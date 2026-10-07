/**
 * Run routes: authoritative run status, and the author-scoped stop control.
 * Stop cancels future steps and continuations; already committed actions are
 * preserved (stop is not undo).
 */

import type { MemorySourceReference, PendingClarification, PublicActivity, RunActionSummary, RunBatchResponse, RunDetailResponse, RunStepSummary } from '@otis/contracts';
import type { AgentRun } from '@otis/contracts';
import { DOMAIN_BOUNDS } from '@otis/contracts';
import { stopRun, ActorError } from '../actor/dispatch.js';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { publicActivityFromRow } from '../chat/activity.js';
import { requireWorkspaceScope } from './scope.js';

function parseRun(row: Record<string, unknown>): AgentRun {
  return {
    id: String(row['id']),
    workspace_id: String(row['workspace_id']),
    chat_id: row['chat_id'] ? String(row['chat_id']) : null,
    source_message_id: row['source_message_id'] ? String(row['source_message_id']) : null,
    source_job_id: row['source_job_id'] ? String(row['source_job_id']) : null,
    executor_kind: String(row['executor_kind']) as AgentRun['executor_kind'],
    status: String(row['status']) as AgentRun['status'],
    model_key: row['model_key'] ? String(row['model_key']) : null,
    attempt_id: row['attempt_id'] ? String(row['attempt_id']) : null,
    lease_fence: Number(row['lease_fence'] ?? 0),
    error_code: row['error_code'] ? String(row['error_code']) : null,
    error_message: row['error_message'] ? String(row['error_message']) : null,
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
  };
}

function mapStepRow(row: Record<string, unknown>): RunStepSummary {
  return {
    step_index: Number(row['step_index']),
    tool_name: String(row['tool_name']),
    status: String(row['status']) as RunStepSummary['status'],
    action_id: row['action_id'] ? String(row['action_id']) : null,
    // `update_preference` stores MemberSettings rather than a CommandResult;
    // the owner boundary normalizes both into one displayable value.
    result: decodeToolResult(row['result_json']),
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
  };
}

function mapActionRow(row: Record<string, unknown>): RunActionSummary {
  return {
    action_id: String(row['action_id']),
    command_name: String(row['command_name']),
    result_status: String(row['result_status']),
    committed_revision: Number(row['committed_revision']),
    summary: readSummary(row['result_json']),
    created_at: String(row['created_at']),
  };
}

function mapClarificationRow(row: Record<string, unknown>): PendingClarification {
  return {
    id: String(row['id']),
    workspace_id: String(row['workspace_id']),
    chat_id: String(row['chat_id']),
    run_id: String(row['run_id']),
    source_message_id: String(row['source_message_id']),
    requester_user_id: String(row['requester_user_id']),
    question: String(row['question']),
    intended_operation: String(row['intended_operation']),
    missing_fields: parseStringArray(row['missing_fields']),
    candidates_json: row['candidates_json'] ? String(row['candidates_json']) : null,
    source_revision: Number(row['source_revision']),
    status: String(row['status']) as 'pending',
    resolution_response: row['resolution_response'] ? String(row['resolution_response']) : null,
    resolved_at: row['resolved_at'] ? String(row['resolved_at']) : null,
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
  };
}

/** Memory ids referenced by memory-tool step results, at most 12 per run. */
function collectMemoryIds(steps: RunStepSummary[]): string[] {
  const memoryIds: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (!['search_memory', 'get_memory', 'remember_context', 'forget_memory'].includes(step.tool_name)) continue;
    const res = step.result as Record<string, unknown> | null;
    const data = res?.['data'] ?? res;
    for (const entry of Array.isArray(data) ? data : data ? [data] : []) {
      if (!entry || typeof entry !== 'object') continue;
      const entryObj = entry as Record<string, unknown>;
      const id = typeof entryObj['id'] === 'string'
        ? entryObj['id']
        : typeof entryObj['memory_id'] === 'string'
        ? entryObj['memory_id']
        : typeof entryObj['entry_id'] === 'string'
        ? entryObj['entry_id']
        : null;
      if (id && !seen.has(id) && memoryIds.length < 12) {
        seen.add(id);
        memoryIds.push(id);
      }
    }
  }
  return memoryIds;
}

function mapSourceRow(row: { id: string; provenance: 'stated' | 'inferred'; observed_at: string; display_name: string | null }): MemorySourceReference {
  return {
    memory_id: row.id,
    provenance: row.provenance ?? 'stated',
    label: `${row.display_name ?? 'Workspace'} · ${row.observed_at ? row.observed_at.slice(0, 10) : 'Note'}`,
  };
}

/**
 * GET /api/workspaces/:workspaceId/runs/:runId
 */
export async function handleGetRun(
  request: Request,
  env: Env,
  workspaceId: string,
  runId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;

  const runRow = await env.DB
    .prepare(
      `SELECT id, workspace_id, chat_id, source_message_id, source_job_id, executor_kind, status,
              model_key, attempt_id, lease_fence, error_code, error_message, created_at, updated_at
       FROM agent_runs WHERE id = ? AND workspace_id = ?`,
    )
    .bind(runId, workspaceId)
    .first<Record<string, unknown>>();

  if (!runRow) {
    return jsonError(404, 'run_not_found', 'Run not found in this workspace.', requestId);
  }
  const run = parseRun(runRow);

  const stepRows =
    (
      await env.DB
        .prepare(
          `SELECT step_index, tool_name, status, action_id, result_json, created_at, updated_at
           FROM run_steps WHERE run_id = ? AND workspace_id = ?
           ORDER BY step_index ASC`,
        )
        .bind(runId, workspaceId)
        .all<Record<string, unknown>>()
    ).results || [];

  const steps: RunStepSummary[] = stepRows.map((row) => mapStepRow(row));

  const actionRows =
    (
      await env.DB
        .prepare(
          `SELECT action_id, command_name, result_status, committed_revision, result_json, created_at
           FROM action_receipts WHERE workspace_id = ? AND (run_id = ? OR source_message_id = ?)
           ORDER BY created_at ASC, action_id ASC`,
        )
        .bind(workspaceId, runId, run.source_message_id)
        .all<Record<string, unknown>>()
    ).results || [];

  const actions: RunActionSummary[] = actionRows.map((row) => mapActionRow(row));

  let activities: PublicActivity[] = [];
  if (run.chat_id) {
    const rows = await env.DB.prepare(`SELECT id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at FROM run_activity WHERE workspace_id = ? AND chat_id = ? AND run_id = ? ORDER BY cursor DESC LIMIT 200`).bind(workspaceId, run.chat_id, runId).all<Record<string, unknown>>();
    activities = rows.results.reverse().map(publicActivityFromRow);
  }

  const clarification = await env.DB
    .prepare(
      `SELECT id, workspace_id, chat_id, run_id, source_message_id, requester_user_id, question,
              intended_operation, missing_fields, candidates_json, source_revision, status,
              resolution_response, resolved_at, created_at, updated_at
       FROM pending_clarifications WHERE run_id = ? AND workspace_id = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(runId, workspaceId)
    .first<Record<string, unknown>>();

  const body: RunDetailResponse = {
    run,
    steps,
    actions,
    activities,
    pending_clarification: clarification ? mapClarificationRow(clarification) : null,
    status: run.status,
  };
  const memoryIds = collectMemoryIds(steps);
  body.sources = [];
  for (const id of memoryIds) {
    const row = await env.DB.prepare(
      `SELECT m.id, m.provenance, m.observed_at, u.display_name
       FROM memory_entries m
       LEFT JOIN users u ON u.id = m.author_user_id
       WHERE m.workspace_id = ? AND m.id = ?`
    ).bind(workspaceId, id).first<{ id: string; provenance: 'stated' | 'inferred'; observed_at: string; display_name: string | null }>();
    if (row) {
      body.sources.push({
        memory_id: row.id,
        provenance: row.provenance ?? 'stated',
        label: `${row.display_name ?? 'Workspace'} · ${row.observed_at ? row.observed_at.slice(0, 10) : 'Note'}`,
      });
    }
  }

  return jsonSuccess(body, 200, { 'x-request-id': requestId });
}

/**
 * GET /api/workspaces/:workspaceId/runs?ids=a,b,c
 *
 * One batched page of the same RunDetailResponse shapes as the single-run
 * route, in request order, omitting unknown ids. Snapshot and older-page
 * loads use this instead of one HTTP roundtrip per run.
 */
export async function handleListRuns(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;

  const seen = new Set<string>();
  const ids: string[] = [];
  const requested = new URL(request.url).searchParams.get('ids') ?? '';
  for (const raw of requested.split(',')) {
    const id = raw.trim();
    if (!id || id.length > 128 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= DOMAIN_BOUNDS.MAX_TRANSCRIPT_PAGE) break;
  }
  if (ids.length === 0) {
    return jsonSuccess({ runs: [] } satisfies RunBatchResponse, 200, { 'x-request-id': requestId });
  }
  const placeholders = ids.map(() => '?').join(',');

  const runRows = (
    await env.DB
      .prepare(
        `SELECT id, workspace_id, chat_id, source_message_id, source_job_id, executor_kind, status,
                model_key, attempt_id, lease_fence, error_code, error_message, created_at, updated_at
         FROM agent_runs WHERE workspace_id = ? AND id IN (${placeholders})`,
      )
      .bind(workspaceId, ...ids)
      .all<Record<string, unknown>>()
  ).results || [];
  const runsById = new Map(runRows.map((row) => [String(row['id']), parseRun(row)]));
  if (runsById.size === 0) {
    return jsonSuccess({ runs: [] } satisfies RunBatchResponse, 200, { 'x-request-id': requestId });
  }
  const found = ids.filter((id) => runsById.has(id));
  const foundPlaceholders = found.map(() => '?').join(',');

  const stepRows = (
    await env.DB
      .prepare(
        `SELECT run_id, step_index, tool_name, status, action_id, result_json, created_at, updated_at
         FROM run_steps WHERE workspace_id = ? AND run_id IN (${foundPlaceholders})
         ORDER BY run_id ASC, step_index ASC`,
      )
      .bind(workspaceId, ...found)
      .all<Record<string, unknown>>()
  ).results || [];
  const stepsByRun = new Map<string, RunStepSummary[]>();
  for (const row of stepRows) {
    const runId = String(row['run_id']);
    const list = stepsByRun.get(runId) ?? [];
    list.push(mapStepRow(row));
    stepsByRun.set(runId, list);
  }

  const sourceMessageIds = [...new Set(
    [...runsById.values()].map((run) => run.source_message_id).filter((id): id is string => Boolean(id)),
  )];
  const actionRows = (
    await env.DB
      .prepare(
        `SELECT run_id, source_message_id, action_id, command_name, result_status, committed_revision, result_json, created_at
         FROM action_receipts WHERE workspace_id = ? AND (run_id IN (${foundPlaceholders})${
           sourceMessageIds.length > 0 ? ` OR source_message_id IN (${sourceMessageIds.map(() => '?').join(',')})` : ''
         })
         ORDER BY created_at ASC, action_id ASC`,
      )
      .bind(workspaceId, ...found, ...sourceMessageIds)
      .all<Record<string, unknown>>()
  ).results || [];
  // Attribute each receipt to its run: direct run linkage first, falling back
  // to the run that produced the same source message.
  const sourceToRun = new Map<string, string>();
  for (const run of runsById.values()) {
    if (run.source_message_id) sourceToRun.set(run.source_message_id, run.id);
  }
  const actionsByRun = new Map<string, RunActionSummary[]>();
  for (const row of actionRows) {
    const direct = row['run_id'] ? String(row['run_id']) : null;
    const viaSource = row['source_message_id'] ? sourceToRun.get(String(row['source_message_id'])) : undefined;
    const runId = (direct && runsById.has(direct) ? direct : viaSource) ?? null;
    if (!runId) continue;
    const list = actionsByRun.get(runId) ?? [];
    list.push(mapActionRow(row));
    actionsByRun.set(runId, list);
  }

  const activityRows = (
    await env.DB
      .prepare(
        `SELECT id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at
         FROM run_activity WHERE workspace_id = ? AND run_id IN (${foundPlaceholders})
         ORDER BY run_id ASC, cursor DESC`,
      )
      .bind(workspaceId, ...found)
      .all<Record<string, unknown>>()
  ).results || [];
  const activitiesByRun = new Map<string, PublicActivity[]>();
  for (const row of activityRows) {
    const runId = String(row['run_id']);
    const list = activitiesByRun.get(runId) ?? [];
    // Mirror the single-run most-recent-200 window per run.
    if (list.length < 200) list.push(publicActivityFromRow(row));
    activitiesByRun.set(runId, list);
  }
  for (const list of activitiesByRun.values()) list.reverse();

  const clarificationRows = (
    await env.DB
      .prepare(
        `SELECT id, workspace_id, chat_id, run_id, source_message_id, requester_user_id, question,
                intended_operation, missing_fields, candidates_json, source_revision, status,
                resolution_response, resolved_at, created_at, updated_at
         FROM pending_clarifications WHERE workspace_id = ? AND run_id IN (${foundPlaceholders}) AND status = 'pending'
         ORDER BY created_at DESC`,
      )
      .bind(workspaceId, ...found)
      .all<Record<string, unknown>>()
  ).results || [];
  const clarificationByRun = new Map<string, PendingClarification>();
  for (const row of clarificationRows) {
    const runId = String(row['run_id']);
    if (!clarificationByRun.has(runId)) clarificationByRun.set(runId, mapClarificationRow(row));
  }

  const memoryIds = new Set<string>();
  const memoryIdsByRun = new Map<string, string[]>();
  for (const runId of found) {
    const collected = collectMemoryIds(stepsByRun.get(runId) ?? []);
    memoryIdsByRun.set(runId, collected);
    for (const id of collected) memoryIds.add(id);
  }
  const sourceById = new Map<string, MemorySourceReference>();
  if (memoryIds.size > 0) {
    const sourcePlaceholders = [...memoryIds].map(() => '?').join(',');
    const sourceRows = (
      await env.DB
        .prepare(
          `SELECT m.id, m.provenance, m.observed_at, u.display_name
           FROM memory_entries m
           LEFT JOIN users u ON u.id = m.author_user_id
           WHERE m.workspace_id = ? AND m.id IN (${sourcePlaceholders})`,
        )
        .bind(workspaceId, ...memoryIds)
        .all<{ id: string; provenance: 'stated' | 'inferred'; observed_at: string; display_name: string | null }>()
    ).results || [];
    for (const row of sourceRows) sourceById.set(row.id, mapSourceRow(row));
  }

  const runs: RunDetailResponse[] = [];
  for (const id of found) {
    const run = runsById.get(id)!;
    runs.push({
      run,
      steps: stepsByRun.get(id) ?? [],
      actions: actionsByRun.get(id) ?? [],
      activities: activitiesByRun.get(id) ?? [],
      pending_clarification: clarificationByRun.get(id) ?? null,
      status: run.status,
      sources: (memoryIdsByRun.get(id) ?? [])
        .map((memoryId) => sourceById.get(memoryId))
        .filter((source): source is MemorySourceReference => Boolean(source)),
    });
  }
  return jsonSuccess({ runs } satisfies RunBatchResponse, 200, { 'x-request-id': requestId });
}

function decodeToolResult(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readSummary(value: unknown): string | null {
  const parsed = decodeToolResult(value) as { summary?: unknown } | null;
  return parsed && typeof parsed.summary === 'string' ? parsed.summary : null;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * POST /api/workspaces/:workspaceId/runs/:runId/stop
 */
export async function handleStopRun(
  request: Request,
  env: Env,
  workspaceId: string,
  runId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;

  try {
    // Best-effort live abort in the workspace actor's isolate (F08): stops
    // provider spend for turns executing there. Any failure falls through —
    // the D1 cancelled marking in stopRun is the authority every isolate
    // honors, and an already-settled run aborts nothing.
    if (env.WORKSPACE_ACTOR) {
      try {
        const stub = env.WORKSPACE_ACTOR.get(env.WORKSPACE_ACTOR.idFromName(workspaceId));
        const abortRes = await stub.fetch(
          new Request('http://actor/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'stop', workspace_id: workspaceId, run_id: runId }),
          }),
        );
        await abortRes.text().catch(() => undefined);
      } catch {
        // Fall through to the durable stop below.
      }
    }
    const result = await stopRun(env.DB, {
      workspaceId,
      runId,
      actorUserId: scope.user.id,
    });
    return jsonSuccess(
      { status: 'ok', stopped: result.stopped, run_status: result.status },
      200,
      { 'x-request-id': requestId },
    );
  } catch (err) {
    if (err instanceof ActorError) {
      if (err.code === 'run_not_found') {
        return jsonError(404, err.code, err.message, requestId);
      }
      return jsonError(403, err.code, err.message, requestId);
    }
    throw err;
  }
}
