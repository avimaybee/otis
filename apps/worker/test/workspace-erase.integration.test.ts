import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import { AUTH_BOUNDS } from '@otis/contracts';
import { acceptWebMessage, createChat } from '../src/inbox/repository.js';
import { executeLedgerCommand, getWorkspaceRevision, handleCreateEntity } from '@otis/ledger';
import { renditionKeyFor } from '../src/media/renditions.js';
import { sha256 } from '@otis/identity';

/**
 * R11 erasure drill: seeds every workspace-scoped store (including a
 * revert-linked event chain that exercises the RESTRICT self-reference and
 * real R2 bytes plus a rendition), deletes the workspace through the
 * production DELETE route, and verifies cross-store removal, survivor
 * scope, the erasure tombstone and restored append-only guards.
 */

const CSRF = {
  origin: 'http://localhost',
  [AUTH_BOUNDS.CSRF_HEADER]: '1',
  'Content-Type': 'application/json',
};

const WS_E = 'ws-erase-drill';
const WS_E2 = 'ws-erase-denials';
const OWNER = 'usr_erase_owner';
const MEMBER = 'usr_erase_member';
const OUTSIDER = 'usr_erase_outsider';

let ownerCookie = '';
let memberCookie = '';
let outsiderCookie = '';

async function call(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('Cookie', init.cookie);
  return SELF.fetch(`http://localhost${path}`, { ...init, headers });
}

beforeAll(async () => {
  await applyMigrations(env.DB);

  const now = new Date().toISOString();
  for (const [id, fb, email, name] of [
    [OWNER, 'fb_erase_owner', 'owner@erase.test', 'Erase Owner'],
    [MEMBER, 'fb_erase_member', 'member@erase.test', 'Erase Member'],
    [OUTSIDER, 'fb_erase_outsider', 'outsider@erase.test', 'Erase Outsider'],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, fb, email, name, now, now)
      .run();
  }

  for (const [workspaceId, name] of [
    [WS_E, 'Erased Business'],
    [WS_E2, 'Standing Business'],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
       VALUES (?, ?, ?, 0, 1, ?, ?)`,
    )
      .bind(workspaceId, name, OWNER, now, now)
      .run();
    for (const [user, role] of [
      [OWNER, 'owner'],
      [MEMBER, 'member'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(workspaceId, user, role, now, now, now)
        .run();
    }
  }

  for (const [sid, raw, user] of [
    ['sess_erase_owner', 'erase_token_owner', OWNER],
    ['sess_erase_member', 'erase_token_member', MEMBER],
    ['sess_erase_outsider', 'erase_token_outsider', OUTSIDER],
  ] as const) {
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
      .bind(sid, await sha256(raw), user, now, expiresAt, now)
      .run();
    const cookie = `${AUTH_BOUNDS.COOKIE_NAME}=${raw}`;
    if (user === OWNER) ownerCookie = cookie;
    else if (user === MEMBER) memberCookie = cookie;
    else outsiderCookie = cookie;
  }
});

/** Commits a real entity through the ledger boundary in the given workspace. */
async function commitEraseEntity(workspaceId: string, chatId: string, tag: string): Promise<string> {
  const accepted = await acceptWebMessage(env.DB, {
    workspaceId,
    chatId,
    userId: OWNER,
    clientMessageId: `cm-erase-${tag}`,
    text: `Create Erase ${tag}`,
  });
  const inbound = await env.DB.prepare(`SELECT id FROM messages_in WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(workspaceId)
    .first<{ id: string }>();
  const revision = await getWorkspaceRevision(env.DB, workspaceId);
  const result = await executeLedgerCommand(
    env.DB,
    {
      workspace_id: workspaceId,
      action_id: `act-erase-${tag}`,
      expected_business_revision: revision?.business_revision ?? 0,
      actor: { kind: 'member', user_id: OWNER },
      membership_revision: 1,
      request_id: `req-erase-${tag}`,
      source_message_id: inbound?.id ?? accepted.message_id,
      source_channel: 'web',
      chat_id: chatId,
    },
    'create_entity',
    { name: `Erase ${tag}` },
    handleCreateEntity,
    undefined,
    { deferRunTransition: true },
  );
  expect(result.status).toBe('applied');
  const entity = await env.DB.prepare(`SELECT id FROM entities WHERE workspace_id = ? LIMIT 1`)
    .bind(workspaceId)
    .first<{ id: string }>();
  return entity!.id;
}

const WS_TABLES = [
  'workspace_users',
  'membership_audit',
  'invites',
  'provider_credentials',
  'workspace_settings',
  'member_settings',
  'settings_audit',
  'chats',
  'messages_in',
  'system_jobs',
  'agent_runs',
  'chat_messages',
  'run_steps',
  'run_activity',
  'pending_clarifications',
  'outbox',
  'entities',
  'entity_aliases',
  'events',
  'action_receipts',
  'entity_state',
  'tasks',
  'draft_projections',
  'field_defs',
  'memory_entries',
  'memory_suppressions',
  'memory_summaries',
  'memory_refresh_jobs',
  'workspace_daily_actions',
  'workspace_voice_settings',
  'media_objects',
  'media_transcriptions',
  'briefs',
  'message_image_attachments',
  'reminders',
  'interaction_state',
  'entity_contacts',
  'entity_redirects',
  'attachment_links',
  'reminder_rules',
  'reminder_rule_cursors',
  'document_extractions',
  'media_annotations',
];

describe('Workspace erasure drill', () => {
  it('removes every workspace store, R2 bytes, and records an audited tombstone', async () => {
    expect(env.STORAGE).toBeDefined();
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 30 * 86400 * 1000).toISOString();

    const chat = await createChat(env.DB, { workspaceId: WS_E, authorUserId: OWNER, title: 'Erase chat' });
    const entityId = await commitEraseEntity(WS_E, chat.id, 'seed');

    const run = await env.DB.prepare(`SELECT id FROM agent_runs WHERE workspace_id = ? LIMIT 1`)
      .bind(WS_E)
      .first<{ id: string }>();
    const inbound = await env.DB.prepare(`SELECT id FROM messages_in WHERE workspace_id = ? LIMIT 1`)
      .bind(WS_E)
      .first<{ id: string }>();
    const message = await env.DB.prepare(`SELECT id FROM chat_messages WHERE workspace_id = ? LIMIT 1`)
      .bind(WS_E)
      .first<{ id: string }>();
    const event = await env.DB.prepare(`SELECT id FROM events WHERE workspace_id = ? LIMIT 1`)
      .bind(WS_E)
      .first<{ id: string }>();
    const maxSeq = await env.DB.prepare(`SELECT MAX(sequence) AS m FROM events WHERE workspace_id = ?`)
      .bind(WS_E)
      .first<{ m: number | null }>();
    const s1 = (maxSeq?.m ?? 0) + 1;

    await env.DB.batch([
      // Revert-linked event pair: exercises the events RESTRICT self-reference.
      env.DB.prepare(
        `INSERT INTO events (id, workspace_id, sequence, entity_id, actor_kind, actor_user_id, kind, schema_version, payload_json, occurred_at, recorded_at, channel, source_message_id, action_id, provenance, created_at)
         VALUES ('evt-erase-1', ?, ${s1}, ?, 'member', ?, 'note', 1, '{}', ?, ?, 'web', ?, 'act-erase-man-1', 'stated', ?)`,
      ).bind(WS_E, entityId, OWNER, now, now, inbound!.id, now),
      env.DB.prepare(
        `INSERT INTO events (id, workspace_id, sequence, entity_id, actor_kind, actor_user_id, kind, schema_version, payload_json, occurred_at, recorded_at, channel, source_message_id, action_id, reverts_event_id, provenance, created_at)
         VALUES ('evt-erase-2', ?, ${s1 + 1}, ?, 'member', ?, 'revert', 1, '{}', ?, ?, 'web', ?, 'act-erase-man-2', 'evt-erase-1', 'stated', ?)`,
      ).bind(WS_E, entityId, OWNER, now, now, inbound!.id, now),
      env.DB.prepare(
        `INSERT INTO entity_aliases (id, workspace_id, entity_id, alias, created_at) VALUES ('eal-erase-1', ?, ?, 'Erase Alias', ?)`,
      ).bind(WS_E, entityId, now),
      env.DB.prepare(
        `INSERT INTO entity_state (id, workspace_id, entity_id, field_name, state, value_text, provenance, revision, updated_at)
         VALUES ('est-erase-1', ?, ?, 'phone', 'clear', 'x', 'stated', 1, ?)`,
      ).bind(WS_E, entityId, now),
      env.DB.prepare(
        `INSERT INTO tasks (id, workspace_id, entity_id, title, status, source_event_id, revision, created_at, updated_at)
         VALUES ('tsk-erase-1', ?, ?, 'Erase task', 'open', ?, 1, ?, ?)`,
      ).bind(WS_E, entityId, event!.id, now, now),
      env.DB.prepare(
        `INSERT INTO draft_projections (id, workspace_id, entity_id, channel, content_text, status, source_event_id, revision, created_at, updated_at)
         VALUES ('drf-erase-1', ?, ?, 'whatsapp', 'hi', 'draft', ?, 1, ?, ?)`,
      ).bind(WS_E, entityId, event!.id, now, now),
      env.DB.prepare(
        `INSERT INTO field_defs (id, workspace_id, field_name, display_label, value_type, created_at, updated_at)
         VALUES ('fld-erase-1', ?, 'loyalty_id', 'Loyalty', 'string', ?, ?)`,
      ).bind(WS_E, now, now),
      env.DB.prepare(
        `INSERT INTO memory_entries (id, workspace_id, scope, category, content, status, observed_at, created_at, business_revision)
         VALUES ('mem-erase-1', ?, 'workspace', 'other_context', 'erase note', 'active', ?, ?, 0)`,
      ).bind(WS_E, now, now),
      env.DB.prepare(
        `INSERT INTO memory_suppressions (id, workspace_id, target_memory_id, suppression_event_id, revision, created_at)
         VALUES ('msp-erase-1', ?, 'mem-erase-1', ?, 1, ?)`,
      ).bind(WS_E, event!.id, now),
      env.DB.prepare(
        `INSERT INTO memory_summaries (id, workspace_id, scope, subject_key, summary_text, source_manifest_json, built_from_revision, built_at)
         VALUES ('msm-erase-1', ?, 'workspace', 'ws', 'summary', '{}', 0, ?)`,
      ).bind(WS_E, now),
      env.DB.prepare(
        `INSERT INTO memory_refresh_jobs (id, workspace_id, scope, subject_key, target_revision, state, next_attempt_at, created_at, updated_at)
         VALUES ('mrj-erase-1', ?, 'workspace', 'ws', 0, 'pending', ?, ?, ?)`,
      ).bind(WS_E, now, now, now),
      env.DB.prepare(
        `INSERT INTO briefs (id, workspace_id, user_id, local_date, body_text, created_at, updated_at)
         VALUES ('brf-erase-1', ?, ?, '2026-10-07', 'erase brief', ?, ?)`,
      ).bind(WS_E, OWNER, now, now),
      env.DB.prepare(
        `INSERT INTO brief_items (brief_id, position, kind, title, reason) VALUES ('brf-erase-1', 0, 'undated', 'erase item', 'erase')`,
      ),
      env.DB.prepare(
        `INSERT INTO reminders (id, workspace_id, user_id, action_id, text, remind_at, channel, status, created_at, updated_at)
         VALUES ('rem-erase-1', ?, ?, 'act-erase-rem-1', 'erase reminder', ?, 'web', 'pending', ?, ?)`,
      ).bind(WS_E, OWNER, future, now, now),
      env.DB.prepare(
        `INSERT INTO system_jobs (id, workspace_id, job_kind, status, scheduled_at, created_at, updated_at)
         VALUES ('job-erase-1', ?, 'export', 'pending', ?, ?, ?)`,
      ).bind(WS_E, now, now, now),
      env.DB.prepare(
        `INSERT INTO run_steps (id, run_id, workspace_id, step_index, tool_name, arguments_hash, arguments_json, status, created_at, updated_at)
         VALUES ('stp-erase-1', ?, ?, 0, 'view_entity', 'h', '{}', 'planned', ?, ?)`,
      ).bind(run!.id, WS_E, now, now),
      env.DB.prepare(
        `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
         VALUES ('rac-erase-1', ?, ?, ?, 7001, 'queued', '{}', ?)`,
      ).bind(WS_E, chat.id, run!.id, now),
      env.DB.prepare(
        `INSERT INTO pending_clarifications (id, workspace_id, chat_id, run_id, source_message_id, requester_user_id, question, intended_operation, missing_fields, source_revision, created_at, updated_at)
         VALUES ('clr-erase-1', ?, ?, ?, ?, ?, 'q?', 'create_entity', '[]', 1, ?, ?)`,
      ).bind(WS_E, chat.id, run!.id, inbound!.id, OWNER, now, now),
      env.DB.prepare(
        `INSERT INTO outbox (id, workspace_id, destination, topic, payload_json, status, created_at, updated_at)
         VALUES ('obx-erase-1', ?, 'telegram', 'send', '{}', 'pending', ?, ?)`,
      ).bind(WS_E, now, now),
      env.DB.prepare(
        `INSERT INTO media_objects (id, workspace_id, chat_id, uploader_user_id, state, object_key, content_type, format, byte_size, expires_at, created_at, updated_at)
         VALUES ('med-erase-1', ?, ?, ?, 'validated', ?, 'image/png', 'image/png', 11, ?, ?, ?)`,
      ).bind(WS_E, chat.id, OWNER, `workspace/${WS_E}/media/med-erase-1`, future, now, now),
      env.DB.prepare(
        `INSERT INTO media_transcriptions (id, workspace_id, media_id, state, route, format, created_at, updated_at)
         VALUES ('mtr-erase-1', ?, 'med-erase-1', 'pending', 'groq_stt', 'audio/webm', ?, ?)`,
      ).bind(WS_E, now, now),
      env.DB.prepare(
        `INSERT INTO message_image_attachments (chat_message_id, media_id, workspace_id, position, created_at)
         VALUES (?, 'med-erase-1', ?, 0, ?)`,
      ).bind(message!.id, WS_E, now),
      env.DB.prepare(
        `INSERT INTO invites (id, token_hash, workspace_id, invited_email, invited_by_user_id, created_at, expires_at)
         VALUES ('inv-erase-1', 'erasehash1', ?, 'e@x.test', ?, ?, ?)`,
      ).bind(WS_E, OWNER, now, future),
      env.DB.prepare(
        `INSERT INTO invite_redemptions (invite_id, user_id, redeemed_at, guard_ok) VALUES ('inv-erase-1', ?, ?, 1)`,
      ).bind(MEMBER, now),
      env.DB.prepare(
        `INSERT INTO member_settings (workspace_id, user_id, brief_channel, preferred_language, created_at, updated_at)
         VALUES (?, ?, 'web', 'en', ?, ?)`,
      ).bind(WS_E, MEMBER, now, now),
      env.DB.prepare(`INSERT INTO workspace_settings (workspace_id, created_at, updated_at) VALUES (?, ?, ?)`).bind(
        WS_E,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO settings_audit (id, workspace_id, user_id, actor_user_id, scope, changed_fields_json, occurred_at)
         VALUES ('sau-erase-1', ?, ?, ?, 'member', '{}', ?)`,
      ).bind(WS_E, MEMBER, OWNER, now),
      env.DB.prepare(
        `INSERT INTO membership_audit (id, workspace_id, user_id, actor_user_id, action, occurred_at)
         VALUES ('mau-erase-1', ?, ?, ?, 'joined', ?)`,
      ).bind(WS_E, MEMBER, OWNER, now),
      env.DB.prepare(
        `INSERT INTO provider_credentials (workspace_id, provider, encrypted_key, key_nonce, key_version, status, created_at, updated_at)
         VALUES (?, 'gemini', 'erase-secret', 'n', 1, 'available', ?, ?)`,
      ).bind(WS_E, now, now),
      env.DB.prepare(`INSERT INTO workspace_voice_settings (workspace_id, created_at, updated_at) VALUES (?, ?, ?)`).bind(
        WS_E,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO workspace_daily_actions (workspace_id, date_utc, action_count, updated_at) VALUES (?, '2026-10-06', 1, ?)`,
      ).bind(WS_E, now),
      env.DB.prepare(
        `INSERT INTO interaction_state (workspace_id, root_event_id, entity_id, kind, head_event_id, revision, state, occurred_at, sequence, updated_at)
         VALUES (?, 'evt-erase-1', ?, 'note', 'evt-erase-1', 1, 'active', ?, 1, ?)`,
      ).bind(WS_E, entityId, now, now),
      env.DB.prepare(
        `INSERT INTO entity_contacts (id, workspace_id, entity_id, method, value, comparison_key, label, is_primary, state, revision, source_event_id, original_event_id, updated_at)
         VALUES ('ctc-erase-1', ?, ?, 'email', 'erase@example.com', 'erase@example.com', NULL, 1, 'active', 1, 'evt-erase-1', 'evt-erase-1', ?)`,
      ).bind(WS_E, entityId, now),
      env.DB.prepare(
        `INSERT INTO entities (id, workspace_id, name, created_at, updated_at) VALUES ('ent-other-erase', ?, 'Other', ?, ?)`,
      ).bind(WS_E, now, now),
      env.DB.prepare(
        `INSERT INTO entity_redirects (workspace_id, source_entity_id, target_entity_id, source_event_id, decisions_json, revision, updated_at)
         VALUES (?, ?, 'ent-other-erase', 'evt-erase-1', '{}', 1, ?)`,
      ).bind(WS_E, entityId, now),
      env.DB.prepare(
        `INSERT INTO attachment_links (id, workspace_id, entity_id, interaction_id, media_id, label, state, revision, source_event_id, updated_at)
         VALUES ('lnk-erase-1', ?, ?, NULL, 'med-erase-1', NULL, 'active', 1, 'evt-erase-1', ?)`,
      ).bind(WS_E, entityId, now),
      env.DB.prepare(
        `INSERT INTO reminder_rules (id, workspace_id, user_id, entity_id, text, timezone, channel, spec_json, status, revision, source_event_id, updated_at)
         VALUES ('rul-erase-1', ?, ?, ?, 'Check client', 'UTC', 'web', '{}', 'active', 1, 'evt-erase-1', ?)`,
      ).bind(WS_E, OWNER, entityId, now),
      env.DB.prepare(
        `INSERT INTO reminder_rule_cursors (rule_id, workspace_id, rule_revision, next_due, dirty, last_delivered_at, updated_at)
         VALUES ('rul-erase-1', ?, 1, ?, 0, NULL, ?)`,
      ).bind(WS_E, future, now),
      env.DB.prepare(
        `INSERT INTO document_extractions (media_id, workspace_id, checksum, extractor_version, state, result_key, updated_at)
         VALUES ('med-erase-1', ?, 'chk123', 1, 'ready', ?, ?)`,
      ).bind(WS_E, `workspace/${WS_E}/docs/doc-erase-1`, now),
      env.DB.prepare(
        `INSERT INTO media_annotations (media_id, workspace_id, transcript, retention, release_after, revision, source_event_id, updated_at)
         VALUES ('med-erase-1', ?, 'erase doc transcript', 'retain', ?, 1, 'evt-erase-1', ?)`,
      ).bind(WS_E, future, now),
    ]);

    // Person-scoped pointers aimed at the doomed workspace.
    await env.DB.prepare(
      `INSERT INTO link_codes (id, code_hash, user_id, created_at, expires_at, requested_workspace_id)
       VALUES ('lc-erase-1', 'erasecodehash1', ?, ?, ?, ?)`,
    )
      .bind(OWNER, now, future, WS_E)
      .run();
    await env.DB.prepare(
      `INSERT INTO telegram_users (telegram_user_id, user_id, selected_workspace_id, active_chat_id, created_at, updated_at)
       VALUES ('tg-erase-1', ?, ?, ?, ?, ?)`,
    )
      .bind(MEMBER, WS_E, chat.id, now, now)
      .run();

    // Real R2 bytes: the original plus its deterministic rendition and document extraction.
    const objectKey = `workspace/${WS_E}/media/med-erase-1`;
    const docResultKey = `workspace/${WS_E}/docs/doc-erase-1`;
    await env.STORAGE!.put(objectKey, new TextEncoder().encode('erase-bytes'));
    await env.STORAGE!.put(renditionKeyFor('med-erase-1'), new TextEncoder().encode('rendition'));
    await env.STORAGE!.put(docResultKey, new TextEncoder().encode('doc-bytes'));
    expect(await env.STORAGE!.get(objectKey)).not.toBeNull();
    expect(await env.STORAGE!.get(docResultKey)).not.toBeNull();

    // Sanity: the drill workspace is fully populated before deletion.
    for (const table of ['events', 'entities', 'tasks', 'chat_messages', 'media_objects', 'reminders', 'briefs']) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`)
        .bind(WS_E)
        .first<{ n: number }>();
      expect(Number(row?.n)).toBeGreaterThan(0);
    }

    const res = await call(`/api/workspaces/${WS_E}`, {
      method: 'DELETE',
      cookie: ownerCookie,
      headers: CSRF,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted: boolean }).deleted).toBe(true);

    // Every workspace store reads back empty.
    for (const table of WS_TABLES) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`)
        .bind(WS_E)
        .first<{ n: number }>();
      expect(`${table}:${Number(row?.n ?? -1)}`).toBe(`${table}:0`);
    }
    const joined = await env.DB.batch([
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM brief_items WHERE brief_id IN (SELECT id FROM briefs WHERE workspace_id = ?)`,
      ).bind(WS_E),
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM invite_redemptions WHERE invite_id IN (SELECT id FROM invites WHERE workspace_id = ?)`,
      ).bind(WS_E),
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM memory_entries_fts WHERE entry_id IN (SELECT id FROM memory_entries WHERE workspace_id = ?)`,
      ).bind(WS_E),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE id = ?`).bind(WS_E),
    ]);
    for (const result of joined) {
      const n = Number((result as unknown as { results?: Array<{ n: number }> }).results?.[0]?.n ?? -1);
      expect(n).toBe(0);
    }

    // R2 bytes are gone with their rows.
    expect(await env.STORAGE!.get(objectKey)).toBeNull();
    expect(await env.STORAGE!.get(renditionKeyFor('med-erase-1'))).toBeNull();
    expect(await env.STORAGE!.get(docResultKey)).toBeNull();

    // The tombstone records what left, by whom, without business content.
    const tomb = await env.DB.prepare(
      `SELECT workspace_id, workspace_name, actor_user_id, counts_json, media_objects_deleted FROM workspace_erasures WHERE workspace_id = ?`,
    )
      .bind(WS_E)
      .first<{
        workspace_id: string;
        workspace_name: string;
        actor_user_id: string;
        counts_json: string;
        media_objects_deleted: number;
      }>();
    expect(tomb?.workspace_name).toBe('Erased Business');
    expect(tomb?.actor_user_id).toBe(OWNER);
    const counts = JSON.parse(tomb!.counts_json) as Record<string, number>;
    expect(counts['events']).toBeGreaterThanOrEqual(3);
    expect(counts['entities']).toBe(2);
    expect(counts['chats']).toBe(1);
    expect(counts['reminders']).toBe(1);
    expect(counts['interaction_state']).toBe(1);
    expect(counts['entity_contacts']).toBe(1);
    expect(counts['entity_redirects']).toBe(1);
    expect(counts['attachment_links']).toBe(1);
    expect(counts['reminder_rules']).toBe(1);
    expect(counts['reminder_rule_cursors']).toBe(1);
    expect(counts['document_extractions']).toBe(1);
    expect(counts['media_annotations']).toBe(1);
    expect(tomb?.media_objects_deleted).toBe(1);
    expect(tomb!.counts_json).not.toContain('erase-bytes');

    // Append-only guards are restored for the surviving workspaces.
    const triggers = (
      await env.DB.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_events_prevent_delete', 'trg_action_receipts_prevent_delete')`,
      ).all<{ name: string }>()
    ).results;
    expect(triggers.map((t) => t.name).sort()).toEqual([
      'trg_action_receipts_prevent_delete',
      'trg_events_prevent_delete',
    ]);

    // Survivors: people, sessions, the other workspace, and nulled pointers.
    for (const id of [OWNER, MEMBER, OUTSIDER]) {
      const user = await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(id).first();
      expect(user).toBeTruthy();
    }
    const sessions = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions`).first<{ n: number }>();
    expect(Number(sessions?.n)).toBe(3);
    const other = await env.DB.prepare(`SELECT id FROM workspaces WHERE id = ?`).bind(WS_E2).first();
    expect(other).toBeTruthy();
    const link = await env.DB.prepare(
      `SELECT id, requested_workspace_id FROM link_codes WHERE id = 'lc-erase-1'`,
    ).first<{ id: string; requested_workspace_id: string | null }>();
    expect(link?.id).toBe('lc-erase-1');
    expect(link?.requested_workspace_id).toBeNull();
    const tg = await env.DB.prepare(
      `SELECT selected_workspace_id, active_chat_id FROM telegram_users WHERE telegram_user_id = 'tg-erase-1'`,
    ).first<{ selected_workspace_id: string | null; active_chat_id: string | null }>();
    expect(tg?.selected_workspace_id).toBeNull();
    expect(tg?.active_chat_id).toBeNull();

    // The ledger stays writable afterwards: a real command applies in WS_E2.
    const chat2 = await createChat(env.DB, { workspaceId: WS_E2, authorUserId: OWNER, title: 'Standing chat' });
    await commitEraseEntity(WS_E2, chat2.id, 'after');
  });

  it('refuses non-owners and outsiders without touching the workspace', async () => {
    const memberDenied = await call(`/api/workspaces/${WS_E2}`, {
      method: 'DELETE',
      cookie: memberCookie,
      headers: CSRF,
    });
    expect(memberDenied.status).toBe(403);

    const outsiderDenied = await call(`/api/workspaces/${WS_E2}`, {
      method: 'DELETE',
      cookie: outsiderCookie,
      headers: CSRF,
    });
    expect(outsiderDenied.status).toBe(404);

    const stillThere = await env.DB.prepare(`SELECT id FROM workspaces WHERE id = ?`).bind(WS_E2).first();
    expect(stillThere).toBeTruthy();
  });
});
