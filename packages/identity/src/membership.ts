/**
 * Membership verification and authorization.
 */

import type { WorkspaceMember } from '@otis/contracts';

export class MembershipError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'MembershipError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Checks if a user is an active member of a workspace.
 */
export async function checkMembership(
  db: D1Database,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMember | null> {
  const row = await db
    .prepare(
      `SELECT workspace_id, user_id, role, joined_at, created_at, updated_at
       FROM workspace_users
       WHERE workspace_id = ? AND user_id = ?`
    )
    .bind(workspaceId, userId)
    .first<Record<string, unknown>>();

  if (!row) return null;

  return {
    workspace_id: String(row['workspace_id']),
    user_id: String(row['user_id']),
    role: row['role'] === 'owner' ? 'owner' : 'member',
    joined_at: String(row['joined_at']),
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
  };
}

/**
 * Enforces that a user is a member of the workspace; throws a 404 (or 403) MembershipError if not.
 * Querying by (workspace_id, user_id) protects against out-of-scope resource access.
 */
export async function requireMembership(
  db: D1Database,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMember> {
  const member = await checkMembership(db, workspaceId, userId);
  if (!member) {
    // 404 for out-of-scope resource lookup to avoid leaking resource existence
    throw new MembershipError(
      404,
      'workspace_not_found',
      'Workspace not found or access denied.',
    );
  }
  return member;
}
