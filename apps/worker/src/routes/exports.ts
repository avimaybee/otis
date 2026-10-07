/**
 * Workspace export routes: machine-readable backup downloads.
 *
 * `GET /api/workspaces/:workspaceId/export` returns the workspace's
 * business data as one JSON document: conversations, ledger history,
 * tasks, drafts, memory, briefs, reminders, runs/activity and media
 * inventory. Any workspace member may export what they can already read
 * (per workspace-history visibility); secrets never enter the document:
 * provider credentials, sessions, invites, link codes and Telegram bindings
 * are not selected at all. Media bytes stay in R2 (inventory rows carry
 * the identities; bytes remain available through the private media route).
 *
 * Event rows make the document rebuild-capable: replaying `events` through
 * the ledger reducers reproduces every projection below.
 */

import type { Env } from '../index.js';
import { requireWorkspaceScope } from './scope.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';

export interface WorkspaceExport {
  version: 1;
  workspace: { id: string; name: string; exported_at: string; exported_by: string };
  users: Array<{ id: string; display_name: string | null }>;
  memberships: Array<{ user_id: string; role: string; joined_at: string }>;
  workspace_settings: unknown;
  chats: unknown[];
  messages_in: unknown[];
  chat_messages: unknown[];
  agent_runs: unknown[];
  run_steps: unknown[];
  run_activity: unknown[];
  pending_clarifications: unknown[];
  entities: unknown[];
  entity_aliases: unknown[];
  entity_state: unknown[];
  field_defs: unknown[];
  events: unknown[];
  action_receipts: unknown[];
  tasks: unknown[];
  draft_projections: unknown[];
  memory_entries: unknown[];
  memory_suppressions: unknown[];
  memory_summaries: unknown[];
  briefs: unknown[];
  brief_items: unknown[];
  reminders: unknown[];
  system_jobs: unknown[];
  outbox: unknown[];
  media_objects: unknown[];
  media_transcriptions: unknown[];
  message_image_attachments: unknown[];
}

/**
 * GET /api/workspaces/:workspaceId/export
 */
export async function handleExportWorkspace(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;

  const ws = await env.DB.prepare(`SELECT id, name FROM workspaces WHERE id = ?`)
    .bind(workspaceId)
    .first<{ id: string; name: string }>();
  if (!ws) return jsonError(404, 'not_found', 'Workspace not found or access denied.', requestId);

  const q = (sql: string) => env.DB.prepare(sql).bind(workspaceId);
  // The reminders table ships with migration 0018 alongside this route; a
  // database that has not applied it yet exports an empty reminder list
  // instead of failing the whole document.
  const hasReminders = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reminders'`,
  ).first();
  const reminderQuery = hasReminders
    ? q(`SELECT * FROM reminders WHERE workspace_id = ?`)
    : null;
  const results = await env.DB.batch([
    env.DB.prepare(
      `SELECT u.id, u.display_name FROM users u JOIN workspace_users wu ON wu.user_id = u.id WHERE wu.workspace_id = ?`,
    ).bind(workspaceId),
    q(`SELECT user_id, role, joined_at FROM workspace_users WHERE workspace_id = ?`),
    q(`SELECT default_model FROM workspace_settings WHERE workspace_id = ?`),
    q(`SELECT * FROM chats WHERE workspace_id = ?`),
    q(`SELECT * FROM messages_in WHERE workspace_id = ?`),
    q(`SELECT * FROM chat_messages WHERE workspace_id = ?`),
    q(`SELECT * FROM agent_runs WHERE workspace_id = ?`),
    q(`SELECT * FROM run_steps WHERE workspace_id = ?`),
    q(`SELECT * FROM run_activity WHERE workspace_id = ?`),
    q(`SELECT * FROM pending_clarifications WHERE workspace_id = ?`),
    q(`SELECT * FROM entities WHERE workspace_id = ?`),
    q(`SELECT * FROM entity_aliases WHERE workspace_id = ?`),
    q(`SELECT * FROM entity_state WHERE workspace_id = ?`),
    q(`SELECT * FROM field_defs WHERE workspace_id = ?`),
    q(`SELECT * FROM events WHERE workspace_id = ?`),
    q(`SELECT * FROM action_receipts WHERE workspace_id = ?`),
    q(`SELECT * FROM tasks WHERE workspace_id = ?`),
    q(`SELECT * FROM draft_projections WHERE workspace_id = ?`),
    q(`SELECT * FROM memory_entries WHERE workspace_id = ?`),
    q(`SELECT * FROM memory_suppressions WHERE workspace_id = ?`),
    q(`SELECT * FROM memory_summaries WHERE workspace_id = ?`),
    q(`SELECT * FROM briefs WHERE workspace_id = ?`),
    q(`SELECT * FROM brief_items WHERE brief_id IN (SELECT id FROM briefs WHERE workspace_id = ?)`),
    ...(reminderQuery ? [reminderQuery] : []),
    q(`SELECT * FROM system_jobs WHERE workspace_id = ?`),
    q(`SELECT * FROM outbox WHERE workspace_id = ?`),
    q(`SELECT * FROM media_objects WHERE workspace_id = ?`),
    q(`SELECT * FROM media_transcriptions WHERE workspace_id = ?`),
    q(`SELECT * FROM message_image_attachments WHERE workspace_id = ?`),
  ]);
  // The reminders statement is conditional, so everything after the brief
  // items shifts by one when it is absent. Index from the front instead of
  // destructuring a fixed-length batch.
  const rowsAt = (index: number): Record<string, unknown>[] =>
    (((results[index] as unknown as { results?: Record<string, unknown>[] }).results) ?? []);
  // Indices 24+ assume the reminders statement is present; shift back by
  // one when it is absent.
  const tailAt = (index: number): Record<string, unknown>[] => rowsAt(index - (hasReminders ? 0 : 1));
  const users = rowsAt(0);
  const memberships = rowsAt(1);
  const settings = rowsAt(2);
  const chats = rowsAt(3);
  const messagesIn = rowsAt(4);
  const chatMessages = rowsAt(5);
  const agentRuns = rowsAt(6);
  const runSteps = rowsAt(7);
  const runActivity = rowsAt(8);
  const pendingClarifications = rowsAt(9);
  const entities = rowsAt(10);
  const entityAliases = rowsAt(11);
  const entityState = rowsAt(12);
  const fieldDefs = rowsAt(13);
  const events = rowsAt(14);
  const actionReceipts = rowsAt(15);
  const tasks = rowsAt(16);
  const draftProjections = rowsAt(17);
  const memoryEntries = rowsAt(18);
  const memorySuppressions = rowsAt(19);
  const memorySummaries = rowsAt(20);
  const briefs = rowsAt(21);
  const briefItems = rowsAt(22);
  const reminders = hasReminders ? rowsAt(23) : [];
  const systemJobs = tailAt(24);
  const outbox = tailAt(25);
  const mediaObjects = tailAt(26);
  const mediaTranscriptions = tailAt(27);
  const messageAttachments = tailAt(28);

  // media_objects_v2 carries the current image inventory when present.
  let mediaV2: Record<string, unknown>[] = [];
  try {
    const v2 = await env.DB.prepare(`SELECT * FROM media_objects_v2 WHERE workspace_id = ?`)
      .bind(workspaceId)
      .all();
    mediaV2 = ((v2 as unknown as { results?: Record<string, unknown>[] }).results ?? []);
  } catch {
    // Pre-images migration databases simply have no v2 inventory.
  }

  const exportedAt = new Date().toISOString();
  const document: WorkspaceExport = {
    version: 1,
    workspace: { id: ws.id, name: ws.name, exported_at: exportedAt, exported_by: scope.user.id },
    users: users as WorkspaceExport['users'],
    memberships: memberships as WorkspaceExport['memberships'],
    workspace_settings: settings[0] ?? null,
    chats,
    messages_in: messagesIn,
    chat_messages: chatMessages,
    agent_runs: agentRuns,
    run_steps: runSteps,
    run_activity: runActivity,
    pending_clarifications: pendingClarifications,
    entities,
    entity_aliases: entityAliases,
    entity_state: entityState,
    field_defs: fieldDefs,
    events,
    action_receipts: actionReceipts,
    tasks,
    draft_projections: draftProjections,
    memory_entries: memoryEntries,
    memory_suppressions: memorySuppressions,
    memory_summaries: memorySummaries,
    briefs,
    brief_items: briefItems,
    reminders,
    system_jobs: systemJobs,
    outbox,
    media_objects: [...mediaObjects, ...mediaV2],
    media_transcriptions: mediaTranscriptions,
    message_image_attachments: messageAttachments,
  };

  return jsonSuccess(document, 200, {
    'x-request-id': requestId,
    'Content-Disposition': `attachment; filename="otis-export-${workspaceId}-${exportedAt.slice(0, 10)}.json"`,
  });
}
