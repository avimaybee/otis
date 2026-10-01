/**
 * Run routes: author-scoped stop. Stop cancels future steps and
 * continuations; already committed actions are preserved (stop is not undo).
 */

import { stopRun, ActorError } from '../actor/dispatch.js';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { requireWorkspaceScope } from './scope.js';

export async function handleStopRun(
  request: Request,
  env: Env,
  workspaceId: string,
  runId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;

  try {
    const result = await stopRun(env.DB, {
      workspaceId,
      runId,
      actorUserId: scope.user.id,
    });
    return jsonSuccess(
      { status: 'ok', stopped: result.stopped, run_status: result.status },
      200,
      { 'x-request-id': requestId },
    );
  } catch (err) {
    if (err instanceof ActorError) {
      if (err.code === 'run_not_found') {
        return jsonError(404, err.code, err.message, requestId);
      }
      return jsonError(403, err.code, err.message, requestId);
    }
    throw err;
  }
}
