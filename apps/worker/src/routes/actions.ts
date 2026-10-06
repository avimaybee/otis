/**
 * Action inspection and undo routes.
 *
 * Undo is a ledger command like any other write: it revalidates membership,
 * workspace revision, and the selected action at its committing batch. The
 * preview is a read, so a stale preview is revalidated at commit rather than
 * trusted.
 */

import type {
  ActionDetailResponse,
  UndoCommitRequest,
  UndoCommitResponse,
  UndoMode,
  UndoPreview,
} from '@otis/contracts';
import {
  computeUndoPreview,
  executeLedgerCommand,
  getActionReceipt,
  getWorkspaceActions,
  getWorkspaceEvents,
  getWorkspaceProjectionState,
  getWorkspaceRevision,
  handleUndoCommit as commitLedgerUndo,
} from '@otis/ledger';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { ensureCommandSourceMessage } from '../chat/commandTurn.js';
import { pathSegment, requireWorkspaceScope } from './scope.js';

function parseMode(value: unknown): UndoMode | null {
  if (value === undefined || value === null) return 'from_here';
  return value === 'from_here' || value === 'single' ? value : null;
}

/** Current membership revision for the trusted ledger context. */
async function readMembershipRevision(db: D1Database, workspaceId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT membership_revision FROM workspaces WHERE id = ?`)
    .bind(workspaceId)
    .first<{ membership_revision: number }>();
  return Number(row?.membership_revision ?? 0);
}

function decodeCommandResult(json: string): { summary?: string; data?: unknown } | null {
  try {
    return JSON.parse(json) as { summary?: string; data?: unknown };
  } catch {
    return null;
  }
}

async function loadPreview(
  db: D1Database,
  workspaceId: string,
  actionId: string,
  mode: UndoMode,
): Promise<UndoPreview | null> {
  const [events, actions, state, revision] = await Promise.all([
    getWorkspaceEvents(db, workspaceId),
    getWorkspaceActions(db, workspaceId),
    getWorkspaceProjectionState(db, workspaceId),
    getWorkspaceRevision(db, workspaceId),
  ]);
  if (!revision || !actions.some((action) => action.action_id === actionId)) return null;

  return computeUndoPreview(actionId, mode, actions, events, state, revision.business_revision);
}

/**
 * GET /api/workspaces/:workspaceId/actions/:actionId
 *
 * Returns the receipt, its events, the attributed source message, and whether
 * the action can still be undone.
 */
export async function handleGetAction(
  request: Request,
  env: Env,
  workspaceId: string,
  rawActionId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;
  const actionId = pathSegment(rawActionId);

  const receipt = await getActionReceipt(env.DB, workspaceId, actionId);
  if (!receipt) {
    return jsonError(404, 'not_found', 'Action not found in this workspace.', requestId);
  }

  const allEvents = await getWorkspaceEvents(env.DB, workspaceId);
  const events = allEvents.filter((event) => event.action_id === actionId);
  const revertedIds = new Set<string>();
  const reverters = new Map<string, string[]>();
  for (const event of allEvents) {
    if (event.kind === 'revert' && event.reverts_event_id) {
      revertedIds.add(event.reverts_event_id);
      reverters.set(event.reverts_event_id, [...(reverters.get(event.reverts_event_id) ?? []), event.id]);
    }
  }

  let source: ActionDetailResponse['action']['source'] = null;
  if (receipt.source_message_id) {
    const row = await env.DB
      .prepare(
        `SELECT mi.id, mi.channel, mi.created_at, cm.content_text
         FROM messages_in mi
         LEFT JOIN chat_messages cm ON cm.inbound_message_id = mi.id
         WHERE mi.id = ? AND mi.workspace_id = ?`,
      )
      .bind(receipt.source_message_id, workspaceId)
      .first<Record<string, unknown>>();
    if (row) {
      const text = row['content_text'] ? String(row['content_text']) : null;
      source = {
        id: String(row['id']),
        channel: String(row['channel']),
        created_at: String(row['created_at']),
        text_preview: text === null ? null : text.slice(0, 400),
      };
    }
  }

  let summary: string | null = null;
  try {
    summary = (JSON.parse(receipt.result_json) as { summary?: string }).summary ?? null;
  } catch {
    summary = null;
  }

  const body: ActionDetailResponse = {
    action: {
      action_id: receipt.action_id,
      workspace_id: receipt.workspace_id,
      command_name: receipt.command_name,
      result_status: receipt.result_status,
      summary,
      committed_revision: receipt.committed_revision,
      actor_kind: receipt.actor_kind,
      actor_user_id: receipt.actor_user_id ?? null,
      source_message_id: receipt.source_message_id ?? null,
      run_id: receipt.run_id ?? null,
      step_id: receipt.step_id ?? null,
      created_at: receipt.created_at,
      events: events.map((event) => ({
        id: event.id,
        kind: event.kind,
        sequence: event.sequence,
        occurred_at: event.occurred_at,
        entity_id: event.entity_id ?? null,
        payload: event.payload,
        reverted: revertedIds.has(event.id),
      })),
      undo: {
        available: events.some((event) => !revertedIds.has(event.id)),
        reverted_event_ids: events.filter((event) => revertedIds.has(event.id)).map((event) => event.id),
        reverted_by_event_ids: events.flatMap((event) => reverters.get(event.id) ?? []),
      },
      source,
    },
  };

  return jsonSuccess(body, 200, { 'x-request-id': requestId });
}

/**
 * POST /api/workspaces/:workspaceId/actions/:actionId/undo-preview
 */
export async function handleUndoPreview(
  request: Request,
  env: Env,
  workspaceId: string,
  rawActionId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;
  const actionId = pathSegment(rawActionId);

  let body: { mode?: unknown } = {};
  try {
    body = (await request.json()) as { mode?: unknown };
  } catch {
    // Empty body selects the default mode.
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError(422, 'validation_error', 'Expected a JSON object.', requestId);
  const mode = parseMode(body.mode);
  if (!mode) {
    return jsonError(422, 'validation_error', 'mode must be "from_here" or "single".', requestId);
  }

  let preview: UndoPreview | null;
  try {
    preview = await loadPreview(env.DB, workspaceId, actionId, mode);
  } catch (err) {
    return jsonError(
      409,
      'preview_unavailable',
      err instanceof Error ? err.message : 'Undo preview could not be computed.',
      requestId,
    );
  }

  if (!preview) {
    return jsonError(404, 'not_found', 'Action not found in this workspace.', requestId);
  }

  const target = await getActionReceipt(env.DB, workspaceId, actionId);
  if (target?.run_id) {
    const active = await env.DB.prepare(`SELECT 1 FROM agent_runs WHERE id = ? AND workspace_id = ? AND status IN ('queued', 'running')`).bind(target.run_id, workspaceId).first();
    if (active) return jsonError(409, 'run_active', 'Stop the current run or wait for it to finish before preparing undo.', requestId);
  }

  return jsonSuccess({ preview }, 200, { 'x-request-id': requestId });
}

/**
 * POST /api/workspaces/:workspaceId/actions/:actionId/undo
 *
 * Commits through the ledger so the revert, projections and receipt land in one
 * guarded transaction. The caller's own chat records the revert when provided,
 * which is how a teammate-initiated undo stays attributed to that teammate.
 */
export async function handleCommitUndo(
  request: Request,
  env: Env,
  workspaceId: string,
  rawActionId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;
  const actionId = pathSegment(rawActionId);

  let body: Partial<UndoCommitRequest> & { command_text?: string; presentation?: 'control' };
  try {
    body = (await request.json()) as Partial<UndoCommitRequest>;
  } catch {
    body = {};
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError(422, 'validation_error', 'Expected a JSON object.', requestId);
  const mode = parseMode(body.mode);
  if (!mode) {
    return jsonError(422, 'validation_error', 'mode must be "from_here" or "single".', requestId);
  }

  if (body.presentation !== undefined && body.presentation !== 'control') return jsonError(422, 'validation_error', 'Invalid command presentation.', requestId);
  const clientOperationId =
    typeof body.client_operation_id === 'string' && body.client_operation_id.length > 0
      ? body.client_operation_id
      : null;
  if (!clientOperationId) {
    return jsonError(422, 'validation_error', 'client_operation_id is required.', requestId);
  }
  if (!Number.isSafeInteger(body.expected_revision) || body.expected_revision! < 0 || clientOperationId.length > 128) return jsonError(422, 'validation_error', 'A valid operation ID and preview revision are required.', requestId);

  const url = new URL(request.url);
  // The undo's own action identity is derived from the client operation ID so
  // a retried request returns the first result instead of reverting twice.
  const undoActionId = `undo_${workspaceId}_${clientOperationId}`;
  const commandRunId = `run_cmd_${workspaceId}_${clientOperationId}`;
  // An undo is an attributed turn in the requester's own chat. When the client
  // omits chat_id, a retried operation must replay in the chat that recorded
  // it; only a fresh operation falls back to the member's most recent
  // conversation. Ownership is re-verified either way.
  const requestedChatId = url.searchParams.get('chat_id');
  let chatId: string | null = null;
  if (requestedChatId) {
    const owned = await env.DB
      .prepare(`SELECT id FROM chats WHERE id = ? AND workspace_id = ? AND author_user_id = ?`)
      .bind(pathSegment(requestedChatId), workspaceId, scope.user.id)
      .first<{ id: string }>();
    if (!owned) {
      return jsonError(
        404,
        'chat_not_found',
        'Undo must be requested from one of your own conversations in this workspace.',
        requestId,
      );
    }
    chatId = owned.id;
  } else {
    const recordedRun = await env.DB
      .prepare(`SELECT chat_id FROM agent_runs WHERE id = ? AND workspace_id = ?`)
      .bind(commandRunId, workspaceId)
      .first<{ chat_id: string | null }>();
    const recordedChatId = recordedRun?.chat_id ? String(recordedRun.chat_id) : null;
    if (recordedChatId) {
      const owned = await env.DB
        .prepare(`SELECT id FROM chats WHERE id = ? AND workspace_id = ? AND author_user_id = ?`)
        .bind(recordedChatId, workspaceId, scope.user.id)
        .first<{ id: string }>();
      if (!owned) {
        return jsonError(
          404,
          'chat_not_found',
          'Undo must be requested from one of your own conversations in this workspace.',
          requestId,
        );
      }
      chatId = owned.id;
    } else {
      const recent = await env.DB
        .prepare(
          `SELECT id FROM chats WHERE workspace_id = ? AND author_user_id = ?
           ORDER BY last_activity_at DESC LIMIT 1`,
        )
        .bind(workspaceId, scope.user.id)
        .first<{ id: string }>();
      if (!recent) {
        return jsonError(
          422,
          'no_chat',
          'Undo needs a conversation of yours to record the change in.',
          requestId,
        );
      }
      chatId = recent.id;
    }
  }

  const target = await getActionReceipt(env.DB, workspaceId, actionId);
  if (!target) {
    return jsonError(404, 'not_found', 'Action not found in this workspace.', requestId);
  }
  let source: { messageInId: string; created: boolean };
  try {
    source = await ensureCommandSourceMessage(env.DB, { workspaceId, userId: scope.user.id, chatId, externalId: body.command_text ? clientOperationId : `undo:${clientOperationId}`, text: body.command_text ?? `/undo ${actionId} ${mode}`, targetActionId: actionId, mode, presentation: body.presentation });
  } catch { return jsonError(409, 'operation_conflict', 'This operation ID belongs to a different undo or conversation.', requestId); }

  // A retried undo carries the same client operation ID. The recorded receipt is
  // the authoritative result; the workspace revision in the request legitimately
  // moved on, so the retry replays instead of recomputing.
  const previous = await getActionReceipt(env.DB, workspaceId, undoActionId);
  if (previous) {
    const recorded = decodeCommandResult(previous.result_json);
    const recordedData = (recorded?.data ?? {}) as {
      reverted_action_ids?: string[];
      revert_event_ids?: string[];
    };
    return jsonSuccess(
      {
        status: 'already_applied',
        action_id: actionId,
        undo_action_id: undoActionId,
        affected_action_ids: recordedData.reverted_action_ids ?? [],
        revert_event_ids: recordedData.revert_event_ids ?? [],
        committed_revision: previous.committed_revision,
        summary: recorded?.summary ?? 'That undo was already applied.',
      } satisfies UndoCommitResponse,
      200,
      { 'x-request-id': requestId },
    );
  }

  const revision = await getWorkspaceRevision(env.DB, workspaceId);
  if (!revision) {
    return jsonError(404, 'workspace_not_found', 'Workspace not found.', requestId);
  }
  const expectedRevision = body.expected_revision!;

  const extraStatements: D1PreparedStatement[] = [];
  const now = new Date().toISOString();
  // Every ledger event requires one accepted source message, so the inbound row
  // is created first and reused by the command run and the activity.
  const sourceMessageId = source.messageInId;

  extraStatements.push(
    env.DB.prepare(`INSERT INTO acceptance_guards (id, guard_ok) VALUES (?, CASE WHEN NOT EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND workspace_id = ? AND status IN ('queued', 'running')) THEN 1 ELSE NULL END) ON CONFLICT(id) DO UPDATE SET guard_ok = excluded.guard_ok`).bind(`guard_undo_${workspaceId}`, target.run_id ?? '', workspaceId),
    env.DB
      .prepare(
        `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, executor_kind, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'command', 'succeeded', ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(commandRunId, workspaceId, chatId, source.messageInId, now, now),
    ...(body.presentation !== 'control' ? [env.DB.prepare(`INSERT INTO chat_messages (id, workspace_id, chat_id, author_user_id, author_kind, channel, inbound_message_id, client_message_id, content_text, run_id, sequence, created_at, updated_at) SELECT ?, ?, ?, ?, 'member', 'web', ?, ?, ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ? FROM chat_messages WHERE chat_id = ?`).bind(`msg_${crypto.randomUUID()}`, workspaceId, chatId, scope.user.id, sourceMessageId, body.command_text ? clientOperationId : `undo:${clientOperationId}`, body.command_text ?? `/undo ${actionId} ${mode}`, commandRunId, now, now, chatId)] : []),
    env.DB
      .prepare(
        `UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(now, now, chatId),
    env.DB
      .prepare(
        `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
         SELECT ?, ?, ?, ?, (SELECT activity_cursor FROM chats WHERE id = ?),
                'action_reverted', ?, ?`,
      )
      .bind(
        `act_${crypto.randomUUID()}`,
        workspaceId,
        chatId,
        commandRunId,
        chatId,
        JSON.stringify({ action_id: actionId, mode, requested_by_user_id: scope.user.id }),
        now,
      ),
  );

  const [allEvents, allActions] = await Promise.all([
    getWorkspaceEvents(env.DB, workspaceId),
    getWorkspaceActions(env.DB, workspaceId),
  ]);

  const result = await executeLedgerCommand(
    env.DB,
    {
      workspace_id: workspaceId,
      action_id: undoActionId,
      expected_business_revision: expectedRevision,
      actor: { kind: 'member', user_id: scope.user.id },
      membership_revision: await readMembershipRevision(env.DB, workspaceId),
      request_id: requestId,
      source_channel: 'web',
      ...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
      ...(chatId ? { chat_id: chatId } : {}),
    },
    'undo',
    {
      action_id: actionId,
      mode,
      client_operation_id: clientOperationId,
      expected_revision: expectedRevision,
    },
    (ctx, state, seq, req) => {
      const outcome = commitLedgerUndo(ctx, allEvents, allActions, state, seq, req);
      const reply = outcome.result.summary ?? 'Undo applied.';
      extraStatements.push(
        env.DB.prepare(`INSERT INTO chat_messages (id, workspace_id, chat_id, author_kind, channel, content_text, run_id, sequence, created_at, updated_at) SELECT ?, ?, ?, 'system', 'system', ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ? FROM chat_messages WHERE chat_id = ?`).bind(`msg_${crypto.randomUUID()}`, workspaceId, chatId, reply, commandRunId, now, now, chatId),
        env.DB.prepare(`UPDATE chats SET activity_cursor = activity_cursor + 1 WHERE id = ?`).bind(chatId),
        env.DB.prepare(`INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at) SELECT ?, ?, ?, ?, activity_cursor, 'answer_saved', ?, ? FROM chats WHERE id = ?`).bind(`act_${crypto.randomUUID()}`, workspaceId, chatId, commandRunId, JSON.stringify({ reply, selected_workspace_id: null }), now, chatId),
      );
      return outcome;
    },
    extraStatements.length > 0 ? extraStatements : undefined,
    { deferRunTransition: true },
  );

  const data = (result.data ?? {}) as {
    reverted_action_ids?: string[];
    revert_event_ids?: string[];
  };

  const response: UndoCommitResponse = {
    status: result.status as UndoCommitResponse['status'],
    action_id: actionId,
    undo_action_id: undoActionId,
    affected_action_ids: data.reverted_action_ids ?? [],
    revert_event_ids: data.revert_event_ids ?? result.event_ids ?? [],
    committed_revision: result.committed_revision ?? null,
    summary:
      result.summary ??
      (result.error ? result.error.message : 'Undo finished with no changes.'),
    ...(result.error ? { error: result.error } : {}),
  };

  const statusCode =
    result.status === 'applied' || result.status === 'already_applied'
      ? 200
      : result.status === 'needs_clarification'
        ? 409
        : result.status === 'conflict'
          ? 409
          : 422;

  return jsonSuccess(response, statusCode, { 'x-request-id': requestId });
}
