import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { ALL_MIGRATION_SQL, applyMigrationSql } from './migrations.js';

/**
 * 0030 records-flexibility migration drill on workerd D1, executing the
 * actual migration file (not a copy). It lives in its own file because each
 * worker test file owns an isolated database: the historical 0020/0021
 * rebuilds in ledger-migrations narrow the events kind CHECK one way, so a
 * records drill sharing that database could not insert records events after
 * they run.
 */

const WS = 'ws-records-migration';
const MEMBER = 'usr_rec_mig';

async function seedIdentity() {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
     VALUES (?, 'fb_rec_mig', 'rec@mig.test', 'Rec', ?, ?)`,
  ).bind(MEMBER, now, now).run();
  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
     VALUES (?, 'Records Migration', ?, 0, 1, ?, ?)`,
  ).bind(WS, MEMBER, now, now).run();
  await env.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?)`,
  ).bind(WS, MEMBER, now, now, now).run();
  await env.DB.prepare(
    `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, chat_id, created_at, updated_at)
     VALUES ('in-rec-1', ?, ?, 'web', 'ext-rec-1', 'fp', 'processed', NULL, ?, ?)`,
  ).bind(WS, MEMBER, now, now).run();
}

beforeAll(async () => {
  // 0030 sits at index 29 of the append-only migration list. Migrations
  // before it run first, then identity, then 0030: its built-in list seed
  // selects from workspaces, so the workspace must already exist — the
  // same order production rollout sees. Later migrations run last.
  for (let i = 0; i < 29; i++) {
    await applyMigrationSql(env.DB, ALL_MIGRATION_SQL[i]!);
  }
  await seedIdentity();
  for (let i = 29; i < ALL_MIGRATION_SQL.length; i++) {
    await applyMigrationSql(env.DB, ALL_MIGRATION_SQL[i]!);
  }
});

describe('0030 records flexibility', () => {
  it('seeds built-in lists, accepts records events, and enforces multi-tenant PKs', async () => {
    const now = new Date().toISOString();

    // 1. Built-in lists seeded for workspace
    const lists = await env.DB.prepare(
      `SELECT id, name, source_kind FROM records_lists WHERE workspace_id = ? ORDER BY id`,
    )
      .bind(WS)
      .all<{ id: string; name: string; source_kind: string }>();

    expect(lists.results.map((l) => l.id)).toEqual(['drafts', 'leads', 'notes', 'tasks']);

    // 2. Insert records event
    await env.DB.prepare(
      `INSERT INTO events (id, workspace_id, sequence, entity_id, actor_kind, actor_user_id, kind, schema_version,
        payload_json, occurred_at, recorded_at, channel, source_message_id, action_id, provenance, created_at)
       VALUES ('evt-mig-30a', ?, 9201, NULL, 'member', ?, 'record_cell_changed', 1, '{"value":"test"}', ?, ?, 'web', 'in-rec-1', 'act-mig-30a', 'stated', ?)`,
    ).bind(WS, MEMBER, now, now, now).run();

    const inserted = await env.DB.prepare(`SELECT kind FROM events WHERE id = 'evt-mig-30a'`)
      .first<{ kind: string }>();
    expect(inserted?.kind).toBe('record_cell_changed');

    // Immutability trigger prevents deletion
    await expect(
      env.DB.prepare(`DELETE FROM events WHERE id = 'evt-mig-30a'`).run(),
    ).rejects.toThrow();

    // 3. Multi-tenant PK: inserting same row id into different workspace succeeds without collision
    const WS2 = 'ws-other-tenant';
    await env.DB.prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, business_revision, membership_revision, created_at, updated_at)
       VALUES (?, 'Other Tenant', 0, 1, ?, ?)`,
    ).bind(WS2, now, now).run();

    await env.DB.prepare(
      `INSERT INTO records_lists (workspace_id, id, name, source_kind, status, revision, created_at, updated_at)
       VALUES (?, 'custom_list_1', 'List 1', 'custom', 'active', 1, ?, ?)`,
    ).bind(WS, now, now).run();

    await env.DB.prepare(
      `INSERT INTO records_lists (workspace_id, id, name, source_kind, status, revision, created_at, updated_at)
       VALUES (?, 'custom_list_1', 'List 1', 'custom', 'active', 1, ?, ?)`,
    ).bind(WS2, now, now).run();

    const ws1List = await env.DB.prepare(`SELECT workspace_id, id FROM records_lists WHERE workspace_id = ? AND id = 'custom_list_1'`)
      .bind(WS)
      .first<{ workspace_id: string; id: string }>();
    const ws2List = await env.DB.prepare(`SELECT workspace_id, id FROM records_lists WHERE workspace_id = ? AND id = 'custom_list_1'`)
      .bind(WS2)
      .first<{ workspace_id: string; id: string }>();

    expect(ws1List?.workspace_id).toBe(WS);
    expect(ws2List?.workspace_id).toBe(WS2);

    // No backup table left behind
    const leftover = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%backup_0030%'`,
    ).all();
    expect(leftover.results).toHaveLength(0);
  });
});
