/**
 * Workspace routes: GET /api/workspaces/:workspaceId
 */

import type { WorkspaceDetailResponse } from '@otis/contracts';
import {
  extractSessionToken,
  verifySession,
  checkMembership,
  getWorkspace,
  validateCsrfAndOrigin,
  createWorkspace,
  updateWorkspaceName,
  deleteWorkspace,
} from '@otis/identity';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { collectErasureR2Inventory, erasurePrefixes, runErasureR2Cleanup, storeErasureCleanup } from './erasureCleanup.js';
import { readJsonBody, requireWorkspaceScope } from './scope.js';

export async function handleGetWorkspace(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const token = extractSessionToken(request);
  if (!token) {
    return jsonError(401, 'unauthorized', 'Authentication session required.', requestId);
  }

  const verified = await verifySession(env.DB, token);
  if (!verified) {
    return jsonError(401, 'session_expired', 'Session is invalid or expired.', requestId);
  }

  // Enforce membership check; 404 for out-of-scope lookups
  const membership = await checkMembership(env.DB, workspaceId, verified.user.id);
  if (!membership) {
    return jsonError(
      404,
      'workspace_not_found',
      'Workspace not found or access denied.',
      requestId,
    );
  }

  const workspace = await getWorkspace(env.DB, workspaceId);
  if (!workspace) {
    return jsonError(
      404,
      'workspace_not_found',
      'Workspace not found or access denied.',
      requestId,
    );
  }

  const responseBody: WorkspaceDetailResponse = {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      role: membership.role,
      business_revision: workspace.business_revision,
      created_at: workspace.created_at,
    },
  };

  return jsonSuccess(responseBody, 200, { 'x-request-id': requestId });
}

export async function handleCreateWorkspace(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  if (!validateCsrfAndOrigin(request)) {
    return jsonError(403, 'csrf_violation', 'Cross-origin request rejected.', requestId);
  }
  const token = extractSessionToken(request);
  if (!token) {
    return jsonError(401, 'unauthorized', 'Authentication session required.', requestId);
  }

  const verified = await verifySession(env.DB, token);
  if (!verified) {
    return jsonError(401, 'session_expired', 'Session is invalid or expired.', requestId);
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok || typeof parsed.body['name'] !== 'string' || !parsed.body['name'].trim()) {
    return jsonError(422, 'invalid_payload', 'A valid workspace name is required.', requestId);
  }

  const name = parsed.body['name'].trim();
  try {
    const ws = await createWorkspace(env.DB, { name, ownerUserId: verified.user.id });
    return jsonSuccess({ workspace: ws }, 201, { 'x-request-id': requestId });
  } catch (err) {
    return jsonError(400, 'workspace_creation_failed', err instanceof Error ? err.message : String(err), requestId);
  }
}

export async function handleUpdateWorkspace(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;

  const parsed = await readJsonBody(request);
  if (!parsed.ok || typeof parsed.body['name'] !== 'string' || !parsed.body['name'].trim()) {
    return jsonError(422, 'invalid_payload', 'A valid workspace name is required.', requestId);
  }

  try {
    const ws = await updateWorkspaceName(env.DB, {
      workspaceId,
      name: parsed.body['name'].trim(),
      actorUserId: scope.user.id,
    });
    return jsonSuccess({ workspace: ws }, 200, { 'x-request-id': requestId });
  } catch (err) {
    return jsonError(403, 'workspace_update_failed', err instanceof Error ? err.message : String(err), requestId);
  }
}

export async function handleDeleteWorkspace(
  request: Request,
  env: Env,
  workspaceId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;
  // Owner gate before anything destructive: the D1 cascade rechecks, but no
  // R2 byte is touched until ownership is established here.
  if (scope.membership.role !== 'owner') {
    return jsonError(403, 'workspace_delete_failed', 'not_owner', requestId);
  }

  try {
    // Inventory R2 keys before the rows go (read-only): originals plus
    // deterministic inference renditions plus generated-document source keys
    // (draft, Markdown source, structured manifest). The D1 cascade commits
    // first with the cleanup intent in the same transaction — globally-keyed
    // rendition keys the sweeps cannot rediscover, plus the workspace-owned
    // prefixes — so a crash any time after the commit still leaves a
    // discoverable cron retry. Bytes delete after; leftovers reconcile the
    // record instead of vanishing with the inventory rows.
    const inventory = await collectErasureR2Inventory(env.DB, workspaceId);
    const globalKeys = inventory.keys.filter(
      (key) => !key.startsWith(`workspace/${workspaceId}/`) && !key.startsWith(`${workspaceId}/`),
    );
    // Outstanding render attempt keys are captured inside the erasure batch
    // itself (see deleteWorkspace), not from a pre-commit read: an attempt
    // that registers between this inventory and the commit is still
    // preserved, including superseded attempts with surviving rows.
    const result = await deleteWorkspace(env.DB, {
      workspaceId,
      actorUserId: scope.user.id,
      r2CleanupIntent: { failedKeys: globalKeys, pendingPrefixes: erasurePrefixes(workspaceId) },
    });
    // The cascade is committed from here: post-commit failures must report
    // the committed erasure with truthful pending status, never a refusal.
    try {
      const intentPrefixes = erasurePrefixes(workspaceId);
      const prevState = {
        erasureId: result.erasureId,
        failedKeys: globalKeys,
        pendingPrefixes: intentPrefixes,
        attemptKeys: [] as { key: string; deleteAfter: string }[],
        rawKeysJson: JSON.stringify(globalKeys),
        rawPrefixesJson: JSON.stringify(intentPrefixes),
        rawAttemptKeysJson: '[]',
      };
      let r2Cleanup: { deleted: number; failed_total: number; failed_sample: string[]; pending: boolean } = {
        deleted: 0, failed_total: 0, failed_sample: [], pending: false,
      };
      if (env.STORAGE) {
        const outcome = await runErasureR2Cleanup(env.STORAGE, workspaceId, inventory);
        // Pending reflects the reconciled durable state, not just this
        // pass: merged concurrent appends keep the row alive.
        const reconciled = await storeErasureCleanup(env.DB, {
          workspaceId,
          erasureId: result.erasureId,
          prev: prevState,
          failedKeys: outcome.failedKeys,
          pendingPrefixes: outcome.pendingPrefixes,
        });
        const pending = !reconciled.reconciled || reconciled.failedKeys.length > 0 ||
          reconciled.pendingPrefixes.length > 0 || reconciled.attemptKeys.length > 0;
        r2Cleanup = {
          deleted: outcome.deleted,
          failed_total: reconciled.failedKeys.length,
          failed_sample: reconciled.failedKeys.slice(0, 20),
          pending,
        };
      } else {
        r2Cleanup = { deleted: 0, failed_total: 0, failed_sample: [], pending: true };
      }
      return jsonSuccess({ ...result, r2_cleanup: r2Cleanup }, 200, { 'x-request-id': requestId });
    } catch (postErr) {
      // D1 committed; only byte cleanup or its bookkeeping failed. The
      // in-transaction intent still owns the retry — report it as pending.
      return jsonSuccess({
        ...result,
        r2_cleanup: {
          deleted: 0,
          failed_total: 0,
          failed_sample: [],
          pending: true,
          error: postErr instanceof Error ? postErr.message : String(postErr),
        },
      }, 200, { 'x-request-id': requestId });
    }
  } catch (err) {
    return jsonError(403, 'workspace_delete_failed', err instanceof Error ? err.message : String(err), requestId);
  }
}
