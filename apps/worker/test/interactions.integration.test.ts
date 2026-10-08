import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { ALL_MIGRATION_SQL, applyMigrationSql } from './migrations.js';
import {
  executeLedgerCommand,
  handleCreateEntity,
  handleDeleteEntity,
  handleLogEvent,
  handleRemoveInteraction,
  handleReviseInteraction,
  rebuildProjections,
  getWorkspaceEvents,
  getWorkspaceProjectionState,
  type LedgerCommandContext,
} from '@otis/ledger';
import { readLeadOverview } from '../src/agent/leadOverview.js';
import { readBriefCandidates } from '../src/brief/read.js';

/**
 * C1 single-interaction revision/removal on workerd D1. Migrations 0023
 * (lifecycle table plus revert-aware backfill) and 0024 (event kind
 * allowlist rebuild) land after legacy interaction events (including a
 * revert and a self-reference) exist, proving backfill plus preservation.
 * Revisions and removals commit through targeted hydration, replay
 * identically, survive guard loss and late batch failure without effects,
 * and keep live projections equal to deterministic rebuild.
 */

const WS = 'ws-interact-c1';
const OWNER = 'usr_interact_owner';
const TEAMMATE = 'usr_interact_tm';
const ATTEMPT = 'att_interact_seed';
const NOW = new Date().toISOString();
const LEASE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function makeContext(
  actionId: string,
  revision: number,
  overrides?: Partial<LedgerCommandContext>,
): LedgerCommandContext {
  return {
    workspace_id: WS,
    actor: { kind: 'member', user_id: OWNER },
    membership_revision: 1,
    source_message_id: 'msg_interact_owner',
    request_id: `req_${actionId}`,
    action_id: actionId,
    expected_business_revision: revision,
    fence: 1,
    run_id: 'run-interact-1',
    ...overrides,
  };
}

function countingDb(db: D1Database) {
  let prepares = 0;
  let batches = 0;
  const queries: string[] = [];
  const target = db as unknown as Record<string, unknown>;
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === 'prepare') {
        return (query: string) => {
          prepares += 1;
          queries.push(String(query).replace(/\s+/g, ' ').slice(0, 80));
          return (t['prepare'] as (q: string) => D1PreparedStatement).call(t, query);
        };
      }
      if (prop === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          batches += 1;
          return (t['batch'] as (s: D1PreparedStatement[]) => Promise<D1Result[]>).call(t, statements);
        };
      }
      const value = Reflect.get(t, prop, receiver);
      return typeof value === 'function' ? (value as (...a: never[]) => unknown).bind(t) : value;
    },
  });
  return { db: proxy as unknown as D1Database, counts: () => ({ prepares, batches }), queries };
}

async function revision(): Promise<number> {
  const row = await env.DB.prepare(`SELECT business_revision FROM workspaces WHERE id = ?`)
    .bind(WS).first<{ business_revision: number }>();
  return Number(row?.business_revision ?? -1);
}

async function eventCount(): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE workspace_id = ?`)
    .bind(WS).first<{ n: number }>();
  return Number(row?.n ?? -1);
}

async function receiptCount(actionId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM action_receipts WHERE workspace_id = ? AND action_id = ?`,
  ).bind(WS, actionId).first<{ n: number }>();
  return Number(row?.n ?? -1);
}

async function interactionRow(rootId: string) {
  return env.DB.prepare(
    `SELECT root_event_id, entity_id, kind, head_event_id, revision, state, occurred_at, sequence
     FROM interaction_state WHERE workspace_id = ? AND root_event_id = ?`,
  ).bind(WS, rootId).first<{
    root_event_id: string; entity_id: string | null; kind: string;
    head_event_id: string; revision: number; state: string;
    occurred_at: string; sequence: number;
  }>();
}

async function liveEqualsRebuild(): Promise<boolean> {
  const events = await getWorkspaceEvents(env.DB, WS);
  const rebuilt = rebuildProjections(events);
  const live = await getWorkspaceProjectionState(env.DB, WS);
  const ser = (m: Map<string, unknown>) =>
    JSON.stringify([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  return (
    ser(rebuilt.interactions as Map<string, unknown>) === ser(live.interactions as Map<string, unknown>) &&
    ser(rebuilt.fields as Map<string, unknown>) === ser(live.fields as Map<string, unknown>) &&
    ser(rebuilt.entities as Map<string, unknown>) === ser(live.entities as Map<string, unknown>)
  );
}

beforeAll(async () => {
  // Apply migrations 0001 through 0022, then seed legacy interaction
  // history (including a revert and a supersedes self-reference) before
  // 0023 lands, so the migration proof runs against pre-migration data.
  for (const sql of ALL_MIGRATION_SQL.slice(0, 22)) await applyMigrationSql(env.DB, sql);

  await env.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
  ).bind(
    OWNER, 'fb_interact_owner', 'owner@interact.test', 'Interact Owner', NOW, NOW,
    TEAMMATE, 'fb_interact_tm', 'tm@interact.test', 'Interact Tm', NOW, NOW,
  ).run();
  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, last_acceptance_sequence, last_event_sequence, lease_fence, lease_owner, lease_attempt_id, lease_expires_at, created_at, updated_at)
     VALUES (?, 'Interact C1', ?, 0, 1, 0, 2, 1, ?, ?, ?, ?, ?)`,
  ).bind(WS, OWNER, ATTEMPT, ATTEMPT, LEASE, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?), (?, ?, 'member', ?, ?, ?)`,
  ).bind(WS, OWNER, NOW, NOW, NOW, WS, TEAMMATE, NOW, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
     VALUES ('msg_interact_owner', ?, ?, 'web', 'ext_owner', 'fp_owner', 'processed', ?, ?),
            ('msg_interact_tm', ?, ?, 'web', 'ext_tm', 'fp_tm', 'processed', ?, ?)`,
  ).bind(WS, OWNER, NOW, NOW, WS, TEAMMATE, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO chats (id, workspace_id, author_user_id, title, activity_cursor, created_at, updated_at, last_activity_at)
     VALUES ('chat-interact-1', ?, ?, 'Interact', 0, ?, ?, ?),
            ('chat-interact-tm', ?, ?, 'Interact Tm', 0, ?, ?, ?)`,
  ).bind(WS, OWNER, NOW, NOW, NOW, WS, TEAMMATE, NOW, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, executor_kind, status, attempt_id, lease_fence, created_at, updated_at)
     VALUES ('run-interact-1', ?, 'chat-interact-1', 'msg_interact_owner', 'agent', 'running', ?, 1, ?, ?),
            ('run-interact-tm', ?, 'chat-interact-tm', 'msg_interact_tm', 'agent', 'running', ?, 1, ?, ?)`,
  ).bind(WS, ATTEMPT, NOW, NOW, WS, ATTEMPT, NOW, NOW).run();

  // Legacy history: a live note plus a note corrected through a manual
  // supersedes link and then reverted, exercising self-reference restore.
  const cols = `(id, workspace_id, sequence, entity_id, actor_kind, actor_user_id, kind, schema_version, payload_json, occurred_at, recorded_at, channel, source_message_id, action_id, supersedes_event_id, reverts_event_id, provenance, created_at)`;
  await env.DB.prepare(
    `INSERT INTO events ${cols} VALUES
     ('evt_legacy_note', ?, 1, NULL, 'member', ?, 'note', 1, '{"text":"Legacy note"}', ?, ?, 'web', 'msg_interact_owner', 'act_legacy_1', NULL, NULL, 'stated', ?),
     ('evt_legacy_fix', ?, 2, NULL, 'member', ?, 'note', 1, '{"text":"Legacy correction"}', ?, ?, 'web', 'msg_interact_owner', 'act_legacy_2', 'evt_legacy_note', NULL, 'stated', ?)`,
  ).bind(
    WS, OWNER, '2026-09-01T10:00:00.000Z', NOW, NOW,
    WS, OWNER, '2026-09-02T10:00:00.000Z', NOW, NOW,
  ).run();
  await env.DB.prepare(
    `INSERT INTO events ${cols} VALUES
     ('evt_legacy_revert', ?, 3, NULL, 'member', ?, 'revert', 1, '{"target_event_id":"evt_legacy_fix","target_action_id":"act_legacy_2","target_event_kind":"note","mode":"single","group_operation_id":"grp_legacy"}', ?, ?, 'web', 'msg_interact_owner', 'act_legacy_3', NULL, 'evt_legacy_fix', 'stated', ?)`,
  ).bind(WS, OWNER, '2026-09-03T10:00:00.000Z', NOW, NOW).run();

  await applyMigrationSql(env.DB, ALL_MIGRATION_SQL[22]!);
  await env.DB.prepare(`UPDATE workspaces SET last_event_sequence = 3 WHERE id = ?`).bind(WS).run();
});

describe('C1 migration 0023', () => {
  it('backfills live legacy roots and skips reverted corrections', async () => {
    // The live legacy note backfills as its own active root; the reverted
    // correction gets no row, matching rebuild exclusion.
    const live = await interactionRow('evt_legacy_note');
    expect(live).toMatchObject({ kind: 'note', head_event_id: 'evt_legacy_note', revision: 1, state: 'active' });
    expect(await interactionRow('evt_legacy_fix')).toBeNull();

    // Deterministic rebuild of the same history agrees with the table.
    expect(await liveEqualsRebuild()).toBe(true);
  });
});

describe('C1 migration 0024', () => {
  it('widens the event kind allowlist while preserving rows and self-references', async () => {
    await applyMigrationSql(env.DB, ALL_MIGRATION_SQL[23]!);

    const kinds = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'`,
    ).first<{ sql: string }>();
    expect(kinds?.sql).toContain("'interaction_removed'");

    const rows = await env.DB.prepare(
      `SELECT id, supersedes_event_id, reverts_event_id FROM events WHERE workspace_id = ? ORDER BY sequence ASC`,
    ).bind(WS).all<{ id: string; supersedes_event_id: string | null; reverts_event_id: string | null }>();
    expect(rows.results?.map((r) => r.id)).toEqual(['evt_legacy_note', 'evt_legacy_fix', 'evt_legacy_revert']);
    expect(rows.results?.[1]?.supersedes_event_id).toBe('evt_legacy_note');
    expect(rows.results?.[2]?.reverts_event_id).toBe('evt_legacy_fix');

    // Backfilled lifecycle rows survive the rebuild untouched.
    expect(await interactionRow('evt_legacy_note')).toMatchObject({ state: 'active', revision: 1 });
    expect(await interactionRow('evt_legacy_fix')).toBeNull();
    expect(await liveEqualsRebuild()).toBe(true);
  });
});

describe('C1 revise and remove on D1', () => {
  it('commits revise, revise and remove with receipts and live equal to rebuild', async () => {
    const rev0 = await revision();
    const create = await executeLedgerCommand(
      env.DB, makeContext('act_c1_create', rev0), 'create_entity',
      { name: 'Romanian Client' }, handleCreateEntity,
    );
    expect(create.status).toBe('applied');
    const entityRow = await env.DB.prepare(`SELECT id FROM entities WHERE workspace_id = ? AND name = ?`)
      .bind(WS, 'Romanian Client').first<{ id: string }>();
    const entityId = entityRow!.id;

    const logged = await executeLedgerCommand(
      env.DB, makeContext('act_c1_log', rev0 + 1), 'log_event',
      { entity_id: entityId, kind: 'quote', payload: { amount: 45000, currency: 'EUR', role: 'offered' } },
      handleLogEvent,
    );
    expect(logged.status).toBe('applied');
    const root = (logged.data as { event_id: string }).event_id;
    expect((await interactionRow(root))?.state).toBe('active');

    const rev1 = await executeLedgerCommand(
      env.DB, makeContext('act_c1_rev1', rev0 + 2), 'revise_interaction',
      {
        interaction_id: root, expected_head_event_id: root, kind: 'quote',
        payload: { amount: 50000, currency: 'EUR', role: 'offered' },
        occurred_at: '2026-10-07T10:00:00.000Z',
      },
      handleReviseInteraction,
    );
    expect(rev1.status).toBe('applied');
    expect(rev1.summary).toContain('500 EUR (offered)');
    const head1 = (rev1.data as { head_event_id: string }).head_event_id;
    expect(await interactionRow(root)).toMatchObject({ head_event_id: head1, revision: 2, state: 'active' });

    const field = await env.DB.prepare(
      `SELECT value_text FROM entity_state WHERE workspace_id = ? AND entity_id = ? AND field_name = 'quote'`,
    ).bind(WS, entityId).first<{ value_text: string }>();
    expect(field?.value_text).toContain('500 EUR');

    const removed = await executeLedgerCommand(
      env.DB, makeContext('act_c1_rem', rev0 + 3), 'remove_interaction',
      { interaction_id: root, expected_head_event_id: head1, reason: 'duplicate entry' },
      handleRemoveInteraction,
    );
    expect(removed.status).toBe('applied');
    expect(await interactionRow(root)).toMatchObject({ state: 'removed', revision: 3 });

    // The removed quote no longer reads as current on durable storage.
    const fieldAfterRemove = await env.DB.prepare(
      `SELECT state, value_text, value_json, source_event_id FROM entity_state WHERE workspace_id = ? AND entity_id = ? AND field_name = 'quote'`,
    ).bind(WS, entityId).first<{ state: string; value_text: string | null; value_json: string | null; source_event_id: string | null }>();
    expect(fieldAfterRemove?.state).toBe('clear');
    expect(fieldAfterRemove?.value_text).toBeNull();
    expect(fieldAfterRemove?.value_json).toBeNull();
    expect(fieldAfterRemove?.source_event_id).toBeNull();

    const kinds = await env.DB.prepare(
      `SELECT kind FROM events WHERE workspace_id = ? AND sequence > 3 ORDER BY sequence ASC`,
    ).bind(WS).all<{ kind: string }>();
    expect(kinds.results?.map((r) => r.kind)).toEqual([
      'entity_created', 'quote', 'quote', 'interaction_removed',
    ]);
    expect(await liveEqualsRebuild()).toBe(true);
    expect(await revision()).toBe(rev0 + 4);
  });

  it('pins the targeted revise cost: 2 batches and a bounded prepare count', async () => {
    const create = await executeLedgerCommand(
      env.DB, makeContext('act_c1_cost_create', await revision()), 'create_entity',
      { name: 'Cost Probe' }, handleCreateEntity,
    );
    expect(create.status).toBe('applied');
    const entityRow = await env.DB.prepare(`SELECT id FROM entities WHERE workspace_id = ? AND name = ?`)
      .bind(WS, 'Cost Probe').first<{ id: string }>();
    const logged = await executeLedgerCommand(
      env.DB, makeContext('act_c1_cost_log', await revision()), 'log_event',
      { entity_id: entityRow!.id, kind: 'note', payload: { text: 'probe note' } },
      handleLogEvent,
    );
    expect(logged.status).toBe('applied');
    const root = (logged.data as { event_id: string }).event_id;

    const counted = countingDb(env.DB);
    const rev = await executeLedgerCommand(
      counted.db, makeContext('act_c1_cost_rev', await revision()), 'revise_interaction',
      { interaction_id: root, expected_head_event_id: root, kind: 'note', payload: { text: 'probe note fixed' } },
      handleReviseInteraction,
    );
    expect(rev.status).toBe('applied');
    // Targeted hydration (row, then entity, field and same-kind siblings in
    // one batch) plus one atomic commit batch: no full-workspace scan
    // regardless of workspace size.
    // 16 prepares: 4 command reads, 4 targeted-hydration reads, 8 commit
    // statements (guard, event, receipt, quota, workspace, interaction row,
    // chat cursor, run activity).
    expect(counted.counts().batches).toBe(2);
    expect(counted.counts().prepares).toBe(16);
  });

  it('replays exact retries without effects and rejects changed payloads', async () => {
    const revBefore = await revision();
    const eventsBefore = await eventCount();
    const logged = await executeLedgerCommand(
      env.DB, makeContext('act_c1_replay_log', revBefore), 'log_event',
      { entity_id: null, kind: 'note', payload: { text: 'replay note' } },
      handleLogEvent,
    );
    expect(logged.status).toBe('applied');
    const root = (logged.data as { event_id: string }).event_id;
    const revAfterLog = await revision();

    const args = {
      interaction_id: root, expected_head_event_id: root, kind: 'note' as const,
      payload: { text: 'replay note fixed' },
    };
    const first = await executeLedgerCommand(
      env.DB, makeContext('act_c1_replay_rev', revAfterLog), 'revise_interaction', args, handleReviseInteraction,
    );
    expect(first.status).toBe('applied');

    const replay = await executeLedgerCommand(
      env.DB, makeContext('act_c1_replay_rev', revAfterLog + 1), 'revise_interaction', args, handleReviseInteraction,
    );
    expect(replay.status).toBe('already_applied');
    expect(await revision()).toBe(revAfterLog + 1);
    expect(await eventCount()).toBe(eventsBefore + 2);

    const changed = await executeLedgerCommand(
      env.DB, makeContext('act_c1_replay_rev', revAfterLog + 1), 'revise_interaction',
      { ...args, payload: { text: 'different text' } }, handleReviseInteraction,
    );
    expect(changed.status).toBe('conflict');
    expect(changed.error?.code).toBe('action_conflict');
    expect(await eventCount()).toBe(eventsBefore + 2);
  });

  it('rejects a simultaneous second edit against the advanced head', async () => {
    const logged = await executeLedgerCommand(
      env.DB, makeContext('act_c1_race_log', await revision()), 'log_event',
      { entity_id: null, kind: 'note', payload: { text: 'race note' } },
      handleLogEvent,
    );
    const root = (logged.data as { event_id: string }).event_id;
    const revAfterLog = await revision();
    const eventsBefore = await eventCount();

    const teammateCtx = makeContext('act_c1_race_tm', revAfterLog, {
      actor: { kind: 'member', user_id: TEAMMATE },
      source_message_id: 'msg_interact_tm',
      run_id: 'run-interact-tm',
    });
    const winner = await executeLedgerCommand(
      env.DB, teammateCtx, 'revise_interaction',
      { interaction_id: root, expected_head_event_id: root, kind: 'note', payload: { text: 'teammate correction' } },
      handleReviseInteraction,
    );
    expect(winner.status).toBe('applied');

    const loser = await executeLedgerCommand(
      env.DB, makeContext('act_c1_race_owner', revAfterLog + 1), 'revise_interaction',
      { interaction_id: root, expected_head_event_id: root, kind: 'note', payload: { text: 'owner correction' } },
      handleReviseInteraction,
    );
    expect(loser.status).toBe('conflict');
    expect(loser.error?.code).toBe('head_conflict');
    expect(await receiptCount('act_c1_race_owner')).toBe(0);
    expect(await eventCount()).toBe(eventsBefore + 1);
    expect(await liveEqualsRebuild()).toBe(true);
  });

  it('loses guard preconditions without committing effects', async () => {
    const logged = await executeLedgerCommand(
      env.DB, makeContext('act_c1_guard_log', await revision()), 'log_event',
      { entity_id: null, kind: 'note', payload: { text: 'guard note' } },
      handleLogEvent,
    );
    const root = (logged.data as { event_id: string }).event_id;
    const revAfterLog = await revision();
    const eventsBefore = await eventCount();

    const staleFence = await executeLedgerCommand(
      env.DB, makeContext('act_c1_guard_fence', revAfterLog, { fence: 99 }), 'revise_interaction',
      { interaction_id: root, expected_head_event_id: root, kind: 'note', payload: { text: 'fenced out' } },
      handleReviseInteraction,
    );
    expect(staleFence.status).toBe('conflict');
    expect(await receiptCount('act_c1_guard_fence')).toBe(0);

    await env.DB.prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .bind(WS, TEAMMATE).run();
    const nonMember = await executeLedgerCommand(
      env.DB, makeContext('act_c1_guard_member', revAfterLog, {
        actor: { kind: 'member', user_id: TEAMMATE },
        source_message_id: 'msg_interact_tm',
        run_id: 'run-interact-tm',
      }), 'revise_interaction',
      { interaction_id: root, expected_head_event_id: root, kind: 'note', payload: { text: 'no longer member' } },
      handleReviseInteraction,
    );
    expect(nonMember.status).toBe('rejected');
    expect(nonMember.error?.code).toBe('forbidden');
    expect(await receiptCount('act_c1_guard_member')).toBe(0);
    expect(await eventCount()).toBe(eventsBefore);
    expect(await revision()).toBe(revAfterLog);
  });

  it('rolls back event, state, receipt and revision when a later statement fails', async () => {
    const logged = await executeLedgerCommand(
      env.DB, makeContext('act_c1_doom_log', await revision()), 'log_event',
      { entity_id: null, kind: 'note', payload: { text: 'doomed note' } },
      handleLogEvent,
    );
    const root = (logged.data as { event_id: string }).event_id;
    const revAfterLog = await revision();
    const eventsBefore = await eventCount();

    const doomed = await executeLedgerCommand(
      env.DB, makeContext('act_c1_doom_rev', revAfterLog), 'revise_interaction',
      { interaction_id: root, expected_head_event_id: root, kind: 'note', payload: { text: 'doomed fix' } },
      handleReviseInteraction,
      [env.DB.prepare(`INSERT INTO ledger_guards (id, guard_ok) VALUES (?, 0)`).bind(`guard_c1_doom_${Date.now()}`)],
    );
    expect(doomed.status).toBe('conflict');
    expect(doomed.error?.code).toBe('guard_conflict');
    expect(await receiptCount('act_c1_doom_rev')).toBe(0);
    expect(await eventCount()).toBe(eventsBefore);
    expect(await revision()).toBe(revAfterLog);
    expect(await interactionRow(root)).toMatchObject({ head_event_id: root, revision: 1 });
    expect(await liveEqualsRebuild()).toBe(true);
  });

  it('drops lifecycle rows with entity deletion and rejects later interaction writes', async () => {
    const create = await executeLedgerCommand(
      env.DB, makeContext('act_c1_del_create', await revision()), 'create_entity',
      { name: 'Doomed Lead' }, handleCreateEntity,
    );
    expect(create.status).toBe('applied');
    const entityRow = await env.DB.prepare(`SELECT id FROM entities WHERE workspace_id = ? AND name = ?`)
      .bind(WS, 'Doomed Lead').first<{ id: string }>();
    const logged = await executeLedgerCommand(
      env.DB, makeContext('act_c1_del_log', await revision()), 'log_event',
      { entity_id: entityRow!.id, kind: 'visit', payload: { summary: 'Only visit', contact_made: true } },
      handleLogEvent,
    );
    const root = (logged.data as { event_id: string }).event_id;
    expect(await interactionRow(root)).not.toBeNull();

    const deleted = await executeLedgerCommand(
      env.DB, makeContext('act_c1_del_entity', await revision()), 'delete_entity',
      { entity_id: entityRow!.id, confirm: 'yes' }, handleDeleteEntity,
    );
    expect(deleted.status).toBe('applied');
    expect(await interactionRow(root)).toBeNull();

    const revise = await executeLedgerCommand(
      env.DB, makeContext('act_c1_del_rev', await revision()), 'revise_interaction',
      { interaction_id: root, expected_head_event_id: root, kind: 'visit', payload: { summary: 'Late', contact_made: true } },
      handleReviseInteraction,
    );
    expect(revise.status).toBe('rejected');
    expect(await liveEqualsRebuild()).toBe(true);

    // Re-running the backfill after the deletion must not resurrect the
    // removed client's lifecycle: replay drops it on entity_deleted, and
    // the table must agree.
    await applyMigrationSql(env.DB, ALL_MIGRATION_SQL[22]!);
    expect(await interactionRow(root)).toBeNull();
    expect(await liveEqualsRebuild()).toBe(true);
  });

  it('drops a removed contact from overview and brief last-contact reads', async () => {
    const OLD_CONTACT = '2026-09-01T10:00:00.000Z';
    const RECENT_CONTACT = '2026-09-20T10:00:00.000Z';
    const create = await executeLedgerCommand(
      env.DB, makeContext('act_c1_lc_create', await revision()), 'create_entity',
      { name: 'Contact Probe', kind: 'lead', initial_status: 'warm' }, handleCreateEntity,
    );
    expect(create.status).toBe('applied');
    const entityRow = await env.DB.prepare(`SELECT id FROM entities WHERE workspace_id = ? AND name = ?`)
      .bind(WS, 'Contact Probe').first<{ id: string }>();
    const entityId = entityRow!.id;
    const older = await executeLedgerCommand(
      env.DB, makeContext('act_c1_lc_old', await revision()), 'log_event',
      { entity_id: entityId, kind: 'contact', payload: { summary: 'Older contact', channel: 'phone' }, occurred_at: OLD_CONTACT },
      handleLogEvent,
    );
    expect(older.status).toBe('applied');
    const recent = await executeLedgerCommand(
      env.DB, makeContext('act_c1_lc_recent', await revision()), 'log_event',
      { entity_id: entityId, kind: 'contact', payload: { summary: 'Recent contact', channel: 'phone' }, occurred_at: RECENT_CONTACT },
      handleLogEvent,
    );
    expect(recent.status).toBe('applied');
    const recentRoot = (recent.data as { event_id: string }).event_id;

    const removed = await executeLedgerCommand(
      env.DB, makeContext('act_c1_lc_rem', await revision()), 'remove_interaction',
      { interaction_id: recentRoot, expected_head_event_id: recentRoot },
      handleRemoveInteraction,
    );
    expect(removed.status).toBe('applied');

    // The removed recent contact no longer counts; the older active one does.
    const overview = await readLeadOverview(env.DB, { workspaceId: WS, actorUserId: OWNER });
    expect(overview.rows.find((row) => row.lead_id === entityId)?.last_contact_at).toBe(OLD_CONTACT);
    const brief = await readBriefCandidates(env.DB, WS, OWNER);
    expect(brief.leads.find((row) => row.entityId === entityId)?.lastContactAt).toBe(OLD_CONTACT);
    expect(await liveEqualsRebuild()).toBe(true);
  });
});
