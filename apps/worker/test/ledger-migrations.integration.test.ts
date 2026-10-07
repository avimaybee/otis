import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations, applyMigrationSql } from './migrations.js';

// @ts-expect-error Vite raw SQL import
import sql0020 from '../../../migrations/0020_quote_text_major_units.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql0021 from '../../../migrations/0021_entity_deleted_kind.sql?raw';

/**
 * Ledger migration drills on workerd D1, executing the actual migration
 * files (not copies): the quote backfill recomputes major-unit display
 * text, and the events rebuild preserves rows, self-references, indexes
 * and append-only guards while widening the kind CHECK.
 */

const WS = 'ws-ledger-migrations';
const AVI = 'usr_mig_avi';

async function seedIdentity() {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
     VALUES (?, 'fb_mig_avi', 'avi@mig.test', 'Avi', ?, ?)`,
  ).bind(AVI, now, now).run();
  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
     VALUES (?, 'Migrations', ?, 0, 1, ?, ?)`,
  ).bind(WS, AVI, now, now).run();
  await env.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?)`,
  ).bind(WS, AVI, now, now, now).run();
}

beforeAll(async () => {
  await applyMigrations(env.DB);
  await seedIdentity();
});

describe('0020 quote display backfill', () => {
  it('recomputes major-unit text from machine payloads, including disputed snapshots', async () => {
    const now = new Date().toISOString();
    // Legacy rows as the buggy reducer wrote them: raw minor units as text.
    // Seeded entities satisfy the entity_state entity_id foreign key.
    await env.DB.prepare(
      `INSERT INTO entities (id, workspace_id, name, kind, status, created_at, updated_at)
       VALUES ('ent-mig-1', ?, 'Mig One', 'lead', 'new', ?, ?), ('ent-mig-2', ?, 'Mig Two', 'lead', 'new', ?, ?), ('ent-mig-3', ?, 'Mig Three', 'lead', 'new', ?, ?)`,
    ).bind(WS, now, now, WS, now, now, WS, now, now).run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO entity_state (id, workspace_id, entity_id, field_name, state, value_text, value_json, provenance, source_event_id, revision, updated_at)
         VALUES ('est-mig-1', ?, 'ent-mig-1', 'quote', 'clear', '400000 RON (expected)',
           '{"amount":400000,"currency":"RON","role":"expected"}', 'stated', NULL, 1, ?)`,
      ).bind(WS, now),
      env.DB.prepare(
        `INSERT INTO entity_state (id, workspace_id, entity_id, field_name, state, value_text, value_json, provenance, source_event_id, revision, updated_at)
         VALUES ('est-mig-2', ?, 'ent-mig-2', 'quote', 'clear', '5000 JPY (offered)',
           '{"amount":5000,"currency":"JPY","role":"offered"}', 'stated', NULL, 1, ?)`,
      ).bind(WS, now),
      env.DB.prepare(
        `INSERT INTO entity_state (id, workspace_id, entity_id, field_name, state, value_text, value_json, provenance, revision, updated_at,
           candidate_event_ids_json, last_confirmed_value_text, last_confirmed_value_json)
         VALUES ('est-mig-3', ?, 'ent-mig-3', 'quote', 'disputed', NULL, NULL, 'stated', 2, ?,
           '["evt-mig-3a","evt-mig-3b"]', '300000 EUR (offered)',
           '{"amount":300000,"currency":"EUR","role":"offered"}')`,
      ).bind(WS, now),
    ]);

    await applyMigrationSql(env.DB, sql0020);

    const ron = await env.DB.prepare(`SELECT value_text FROM entity_state WHERE id = 'est-mig-1'`)
      .first<{ value_text: string }>();
    expect(ron?.value_text).toBe('4000 RON (expected)');
    const jpy = await env.DB.prepare(`SELECT value_text FROM entity_state WHERE id = 'est-mig-2'`)
      .first<{ value_text: string }>();
    expect(jpy?.value_text).toBe('5000 JPY (offered)');
    const disputed = await env.DB.prepare(
      `SELECT value_text, last_confirmed_value_text FROM entity_state WHERE id = 'est-mig-3'`,
    ).first<{ value_text: string | null; last_confirmed_value_text: string | null }>();
    expect(disputed?.value_text).toBeNull();
    expect(disputed?.last_confirmed_value_text).toBe('3000 EUR (offered)');
  });
});

describe('0021 entity_deleted kind rebuild', () => {
  it('preserves rows, self-references, indexes and guards while widening the kind set', async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, chat_id, created_at, updated_at)
       VALUES ('in-mig-1', ?, ?, 'web', 'ext-mig-1', 'fp', 'processed', NULL, ?, ?)`,
    ).bind(WS, AVI, now, now).run();
    await env.DB.prepare(
      `INSERT INTO entities (id, workspace_id, name, kind, status, created_at, updated_at)
       VALUES ('ent-mig-9', ?, 'Keepsake', 'lead', 'new', ?, ?)`,
    ).bind(WS, now, now).run();
    // A revert-linked pair exercises the self-referencing RESTRICT guards.
    await env.DB.prepare(
      `INSERT INTO events (id, workspace_id, sequence, entity_id, actor_kind, actor_user_id, kind, schema_version,
        payload_json, occurred_at, recorded_at, channel, source_message_id, action_id, provenance, created_at)
       VALUES ('evt-mig-9a', ?, 9101, 'ent-mig-9', 'member', ?, 'note', 1, '{"text":"hi"}', ?, ?, 'web', 'in-mig-1', 'act-mig-9a', 'stated', ?)`,
    ).bind(WS, AVI, now, now, now).run();
    await env.DB.prepare(
      `INSERT INTO events (id, workspace_id, sequence, entity_id, actor_kind, actor_user_id, kind, schema_version,
        payload_json, occurred_at, recorded_at, channel, source_message_id, action_id, reverts_event_id, provenance, created_at)
       VALUES ('evt-mig-9b', ?, 9102, 'ent-mig-9', 'member', ?, 'revert', 1, '{"target_event_id":"evt-mig-9a"}', ?, ?, 'web', 'in-mig-1', 'act-mig-9b', 'evt-mig-9a', 'stated', ?)`,
    ).bind(WS, AVI, now, now, now).run();

    await applyMigrationSql(env.DB, sql0021);

    // Rows and links survive the rebuild byte-identical.
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND sequence >= 9101`)
      .bind(WS)
      .first<{ n: number }>();
    expect(Number(count?.n)).toBe(2);
    const link = await env.DB.prepare(`SELECT reverts_event_id FROM events WHERE id = 'evt-mig-9b'`)
      .first<{ reverts_event_id: string }>();
    expect(link?.reverts_event_id).toBe('evt-mig-9a');
    const indexes = (
      await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'`)
        .all<{ name: string }>()
    ).results.map((r) => r.name);
    for (const name of ['idx_events_ws_seq', 'idx_events_ws_entity', 'idx_events_ws_action', 'idx_events_supersedes', 'idx_events_reverts']) {
      expect(indexes).toContain(name);
    }

    // The widened kind inserts; ordinary history deletion still aborts.
    await env.DB.prepare(
      `INSERT INTO events (id, workspace_id, sequence, entity_id, actor_kind, actor_user_id, kind, schema_version,
        payload_json, occurred_at, recorded_at, channel, source_message_id, action_id, provenance, created_at)
       VALUES ('evt-mig-9c', ?, 9103, 'ent-mig-9', 'member', ?, 'entity_deleted', 1, '{"name":"Keepsake"}', ?, ?, 'web', 'in-mig-1', 'act-mig-9c', 'stated', ?)`,
    ).bind(WS, AVI, now, now, now).run();
    const inserted = await env.DB.prepare(`SELECT kind FROM events WHERE id = 'evt-mig-9c'`)
      .first<{ kind: string }>();
    expect(inserted?.kind).toBe('entity_deleted');
    await expect(
      env.DB.prepare(`DELETE FROM events WHERE id = 'evt-mig-9c'`).run(),
    ).rejects.toThrow();
    // No backup table left behind.
    const leftover = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%backup_0021%'`,
    ).all();
    expect(leftover.results).toHaveLength(0);
  });
});
