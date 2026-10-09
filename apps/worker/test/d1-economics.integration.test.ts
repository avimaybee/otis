import { ALL_MIGRATION_SQL } from './migrations.js';
/**
 * D1 economics containment (production write-budget incident).
 *
 * Every test here counts executed SQL — statements by verb plus D1
 * rows_read/rows_written from result meta where the test env provides it —
 * rather than asserting method names. Read paths (GET scope, idle SSE
 * connect/ticks/reconnect across concurrent tabs, idle recovery sweeps)
 * must change zero rows. The SSE stream additionally rotates by a query
 * budget with a clean close, never a resync_required.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { AUTH_BOUNDS } from '@otis/contracts';
import { sha256 } from '@otis/identity';
import { createChat } from '../src/inbox/repository.js';
import { createActivityStream } from '../src/chat/stream.js';
import { handleGetMe } from '../src/routes/me.js';
import { handleGetWorkspace } from '../src/routes/workspaces.js';
import { handleGetActivity } from '../src/routes/activity.js';
import {
  dispatchWorkspace,
  listWorkspacesNeedingRecovery,
  recoverWorkspace,
} from '../src/actor/dispatch.js';
import { processMemoryRefreshJobs } from '../src/agent/memory.js';
import type { Env } from '../src/index.js';

const WS = 'ws-eco';
const WS_PARKED = 'ws-eco-parked';
const AVI = 'usr_eco_avi';
const TOKEN = 'eco_token_avi';

type Verb = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER';

function verbOf(sql: string): Verb {
  const head = sql.trim().split(/[\s(]/, 1)[0]!.toUpperCase();
  if (head === 'SELECT' || head === 'INSERT' || head === 'UPDATE' || head === 'DELETE') return head;
  return 'OTHER';
}

interface CountedTotals {
  statements: number;
  selectStatements: number;
  writeStatements: number;
  rowsRead: number;
  rowsWritten: number;
  metaSeen: number;
  metaMissing: number;
}

/**
 * Counts every statement executed through one D1 binding: verb per SQL
 * plus rows_read/rows_written from result meta. Setup fixtures run on the
 * raw binding; only the measured phase runs through a counter.
 */
function countDb(db: D1Database) {
  const verbs: Verb[] = [];
  const totals: CountedTotals = {
    statements: 0,
    selectStatements: 0,
    writeStatements: 0,
    rowsRead: 0,
    rowsWritten: 0,
    metaSeen: 0,
    metaMissing: 0,
  };
  function record(sql: string, meta: { rows_read?: unknown; rows_written?: unknown } | null | undefined) {
    const verb = verbOf(sql);
    const rowsRead = typeof meta?.rows_read === 'number' ? meta.rows_read : 0;
    const rowsWritten = typeof meta?.rows_written === 'number' ? meta.rows_written : 0;
    if (meta && (typeof meta.rows_read === 'number' || typeof meta.rows_written === 'number')) {
      totals.metaSeen += 1;
    } else {
      totals.metaMissing += 1;
    }
    verbs.push(verb);
    totals.statements += 1;
    if (verb === 'SELECT') totals.selectStatements += 1;
    else if (verb !== 'OTHER') totals.writeStatements += 1;
    totals.rowsRead += rowsRead;
    totals.rowsWritten += rowsWritten;
  }
  const inners = new WeakMap<object, { sql: string; inner: D1PreparedStatement }>();
  function wrapStatement(inner: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'bind') {
          return (...args: unknown[]) =>
            wrapStatement(
              (target.bind as (...bound: unknown[]) => D1PreparedStatement)(...args),
              sql,
            );
        }
        if (prop === 'run' || prop === 'all' || prop === 'first' || prop === 'raw') {
          return async (...args: unknown[]) => {
            const result = (await (target[prop as 'run'] as (...callArgs: unknown[]) => Promise<D1Result<unknown>>)(
              ...args,
            )) as D1Result<unknown>;
            record(sql, result?.meta as { rows_read?: unknown; rows_written?: unknown } | undefined);
            return result;
          };
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === 'function' ? (value as (...callArgs: unknown[]) => unknown).bind(target) : value;
      },
    }) as D1PreparedStatement;
    inners.set(proxy, { sql, inner });
    return proxy;
  }
  const counted = {
    prepare: (sql: string) => wrapStatement(db.prepare(sql), sql),
    batch: async (statements: D1PreparedStatement[]) => {
      const real = statements.map((statement) => inners.get(statement)?.inner ?? statement);
      const results = (await db.batch(real)) as D1Result<unknown>[];
      statements.forEach((statement, index) => {
        record(
          inners.get(statement)?.sql ?? '<batch>',
          results[index]?.meta as { rows_read?: unknown; rows_written?: unknown } | undefined,
        );
      });
      return results;
    },
  };
  return { db: counted as unknown as D1Database, verbs, totals };
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

async function readAll(response: Response, deadlineMs = 8000): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining));
    const chunk = await Promise.race([reader.read(), timeout]);
    if (chunk === null) break;
    if (chunk.done) break;
    out += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  return out;
}

let aviChat: string;
let aviCookie: string;

beforeAll(async () => {
  for (const sql of ALL_MIGRATION_SQL) {
    for (const stmt of splitSqlStatements(sql)) {
      await env.DB.prepare(stmt).run();
    }
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
     VALUES (?, 'fb_eco_avi', 'avi@kerning.test', 'Avi', ?, ?)`,
  )
    .bind(AVI, now, now)
    .run();
  for (const workspaceId of [WS, WS_PARKED]) {
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
       VALUES (?, 'Kerning', ?, 0, 1, ?, ?)`,
    )
      .bind(workspaceId, AVI, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'owner', ?, ?, ?)`,
    )
      .bind(workspaceId, AVI, now, now, now)
      .run();
  }
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
     VALUES ('sess_eco_avi', ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(await sha256(TOKEN), AVI, now, expiresAt, now)
    .run();
  aviCookie = `${AUTH_BOUNDS.COOKIE_NAME}=${TOKEN}`;
  aviChat = (await createChat(env.DB, { workspaceId: WS, authorUserId: AVI, title: 'Eco chat' })).id;
  // Queued workspace: a run queued with no lease and no pending
  // outbox rows. Recovery discovers it; the revisit must change zero rows.
  await env.DB.prepare(
    `INSERT INTO system_jobs (id, workspace_id, job_kind, status, scheduled_at, created_at, updated_at)
     VALUES ('job_eco_parked', ?, 'reminder', 'pending', ?, ?, ?)`,
  )
    .bind(WS_PARKED, now, now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO agent_runs (id, workspace_id, source_job_id, executor_kind, status, created_at, updated_at)
     VALUES ('run_eco_parked', ?, 'job_eco_parked', 'system', 'waiting_for_input', ?, ?)`,
  )
    .bind(WS_PARKED, now, now)
    .run();
});

function countedEnv() {
  const counter = countDb(env.DB);
  return { counter, env: { DB: counter.db } as unknown as Env };
}

describe('D1 zero-mutation read paths', () => {
  it('exposes rows_read/rows_written meta in this test env', async () => {
    const { counter } = countedEnv();
    await counter.db.prepare('SELECT 1').all();
    expect(counter.totals.metaSeen).toBeGreaterThan(0);
    expect(counter.totals.rowsWritten).toBe(0);
  });

  it('production GET scope routes change zero rows', async () => {
    const { counter, env: wenv } = countedEnv();
    const meRes = await handleGetMe(
      new Request('http://localhost/api/me', { headers: { Cookie: aviCookie } }),
      wenv,
      'req-eco-me',
    );
    expect(meRes.status).toBe(200);
    const wsRes = await handleGetWorkspace(
      new Request(`http://localhost/api/workspaces/${WS}`, { headers: { Cookie: aviCookie } }),
      wenv,
      WS,
      'req-eco-ws',
    );
    expect(wsRes.status).toBe(200);
    const activityRes = await handleGetActivity(
      new Request(`http://localhost/api/workspaces/${WS}/chats/${aviChat}/activity?after=0`, {
        headers: { Cookie: aviCookie },
      }),
      wenv,
      WS,
      aviChat,
      'req-eco-activity',
    );
    expect(activityRes.status).toBe(200);
    // Auth + membership + content/page reads, zero writes:
    // me (session + workspaces) + workspace (session + membership + row) +
    // activity JSON (scope 2 + chat 1 + cursor 1) = 2 + 3 + 4.
    expect(counter.totals.statements).toBe(9);
    expect(counter.totals.writeStatements).toBe(0);
    expect(counter.totals.rowsWritten).toBe(0);
  });

  it('idle SSE stream rotates by query budget with zero writes and no resync', async () => {
    const { counter } = countedEnv();
    const response = createActivityStream(counter.db, {
      workspaceId: WS,
      chatId: aviChat,
      afterCursor: 0,
      sessionToken: TOKEN,
      userId: AVI,
      pollIntervalMs: 5,
      maxStreamMs: 60_000,
      heartbeatMs: 20,
    });
    const body = await readAll(response);
    // Budget rotation, not time expiry (60s never reached) and not an error:
    // the stream ran to its query budget, closed cleanly, and never asked
    // for a full snapshot reload.
    expect(counter.totals.statements).toBeGreaterThanOrEqual(15);
    expect(counter.totals.statements).toBeLessThanOrEqual(25);
    expect(counter.totals.writeStatements).toBe(0);
    expect(counter.totals.rowsWritten).toBe(0);
    expect(body).not.toContain('resync_required');
    expect(body).toContain('heartbeat');
  });

  it('concurrent tabs and reconnects stay within budget with zero writes', async () => {
    const tabs = [countDb(env.DB), countDb(env.DB), countDb(env.DB)];
    const open = (counter: ReturnType<typeof countDb>) =>
      createActivityStream(counter.db, {
        workspaceId: WS,
        chatId: aviChat,
        afterCursor: 0,
        sessionToken: TOKEN,
        userId: AVI,
        pollIntervalMs: 5,
        maxStreamMs: 60_000,
        heartbeatMs: 20,
      });
    const first = await Promise.all(tabs.map(async (counter) => readAll(open(counter))));
    for (const body of first) expect(body).not.toContain('resync_required');
    // Reconnect every tab once from its cursor: rotation, not reload.
    const second = await Promise.all(tabs.map(async (counter) => readAll(open(counter))));
    for (const body of second) expect(body).not.toContain('resync_required');
    for (const counter of tabs) {
      expect(counter.totals.statements).toBeLessThanOrEqual(88);
      expect(counter.totals.writeStatements).toBe(0);
      expect(counter.totals.rowsWritten).toBe(0);
    }
  });
});

describe('D1 zero-mutation idle recovery', () => {
  it('idle memory refresh and recovery discovery change zero rows', async () => {
    const { counter } = countedEnv();
    const listed = await listWorkspacesNeedingRecovery(counter.db);
    expect(listed).not.toContain(WS_PARKED);
    const memory = await processMemoryRefreshJobs(counter.db);
    expect(memory).toEqual({ processed: 0, completed: 0 });
    // The discovery read plus the unconditional cleanup UPDATE (zero matched
    // rows) plus the empty discovery read: reads happen, changed rows zero.
    expect(counter.totals.writeStatements).toBe(1);
    expect(counter.totals.rowsWritten).toBe(0);
  });

  it('recovering idle and parked workspaces changes zero rows', async () => {
    const { counter } = countedEnv();
    const idle = await recoverWorkspace(counter.db, WS);
    expect(idle).toEqual({ requeuedRuns: 0, resetOutbox: 0, failedPoison: 0, createdOutbox: 0 });
    // Parked in waiting_for_input with no lease, no stuck rows, no stale
    // sending rows, no orphans, nothing cancelled: every revisit reads and
    // the single restrictive cleanup UPDATE matches zero rows.
    const parked = await recoverWorkspace(counter.db, WS_PARKED);
    expect(parked).toEqual({ requeuedRuns: 0, resetOutbox: 0, failedPoison: 0, createdOutbox: 0 });
    const quiet = await dispatchWorkspace(counter.db, WS_PARKED);
    expect(quiet.processed).toBe(0);
    // Two UPDATE statements ran (one restrictive cleanup per workspace) and
    // both matched zero rows: statements are counted honestly, changed rows
    // are what the write budget bills.
    expect(counter.totals.writeStatements).toBe(2);
    expect(counter.totals.rowsWritten).toBe(0);
  });
});
