/**
 * Workspace lifecycle: remove, leave, and ownership transfer.
 * All mutations re-verify preconditions inside the committing D1 batch via
 * lifecycle_guards (guard_ok CHECK pattern), so concurrent lifecycle races
 * abort atomically instead of silently violating owner/last-member rules.
 */

import type { WorkspaceMember } from '@otis/contracts';
import { checkMembership } from './membership.js';

export type LifecycleErrorCode =
  | 'workspace_not_found'
  | 'not_member'
  | 'not_owner'
  | 'cannot_remove_owner'
  | 'owner_must_transfer'
  | 'last_member'
  | 'target_not_member'
  | 'concurrent_change';

export class LifecycleError extends Error {
  public readonly code: LifecycleErrorCode;

  constructor(code: LifecycleErrorCode, message: string) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
  }
}

export interface LifecycleResult {
  workspace_id: string;
  affected_user_id: string;
  membership_revision: number;
}

async function getMembershipRevision(db: D1Database, workspaceId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT membership_revision FROM workspaces WHERE id = ?`)
    .bind(workspaceId)
    .first<Record<string, unknown>>();
  return Number(row?.['membership_revision'] ?? 1);
}

async function countMembers(db: D1Database, workspaceId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM workspace_users WHERE workspace_id = ?`)
    .bind(workspaceId)
    .first<Record<string, unknown>>();
  return Number(row?.['n'] ?? 0);
}

function isGuardFailure(err: unknown): boolean {
  const s = String(err);
  return (
    s.includes('SQLITE_CONSTRAINT') ||
    s.includes('guard_ok') ||
    s.includes('PRIMARY KEY')
  );
}

/**
 * Removes a member from a workspace. Any current member may remove another
 * member, but nobody can remove the recorded owner and the last member
 * cannot disappear. Removal also clears the member's Telegram workspace
 * selection so routed Telegram input stops immediately.
 */
export async function removeMember(
  db: D1Database,
  params: { workspaceId: string; actorUserId: string; targetUserId: string },
): Promise<LifecycleResult> {
  const { workspaceId, actorUserId, targetUserId } = params;
  const nowIso = new Date().toISOString();

  const actor = await checkMembership(db, workspaceId, actorUserId);
  if (!actor) {
    throw new LifecycleError('not_member', 'Caller is not a member of this workspace.');
  }
  const target = await checkMembership(db, workspaceId, targetUserId);
  if (!target) {
    throw new LifecycleError('target_not_member', 'Target user is not a member of this workspace.');
  }
  if (target.role === 'owner') {
    throw new LifecycleError('cannot_remove_owner', 'The workspace owner cannot be removed by another member.');
  }
  if ((await countMembers(db, workspaceId)) <= 1) {
    throw new LifecycleError('last_member', 'The last member cannot be removed.');
  }

  const guardId = `guard_life_remove_${workspaceId}`;
  const auditId = crypto.randomUUID();
  try {
    await db.batch([
      // Guard: actor still a member, target still a non-owner member, >1 member.
      db
        .prepare(
          `INSERT INTO lifecycle_guards (id, guard_ok)
           VALUES (?, (
             SELECT 1
             FROM workspace_users a, workspace_users t
             WHERE a.workspace_id = ? AND a.user_id = ?
               AND t.workspace_id = ? AND t.user_id = ? AND t.role = 'member'
               AND (SELECT COUNT(*) FROM workspace_users WHERE workspace_id = ?) > 1
           ))
           ON CONFLICT(id) DO UPDATE SET guard_ok = excluded.guard_ok`
        )
        .bind(guardId, workspaceId, actorUserId, workspaceId, targetUserId, workspaceId),
      db
        .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
        .bind(workspaceId, targetUserId),
      db
        .prepare(
          `UPDATE workspaces SET membership_revision = membership_revision + 1, updated_at = ? WHERE id = ?`
        )
        .bind(nowIso, workspaceId),
      db
        .prepare(
          `INSERT INTO membership_audit (id, workspace_id, user_id, actor_user_id, action, occurred_at, details)
           VALUES (?, ?, ?, ?, 'removed', ?, ?)`
        )
        .bind(auditId, workspaceId, targetUserId, actorUserId, nowIso, JSON.stringify({})),
      // Invalidate Telegram routing for the removed member.
      db
        .prepare(
          `UPDATE telegram_users SET selected_workspace_id = NULL, active_chat_id = NULL, updated_at = ?
           WHERE user_id = ? AND selected_workspace_id = ?`
        )
        .bind(nowIso, targetUserId, workspaceId),
    ]);
  } catch (err) {
    if (isGuardFailure(err)) {
      throw await classifyRemovalFailure(db, workspaceId, actorUserId, targetUserId);
    }
    throw err;
  }

  return {
    workspace_id: workspaceId,
    affected_user_id: targetUserId,
    membership_revision: await getMembershipRevision(db, workspaceId),
  };
}

async function classifyRemovalFailure(
  db: D1Database,
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
): Promise<LifecycleError> {
  const actor = await checkMembership(db, workspaceId, actorUserId);
  if (!actor) return new LifecycleError('not_member', 'Caller is no longer a member.');
  const target = await checkMembership(db, workspaceId, targetUserId);
  if (!target) return new LifecycleError('target_not_member', 'Target is no longer a member.');
  if (target.role === 'owner') {
    return new LifecycleError('cannot_remove_owner', 'The workspace owner cannot be removed by another member.');
  }
  if ((await countMembers(db, workspaceId)) <= 1) {
    return new LifecycleError('last_member', 'The last member cannot be removed.');
  }
  return new LifecycleError('concurrent_change', 'Membership changed concurrently; retry the operation.');
}

/**
 * A member leaves a workspace voluntarily. The owner cannot leave while
 * owning: they must transfer ownership first. The last member cannot leave.
 */
export async function leaveWorkspace(
  db: D1Database,
  params: { workspaceId: string; userId: string },
): Promise<LifecycleResult> {
  const { workspaceId, userId } = params;
  const self = await checkMembership(db, workspaceId, userId);
  if (!self) {
    throw new LifecycleError('not_member', 'Caller is not a member of this workspace.');
  }
  if (self.role === 'owner') {
    throw new LifecycleError(
      'owner_must_transfer',
      'The owner must transfer ownership to a current member before leaving.',
    );
  }
  return removeMember(db, { workspaceId, actorUserId: userId, targetUserId: userId });
}

/**
 * Transfers the owner marker to a current member. Only the current owner
 * can initiate the transfer. The guard pins the transfer to the observed
 * owner so concurrent transfers abort instead of interleaving roles.
 */
export async function transferOwnership(
  db: D1Database,
  params: { workspaceId: string; actorUserId: string; newOwnerUserId: string },
): Promise<LifecycleResult> {
  const { workspaceId, actorUserId, newOwnerUserId } = params;
  const nowIso = new Date().toISOString();

  const actor = await checkMembership(db, workspaceId, actorUserId);
  if (!actor) {
    throw new LifecycleError('not_member', 'Caller is not a member of this workspace.');
  }
  if (actor.role !== 'owner') {
    throw new LifecycleError('not_owner', 'Only the current owner can transfer ownership.');
  }
  const target = await checkMembership(db, workspaceId, newOwnerUserId);
  if (!target) {
    throw new LifecycleError('target_not_member', 'New owner must be a current member.');
  }

  const guardId = `guard_life_transfer_${workspaceId}`;
  const auditId = crypto.randomUUID();
  try {
    await db.batch([
      // Guard: actor is still the recorded owner and target still a member.
      db
        .prepare(
          `INSERT INTO lifecycle_guards (id, guard_ok)
           VALUES (?, (
             SELECT 1
             FROM workspaces w, workspace_users a, workspace_users t
             WHERE w.id = ? AND w.owner_user_id = ?
               AND a.workspace_id = ? AND a.user_id = ?
               AND t.workspace_id = ? AND t.user_id = ?
           ))
           ON CONFLICT(id) DO UPDATE SET guard_ok = excluded.guard_ok`
        )
        .bind(guardId, workspaceId, actorUserId, workspaceId, actorUserId, workspaceId, newOwnerUserId),
      db
        .prepare(
          `UPDATE workspaces SET owner_user_id = ?, membership_revision = membership_revision + 1, updated_at = ? WHERE id = ?`
        )
        .bind(newOwnerUserId, nowIso, workspaceId),
      db
        .prepare(`UPDATE workspace_users SET role = 'member', updated_at = ? WHERE workspace_id = ? AND user_id = ?`)
        .bind(nowIso, workspaceId, actorUserId),
      db
        .prepare(`UPDATE workspace_users SET role = 'owner', updated_at = ? WHERE workspace_id = ? AND user_id = ?`)
        .bind(nowIso, workspaceId, newOwnerUserId),
      db
        .prepare(
          `INSERT INTO membership_audit (id, workspace_id, user_id, actor_user_id, action, occurred_at, details)
           VALUES (?, ?, ?, ?, 'transferred_owner', ?, ?)`
        )
        .bind(auditId, workspaceId, newOwnerUserId, actorUserId, nowIso, JSON.stringify({ previous_owner: actorUserId })),
    ]);
  } catch (err) {
    if (isGuardFailure(err)) {
      const current = await checkMembership(db, workspaceId, actorUserId);
      if (!current || current.role !== 'owner') {
        throw new LifecycleError(
          'concurrent_change',
          'Ownership changed concurrently; this transfer was not applied.',
        );
      }
      throw new LifecycleError('concurrent_change', 'Ownership changed concurrently; retry the operation.');
    }
    throw err;
  }

  return {
    workspace_id: workspaceId,
    affected_user_id: newOwnerUserId,
    membership_revision: await getMembershipRevision(db, workspaceId),
  };
}

/**
 * Lists current members of a workspace for lifecycle management.
 */
export async function listMembers(
  db: D1Database,
  workspaceId: string,
): Promise<WorkspaceMember[]> {
  const { results } = await db
    .prepare(
      `SELECT wu.workspace_id, wu.user_id, wu.role, wu.joined_at, wu.created_at, wu.updated_at,
              u.display_name, u.email
       FROM workspace_users wu
       LEFT JOIN users u ON wu.user_id = u.id
       WHERE wu.workspace_id = ? ORDER BY wu.joined_at ASC`
    )
    .bind(workspaceId)
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    workspace_id: String(r['workspace_id']),
    user_id: String(r['user_id']),
    role: r['role'] === 'owner' ? 'owner' : 'member',
    joined_at: String(r['joined_at']),
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at']),
    display_name: r['display_name'] ? String(r['display_name']) : null,
    email: r['email'] ? String(r['email']) : null,
  }));
}
