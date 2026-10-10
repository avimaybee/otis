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
import type { SheetData } from '@otis/sheet';
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
  interaction_state: unknown[];
  entity_contacts: unknown[];
  entity_redirects: unknown[];
  attachment_links: unknown[];
  reminder_rules: unknown[];
  document_extractions: unknown[];
  media_annotations: unknown[];
  records_lists: unknown[];
  records_list_columns: unknown[];
  records_rows: unknown[];
  records_values: unknown[];
}

/**
 * GET /api/workspaces/:workspaceId/export[?format=json|xlsx]
 *
 * JSON (default) returns the WorkspaceExport document below. `format=xlsx`
 * renders the same collection as a spreadsheet snapshot through the shared
 * zero-dependency writer: same scope, same membership check, same secret
 * exclusions.
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

  const url = new URL(request.url);
  const format = url.searchParams.get('format') ?? 'json';
  if (format !== 'json' && format !== 'xlsx') {
    return jsonError(422, 'validation_error', "format must be 'json' or 'xlsx'.", requestId);
  }

  const exportedAt = new Date().toISOString();
  if (format === 'xlsx') {
    const { buildWorkbook } = await import('@otis/sheet');
    const { sheets, filename } = workspaceExportToSheets(
      await collectWorkspaceExportSections(env.DB, workspaceId),
      ws.name,
      workspaceId,
      exportedAt,
    );
    const workbook = buildWorkbook(sheets, filename);
    return new Response(workbook.bytes as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': workbook.contentType,
        'Content-Disposition': `attachment; filename="${workbook.filename}"`,
        'x-request-id': requestId,
      },
    });
  }

  const sections = await collectWorkspaceExportSections(env.DB, workspaceId);
  const document: WorkspaceExport = {
    version: 1,
    workspace: { id: ws.id, name: ws.name, exported_at: exportedAt, exported_by: scope.user.id },
    users: sections.users as WorkspaceExport['users'],
    memberships: sections.memberships as WorkspaceExport['memberships'],
    workspace_settings: sections.settings[0] ?? null,
    chats: sections.chats,
    messages_in: sections.messagesIn,
    chat_messages: sections.chatMessages,
    agent_runs: sections.agentRuns,
    run_steps: sections.runSteps,
    run_activity: sections.runActivity,
    pending_clarifications: sections.pendingClarifications,
    entities: sections.entities,
    entity_aliases: sections.entityAliases,
    entity_state: sections.entityState,
    field_defs: sections.fieldDefs,
    events: sections.events,
    action_receipts: sections.actionReceipts,
    tasks: sections.tasks,
    draft_projections: sections.draftProjections,
    memory_entries: sections.memoryEntries,
    memory_suppressions: sections.memorySuppressions,
    memory_summaries: sections.memorySummaries,
    briefs: sections.briefs,
    brief_items: sections.briefItems,
    reminders: sections.reminders,
    system_jobs: sections.systemJobs,
    outbox: sections.outbox,
    media_objects: [...sections.mediaObjects, ...sections.mediaObjectsV2].map(({ object_key: _key, upload_token_hash: _ticket, upload_token_expires_at: _expiry, ...media }) => ({ ...media, original_url: `/api/workspaces/${encodeURIComponent(workspaceId)}/media/${encodeURIComponent(String(media.id))}` })),
    media_transcriptions: sections.mediaTranscriptions,
    message_image_attachments: sections.messageAttachments,
    interaction_state: sections.interactions ?? [],
    entity_contacts: sections.contacts ?? [],
    entity_redirects: sections.redirects ?? [],
    attachment_links: sections.attachmentLinks ?? [],
    reminder_rules: sections.reminderRules ?? [],
    document_extractions: (sections.documentExtractions ?? []).map(({ result_key: _key, ...extraction }) => extraction),
    media_annotations: sections.mediaAnnotations ?? [],
    records_lists: sections.recordsLists ?? [],
    records_list_columns: sections.recordsListColumns ?? [],
    records_rows: sections.recordsRows ?? [],
    records_values: sections.recordsValues ?? [],
  };

  return jsonSuccess(document, 200, {
    'x-request-id': requestId,
    'Content-Disposition': `attachment; filename="otis-export-${workspaceId}-${exportedAt.slice(0, 10)}.json"`,
  });
}
export interface ExportSections {
  interactions?: Record<string, unknown>[];
  contacts?: Record<string, unknown>[];
  redirects?: Record<string, unknown>[];
  attachmentLinks?: Record<string, unknown>[];
  reminderRules?: Record<string, unknown>[];
  documentExtractions?: Record<string, unknown>[];
  mediaAnnotations?: Record<string, unknown>[];
  recordsLists?: Record<string, unknown>[];
  recordsListColumns?: Record<string, unknown>[];
  recordsRows?: Record<string, unknown>[];
  recordsValues?: Record<string, unknown>[];
  users: Record<string, unknown>[];
  memberships: Record<string, unknown>[];
  settings: Record<string, unknown>[];
  chats: Record<string, unknown>[];
  messagesIn: Record<string, unknown>[];
  chatMessages: Record<string, unknown>[];
  agentRuns: Record<string, unknown>[];
  runSteps: Record<string, unknown>[];
  runActivity: Record<string, unknown>[];
  pendingClarifications: Record<string, unknown>[];
  entities: Record<string, unknown>[];
  entityAliases: Record<string, unknown>[];
  entityState: Record<string, unknown>[];
  fieldDefs: Record<string, unknown>[];
  events: Record<string, unknown>[];
  actionReceipts: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  draftProjections: Record<string, unknown>[];
  memoryEntries: Record<string, unknown>[];
  memorySuppressions: Record<string, unknown>[];
  memorySummaries: Record<string, unknown>[];
  briefs: Record<string, unknown>[];
  briefItems: Record<string, unknown>[];
  reminders: Record<string, unknown>[];
  systemJobs: Record<string, unknown>[];
  outbox: Record<string, unknown>[];
  mediaObjects: Record<string, unknown>[];
  mediaObjectsV2: Record<string, unknown>[];
  mediaTranscriptions: Record<string, unknown>[];
  messageAttachments: Record<string, unknown>[];
}

/**
 * Reads every exported workspace store in one batch roundtrip. The
 * reminders and v2 media reads degrade to empty lists on databases that
 * predate those migrations instead of failing the whole collection.
 */
export async function collectWorkspaceExportSections(
  db: D1Database,
  workspaceId: string,
): Promise<ExportSections> {
  const q = (sql: string) => db.prepare(sql).bind(workspaceId);
  // The reminders table ships with migration 0018; a database that has not
  // applied it yet exports an empty reminder list instead of failing.
  const hasReminders = await db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reminders'`,
  ).first();
  const reminderQuery = hasReminders
    ? q(`SELECT * FROM reminders WHERE workspace_id = ?`)
    : null;
  const results = await db.batch([
    db.prepare(
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

  // media_objects_v2 carries the current image inventory when present.
  let mediaV2: Record<string, unknown>[] = [];
  try {
    const v2 = await db.prepare(`SELECT * FROM media_objects_v2 WHERE workspace_id = ?`)
      .bind(workspaceId)
      .all();
    mediaV2 = ((v2 as unknown as { results?: Record<string, unknown>[] }).results ?? []);
  } catch {
    // Pre-images migration databases simply have no v2 inventory.
  }

  const detailTables = ['interaction_state', 'entity_contacts', 'entity_redirects', 'attachment_links', 'reminder_rules', 'document_extractions', 'media_annotations', 'records_lists', 'records_list_columns', 'records_rows', 'records_values'];
  const present = new Set((await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map(r => r.name));
  const available = detailTables.filter(table => present.has(table));
  const details = available.length ? await db.batch(available.map(table => q(`SELECT * FROM ${table} WHERE workspace_id = ?`))) : [];
  const detail = (table: string) => (details[available.indexOf(table)]?.results ?? []) as Record<string, unknown>[];
  return {
    interactions: detail('interaction_state'), contacts: detail('entity_contacts'), redirects: detail('entity_redirects'), attachmentLinks: detail('attachment_links'), reminderRules: detail('reminder_rules'), documentExtractions: detail('document_extractions'), mediaAnnotations: detail('media_annotations'),
    recordsLists: detail('records_lists'), recordsListColumns: detail('records_list_columns'), recordsRows: detail('records_rows'), recordsValues: detail('records_values'),
    users: rowsAt(0),
    memberships: rowsAt(1),
    settings: rowsAt(2),
    chats: rowsAt(3),
    messagesIn: rowsAt(4),
    chatMessages: rowsAt(5),
    agentRuns: rowsAt(6),
    runSteps: rowsAt(7),
    runActivity: rowsAt(8),
    pendingClarifications: rowsAt(9),
    entities: rowsAt(10),
    entityAliases: rowsAt(11),
    entityState: rowsAt(12),
    fieldDefs: rowsAt(13),
    events: rowsAt(14),
    actionReceipts: rowsAt(15),
    tasks: rowsAt(16),
    draftProjections: rowsAt(17),
    memoryEntries: rowsAt(18),
    memorySuppressions: rowsAt(19),
    memorySummaries: rowsAt(20),
    briefs: rowsAt(21),
    briefItems: rowsAt(22),
    reminders: hasReminders ? rowsAt(23) : [],
    systemJobs: tailAt(24),
    outbox: tailAt(25),
    mediaObjects: tailAt(26),
    mediaObjectsV2: mediaV2,
    mediaTranscriptions: tailAt(27),
    messageAttachments: tailAt(28),
  };
}

type SheetCell = string | number | boolean | null;

/** Longest cell body kept per spreadsheet cell; overflow is marked, not cut silently. */
const MAX_CELL_CHARS = 8000;

function cellText(value: unknown): SheetCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const text = String(value);
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…[truncated]` : text;
}

function rowDate(value: unknown): SheetCell {
  if (typeof value !== 'string' || !value) return null;
  return value.slice(0, 19).replace('T', ' ');
}

/**
 * Maps collected export sections onto spreadsheet sheets. Scoped to the
 * same member-readable stores as the JSON document: conversations,
 * business records, tasks, drafts, memory and briefs. Secrets never enter
 * (they are not collected), and every sheet carries its source so a reader
 * can trace each row back to the workspace record.
 */
export function workspaceExportToSheets(
  sections: ExportSections,
  workspaceName: string,
  workspaceId: string,
  exportedAt: string,
): { sheets: SheetData[]; filename: string } {
  const memberName = (userId: unknown): string | null => {
    if (typeof userId !== 'string' || !userId) return null;
    const member = sections.users.find((user) => user['id'] === userId);
    const display = member?.['display_name'];
    return typeof display === 'string' && display ? display : null;
  };
  const entityName = (entityId: unknown): string | null => {
    if (typeof entityId !== 'string' || !entityId) return null;
    let current = entityId;
    for (let depth = 0; depth < 32; depth++) { const redirect = sections.redirects?.find(r => r.source_entity_id === current); if (!redirect) break; current = String(redirect.target_entity_id); }
    const entity = sections.entities.find((row) => row['id'] === current);
    const name = entity?.['name'];
    return typeof name === 'string' ? name : null;
  };
  const chatTitle = (chatId: unknown): string | null => {
    if (typeof chatId !== 'string' || !chatId) return null;
    const chat = sections.chats.find((row) => row['id'] === chatId);
    const title = chat?.['title'];
    return typeof title === 'string' ? title : null;
  };
  const dueLabel = (task: Record<string, unknown>): string | null => {
    if (task['due_local_date']) return String(task['due_local_date']);
    if (task['due_instant']) return String(task['due_instant']);
    return null;
  };
  const counts: Array<[string, number]> = [
    ['Chats', sections.chats.length],
    ['Messages', sections.chatMessages.length],
    ['Entities', sections.entities.length],
    ['Tasks', sections.tasks.length],
    ['Drafts', sections.draftProjections.length],
    ['Memory notes', sections.memoryEntries.length],
    ['Briefs', sections.briefs.length],
    ['Reminders', sections.reminders.length],
    ['Records lists', sections.recordsLists?.length ?? 0],
    ['Records rows', sections.recordsRows?.length ?? 0],
  ];
  const sheets: SheetData[] = [
    {
      name: 'Summary',
      headers: ['Workspace snapshot', ''],
      rows: [
        ['Workspace', workspaceName],
        ['Workspace ID', workspaceId],
        ['Exported at (UTC)', exportedAt],
        ...counts.map(([label, total]): SheetCell[] => [label, total]),
      ],
    },
    {
      name: 'Chats',
      headers: ['Title', 'Author', 'Created'],
      rows: sections.chats.map((chat) => [
        cellText(chat['title']),
        cellText(memberName(chat['author_user_id']) ?? chat['author_user_id']),
        rowDate(chat['created_at']),
      ]),
    },
    {
      name: 'Messages',
      headers: ['Chat', 'Author', 'Text', 'Sequence', 'Sent at (UTC)'],
      rows: sections.chatMessages.map((message) => [
        cellText(chatTitle(message['chat_id']) ?? message['chat_id']),
        message['author_kind'] === 'member'
          ? cellText(memberName(message['author_user_id']) ?? message['author_user_id'])
          : 'Otis',
        cellText(message['content_text']),
        typeof message['sequence'] === 'number' ? message['sequence'] : null,
        rowDate(message['created_at']),
      ]),
    },
    {
      name: 'Entities',
      headers: ['Name', 'Kind', 'Status'],
      rows: sections.entities.map((entity) => [
        cellText(entity['name']),
        cellText(entity['kind']),
        cellText(entity['status']),
      ]),
    },
    {
      name: 'Tasks',
      headers: ['Title', 'Status', 'Due', 'Snoozed until', 'Promise', 'No deadline'],
      rows: sections.tasks.map((task) => [
        cellText(task['title']),
        cellText(task['status']),
        cellText(dueLabel(task)),
        cellText(task['snooze_until']),
        task['is_promise'] ? 'yes' : null,
        task['due_kind'] === null && task['explicit_no_deadline'] ? 'yes' : null,
      ]),
    },
    {
      name: 'Memory',
      headers: ['Scope', 'Subject', 'Category', 'Observed', 'Content'],
      rows: sections.memoryEntries.map((note) => [
        cellText(note['scope']),
        note['scope'] === 'entity'
          ? cellText(entityName(note['subject_id']) ?? note['subject_id'])
          : cellText(note['subject_id']),
        cellText(note['category']),
        rowDate(note['observed_at']),
        cellText(note['content']),
      ]),
    },
    {
      name: 'Drafts',
      headers: ['Channel', 'Recipient', 'Status', 'Content'],
      rows: sections.draftProjections.map((draft) => [
        cellText(draft['channel']),
        cellText(draft['recipient_address']),
        cellText(draft['status']),
        cellText(draft['content_text']),
      ]),
    },
    {
      name: 'Reminders',
      headers: ['Title', 'Due at (UTC)', 'Status', 'Created at (UTC)'],
      rows: sections.reminders.map((reminder) => [
        cellText(reminder['title']),
        rowDate(reminder['due_at']),
        cellText(reminder['status']),
        rowDate(reminder['created_at']),
      ]),
    },
    {
      name: 'Briefs',
      headers: ['Member', 'Channel', 'Status', 'Delivery time', 'Created at (UTC)'],
      rows: sections.briefs.map((brief) => [
        cellText(memberName(brief['member_user_id']) ?? brief['member_user_id']),
        cellText(brief['delivery_channel']),
        cellText(brief['status']),
        cellText(brief['delivery_time']),
        rowDate(brief['created_at']),
      ]),
    },
  ];
  for (const [name, rows] of [
    ['Contacts', sections.contacts],
    ['Combined clients', sections.redirects],
    ['File links', sections.attachmentLinks],
    ['Follow-up rules', sections.reminderRules],
    ['Document text inventory', sections.documentExtractions],
    ['Media annotations', sections.mediaAnnotations],
    ['Records lists', sections.recordsLists],
    ['Records columns', sections.recordsListColumns],
    ['Records rows', sections.recordsRows],
    ['Records values', sections.recordsValues],
  ] as const) {
    if (!rows?.length) continue;
    const headers = Object.keys(rows[0]!);
    sheets.push({ name, headers, rows: rows.map(row => headers.map(key => cellText(row[key]))) });
  }
  return { sheets, filename: `otis-export-${workspaceId}-${exportedAt.slice(0, 10)}.xlsx` };
}
