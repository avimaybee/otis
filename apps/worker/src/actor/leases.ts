/**
 * @otis/worker/actor/leases
 * Durable workspace leases with fencing (Gate 004B).
 *
 * One workspace has at most one mutating turn at a time. The lease lives in
 * D1 (workspaces.lease_*), never only in memory: claims, renewals, and
 * releases are single conditional UPDATEs, and every business commit
 * re-verifies owner/attempt/fence/expiry inside its own transaction. A new
 * claim always increments the fence, so a holder that lost its lease can
 * never commit afterwards.
 */

export interface WorkspaceLease {
  workspace_id: string;
  attempt_id: string;
  fence: number;
  expires_at: string;
}

export class LeaseError extends Error {
  public readonly code: 'lease_unavailable' | 'lease_not_held' | 'workspace_not_found';

  constructor(
    code: 'lease_unavailable' | 'lease_not_held' | 'workspace_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'LeaseError';
    this.code = code;
  }
}

export const DEFAULT_LEASE_TTL_SECONDS = 120;

function leaseExpiresAt(nowIso: string, ttlSeconds: number): string {
  return new Date(new Date(nowIso).getTime() + ttlSeconds * 1000).toISOString();
}

async function readLease(
  db: D1Database,
  workspaceId: string,
): Promise<{ fence: number; owner: string | null; attempt: string | null; expiresAt: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT lease_owner, lease_attempt_id, lease_fence, lease_expires_at
       FROM workspaces WHERE id = ?`,
    )
    .bind(workspaceId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    fence: Number(row['lease_fence'] ?? 0),
    owner: row['lease_owner'] ? String(row['lease_owner']) : null,
    attempt: row['lease_attempt_id'] ? String(row['lease_attempt_id']) : null,
    expiresAt: row['lease_expires_at'] ? String(row['lease_expires_at']) : null,
  };
}

/**
 * Claims the workspace lease for a new attempt. Succeeds only when no live
 * lease is held; always increments the fence so prior holders go stale.
 * Returns null when another live holder exists (caller defers, not spins).
 */
export async function claimWorkspaceLease(
  db: D1Database,
  params: {
    workspaceId: string;
    attemptId: string;
    ttlSeconds?: number;
    nowIso?: string;
  },
): Promise<WorkspaceLease | null> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const ttl = params.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
  const expiresAt = leaseExpiresAt(nowIso, ttl);

  // Single conditional claim returning the fence directly: no pre-read and
  // no post-read. The returned row is the post-update state atomically, so
  // no successor can slip between a claim and a verification read. Read
  // through a one-statement batch: D1 surfaces RETURNING rows through batch
  // result sets in this runtime.
  const batched = await db.batch([
    db
      .prepare(
        `UPDATE workspaces
         SET lease_owner = ?, lease_attempt_id = ?, lease_fence = COALESCE(lease_fence, 0) + 1, lease_expires_at = ?
         WHERE id = ? AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
         RETURNING lease_fence, lease_expires_at`,
      )
      .bind(params.attemptId, params.attemptId, expiresAt, params.workspaceId, nowIso),
  ]);
  const row = (((batched[0] as unknown as { results?: Record<string, unknown>[] }).results ?? [])[0]) as
    | { lease_fence: number; lease_expires_at: string | null }
    | undefined;

  if (!row) {
    // Only the failure path reads: a missing workspace throws, a live
    // holder simply defers.
    const exists = await db
      .prepare(`SELECT 1 FROM workspaces WHERE id = ?`)
      .bind(params.workspaceId)
      .first();
    if (!exists) {
      throw new LeaseError('workspace_not_found', `Workspace '${params.workspaceId}' not found.`);
    }
    return null;
  }
  return {
    workspace_id: params.workspaceId,
    attempt_id: params.attemptId,
    fence: Number(row.lease_fence),
    expires_at: row.lease_expires_at ? String(row.lease_expires_at) : expiresAt,
  };
}

/**
 * Renews a held lease. Fails when the lease was lost or expired; the caller
 * must stop and let recovery requeue the work.
 */
export async function renewWorkspaceLease(
  db: D1Database,
  params: {
    workspaceId: string;
    attemptId: string;
    ttlSeconds?: number;
    nowIso?: string;
  },
): Promise<WorkspaceLease> {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const ttl = params.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
  const expiresAt = leaseExpiresAt(nowIso, ttl);

  const renewed = await db.batch([
    db
      .prepare(
        `UPDATE workspaces SET lease_expires_at = ?
         WHERE id = ? AND lease_owner = ? AND lease_attempt_id = ? AND lease_expires_at > ?
         RETURNING lease_fence`,
      )
      .bind(expiresAt, params.workspaceId, params.attemptId, params.attemptId, nowIso),
  ]);
  const row = (((renewed[0] as unknown as { results?: Record<string, unknown>[] }).results ?? [])[0]) as
    | { lease_fence: number }
    | undefined;

  if (!row) {
    throw new LeaseError('lease_not_held', 'Lease was lost or expired; stop and let recovery requeue.');
  }
  return {
    workspace_id: params.workspaceId,
    attempt_id: params.attemptId,
    fence: Number(row.lease_fence),
    expires_at: expiresAt,
  };
}

/**
 * Releases a held lease. Only the holding attempt can release; a no-op
 * otherwise (never clears a successor's lease).
 */
export async function releaseWorkspaceLease(
  db: D1Database,
  params: { workspaceId: string; attemptId: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE workspaces
       SET lease_owner = NULL, lease_attempt_id = NULL, lease_expires_at = NULL
       WHERE id = ? AND lease_owner = ? AND lease_attempt_id = ?`,
    )
    .bind(params.workspaceId, params.attemptId, params.attemptId)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/**
 * Reads the current lease without mutating. Used by recovery and diagnostics.
 */
export async function getWorkspaceLease(
  db: D1Database,
  workspaceId: string,
): Promise<WorkspaceLease | null> {
  const current = await readLease(db, workspaceId);
  if (!current || !current.owner || !current.attempt) return null;
  return {
    workspace_id: workspaceId,
    attempt_id: current.attempt,
    fence: current.fence,
    expires_at: current.expiresAt ?? '',
  };
}
