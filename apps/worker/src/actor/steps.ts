/**
 * @otis/worker/actor/steps
 * Logical tool-step receipts (Gate 004B, hardened).
 *
 * A step is persisted (planned) before its handler runs, keyed by
 * (run_id, step_index) with a normalized arguments hash. Every step row is
 * owned by the attempt that created it (`attempt_id`); all writes are
 * conditional on ownership plus the run still being pinned to that attempt.
 * A stale attempt's write therefore changes zero rows and surfaces as a
 * conflict instead of overwriting its successor's receipt. Reads are shared:
 * a successor replays a final receipt but never rewrites another attempt's
 * row. Unowned rows (NULL attempt, including pre-hardening rows) are
 * adoptable exactly once by the attempt that pins the run.
 */

import { sha256 } from '@otis/identity';

export interface PersistedStep {
  id: string;
  run_id: string;
  step_index: number;
  tool_name: string;
  status: 'planned' | 'running' | 'succeeded' | 'failed' | 'skipped';
  result_json: string | null;
  action_id: string | null;
  attempt_id: string | null;
}

export class StepError extends Error {
  public readonly code: 'step_conflict' | 'stale_attempt';

  constructor(code: 'step_conflict' | 'stale_attempt', message: string) {
    super(message);
    this.name = 'StepError';
    this.code = code;
  }
}

export async function hashStepArguments(args: unknown): Promise<string> {
  return sha256(JSON.stringify(args ?? null));
}

function toStep(row: Record<string, unknown>): PersistedStep {
  return {
    id: String(row['id']),
    run_id: String(row['run_id']),
    step_index: Number(row['step_index']),
    tool_name: String(row['tool_name']),
    status: row['status'] as PersistedStep['status'],
    result_json: row['result_json'] ? String(row['result_json']) : null,
    action_id: row['action_id'] ? String(row['action_id']) : null,
    attempt_id: row['attempt_id'] ? String(row['attempt_id']) : null,
  };
}

/**
 * Persists a planned step, or returns the recorded step when this index was
 * already planned. Same hash replays (read-only); a different hash for the
 * same index is a conflict. An unowned row is adopted by the pinning
 * attempt; a row owned by another attempt is reported, never seized — the
 * caller must abort as stale.
 */
export async function persistStep(
  db: D1Database,
  params: {
    runId: string;
    workspaceId: string;
    stepIndex: number;
    toolName: string;
    args: unknown;
    attemptId: string;
    fence?: number;
    nowIso?: string;
  },
): Promise<{ step: PersistedStep; replay: boolean; foreign: boolean }> {
  const argsHash = await hashStepArguments(params.args);
  const now = params.nowIso ?? new Date().toISOString();
  const fence = params.fence ?? null;

  const existing = await db
    .prepare(
      `SELECT id, run_id, step_index, tool_name, status, result_json, action_id, attempt_id, arguments_hash
       FROM run_steps WHERE run_id = ? AND step_index = ?`,
    )
    .bind(params.runId, params.stepIndex)
    .first<Record<string, unknown>>();

  if (existing) {
    if (String(existing['arguments_hash']) !== argsHash) {
      throw new StepError(
        'step_conflict',
        `Step ${params.stepIndex} of run '${params.runId}' was already planned with different arguments.`,
      );
    }
    const owner = existing['attempt_id'] ? String(existing['attempt_id']) : null;
    if (owner === null) {
      const adopted = await db
        .prepare(
          `UPDATE run_steps SET attempt_id = ?, updated_at = ?
           WHERE id = ? AND attempt_id IS NULL
             AND EXISTS (
               SELECT 1 FROM agent_runs r
               JOIN workspaces w ON w.id = r.workspace_id
               WHERE r.id = ? AND r.status = 'running' AND r.attempt_id = ?
                 AND (? IS NULL OR r.lease_fence = ?)
                 AND (? IS NULL OR w.lease_fence = ?)
                 AND w.lease_owner = ? AND w.lease_attempt_id = ? AND w.lease_expires_at > ?
             )`,
        )
        .bind(
          params.attemptId,
          now,
          String(existing['id']),
          params.runId,
          params.attemptId,
          fence,
          fence,
          fence,
          fence,
          params.attemptId,
          params.attemptId,
          now,
        )
        .run();
      if ((adopted.meta.changes ?? 0) !== 1) {
        throw new StepError('stale_attempt', 'Cannot adopt step: turn is not running or lease is not held.');
      }
      return { step: { ...toStep(existing), attempt_id: params.attemptId }, replay: true, foreign: false };
    }
    return { step: toStep(existing), replay: true, foreign: owner !== params.attemptId };
  }

  const id = `stp_${crypto.randomUUID()}`;
  try {
    const inserted = await db
      .prepare(
        `INSERT INTO run_steps (id, run_id, workspace_id, step_index, tool_name, arguments_hash, arguments_json, status, attempt_id, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM agent_runs r
           JOIN workspaces w ON w.id = r.workspace_id
           WHERE r.id = ? AND r.status = 'running' AND r.attempt_id = ?
             AND (? IS NULL OR r.lease_fence = ?)
             AND (? IS NULL OR w.lease_fence = ?)
             AND w.lease_owner = ? AND w.lease_attempt_id = ? AND w.lease_expires_at > ?
         )`,
      )
      .bind(
        id,
        params.runId,
        params.workspaceId,
        params.stepIndex,
        params.toolName,
        argsHash,
        JSON.stringify(params.args ?? null),
        params.attemptId,
        now,
        now,
        params.runId,
        params.attemptId,
        fence,
        fence,
        fence,
        fence,
        params.attemptId,
        params.attemptId,
        now,
      )
      .run();
    if ((inserted.meta.changes ?? 0) !== 1) {
      throw new StepError('stale_attempt', 'Step planning rejected: turn is not running or lease is not held.');
    }
  } catch (err) {
    if (err instanceof StepError) throw err;
    if (String(err).includes('SQLITE_CONSTRAINT')) {
      throw new StepError('stale_attempt', 'Another attempt planned this step concurrently.');
    }
    throw err;
  }

  return {
    step: {
      id,
      run_id: params.runId,
      step_index: params.stepIndex,
      tool_name: params.toolName,
      status: 'planned',
      result_json: null,
      action_id: null,
      attempt_id: params.attemptId,
    },
    replay: false,
    foreign: false,
  };
}

/**
 * Adopts one step row for an attempt when the run is pinned to it (used for
 * answered-clarification re-execution and crash recovery). The run pin is the
 * authority: a stale holder's run is not pinned to it, so adoption fails.
 */
export async function adoptStep(
  db: D1Database,
  stepId: string,
  attemptId: string,
  options?: { fence?: number; nowIso?: string },
): Promise<void> {
  const now = options?.nowIso ?? new Date().toISOString();
  const fence = options?.fence ?? null;
  const adopted = await db
    .prepare(
      `UPDATE run_steps SET attempt_id = ?, updated_at = ?
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM agent_runs r
           JOIN run_steps s ON s.run_id = r.id
           JOIN workspaces w ON w.id = r.workspace_id
           WHERE s.id = ? AND r.status = 'running' AND r.attempt_id = ?
             AND (? IS NULL OR r.lease_fence = ?)
             AND (? IS NULL OR w.lease_fence = ?)
             AND w.lease_owner = ? AND w.lease_attempt_id = ? AND w.lease_expires_at > ?
         )`,
    )
    .bind(
      attemptId,
      now,
      stepId,
      stepId,
      attemptId,
      fence,
      fence,
      fence,
      fence,
      attemptId,
      attemptId,
      now,
    )
    .run();
  if ((adopted.meta.changes ?? 0) !== 1) {
    throw new StepError('stale_attempt', 'Step is owned by another attempt or turn is not running.');
  }
}

/** Conditional step transition: owned by us, run still running and pinned to us, and lease held. */
async function transitionStep(
  db: D1Database,
  stepId: string,
  attemptId: string,
  setClause: string,
  binds: Array<string | number | null>,
  options?: { fence?: number; nowIso?: string },
): Promise<void> {
  const now = options?.nowIso ?? new Date().toISOString();
  const fence = options?.fence ?? null;
  const result = await db
    .prepare(
      `UPDATE run_steps SET ${setClause}, updated_at = ?
       WHERE id = ? AND attempt_id = ?
         AND EXISTS (
           SELECT 1 FROM agent_runs r
           JOIN run_steps s ON s.run_id = r.id
           JOIN workspaces w ON w.id = r.workspace_id
           WHERE s.id = ? AND r.status = 'running' AND r.attempt_id = ?
             AND (? IS NULL OR r.lease_fence = ?)
             AND (? IS NULL OR w.lease_fence = ?)
             AND w.lease_owner = ? AND w.lease_attempt_id = ? AND w.lease_expires_at > ?
         )`,
    )
    .bind(
      ...binds,
      now,
      stepId,
      attemptId,
      stepId,
      attemptId,
      fence,
      fence,
      fence,
      fence,
      attemptId,
      attemptId,
      now,
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new StepError('stale_attempt', 'Step write rejected: turn is not running or lease is not held.');
  }
}

export async function markStepRunning(
  db: D1Database,
  stepId: string,
  attemptId: string,
  options?: { fence?: number; nowIso?: string },
): Promise<void> {
  // 'running' is allowed: after a crash the pinning successor adopts an
  // in-flight step and restarts it. 'succeeded' is allowed for answered
  // clarifications, which re-adopt a spent receipt before re-executing.
  // Attempt ownership plus the run-pin guard, not the prior status, is the
  // safety condition.
  const now = options?.nowIso ?? new Date().toISOString();
  const fence = options?.fence ?? null;
  const result = await db
    .prepare(
      `UPDATE run_steps SET status = 'running', updated_at = ?
       WHERE id = ? AND attempt_id = ? AND status IN ('planned', 'running', 'succeeded')
         AND EXISTS (
           SELECT 1 FROM agent_runs r
           JOIN run_steps s ON s.run_id = r.id
           JOIN workspaces w ON w.id = r.workspace_id
           WHERE s.id = ? AND r.status = 'running' AND r.attempt_id = ?
             AND (? IS NULL OR r.lease_fence = ?)
             AND (? IS NULL OR w.lease_fence = ?)
             AND w.lease_owner = ? AND w.lease_attempt_id = ? AND w.lease_expires_at > ?
         )`,
    )
    .bind(
      now,
      stepId,
      attemptId,
      stepId,
      attemptId,
      fence,
      fence,
      fence,
      fence,
      attemptId,
      attemptId,
      now,
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new StepError('stale_attempt', 'Step write rejected: turn is not running or lease is not held.');
  }
}

export async function completeStep(
  db: D1Database,
  stepId: string,
  attemptId: string,
  params: { resultJson: string; actionId?: string | null; fence?: number; nowIso?: string },
): Promise<void> {
  await transitionStep(
    db,
    stepId,
    attemptId,
    `status = 'succeeded', result_json = ?, action_id = ?`,
    [params.resultJson, params.actionId ?? null],
    { fence: params.fence, nowIso: params.nowIso },
  );
}

export async function failStep(
  db: D1Database,
  stepId: string,
  attemptId: string,
  errorJson: string,
  options?: { fence?: number; nowIso?: string },
): Promise<void> {
  await transitionStep(db, stepId, attemptId, `status = 'failed', result_json = ?`, [errorJson], options);
}

export async function listRunSteps(db: D1Database, runId: string): Promise<PersistedStep[]> {
  const { results } = await db
    .prepare(
      `SELECT id, run_id, step_index, tool_name, status, result_json, action_id, attempt_id
       FROM run_steps WHERE run_id = ? ORDER BY step_index ASC`,
    )
    .bind(runId)
    .all<Record<string, unknown>>();
  return results.map(toStep);
}
