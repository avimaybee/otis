import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import { AUTH_BOUNDS } from '@otis/contracts';
import { sha256 } from '@otis/identity';
import { unifiedWorkspaceSearch } from '../src/unifiedSearch.js';
import { executeAgentTool } from '../src/agent/repository.js';

const CSRF = {
  origin: 'http://localhost',
  [AUTH_BOUNDS.CSRF_HEADER]: '1',
  'Content-Type': 'application/json',
};

const WS = 'ws-search-dup-test';
const USER = 'usr_search_dup';
let authCookie: string;

beforeAll(async () => {
  await applyMigrations(env.DB);

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
     VALUES (?, 'fb_search_dup', 'searchdup@test.local', 'Search Dup User', ?, ?)`,
  )
    .bind(USER, now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
     VALUES (?, 'Search Dup Workspace', ?, 0, 1, ?, ?)`,
  )
    .bind(WS, USER, now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?)`,
  )
    .bind(WS, USER, now, now, now)
    .run();

  const token = 'search_dup_token_123';
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
     VALUES ('sess_search_dup', ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(await sha256(token), USER, now, expiresAt, now)
    .run();

  authCookie = `${AUTH_BOUNDS.COOKIE_NAME}=${token}`;

  // Insert test entities
  await env.DB.prepare(
    `INSERT INTO entities (id, workspace_id, name, kind, status, assigned_user_id, created_at, updated_at)
     VALUES ('ent_alpha', ?, 'Alpha Logistics', 'lead', 'warm', ?, ?, ?)`,
  )
    .bind(WS, USER, now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO entities (id, workspace_id, name, kind, status, assigned_user_id, created_at, updated_at)
     VALUES ('ent_beta', ?, 'Alpha Logistics SRL', 'lead', 'new', ?, ?, ?)`,
  )
    .bind(WS, USER, now, now)
    .run();

  // Set company field in entity_state
  await env.DB.prepare(
    `INSERT INTO entity_state (id, workspace_id, entity_id, field_name, state, value_text, provenance, revision, updated_at)
     VALUES ('es_alpha_co', ?, 'ent_alpha', 'company', 'clear', 'Alpha Transport Group', 'stated', 1, ?)`,
  )
    .bind(WS, now)
    .run();

  // Insert system job and test event
  await env.DB.prepare(
    `INSERT INTO system_jobs (id, workspace_id, job_kind, status, scheduled_at, attempt_count, max_attempts, created_at, updated_at)
     VALUES ('job_1', ?, 'reminder', 'pending', ?, 0, 3, ?, ?)`,
  )
    .bind(WS, now, now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO events (id, workspace_id, sequence, entity_id, actor_kind, actor_user_id, kind, schema_version, payload_json, occurred_at, recorded_at, channel, action_id, provenance, created_at, source_job_id)
     VALUES ('evt_note_1', ?, 1, 'ent_alpha', 'member', ?, 'note', 1, ?, ?, ?, 'system', 'act_1', 'stated', ?, 'job_1')`,
  )
    .bind(WS, USER, JSON.stringify({ text: 'Discussed summer contract pricing with Alpha' }), now, now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO interaction_state (workspace_id, root_event_id, entity_id, kind, head_event_id, revision, state, occurred_at, sequence, updated_at, head_value_json)
     VALUES (?, 'evt_note_1', 'ent_alpha', 'note', 'evt_note_1', 1, 'active', ?, 1, ?, ?)`,
  )
    .bind(WS, now, now, JSON.stringify({ text: 'Discussed summer contract pricing with Alpha' }))
    .run();
});

describe('Unified Search and Duplicate Detection', () => {
  it('searches across entities and notes without SQLite errors', async () => {
    const res = await unifiedWorkspaceSearch(env.DB, WS, USER, 'pricing', 5);
    expect(res.query).toBe('pricing');
    expect(res.categories.notes.length).toBeGreaterThan(0);
    expect(res.categories.notes[0]?.title).toContain('pricing');
  });

  it('detects duplicate candidate entities via HTTP API', async () => {
    const res = await SELF.fetch(`http://localhost/api/workspaces/${WS}/duplicates`, {
      method: 'GET',
      headers: {
        ...CSRF,
        Cookie: authCookie,
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: Array<{ entity_a: { name: string }; entity_b: { name: string }; similarity: number }> };
    expect(body.candidates).toBeDefined();
    expect(body.candidates.length).toBeGreaterThan(0);
    const pair = body.candidates[0]!;
    expect(pair.entity_a.name).toContain('Alpha');
    expect(pair.entity_b.name).toContain('Alpha');
  });

  it('executes agent query tool with search resource', async () => {
    const result = await executeAgentTool({
      db: env.DB,
      workspaceId: WS,
      actorUserId: USER,
      actionId: 'act_query_search',
      toolName: 'query',
      toolArgs: {
        resource: 'search',
        text: 'Alpha',
      },
    });

    expect(result.status).toBe('applied');
    const data = result.data as { categories: { entities: Array<{ title: string }> } };
    expect(data.categories.entities.length).toBeGreaterThan(0);
  });

  it('executes agent query tool with duplicates resource', async () => {
    const result = await executeAgentTool({
      db: env.DB,
      workspaceId: WS,
      actorUserId: USER,
      actionId: 'act_query_dups',
      toolName: 'query',
      toolArgs: {
        resource: 'duplicates',
      },
    });

    expect(result.status).toBe('applied');
    const data = result.data as { candidates: Array<{ entity_a: { name: string } }> };
    expect(data.candidates.length).toBeGreaterThan(0);
  });

  it('executes agent query tool with members resource', async () => {
    const result = await executeAgentTool({
      db: env.DB,
      workspaceId: WS,
      actorUserId: USER,
      actionId: 'act_query_members',
      toolName: 'query',
      toolArgs: {
        resource: 'members',
      },
    });

    expect(result.status).toBe('applied');
    const data = result.data as { members: Array<{ user_id: string; display_name: string }> };
    expect(data.members.length).toBeGreaterThan(0);
    expect(data.members[0]?.user_id).toBe(USER);
  });

  it('gracefully handles missing entity_id for entity_file and merge_preview without throwing', async () => {
    const fileResult = await executeAgentTool({
      db: env.DB,
      workspaceId: WS,
      actorUserId: USER,
      actionId: 'act_query_ef_missing',
      toolName: 'query',
      toolArgs: {
        resource: 'entity_file',
        // No entity_id supplied
      },
    });

    expect(fileResult.status).toBe('rejected');
    expect(fileResult.error?.code).toBe('invalid_argument');

    const mergeResult = await executeAgentTool({
      db: env.DB,
      workspaceId: WS,
      actorUserId: USER,
      actionId: 'act_query_mp_missing',
      toolName: 'query',
      toolArgs: {
        resource: 'merge_preview',
        // No entity_ids supplied
      },
    });

    expect(mergeResult.status).toBe('rejected');
    expect(mergeResult.error?.code).toBe('invalid_argument');
  });
});
