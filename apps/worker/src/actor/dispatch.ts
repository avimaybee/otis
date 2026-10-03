import { resolveDateAnswer } from './clarificationFields.js';
/**
 * @otis/worker/actor/dispatch
 * Durable workspace dispatch with leases, step receipts, checkpoints, and
 * recovery (Gate 004B).
 *
 * D1 is authoritative; in-memory state is only an optimization. One workspace
 * runs at most one mutating turn at a time (D1 lease + fencing). A run that
 * waits for human clarification releases the slot. Every commit re-verifies
 * run status, attempt, fence, lease ownership/expiry, and actor membership in
 * its own transaction, so a stale holder can never commit a business effect.
 *
 * Until the agent gate lands, turns execute through a deterministic handler
 * (echo). The lease/step/outbox protocol is handler-agnostic.
 */

import { claimWorkspaceLease, releaseWorkspaceLease, renewWorkspaceLease } from './leases.js';
import {
  adoptStep,
  completeStep,
  listRunSteps,
  markStepRunning,
  persistStep,
  StepError,
} from './steps.js';
import { resumePendingClarification } from '@otis/ledger';

export type ActorErrorCode =
  | 'lease_unavailable'
  | 'stale_lease'
  | 'run_inactive'
  | 'run_not_found'
  | 'not_member'
  | 'already_terminal'
  | 'contended'
  | 'poison'
  | 'invalid_payload';

export class ActorError extends Error {
  public readonly code: ActorErrorCode;

  constructor(code: ActorErrorCode, message: string) {
    super(message);
    this.name = 'ActorError';
    this.code = code;
  }
}

export type TurnOutcome =
  | { kind: 'completed'; replyText: string }
  | {
      kind: 'needs_input';
      question: string;
      intendedOperation: string;
      missingFields: string[];
      candidates?: unknown;
      pendingOperation?: unknown;
    }
  | { kind: 'continuation'; progressJson: string }
  | { kind: 'failed'; errorCode: string; errorMessage: string };

export interface TurnContext {
  db: D1Database;
  workspaceId: string;
  runId: string;
  /** The attempt executing this turn; receipts are stamped with it. */
  attemptId: string;
  /**
   * Fence claimed by this dispatch. Ledger mutations scoped to this run must
   * present it; the ledger guard validates it in the committing transaction.
   */
  fence: number;
  chatId: string;
  sourceMessageId: string | null;
  sourceJobId: string | null;
  sourceText: string;
  channel: string;
  sourceTrust?: 'member' | 'forwarded_client' | 'memory';
  /** Durable answer from the resolved clarification, if this turn resumes one. */
  answerText: string | null;
  answerMessageId: string | null;
}

export interface TurnHandler {
  readonly name: string;
  runTurn(ctx: TurnContext): Promise<TurnOutcome>;
}

/** Deterministic turn executor used until the agent gate lands. No model, no business writes. */
export const EchoHandler: TurnHandler = {
  name: 'echo',
  async runTurn(ctx: TurnContext): Promise<TurnOutcome> {
    return { kind: 'completed', replyText: `Echo: ${ctx.sourceText}` };
  },
};

export interface DispatchOptions {
  handler?: TurnHandler;
  /** Max outbox attempts before a run is declared poison. */
  maxAttempts?: number;
  leaseTtlSeconds?: number;
  nowIso?: string;
  /** Clock source; tests advance it to prove TTL enforcement mid-turn. */
  clock?: () => string;
  /**
   * Test-only pause points to prove stale dispatchers cannot touch a
   * successor's intent. Never set in production.
   */
  testHooks?: {
    beforePin?: (info: { attemptId: string; outboxId: string }) => Promise<void>;
    beforeIncrement?: (info: { attemptId: string; outboxId: string }) => Promise<void>;
  };
}

export interface ResumeAnswer {
  text: string;
  messageId?: string | null;
  clarificationId?: string | null;
  authorUserId?: string | null;
  resolvedFields?: Record<string, unknown>;
}

export interface ResumeRunResult {
  resumed: boolean;
  replay?: boolean;
  clarificationId?: string | null;
}

export interface DispatchResult {
  status:
    | 'completed'
    | 'waiting_for_input'
    | 'failed'
    | 'deferred'
    | 'contended'
    | 'already_done'
    | 'not_found';
  run_id: string | null;
  detail?: string;
}

export interface LoadedRun {
  id: string;
  workspace_id: string;
  chat_id: string;
  source_message_id: string | null;
  source_job_id: string | null;
  status: string;
  attempt_id: string | null;
  lease_fence: number;
}

async function loadRun(db: D1Database, workspaceId: string, runId: string): Promise<LoadedRun | null> {
  const row = await db
    .prepare(
      `SELECT id, workspace_id, chat_id, source_message_id, source_job_id, status, attempt_id, lease_fence
       FROM agent_runs WHERE id = ? AND workspace_id = ?`,
    )
    .bind(runId, workspaceId)
    .first<Record<string, unknown>>();
  if (!row) return null;
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

function isTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'partial' || status === 'failed' || status === 'cancelled';
}

/** Fresh clock per operation (P0-2): a stale fixed timestamp can never pass a live expiry check. */
function makeNow(options: DispatchOptions): () => string {
  if (options.clock) return options.clock;
  if (options.nowIso) {
    const fixed = options.nowIso;
    return () => fixed;
  }
  return () => new Date().toISOString();
}

/**
 * Clarification consumption state. A recorded needs_input outcome is only
 * spent when a clarification was resolved and none is pending: sequential
 * questions (Q1 answered, Q2 pending) must not be collapsed.
 */
async function clarificationState(
  db: D1Database,
  runId: string,
): Promise<{ hasResolved: boolean; hasPending: boolean }> {
  const row = await db
    .prepare(
      `SELECT
         EXISTS(SELECT 1 FROM pending_clarifications WHERE run_id = ? AND status = 'resolved') AS has_resolved,
         EXISTS(SELECT 1 FROM pending_clarifications WHERE run_id = ? AND status = 'pending') AS has_pending`,
    )
    .bind(runId, runId)
    .first<{ has_resolved: number; has_pending: number }>();
  return {
    hasResolved: Number(row?.has_resolved ?? 0) === 1,
    hasPending: Number(row?.has_pending ?? 0) === 1,
  };
}

/** True while this attempt still owns a live lease on its running run. */
async function holderStillOwns(
  db: D1Database,
  runId: string,
  attemptId: string,
  nowIso: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok
       FROM agent_runs r
       JOIN workspaces w ON w.id = r.workspace_id
       WHERE r.id = ? AND r.status = 'running' AND r.attempt_id = ?
         AND w.lease_owner = ? AND w.lease_attempt_id = ? AND w.lease_expires_at > ?`,
    )
    .bind(runId, attemptId, attemptId, attemptId, nowIso)
    .first();
  return row !== null;
}

/**
 * Requeues a run for retry, but only while this attempt still owns it.
 * Returns false (touching nothing) when a successor holds the run.
 */
export async function requeueAsHolder(
  db: D1Database,
  params: { workspaceId: string; runId: string; attemptId: string; outboxId: string; nowIso: string },
): Promise<boolean> {
  const guard = `(SELECT 1 FROM agent_runs WHERE id = ? AND status = 'running' AND attempt_id = ?)`;
  try {
    await db.batch([
      db
        .prepare(`INSERT INTO acceptance_guards (id, guard_ok) VALUES (?, ${guard})`)
        .bind(`guard_${crypto.randomUUID()}`, params.runId, params.attemptId),
      db
        .prepare(
          `UPDATE agent_runs SET status = 'queued', updated_at = ?
           WHERE id = ? AND status = 'running' AND attempt_id = ?`,
        )
        .bind(params.nowIso, params.runId, params.attemptId),
      db
        .prepare(
          `UPDATE outbox SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'sending'
           AND (claimed_by IS NULL OR claimed_by = ?)`,
        )
        .bind(params.nowIso, params.outboxId, params.attemptId),
      db
        .prepare(`UPDATE messages_in SET status = 'queued', updated_at = ? WHERE id = (SELECT source_message_id FROM agent_runs WHERE id = ?)`)
        .bind(params.nowIso, params.runId),
      db
        .prepare(
          `UPDATE workspaces SET lease_owner = NULL, lease_attempt_id = NULL, lease_expires_at = NULL
           WHERE id = ? AND lease_owner = ? AND lease_attempt_id = ?`,
        )
        .bind(params.workspaceId, params.attemptId, params.attemptId),
    ]);
    return true;
  } catch (err) {
    if (isGuardFailure(err)) return false;
    throw err;
  }
}

function isGuardFailure(err: unknown): boolean {
  const s = String(err);
  return s.includes('SQLITE_CONSTRAINT') || s.includes('guard_ok') || s.includes('PRIMARY KEY');
}

async function resolveRunActor(db: D1Database, run: LoadedRun): Promise<string | null> {
  if (run.source_message_id) {
    const row = await db
      .prepare(`SELECT user_id FROM messages_in WHERE id = ?`)
      .bind(run.source_message_id)
      .first<{ user_id: string | null }>();
    return row?.user_id ?? null;
  }
  return null;
}

async function loadSourceText(db: D1Database, run: LoadedRun): Promise<{ text: string; channel: string; sourceTrust?: 'member' | 'forwarded_client' | 'memory' }> {
  if (!run.source_message_id) return { text: '', channel: 'system', sourceTrust: 'member' };
  const row = await db
    .prepare(
      `SELECT content_text, channel, author_kind FROM chat_messages
       WHERE run_id = ? ORDER BY sequence ASC LIMIT 1`,
    )
    .bind(run.id)
    .first<Record<string, unknown>>();
  if (!row) return { text: '', channel: 'web', sourceTrust: 'member' };
  const authorKind = row['author_kind'];
  const sourceTrust: 'member' | 'forwarded_client' | 'memory' = authorKind === 'member' ? 'member' : 'forwarded_client';
  return { text: String(row['content_text'] ?? ''), channel: String(row['channel'] ?? 'web'), sourceTrust };
}

/**
 * Pins a queued run to an attempt: conditional transition plus fence stamp.
 * The pin is atomic with step adoption and inbox marking, and it verifies
 * the caller still holds the workspace lease (owner/fence/expiry) so a
 * stale claimant that lost its lease between claim and pin cannot steal the
 * run from its successor. Returns false when the run is no longer queued
 * or the lease is no longer held (lost race).
 */
export async function pinRun(
  db: D1Database,
  run: LoadedRun,
  attemptId: string,
  fence: number,
  nowIso: string,
): Promise<boolean> {
  const guard = `(SELECT 1 FROM agent_runs r
    JOIN workspaces w ON w.id = r.workspace_id
    WHERE r.id = ? AND r.status = 'queued'
      AND w.id = ? AND w.lease_owner = ? AND w.lease_attempt_id = ?
      AND w.lease_fence = ? AND w.lease_expires_at > ?)`;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(`INSERT INTO acceptance_guards (id, guard_ok) VALUES (?, ${guard})`)
      .bind(`guard_${crypto.randomUUID()}`, run.id, run.workspace_id, attemptId, attemptId, fence, nowIso),
    db
      .prepare(
        `UPDATE agent_runs SET status = 'running', attempt_id = ?, lease_fence = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .bind(attemptId, fence, nowIso, run.id),
    db
      .prepare(
        `UPDATE run_steps SET attempt_id = ?, updated_at = ?
         WHERE run_id = ? AND status IN ('planned', 'running')`,
      )
      .bind(attemptId, nowIso, run.id),
  ];
  if (run.source_message_id) {
    statements.push(
      db
        .prepare(`UPDATE messages_in SET status = 'processing', updated_at = ? WHERE id = ?`)
        .bind(nowIso, run.source_message_id),
    );
  }
  try {
    await db.batch(statements);
    return true;
  } catch (err) {
    if (isGuardFailure(err)) return false;
    throw err;
  }
}

/** Guard fragment verifying the holder still owns the lease, fence, run, and membership. */
function holderGuardSql(): string {
  return `(
    SELECT 1
    FROM agent_runs r
    JOIN workspaces w ON w.id = r.workspace_id
    LEFT JOIN messages_in m ON m.id = r.source_message_id
    LEFT JOIN system_jobs j ON j.id = r.source_job_id
    WHERE r.id = ? AND r.status = 'running' AND r.attempt_id = ? AND r.lease_fence = ?
      AND w.lease_fence = ? AND w.lease_owner = ? AND w.lease_attempt_id = ?
      AND w.lease_expires_at > ?
      AND (
        (r.source_message_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM workspace_users wu
          WHERE wu.workspace_id = r.workspace_id AND wu.user_id = m.user_id
        ))
        OR (r.source_job_id IS NOT NULL AND j.status IN ('pending', 'running'))
      )
  )`;
}

async function appendActivity(
  batch: D1PreparedStatement[],
  db: D1Database,
  params: {
    workspaceId: string;
    chatId: string;
    runId: string;
    cursorSelect: string;
    type: string;
    payload: unknown;
    nowIso: string;
  },
): Promise<void> {
  batch.push(
    db
      .prepare(
        `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ${params.cursorSelect}, ?, ?, ?)`,
      )
      .bind(
        `act_${crypto.randomUUID()}`,
        params.workspaceId,
        params.chatId,
        params.runId,
        params.chatId,
        params.type,
        JSON.stringify(params.payload),
        params.nowIso,
      ),
  );
}

/**
 * Fenced completion: system reply, activity, processed markers, outbox
 * delivery, and lease release commit atomically — or nothing commits.
 */
export async function completeRun(
  db: D1Database,
  params: {
    run: LoadedRun;
    attemptId: string;
    fence: number;
    replyText: string;
    channel: string;
    outboxId: string | null;
    nowIso: string;
  },
): Promise<void> {
  const { run } = params;
  const replyId = `reply_${run.id}`;

  const seqRow = await db
    .prepare(`SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM chat_messages WHERE chat_id = ?`)
    .bind(run.chat_id)
    .first<{ max_seq: number }>();
  const nextSeq = (seqRow?.max_seq || 0) + 1;

  const batch: D1PreparedStatement[] = [
    db
      .prepare(`INSERT INTO acceptance_guards (id, guard_ok) VALUES (?, ${holderGuardSql()})`)
      .bind(
        `guard_${crypto.randomUUID()}`,
        run.id,
        params.attemptId,
        params.fence,
        params.fence,
        params.attemptId,
        params.attemptId,
        params.nowIso,
      ),
    db.prepare(`UPDATE agent_runs SET status = 'succeeded', updated_at = ? WHERE id = ?`).bind(params.nowIso, run.id),
    db
      .prepare(`UPDATE chats SET activity_cursor = activity_cursor + 2, last_activity_at = ?, updated_at = ? WHERE id = ?`)
      .bind(params.nowIso, params.nowIso, run.chat_id),
    db
      .prepare(
        `INSERT INTO chat_messages (id, workspace_id, chat_id, author_user_id, author_kind, channel, inbound_message_id, client_message_id, content_text, media_id, run_id, sequence, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'system', ?, NULL, NULL, ?, NULL, ?, ?, ?, ?)`,
      )
      .bind(replyId, run.workspace_id, run.chat_id, params.channel, params.replyText, run.id, nextSeq, params.nowIso, params.nowIso),
  ];
  await appendActivity(batch, db, {
    workspaceId: run.workspace_id,
    chatId: run.chat_id,
    runId: run.id,
    cursorSelect: `(SELECT activity_cursor - 1 FROM chats WHERE id = ?)`,
    type: 'text_chunk',
    payload: { text: params.replyText },
    nowIso: params.nowIso,
  });
  await appendActivity(batch, db, {
    workspaceId: run.workspace_id,
    chatId: run.chat_id,
    runId: run.id,
    cursorSelect: `(SELECT activity_cursor FROM chats WHERE id = ?)`,
    type: 'run_finished',
    payload: { status: 'succeeded' },
    nowIso: params.nowIso,
  });
  if (run.source_message_id) {
    batch.push(
      db
        .prepare(`UPDATE messages_in SET status = 'processed', updated_at = ? WHERE id = ?`)
        .bind(params.nowIso, run.source_message_id),
    );
  }
  if (params.outboxId) {
    batch.push(
      db
        .prepare(
          `UPDATE outbox SET status = 'delivered', last_attempt_at = ?, updated_at = ? WHERE id = ?
           AND (claimed_by IS NULL OR claimed_by = ?)`,
        )
        .bind(params.nowIso, params.nowIso, params.outboxId, params.attemptId),
    );
  }
  batch.push(
    db
      .prepare(
        `UPDATE workspaces SET lease_owner = NULL, lease_attempt_id = NULL, lease_expires_at = NULL
         WHERE id = ? AND lease_owner = ? AND lease_attempt_id = ?`,
      )
      .bind(run.workspace_id, params.attemptId, params.attemptId),
  );

  try {
    await db.batch(batch);
  } catch (err) {
    if (isGuardFailure(err)) {
      throw await classifyCommitFailure(db, run, params.attemptId);
    }
    throw err;
  }
}

async function classifyCommitFailure(db: D1Database, run: LoadedRun, attemptId: string): Promise<ActorError> {
  const current = await loadRun(db, run.workspace_id, run.id);
  if (!current) return new ActorError('run_not_found', `Run '${run.id}' disappeared.`);
  if (current.status === 'succeeded') {
    return new ActorError('already_terminal', `Run '${run.id}' already completed.`);
  }
  if (current.status === 'cancelled') {
    return new ActorError('run_inactive', `Run '${run.id}' was cancelled.`);
  }
  if (current.attempt_id !== attemptId) {
    return new ActorError('stale_lease', 'Another attempt holds this run; this holder is stale.');
  }
  return new ActorError('stale_lease', 'Lease, fence, or membership no longer valid; holder is stale.');
}

/**
 * Fenced terminal failure. Used for poison inputs and deterministic handler
 * failures. The transition is guarded on the observed run status and attempt
 * so a stale attempt can never fail its successor's run. Returns false when
 * the observed state no longer holds (nothing was written).
 */
async function failRunTerminal(
  db: D1Database,
  params: {
    run: LoadedRun;
    expectedStatus: string;
    expectedAttemptId: string | null;
    errorCode: string;
    errorMessage: string;
    outboxId: string | null;
    runStatus: 'failed' | 'partial';
    nowIso: string;
  },
): Promise<boolean> {
  const { run } = params;
  // Explicit null handling: build the attempt predicate literally rather than
  // relying on `IS ?` parameter binding.
  const attemptPredicate = params.expectedAttemptId === null ? `attempt_id IS NULL` : `attempt_id = ?`;
  const guardPredicate = `(SELECT 1 FROM agent_runs WHERE id = ? AND status = ? AND ${attemptPredicate})`;
  const guardBinds: Array<string | number | null> = [run.id, params.expectedStatus];
  if (params.expectedAttemptId !== null) guardBinds.push(params.expectedAttemptId);
  const batch: D1PreparedStatement[] = [
    db
      .prepare(`INSERT INTO acceptance_guards (id, guard_ok) VALUES (?, ${guardPredicate})`)
      .bind(`guard_${crypto.randomUUID()}`, ...guardBinds),
    db
      .prepare(
        `UPDATE agent_runs SET status = ?, error_code = ?, error_message = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(params.runStatus, params.errorCode, params.errorMessage, params.nowIso, run.id),
  ];
  await appendActivity(batch, db, {
    workspaceId: run.workspace_id,
    chatId: run.chat_id,
    runId: run.id,
    cursorSelect: `(SELECT activity_cursor + 1 FROM chats WHERE id = ?)`,
    type: 'partial_failure',
    payload: { error_code: params.errorCode, error_message: params.errorMessage },
    nowIso: params.nowIso,
  });
  batch.push(
    db
      .prepare(`UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ? WHERE id = ?`)
      .bind(params.nowIso, params.nowIso, run.chat_id),
  );
  if (run.source_message_id) {
    batch.push(
      db
        .prepare(`UPDATE messages_in SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`)
        .bind(params.errorMessage, params.nowIso, run.source_message_id),
    );
  }
  if (params.outboxId) {
    if (params.expectedAttemptId) {
      batch.push(
        db
          .prepare(
            `UPDATE outbox SET status = 'failed_known', last_error = ?, last_attempt_at = ?, updated_at = ? WHERE id = ?
             AND (claimed_by IS NULL OR claimed_by = ?)`,
          )
          .bind(params.errorMessage, params.nowIso, params.nowIso, params.outboxId, params.expectedAttemptId),
      );
    } else {
      batch.push(
        db
          .prepare(
            `UPDATE outbox SET status = 'failed_known', last_error = ?, last_attempt_at = ?, updated_at = ? WHERE id = ?`,
          )
          .bind(params.errorMessage, params.nowIso, params.nowIso, params.outboxId),
      );
    }
  }
  if (params.expectedAttemptId) {
    batch.push(
      db
        .prepare(
          `UPDATE workspaces SET lease_owner = NULL, lease_attempt_id = NULL, lease_expires_at = NULL
           WHERE id = ? AND lease_owner = ? AND lease_attempt_id = ?`,
        )
        .bind(run.workspace_id, params.expectedAttemptId, params.expectedAttemptId),
    );
  }
  try {
    await db.batch(batch);
    return true;
  } catch (err) {
    if (isGuardFailure(err)) return false;
    throw err;
  }
}

/**
 * Parks a run waiting for human input and releases the workspace slot.
 * Other members continue; the answer resumes via resumeRun.
 */
async function waitForInput(
  db: D1Database,
  params: {
    run: LoadedRun;
    attemptId: string;
    fence: number;
    question: string;
    intendedOperation: string;
    missingFields: string[];
    candidates: unknown;
    pendingOperation?: unknown;
    requesterUserId: string;
    outboxId: string | null;
    nowIso: string;
  },
): Promise<void> {
  const { run } = params;
  const revRow = await db
    .prepare(`SELECT business_revision FROM workspaces WHERE id = ?`)
    .bind(run.workspace_id)
    .first<{ business_revision: number }>();
  // Idempotent: a redispatch that reuses a recorded question must not create
  // a duplicate pending clarification or a duplicate question activity.
  const alreadyPending = await db
    .prepare(`SELECT 1 AS ok FROM pending_clarifications WHERE run_id = ? AND status = 'pending'`)
    .bind(run.id)
    .first();

  const batch: D1PreparedStatement[] = [
    db
      .prepare(`INSERT INTO acceptance_guards (id, guard_ok) VALUES (?, ${holderGuardSql()})`)
      .bind(
        `guard_${crypto.randomUUID()}`,
        run.id,
        params.attemptId,
        params.fence,
        params.fence,
        params.attemptId,
        params.attemptId,
        params.nowIso,
      ),
    db
      .prepare(`UPDATE agent_runs SET status = 'waiting_for_input', updated_at = ? WHERE id = ?`)
      .bind(params.nowIso, run.id),
  ];
  if (!alreadyPending) {
    batch.push(
      db
        .prepare(
          `INSERT INTO pending_clarifications
             (id, workspace_id, chat_id, run_id, source_message_id, requester_user_id, question,
              intended_operation, missing_fields, candidates_json, operation_payload_json, source_revision, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .bind(
          `clr_${crypto.randomUUID()}`,
          run.workspace_id,
          run.chat_id,
          run.id,
          run.source_message_id,
          params.requesterUserId,
          params.question,
          params.intendedOperation,
          JSON.stringify(params.missingFields),
          params.candidates === undefined ? null : JSON.stringify(params.candidates),
          params.pendingOperation === undefined ? null : JSON.stringify(params.pendingOperation),
          Number(revRow?.business_revision ?? 0),
          params.nowIso,
          params.nowIso,
        ),
    );
    await appendActivity(batch, db, {
      workspaceId: run.workspace_id,
      chatId: run.chat_id,
      runId: run.id,
      cursorSelect: `(SELECT activity_cursor + 1 FROM chats WHERE id = ?)`,
      type: 'clarification_required',
      payload: { question: params.question, missing_fields: params.missingFields },
      nowIso: params.nowIso,
    });
    batch.push(
      db
        .prepare(`UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ? WHERE id = ?`)
        .bind(params.nowIso, params.nowIso, run.chat_id),
    );
  }
  if (run.source_message_id) {
    batch.push(
      db
        .prepare(`UPDATE messages_in SET status = 'waiting_for_input', updated_at = ? WHERE id = ?`)
        .bind(params.nowIso, run.source_message_id),
    );
  }
  if (params.outboxId) {
    // Dispatch of this item is complete; the answer schedules a continuation.
    // Only our own intent is marked delivered.
    batch.push(
      db
        .prepare(
          `UPDATE outbox SET status = 'delivered', last_attempt_at = ?, updated_at = ? WHERE id = ?
           AND (claimed_by IS NULL OR claimed_by = ?)`,
        )
        .bind(params.nowIso, params.nowIso, params.outboxId, params.attemptId),
    );
  }
  batch.push(
    db
      .prepare(
        `UPDATE workspaces SET lease_owner = NULL, lease_attempt_id = NULL, lease_expires_at = NULL
         WHERE id = ? AND lease_owner = ? AND lease_attempt_id = ?`,
      )
      .bind(run.workspace_id, params.attemptId, params.attemptId),
  );

  try {
    await db.batch(batch);
  } catch (err) {
    if (isGuardFailure(err)) {
      throw await classifyCommitFailure(db, run, params.attemptId);
    }
    throw err;
  }
}

/**
 * Dispatches one pending outbox item: claims it, pins its run under a fresh
 * lease, executes one bounded turn, and commits exactly once.
 */
export async function dispatchOutboxItem(
  db: D1Database,
  outboxId: string,
  workspaceId: string,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const handler = options.handler ?? EchoHandler;
  const maxAttempts = options.maxAttempts ?? 3;
  const now = makeNow(options);
  const attemptId = `att_${crypto.randomUUID()}`;

  const item = await db
    .prepare(
      `SELECT id, payload_json, status, attempt_count, max_attempts
       FROM outbox WHERE id = ? AND workspace_id = ?`,
    )
    .bind(outboxId, workspaceId)
    .first<Record<string, unknown>>();
  if (!item) {
    return { status: 'not_found', run_id: null };
  }
  if (String(item['status']) === 'sending') {
    // Owned by a live dispatch; a duplicate delivery backs off.
    return { status: 'contended', run_id: null };
  }
  if (String(item['status']) !== 'pending') {
    // delivered, failed_known, or cancelled: the recorded outcome stands.
    return { status: 'already_done', run_id: null };
  }

  const claim = await db
    .prepare(
      `UPDATE outbox SET status = 'sending', claimed_by = ?, last_attempt_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(attemptId, now(), now(), outboxId)
    .run();
  if ((claim.meta.changes ?? 0) !== 1) {
    return { status: 'contended', run_id: null };
  }

  let payload: { run_id?: string };
  try {
    payload = JSON.parse(String(item['payload_json'])) as { run_id?: string };
  } catch {
    await db
      .prepare(`UPDATE outbox SET status = 'failed_known', last_error = ?, updated_at = ? WHERE id = ?`)
      .bind('Outbox payload is not valid JSON.', now(), outboxId)
      .run();
    return { status: 'failed', run_id: null, detail: 'poison' };
  }

  if (!payload.run_id) {
    await db
      .prepare(`UPDATE outbox SET status = 'failed_known', last_error = ?, updated_at = ? WHERE id = ?`)
      .bind('Outbox payload has no run_id.', now(), outboxId)
      .run();
    return { status: 'failed', run_id: null, detail: 'poison' };
  }

  const run = await loadRun(db, workspaceId, payload.run_id);
  if (!run) {
    await db
      .prepare(`UPDATE outbox SET status = 'failed_known', last_error = ?, updated_at = ? WHERE id = ?`)
      .bind(`Run '${payload.run_id}' not found.`, now(), outboxId)
      .run();
    return { status: 'failed', run_id: payload.run_id, detail: 'run_not_found' };
  }
  if (isTerminal(run.status)) {
    await db
      .prepare(`UPDATE outbox SET status = 'delivered', updated_at = ? WHERE id = ?`)
      .bind(now(), outboxId)
      .run();
    return { status: 'already_done', run_id: run.id };
  }
  if (run.status !== 'queued') {
    // Held or waiting elsewhere; leave the item for its owner/recovery.
    // Lease contention and non-queued states never consume the execution
    // budget: attempt_count is only incremented once this dispatch actually
    // pins and begins execution below. Only reset our own claim; a successor's
    // row is never touched.
    await db
      .prepare(
        `UPDATE outbox SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'sending'
         AND (claimed_by IS NULL OR claimed_by = ?)`,
      )
      .bind(now(), outboxId, attemptId)
      .run();
    return { status: 'deferred', run_id: run.id };
  }

  // Revoked membership denies dispatch: the actor is gone, so the run fails
  // visibly instead of executing without authority.
  // (A sourceless run needs no fast path: the agent_runs CHECK enforces
  // exactly one of source_message_id / source_job_id at the schema level.)
  const actorUserId = await resolveRunActor(db, run);
  if (actorUserId) {
    const member = await db
      .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .bind(workspaceId, actorUserId)
      .first();
    if (!member) {
      const failed = await failRunTerminal(db, {
        run,
        expectedStatus: 'queued',
        expectedAttemptId: run.attempt_id,
        errorCode: 'member_removed',
        errorMessage: 'Run actor is no longer a workspace member.',
        outboxId,
        runStatus: 'failed',
        nowIso: now(),
      });
      return failed
        ? { status: 'failed', run_id: run.id, detail: 'member_removed' }
        : { status: 'deferred', run_id: run.id, detail: 'stale_attempt' };
    }
  }

  const lease = await claimWorkspaceLease(db, {
    workspaceId,
    attemptId,
    ttlSeconds: options.leaseTtlSeconds,
    nowIso: now(),
  });
  if (!lease) {
    // Lease contention defers without consuming the execution budget.
    // Only our own claim is reset; a successor's intent is never touched.
    await db
      .prepare(
        `UPDATE outbox SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'sending'
         AND (claimed_by IS NULL OR claimed_by = ?)`,
      )
      .bind(now(), outboxId, attemptId)
      .run();
    return { status: 'deferred', run_id: run.id };
  }

  const pinned = await (async () => {
    if (options.testHooks?.beforePin) {
      await options.testHooks.beforePin({ attemptId, outboxId });
    }
    return pinRun(db, run, attemptId, lease.fence, now());
  })();
  if (!pinned) {
    await releaseWorkspaceLease(db, { workspaceId, attemptId });
    // Lost the pinning race (run no longer queued or lease no longer held):
    // defer without consuming budget and without touching a successor's row.
    await db
      .prepare(
        `UPDATE outbox SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'sending'
         AND (claimed_by IS NULL OR claimed_by = ?)`,
      )
      .bind(now(), outboxId, attemptId)
      .run();
    return { status: 'deferred', run_id: run.id };
  }

  // Execution budget is consumed only once this dispatch actually begins
  // execution (lease held + run pinned). The counter is owned: a paused
  // dispatcher that lost its intent to a successor affects zero rows and
  // aborts instead of inflating the successor's failure budget.
  if (options.testHooks?.beforeIncrement) {
    await options.testHooks.beforeIncrement({ attemptId, outboxId });
  }
  const counted = await db
    .prepare(
      `UPDATE outbox SET attempt_count = attempt_count + 1, last_attempt_at = ?, updated_at = ? WHERE id = ?
       AND status = 'sending' AND (claimed_by IS NULL OR claimed_by = ?)`,
    )
    .bind(now(), now(), outboxId, attemptId)
    .run();
  if ((counted.meta.changes ?? 0) !== 1) {
    // Intent no longer ours (recovery + successor took over between pin and
    // count): stop without running the handler. The pinned run is still ours,
    // so requeue it for a clean retry rather than leaking a running owner.
    await requeueAsHolder(db, { workspaceId, runId: run.id, attemptId, outboxId, nowIso: now() });
    return { status: 'deferred', run_id: run.id, detail: 'stale_attempt' };
  }
  const freshOutbox = await db
    .prepare(`SELECT attempt_count, max_attempts FROM outbox WHERE id = ?`)
    .bind(outboxId)
    .first<{ attempt_count: number; max_attempts: number | null }>();
  const attempts = Number(freshOutbox?.attempt_count ?? 1);
  const itemMax = Number(freshOutbox?.max_attempts ?? item['max_attempts'] ?? maxAttempts);
  if (attempts > itemMax) {
    const failed = await failRunTerminal(db, {
      run: await loadRun(db, workspaceId, run.id).then((r) => r ?? run),
      expectedStatus: 'running',
      expectedAttemptId: attemptId,
      errorCode: 'poison',
      errorMessage: `Run exceeded ${itemMax} dispatch attempts.`,
      outboxId,
      runStatus: 'failed',
      nowIso: now(),
    });
    return failed
      ? { status: 'failed', run_id: run.id, detail: 'poison' }
      : { status: 'deferred', run_id: run.id, detail: 'stale_attempt' };
  }

  // Persist the logical turn step BEFORE executing: a replay finds the
  // receipt and never re-runs the handler for the same source. Receipts are
  // attempt-owned, so a successor's records can never be overwritten.
  const stepArgs = { source_message_id: run.source_message_id, source_job_id: run.source_job_id };
  let outcome: TurnOutcome;
  try {
    const persisted = await persistStep(db, {
      runId: run.id,
      workspaceId,
      stepIndex: 0,
      toolName: `turn:${handler.name}`,
      args: stepArgs,
      attemptId,
      fence: lease.fence,
      nowIso: now(),
    });
    let recorded: TurnOutcome | null = null;
    if (persisted.replay && persisted.step.status === 'succeeded' && persisted.step.result_json) {
      recorded = JSON.parse(persisted.step.result_json) as TurnOutcome;
    }
    // A recorded continuation always re-executes: progress lives in the
    // checkpoint steps, and replaying the receipt would loop forever.
    // A recorded question re-executes only once its clarification is spent
    // (resolved, with nothing pending).
    let reusable = false;
    if (recorded !== null) {
      if (recorded.kind === 'continuation') {
        reusable = false;
      } else if (recorded.kind === 'needs_input') {
        const clar = await clarificationState(db, run.id);
        reusable = !(clar.hasResolved && !clar.hasPending);
      } else {
        reusable = true;
      }
    }
    if (reusable && recorded !== null) {
      outcome = recorded;
    } else {
      if (persisted.step.attempt_id !== null && persisted.step.attempt_id !== attemptId) {
        // Re-executing a predecessor's spent receipt: adopt it first so the
        // successor owns the row it is about to rewrite.
        await adoptStep(db, persisted.step.id, attemptId, { fence: lease.fence, nowIso: now() });
      }
      await markStepRunning(db, persisted.step.id, attemptId, { fence: lease.fence, nowIso: now() });
      const source = await loadSourceText(db, run);
      const answer = await loadClarificationAnswer(db, run.id);
      outcome = await handler.runTurn({
        db,
        workspaceId,
        runId: run.id,
        attemptId,
        fence: lease.fence,
        chatId: run.chat_id,
        sourceMessageId: run.source_message_id,
        sourceJobId: run.source_job_id,
        sourceText: source.text,
        channel: source.channel,
        sourceTrust: source.sourceTrust,
        answerText: answer?.text ?? null,
        answerMessageId: answer?.messageId ?? null,
      });
      await completeStep(db, persisted.step.id, attemptId, {
        resultJson: JSON.stringify(outcome),
        fence: lease.fence,
        nowIso: now(),
      });
    }
  } catch (err) {
    if (err instanceof StepError) {
      // If the lease expired mid-turn while this attempt still owns the run,
      // requeue as holder so the turn can retry with a fresh lease.
      // If the run was stopped or stolen by another attempt, touch nothing.
      const runRow = await db
        .prepare(`SELECT attempt_id, status FROM agent_runs WHERE id = ?`)
        .bind(run.id)
        .first<{ attempt_id: string | null; status: string }>();
      if (runRow?.status === 'running' && runRow.attempt_id === attemptId) {
        const requeued = await requeueAsHolder(db, {
          workspaceId,
          runId: run.id,
          attemptId,
          outboxId,
          nowIso: now(),
        });
        if (requeued) {
          return { status: 'deferred', run_id: run.id, detail: 'lease_lost' };
        }
      }
      return { status: 'deferred', run_id: run.id, detail: err.code };
    }
    // Unexpected handler failure: requeue while attempts remain, else poison.
    // Every write is gated on this attempt still owning the run.
    if (attempts >= itemMax) {
      const steps = await listRunSteps(db, run.id);
      const failed = await failRunTerminal(db, {
        run,
        expectedStatus: 'running',
        expectedAttemptId: attemptId,
        errorCode: 'handler_error',
        errorMessage: err instanceof Error ? err.message : String(err),
        outboxId,
        runStatus: steps.some((s) => s.status === 'succeeded') ? 'partial' : 'failed',
        nowIso: now(),
      });
      return failed
        ? { status: 'failed', run_id: run.id, detail: 'handler_error' }
        : { status: 'deferred', run_id: run.id, detail: 'stale_attempt' };
    }
    const requeued = await requeueAsHolder(db, {
      workspaceId,
      runId: run.id,
      attemptId,
      outboxId,
      nowIso: now(),
    });
    return requeued
      ? { status: 'deferred', run_id: run.id, detail: 'retry' }
      : { status: 'deferred', run_id: run.id, detail: 'stale_attempt' };
  }

  // Renew before committing so a slow handler cannot straddle expiry. The
  // renewal uses the current clock, never the turn's start time (P0-2).
  try {
    await renewWorkspaceLease(db, { workspaceId, attemptId, ttlSeconds: options.leaseTtlSeconds, nowIso: now() });
  } catch {
    // Lost the lease mid-turn: requeue only if this attempt still owns the
    // run; a successor's state is never clobbered.
    const requeued = await requeueAsHolder(db, {
      workspaceId,
      runId: run.id,
      attemptId,
      outboxId,
      nowIso: now(),
    });
    return { status: 'deferred', run_id: run.id, detail: requeued ? 'lease_lost' : 'stale_attempt' };
  }

  try {
    if (outcome.kind === 'completed') {
      await completeRun(db, {
        run,
        attemptId,
        fence: lease.fence,
        replyText: outcome.replyText,
        channel: (await loadSourceText(db, run)).channel,
        outboxId,
        nowIso: now(),
      });
      return { status: 'completed', run_id: run.id };
    }
    if (outcome.kind === 'needs_input') {
      const requester = await db
        .prepare(`SELECT user_id FROM messages_in WHERE id = ?`)
        .bind(run.source_message_id)
        .first<{ user_id: string | null }>();
      await waitForInput(db, {
        run,
        attemptId,
        fence: lease.fence,
        question: outcome.question,
        intendedOperation: outcome.intendedOperation,
        missingFields: outcome.missingFields,
        candidates: outcome.candidates,
        pendingOperation: outcome.pendingOperation,
        requesterUserId: requester?.user_id ?? '',
        outboxId,
        nowIso: now(),
      });
      return { status: 'waiting_for_input', run_id: run.id };
    }
    if (outcome.kind === 'continuation') {
      // Bounded slice: only a current holder may checkpoint and requeue.
      if (!(await holderStillOwns(db, run.id, attemptId, now()))) {
        return { status: 'deferred', run_id: run.id, detail: 'stale_attempt' };
      }
      const checkpointIndex = (await listRunSteps(db, run.id)).length;
      const persisted = await persistStep(db, {
        runId: run.id,
        workspaceId,
        stepIndex: checkpointIndex,
        toolName: 'checkpoint',
        args: { progress: outcome.progressJson },
        attemptId,
        fence: lease.fence,
        nowIso: now(),
      });
      if (!persisted.replay && persisted.step.attempt_id === attemptId) {
        await completeStep(db, persisted.step.id, attemptId, {
          resultJson: outcome.progressJson,
          fence: lease.fence,
          nowIso: now(),
        });
      }
      const requeued = await requeueAsHolder(db, {
        workspaceId,
        runId: run.id,
        attemptId,
        outboxId,
        nowIso: now(),
      });
      if (requeued) {
        // A planned continuation is not a failed attempt: refund the claim
        // so long checkpoint chains are not mistaken for poison. Only refund
        // our own intent.
        await db
          .prepare(
            `UPDATE outbox SET attempt_count = attempt_count - 1, updated_at = ? WHERE id = ? AND status = 'pending'
             AND (claimed_by IS NULL OR claimed_by = ?)`,
          )
          .bind(now(), outboxId, attemptId)
          .run();
      }
      return { status: 'deferred', run_id: run.id, detail: requeued ? 'checkpoint' : 'stale_attempt' };
    }
    const appliedReceipt = await db
      .prepare(`SELECT 1 FROM action_receipts WHERE workspace_id = ? AND run_id = ? AND result_status = 'applied' LIMIT 1`)
      .bind(run.workspace_id, run.id)
      .first();
    const finalRunStatus = appliedReceipt !== null ? 'partial' : 'failed';

    const failed = await failRunTerminal(db, {
      run,
      expectedStatus: 'running',
      expectedAttemptId: attemptId,
      errorCode: outcome.errorCode,
      errorMessage: outcome.errorMessage,
      outboxId,
      runStatus: finalRunStatus,
      nowIso: now(),
    });
    return failed
      ? { status: 'failed', run_id: run.id, detail: outcome.errorCode }
      : { status: 'deferred', run_id: run.id, detail: 'stale_attempt' };
  } catch (err) {
    if (err instanceof ActorError && (err.code === 'stale_lease' || err.code === 'run_inactive')) {
      return { status: 'deferred', run_id: run.id, detail: err.code };
    }
    if (err instanceof ActorError && err.code === 'already_terminal') {
      return { status: 'already_done', run_id: run.id };
    }
    throw err;
  }
}

/** Durable answer from the latest resolved clarification for a run. */
async function loadClarificationAnswer(
  db: D1Database,
  runId: string,
): Promise<{ text: string; messageId: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT resolution_response, answer_message_id FROM pending_clarifications
       WHERE run_id = ? AND status = 'resolved' AND resolution_response IS NOT NULL
       ORDER BY resolved_at DESC LIMIT 1`,
    )
    .bind(runId)
    .first<{ resolution_response: string | null; answer_message_id: string | null }>();
  if (!row?.resolution_response) return null;
  return {
    text: String(row.resolution_response),
    messageId: row.answer_message_id ? String(row.answer_message_id) : null,
  };
}

/**
 * Dispatches pending outbox items for a workspace, oldest first, within a
 * bounded budget. Queue wake-up order never defines business order: the
 * oldest pending item wins regardless of arrival order.
 */
export async function dispatchWorkspace(
  db: D1Database,
  workspaceId: string,
  options: DispatchOptions & { budget?: number } = {},
): Promise<{ processed: number; results: DispatchResult[] }> {
  const budget = options.budget ?? 5;
  const results: DispatchResult[] = [];
  for (let i = 0; i < budget; i++) {
    const next = await db
      .prepare(
        `SELECT id FROM outbox
         WHERE workspace_id = ? AND destination = 'workspace_actor' AND status = 'pending'
         ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .bind(workspaceId)
      .first<{ id: string }>();
    if (!next) break;
    const result = await dispatchOutboxItem(db, next.id, workspaceId, options);
    results.push(result);
    if (result.status === 'deferred' || result.status === 'contended') break;
  }
  return { processed: results.length, results };
}

/**
 * Resumes a run parked in waiting_for_input. The member's answer is stored
 * durably on the clarification row (response text + optional source message)
 * so a restarted handler receives the actual answer, not the original
 * request. Committed steps are never repeated thanks to step receipts.
 *
 * Specificity & Duplication:
 * - If clarificationId is given, targets that exact question; otherwise the
 *   run must have exactly one total clarification (single-question flow).
 *   Multi-question runs require an explicit clarificationId so a delayed or
 *   retried answer to Q1 can never resolve Q2.
 * - If answer.messageId was already recorded on a resolved clarification, returns replay outcome.
 * - The specific clarificationId is guarded in the transaction guard so an answer to Q1 cannot resolve Q2.
 * - When the clarification carries an operation payload from @otis/ledger, coordinates with
 *   resumePendingClarification to execute the ledger command atomically in the same batch.
 */
export async function resumeRun(
  db: D1Database,
  params: {
    workspaceId: string;
    runId: string;
    answer: ResumeAnswer;
    nowIso?: string;
    testHooks?: { afterPrecheck?: (info: { clarId: string; authorUserId: string }) => Promise<void> };
  },
): Promise<ResumeRunResult> {
  const nowIso = params.nowIso ?? new Date().toISOString();

  // 1. Check duplicate delivery by answer message ID
  if (params.answer.messageId) {
    const existingAnswer = await db
      .prepare(
        `SELECT id, status FROM pending_clarifications
         WHERE workspace_id = ? AND answer_message_id = ? AND status = 'resolved'`,
      )
      .bind(params.workspaceId, params.answer.messageId)
      .first<Record<string, unknown>>();
    if (existingAnswer) {
      return { resumed: false, replay: true, ...(params.answer.clarificationId ? { clarificationId: String(existingAnswer['id']) } : {}) };
    }
  }

  const run = await loadRun(db, params.workspaceId, params.runId);
  if (!run || run.status !== 'waiting_for_input') {
    return { resumed: false };
  }

  // 2. Locate target clarification
  let clar: Record<string, unknown> | null = null;
  if (params.answer.clarificationId) {
    clar = await db
      .prepare(
        `SELECT id, workspace_id, chat_id, run_id, requester_user_id, status, missing_fields, operation_payload_json, answer_message_id
         FROM pending_clarifications WHERE id = ? AND workspace_id = ? AND run_id = ?`,
      )
      .bind(params.answer.clarificationId, params.workspaceId, params.runId)
      .first<Record<string, unknown>>();
    if (!clar) return { resumed: false };
    if (clar['status'] !== 'pending') {
      if (clar['status'] === 'resolved' && params.answer.messageId && clar['answer_message_id'] === params.answer.messageId) {
        return { resumed: false, replay: true, ...(params.answer.clarificationId ? { clarificationId: String(clar['id']) } : {}) };
      }
      return { resumed: false };
    }
  } else {
    // No explicit question: only safe for single-question runs. If this run
    // ever asked more than one question, the caller must name which one the
    // answer resolves; otherwise a retried Q1 delivery could resolve Q2.
    const total = await db
      .prepare(`SELECT COUNT(*) AS n FROM pending_clarifications WHERE run_id = ? AND workspace_id = ?`)
      .bind(params.runId, params.workspaceId)
      .first<{ n: number }>();
    if (Number(total?.n ?? 0) !== 1) {
      return { resumed: false };
    }
    clar = await db
      .prepare(
        `SELECT id, workspace_id, chat_id, run_id, requester_user_id, status, missing_fields, operation_payload_json, answer_message_id
         FROM pending_clarifications WHERE run_id = ? AND workspace_id = ? AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(params.runId, params.workspaceId)
      .first<Record<string, unknown>>();
    if (!clar) return { resumed: false };
  }

  const clarId = String(clar['id']);
  const requesterUserId = clar['requester_user_id'] ? String(clar['requester_user_id']) : null;

  // 3. Answer provenance: a persisted answer source is required. Its author is
  // derived server-side from messages_in, never trusted from the caller. The
  // source must belong to this workspace, match the clarification chat when
  // both carry one, and come from the requesting member. Membership is checked
  // here for a fast reject and repeated inside the committing transaction.
  if (!params.answer.messageId) {
    return { resumed: false };
  }
  const answerMsg = await db
    .prepare(`SELECT workspace_id, chat_id, user_id FROM messages_in WHERE id = ?`)
    .bind(params.answer.messageId)
    .first<Record<string, unknown>>();
  if (!answerMsg || !answerMsg['user_id']) {
    return { resumed: false };
  }
  if (String(answerMsg['workspace_id'] ?? '') !== params.workspaceId) {
    return { resumed: false };
  }
  if (
    clar['chat_id'] &&
    answerMsg['chat_id'] &&
    String(answerMsg['chat_id']) !== String(clar['chat_id'])
  ) {
    return { resumed: false };
  }
  const authorUserId = String(answerMsg['user_id']);
  if (params.answer.authorUserId && String(params.answer.authorUserId) !== authorUserId) {
    return { resumed: false };
  }
  if (requesterUserId && authorUserId !== requesterUserId) {
    return { resumed: false };
  }
  {
    const member = await db
      .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .bind(params.workspaceId, authorUserId)
      .first();
    if (!member) return { resumed: false };
  }

  if (params.testHooks?.afterPrecheck) {
    await params.testHooks.afterPrecheck({ clarId, authorUserId });
  }

  // 4. If clarification has a ledger operation_payload_json, execute ledger resumption.
  // Non-ledger control clarifications (such as bulk_operation confirmation) route to
  // standard resumption in section 5 so the agent loop can resume with approved scope.
  let isLedgerCommand = false;
  let pendingOpActionId: string | null = null;
  if (clar['operation_payload_json']) {
    try {
      const op = JSON.parse(String(clar['operation_payload_json']));
      if (op && typeof op === 'object' && op.command_name) {
        if (op.command_name !== 'bulk_operation') {
          isLedgerCommand = true;
        }
        if (op.action_id) {
          pendingOpActionId = String(op.action_id);
        }
      }
    } catch {
      // ignore
    }
  }

  if (isLedgerCommand) {
    let resolvedFields = params.answer.resolvedFields;
    if (!resolvedFields) {
      let missingList: string[] = [];
      if (clar['missing_fields']) {
        try {
          const parsed = JSON.parse(String(clar['missing_fields']));
          if (Array.isArray(parsed)) missingList = parsed.map(String);
        } catch {
          missingList = [];
        }
      }
      const firstMissing = missingList[0];
      if (firstMissing) {
        resolvedFields = { [firstMissing]: params.answer.text };
      } else {
        resolvedFields = {};
      }
    }

    if (resolvedFields && typeof resolvedFields['due'] === 'string') {
      const settings = await db.prepare(`SELECT brief_timezone FROM member_settings WHERE workspace_id = ? AND user_id = ?`).bind(params.workspaceId, authorUserId).first<{ brief_timezone: string | null }>();
      const due = resolveDateAnswer(resolvedFields['due'], nowIso, settings?.brief_timezone ?? null);
      if (due === undefined) return { resumed: false };
      resolvedFields = { ...resolvedFields, due };
    }

    const outboxStmt = db
      .prepare(
        `INSERT INTO outbox (id, workspace_id, destination, topic, payload_json, status, created_at, updated_at)
         SELECT ?, ?, 'workspace_actor', 'execute_run', ?, 'pending', ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM outbox WHERE workspace_id = ? AND status IN ('pending', 'sending')
             AND json_extract(payload_json, '$.run_id') = ?
         )`,
      )
      .bind(
        `out_${crypto.randomUUID()}`,
        params.workspaceId,
        JSON.stringify({ run_id: params.runId, resumed: true }),
        nowIso,
        nowIso,
        params.workspaceId,
        params.runId,
      );

    const msgInStmt = db
      .prepare(
        `UPDATE messages_in SET status = 'queued', updated_at = ?
         WHERE id = (SELECT source_message_id FROM agent_runs WHERE id = ?)`,
      )
      .bind(nowIso, params.runId);

    const setAnswerMsgStmt = db
      .prepare(`UPDATE pending_clarifications SET answer_message_id = ? WHERE id = ?`)
      .bind(params.answer.messageId, clarId);

    const wsMeta = await db
      .prepare(`SELECT business_revision, membership_revision FROM workspaces WHERE id = ?`)
      .bind(params.workspaceId)
      .first<{ business_revision: number; membership_revision: number }>();

    const ledgerRes = await resumePendingClarification(
      db,
      {
        workspace_id: params.workspaceId,
        action_id: pendingOpActionId ? `${pendingOpActionId}:resumed` : `act_resume_${crypto.randomUUID()}`,
        actor: { kind: 'member', user_id: authorUserId },
        membership_revision: Number(wsMeta?.membership_revision ?? 0),
        request_id: `req_resume_${crypto.randomUUID()}`,
        expected_business_revision: Number(wsMeta?.business_revision ?? 0),
        source_message_id: params.answer.messageId,
        run_id: params.runId,
        chat_id: clar['chat_id'] ? String(clar['chat_id']) : undefined,
        resuming_clarification_id: clarId,
      },
      {
        clarification_id: clarId,
        resolved_fields: resolvedFields,
        resolution_response: params.answer.text,
      },
      undefined,
      [outboxStmt, msgInStmt, setAnswerMsgStmt],
    );

    if (ledgerRes.status === 'applied' || ledgerRes.status === 'already_applied') {
      return { resumed: true, ...(params.answer.clarificationId ? { clarificationId: clarId } : {}) };
    }
    return { resumed: false };
  }

  // 5. Standard non-ledger clarification resumption. The guard repeats the
  // answer authorization inside the committing transaction: the answer source
  // must still exist in this workspace, still belong to the requesting member,
  // and that member must still hold workspace membership. A removal between
  // the fast pre-check and the commit therefore fails the whole batch.
  const guard = `(SELECT 1 FROM agent_runs r
     JOIN pending_clarifications c ON c.run_id = r.id
     JOIN messages_in am ON am.id = ?
     WHERE r.id = ? AND r.workspace_id = ? AND r.status = 'waiting_for_input'
       AND c.id = ? AND c.workspace_id = ? AND c.status = 'pending'
       AND am.workspace_id = r.workspace_id
       AND am.user_id = c.requester_user_id
       AND (c.chat_id IS NULL OR am.chat_id IS NULL OR am.chat_id = c.chat_id)
       AND EXISTS (
         SELECT 1 FROM workspace_users wu
         WHERE wu.workspace_id = r.workspace_id AND wu.user_id = am.user_id
       ))`;

  try {
    await db.batch([
      db
        .prepare(`INSERT INTO acceptance_guards (id, guard_ok) VALUES (?, ${guard})`)
        .bind(
          `guard_${crypto.randomUUID()}`,
          params.answer.messageId,
          params.runId,
          params.workspaceId,
          clarId,
          params.workspaceId,
        ),
      db
        .prepare(`UPDATE agent_runs SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'waiting_for_input'`)
        .bind(nowIso, params.runId),
      db
        .prepare(
          `UPDATE pending_clarifications
           SET status = 'resolved', resolution_response = ?, answer_message_id = ?, resolved_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(params.answer.text, params.answer.messageId, nowIso, nowIso, clarId),
      // One continuation intent, created only when none is live.
      db
        .prepare(
          `INSERT INTO outbox (id, workspace_id, destination, topic, payload_json, status, created_at, updated_at)
           SELECT ?, ?, 'workspace_actor', 'execute_run', ?, 'pending', ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM outbox WHERE workspace_id = ? AND status IN ('pending', 'sending')
               AND json_extract(payload_json, '$.run_id') = ?
           )`,
        )
        .bind(
          `out_${crypto.randomUUID()}`,
          params.workspaceId,
          JSON.stringify({ run_id: params.runId, resumed: true }),
          nowIso,
          nowIso,
          params.workspaceId,
          params.runId,
        ),
      db
        .prepare(
          `UPDATE messages_in SET status = 'queued', updated_at = ?
           WHERE id = (SELECT source_message_id FROM agent_runs WHERE id = ?)`,
        )
        .bind(nowIso, params.runId),
    ]);
  } catch (err) {
    if (isGuardFailure(err)) return { resumed: false };
    throw err;
  }
  return { resumed: true, ...(params.answer.clarificationId ? { clarificationId: clarId } : {}) };
}

/**
 * Stops a run: cancels future steps and continuations, preserves already
 * committed actions. 'Stop' is not undo. Only the chat author may stop
 * their run (enforced by callers passing the requesting user).
 */
export async function stopRun(
  db: D1Database,
  params: { workspaceId: string; runId: string; actorUserId: string; nowIso?: string },
): Promise<{ stopped: boolean; status: string }> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const run = await loadRun(db, params.workspaceId, params.runId);
  if (!run) {
    throw new ActorError('run_not_found', `Run '${params.runId}' not found.`);
  }
  const chat = await db
    .prepare(`SELECT author_user_id FROM chats WHERE id = ? AND workspace_id = ?`)
    .bind(run.chat_id, params.workspaceId)
    .first<{ author_user_id: string }>();
  if (!chat || chat.author_user_id !== params.actorUserId) {
    throw new ActorError('run_inactive', 'Only the chat author can stop this run.');
  }
  if (isTerminal(run.status)) {
    return { stopped: false, status: run.status };
  }

  // One atomic batch: the guard pins the observed active status, so a
  // concurrent completion wins cleanly instead of leaving the run succeeded
  // while its input is marked cancelled (P1-5).
  const guard = `(SELECT 1 FROM agent_runs WHERE id = ? AND status IN ('queued', 'running', 'waiting_for_input'))`;
  try {
    await db.batch([
      db
        .prepare(`INSERT INTO acceptance_guards (id, guard_ok) VALUES (?, ${guard})`)
        .bind(`guard_${crypto.randomUUID()}`, run.id),
      db
        .prepare(
          `UPDATE agent_runs SET status = 'cancelled', error_code = 'stopped', updated_at = ?
           WHERE id = ? AND status IN ('queued', 'running', 'waiting_for_input')`,
        )
        .bind(nowIso, run.id),
      db
        .prepare(
          `UPDATE outbox SET status = 'cancelled', updated_at = ?
           WHERE workspace_id = ? AND status IN ('pending', 'sending')
             AND json_extract(payload_json, '$.run_id') = ?`,
        )
        .bind(nowIso, params.workspaceId, run.id),
      db
        .prepare(`UPDATE messages_in SET status = 'cancelled', updated_at = ? WHERE id = ?`)
        .bind(nowIso, run.source_message_id),
      db
        .prepare(
          `UPDATE pending_clarifications SET status = 'cancelled', updated_at = ?
           WHERE run_id = ? AND status = 'pending'`,
        )
        .bind(nowIso, run.id),
      db
        .prepare(
          `UPDATE workspaces SET lease_owner = NULL, lease_attempt_id = NULL, lease_expires_at = NULL
           WHERE id = ? AND lease_attempt_id = (SELECT attempt_id FROM agent_runs WHERE id = ?)`,
        )
        .bind(params.workspaceId, run.id),
    ]);
  } catch (err) {
    if (isGuardFailure(err)) {
      const current = await loadRun(db, params.workspaceId, params.runId);
      return { stopped: false, status: current?.status ?? 'unknown' };
    }
    throw err;
  }
  return { stopped: true, status: 'cancelled' };
}

/**
 * Discovers workspaces needing recovery or dispatch without relying on
 * existing outbox rows: an accepted-but-never-dispatched run has no pending
 * outbox (P1-3). Paginated and bounded.
 */
export async function listWorkspacesNeedingRecovery(
  db: D1Database,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<string[]> {
  const pageSize = Math.min(options.pageSize ?? 25, 100);
  const maxPages = options.maxPages ?? 4;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const { results } = await db
      .prepare(
        `SELECT workspace_id FROM (
           SELECT DISTINCT workspace_id FROM outbox
           WHERE destination = 'workspace_actor' AND status IN ('pending', 'sending')
           UNION
           SELECT DISTINCT workspace_id FROM agent_runs
           WHERE status IN ('queued', 'running') OR status = 'waiting_for_input'
         )
         ORDER BY workspace_id ASC LIMIT ? OFFSET ?`,
      )
      .bind(pageSize, page * pageSize)
      .all<{ workspace_id: string }>();
    const rows = results ?? [];
    for (const row of rows) {
      if (!seen.has(row.workspace_id)) {
        seen.add(row.workspace_id);
        ids.push(row.workspace_id);
      }
    }
    if (rows.length < pageSize) break;
  }
  return ids;
}

/**
 * Recovery sweep for one workspace: expired leases, stale sending items,
 * orphaned queued runs, and cancelled leftovers. Returns what moved.
 */
export async function recoverWorkspace(
  db: D1Database,
  workspaceId: string,
  options: { nowIso?: string; sendingStaleSeconds?: number; maxAttempts?: number } = {},
): Promise<{ requeuedRuns: number; resetOutbox: number; failedPoison: number; createdOutbox: number }> {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const staleCutoff = new Date(new Date(nowIso).getTime() - (options.sendingStaleSeconds ?? 300) * 1000).toISOString();
  const summary = { requeuedRuns: 0, resetOutbox: 0, failedPoison: 0, createdOutbox: 0 };

  // 1. No live lease: no holder can commit (every commit re-verifies a live
  // lease), so every running run is definitionally stale. Requeue them all,
  // reset their dispatch intents, and clear the dead lease.
  const lease = await db
    .prepare(
      `SELECT lease_owner, lease_attempt_id, lease_fence, lease_expires_at FROM workspaces WHERE id = ?`,
    )
    .bind(workspaceId)
    .first<Record<string, unknown>>();
  const expired =
    !lease ||
    !lease['lease_owner'] ||
    !lease['lease_expires_at'] ||
    String(lease['lease_expires_at']) <= nowIso;
  if (expired) {
    const deadAttempt = lease?.['lease_attempt_id'] ? String(lease['lease_attempt_id']) : null;
    const stuck = await db
      .prepare(`SELECT id, source_message_id FROM agent_runs WHERE workspace_id = ? AND status = 'running'`)
      .bind(workspaceId)
      .all<Record<string, unknown>>();
    for (const row of stuck.results ?? []) {
      const runId = String(row['id']);
      // Requeue atomically in a single guarded batch: only while the run's
      // own attempt has no live lease. A successor that claimed and pinned
      // in the meantime causes the guard to fail, leaving its state intact.
      const guard = `(
        SELECT 1 FROM agent_runs r
        WHERE r.id = ? AND r.status = 'running'
          AND NOT EXISTS (
            SELECT 1 FROM workspaces w
            WHERE w.id = r.workspace_id
              AND w.lease_owner IS NOT NULL
              AND w.lease_expires_at > ?
              AND w.lease_attempt_id = r.attempt_id
          )
      )`;
      const statements: D1PreparedStatement[] = [
        db
          .prepare(`INSERT INTO acceptance_guards (id, guard_ok) VALUES (?, ${guard})`)
          .bind(`guard_${crypto.randomUUID()}`, runId, nowIso),
        db
          .prepare(`UPDATE agent_runs SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'running'`)
          .bind(nowIso, runId),
      ];
      if (row['source_message_id']) {
        statements.push(
          db
            .prepare(`UPDATE messages_in SET status = 'queued', updated_at = ? WHERE id = ?`)
            .bind(nowIso, String(row['source_message_id'])),
        );
      }
      statements.push(
        db
          .prepare(
            `UPDATE outbox SET status = 'pending', updated_at = ?
             WHERE workspace_id = ? AND status = 'sending' AND json_extract(payload_json, '$.run_id') = ?`,
          )
          .bind(nowIso, workspaceId, runId),
      );
      try {
        await db.batch(statements);
        summary.requeuedRuns++;
      } catch (err) {
        if (!isGuardFailure(err)) throw err;
      }
    }
    if (deadAttempt) {
      await db
        .prepare(
          `UPDATE workspaces SET lease_owner = NULL, lease_attempt_id = NULL, lease_expires_at = NULL
           WHERE id = ? AND lease_attempt_id = ?`,
        )
        .bind(workspaceId, deadAttempt)
        .run();
    }
  }

  // 2. Stale sending outbox without a live holder: retry or declare poison.
  // A live holder (running run + live lease for its attempt) is never reset.
  const stale = await db
    .prepare(
      `SELECT id, payload_json, attempt_count, max_attempts FROM outbox
       WHERE workspace_id = ? AND destination = 'workspace_actor' AND status = 'sending'
         AND (last_attempt_at IS NULL OR last_attempt_at <= ?)`,
    )
    .bind(workspaceId, staleCutoff)
    .all<Record<string, unknown>>();
  for (const row of stale.results ?? []) {
    const outboxId = String(row['id']);
    const attempts = Number(row['attempt_count'] ?? 0);
    const max = Number(row['max_attempts'] ?? options.maxAttempts ?? 3);
    let runId: string | null = null;
    try {
      runId = (JSON.parse(String(row['payload_json'])) as { run_id?: string }).run_id ?? null;
    } catch {
      runId = null;
    }
    if (runId) {
      const live = await db
        .prepare(
          `SELECT 1 AS ok FROM agent_runs r JOIN workspaces w ON w.id = r.workspace_id
           WHERE r.id = ? AND r.workspace_id = ? AND r.status = 'running'
             AND r.attempt_id IS NOT NULL
             AND w.lease_attempt_id = r.attempt_id AND w.lease_expires_at > ?`,
        )
        .bind(runId, workspaceId, nowIso)
        .first();
      if (live) continue;
    }
    if (attempts >= max) {
      const run = runId ? await loadRun(db, workspaceId, runId) : null;
      if (run && !isTerminal(run.status)) {
        const failed = await failRunTerminal(db, {
          run,
          expectedStatus: run.status,
          expectedAttemptId: run.attempt_id,
          errorCode: 'poison',
          errorMessage: 'Dispatch attempts exhausted during recovery.',
          outboxId,
          runStatus: 'failed',
          nowIso,
        });
        if (failed) summary.failedPoison++;
      } else {
        await db
          .prepare(`UPDATE outbox SET status = 'failed_known', last_error = ?, updated_at = ? WHERE id = ?`)
          .bind('Dispatch attempts exhausted during recovery.', nowIso, outboxId)
          .run();
        summary.failedPoison++;
      }
    } else {
      await db
        .prepare(
          `UPDATE outbox SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'sending'
           AND (last_attempt_at IS NULL OR last_attempt_at <= ?)`,
        )
        .bind(nowIso, outboxId, staleCutoff)
        .run();
      summary.resetOutbox++;
    }
  }

  // 3. Queued runs with no live outbox (crash between acceptance and
  // dispatch): recreate the dispatch intent. D1 is authoritative.
  const orphans = await db
    .prepare(
      `SELECT r.id FROM agent_runs r
       WHERE r.workspace_id = ? AND r.status = 'queued'
         AND NOT EXISTS (
           SELECT 1 FROM outbox o
           WHERE o.workspace_id = r.workspace_id AND o.status IN ('pending', 'sending')
             AND json_extract(o.payload_json, '$.run_id') = r.id
         )`,
    )
    .bind(workspaceId)
    .all<{ id: string }>();
  for (const row of orphans.results ?? []) {
    await db
      .prepare(
        `INSERT INTO outbox (id, workspace_id, destination, topic, payload_json, status, created_at, updated_at)
         VALUES (?, ?, 'workspace_actor', 'execute_run', ?, 'pending', ?, ?)`,
      )
      .bind(
        `out_${crypto.randomUUID()}`,
        workspaceId,
        JSON.stringify({ run_id: row.id, recovered: true }),
        nowIso,
        nowIso,
      )
      .run();
    summary.createdOutbox++;
  }

  // 4. Cancelled runs must not keep live dispatch intents.
  await db
    .prepare(
      `UPDATE outbox SET status = 'cancelled', updated_at = ?
       WHERE workspace_id = ? AND status IN ('pending', 'sending')
         AND EXISTS (
           SELECT 1 FROM agent_runs r
           WHERE r.workspace_id = outbox.workspace_id
             AND json_extract(outbox.payload_json, '$.run_id') = r.id
             AND r.status = 'cancelled'
         )`,
    )
    .bind(nowIso, workspaceId)
    .run();

  return summary;
}
