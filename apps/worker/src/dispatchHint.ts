/**
 * Immediate dispatch wake-ups.
 *
 * Acceptance commits the message, run, and outbox row in D1 and returns 202;
 * the agent turn itself runs asynchronously inside the workspace actor, which
 * owns the same live SSE subscribers. This wakes that actor directly so a
 * greeting does not wait for Queue batching.
 *
 * Hints are never load-bearing: dispatch claims outbox rows atomically, so a
 * repeated or lost hint is harmless and the cron remains the backstop. A
 * failed wake-up must never fail acceptance — the work is already durable.
 * The Queue binding remains only for delayed continuations and as a fallback
 * when no actor binding exists.
 */

import type { Env } from './index.js';
import { workerDebug, workerFailure } from './observability.js';

async function wakeWorkspaceActor(env: Env, workspaceId: string): Promise<void> {
  const actorId = env.WORKSPACE_ACTOR!.idFromName(workspaceId);
  const stub = env.WORKSPACE_ACTOR!.get(actorId);
  // Async actor wake: the actor acks fast and continues via its own
  // state.waitUntil, so this waitUntil never holds the Worker past its
  // post-response lifetime for a long model turn.
  await stub.fetch(new Request('http://actor/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'dispatch', workspace_id: workspaceId, budget: 5 }),
  }));
}

export function publishDispatchHint(ctx: ExecutionContext | undefined, env: Env, workspaceId: string): void {
  if (env.WORKSPACE_ACTOR && ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await wakeWorkspaceActor(env, workspaceId);
          workerDebug('dispatch', 'wake-up dispatched via actor', { workspaceId });
        } catch (err) {
          workerFailure('dispatch', 'actor dispatch failed; cron remains backstop', {
            workspaceId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })(),
    );
    return;
  }

  if (env.DISPATCH_QUEUE && ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await env.DISPATCH_QUEUE!.send({ workspace_id: workspaceId });
          workerDebug('dispatch', 'wake-up published via queue fallback (no actor binding)', { workspaceId });
        } catch (err) {
          workerFailure('dispatch', 'queue fallback publish failed; cron remains backstop', {
            workspaceId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })(),
    );
    return;
  }

  workerDebug('dispatch', 'no actor or queue binding; cron remains the backstop', { workspaceId });
}

/**
 * Best-effort Telegram delivery wake-up. The delivery row is already
 * durable; a lost hint is covered by the cron sweep. Waking the workspace
 * actor also runs its delivery pass, so a separate queue kind is only used
 * when no actor binding exists. Workspace-less administrative rows publish an
 * empty scope so the consumer scans all workspaces.
 */
export function publishTelegramDeliveryHint(
  ctx: ExecutionContext | undefined,
  env: Env,
  workspaceId?: string,
): void {
  if (env.WORKSPACE_ACTOR && ctx && workspaceId) {
    ctx.waitUntil(
      (async () => {
        try {
          await wakeWorkspaceActor(env, workspaceId);
        } catch (err) {
          workerFailure('dispatch', 'actor delivery trigger failed', { workspaceId, error: String(err) });
        }
      })(),
    );
    return;
  }

  if (env.DISPATCH_QUEUE && ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await env.DISPATCH_QUEUE!.send({ kind: 'telegram_delivery', workspace_id: workspaceId ?? '' });
        } catch (err) {
          workerFailure('dispatch', 'Telegram delivery wake-up publish failed; cron remains backstop', {
            workspaceId: workspaceId ?? '',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })(),
    );
    return;
  }

  workerDebug('dispatch', 'no actor or queue binding; cron remains the Telegram delivery backstop', {
    workspaceId: workspaceId ?? '',
  });
}