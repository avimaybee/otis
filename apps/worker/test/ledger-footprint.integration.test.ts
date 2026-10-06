/**
 * 015A.1 changed-only ledger projection persistence.
 *
 * `executeLedgerCommand` loads whole projection state, then must persist
 * only newly created, actually changed, or deleted projections — never
 * blindly upsert every row. Every test counts executed SQL (statements by
 * verb plus D1 rows_read/rows_written from run/all/batch meta; `.first()`
 * returns no meta) over real workerd D1. Setup fixtures run on the raw
 * binding; only the measured operation runs counted.
 *
 * Decisive properties: unrelated projection IDs are never targeted;
 * footprint is independent of unrelated counts; in-place reducer mutation
 * is detected via immutable before-snapshots (never reference comparison);
 * new records keep FK order (entity before events/children); unchanged
 * aliases emit nothing; FTS follows committed status/content; failures
 * roll back everything; persisted state equals deterministic replay.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
// @ts-expect-error vite raw import
import migration0001Sql from '../../../migrations/0001_identity.sql?raw';
// @ts-expect-error vite raw import
import migration0002Sql from '../../../migrations/0002_conversations_sources.sql?raw';
// @ts-expect-error vite raw import
import migration0003Sql from '../../../migrations/0003_ledger.sql?raw';
// @ts-expect-error vite raw import
import migration0004Sql from '../../../migrations/0004_lifecycle_settings.sql?raw';
// @ts-expect-error vite raw import
import migration0005Sql from '../../../migrations/0005_actor_dispatch.sql?raw';
// @ts-expect-error vite raw import
import migration0006Sql from '../../../migrations/0006_actor_hardening.sql?raw';
// @ts-expect-error vite raw import
import migration0007Sql from '../../../migrations/0007_outbox_claim_owner.sql?raw';
// @ts-expect-error vite raw import
import migration0008Sql from '../../../migrations/0008_memory_and_agent_runs.sql?raw';
// @ts-expect-error vite raw import
import migration0009Sql from '../../../migrations/0009_thinking_controls.sql?raw';
import {
  executeLedgerCommand,
  getWorkspaceRevision,
  getWorkspaceProjectionState,
  getWorkspaceEvents,
  getWorkspaceActions,
  rebuildProjections,
  createLedgerEvent,
  handleCreateEntity,
  handleRenameEntity,
  handleSetField,
  handleLogEvent,
  handleCreateTask,
  handleRecordDraft,
  handleRememberContext,
  handleForgetMemory,
  handleUndoCommit,
} from '@otis/ledger';
import type { AnyCommandHandler, LedgerProjectionState } from '@otis/ledger';

const WS_SMALL = 'ws-fp-small';
const WS_LARGE = 'ws-fp-large';
const AVI = 'usr_fp_avi';
const HUNOR = 'usr_fp_hunor';
const SMALL_N = 6;
const LARGE_N = 40;

let smallIds: string[] = [];
let largeIds: string[] = [];
let teammateId = '';

type Verb = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER';

interface LoggedStatement {
  sql: string;
  verb: Verb;
  binds: string[];
  rowsRead: number;
  rowsWritten: number;
}

function verbOf(sql: string): Verb {
  const head = sql.trim().split(/[\s(]/, 1)[0]!.toUpperCase();
  if (head === 'SELECT' || head === 'INSERT' || head === 'UPDATE' || head === 'DELETE') return head;
  return 'OTHER';
}

function countDb(db: D1Database, options?: { poisonTail?: boolean }) {
  const statements: LoggedStatement[] = [];
  const totals = { statements: 0, rowsRead: 0, rowsWritten: 0, metaSeen: 0 };
  function record(sql: string, binds: unknown[], meta: { rows_read?: unknown; rows_written?: unknown } | null | undefined) {
    const rowsRead = typeof meta?.rows_read === 'number' ? meta.rows_read : 0;
    const rowsWritten = typeof meta?.rows_written === 'number' ? meta.rows_written : 0;
    if (meta && (typeof meta.rows_read === 'number' || typeof meta.rows_written === 'number')) totals.metaSeen += 1;
    statements.push({
      sql: sql.trim().slice(0, 140),
      verb: verbOf(sql),
      binds: binds.flatMap((b) => (typeof b === 'string' ? [b] : [])),
      rowsRead,
      rowsWritten,
    });
    totals.statements += 1;
    totals.rowsRead += rowsRead;
    totals.rowsWritten += rowsWritten;
  }
  const inners = new WeakMap<object, { sql: string; inner: D1PreparedStatement; binds: unknown[] }>();
  function wrap(inner: D1PreparedStatement, sql: string): D1PreparedStatement {
    const entry = { sql, inner, binds: [] as unknown[] };
    const proxy = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'bind') {
          return (...args: unknown[]) => {
            const next = wrap((target.bind as (...bound: unknown[]) => D1PreparedStatement)(...args), sql);
            inners.get(next)!.binds.push(...args);
            return next;
          };
        }
        if (prop === 'run' || prop === 'all' || prop === 'first' || prop === 'raw') {
          return async (...args: unknown[]) => {
            const result = (await (target[prop as 'run'] as (...callArgs: unknown[]) => Promise<D1Result<unknown>>)(
              ...args,
            )) as D1Result<unknown>;
            record(sql, entry.binds, result?.meta as { rows_read?: unknown; rows_written?: unknown } | undefined);
            return result;
          };
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function' ? (value as (...callArgs: unknown[]) => unknown).bind(target) : value;
      },
    }) as D1PreparedStatement;
    inners.set(proxy, entry);
    return proxy;
  }
  const counted = {
    prepare: (sql: string) => wrap(db.prepare(sql), sql),
    batch: async (statementsToRun: D1PreparedStatement[]) => {
      const pairs = statementsToRun.map((s) => ({
        sql: inners.get(s)?.sql ?? '<batch>',
        binds: inners.get(s)?.binds ?? [],
        inner: inners.get(s)?.inner ?? s,
      }));
      // Test-only late failure: with poisonTail, a deliberately invalid
      // statement is appended AFTER every production-generated statement of
      // the commit (write) batch, so the batch fails at its true end. Pure
      // read batches (projection loads) never take the poison: they precede
      // the commit and their failure could not prove write rollback. No
      // production hook or abstraction.
      const POISON_SQL = 'INSERT INTO entities (id) VALUES (NULL)';
      const hasWrite = pairs.some((p) => verbOf(p.sql) !== 'SELECT');
      if (options?.poisonTail && hasWrite) {
        pairs.push({ sql: POISON_SQL, binds: [], inner: db.prepare(POISON_SQL) });
      }
      try {
        const results = (await db.batch(pairs.map((p) => p.inner))) as D1Result<unknown>[];
        pairs.forEach((p, i) => {
          record(
            p.sql,
            p.binds,
            results[i]?.meta as { rows_read?: unknown; rows_written?: unknown } | undefined,
          );
        });
        return results;
      } catch (err) {
        // Failed batches return no result metadata: record the attempted
        // statements with unavailable meta and rethrow. Rollback itself is
        // proven by durable before/after invariants, never by an aggregate
        // zero presented as measured cost.
        pairs.forEach((p) => record(p.sql, p.binds, undefined));
        throw err;
      }
    },
  };
  return { db: counted as unknown as D1Database, statements, totals };
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inTrigger = false;
  for (const rawLine of sql.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('--') || line.length === 0) continue;
    current += rawLine + '\n';
    if (/\bBEGIN\b/i.test(line)) inTrigger = true;
    if (inTrigger) {
      if (/\bEND;\s*$/i.test(line)) {
        inTrigger = false;
        statements.push(current.trim());
        current = '';
      }
    } else if (line.endsWith(';')) {
      statements.push(current.trim());
      current = '';
    }
  }
  if (current.trim().length > 0) statements.push(current.trim());
  return statements;
}

const PROJECTION_TABLES =
  /\b(entities|entity_aliases|entity_state|tasks|draft_projections|memory_entries|memory_suppressions|memory_entries_fts|memory_refresh_jobs)\b/;

/** Projection-table WRITE statements only (INSERT/UPDATE/DELETE): SELECTs
 * against projection tables (verification reads) never count as writes. */
function projectionWrites(log: LoggedStatement[]): LoggedStatement[] {
  return log.filter((s) => s.verb !== 'SELECT' && PROJECTION_TABLES.test(s.sql));
}

function touchedIds(log: LoggedStatement[]): Set<string> {
  const ids = new Set<string>();
  for (const s of projectionWrites(log)) {
    for (const b of s.binds) ids.add(b);
  }
  return ids;
}

const SEED_WORDS = [
  'Acme', 'Beacon', 'Cobalt', 'Delta', 'Frost', 'Granite', 'Harbor',
  'Ivory', 'Juniper', 'Krypton', 'Lagoon', 'Meadow', 'Nimbus', 'Onyx', 'Prairie',
  'Quartz', 'Ridge', 'Summit', 'Tundra', 'Vortex', 'Willow', 'Xenon',
  'Yonder', 'Zephyr', 'Anchor', 'Birch', 'Cinder', 'Drift', 'Flint',
  'Grove', 'Hazel', 'Indigo', 'Jasper', 'Kelvin', 'Lark', 'Maple', 'Opal',
  'Pine', 'Quill', 'River', 'Stone', 'Thyme', 'Ursa', 'Vale',
  'Wren', 'Yew', 'Zinc', 'Alder', 'North', 'Elm',
];

async function seedWorkspace(prefix: string, workspaceId: string, count: number): Promise<string[]> {
  const jobId = workspaceId === WS_LARGE ? 'job_fp_large' : 'job_fp_sys';
  async function runCommand(commandName: string, handler: AnyCommandHandler, args: Record<string, unknown>) {
    const rev = await getWorkspaceRevision(env.DB, workspaceId);
    const res = await executeLedgerCommand(
      env.DB,
      {
        workspace_id: workspaceId,
        action_id: crypto.randomUUID(),
        actor: { kind: 'system', system_job: 'reminder' },
        membership_revision: 1,
        request_id: `req-fp-seed-${crypto.randomUUID()}`,
        expected_business_revision: rev?.business_revision ?? 0,
        source_job_id: jobId,
      },
      commandName,
      args,
      handler,
    );
    if (res.status !== 'applied') throw new Error(`seed ${commandName} failed: ${JSON.stringify(res)}`);
    return res;
  }
  const entityIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    // Distinct single words: create_entity rejects near-duplicates.
    const created = await runCommand('create_entity', handleCreateEntity, { name: `${SEED_WORDS[i]!}` });
    const entityId = (created.data as { entity_id: string } | undefined)?.entity_id;
    if (!entityId) throw new Error('seed entity id missing');
    entityIds.push(entityId);
    await runCommand('set_field', handleSetField, { entity_id: entityId, field_name: 'phone', value: `+100000${i}` });
  }
  await runCommand('create_task', handleCreateTask, { title: 'General errand task', explicit_no_deadline: true });
  await runCommand('record_draft', handleRecordDraft, { channel: 'other', content_text: 'General draft document' });
  await runCommand('remember_context', handleRememberContext, {
    scope: 'workspace',
    category: 'workflow_context',
    content: 'Alpha ledger annotation',
  });
  await runCommand('remember_context', handleRememberContext, {
    scope: 'workspace',
    category: 'workflow_context',
    content: 'Zebra workflow reminder',
  });
  return entityIds;
}

beforeAll(async () => {
  for (const sql of [
    migration0001Sql,
    migration0002Sql,
    migration0003Sql,
    migration0004Sql,
    migration0005Sql,
    migration0006Sql,
    migration0007Sql,
    migration0008Sql,
    migration0009Sql,
  ]) {
    for (const stmt of splitSqlStatements(sql)) {
      await env.DB.prepare(stmt).run();
    }
  }
  const now = new Date().toISOString();
  for (const [id, fb, email, name] of [
    [AVI, 'fb_fp_avi', 'avi@kerning.test', 'Avi'],
    [HUNOR, 'fb_fp_hunor', 'hunor@kerning.test', 'Hunor'],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, fb, email, name, now, now)
      .run();
  }
  for (const workspaceId of [WS_SMALL, WS_LARGE]) {
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
       VALUES (?, 'Kerning', ?, 0, 1, ?, ?)`,
    )
      .bind(workspaceId, AVI, now, now)
      .run();
    for (const [user, role] of [
      [AVI, 'owner'],
      [HUNOR, 'member'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(workspaceId, user, role, now, now, now)
        .run();
    }
  }
  // System jobs backing system-actor test events (guard requires a live
  // pending/running system job matching the actor's job kind, owned by the
  // workspace being written).
  for (const [jobId, workspaceId] of [
    ['job_fp_sys', WS_SMALL],
    ['job_fp_large', WS_LARGE],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO system_jobs (id, workspace_id, job_kind, status, scheduled_at, created_at, updated_at)
       VALUES (?, ?, 'reminder', 'pending', ?, ?, ?)`,
    )
      .bind(jobId, workspaceId, now, now, now)
      .run();
  }
  // Source message backing the teammate member-actor seed.
  await env.DB.prepare(
    `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
     VALUES ('msg_fp_seed', ?, ?, 'web', 'fp-seed-1', 'fp', 'queued', ?, ?)`,
  )
    .bind(WS_SMALL, HUNOR, now, now)
    .run();
  // Stranger user + message: member actor with a valid source whose guard
  // still fails on workspace membership.
  await env.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
     VALUES ('usr_fp_stranger', 'fb_fp_stranger', 'stranger@elsewhere.test', 'Stranger', ?, ?)`,
  )
    .bind(now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
     VALUES ('msg_fp_stranger', ?, 'usr_fp_stranger', 'web', 'fp-stranger-1', 'fp', 'queued', ?, ?)`,
  )
    .bind(WS_SMALL, now, now)
    .run();
  smallIds = await seedWorkspace('fps', WS_SMALL, SMALL_N);
  largeIds = await seedWorkspace('fpl', WS_LARGE, LARGE_N);
  // One teammate-authored entity via the member actor (proves the member
  // path and gives unrelated teammate state for preservation tests).
  const rev = await getWorkspaceRevision(env.DB, WS_SMALL);
  const teammate = await executeLedgerCommand(
    env.DB,
    {
      workspace_id: WS_SMALL,
      action_id: crypto.randomUUID(),
      actor: { kind: 'member', user_id: HUNOR },
      membership_revision: 1,
      request_id: 'req-fp-teammate',
      expected_business_revision: rev?.business_revision ?? 0,
      source_message_id: 'msg_fp_seed',
    },
    'create_entity',
    { name: 'Hunor Solo Venture' },
    handleCreateEntity,
  );
  if (teammate.status !== 'applied') throw new Error('teammate seed failed');
  teammateId = (teammate.data as { entity_id: string } | undefined)?.entity_id ?? '';
}, 120_000);

async function fpContext(
  workspaceId: string,
  actionId = crypto.randomUUID(),
  actor: { kind: 'member'; user_id: string } | { kind: 'system'; system_job?: string } = {
    kind: 'system',
    system_job: 'reminder',
  },
  sourceJobId = workspaceId === WS_LARGE ? 'job_fp_large' : 'job_fp_sys',
) {
  const rev = await getWorkspaceRevision(env.DB, workspaceId);
  return {
    workspace_id: workspaceId,
    action_id: actionId,
    actor,
    membership_revision: 1,
    request_id: `req-fp-${crypto.randomUUID()}`,
    expected_business_revision: rev?.business_revision ?? 0,
    source_job_id: sourceJobId,
  };
}

function probeEvent(
  context: Parameters<AnyCommandHandler>[0],
  sequence: number,
  entityId: string | null,
  kind: 'note' | 'status_change',
  payload: Record<string, unknown>,
) {
  return createLedgerEvent(context, sequence, {
    entity_id: entityId,
    kind,
    payload,
    provenance: 'stated',
  });
}

describe('015A.1 changed-only projection persistence', () => {
  it('one-record rename amid many unrelated records touches only its own rows, independent of workspace size', async () => {
    const measured: Record<string, { statements: number; rowsRead: number; rowsWritten: number; metaSeen: number }> = {};
    for (const [workspaceId, ids, newName] of [
      [WS_SMALL, smallIds, 'Renamed Holdings Small'],
      [WS_LARGE, largeIds, 'Renamed Holdings Large'],
    ] as const) {
      const counter = countDb(env.DB);
      const targetId = ids[0]!;
      const beforeIds = new Set(ids);
      if (workspaceId === WS_SMALL) beforeIds.add(teammateId);
      const res = await executeLedgerCommand(
        counter.db,
        await fpContext(workspaceId),
        'rename_entity',
        { entity_id: targetId, new_name: newName },
        handleRenameEntity,
      );
      expect(res.status).toBe('applied');
      // In-place reducer mutation correctness: the rename must reach D1 even
      // though the reducer mutated the shared object (no snapshot, no write).
      // Verification reads run on the raw binding, never the counter, so the
      // operation measurement above stays exact.
      const renamed = await env.DB
        .prepare('SELECT name FROM entities WHERE id = ?')
        .bind(targetId)
        .first<{ name: string }>();
      expect(renamed?.name).toBe(newName);
      // Projection writes: exactly the entity upsert + the new-name alias
      // insert. Everything else (events, receipt, quota, revision) preserved.
      const proj = projectionWrites(counter.statements);
      expect(proj).toHaveLength(2);
      expect(proj[0]!.sql).toMatch(/INSERT INTO entities \(/);
      expect(proj[0]!.binds).toContain(targetId);
      expect(proj[1]!.sql).toMatch(/INSERT OR IGNORE INTO entity_aliases/);
      // No unrelated projection ID is targeted by any statement.
      const touched = touchedIds(counter.statements);
      for (const id of beforeIds) {
        if (id !== targetId) expect(touched.has(id)).toBe(false);
      }
      // Full single-operation footprint is identical for 6 and 40 entities:
      // 9 pre-batch reads + 7 batch statements.
      expect(counter.totals.statements).toBe(16);
      measured[workspaceId] = { ...counter.totals };
    }
    // D1 metadata assertions (miniflare provides meta on run/all/batch;
    // .first() reads contribute statements but no measured rows, and stay
    // out of the row totals by construction, never silently counted).
    expect(measured[WS_SMALL]!.metaSeen).toBeGreaterThan(0);
    expect(measured[WS_LARGE]!.metaSeen).toBeGreaterThan(0);
    // Same 7-statement batch on both sizes: identical rows written, while
    // rows read scale with unrelated records (state load is the remaining
    // read cost, explicitly sequenced after this write bound).
    expect(measured[WS_SMALL]).toMatchObject({ statements: 16, rowsRead: 34, rowsWritten: 21 });
    expect(measured[WS_LARGE]!.statements).toBe(16);
    expect(measured[WS_LARGE]!.rowsWritten).toBe(21);
    // Reads scale with unrelated records (state load); writes do not.
    // LARGE observed at 139 rows in this env; assert relationally so the
    // regression tracks scaling, not one engine's accounting.
    expect(measured[WS_LARGE]!.rowsRead).toBeGreaterThan(measured[WS_SMALL]!.rowsRead);
  });

  it('identical values emit zero projection writes while the command still commits', async () => {
    const counter = countDb(env.DB);
    const targetId = smallIds[1]!;
    const revBefore = await getWorkspaceRevision(env.DB, WS_SMALL);
    // A logged note touches no projection: the handler returns cloned maps
    // with identical values plus one event. Replay-consistent: reducers
    // ignore 'note', so rebuild agrees exactly.
    const res = await executeLedgerCommand(
      counter.db,
      await fpContext(WS_SMALL),
      'log_event',
      { entity_id: targetId, kind: 'note', payload: { text: 'footprint probe note' } },
      handleLogEvent,
    );
    expect(res.status).toBe('applied');
    expect(projectionWrites(counter.statements)).toHaveLength(0);
    // The command itself still committed: revision advanced and receipt kept.
    const revAfter = await getWorkspaceRevision(env.DB, WS_SMALL);
    expect(revAfter?.business_revision).toBe((revBefore?.business_revision ?? 0) + 1);
    expect(touchedIds(counter.statements).has(targetId)).toBe(false);
  });

  it('detects reducer in-place mutation of shared objects', async () => {
    const counter = countDb(env.DB);
    const before = await getWorkspaceProjectionState(env.DB, WS_SMALL);
    const targetId = smallIds[2]!;
    const ctx = await fpContext(WS_SMALL, crypto.randomUUID(), { kind: 'system', system_job: 'reminder' }, 'job_fp_sys');
    const handler: AnyCommandHandler = (context, state, nextSequence) => {
      // Sloppy reducer: mutates the shared object in place and returns the
      // same state object. A post-handler reference/value diff against the
      // (now mutated) currentState would see nothing and lose the update.
      // The appended event is a replayable status_change for the same change
      // (timestamps taken from the event itself), so deterministic replay
      // still agrees exactly.
      const event = probeEvent(context, nextSequence, targetId, 'status_change', { new_status: 'won' });
      const entity = state.entities.get(targetId)!;
      entity.status = 'won';
      entity.updated_at = event.recorded_at;
      return {
        result: { status: 'applied', action_id: context.action_id, summary: 'mutate' },
        events: [event],
        nextState: state,
      };
    };
    const res = await executeLedgerCommand(counter.db, ctx, 'mutate_probe', {}, handler);
    expect(res.status).toBe('applied');
    const entityWrites = counter.statements.filter((s) => /INSERT INTO entities \(/.test(s.sql));
    expect(entityWrites).toHaveLength(1);
    expect(entityWrites[0]!.binds).toContain(targetId);
    const persisted = await env.DB.prepare('SELECT status FROM entities WHERE id = ?').bind(targetId).first<{ status: string }>();
    expect(persisted?.status).toBe('won');
    const beforeIds = new Set(before.entities.keys());
    const touched = touchedIds(counter.statements);
    for (const id of beforeIds) {
      if (id !== targetId) expect(touched.has(id)).toBe(false);
    }
  });

  it('new records keep FK order: entity precedes events and child inserts', async () => {
    const counter = countDb(env.DB);
    const res = await executeLedgerCommand(
      counter.db,
      await fpContext(WS_SMALL),
      'create_entity',
      { name: 'Brand New Venture' },
      handleCreateEntity,
    );
    expect(res.status).toBe('applied');
    const idxEntity = counter.statements.findIndex((s) => /INSERT INTO entities \(/.test(s.sql));
    const idxEvents = counter.statements.findIndex((s) => /INSERT INTO events \(/.test(s.sql));
    const idxAlias = counter.statements.findIndex((s) => /INSERT OR IGNORE INTO entity_aliases/.test(s.sql));
    expect(idxEntity).toBeGreaterThanOrEqual(0);
    expect(idxEvents).toBeGreaterThanOrEqual(0);
    expect(idxEntity).toBeLessThan(idxEvents);
    expect(idxAlias).toBeGreaterThanOrEqual(0);
  });

  it('real undo deletions remove only reverted records and preserve teammate state', async () => {
    // Create then undo through the actual undo path (dependency detection +
    // deterministic rebuild), so revert events stay replay-consistent.
    const createCtx = await fpContext(WS_SMALL);
    const createActionId = createCtx.action_id;
    const created = await executeLedgerCommand(
      env.DB,
      createCtx,
      'create_entity',
      { name: 'Doomed Short Venture' },
      handleCreateEntity,
    );
    expect(created.status).toBe('applied');
    const doomedId = (created.data as { entity_id: string } | undefined)?.entity_id ?? '';
    expect(doomedId).not.toBe('');
    const counter = countDb(env.DB);
    const allEvents = await getWorkspaceEvents(env.DB, WS_SMALL);
    const allActions = await getWorkspaceActions(env.DB, WS_SMALL);
    const undoRev = await getWorkspaceRevision(env.DB, WS_SMALL);
    const adapter: AnyCommandHandler = (context, state, nextSequence) =>
      handleUndoCommit(context, allEvents, allActions, state, nextSequence, {
        action_id: createActionId,
        mode: 'single',
        client_operation_id: crypto.randomUUID(),
        expected_revision: undoRev?.business_revision ?? 0,
      });
    const res = await executeLedgerCommand(counter.db, await fpContext(WS_SMALL), 'undo_commit', {}, adapter);
    expect(res.status).toBe('applied');
    const deletes = counter.statements.filter((s) => s.verb === 'DELETE');
    expect(deletes.length).toBeGreaterThan(0);
    for (const del of deletes) {
      expect(del.binds.some((b) => b === doomedId)).toBe(true);
    }
    // Teammate state preserved: record intact with identical values.
    const after = await getWorkspaceProjectionState(env.DB, WS_SMALL);
    expect(after.entities.get(teammateId)?.name).toBe('Hunor Solo Venture');
    expect(after.entities.has(doomedId)).toBe(false);
    const touched = touchedIds(counter.statements);
    expect(touched.has(teammateId)).toBe(false);
  });

  it('memory update/forget keeps FTS coherent without touching other entries', async () => {
    const counter = countDb(env.DB);
    const before = await getWorkspaceProjectionState(env.DB, WS_SMALL);
    const entries = [...before.memoryEntries.values()].filter((m) =>
      ['Alpha ledger annotation', 'Zebra workflow reminder'].includes(m.content),
    );
    expect(entries.length).toBe(2);
    const [first, second] = entries as [typeof entries[number], typeof entries[number]];
    const ftsHas = async (id: string) =>
      env.DB.prepare('SELECT entry_id FROM memory_entries_fts WHERE entry_id = ?').bind(id).first();
    expect(await ftsHas(first!.id)).toBeTruthy();
    // Forget one entry: status flips, FTS row removed, entry row retained.
    const forgetRes = await executeLedgerCommand(
      counter.db,
      await fpContext(WS_SMALL),
      'forget_memory',
      { memory_id: first!.id, rationale: 'footprint probe' },
      handleForgetMemory,
    );
    expect(forgetRes.status).toBe('applied');
    expect(await ftsHas(first!.id)).toBeNull();
    expect(await ftsHas(second!.id)).toBeTruthy();
    const memTables = counter.statements.filter(
      (s) => s.verb !== 'SELECT' && /memory_entries|memory_suppressions|memory_refresh_jobs/.test(s.sql),
    );
    for (const s of memTables) {
      const mentionsSecond = s.binds.some((b) => b === second!.id);
      expect(mentionsSecond).toBe(false);
    }
    // Update the other EXISTING entry via supersede (not a different memory):
    // old flips to superseded with FTS removed, new row carries the content.
    const mark = counter.statements.length;
    const rememberRes = await executeLedgerCommand(
      counter.db,
      await fpContext(WS_SMALL),
      'remember_context',
      {
        scope: 'workspace',
        category: 'workflow_context',
        content: 'Quasar revised annotation',
        supersedes_memory_id: second!.id,
      },
      handleRememberContext,
    );
    expect(rememberRes.status).toBe('applied');
    const revisedId = (rememberRes.data as { memory_id: string } | undefined)?.memory_id;
    expect(revisedId).toBeDefined();
    const ftsRevised = await env.DB
      .prepare('SELECT content FROM memory_entries_fts WHERE entry_id = ?')
      .bind(revisedId!)
      .first<{ content: string }>();
    expect(ftsRevised?.content).toBe('Quasar revised annotation');
    expect(await ftsHas(second!.id)).toBeNull();
    const superseded = await env.DB
      .prepare('SELECT status FROM memory_entries WHERE id = ?')
      .bind(second!.id)
      .first<{ status: string }>();
    expect(superseded?.status).toBe('superseded');
    // The forgotten entry from the first half stays untouched by this update.
    for (const s of counter.statements.slice(mark)) {
      if (s.verb === 'SELECT') continue;
      expect(s.binds.some((b) => b === first!.id)).toBe(false);
    }
  });

  it('idempotent replay performs one receipt read and zero writes', async () => {
    const actionId = crypto.randomUUID();
    const ctx = await fpContext(WS_SMALL, actionId);
    const targetId = smallIds[4]!;
    const first = await executeLedgerCommand(
      env.DB,
      ctx,
      'rename_entity',
      { entity_id: targetId, new_name: 'Renamed Four' },
      handleRenameEntity,
    );
    expect(first.status).toBe('applied');
    const counter = countDb(env.DB);
    const second = await executeLedgerCommand(
      counter.db,
      await fpContext(WS_SMALL, actionId),
      'rename_entity',
      { entity_id: targetId, new_name: 'Renamed Four' },
      handleRenameEntity,
    );
    expect(second.status).toBe('already_applied');
    expect(counter.totals.statements).toBe(1);
    expect(counter.statements.filter((s) => s.verb !== 'SELECT')).toHaveLength(0);
  });

  it('revision, membership and fence failures change zero rows; late batch failure rolls back', async () => {
    // Stale revision conflicts before any statement runs.
    const stale = countDb(env.DB);
    const rev = await getWorkspaceRevision(env.DB, WS_SMALL);
    const staleRes = await executeLedgerCommand(
      stale.db,
      { ...(await fpContext(WS_SMALL)), expected_business_revision: (rev?.business_revision ?? 1) - 1 },
      'rename_entity',
      { entity_id: 'nope', new_name: 'x' },
      handleRenameEntity,
    );
    expect(staleRes.status).toBe('conflict');
    expect(stale.totals.statements).toBeGreaterThan(0);
    expect(stale.statements.filter((s) => s.verb !== 'SELECT')).toHaveLength(0);
    // Non-member actor fails the in-batch guard: nothing commits. A valid
    // entity is used so the handler emits events and the guard itself (not
    // handler validation) is what rejects inside the atomic batch.
    const guardFail = countDb(env.DB);
    const guardRevBefore = await getWorkspaceRevision(env.DB, WS_SMALL);
    const guardTargetId = smallIds[0]!;
    const guardTargetBefore = await env.DB.prepare('SELECT name FROM entities WHERE id = ?')
      .bind(guardTargetId)
      .first<{ name: string }>();
    const guardRes = await executeLedgerCommand(
      guardFail.db,
      {
        ...(await fpContext(WS_SMALL)),
        actor: { kind: 'member', user_id: 'usr_fp_stranger' },
        source_job_id: undefined,
        source_message_id: 'msg_fp_stranger',
      },
      'rename_entity',
      { entity_id: guardTargetId, new_name: 'Stranger Attempt' },
      handleRenameEntity,
    );
    expect(guardRes.status).not.toBe('applied');
    // Failed batches return no result metadata, so rollback is proven by
    // durable invariants (revision/receipt/name unchanged), never by an
    // aggregate zero presented as measured cost. (The wrapper logs attempted
    // statements even when the batch throws, so statement counts are not
    // asserted here — only that nothing committed.)
    const guardRevAfter = await getWorkspaceRevision(env.DB, WS_SMALL);
    expect(guardRevAfter?.business_revision).toBe(guardRevBefore?.business_revision);
    const guardNameAfter = await env.DB.prepare('SELECT name FROM entities WHERE id = ?')
      .bind(guardTargetId)
      .first<{ name: string }>();
    expect(guardNameAfter?.name).toBe(guardTargetBefore?.name);
    // Real stale-fence case: a running run pinned to an expired lease. The
    // handler emits events, then the in-batch fence guard rejects: zero
    // events, receipts, projections, or revision changes.
    const fenceDb = countDb(env.DB);
    const fenceTargetId = smallIds[4]!;
    const fenceTargetBefore = await env.DB.prepare('SELECT name FROM entities WHERE id = ?')
      .bind(fenceTargetId)
      .first<{ name: string }>();
    const fenceRevBefore = await getWorkspaceRevision(env.DB, WS_SMALL);
    await env.DB.prepare(
      `INSERT INTO agent_runs (id, workspace_id, source_job_id, status, attempt_id, created_at, updated_at)
       VALUES ('run_fp_fence', ?, 'job_fp_sys', 'running', 'att_fp_old', ?, ?)`,
    )
      .bind(WS_SMALL, new Date().toISOString(), new Date().toISOString())
      .run();
    await env.DB.prepare(
      `UPDATE workspaces SET lease_owner = ?, lease_attempt_id = ?, lease_fence = ?, lease_expires_at = ? WHERE id = ?`,
    )
      .bind(
        'att_fp_old',
        'att_fp_old',
        5,
        new Date(Date.now() - 60_000).toISOString(),
        WS_SMALL,
      )
      .run();
    const fenceCtx = await fpContext(WS_SMALL);
    const fenceRes = await executeLedgerCommand(
      fenceDb.db,
      {
        ...fenceCtx,
        run_id: 'run_fp_fence',
        fence: 5,
      },
      'rename_entity',
      { entity_id: fenceTargetId, new_name: 'Fenced Attempt Name' },
      handleRenameEntity,
    );
    expect(fenceRes.status).toBe('conflict');
    expect(fenceRes.error?.code).toBe('fence_conflict');
    const fenceRevAfter = await getWorkspaceRevision(env.DB, WS_SMALL);
    expect(fenceRevAfter?.business_revision).toBe(fenceRevBefore?.business_revision);
    const fenceReceipt = await env.DB.prepare('SELECT id FROM action_receipts WHERE action_id = ?')
      .bind(fenceCtx.action_id)
      .first();
    expect(fenceReceipt).toBeNull();
    const fenceNameAfter = await env.DB.prepare('SELECT name FROM entities WHERE id = ?')
      .bind(fenceTargetId)
      .first<{ name: string }>();
    expect(fenceNameAfter?.name).toBe(fenceTargetBefore?.name);
    // Release the expired test lease so later tests observe a clean slate.
    await env.DB.prepare(
      `UPDATE workspaces SET lease_owner = NULL, lease_attempt_id = NULL, lease_expires_at = NULL WHERE id = ?`,
    )
      .bind(WS_SMALL)
      .run();
    // Late batch failure, positioned by the test-only wrapper at the TRUE
    // end of the production-generated batch (no production hook): the batch
    // throws (only guard failures map to statuses) and D1 rolls back every
    // effect atomically. Rollback is proven by durable before/after
    // invariants — revision, receipt absence, and the untouched row — since
    // a thrown batch returns no result metadata to measure.
    const lateFail = countDb(env.DB, { poisonTail: true });
    const lateCtx = await fpContext(WS_SMALL);
    const beforeRev = await getWorkspaceRevision(env.DB, WS_SMALL);
    const lateId = smallIds[5]!;
    const lateBefore = await env.DB.prepare('SELECT name FROM entities WHERE id = ?')
      .bind(lateId)
      .first<{ name: string }>();
    await expect(
      executeLedgerCommand(
        lateFail.db,
        lateCtx,
        'rename_entity',
        { entity_id: lateId, new_name: 'Renamed Late' },
        handleRenameEntity,
      ),
    ).rejects.toThrow(/constraint/i);
    // The poison ran after every production statement (true end of batch):
    // everything logged after it is diagnostic reads from error handling.
    const logged = lateFail.statements.map((s) => s.sql);
    const poisonIdx = logged.findIndex((s) => /INSERT INTO entities \(id\) VALUES \(NULL\)/.test(s));
    expect(poisonIdx).toBeGreaterThan(-1);
    expect(lateFail.statements.slice(0, poisonIdx).filter((s) => s.verb !== 'SELECT').length).toBeGreaterThan(0);
    expect(lateFail.statements.slice(poisonIdx + 1).every((s) => s.verb === 'SELECT')).toBe(true);
    const afterRev = await getWorkspaceRevision(env.DB, WS_SMALL);
    expect(afterRev?.business_revision).toBe(beforeRev?.business_revision);
    const receipt = await env.DB.prepare('SELECT id FROM action_receipts WHERE action_id = ?')
      .bind(lateCtx.action_id)
      .first();
    expect(receipt).toBeNull();
    const rolledBack = await env.DB.prepare('SELECT name FROM entities WHERE id = ?')
      .bind(lateId)
      .first<{ name: string }>();
    expect(rolledBack?.name).toBe(lateBefore?.name);
  });

  it('persisted state equals deterministic replay of the event log', async () => {
    const events = await getWorkspaceEvents(env.DB, WS_SMALL);
    expect(events.length).toBeGreaterThan(0);
    const rebuilt = rebuildProjections(events);
    const live = await getWorkspaceProjectionState(env.DB, WS_SMALL);
    const normalize = (state: LedgerProjectionState) =>
      JSON.stringify(
        (['entities', 'aliases', 'fields', 'tasks', 'drafts', 'memoryEntries', 'memorySuppressions'] as const).map(
          (collection) => [...state[collection].entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
        ),
      );
    expect(normalize(rebuilt)).toBe(normalize(live));
  });
});



