/**
 * Workspace and User management.
 * Provides idempotent bootstrap and repository lookups.
 */

import type { User, Workspace, WorkspaceSummary } from '@otis/contracts';

/**
 * Retrieves a user by Firebase UID or creates a new user if not found.
 */
export async function getOrCreateUser(
  db: D1Database,
  params: {
    firebaseUid: string;
    email?: string | null;
    displayName?: string | null;
  },
): Promise<User> {
  const existing = await db
    .prepare(
      `SELECT id, firebase_uid, email, display_name, created_at, updated_at
       FROM users WHERE firebase_uid = ?`
    )
    .bind(params.firebaseUid)
    .first<Record<string, unknown>>();

  const nowIso = new Date().toISOString();

  if (existing) {
    const user: User = {
      id: String(existing['id']),
      firebase_uid: String(existing['firebase_uid']),
      email: existing['email'] ? String(existing['email']) : null,
      display_name: existing['display_name'] ? String(existing['display_name']) : null,
      created_at: String(existing['created_at']),
      updated_at: String(existing['updated_at']),
    };

    // Update email or display name if updated in Firebase
    if (
      (params.email !== undefined && params.email !== user.email) ||
      (params.displayName !== undefined && params.displayName !== user.display_name)
    ) {
      await db
        .prepare(
          `UPDATE users SET email = ?, display_name = ?, updated_at = ? WHERE id = ?`
        )
        .bind(
          params.email ?? user.email,
          params.displayName ?? user.display_name,
          nowIso,
          user.id,
        )
        .run();
      user.email = params.email ?? user.email;
      user.display_name = params.displayName ?? user.display_name;
      user.updated_at = nowIso;
    }

    return user;
  }

  // Create new user
  const newId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      newId,
      params.firebaseUid,
      params.email ?? null,
      params.displayName ?? null,
      nowIso,
      nowIso,
    )
    .run();

  return {
    id: newId,
    firebase_uid: params.firebaseUid,
    email: params.email ?? null,
    display_name: params.displayName ?? null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

/**
 * Idempotently bootstraps a workspace and owner user in a single atomic transaction.
 * Safe against foreign key constraints: user is ensured first, then workspace, then membership.
 */
export async function bootstrapWorkspace(
  db: D1Database,
  params: {
    workspaceId: string;
    workspaceName: string;
    ownerUid: string;
    ownerEmail?: string | null;
    ownerDisplayName?: string | null;
  },
): Promise<{ workspace: Workspace; owner: User }> {
  const nowIso = new Date().toISOString();

  if (!params.ownerUid || !params.ownerUid.trim()) {
    throw new Error('Bootstrap requires an explicit ownerUid.');
  }

  // 1. Check or create owner user
  const owner = await getOrCreateUser(db, {
    firebaseUid: params.ownerUid,
    email: params.ownerEmail,
    displayName: params.ownerDisplayName,
  });

  // 2. Check if workspace exists
  const existingWs = await db
    .prepare(
      `SELECT id, name, owner_user_id, business_revision, membership_revision, lease_owner,
              lease_attempt_id, lease_fence, lease_expires_at, created_at, updated_at
       FROM workspaces WHERE id = ?`
    )
    .bind(params.workspaceId)
    .first<Record<string, unknown>>();

  if (existingWs) {
    // If workspace already exists, verify that the caller is the registered owner.
    // Routine login or other users must NEVER be granted ownership or membership through bootstrap.
    if (existingWs['owner_user_id'] !== owner.id) {
      throw new Error(`Workspace '${params.workspaceId}' already exists with a different owner.`);
    }

    return {
      workspace: {
        id: String(existingWs['id']),
        name: String(existingWs['name']),
        owner_user_id: String(existingWs['owner_user_id']),
        business_revision: Number(existingWs['business_revision']),
        membership_revision: Number(existingWs['membership_revision'] ?? 1),
        lease_owner: existingWs['lease_owner'] ? String(existingWs['lease_owner']) : null,
        lease_attempt_id: existingWs['lease_attempt_id'] ? String(existingWs['lease_attempt_id']) : null,
        lease_fence: Number(existingWs['lease_fence']),
        lease_expires_at: existingWs['lease_expires_at'] ? String(existingWs['lease_expires_at']) : null,
        created_at: String(existingWs['created_at']),
        updated_at: String(existingWs['updated_at']),
      },
      owner,
    };
  }

  // 3. Atomically create workspace, membership, and audit entry in one batch
  const auditId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, lease_fence, created_at, updated_at)
         VALUES (?, ?, ?, 0, 1, 0, ?, ?)`
      )
      .bind(params.workspaceId, params.workspaceName, owner.id, nowIso, nowIso),
    db
      .prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
         VALUES (?, ?, 'owner', ?, ?, ?)`
      )
      .bind(params.workspaceId, owner.id, nowIso, nowIso, nowIso),
    db
      .prepare(
        `INSERT INTO membership_audit (id, workspace_id, user_id, actor_user_id, action, occurred_at, details)
         VALUES (?, ?, ?, ?, 'created', ?, ?)`
      )
      .bind(
        auditId,
        params.workspaceId,
        owner.id,
        owner.id,
        nowIso,
        JSON.stringify({ reason: 'bootstrap' }),
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO workspace_settings (workspace_id, default_model, created_at, updated_at)
         VALUES (?, 'gemini-3.5-flash-lite', ?, ?)`
      )
      .bind(params.workspaceId, nowIso, nowIso),
  ]);

  return {
    workspace: {
      id: params.workspaceId,
      name: params.workspaceName,
      owner_user_id: owner.id,
      business_revision: 0,
      membership_revision: 1,
      lease_owner: null,
      lease_attempt_id: null,
      lease_fence: 0,
      lease_expires_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    },
    owner,
  };
}

/**
 * Retrieves a workspace by ID.
 */
export async function getWorkspace(
  db: D1Database,
  workspaceId: string,
): Promise<Workspace | null> {
  const row = await db
    .prepare(
      `SELECT id, name, owner_user_id, business_revision, membership_revision, lease_owner,
              lease_attempt_id, lease_fence, lease_expires_at, created_at, updated_at
       FROM workspaces WHERE id = ?`
    )
    .bind(workspaceId)
    .first<Record<string, unknown>>();

  if (!row) return null;

  return {
    id: String(row['id']),
    name: String(row['name']),
    owner_user_id: row['owner_user_id'] ? String(row['owner_user_id']) : null,
    business_revision: Number(row['business_revision']),
    membership_revision: Number(row['membership_revision'] ?? 1),
    lease_owner: row['lease_owner'] ? String(row['lease_owner']) : null,
    lease_attempt_id: row['lease_attempt_id'] ? String(row['lease_attempt_id']) : null,
    lease_fence: Number(row['lease_fence']),
    lease_expires_at: row['lease_expires_at'] ? String(row['lease_expires_at']) : null,
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
  };
}

/**
 * Lists all workspaces a user is a member of.
 */
export async function getUserWorkspaces(
  db: D1Database,
  userId: string,
): Promise<WorkspaceSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT w.id, w.name, wu.role, wu.joined_at
       FROM workspaces w
       JOIN workspace_users wu ON w.id = wu.workspace_id
       WHERE wu.user_id = ?
       ORDER BY wu.joined_at ASC`
    )
    .bind(userId)
    .all<Record<string, unknown>>();

  return results.map((r) => ({
    id: String(r['id']),
    name: String(r['name']),
    role: r['role'] === 'owner' ? 'owner' : 'member',
    joined_at: String(r['joined_at']),
  }));
}

/**
 * Creates a new workspace authored by the given user.
 */
export async function createWorkspace(
  db: D1Database,
  params: {
    name: string;
    ownerUserId: string;
    workspaceId?: string;
  },
): Promise<Workspace> {
  const name = (params.name || '').trim();
  if (!name || name.length > 100) {
    throw new Error('Workspace name must be 1–100 characters.');
  }
  const workspaceId = params.workspaceId || `ws_${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();
  const auditId = crypto.randomUUID();

  await db.batch([
    db
      .prepare(
        `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, lease_fence, created_at, updated_at)
         VALUES (?, ?, ?, 0, 1, 0, ?, ?)`
      )
      .bind(workspaceId, name, params.ownerUserId, nowIso, nowIso),
    db
      .prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
         VALUES (?, ?, 'owner', ?, ?, ?)`
      )
      .bind(workspaceId, params.ownerUserId, nowIso, nowIso, nowIso),
    db
      .prepare(
        `INSERT INTO workspace_settings (workspace_id, default_model, created_at, updated_at)
         VALUES (?, 'gemini-3.5-flash-lite', ?, ?)`
      )
      .bind(workspaceId, nowIso, nowIso),
    db
      .prepare(
        `INSERT INTO membership_audit (id, workspace_id, user_id, actor_user_id, action, occurred_at, details)
         VALUES (?, ?, ?, ?, 'created', ?, ?)`
      )
      .bind(
        auditId,
        workspaceId,
        params.ownerUserId,
        params.ownerUserId,
        nowIso,
        JSON.stringify({ reason: 'user_created' }),
      ),
  ]);

  return {
    id: workspaceId,
    name,
    owner_user_id: params.ownerUserId,
    business_revision: 0,
    membership_revision: 1,
    lease_owner: null,
    lease_attempt_id: null,
    lease_fence: 0,
    lease_expires_at: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

/**
 * Renames an existing workspace (owner only).
 */
export async function updateWorkspaceName(
  db: D1Database,
  params: {
    workspaceId: string;
    name: string;
    actorUserId: string;
  },
): Promise<Workspace> {
  const name = (params.name || '').trim();
  if (!name || name.length > 100) {
    throw new Error('Workspace name must be 1–100 characters.');
  }
  const membership = await db
    .prepare(`SELECT role FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
    .bind(params.workspaceId, params.actorUserId)
    .first<{ role: string }>();
  if (!membership) throw new Error('not_member');
  if (membership.role !== 'owner') throw new Error('not_owner');

  const nowIso = new Date().toISOString();
  await db
    .prepare(`UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?`)
    .bind(name, nowIso, params.workspaceId)
    .run();

  const ws = await getWorkspace(db, params.workspaceId);
  if (!ws) throw new Error('not_found');
  return ws;
}

/**
 * Permanently deletes a workspace and its data (owner only).
 */
export async function deleteWorkspace(
  db: D1Database,
  params: {
    workspaceId: string;
    actorUserId: string;
  },
): Promise<{ deleted: boolean }> {
  const membership = await db
    .prepare(`SELECT role FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
    .bind(params.workspaceId, params.actorUserId)
    .first<{ role: string }>();
  if (!membership) throw new Error('not_member');
  if (membership.role !== 'owner') throw new Error('not_owner');

  await db.batch([
    db.prepare(`DELETE FROM chat_messages WHERE workspace_id = ?`).bind(params.workspaceId),
    db.prepare(`DELETE FROM messages_in WHERE workspace_id = ?`).bind(params.workspaceId),
    db.prepare(`DELETE FROM run_activity WHERE workspace_id = ?`).bind(params.workspaceId),
    db.prepare(`DELETE FROM agent_runs WHERE workspace_id = ?`).bind(params.workspaceId),
    db.prepare(`DELETE FROM chats WHERE workspace_id = ?`).bind(params.workspaceId),
    db.prepare(`DELETE FROM provider_credentials WHERE workspace_id = ?`).bind(params.workspaceId),
    db.prepare(`DELETE FROM workspace_settings WHERE workspace_id = ?`).bind(params.workspaceId),
    db.prepare(`DELETE FROM workspace_users WHERE workspace_id = ?`).bind(params.workspaceId),
    db.prepare(`DELETE FROM workspaces WHERE id = ?`).bind(params.workspaceId),
  ]);

  return { deleted: true };
}

