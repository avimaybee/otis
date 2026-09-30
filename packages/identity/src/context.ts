/**
 * Trusted WorkspaceContext construction.
 * Ensures model/client input cannot forge identity or authority.
 */

import type { WorkspaceContext } from '@otis/contracts';
import { requireMembership } from './membership.js';

/**
 * Builds a trusted, verified WorkspaceContext for service operations.
 * Re-checks membership in D1 to prevent stale permissions authorizing requests.
 */
export async function buildWorkspaceContext(
  db: D1Database,
  params: {
    workspaceId: string;
    userId: string;
    requestId: string;
    sourceMessageId?: string;
    sourceJobId?: string;
    runId?: string;
    stepId?: string;
  },
): Promise<WorkspaceContext> {
  // 1. Verify active membership
  await requireMembership(db, params.workspaceId, params.userId);

  // 2. Fetch current workspace lease fence and membership revision
  const ws = await db
    .prepare(
      `SELECT membership_revision, lease_fence FROM workspaces WHERE id = ?`
    )
    .bind(params.workspaceId)
    .first<Record<string, unknown>>();

  const membershipRevision = ws ? Number(ws['membership_revision']) : 1;
  const fence = ws ? Number(ws['lease_fence']) : 0;

  return {
    workspace_id: params.workspaceId,
    actor: {
      kind: 'member',
      user_id: params.userId,
    },
    membership_revision: membershipRevision,
    source_message_id: params.sourceMessageId,
    source_job_id: params.sourceJobId,
    request_id: params.requestId,
    run_id: params.runId,
    step_id: params.stepId,
    fence,
  };
}
