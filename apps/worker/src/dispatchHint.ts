/**
 * Immediate dispatch wake-ups.
 *
 * Acceptance commits the message, run, and outbox row in D1 and returns 202;
 * the agent turn itself runs asynchronously. This publishes a best-effort hint
 * to `otis-dispatch` so the queue consumer picks the workspace up within
 * seconds instead of waiting for the 5-minute cron sweep.
 *
 * Hints are never load-bearing: dispatch claims outbox rows atomically, so a
 * repeated or lost hint is harmless and the cron remains the backstop. A
 * failed publish must never fail acceptance — the work is already durable.
 */

import type { Env } from './index.js';
import { workerDebug, workerFailure } from './observability.js';

export function publishDispatchHint(ctx: ExecutionContext | undefined, env: Env, workspaceId: string): void {
  if (!ctx || !env.DISPATCH_QUEUE) {
    workerDebug('dispatch', 'no queue binding; cron remains the backstop', { workspaceId });
    return;
  }
  ctx.waitUntil(
    (async () => {
      try {
        await env.DISPATCH_QUEUE!.send({ workspace_id: workspaceId });
        workerDebug('dispatch', 'wake-up published', { workspaceId });
      } catch (err) {
        workerFailure('dispatch', 'wake-up publish failed; cron remains the backstop', {
          workspaceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })(),
  );
}

/**
 * Best-effort Telegram delivery wake-up. The delivery row is already
 * durable; a lost hint is covered by the cron sweep. Workspace-less
 * administrative rows publish an empty scope so the consumer scans all
 * workspaces.
 */
export function publishTelegramDeliveryHint(
  ctx: ExecutionContext | undefined,
  env: Env,
  workspaceId?: string,
): void {
  if (!ctx || !env.DISPATCH_QUEUE) {
    workerDebug('dispatch', 'no queue binding; cron remains the Telegram delivery backstop', {
      workspaceId: workspaceId ?? '',
    });
    return;
  }
  ctx.waitUntil(
    (async () => {
      try {
        await env.DISPATCH_QUEUE!.send({ kind: 'telegram_delivery', workspace_id: workspaceId ?? '' });
      } catch (err) {
        workerFailure('dispatch', 'Telegram delivery wake-up publish failed; cron remains the backstop', {
          workspaceId: workspaceId ?? '',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })(),
  );
}