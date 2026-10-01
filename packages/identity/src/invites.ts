/**
 * Workspace Invites management.
 * Generates hashed invite tokens, binds verified emails to user IDs upon sign-in.
 */

import { AUTH_BOUNDS } from '@otis/contracts';
import { generateRandomToken, sha256 } from './crypto.js';

export class InviteError extends Error {
  public readonly code:
    | 'invite_not_found'
    | 'invite_expired'
    | 'email_mismatch'
    | 'already_accepted'
    | 'not_member';

  constructor(
    code: 'invite_not_found' | 'invite_expired' | 'email_mismatch' | 'already_accepted' | 'not_member',
    message: string,
  ) {
    super(message);
    this.name = 'InviteError';
    this.code = code;
  }
}

/**
 * Creates an invite for a specific email address to a workspace.
 */
export async function createInvite(
  db: D1Database,
  params: {
    workspaceId: string;
    invitedEmail: string;
    invitedByUserId: string;
    ttlSeconds?: number;
  },
): Promise<{ inviteId: string; token: string; expiresAt: string }> {
  const token = generateRandomToken(32);
  const tokenHash = await sha256(token);
  const inviteId = crypto.randomUUID();
  const now = new Date();
  const ttl = params.ttlSeconds ?? AUTH_BOUNDS.INVITE_TTL_SECONDS;
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
  const createdAt = now.toISOString();
  const normalizedEmail = params.invitedEmail.trim().toLowerCase();
  if (!normalizedEmail) {
    throw new InviteError('email_mismatch', 'Invite email must not be empty.');
  }

  try {
    await db.batch([
      // Guard: the inviter is still a member at commit time.
      db
        .prepare(
          `INSERT INTO lifecycle_guards (id, guard_ok)
           VALUES (?, (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?))`
        )
        .bind(crypto.randomUUID(), params.workspaceId, params.invitedByUserId),
      db
        .prepare(
          `INSERT INTO invites (id, token_hash, workspace_id, invited_email, invited_by_user_id, created_at, expires_at, accepted_at, accepted_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
        )
        .bind(
          inviteId,
          tokenHash,
          params.workspaceId,
          normalizedEmail,
          params.invitedByUserId,
          createdAt,
          expiresAt,
        ),
    ]);
  } catch (err) {
    if (isGuardFailure(err)) {
      const member = await db
        .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
        .bind(params.workspaceId, params.invitedByUserId)
        .first();
      if (!member) {
        throw new InviteError('not_member', 'Inviter is no longer a member of this workspace.');
      }
    }
    throw err;
  }

  return { inviteId, token, expiresAt };
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
 * Accepts an invite for an authenticated user whose verified email matches the invite.
 * Runs atomically in a single D1 batch.
 */
export async function acceptInvite(
  db: D1Database,
  params: {
    token: string;
    userId: string;
    userEmail: string;
  },
): Promise<{ workspaceId: string; inviteId: string }> {
  const tokenHash = await sha256(params.token);
  const nowIso = new Date().toISOString();

  const invite = await db
    .prepare(
      `SELECT id, workspace_id, invited_email, expires_at, accepted_at
       FROM invites
       WHERE token_hash = ?`
    )
    .bind(tokenHash)
    .first<Record<string, unknown>>();

  if (!invite) {
    throw new InviteError('invite_not_found', 'Invite code is invalid.');
  }

  if (invite['accepted_at']) {
    throw new InviteError('already_accepted', 'Invite code has already been used.');
  }

  if (String(invite['expires_at']) <= nowIso) {
    throw new InviteError('invite_expired', 'Invite code has expired.');
  }

  const invitedEmail = String(invite['invited_email']).trim().toLowerCase();
  const userEmail = params.userEmail.trim().toLowerCase();

  if (invitedEmail !== userEmail) {
    throw new InviteError(
      'email_mismatch',
      `Invite was issued to ${invitedEmail}, but signed-in account is ${userEmail}.`,
    );
  }

  const workspaceId = String(invite['workspace_id']);
  const inviteId = String(invite['id']);
  const auditId = crypto.randomUUID();

  // Atomically claim the invite with strict guard, update invite, add membership, and update revision
  try {
    await db.batch([
      // 1. Transaction Guard: Must insert into invite_redemptions.
      // If already redeemed, PRIMARY KEY constraint aborts the batch.
      // If expired or accepted concurrently, guard_ok evaluates to NULL, which aborts the batch via CHECK(guard_ok=1).
      db
        .prepare(
          `INSERT INTO invite_redemptions (invite_id, user_id, redeemed_at, guard_ok)
           VALUES (
             ?,
             ?,
             ?,
             (SELECT 1 FROM invites WHERE id = ? AND accepted_at IS NULL AND expires_at > ?)
           )`
        )
        .bind(inviteId, params.userId, nowIso, inviteId, nowIso),
      // 2. Mark invite accepted
      db
        .prepare(
          `UPDATE invites
           SET accepted_at = ?, accepted_by_user_id = ?
           WHERE id = ?`
        )
        .bind(nowIso, params.userId, inviteId),
      // 3. Add member to workspace
      db
        .prepare(
          `INSERT OR IGNORE INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
           VALUES (?, ?, 'member', ?, ?, ?)`
        )
        .bind(workspaceId, params.userId, nowIso, nowIso, nowIso),
      // 4. Increment membership_revision
      db
        .prepare(
          `UPDATE workspaces
           SET membership_revision = membership_revision + 1, updated_at = ?
           WHERE id = ?`
        )
        .bind(nowIso, workspaceId),
      // 5. Audit record
      db
        .prepare(
          `INSERT INTO membership_audit (id, workspace_id, user_id, actor_user_id, action, occurred_at, details)
           VALUES (?, ?, ?, ?, 'joined', ?, ?)`
        )
        .bind(
          auditId,
          workspaceId,
          params.userId,
          params.userId,
          nowIso,
          JSON.stringify({ invite_id: inviteId }),
        ),
    ]);
  } catch (err) {
    const errStr = String(err);
    if (
      errStr.includes('SQLITE_CONSTRAINT') ||
      errStr.includes('guard_ok') ||
      errStr.includes('PRIMARY KEY')
    ) {
      throw new InviteError(
        'already_accepted',
        'Invite has already been accepted or is no longer valid.',
      );
    }
    throw err;
  }

  return { workspaceId, inviteId };
}
