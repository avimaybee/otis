import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
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
// @ts-expect-error vite raw import
import migration0010Sql from '../../../migrations/0010_outbox_retry_at.sql?raw';
// @ts-expect-error vite raw import
import migration0011Sql from '../../../migrations/0011_link_workspace_intent.sql?raw';
// @ts-expect-error vite raw import
import migration0012Sql from '../../../migrations/0012_voice_media.sql?raw';
// @ts-expect-error vite raw import
import migration0015Sql from '../../../migrations/0015_message_image_attachments.sql?raw';
import { AUTH_BOUNDS } from '@otis/contracts';
import type { HttpErrorResponse } from '@otis/contracts';
import { acceptWebMessage, createChat } from '../src/inbox/repository.js';
import { AgentHandler } from '../src/agent/handler.js';
import { FakeProviderAdapter } from '@otis/agent';
import {
  ActorError,
  completeRun,
  dispatchOutboxItem,
  dispatchWorkspace,
  EchoHandler,
  listWorkspacesNeedingRecovery,
  pinRun,
  recoverWorkspace,
  requeueAsHolder,
  resumeRun,
  stopRun,
  type LoadedRun,
  type TurnHandler,
} from '../src/actor/dispatch.js';
import {
  claimWorkspaceLease,
  getWorkspaceLease,
  releaseWorkspaceLease,
  renewWorkspaceLease,
} from '../src/actor/leases.js';
import {
  adoptStep,
  completeStep,
  listRunSteps,
  nextStepIndex,
  persistStep,
  StepError,
} from '../src/actor/steps.js';
import { executeLedgerCommand, handleCreateTask } from '@otis/ledger';
import { removeMember, sha256 } from '@otis/identity';
import worker from '../src/index.js';

const CSRF = {
  origin: 'http://localhost',
  [AUTH_BOUNDS.CSRF_HEADER]: '1',
  'Content-Type': 'application/json',
};

async function loadRunById(runId: string): Promise<LoadedRun> {
  const row = await env.DB.prepare(
    `SELECT id, workspace_id, chat_id, source_message_id, source_job_id, status, attempt_id, lease_fence
     FROM agent_runs WHERE id = ?`,
  )
    .bind(runId)
    .first<Record<string, unknown>>();
  if (!row) throw new Error(`run ${runId} missing`);
  return {
    id: String(row['id']),
    workspace_id: String(row['workspace_id']),
    chat_id: String(row['chat_id']),
    source_message_id: row['source_message_id'] ? String(row['source_message_id']) : null,
    source_job_id: row['source_job_id'] ? String(row['source_job_id']) : null,
    status: String(row['status']),
    attempt_id: row['attempt_id'] ? String(row['attempt_id']) : null,
    lease_fence: Number(row['lease_fence'] ?? 0),
  };
}

async function outboxIdForRun(runId: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT id FROM outbox WHERE json_extract(payload_json, '$.run_id') = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(runId)
    .first<{ id: string }>();
  if (!row) throw new Error(`outbox for run ${runId} missing`);
  return row.id;
}

async function replyCount(runId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`,
  )
    .bind(runId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function runStatus(runId: string): Promise<string> {
  return (await loadRunById(runId)).status;
}

async function insertAnswerMessage(id: string, userId: string, extSuffix: string): Promise<void> {
  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
     VALUES (?, ?, ?, 'web', ?, ?, 'processing', ?, ?)`,
  )
    .bind(id, 'ws-actor-test', userId, `ext-${extSuffix}`, `fp-${extSuffix}`, nowIso, nowIso)
    .run();
}

describe('Worker Actor Dispatch & Recovery Integration (workerd)', () => {
  const ws = 'ws-actor-test';
  const aviId = 'usr_act_avi';
  const hunorId = 'usr_act_hunor';
  let chatAvi: string;
  let chatHunor: string;
  let aviCookie: string;
  let hunorCookie: string;

  async function accept(chatId: string, userId: string, clientId: string, text: string) {
    return acceptWebMessage(env.DB, {
      workspaceId: ws,
      chatId,
      userId,
      clientMessageId: clientId,
      text,
    });
  }

  function splitSqlStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let inTrigger = false;

    for (const rawLine of sql.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('--') || line.length === 0) continue;

      current += rawLine + '\n';
      if (/\bBEGIN\b/i.test(line)) {
        inTrigger = true;
      }
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

    if (current.trim().length > 0) {
      statements.push(current.trim());
    }
    return statements;
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
      migration0010Sql,
      migration0011Sql,
      migration0012Sql,
      migration0015Sql,
    ]) {
      for (const stmt of splitSqlStatements(sql)) {
        await env.DB.prepare(stmt).run();
      }
    }
    env.ENVIRONMENT = 'test';
    env.USE_ECHO_HANDLER = 'true';

    const now = new Date().toISOString();
    for (const [id, fb, email, name] of [
      [aviId, 'fb_act_avi', 'avi@kerning.test', 'Avi'],
      [hunorId, 'fb_act_hunor', 'hunor@kerning.test', 'Hunor'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, fb, email, name, now, now)
        .run();
    }
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
       VALUES (?, 'Actor WS', ?, 0, 1, ?, ?)`,
    )
      .bind(ws, aviId, now, now)
      .run();
    for (const [user, role] of [
      [aviId, 'owner'],
      [hunorId, 'member'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(ws, user, role, now, now, now)
        .run();
    }
    chatAvi = (
      await createChat(env.DB, { workspaceId: ws, authorUserId: aviId, title: 'Avi actor chat' })
    ).id;
    chatHunor = (
      await createChat(env.DB, { workspaceId: ws, authorUserId: hunorId, title: 'Hunor actor chat' })
    ).id;

    for (const [sid, raw, user, holder] of [
      ['sess_act_avi', 'act_token_avi', aviId, 'aviCookie'],
      ['sess_act_hunor', 'act_token_hunor', hunorId, 'hunorCookie'],
    ] as const) {
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
      await env.DB.prepare(
        `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      )
        .bind(sid, await sha256(raw), user, now, expiresAt, now)
        .run();
      const cookie = `${AUTH_BOUNDS.COOKIE_NAME}=${raw}`;
      if (holder === 'aviCookie') aviCookie = cookie;
      else hunorCookie = cookie;
    }
  });

  it('dispatches oldest-first and completes every accepted turn', async () => {
    const first = await accept(chatAvi, aviId, 'act-msg-001', 'first report');
    const second = await accept(chatAvi, aviId, 'act-msg-002', 'second report');

    const one = await dispatchWorkspace(env.DB, ws, { budget: 1 });
    expect(one.processed).toBe(1);
    expect(one.results[0]?.run_id).toBe(first.run_id);

    const rest = await dispatchWorkspace(env.DB, ws);
    expect(rest.processed).toBe(1);
    expect(await runStatus(first.run_id)).toBe('succeeded');
    expect(await runStatus(second.run_id)).toBe('succeeded');
    expect(await replyCount(first.run_id)).toBe(1);
    expect(await replyCount(second.run_id)).toBe(1);
  });

  it('duplicate delivery commits once and replays the recorded result', async () => {
    const msg = await accept(chatAvi, aviId, 'act-msg-003', 'duplicate me');
    const outboxId = await outboxIdForRun(msg.run_id);

    const [a, b] = await Promise.all([
      dispatchOutboxItem(env.DB, outboxId, ws),
      dispatchOutboxItem(env.DB, outboxId, ws),
    ]);
    const completed = [a, b].filter((r) => r.status === 'completed');
    expect(completed).toHaveLength(1);
    expect(await replyCount(msg.run_id)).toBe(1);

    // Exactly one logical step was persisted despite two deliveries.
    const steps = await env.DB.prepare(`SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ?`)
      .bind(msg.run_id)
      .first<{ n: number }>();
    expect(Number(steps?.n)).toBe(1);

    const redelivery = await dispatchOutboxItem(env.DB, outboxId, ws);
    expect(redelivery.status).toBe('already_done');
    expect(await replyCount(msg.run_id)).toBe(1);
  });

  it('out-of-order wake-ups still complete every turn', async () => {
    const older = await accept(chatAvi, aviId, 'act-msg-004', 'older turn');
    const newer = await accept(chatAvi, aviId, 'act-msg-005', 'newer turn');

    const newerFirst = await dispatchOutboxItem(env.DB, await outboxIdForRun(newer.run_id), ws);
    expect(newerFirst.status).toBe('completed');
    const olderSecond = await dispatchOutboxItem(env.DB, await outboxIdForRun(older.run_id), ws);
    expect(olderSecond.status).toBe('completed');
    expect(await runStatus(older.run_id)).toBe('succeeded');
    expect(await runStatus(newer.run_id)).toBe('succeeded');
  });

  it('recovers an acceptance whose dispatch never ran (orphaned run)', async () => {
    const msg = await accept(chatAvi, aviId, 'act-msg-006', 'lost wake-up');
    // Simulate the crash: dispatch intent gone, run still queued.
    await env.DB.prepare(`DELETE FROM outbox WHERE json_extract(payload_json, '$.run_id') = ?`)
      .bind(msg.run_id)
      .run();

    const recovery = await recoverWorkspace(env.DB, ws);
    expect(recovery.createdOutbox).toBe(1);

    const dispatched = await dispatchWorkspace(env.DB, ws);
    expect(dispatched.results.some((r) => r.run_id === msg.run_id && r.status === 'completed')).toBe(true);
    expect(await runStatus(msg.run_id)).toBe('succeeded');
  });

  it('recovers a holder that died mid-run without repeating the effect', async () => {
    const msg = await accept(chatAvi, aviId, 'act-msg-007', 'dead holder turn');
    const outboxId = await outboxIdForRun(msg.run_id);
    const past = '2000-01-01T00:00:00.000Z';

    // Dead holder state: pinned run, expired lease, stale sending outbox.
    await env.DB.prepare(`UPDATE agent_runs SET status = 'running', attempt_id = 'att_dead', lease_fence = 41 WHERE id = ?`)
      .bind(msg.run_id)
      .run();
    await env.DB.prepare(
      `UPDATE workspaces SET lease_owner = 'att_dead', lease_attempt_id = 'att_dead', lease_fence = 41, lease_expires_at = ? WHERE id = ?`,
    )
      .bind(past, ws)
      .run();
    await env.DB.prepare(`UPDATE outbox SET status = 'sending', last_attempt_at = ? WHERE id = ?`)
      .bind(past, outboxId)
      .run();

    const recovery = await recoverWorkspace(env.DB, ws);
    expect(recovery.requeuedRuns).toBe(1);

    const dispatched = await dispatchWorkspace(env.DB, ws);
    expect(dispatched.results.some((r) => r.run_id === msg.run_id && r.status === 'completed')).toBe(true);
    expect(await replyCount(msg.run_id)).toBe(1);
  });

  it('a stale lease holder cannot commit a business effect', async () => {
    const msg = await accept(chatAvi, aviId, 'act-msg-008', 'fenced turn');
    const run = await loadRunById(msg.run_id);

    const first = await claimWorkspaceLease(env.DB, { workspaceId: ws, attemptId: 'att_first' });
    if (!first) throw new Error('first claim failed');
    expect(await pinRun(env.DB, run, 'att_first', first.fence, new Date().toISOString())).toBe(true);

    // Lease expires; a successor claims and the fence advances.
    await env.DB.prepare(`UPDATE workspaces SET lease_expires_at = ? WHERE id = ?`)
      .bind('2000-01-01T00:00:00.000Z', ws)
      .run();
    const second = await claimWorkspaceLease(env.DB, { workspaceId: ws, attemptId: 'att_second' });
    if (!second) throw new Error('second claim failed');
    expect(second.fence).toBeGreaterThan(first.fence);

    // The stale holder's commit is rejected; nothing is written.
    await expect(
      completeRun(env.DB, {
        run,
        attemptId: 'att_first',
        fence: first.fence,
        replyText: 'stale write',
        channel: 'web',
        outboxId: null,
        nowIso: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'stale_lease' });
    expect(ActorError).toBeDefined();
    expect(await replyCount(msg.run_id)).toBe(0);
    expect(await runStatus(msg.run_id)).toBe('running');

    // Recovery heals the run and exactly one effect lands.
    await env.DB.prepare(`UPDATE workspaces SET lease_expires_at = ? WHERE id = ?`)
      .bind('2000-01-01T00:00:00.000Z', ws)
      .run();
    await recoverWorkspace(env.DB, ws);
    const dispatched = await dispatchWorkspace(env.DB, ws);
    expect(dispatched.results.some((r) => r.run_id === msg.run_id && r.status === 'completed')).toBe(true);
    expect(await replyCount(msg.run_id)).toBe(1);
  });

  it('a waiting clarification releases the slot; answer resumes durably without in-memory state', async () => {
    // No counters: the handler can only act on the durable answer carried by
    // the context, so a restarted process behaves identically.
    const answerDriven: TurnHandler = {
      name: 'answer-driven',
      async runTurn(ctx) {
        if (!ctx.answerText) {
          return {
            kind: 'needs_input',
            question: 'Which date?',
            intendedOperation: 'create_task',
            missingFields: ['due'],
          };
        }
        return { kind: 'completed', replyText: `Done for ${ctx.answerText}: ${ctx.sourceText}` };
      },
    };

    const first = await accept(chatAvi, aviId, 'act-msg-009', 'task without date');
    const waiting = await dispatchWorkspace(env.DB, ws, { handler: answerDriven });
    expect(waiting.results[0]?.status).toBe('waiting_for_input');
    expect(await runStatus(first.run_id)).toBe('waiting_for_input');
    expect(await getWorkspaceLease(env.DB, ws)).toBeNull();

    const clarifications = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`,
    )
      .bind(first.run_id)
      .first<{ n: number }>();
    expect(Number(clarifications?.n)).toBe(1);

    // Hunor's own turn proceeds while Avi's waits.
    const second = await accept(chatHunor, hunorId, 'act-msg-010', 'hunor report');
    const teammate = await dispatchWorkspace(env.DB, ws);
    expect(teammate.results.some((r) => r.run_id === second.run_id && r.status === 'completed')).toBe(true);

    // Resuming without a pending clarification is a no-op.
    await insertAnswerMessage('msg-ans-nopend-h09', aviId, 'ans-nopend-h09');
    expect(
      await resumeRun(env.DB, {
        workspaceId: ws,
        runId: second.run_id,
        answer: { text: 'n/a', messageId: 'msg-ans-nopend-h09' },
      }),
    ).toEqual({ resumed: false, failureReason: 'run_not_waiting', runStatus: 'succeeded' });

    // The answer is persisted on the clarification and resumes exactly once.
    await insertAnswerMessage('msg-ans-friday-h09', aviId, 'ans-friday-h09');
    const q09 = await env.DB.prepare(`SELECT id FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`)
      .bind(first.run_id)
      .first<{ id: string }>();
    expect(
      await resumeRun(env.DB, {
        workspaceId: ws,
        runId: first.run_id,
        answer: { text: 'Friday', messageId: 'msg-ans-friday-h09', clarificationId: q09!.id },
      }),
    ).toMatchObject({ resumed: true });
    const stored = await env.DB.prepare(
      `SELECT status, resolution_response FROM pending_clarifications WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(first.run_id)
      .first<{ status: string; resolution_response: string | null }>();
    expect(stored?.status).toBe('resolved');
    expect(stored?.resolution_response).toBe('Friday');

    // A fresh dispatch (simulated restart) receives the durable answer.
    const resumed = await dispatchWorkspace(env.DB, ws, { handler: answerDriven });
    expect(resumed.results.some((r) => r.run_id === first.run_id && r.status === 'completed')).toBe(true);
    expect(await replyCount(first.run_id)).toBe(1);
    const reply = await env.DB.prepare(
      `SELECT content_text FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`,
    )
      .bind(first.run_id)
      .first<{ content_text: string }>();
    expect(reply?.content_text).toContain('Friday');

    const pending = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`,
    )
      .bind(first.run_id)
      .first<{ n: number }>();
    expect(Number(pending?.n)).toBe(0);
    const questions = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM run_activity WHERE run_id = ? AND type = 'clarification_required'`,
    )
      .bind(first.run_id)
      .first<{ n: number }>();
    expect(Number(questions?.n)).toBe(1);
    // Repeated resume cannot double-queue the continuation.
    expect(
      await resumeRun(env.DB, {
        workspaceId: ws,
        runId: first.run_id,
        answer: { text: 'Friday', messageId: 'msg-ans-friday-h09', clarificationId: q09!.id },
      }),
    ).toEqual({ resumed: false, replay: true, clarificationId: q09!.id });
  });

  it('stop cancels future work author-scoped; a stopped holder cannot commit', async () => {
    const queued = await accept(chatAvi, aviId, 'act-msg-011', 'stoppable turn');
    const stopRes = await SELF.fetch(`http://localhost/api/workspaces/${ws}/runs/${queued.run_id}/stop`, {
      method: 'POST',
      headers: { cookie: aviCookie, ...CSRF },
    });
    expect(stopRes.status).toBe(200);
    expect(await runStatus(queued.run_id)).toBe('cancelled');
    await insertAnswerMessage('msg-ans-stopped-h11', aviId, 'ans-stopped-h11');
    expect(
      await resumeRun(env.DB, {
        workspaceId: ws,
        runId: queued.run_id,
        answer: { text: 'x', messageId: 'msg-ans-stopped-h11' },
      }),
    ).toEqual({ resumed: false, failureReason: 'run_not_waiting', runStatus: 'cancelled' });

    const other = await accept(chatAvi, aviId, 'act-msg-012', 'not yours to stop');
    const forbidden = await SELF.fetch(`http://localhost/api/workspaces/${ws}/runs/${other.run_id}/stop`, {
      method: 'POST',
      headers: { cookie: hunorCookie, ...CSRF },
    });
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as HttpErrorResponse).error.code).toBe('run_inactive');
    await dispatchWorkspace(env.DB, ws);
    expect(await runStatus(other.run_id)).toBe('succeeded');

    // A holder pinned before the stop loses its commit.
    const pinned = await accept(chatAvi, aviId, 'act-msg-013', 'pinned then stopped');
    const run = await loadRunById(pinned.run_id);
    const lease = await claimWorkspaceLease(env.DB, { workspaceId: ws, attemptId: 'att_stop' });
    if (!lease) throw new Error('claim failed');
    expect(await pinRun(env.DB, run, 'att_stop', lease.fence, new Date().toISOString())).toBe(true);
    const stopped = await stopRun(env.DB, { workspaceId: ws, runId: pinned.run_id, actorUserId: aviId });
    expect(stopped).toEqual({ stopped: true, status: 'cancelled' });
    await expect(
      completeRun(env.DB, {
        run,
        attemptId: 'att_stop',
        fence: lease.fence,
        replyText: 'too late',
        channel: 'web',
        outboxId: null,
        nowIso: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'run_inactive' });
    expect(await replyCount(pinned.run_id)).toBe(0);
  });

  it('poison inputs fail visibly without retrying forever', async () => {
    const throwing: TurnHandler = {
      name: 'always-throws',
      async runTurn() {
        throw new Error('boom');
      },
    };
    const poisoned = await accept(chatAvi, aviId, 'act-msg-014', 'poison turn');
    await env.DB.prepare(
      `UPDATE outbox SET max_attempts = 2 WHERE json_extract(payload_json, '$.run_id') = ?`,
    )
      .bind(poisoned.run_id)
      .run();
    await dispatchWorkspace(env.DB, ws, { handler: throwing, maxAttempts: 2 });
    await dispatchWorkspace(env.DB, ws, { handler: throwing, maxAttempts: 2 });
    expect(await runStatus(poisoned.run_id)).toBe('failed');
    const inbox = await env.DB.prepare(`SELECT status FROM messages_in WHERE id = ?`)
      .bind((await loadRunById(poisoned.run_id)).source_message_id)
      .first<{ status: string }>();
    expect(inbox?.status).toBe('failed');

    // A run with no durable source cannot exist: the schema CHECK enforces
    // exactly one of source_message_id / source_job_id.
    const now = new Date().toISOString();
    await expect(
      env.DB.prepare(
        `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, source_job_id, executor_kind, status, created_at, updated_at)
         VALUES ('run_sourceless_poison', ?, ?, NULL, NULL, 'agent', 'queued', ?, ?)`,
      )
        .bind(ws, chatAvi, now, now)
        .run(),
    ).rejects.toThrow();
  });

  it('revoked membership fails the run visibly with no reply', async () => {
    const msg = await accept(chatHunor, hunorId, 'act-msg-015', 'hunor last report');
    await removeMember(env.DB, { workspaceId: ws, actorUserId: aviId, targetUserId: hunorId });

    const result = await dispatchWorkspace(env.DB, ws);
    expect(result.results.some((r) => r.run_id === msg.run_id && r.status === 'failed')).toBe(true);
    expect(await replyCount(msg.run_id)).toBe(0);
    const outbox = await env.DB.prepare(
      `SELECT status FROM outbox WHERE json_extract(payload_json, '$.run_id') = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(msg.run_id)
      .first<{ status: string }>();
    expect(outbox?.status).toBe('failed_known');
  });

  it('expired leases renew while held and reject renewal after loss', async () => {
    const live = await claimWorkspaceLease(env.DB, { workspaceId: ws, attemptId: 'att_live' });
    expect(live).not.toBeNull();
    const contended = await claimWorkspaceLease(env.DB, { workspaceId: ws, attemptId: 'att_late' });
    expect(contended).toBeNull();

    const renewed = await renewWorkspaceLease(env.DB, { workspaceId: ws, attemptId: 'att_live' });
    expect(renewed.attempt_id).toBe('att_live');

    await env.DB.prepare(`UPDATE workspaces SET lease_expires_at = ? WHERE id = ?`)
      .bind('2000-01-01T00:00:00.000Z', ws)
      .run();
    await expect(
      renewWorkspaceLease(env.DB, { workspaceId: ws, attemptId: 'att_live' }),
    ).rejects.toMatchObject({ code: 'lease_not_held' });

    const successor = await claimWorkspaceLease(env.DB, { workspaceId: ws, attemptId: 'att_next' });
    expect(successor).not.toBeNull();
    expect(successor?.fence).toBeGreaterThan(renewed.fence);
    expect(await releaseWorkspaceLease(env.DB, { workspaceId: ws, attemptId: 'att_next' })).toBe(true);
  });

  it('bounded slices checkpoint and resume without repeating work', async () => {
    const calls = new Map<string, number>();
    const chunked: TurnHandler = {
      name: 'chunked',
      async runTurn(ctx) {
        const n = (calls.get(ctx.runId) ?? 0) + 1;
        calls.set(ctx.runId, n);
        if (n < 3) return { kind: 'continuation', progressJson: JSON.stringify({ slice: n }) };
        return { kind: 'completed', replyText: `Chunked done: ${ctx.sourceText}` };
      },
    };
    const msg = await accept(chatAvi, aviId, 'act-msg-016', 'long turn');
    for (let i = 0; i < 3; i++) {
      await dispatchWorkspace(env.DB, ws, { handler: chunked });
    }
    expect(await runStatus(msg.run_id)).toBe('succeeded');
    expect(await replyCount(msg.run_id)).toBe(1);
    const checkpoints = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ? AND tool_name = 'checkpoint' AND status = 'succeeded'`,
    )
      .bind(msg.run_id)
      .first<{ n: number }>();
    expect(Number(checkpoints?.n)).toBe(2);
  });

  it('allocates step indexes from MAX without downloading prior steps', async () => {
    // Fully isolated workspace: no queued rows or pending outbox may leak
    // into the shared workspace.
    const iso = 'ws-actor-stepidx';
    const nowIso = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
       VALUES (?, 'StepIdx WS', ?, 0, 1, ?, ?)`,
    ).bind(iso, aviId, nowIso, nowIso).run();
    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)`,
    ).bind(iso, aviId, nowIso, nowIso, nowIso).run();
    const isoChat = (
      await createChat(env.DB, { workspaceId: iso, authorUserId: aviId, title: 'StepIdx chat' })
    ).id;
    const isoRunId = 'run_stepidx_1';
    await env.DB.prepare(
      `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
       VALUES ('msg_stepidx_1', ?, ?, 'web', 'ext_stepidx_1', 'fp_stepidx_1', 'processing', ?, ?)`,
    ).bind(iso, aviId, nowIso, nowIso).run();
    await env.DB.prepare(
      `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, source_job_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'msg_stepidx_1', NULL, 'queued', ?, ?)`,
    ).bind(isoRunId, iso, isoChat, nowIso, nowIso).run();
    expect(await nextStepIndex(env.DB, isoRunId)).toBe(0);
    for (const index of [0, 1, 3]) {
      await env.DB.prepare(
        `INSERT INTO run_steps (id, run_id, workspace_id, step_index, tool_name, arguments_hash, arguments_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'find_entities', 'h', '{}', 'succeeded', ?, ?)`,
      ).bind(`stp_idx_${index}`, isoRunId, iso, index, nowIso, nowIso).run();
    }
    // The gap at 2 stays empty: MAX+1 skips it instead of colliding the way
    // a row count would.
    expect(await nextStepIndex(env.DB, isoRunId)).toBe(4);
  });

  it('drives dispatch through the Durable Object, cron, and queue entrypoints', async () => {
    const viaDo = await accept(chatAvi, aviId, 'act-msg-017', 'actor turn');
    const stub = env.WORKSPACE_ACTOR.get(env.WORKSPACE_ACTOR.idFromName(ws));
    const doRes = await stub.fetch(
      new Request('https://actor/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dispatch', workspace_id: ws, budget: 5, sync: true }),
      }),
    );
    expect(doRes.status).toBe(200);
    expect(await runStatus(viaDo.run_id)).toBe('succeeded');

    const viaCron = await accept(chatAvi, aviId, 'act-msg-018', 'cron turn');
    await worker.scheduled({} as ScheduledEvent, env, {} as ExecutionContext);
    expect(await runStatus(viaCron.run_id)).toBe('succeeded');

    const viaQueue = await accept(chatAvi, aviId, 'act-msg-019', 'queue turn');
    await worker.queue(
      { messages: [{ body: { workspace_id: ws } }, { body: {} }] } as unknown as MessageBatch<{
        workspace_id?: unknown;
      }>,
      env,
    );
    expect(await runStatus(viaQueue.run_id)).toBe('succeeded');
    expect(EchoHandler.name).toBe('echo');
  });

  // --- 004B hardening regression tests (P0/P1 findings) ---

  async function waitFor(label: string, check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  it('P0-1: a stale attempt throwing after losing its lease cannot clobber the successor', async () => {
    const msg = await accept(chatAvi, aviId, 'act-msg-020', 'stale error path');
    const outboxId = await outboxIdForRun(msg.run_id);

    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const slowThrow: TurnHandler = {
      name: 'slow-throw',
      async runTurn() {
        await gate;
        throw new Error('A failed after losing the lease');
      },
    };
    const dispatchA = dispatchOutboxItem(env.DB, outboxId, ws, { handler: slowThrow, leaseTtlSeconds: 1 });

    await waitFor('A to pin the run', async () => (await loadRunById(msg.run_id)).attempt_id !== null);

    // A's lease expires. Recovery detects the dead attempt (no live lease for
    // it), requeues the run, and clears the dead lease; B then claims and
    // pins exactly as a successor dispatch would.
    await env.DB.prepare(`UPDATE workspaces SET lease_expires_at = ? WHERE id = ?`)
      .bind('2000-01-01T00:00:00.000Z', ws)
      .run();
    const recovery = await recoverWorkspace(env.DB, ws);
    expect(recovery.requeuedRuns).toBe(1);
    const leaseB = await claimWorkspaceLease(env.DB, { workspaceId: ws, attemptId: 'att_b' });
    if (!leaseB) throw new Error('B claim failed');
    const pinnedB = await pinRun(env.DB, await loadRunById(msg.run_id), 'att_b', leaseB.fence, new Date().toISOString());
    expect(pinnedB).toBe(true);

    releaseA();
    const resultA = await dispatchA;
    expect(resultA.status).toBe('deferred');
    expect(resultA.detail).toBe('stale_attempt');

    // A wrote no state: run still B's, no reply, step belongs to B now.
    const afterA = await loadRunById(msg.run_id);
    expect(afterA.status).toBe('running');
    expect(afterA.attempt_id).toBe('att_b');
    expect(await replyCount(msg.run_id)).toBe(0);
    const stepOwner = await env.DB.prepare(`SELECT attempt_id FROM run_steps WHERE run_id = ? AND step_index = 0`)
      .bind(msg.run_id)
      .first<{ attempt_id: string | null }>();
    expect(stepOwner?.attempt_id).toBe('att_b');

    // B commits exactly once.
    await completeRun(env.DB, {
      run: await loadRunById(msg.run_id),
      attemptId: 'att_b',
      fence: leaseB.fence,
      replyText: 'B wins',
      channel: 'web',
      outboxId,
      nowIso: new Date().toISOString(),
    });
    expect(await runStatus(msg.run_id)).toBe('succeeded');
    expect(await replyCount(msg.run_id)).toBe(1);
  });

  it('P0-1: a stale attempt returning a checkpoint cannot write checkpoints or requeue its successor', async () => {
    const msg = await accept(chatAvi, aviId, 'act-msg-021', 'stale checkpoint');
    const outboxId = await outboxIdForRun(msg.run_id);

    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const slowCheckpoint: TurnHandler = {
      name: 'slow-checkpoint',
      async runTurn() {
        await gate;
        return { kind: 'continuation', progressJson: JSON.stringify({ slice: 1 }) };
      },
    };
    const dispatchA = dispatchOutboxItem(env.DB, outboxId, ws, { handler: slowCheckpoint, leaseTtlSeconds: 1 });
    await waitFor('A to pin the run', async () => (await loadRunById(msg.run_id)).attempt_id !== null);

    await env.DB.prepare(`UPDATE workspaces SET lease_expires_at = ? WHERE id = ?`)
      .bind('2000-01-01T00:00:00.000Z', ws)
      .run();
    const recovery = await recoverWorkspace(env.DB, ws);
    expect(recovery.requeuedRuns).toBe(1);
    const leaseB = await claimWorkspaceLease(env.DB, { workspaceId: ws, attemptId: 'att_b2' });
    if (!leaseB) throw new Error('B claim failed');
    await pinRun(env.DB, await loadRunById(msg.run_id), 'att_b2', leaseB.fence, new Date().toISOString());

    releaseA();
    const resultA = await dispatchA;
    expect(resultA.status).toBe('deferred');
    expect(resultA.detail).toBe('stale_attempt');

    const checkpoints = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ? AND tool_name = 'checkpoint'`,
    )
      .bind(msg.run_id)
      .first<{ n: number }>();
    expect(Number(checkpoints?.n)).toBe(0);
    expect((await loadRunById(msg.run_id)).status).toBe('running');
    expect((await loadRunById(msg.run_id)).attempt_id).toBe('att_b2');

    // Cleanup: no live lease or pending work may leak into later tests.
    await releaseWorkspaceLease(env.DB, { workspaceId: ws, attemptId: 'att_b2' });
    await env.DB.prepare(`UPDATE outbox SET status = 'cancelled', updated_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), outboxId)
      .run();
    await env.DB.prepare(`UPDATE agent_runs SET status = 'cancelled', updated_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), msg.run_id)
      .run();
  });

  it('P0-2: a handler outliving the lease TTL cannot renew or commit with a stale clock', async () => {
    let clockMs = Date.parse('2026-01-01T00:00:00.000Z');
    const clock = () => new Date(clockMs).toISOString();
    const slow: TurnHandler = {
      name: 'slow-ttl',
      async runTurn() {
        clockMs += 11_000; // outlive the 10s lease
        return { kind: 'completed', replyText: 'too late' };
      },
    };
    const msg = await accept(chatAvi, aviId, 'act-msg-022', 'ttl turn');
    const outboxId = await outboxIdForRun(msg.run_id);

    const result = await dispatchOutboxItem(env.DB, outboxId, ws, {
      handler: slow,
      clock,
      leaseTtlSeconds: 10,
    });
    expect(result.status).toBe('deferred');
    expect(result.detail).toBe('lease_lost');
    expect(await replyCount(msg.run_id)).toBe(0);
    expect(await runStatus(msg.run_id)).toBe('queued');
    expect(await getWorkspaceLease(env.DB, ws)).toBeNull();
  });

  it('P1-3: cron discovers and recovers a workspace whose only work is an orphaned run', async () => {
    const msg = await accept(chatAvi, aviId, 'act-msg-023', 'cron orphan');
    await env.DB.prepare(`DELETE FROM outbox WHERE json_extract(payload_json, '$.run_id') = ?`)
      .bind(msg.run_id)
      .run();

    // Discovery is driven by durable runs, not only by existing outbox rows.
    const discovered = await listWorkspacesNeedingRecovery(env.DB);
    expect(discovered).toContain(ws);

    await worker.scheduled({} as ScheduledEvent, env, {} as ExecutionContext);
    expect(await runStatus(msg.run_id)).toBe('succeeded');
    expect(await replyCount(msg.run_id)).toBe(1);
  });

  it('P1-5: concurrent stop and completion leave exactly one consistent outcome', async () => {
    const msg = await accept(chatAvi, aviId, 'act-msg-024', 'stop race');
    const lease = await claimWorkspaceLease(env.DB, { workspaceId: ws, attemptId: 'att_race' });
    if (!lease) throw new Error('race claim failed');
    await pinRun(env.DB, await loadRunById(msg.run_id), 'att_race', lease.fence, new Date().toISOString());

    const [stopResult, completeResult] = await Promise.allSettled([
      stopRun(env.DB, { workspaceId: ws, runId: msg.run_id, actorUserId: aviId }),
      completeRun(env.DB, {
        run: await loadRunById(msg.run_id),
        attemptId: 'att_race',
        fence: lease.fence,
        replyText: 'completion won',
        channel: 'web',
        outboxId: null,
        nowIso: new Date().toISOString(),
      }),
    ]);

    const status = await runStatus(msg.run_id);
    const replies = await replyCount(msg.run_id);
    const inbox = await env.DB.prepare(`SELECT status FROM messages_in WHERE id = ?`)
      .bind((await loadRunById(msg.run_id)).source_message_id)
      .first<{ status: string }>();

    if (status === 'succeeded') {
      expect(replies).toBe(1);
      expect(inbox?.status).toBe('processed');
      // Stop must not claim a cancellation it did not commit.
      if (stopResult.status === 'fulfilled') expect(stopResult.value.stopped).toBe(false);
    } else if (status === 'cancelled') {
      expect(replies).toBe(0);
      expect(inbox?.status).toBe('cancelled');
    } else {
      throw new Error(`unexpected run status after race: ${status}`);
    }
    expect(completeResult.status === 'fulfilled' || completeResult.status === 'rejected').toBe(true);
  });

  it('P1-4: sequential clarifications survive restart without collapsing answers', async () => {
    // Handler asks Q1, then Q2, then completes — reading only durable state.
    const twoQuestions: TurnHandler = {
      name: 'two-questions',
      async runTurn(ctx) {
        const answered = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM pending_clarifications WHERE run_id = ? AND status = 'resolved'`,
        )
          .bind(ctx.runId)
          .first<{ n: number }>();
        const n = Number(answered?.n ?? 0);
        if (n === 0) {
          return { kind: 'needs_input', question: 'Q1?', intendedOperation: 'op', missingFields: ['a'] };
        }
        if (n === 1) {
          return { kind: 'needs_input', question: 'Q2?', intendedOperation: 'op', missingFields: ['b'] };
        }
        return { kind: 'completed', replyText: `Both answered: ${ctx.answerText}` };
      },
    };
    const msg = await accept(chatAvi, aviId, 'act-msg-025', 'two questions');
    await dispatchWorkspace(env.DB, ws, { handler: twoQuestions });
    expect(await runStatus(msg.run_id)).toBe('waiting_for_input');

    const q1row = await env.DB.prepare(
      `SELECT id FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`,
    )
      .bind(msg.run_id)
      .first<{ id: string }>();
    await insertAnswerMessage('msg-ans-p14-q1', aviId, 'ans-p14-q1');
    await resumeRun(env.DB, {
      workspaceId: ws,
      runId: msg.run_id,
      answer: { text: 'answer-1', messageId: 'msg-ans-p14-q1', clarificationId: q1row!.id },
    });
    await dispatchWorkspace(env.DB, ws, { handler: twoQuestions });
    expect(await runStatus(msg.run_id)).toBe('waiting_for_input');
    const pendingQs = await env.DB.prepare(
      `SELECT question FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`,
    )
      .bind(msg.run_id)
      .all<{ question: string }>();
    expect(pendingQs.results?.map((r) => r.question)).toEqual(['Q2?']);
    const questionActivity = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM run_activity WHERE run_id = ? AND type = 'clarification_required'`,
    )
      .bind(msg.run_id)
      .first<{ n: number }>();
    expect(Number(questionActivity?.n)).toBe(2);

    const q2row = await env.DB.prepare(
      `SELECT id FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`,
    )
      .bind(msg.run_id)
      .first<{ id: string }>();
    await insertAnswerMessage('msg-ans-p14-q2', aviId, 'ans-p14-q2');
    await resumeRun(env.DB, {
      workspaceId: ws,
      runId: msg.run_id,
      answer: { text: 'answer-2', messageId: 'msg-ans-p14-q2', clarificationId: q2row!.id },
    });
    await dispatchWorkspace(env.DB, ws, { handler: twoQuestions });
    expect(await runStatus(msg.run_id)).toBe('succeeded');
    expect(await replyCount(msg.run_id)).toBe(1);
    const reply = await env.DB.prepare(
      `SELECT content_text FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`,
    )
      .bind(msg.run_id)
      .first<{ content_text: string }>();
    expect(reply?.content_text).toContain('answer-2');
  });

  it('hardened-01: atomic pinning and requeueing prevent late attempt from stealing steps or corrupting outbox', async () => {
    const msg = await accept(chatAvi, aviId, 'act-msg-h01', 'atomic pin & requeue');
    const run = await loadRunById(msg.run_id);
    const attemptA = 'att-pin-a';
    const attemptB = 'att-pin-b';
    const nowIso = new Date().toISOString();

    // 1. Attempt A acquires lease and pins the queued run.
    const leaseA = await claimWorkspaceLease(env.DB, { workspaceId: ws, attemptId: attemptA, ttlSeconds: 30, nowIso });
    if (!leaseA) throw new Error('A claim failed');
    expect(await pinRun(env.DB, run, attemptA, leaseA.fence, nowIso)).toBe(true);
    const pinnedA = await loadRunById(msg.run_id);
    expect(pinnedA.status).toBe('running');
    expect(pinnedA.attempt_id).toBe(attemptA);

    // Persist a step under attempt A
    await persistStep(env.DB, {
      runId: msg.run_id,
      workspaceId: ws,
      stepIndex: 0,
      toolName: 'test-step',
      args: { test: 1 },
      attemptId: attemptA,
      nowIso,
    });

    // 2. Successor B takes over (e.g. after recovery resets to queued).
    await releaseWorkspaceLease(env.DB, { workspaceId: ws, attemptId: attemptA });
    await env.DB.prepare(`UPDATE agent_runs SET status = 'queued', attempt_id = NULL WHERE id = ?`).bind(msg.run_id).run();
    const leaseB = await claimWorkspaceLease(env.DB, { workspaceId: ws, attemptId: attemptB, ttlSeconds: 30, nowIso });
    if (!leaseB) throw new Error('B claim failed');
    expect(await pinRun(env.DB, await loadRunById(msg.run_id), attemptB, leaseB.fence, nowIso)).toBe(true);

    // Verify step index 0 is adopted by attempt B
    const stepsAfterB = await listRunSteps(env.DB, msg.run_id);
    expect(stepsAfterB[0].attempt_id).toBe(attemptB);

    // 3. Stale attempt A tries to pin again — must return false and fail the guard
    // (run no longer queued AND A no longer holds the lease).
    expect(await pinRun(env.DB, await loadRunById(msg.run_id), attemptA, leaseA.fence, nowIso)).toBe(false);

    // Verify step ownership was NOT assigned back to A!
    const stepsCheck = await listRunSteps(env.DB, msg.run_id);
    expect(stepsCheck[0].attempt_id).toBe(attemptB);

    // 4. Stale attempt A tries to call requeueAsHolder — must fail guard and touch nothing
    const outboxId = await outboxIdForRun(msg.run_id);
    const requeued = await requeueAsHolder(env.DB, {
      workspaceId: ws,
      runId: msg.run_id,
      attemptId: attemptA,
      outboxId,
      nowIso,
    });
    expect(requeued).toBe(false);

    // B's run is STILL running and outbox is NOT clobbered to pending by A!
    const runAfterLateA = await loadRunById(msg.run_id);
    expect(runAfterLateA.status).toBe('running');
    expect(runAfterLateA.attempt_id).toBe(attemptB);
    await releaseWorkspaceLease(env.DB, { workspaceId: ws, attemptId: attemptB });
    await env.DB.prepare(`DELETE FROM run_steps WHERE run_id = ?`).bind(msg.run_id).run();
    await env.DB.prepare(`DELETE FROM agent_runs WHERE id = ?`).bind(msg.run_id).run();
    await env.DB.prepare(`DELETE FROM outbox WHERE id = ?`).bind(outboxId).run();
  });

  it('hardened-02: waiting for workspace lease does not consume failure budget; turn succeeds after lease released', async () => {
    // 1. Hold workspace lease with a dedicated holder
    const holderAttempt = 'att-lease-holder-h02';
    const acquired = await claimWorkspaceLease(env.DB, {
      workspaceId: ws,
      attemptId: holderAttempt,
      ttlSeconds: 60,
      nowIso: new Date().toISOString(),
    });
    expect(acquired).not.toBeNull();

    // 2. Accept turn B
    const msgB = await accept(chatAvi, aviId, 'act-msg-h02', 'turn B under contention');
    const outboxIdB = await outboxIdForRun(msgB.run_id);

    // 3. Attempt to dispatch turn B 5 times (exceeding default 3 max attempts)
    for (let i = 0; i < 5; i++) {
      const dispatchRes = await dispatchWorkspace(env.DB, ws);
      expect(dispatchRes.results.some((r) => r.run_id === msgB.run_id && r.status === 'deferred')).toBe(true);
    }

    // 4. Verify turn B is STILL queued and poison check was NOT tripped
    expect(await runStatus(msgB.run_id)).toBe('queued');
    const outboxB = await env.DB.prepare(`SELECT attempt_count, status FROM outbox WHERE id = ?`)
      .bind(outboxIdB)
      .first<{ attempt_count: number; status: string }>();
    expect(outboxB?.status).toBe('pending');
    expect(outboxB?.attempt_count).toBe(0);

    // 5. Release holder's lease
    await releaseWorkspaceLease(env.DB, { workspaceId: ws, attemptId: holderAttempt });

    // 6. Dispatch again — turn B acquires lease and completes!
    const finishRes = await dispatchWorkspace(env.DB, ws);
    expect(finishRes.results.some((r) => r.run_id === msgB.run_id && r.status === 'completed')).toBe(true);
    expect(await runStatus(msgB.run_id)).toBe('succeeded');
  });

  it('hardened-03: answering Q1 and parking on Q2 rejects redelivery of Q1 answer; Q2 remains pending', async () => {
    const multiQuestionHandler: TurnHandler = {
      name: 'multi-question-h03',
      async runTurn(ctx) {
        const resolved = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM pending_clarifications WHERE run_id = ? AND status = 'resolved'`,
        )
          .bind(ctx.runId)
          .first<{ n: number }>();
        const n = Number(resolved?.n ?? 0);
        if (n === 0) {
          return { kind: 'needs_input', question: 'Q1: What is the date?', intendedOperation: 'set_date', missingFields: ['due_date'] };
        }
        if (n === 1) {
          return { kind: 'needs_input', question: 'Q2: What is the priority?', intendedOperation: 'set_priority', missingFields: ['priority'] };
        }
        return { kind: 'completed', replyText: `Done with date=${ctx.answerText}` };
      },
    };

    const msg = await accept(chatAvi, aviId, 'act-msg-h03', 'multi-clarification turn');
    await dispatchWorkspace(env.DB, ws, { handler: multiQuestionHandler });
    expect(await runStatus(msg.run_id)).toBe('waiting_for_input');

    // Retrieve Q1 clarification
    const q1 = await env.DB.prepare(
      `SELECT id FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`,
    )
      .bind(msg.run_id)
      .first<{ id: string }>();
    expect(q1?.id).toBeTruthy();
    const q1Id = q1!.id;

    // Insert answer messages into messages_in to satisfy foreign key constraint
    const nowIso = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
       VALUES ('msg-ans-q1', ?, ?, 'web', 'ext-ans-q1', 'fp-ans-q1', 'processing', ?, ?),
              ('msg-ans-q2', ?, ?, 'web', 'ext-ans-q2', 'fp-ans-q2', 'processing', ?, ?)`,
    )
      .bind(ws, aviId, nowIso, nowIso, ws, aviId, nowIso, nowIso)
      .run();

    // Answer Q1 with stable answer message ID
    const ans1Res = await resumeRun(env.DB, {
      workspaceId: ws,
      runId: msg.run_id,
      answer: { text: '2026-10-15', messageId: 'msg-ans-q1', clarificationId: q1Id },
    });
    expect(ans1Res.resumed).toBe(true);

    // Dispatch: turn processes answer 1 and parks on Q2
    await dispatchWorkspace(env.DB, ws, { handler: multiQuestionHandler });
    expect(await runStatus(msg.run_id)).toBe('waiting_for_input');

    const q2 = await env.DB.prepare(
      `SELECT id, question FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`,
    )
      .bind(msg.run_id)
      .first<{ id: string; question: string }>();
    expect(q2?.question).toContain('Q2');
    const q2Id = q2!.id;
    expect(q2Id).not.toBe(q1Id);

    // Redeliver Q1 answer!
    const replayRes = await resumeRun(env.DB, {
      workspaceId: ws,
      runId: msg.run_id,
      answer: { text: '2026-10-15', messageId: 'msg-ans-q1', clarificationId: q1Id },
    });
    expect(replayRes.resumed).toBe(false);
    expect(replayRes.replay).toBe(true);

    // Assert Q2 remains pending and run remains waiting_for_input!
    const q2AfterReplay = await env.DB.prepare(
      `SELECT status FROM pending_clarifications WHERE id = ?`,
    )
      .bind(q2Id)
      .first<{ status: string }>();
    expect(q2AfterReplay?.status).toBe('pending');
    expect(await runStatus(msg.run_id)).toBe('waiting_for_input');

    // Answer Q2
    const ans2Res = await resumeRun(env.DB, {
      workspaceId: ws,
      runId: msg.run_id,
      answer: { text: 'high', messageId: 'msg-ans-q2', clarificationId: q2Id },
    });
    expect(ans2Res.resumed).toBe(true);

    // Complete run
    await dispatchWorkspace(env.DB, ws, { handler: multiQuestionHandler });
    expect(await runStatus(msg.run_id)).toBe('succeeded');
  });

  it('hardened-04: actor clarification resumption coordinates with ledger to commit business event atomically', async () => {
    // 1. Create a task that triggers clarification (missing due date) via executeLedgerCommand
    const run = await accept(chatAvi, aviId, 'act-msg-h04', 'create task without date');
    const loadedRun = await loadRunById(run.run_id);
    const attemptId = 'att-ledger-clar-h04';
    const nowH04 = new Date().toISOString();
    const leaseH04 = await claimWorkspaceLease(env.DB, { workspaceId: ws, attemptId, ttlSeconds: 30, nowIso: nowH04 });
    if (!leaseH04) throw new Error('h04 claim failed');
    await pinRun(env.DB, loadedRun, attemptId, leaseH04.fence, nowH04);

    const wsRow = await env.DB.prepare(`SELECT business_revision, membership_revision FROM workspaces WHERE id = ?`)
      .bind(ws)
      .first<{ business_revision: number; membership_revision: number }>();

    // Execute ledger command that needs clarification
    const commandRes = await executeLedgerCommand(
      env.DB,
      {
        workspace_id: ws,
        action_id: `act_${crypto.randomUUID()}`,
        actor: { kind: 'member', user_id: aviId },
        membership_revision: wsRow!.membership_revision,
        expected_business_revision: wsRow!.business_revision,
        source_message_id: loadedRun.source_message_id!,
        run_id: run.run_id,
        chat_id: chatAvi,
        request_id: `req_${crypto.randomUUID()}`,
        fence: leaseH04.fence,
      },
      'create_task',
      {
        task_id: `tsk_${crypto.randomUUID()}`,
        title: 'Send Bistro the contract',
        // missing due date!
      },
      handleCreateTask,
    );

    expect(commandRes.status).toBe('needs_clarification');
    expect(commandRes.clarification).toBeDefined();

    // Verify pending_clarifications row exists with operation_payload_json and run is waiting_for_input
    const clarRow = await env.DB.prepare(
      `SELECT id, status, operation_payload_json, missing_fields FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`,
    )
      .bind(run.run_id)
      .first<{ id: string; status: string; operation_payload_json: string; missing_fields: string }>();
    expect(clarRow?.status).toBe('pending');
    expect(clarRow?.operation_payload_json).toBeTruthy();
    expect(await runStatus(run.run_id)).toBe('waiting_for_input');

    // 2. Resume through actor dispatch with the resolved due date
    const answerMsgId = 'msg-answer-due-date-h04';
    await env.DB.prepare(
      `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
       VALUES (?, ?, ?, 'web', ?, 'fp_ans_h04', 'processing', ?, ?)`,
    )
      .bind(answerMsgId, ws, aviId, answerMsgId, new Date().toISOString(), new Date().toISOString())
      .run();

    // 2a. Attempt resumption with an unsolicited field — must be rejected and leave clarification pending
    const unsolicitedRes = await resumeRun(env.DB, {
      workspaceId: ws,
      runId: run.run_id,
      answer: {
        text: '2026-10-20',
        messageId: answerMsgId,
        clarificationId: clarRow!.id,
        resolvedFields: {
          due: { kind: 'date', local_date: '2026-10-20', timezone: 'UTC' },
          title: 'Hacked Title Overwrite',
        },
      },
    });
    expect(unsolicitedRes.resumed).toBe(false);
    const clarStillPending = await env.DB.prepare(`SELECT status FROM pending_clarifications WHERE id = ?`)
      .bind(clarRow!.id)
      .first<{ status: string }>();
    expect(clarStillPending?.status).toBe('pending');

    // 2b. Valid resumption through actor dispatch with only allowed missing fields
    const resumeOutcome = await resumeRun(env.DB, {
      workspaceId: ws,
      runId: run.run_id,
      answer: {
        text: '2026-10-20',
        messageId: answerMsgId,
        clarificationId: clarRow!.id,
        resolvedFields: {
          due: { kind: 'date', local_date: '2026-10-20', timezone: 'UTC' },
        },
      },
    });

    expect(resumeOutcome.resumed).toBe(true);

    // 2c. Redelivery of the exact same answer returns replay without re-executing
    const replayOutcome = await resumeRun(env.DB, {
      workspaceId: ws,
      runId: run.run_id,
      answer: {
        text: '2026-10-20',
        messageId: answerMsgId,
        clarificationId: clarRow!.id,
        resolvedFields: {
          due: { kind: 'date', local_date: '2026-10-20', timezone: 'UTC' },
        },
      },
    });
    expect(replayOutcome.resumed).toBe(false);
    expect(replayOutcome.replay).toBe(true);

    // 3. Verify ledger command committed its business event into events table and projection in D1
    const clarAfter = await env.DB.prepare(`SELECT status, resolution_response FROM pending_clarifications WHERE id = ?`)
      .bind(clarRow!.id)
      .first<{ status: string; resolution_response: string }>();
    expect(clarAfter?.status).toBe('resolved');

    const taskEvents = await env.DB.prepare(
      `SELECT kind, payload_json FROM events WHERE workspace_id = ? AND kind = 'task_created'`,
    )
      .bind(ws)
      .all<{ kind: string; payload_json: string }>();
    expect(taskEvents.results.length).toBeGreaterThan(0);
    const createdEvent = taskEvents.results[taskEvents.results.length - 1];
    expect(createdEvent.payload_json).toContain('Send Bistro the contract');
    expect(createdEvent.payload_json).toContain('2026-10-20');
    const eventCountAfterResume = taskEvents.results.length;

    // 3b. Redelivery did not duplicate the business event (exactly once).
    const taskEventsAfterReplay = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND kind = 'task_created'`,
    )
      .bind(ws)
      .first<{ n: number }>();
    expect(Number(taskEventsAfterReplay?.n)).toBe(eventCountAfterResume);

    // 3c. Restart dispatch completes the original queued continuation exactly
    // once with no duplicate business effect.
    await releaseWorkspaceLease(env.DB, { workspaceId: ws, attemptId }).catch(() => {});
    const finish = await dispatchWorkspace(env.DB, ws);
    expect(finish.results.some((r) => r.run_id === run.run_id && r.status === 'completed')).toBe(true);
    expect(await runStatus(run.run_id)).toBe('succeeded');
    expect(await replyCount(run.run_id)).toBe(1);
    const taskEventsAfterFinish = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND kind = 'task_created'`,
    )
      .bind(ws)
      .first<{ n: number }>();
    expect(Number(taskEventsAfterFinish?.n)).toBe(eventCountAfterResume);

    // Run is now succeeded (was queued with continuation outbox ready before restart).
    await releaseWorkspaceLease(env.DB, { workspaceId: ws, attemptId }).catch(() => {});
  });

  it('hardened-05: step transitions, additions, and adoptions are rejected if run was stopped or lease lost', async () => {
    // Ensure workspace lease is clear before test
    await env.DB.prepare(`UPDATE workspaces SET lease_owner = NULL, lease_attempt_id = NULL, lease_expires_at = NULL WHERE id = ?`).bind(ws).run();

    const msg = await accept(chatAvi, aviId, 'act-msg-h05', 'stoppable steps');
    const attemptId = 'att-step-stop-h05';
    const nowIso = new Date().toISOString();
    const leaseH05 = await claimWorkspaceLease(env.DB, { workspaceId: ws, attemptId, ttlSeconds: 30, nowIso });
    if (!leaseH05) throw new Error('h05 claim failed');
    const loadedRun = await loadRunById(msg.run_id);
    await pinRun(env.DB, loadedRun, attemptId, leaseH05.fence, nowIso);

    // Plan step 0
    const step0 = await persistStep(env.DB, {
      runId: msg.run_id,
      workspaceId: ws,
      stepIndex: 0,
      toolName: 'my-step',
      args: { test: 'val' },
      attemptId,
      nowIso,
    });
    expect(step0.step.status).toBe('planned');

    // Stop/cancel the run
    await stopRun(env.DB, { workspaceId: ws, runId: msg.run_id, actorUserId: aviId });
    expect(await runStatus(msg.run_id)).toBe('cancelled');

    // 1. Paused handler tries to complete step 0 — must be rejected with StepError
    await expect(
      completeStep(env.DB, step0.step.id, attemptId, {
        resultJson: JSON.stringify({ done: true }),
        nowIso,
      }),
    ).rejects.toThrow(StepError);

    // In DB, step 0 must NOT be succeeded!
    const stepInDb = (await listRunSteps(env.DB, msg.run_id))[0];
    expect(stepInDb.status).toBe('planned');

    // 2. Trying to plan a new step after stop must be rejected with StepError
    await expect(
      persistStep(env.DB, {
        runId: msg.run_id,
        workspaceId: ws,
        stepIndex: 1,
        toolName: 'late-step',
        args: { late: true },
        attemptId,
        nowIso,
      }),
    ).rejects.toThrow(StepError);

    // 3. Trying to adopt a step after stop must be rejected with StepError
    await expect(adoptStep(env.DB, step0.step.id, attemptId, { nowIso })).rejects.toThrow(StepError);
  });

  it('hardened-01b: a stale claimant that lost its lease before pinning cannot steal the run', async () => {
    const msg = await accept(chatAvi, aviId, 'act-msg-h01b', 'stale pin race');
    const run = await loadRunById(msg.run_id);
    const nowIso = new Date().toISOString();
    const attemptA = 'att-pin-stale-a';
    const attemptB = 'att-pin-stale-b';

    // A claims the lease but does not pin yet.
    const leaseA = await claimWorkspaceLease(env.DB, { workspaceId: ws, attemptId: attemptA, ttlSeconds: 30, nowIso });
    if (!leaseA) throw new Error('A claim failed');

    // A's lease expires before it pins; B claims the slot.
    await env.DB.prepare(`UPDATE workspaces SET lease_expires_at = ? WHERE id = ?`)
      .bind('2000-01-01T00:00:00.000Z', ws)
      .run();
    const leaseB = await claimWorkspaceLease(env.DB, { workspaceId: ws, attemptId: attemptB, ttlSeconds: 30 });
    if (!leaseB) throw new Error('B claim failed');

    // A's late pin must fail: A no longer holds the lease even though the run
    // is still queued. B's pin succeeds and owns the run.
    expect(await pinRun(env.DB, run, attemptA, leaseA.fence, new Date().toISOString())).toBe(false);
    expect(await pinRun(env.DB, await loadRunById(msg.run_id), attemptB, leaseB.fence, new Date().toISOString())).toBe(
      true,
    );
    const after = await loadRunById(msg.run_id);
    expect(after.status).toBe('running');
    expect(after.attempt_id).toBe(attemptB);

    // Cleanup.
    await releaseWorkspaceLease(env.DB, { workspaceId: ws, attemptId: attemptB });
    const outboxId = await outboxIdForRun(msg.run_id);
    await env.DB.prepare(`DELETE FROM outbox WHERE id = ?`).bind(outboxId).run();
    await env.DB.prepare(`DELETE FROM run_steps WHERE run_id = ?`).bind(msg.run_id).run();
    await env.DB.prepare(`DELETE FROM agent_runs WHERE id = ?`).bind(msg.run_id).run();
  });

  it('hardened-03b: omitting clarificationId on a multi-question run is ambiguous and resumes nothing', async () => {
    const twoQ: TurnHandler = {
      name: 'two-q-ambiguous',
      async runTurn(ctx) {
        const answered = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM pending_clarifications WHERE run_id = ? AND status = 'resolved'`,
        )
          .bind(ctx.runId)
          .first<{ n: number }>();
        const n = Number(answered?.n ?? 0);
        if (n === 0) return { kind: 'needs_input', question: 'Q1?', intendedOperation: 'op', missingFields: ['a'] };
        return { kind: 'needs_input', question: 'Q2?', intendedOperation: 'op', missingFields: ['b'] };
      },
    };
    const msg = await accept(chatAvi, aviId, 'act-msg-h03b', 'ambiguous resume');
    await dispatchWorkspace(env.DB, ws, { handler: twoQ });
    const q1 = await env.DB.prepare(`SELECT id FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`)
      .bind(msg.run_id)
      .first<{ id: string }>();
    await insertAnswerMessage('msg-ans-h03b-q1', aviId, 'ans-h03b-q1');
    await resumeRun(env.DB, {
      workspaceId: ws,
      runId: msg.run_id,
      answer: { text: 'a1', messageId: 'msg-ans-h03b-q1', clarificationId: q1!.id },
    });
    await dispatchWorkspace(env.DB, ws, { handler: twoQ });
    expect(await runStatus(msg.run_id)).toBe('waiting_for_input');

    // Two total questions now (Q1 resolved, Q2 pending): an answer without an
    // explicit question must not guess and resolve Q2.
    await insertAnswerMessage('msg-ans-h03b-ambig', aviId, 'ans-h03b-ambig');
    const ambiguous = await resumeRun(env.DB, {
      workspaceId: ws,
      runId: msg.run_id,
      answer: { text: 'a1-again', messageId: 'msg-ans-h03b-ambig' },
    });
    expect(ambiguous.resumed).toBe(false);
    const q2 = await env.DB.prepare(`SELECT id, status FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`)
      .bind(msg.run_id)
      .first<{ id: string; status: string }>();
    expect(q2?.status).toBe('pending');
    expect(await runStatus(msg.run_id)).toBe('waiting_for_input');

    // Cleanup: answer Q2 explicitly and finish.
    await insertAnswerMessage('msg-ans-h03b-q2', aviId, 'ans-h03b-q2');
    await resumeRun(env.DB, {
      workspaceId: ws,
      runId: msg.run_id,
      answer: { text: 'a2', messageId: 'msg-ans-h03b-q2', clarificationId: q2!.id },
    });
    const finisher: TurnHandler = {
      name: 'finisher-h03b',
      async runTurn(ctx) {
        return { kind: 'completed', replyText: `done ${ctx.answerText ?? ''}` };
      },
    };
    await dispatchWorkspace(env.DB, ws, { handler: finisher });
    expect(await runStatus(msg.run_id)).toBe('succeeded');
  });

  it('hardened-04b: a stale business revision prevents the coordinated ledger write', async () => {
    const run = await accept(chatAvi, aviId, 'act-msg-h04b', 'stale revision guard');
    const loaded = await loadRunById(run.run_id);
    const nowIso = new Date().toISOString();
    const att = 'att-stale-rev-h04b';
    const lease = await claimWorkspaceLease(env.DB, { workspaceId: ws, attemptId: att, ttlSeconds: 30, nowIso });
    if (!lease) throw new Error('claim failed');
    await pinRun(env.DB, loaded, att, lease.fence, nowIso);
    const wsRow = await env.DB.prepare(`SELECT business_revision, membership_revision FROM workspaces WHERE id = ?`)
      .bind(ws)
      .first<{ business_revision: number; membership_revision: number }>();
    const staleRes = await (
      await import('@otis/ledger')
    ).executeLedgerCommand(
      env.DB,
      {
        workspace_id: ws,
        action_id: `act_${crypto.randomUUID()}`,
        actor: { kind: 'member', user_id: aviId },
        membership_revision: wsRow!.membership_revision,
        expected_business_revision: wsRow!.business_revision,
        source_message_id: loaded.source_message_id!,
        run_id: run.run_id,
        chat_id: chatAvi,
        request_id: `req_${crypto.randomUUID()}`,
        fence: lease.fence,
      },
      'create_task',
      { task_id: `tsk_${crypto.randomUUID()}`, title: 'Stale guard task' },
      (await import('@otis/ledger')).handleCreateTask,
    );
    expect(staleRes.status).toBe('needs_clarification');
    const clar = await env.DB.prepare(`SELECT id FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`)
      .bind(run.run_id)
      .first<{ id: string }>();
    // Advance the workspace revision with an unrelated applied write.
    await env.DB.prepare(`UPDATE workspaces SET business_revision = business_revision + 1, updated_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), ws)
      .run();
    // A resume that expects the pre-advance revision must conflict, not write.
    const eventsBefore = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE workspace_id = ?`)
      .bind(ws)
      .first<{ n: number }>();
    const staleAttempt = await (await import('@otis/ledger')).resumePendingClarification(
      env.DB,
      {
        workspace_id: ws,
        action_id: `act_${crypto.randomUUID()}`,
        actor: { kind: 'member', user_id: aviId },
        membership_revision: wsRow!.membership_revision,
        request_id: `req_${crypto.randomUUID()}`,
        expected_business_revision: wsRow!.business_revision,
        source_message_id: loaded.source_message_id!,
        run_id: run.run_id,
        chat_id: chatAvi,
      },
      { clarification_id: clar!.id, resolved_fields: { due: { kind: 'date', local_date: '2026-10-20', timezone: 'UTC' } } },
    );
    expect(staleAttempt.status).toBe('conflict');
    const eventsAfter = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE workspace_id = ?`)
      .bind(ws)
      .first<{ n: number }>();
    expect(Number(eventsAfter?.n)).toBe(Number(eventsBefore?.n));
    // Cleanup.
    await releaseWorkspaceLease(env.DB, { workspaceId: ws, attemptId: att }).catch(() => {});
    await env.DB.prepare(`UPDATE agent_runs SET status = 'cancelled' WHERE id = ?`).bind(run.run_id).run();
    await env.DB.prepare(`UPDATE pending_clarifications SET status = 'cancelled' WHERE run_id = ?`).bind(run.run_id).run();
    await env.DB.prepare(`UPDATE outbox SET status = 'cancelled' WHERE json_extract(payload_json, '$.run_id') = ?`)
      .bind(run.run_id)
      .run();
  });

  it('hardened-05b: a paused handler that returns after Stop writes no receipt or checkpoint', async () => {
    await env.DB.prepare(`UPDATE workspaces SET lease_owner = NULL, lease_attempt_id = NULL, lease_expires_at = NULL WHERE id = ?`)
      .bind(ws)
      .run();
    const msg = await accept(chatAvi, aviId, 'act-msg-h05b', 'paused then stopped');
    const outboxId = await outboxIdForRun(msg.run_id);
    let releaseHandler: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const pausable: TurnHandler = {
      name: 'pausable-h05b',
      async runTurn() {
        await gate;
        return { kind: 'completed', replyText: 'late reply must never land' };
      },
    };
    const dispatching = dispatchOutboxItem(env.DB, outboxId, ws, { handler: pausable });
    // Wait until the run is pinned and the handler is paused inside the turn.
    while ((await loadRunById(msg.run_id)).status !== 'running') {
      await new Promise((r) => setTimeout(r, 25));
    }
    // Stop the run while the handler is still paused.
    const stopped = await stopRun(env.DB, { workspaceId: ws, runId: msg.run_id, actorUserId: aviId });
    expect(stopped.stopped).toBe(true);
    expect(await runStatus(msg.run_id)).toBe('cancelled');
    // Release the handler; its late completion must be rejected, not recorded.
    releaseHandler();
    const result = await dispatching;
    expect(result.status).toBe('deferred');
    expect(await replyCount(msg.run_id)).toBe(0);
    const steps = await listRunSteps(env.DB, msg.run_id);
    // The turn step may exist as planned/running, but must never be succeeded.
    expect(steps.every((s) => s.status !== 'succeeded')).toBe(true);
    const inbox = await env.DB.prepare(`SELECT status FROM messages_in WHERE id = ?`)
      .bind((await loadRunById(msg.run_id)).source_message_id)
      .first<{ status: string }>();
    expect(inbox?.status).toBe('cancelled');
  });

  it('empty model reply fails honestly without persisting an empty answer', async () => {    const msg = await accept(chatAvi, aviId, 'act-msg-empty-reply', 'say nothing useful');
    const outboxId = await outboxIdForRun(msg.run_id);
    const fake = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [{ kind: 'text', text: '   ' }],
    });
    const handler = new AgentHandler({
      providerAdapter: fake,
      limits: { maxDailyActions: 50, maxRoundsPerRun: 10 },
    });
    const result = await dispatchOutboxItem(env.DB, outboxId, ws, { handler });
    expect(result.status).toBe('failed');
    expect(await runStatus(msg.run_id)).toBe('failed');
    const runRow = await env.DB.prepare(`SELECT error_code, error_message FROM agent_runs WHERE id = ?`)
      .bind(msg.run_id)
      .first<{ error_code: string | null; error_message: string | null }>();
    expect(runRow?.error_code).toBe('empty_response');
    // No reply message, no answer activity: nothing was saved.
    expect(await replyCount(msg.run_id)).toBe(0);
    const answers = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM run_activity WHERE run_id = ? AND type = 'answer_saved'`,
    ).bind(msg.run_id).first<{ n: number }>();
    expect(Number(answers?.n ?? 0)).toBe(0);
  });

  it('partial failure records receipt-backed committed/unfinished copy in its activity', async () => {
    const msg = await accept(chatAvi, aviId, 'act-msg-partial-copy', 'remember this then break');
    const outboxId = await outboxIdForRun(msg.run_id);
    const fake = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [
        {
          kind: 'tool_calls',
          calls: [{
            callId: 'c1',
            name: 'remember_context',
            args: { scope: 'workspace', category: 'other_context', content: 'Partial survival note.' },
          }],
        },
        { kind: 'fail', code: 'transient', message: 'Upstream went away mid-turn.' },
      ],
    });
    const handler = new AgentHandler({
      providerAdapter: fake,
      limits: { maxDailyActions: 50, maxRoundsPerRun: 10 },
    });
    // A planned step left by the dead holder mirrors crash-recovery reality:
    // the summary must name it as unfinished instead of dropping it.
    await env.DB.prepare(
      `INSERT INTO run_steps (id, run_id, workspace_id, step_index, tool_name, arguments_hash, arguments_json, status, created_at, updated_at)
       VALUES (?, ?, ?, 7, 'draft_message', 'h', '{}', 'planned', ?, ?)`,
    ).bind(`step_${msg.run_id}_planned`, msg.run_id, ws, new Date().toISOString(), new Date().toISOString()).run();
    const result = await dispatchOutboxItem(env.DB, outboxId, ws, { handler });
    expect(result.status).toBe('failed');
    expect(await runStatus(msg.run_id)).toBe('partial');
    const payloadRow = await env.DB.prepare(
      `SELECT payload_json FROM run_activity WHERE run_id = ? AND type = 'partial_failure'`,
    ).bind(msg.run_id).first<{ payload_json: string }>();
    const payload = JSON.parse(payloadRow!.payload_json) as {
      error_code: string; committed_actions: number; unfinished_steps: string[];
    };
    expect(payload.error_code).toBe('provider_stream_error');
    expect(payload.committed_actions).toBe(1);
    expect(payload.unfinished_steps).toEqual(['draft_message']);
  });

  it('F08: stop aborts the in-flight provider stream and the run stays cancelled', async () => {    const msg = await accept(chatAvi, aviId, 'act-msg-f08-stop', 'take your time');
    const outboxId = await outboxIdForRun(msg.run_id);
    const fake = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [{ kind: 'hang_until_abort' }],
    });
    const handler = new AgentHandler({
      providerAdapter: fake,
      limits: { maxDailyActions: 50, maxRoundsPerRun: 10 },
    });
    const dispatching = dispatchOutboxItem(env.DB, outboxId, ws, { handler });
    // Wait until the provider turn is hanging inside the stream.
    for (let i = 0; i < 200 && fake.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fake.calls.length).toBeGreaterThan(0);
    // Stop aborts the in-isolate controller and marks the run cancelled.
    const stopped = await stopRun(env.DB, { workspaceId: ws, runId: msg.run_id, actorUserId: aviId });
    expect(stopped.stopped).toBe(true);
    expect(await runStatus(msg.run_id)).toBe('cancelled');
    // The aborted turn settles promptly instead of hanging to the timeout,
    // and the failed outcome cannot overwrite the user's cancellation.
    const result = await dispatching;
    expect(result.status).toBe('deferred');
    expect(await runStatus(msg.run_id)).toBe('cancelled');
    expect(await replyCount(msg.run_id)).toBe(0);
    const runRow = await env.DB.prepare(`SELECT error_code FROM agent_runs WHERE id = ?`)
      .bind(msg.run_id)
      .first<{ error_code: string | null }>();
    expect(runRow?.error_code).toBe('stopped');
  });

  it('hardened-06: a real ledger clarification inside runTurn releases the slot for a teammate', async () => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'member', ?, ?, ?)`,
    )
      .bind(ws, hunorId, new Date().toISOString(), new Date().toISOString(), new Date().toISOString())
      .run();
    const ledgerHandler: TurnHandler = {
      name: 'ledger-missing-date-h06',
      async runTurn(ctx) {
        if (ctx.answerText) {
          return { kind: 'completed', replyText: `Done for ${ctx.answerText}: ${ctx.sourceText}` };
        }
        const wsRow = await env.DB.prepare(
          `SELECT business_revision, membership_revision FROM workspaces WHERE id = ?`,
        )
          .bind(ws)
          .first<{ business_revision: number; membership_revision: number }>();
        const res = await executeLedgerCommand(
          env.DB,
          {
            workspace_id: ws,
            action_id: `act_${ctx.runId}_task`,
            actor: { kind: 'member', user_id: aviId },
            membership_revision: Number(wsRow?.membership_revision ?? 0),
            expected_business_revision: Number(wsRow?.business_revision ?? 0),
            source_message_id: ctx.sourceMessageId!,
            run_id: ctx.runId,
            chat_id: ctx.chatId,
            request_id: `req_${ctx.runId}_${ctx.attemptId}`,
            fence: ctx.fence,
          },
          'create_task',
          { task_id: `tsk_${ctx.runId}`, title: `Bistro contract ${ctx.runId}` },
          handleCreateTask,
          undefined,
          { deferRunTransition: true },
        );
        if (res.status === 'needs_clarification') {
          return {
            kind: 'needs_input',
            question: res.clarification?.prompt ?? 'Which date?',
            intendedOperation: 'create_task',
            missingFields: res.clarification?.missing_fields ?? ['due'],
          };
        }
        if (res.status === 'applied' || res.status === 'already_applied') {
          return { kind: 'completed', replyText: `Done: ${ctx.sourceText}` };
        }
        return { kind: 'failed', errorCode: 'ledger', errorMessage: res.error?.message ?? 'ledger failed' };
      },
    };

    const aviMsg = await accept(chatAvi, aviId, 'act-msg-h06', 'Bistro contract without date');
    const aviOutbox = await outboxIdForRun(aviMsg.run_id);
    const first = await dispatchOutboxItem(env.DB, aviOutbox, ws, { handler: ledgerHandler });
    expect(first.status).toBe('waiting_for_input');
    expect(await runStatus(aviMsg.run_id)).toBe('waiting_for_input');
    // Slot released: no lease, dispatch intent completed, inbox waiting.
    expect(await getWorkspaceLease(env.DB, ws)).toBeNull();
    const aviOut = await env.DB.prepare(`SELECT status FROM outbox WHERE id = ?`).bind(aviOutbox).first<{ status: string }>();
    expect(aviOut?.status).toBe('delivered');
    const aviInbox = await env.DB.prepare(`SELECT status FROM messages_in WHERE id = ?`)
      .bind((await loadRunById(aviMsg.run_id)).source_message_id)
      .first<{ status: string }>();
    expect(aviInbox?.status).toBe('waiting_for_input');
    const clar = await env.DB.prepare(
      `SELECT id, operation_payload_json FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`,
    )
      .bind(aviMsg.run_id)
      .first<{ id: string; operation_payload_json: string }>();
    expect(clar?.operation_payload_json).toContain('create_task');

    // Hunor proceeds immediately with no manual lease release.
    const hunorMsg = await accept(chatHunor, hunorId, 'act-msg-h06b', 'hunor quick note');
    const hunorOutbox = await outboxIdForRun(hunorMsg.run_id);
    const hunorRes = await dispatchOutboxItem(env.DB, hunorOutbox, ws);
    expect(hunorRes.status).toBe('completed');
    expect(await runStatus(hunorMsg.run_id)).toBe('succeeded');

    // Answer Avi and complete exactly once.
    await insertAnswerMessage('msg-ans-h06', aviId, 'ans-h06');
    const resumed = await resumeRun(env.DB, {
      workspaceId: ws,
      runId: aviMsg.run_id,
      answer: {
        text: '2026-10-20',
        messageId: 'msg-ans-h06',
        clarificationId: clar!.id,
        resolvedFields: { due: { kind: 'date', local_date: '2026-10-20', timezone: 'UTC' } },
      },
    });
    expect(resumed.resumed).toBe(true);
    const second = await dispatchOutboxItem(env.DB, await outboxIdForRun(aviMsg.run_id), ws, { handler: ledgerHandler });
    expect(second.status).toBe('completed');
    expect(await runStatus(aviMsg.run_id)).toBe('succeeded');
    const tasks = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ? AND title LIKE 'Bistro contract%'`)
      .bind(ws)
      .first<{ n: number }>();
    expect(Number(tasks?.n)).toBe(1);
  });

  it('hardened-07a: a stale dispatcher paused before pin cannot reset its successor outbox', async () => {
    const msg = await accept(chatAvi, aviId, 'act-msg-h07a', 'pre-pin ownership');
    const outboxId = await outboxIdForRun(msg.run_id);
    let releaseA: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      void resolve;
    });
    let enteredResolve: () => void = () => {};
    const enteredGate = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const pausedGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    void entered;
    const dispatchA = dispatchOutboxItem(env.DB, outboxId, ws, {
      handler: { name: 'echo-h07a', async runTurn() { return { kind: 'completed', replyText: 'A late' }; } },
      testHooks: {
        beforePin: async () => {
          enteredResolve();
          await pausedGate;
        },
      },
    });
    await enteredGate;
    // Force A's claim stale so recovery can reset it, then let B take over.
    await env.DB.prepare(`UPDATE workspaces SET lease_expires_at = ? WHERE id = ?`)
      .bind('2000-01-01T00:00:00.000Z', ws)
      .run();
    await env.DB.prepare(`UPDATE outbox SET last_attempt_at = ? WHERE id = ?`)
      .bind('2000-01-01T00:00:00.000Z', outboxId)
      .run();
    await recoverWorkspace(env.DB, ws);
    const bRes = await dispatchWorkspace(env.DB, ws);
    expect(bRes.results.some((r) => r.run_id === msg.run_id && r.status === 'completed')).toBe(true);
    const bOutbox = await env.DB.prepare(`SELECT status, attempt_count, claimed_by FROM outbox WHERE id = ?`)
      .bind(outboxId)
      .first<{ status: string; attempt_count: number; claimed_by: string | null }>();
    releaseA();
    const aRes = await dispatchA;
    expect(aRes.status).toBe('deferred');
    const after = await env.DB.prepare(`SELECT status, attempt_count, claimed_by FROM outbox WHERE id = ?`)
      .bind(outboxId)
      .first<{ status: string; attempt_count: number; claimed_by: string | null }>();
    expect(after?.status).toBe(bOutbox?.status);
    expect(Number(after?.attempt_count)).toBe(Number(bOutbox?.attempt_count));
    expect(after?.claimed_by).toBe(bOutbox?.claimed_by);
    expect(await runStatus(msg.run_id)).toBe('succeeded');
  });

  it('hardened-07b: a stale dispatcher paused before count cannot inflate its successor budget', async () => {
    const msg = await accept(chatAvi, aviId, 'act-msg-h07b', 'post-pin ownership');
    const outboxId = await outboxIdForRun(msg.run_id);
    let releaseA: () => void = () => {};
    const pausedGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let enteredResolve: () => void = () => {};
    const enteredGate = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const dispatchA = dispatchOutboxItem(env.DB, outboxId, ws, {
      handler: { name: 'echo-h07b', async runTurn() { return { kind: 'completed', replyText: 'A late' }; } },
      testHooks: {
        beforeIncrement: async () => {
          enteredResolve();
          await pausedGate;
        },
      },
    });
    await enteredGate;
    // A has pinned (run running with A). Expire its lease so recovery requeues
    // and B takes over the same intent.
    await env.DB.prepare(`UPDATE workspaces SET lease_expires_at = ? WHERE id = ?`)
      .bind('2000-01-01T00:00:00.000Z', ws)
      .run();
    await recoverWorkspace(env.DB, ws);
    const bRes = await dispatchWorkspace(env.DB, ws);
    expect(bRes.results.some((r) => r.run_id === msg.run_id && r.status === 'completed')).toBe(true);
    const bOutbox = await env.DB.prepare(`SELECT status, attempt_count, claimed_by FROM outbox WHERE id = ?`)
      .bind(outboxId)
      .first<{ status: string; attempt_count: number; claimed_by: string | null }>();
    releaseA();
    const aRes = await dispatchA;
    expect(aRes.status).toBe('deferred');
    const after = await env.DB.prepare(`SELECT status, attempt_count, claimed_by FROM outbox WHERE id = ?`)
      .bind(outboxId)
      .first<{ status: string; attempt_count: number; claimed_by: string | null }>();
    expect(after?.status).toBe(bOutbox?.status);
    expect(Number(after?.attempt_count)).toBe(Number(bOutbox?.attempt_count));
    expect(await runStatus(msg.run_id)).toBe('succeeded');
  });

  it('hardened-08: clarification answers require derived provenance and transactional recheck', async () => {
    // Re-add Hunor (earlier revocation test removed him) for provenance checks.
    const nowIso = new Date().toISOString();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'member', ?, ?, ?)`,
    )
      .bind(ws, hunorId, nowIso, nowIso, nowIso)
      .run();
    const ask: TurnHandler = {
      name: 'ask-h08',
      async runTurn() {
        return { kind: 'needs_input', question: 'Q?', intendedOperation: 'op', missingFields: ['a'] };
      },
    };
    const msg = await accept(chatAvi, aviId, 'act-msg-h08', 'provenance question');
    await dispatchWorkspace(env.DB, ws, { handler: ask });
    const clar = await env.DB.prepare(`SELECT id FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`)
      .bind(msg.run_id)
      .first<{ id: string }>();
    await insertAnswerMessage('msg-ans-h08-avi', aviId, 'ans-h08-avi');
    await insertAnswerMessage('msg-ans-h08-hunor', hunorId, 'ans-h08-hunor');

    // Another member cannot answer the requester's question.
    expect(
      await resumeRun(env.DB, {
        workspaceId: ws,
        runId: msg.run_id,
        answer: { text: 'x', messageId: 'msg-ans-h08-hunor', clarificationId: clar!.id },
      }),
    ).toEqual({ resumed: false, failureReason: 'answer_invalid' });

    // Missing or unknown sources are rejected.
    expect(
      await resumeRun(env.DB, { workspaceId: ws, runId: msg.run_id, answer: { text: 'x', clarificationId: clar!.id } }),
    ).toEqual({ resumed: false, failureReason: 'answer_invalid' });
    expect(
      await resumeRun(env.DB, {
        workspaceId: ws,
        runId: msg.run_id,
        answer: { text: 'x', messageId: 'msg-missing-h08', clarificationId: clar!.id },
      }),
    ).toEqual({ resumed: false, failureReason: 'answer_invalid' });

    // Claimed author must match the derived source author.
    expect(
      await resumeRun(env.DB, {
        workspaceId: ws,
        runId: msg.run_id,
        answer: { text: 'x', messageId: 'msg-ans-h08-avi', clarificationId: clar!.id, authorUserId: hunorId },
      }),
    ).toEqual({ resumed: false, failureReason: 'answer_invalid' });

    // Removal after the pre-check still fails the committing guard.
    const hunorMsg = await accept(chatHunor, hunorId, 'act-msg-h08b', 'hunor question');
    await dispatchWorkspace(env.DB, ws, { handler: ask });
    const hunorClar = await env.DB.prepare(`SELECT id FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`)
      .bind(hunorMsg.run_id)
      .first<{ id: string }>();
    await insertAnswerMessage('msg-ans-h08b-hunor', hunorId, 'ans-h08b-hunor');
    const removed = await resumeRun(env.DB, {
      workspaceId: ws,
      runId: hunorMsg.run_id,
      answer: { text: 'y', messageId: 'msg-ans-h08b-hunor', clarificationId: hunorClar!.id },
      testHooks: {
        afterPrecheck: async () => {
          await removeMember(env.DB, { workspaceId: ws, actorUserId: aviId, targetUserId: hunorId });
        },
      },
    });
    expect(removed.resumed).toBe(false);
    const stillPending = await env.DB.prepare(`SELECT status FROM pending_clarifications WHERE id = ?`)
      .bind(hunorClar!.id)
      .first<{ status: string }>();
    expect(stillPending?.status).toBe('pending');

    // Valid Avi answer still succeeds.
    expect(
      await resumeRun(env.DB, {
        workspaceId: ws,
        runId: msg.run_id,
        answer: { text: 'ok', messageId: 'msg-ans-h08-avi', clarificationId: clar!.id },
      }),
    ).toMatchObject({ resumed: true });
  });

  it('hardened-09: a stale attempt cannot commit a ledger business write first', async () => {
    const revBefore =
      (
        await env.DB.prepare(`SELECT business_revision FROM workspaces WHERE id = ?`)
          .bind(ws)
          .first<{ business_revision: number }>()
      )?.business_revision ?? 0;
    const msg = await accept(chatAvi, aviId, 'act-msg-h09', 'fenced business write');
    const outboxId = await outboxIdForRun(msg.run_id);
    const actionId = `act_${msg.run_id}_fenced`;
    const taskId = `tsk_${msg.run_id}_fenced`;

    let aLedgerStatus: string | null = null;
    let aLedgerCode: string | null = null;
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let enteredA: () => void = () => {};
    const enteredAGate = new Promise<void>((resolve) => {
      enteredA = resolve;
    });
    let releaseB: () => void = () => {};
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let enteredB: () => void = () => {};
    const enteredBGate = new Promise<void>((resolve) => {
      enteredB = resolve;
    });

    // A pauses before its ledger mutation, presenting its originally claimed
    // fence. It must not read B's fence as its own authority.
    const fencedWriter: TurnHandler = {
      name: 'fenced-writer-h09',
      async runTurn(ctx) {
        const wsRow = await env.DB.prepare(
          `SELECT business_revision, membership_revision FROM workspaces WHERE id = ?`,
        )
          .bind(ws)
          .first<{ business_revision: number; membership_revision: number }>();
        enteredA();
        await gateA;
        const res = await executeLedgerCommand(
          env.DB,
          {
            workspace_id: ws,
            action_id: actionId,
            actor: { kind: 'member', user_id: aviId },
            membership_revision: Number(wsRow?.membership_revision ?? 0),
            expected_business_revision: Number(wsRow?.business_revision ?? 0),
            source_message_id: ctx.sourceMessageId!,
            run_id: ctx.runId,
            chat_id: ctx.chatId,
            request_id: `req_${ctx.runId}_${ctx.attemptId}`,
            fence: ctx.fence,
          },
          'create_task',
          {
            task_id: taskId,
            title: `Fenced write ${msg.run_id}`,
            due: { kind: 'date', local_date: '2026-10-20', timezone: 'UTC' },
          },
          handleCreateTask,
        );
        aLedgerStatus = res.status;
        aLedgerCode = res.error?.code ?? null;
        if (res.status === 'applied' || res.status === 'already_applied') {
          return { kind: 'completed', replyText: `A wrote: ${ctx.sourceText}` };
        }
        return { kind: 'failed', errorCode: aLedgerCode ?? 'ledger_conflict', errorMessage: res.error?.message ?? 'stale' };
      },
    };
    const pausingEcho: TurnHandler = {
      name: 'pausing-echo-h09',
      async runTurn(ctx) {
        enteredB();
        await gateB;
        return { kind: 'completed', replyText: `Echo: ${ctx.sourceText}` };
      },
    };

    const dispatchA = dispatchOutboxItem(env.DB, outboxId, ws, { handler: fencedWriter });
    await waitFor('A to reach its ledger mutation', async () => {
      // Pinned and inside the handler: step exists and gate entered.
      const run = await loadRunById(msg.run_id).catch(() => null);
      return run?.status === 'running';
    });
    await enteredAGate;

    // A's lease expires; recovery hands the same run/intent to B, advancing
    // the workspace fence. B pins and pauses inside its own turn while the
    // run is still active, so only the fence distinguishes A's late write.
    await env.DB.prepare(`UPDATE workspaces SET lease_expires_at = ? WHERE id = ?`)
      .bind('2000-01-01T00:00:00.000Z', ws)
      .run();
    await recoverWorkspace(env.DB, ws);
    const dispatchB = dispatchOutboxItem(env.DB, outboxId, ws, { handler: pausingEcho });
    await enteredBGate;
    expect(await runStatus(msg.run_id)).toBe('running');

    // A resumes with its original fence against B's live lease.
    releaseA();
    const aRes = await dispatchA;
    expect(aRes.status).toBe('deferred');
    expect(aLedgerStatus).toBe('conflict');
    expect(aLedgerCode).toBe('fence_conflict');

    // A committed nothing: no event, no task, no receipt, no revision move.
    const aEvents = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND action_id = ?`)
      .bind(ws, actionId)
      .first<{ n: number }>();
    expect(Number(aEvents?.n ?? -1)).toBe(0);
    const aTask = await env.DB.prepare(`SELECT id FROM tasks WHERE workspace_id = ? AND id = ?`)
      .bind(ws, taskId)
      .first();
    expect(aTask).toBeNull();
    const aReceipt = await env.DB.prepare(`SELECT id FROM action_receipts WHERE workspace_id = ? AND action_id = ?`)
      .bind(ws, actionId)
      .first();
    expect(aReceipt).toBeNull();

    // B completes the same turn exactly once.
    releaseB();
    const bRes = await dispatchB;
    expect(bRes.status).toBe('completed');
    expect(await runStatus(msg.run_id)).toBe('succeeded');
    expect(await replyCount(msg.run_id)).toBe(1);
    const revAfter =
      (
        await env.DB.prepare(`SELECT business_revision FROM workspaces WHERE id = ?`)
          .bind(ws)
          .first<{ business_revision: number }>()
      )?.business_revision ?? -1;
    expect(revAfter).toBe(revBefore);
  });

  it('hardened-10: a stale attempt cannot commit after recovery clears the lease, before B claims', async () => {
    const revBefore =
      (
        await env.DB.prepare(`SELECT business_revision FROM workspaces WHERE id = ?`)
          .bind(ws)
          .first<{ business_revision: number }>()
      )?.business_revision ?? 0;
    const msg = await accept(chatAvi, aviId, 'act-msg-h10', 'cleared lease window');
    const outboxId = await outboxIdForRun(msg.run_id);
    const actionId = `act_${msg.run_id}_cleared`;
    const taskId = `tsk_${msg.run_id}_cleared`;

    let aLedgerStatus: string | null = null;
    let aLedgerCode: string | null = null;
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let enteredA: () => void = () => {};
    const enteredAGate = new Promise<void>((resolve) => {
      enteredA = resolve;
    });

    // A pauses before its ledger mutation, presenting its original fence.
    const fencedWriter: TurnHandler = {
      name: 'fenced-writer-h10',
      async runTurn(ctx) {
        const wsRow = await env.DB.prepare(
          `SELECT business_revision, membership_revision FROM workspaces WHERE id = ?`,
        )
          .bind(ws)
          .first<{ business_revision: number; membership_revision: number }>();
        enteredA();
        await gateA;
        const res = await executeLedgerCommand(
          env.DB,
          {
            workspace_id: ws,
            action_id: actionId,
            actor: { kind: 'member', user_id: aviId },
            membership_revision: Number(wsRow?.membership_revision ?? 0),
            expected_business_revision: Number(wsRow?.business_revision ?? 0),
            source_message_id: ctx.sourceMessageId!,
            run_id: ctx.runId,
            chat_id: ctx.chatId,
            request_id: `req_${ctx.runId}_${ctx.attemptId}`,
            fence: ctx.fence,
          },
          'create_task',
          {
            task_id: taskId,
            title: `Cleared window ${msg.run_id}`,
            due: { kind: 'date', local_date: '2026-10-20', timezone: 'UTC' },
          },
          handleCreateTask,
        );
        aLedgerStatus = res.status;
        aLedgerCode = res.error?.code ?? null;
        return { kind: 'failed', errorCode: aLedgerCode ?? 'ledger_conflict', errorMessage: res.error?.message ?? 'stale' };
      },
    };

    const dispatchA = dispatchOutboxItem(env.DB, outboxId, ws, { handler: fencedWriter });
    await waitFor('A to reach its ledger mutation', async () => {
      const run = await loadRunById(msg.run_id).catch(() => null);
      return run?.status === 'running';
    });
    await enteredAGate;

    // A's lease expires; recovery requeues the run and clears the lease
    // entirely (NULL owner/attempt/expiry, fence unchanged). No successor
    // has claimed yet: the cleared-lease window is open.
    await env.DB.prepare(`UPDATE workspaces SET lease_expires_at = ? WHERE id = ?`)
      .bind('2000-01-01T00:00:00.000Z', ws)
      .run();
    await recoverWorkspace(env.DB, ws);
    expect(await runStatus(msg.run_id)).toBe('queued');
    expect(await getWorkspaceLease(env.DB, ws)).toBeNull();

    // A resumes with its original fence into the cleared window. The fence
    // value still matches, but no live lease exists, so the write must fail.
    releaseA();
    const aRes = await dispatchA;
    expect(aRes.status).toBe('deferred');
    expect(aLedgerStatus).toBe('conflict');
    expect(aLedgerCode).toBe('fence_conflict');

    // A committed nothing: no event, no task, no receipt, no revision move.
    const aEvents = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND action_id = ?`)
      .bind(ws, actionId)
      .first<{ n: number }>();
    expect(Number(aEvents?.n ?? -1)).toBe(0);
    expect(await env.DB.prepare(`SELECT id FROM tasks WHERE workspace_id = ? AND id = ?`).bind(ws, taskId).first()).toBeNull();
    expect(
      await env.DB.prepare(`SELECT id FROM action_receipts WHERE workspace_id = ? AND action_id = ?`).bind(ws, actionId).first(),
    ).toBeNull();

    // B then finishes the same turn exactly once.
    const bRes = await dispatchWorkspace(env.DB, ws);
    expect(bRes.results.some((r) => r.run_id === msg.run_id && r.status === 'completed')).toBe(true);
    expect(await runStatus(msg.run_id)).toBe('succeeded');
    expect(await replyCount(msg.run_id)).toBe(1);
    const revAfter =
      (
        await env.DB.prepare(`SELECT business_revision FROM workspaces WHERE id = ?`)
          .bind(ws)
          .first<{ business_revision: number }>()
      )?.business_revision ?? -1;
    expect(revAfter).toBe(revBefore);
  });
});
