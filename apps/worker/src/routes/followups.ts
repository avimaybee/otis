import { validateToolCall } from '@otis/agent';
import type { Env } from '../index.js';
import { readFollowUps } from '../entities/followups.js';
import { requireWorkspaceScope, readJsonBody } from './scope.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { commitSelectedEdit } from './entities.js';

export async function handleFollowUps(
  request: Request,
  env: Env,
  workspace: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspace, requestId, {
    csrf: request.method === 'POST',
  });
  if (scope instanceof Response) return scope;
  if (request.method === 'GET') {
    const p = new URL(request.url).searchParams;
    try {
      return jsonSuccess(
        await readFollowUps(env.DB, workspace, scope.user.id, {
          cursor: p.get('cursor') ?? undefined,
        }),
        200,
        { 'cache-control': 'no-store' },
      );
    } catch (error) {
      return jsonError(
        409,
        'followups_changed',
        error instanceof Error ? error.message : 'Refresh these follow-ups.',
        requestId,
      );
    }
  }
  const body = await readJsonBody(request);
  if (!body.ok) return jsonError(400, 'invalid_edit', 'Choose a follow-up change.', requestId);
  const { operation_id, expected_revision, args } = body.body;
  const validation = validateToolCall('change_reminder_rule', args);
  if (
    !validation.ok ||
    typeof operation_id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(operation_id) ||
    !Number.isSafeInteger(expected_revision) ||
    Number(expected_revision) < 0
  )
    return jsonError(
      400,
      'invalid_edit',
      validation.ok ? 'Use the current revision and an edit ID.' : validation.error.message,
      requestId,
    );
  const values = validation.data as Record<string, unknown>;
  if (
    !values.rule_id ||
    Object.keys(values).some((key) => !['rule_id', 'expected_revision', 'status'].includes(key))
  )
    return jsonError(
      400,
      'invalid_edit',
      'Use this control to pause, resume or cancel one existing follow-up.',
      requestId,
    );
  return commitSelectedEdit(
    env,
    workspace,
    scope.user.id,
    null,
    requestId,
    'change_reminder_rule',
    values,
    operation_id,
    Number(expected_revision),
  );
}
