import { ENTITY_FILE_SECTIONS, type EntityFileSection } from '@otis/contracts';
import type { Env } from '../index.js';
import { FileReadError, readEntityFile } from '../entities/file.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { requireWorkspaceScope } from './scope.js';
import { readJsonBody } from './scope.js';
import {
  DEFAULT_COMMAND_HANDLERS,
  ENTITY_FAMILY_SQL,
  executeLedgerCommand,
  familyBinds,
} from '@otis/ledger';
import { validateToolCall } from '@otis/agent';
import { sha256 } from '@otis/identity';

/** Explicit selected-entry Save; unrelated Records drafts are never involved. */
export async function handleEntityFileAction(
  request: Request,
  env: Env,
  workspaceId: string,
  entityId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, {
    csrf: true,
  });
  if (scope instanceof Response) return scope;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return jsonError(400, 'invalid_body', 'Choose a valid edit.', requestId);
  const { command, args, operation_id: operationId, expected_revision: revision } = parsed.body;
  const commands = [
    'change_contact',
    'revise_interaction',
    'remove_interaction',
    'update_task',
    'link_attachment',
    'unlink_attachment',
    'update_attachment',
    'change_reminder_rule',
    'resolve_conflict',
  ];
  if (
    typeof command !== 'string' ||
    !commands.includes(command) ||
    typeof operationId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(operationId) ||
    !Number.isSafeInteger(revision) ||
    Number(revision) < 0
  )
    return jsonError(
      400,
      'invalid_edit',
      'Use an edit ID and the current file revision.',
      requestId,
    );
  const validation = validateToolCall(command, args);
  if (!validation.ok)
    return jsonError(400, validation.error.code, validation.error.message, requestId);
  const values = validation.data as Record<string, unknown>;
  const family =
    (
      await env.DB.prepare(`${ENTITY_FAMILY_SQL} SELECT id FROM family`)
        .bind(...familyBinds(workspaceId, entityId))
        .all<{ id: string }>()
    ).results ?? [];
  const ids = new Set(family.map((r) => r.id));
  if (!ids.size) return jsonError(404, 'not_found', 'Client file not found.', requestId);
  if (values.entity_id !== undefined && !ids.has(String(values.entity_id)))
    return jsonError(400, 'wrong_client', 'This edit belongs to a different client.', requestId);
  const targetTable =
    command === 'update_task'
      ? ['tasks', 'task_id', 'id']
      : command === 'revise_interaction' || command === 'remove_interaction'
        ? ['interaction_state', 'interaction_id', 'root_event_id']
        : command === 'unlink_attachment'
          ? ['attachment_links', 'link_id', 'id']
          : command === 'change_reminder_rule' && values.rule_id
            ? ['reminder_rules', 'rule_id', 'id']
            : null;
  if (targetTable) {
    const [table, key, idKey] = targetTable;
    const row = await env.DB.prepare(
      `SELECT entity_id FROM ${table} WHERE workspace_id = ? AND ${idKey} = ?`,
    )
      .bind(workspaceId, String(values[key!] ?? ''))
      .first<{ entity_id: string | null }>();
    if (!row?.entity_id || !ids.has(row.entity_id))
      return jsonError(404, 'not_found', 'This entry is not on the selected client.', requestId);
  }
  return commitSelectedEdit(
    env,
    workspaceId,
    scope.user.id,
    entityId,
    requestId,
    command,
    values,
    String(operationId),
    Number(revision),
  );
}

export async function handleGetEntityFile(
  request: Request,
  env: Env,
  workspaceId: string,
  entityId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;
  const url = new URL(request.url),
    section = url.searchParams.get('section');
  const order = url.searchParams.get('order') ?? 'occurred';
  if (
    (section && !ENTITY_FILE_SECTIONS.includes(section as EntityFileSection)) ||
    !['occurred', 'recorded'].includes(order)
  )
    return jsonError(400, 'invalid_argument', 'Choose a valid section and order.', requestId);
  try {
    const result = await readEntityFile(env.DB, workspaceId, scope.user.id, entityId, {
      interaction_id: url.searchParams.get('interaction_id') ?? undefined,
      author_user_id: url.searchParams.get('author_user_id') ?? undefined,
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      include_removed: url.searchParams.get('include_removed') === 'true',
      section: (section as EntityFileSection) ?? undefined,
      order: order as 'occurred' | 'recorded',
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
    });
    return jsonSuccess(result, 200, { 'x-request-id': requestId, 'cache-control': 'no-store' });
  } catch (error) {
    if (!(error instanceof FileReadError)) throw error;
    return jsonError(
      error.code === 'not_found' ? 404 : error.code === 'file_changed' ? 409 : 400,
      error.code,
      error.message,
      requestId,
    );
  }
}

export async function commitSelectedEdit(
  env: Env,
  workspaceId: string,
  userId: string,
  entityId: string | null,
  requestId: string,
  command: string,
  values: Record<string, unknown>,
  operationId: string,
  revision: number,
): Promise<Response> {
  const inputId = `file_edit_${operationId}`,
    payload = JSON.stringify({
      text: 'Explicit manual client-file edit',
      command,
      args: values,
      entity_id: entityId,
    }),
    fingerprint = await sha256(payload),
    now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO messages_in(id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, created_at, updated_at)
    VALUES (?, ?, ?, 'web', ?, ?, ?, 'processed', ?, ?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind(inputId, workspaceId, userId, inputId, fingerprint, payload, now, now)
    .run();
  const accepted = await env.DB.prepare(
    'SELECT workspace_id, user_id, payload_fingerprint FROM messages_in WHERE id = ?',
  )
    .bind(inputId)
    .first<{ workspace_id: string; user_id: string; payload_fingerprint: string }>();
  if (
    accepted?.workspace_id !== workspaceId ||
    accepted.user_id !== userId ||
    accepted.payload_fingerprint !== fingerprint
  )
    return jsonError(409, 'edit_changed', 'This retry ID belongs to a different edit.', requestId);
  const result = await executeLedgerCommand(
    env.DB,
    {
      workspace_id: workspaceId,
      actor: { kind: 'member', user_id: userId },
      membership_revision: 1,
      source_message_id: inputId,
      request_id: requestId,
      action_id: operationId,
      expected_business_revision: Number(revision),
    },
    command,
    values,
    DEFAULT_COMMAND_HANDLERS[command]!,
  );
  if (result.status === 'conflict' || result.status === 'rejected') return jsonError(result.status === 'conflict' ? 409 : 400, result.error?.code ?? 'edit_rejected', result.error?.message ?? 'This edit could not be saved.', requestId, false, result.data);
  return jsonSuccess(result, 200, { 'cache-control': 'no-store' });
}
