/**
 * Server-sent activity stream for one chat.
 *
 * The stream is a delivery mechanism over already-persisted rows. It never
 * invents activity, and heartbeats carry no business meaning. Membership and
 * session are revalidated while the stream is open so a removed member cannot
 * keep reading.
 */

import type { ActivityReadResult, StreamEventName } from '@otis/contracts';
import { ACTIVITY_BOUNDS } from '@otis/contracts';
import { checkMembership, verifySession } from '@otis/identity';
import { ActivityCursorSupersededError, readChatActivity } from './activity.js';

export interface StreamOptions {
  workspaceId: string;
  chatId: string;
  afterCursor: number;
  sessionToken: string;
  userId: string;
  /** Injectable for deterministic tests; defaults to the platform clock. */
  now?: () => number;
  pollIntervalMs?: number;
  maxStreamMs?: number;
  heartbeatMs?: number;
  requestId?: string;
}

const encoder = new TextEncoder();

/** Stream-internal D1 reads before a clean budget rotation (see above). */
const STREAM_QUERY_BUDGET = 40;

function formatEvent(name: StreamEventName, data: unknown, id?: number): Uint8Array {
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`event: ${name}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  lines.push('');
  lines.push('');
  return encoder.encode(lines.join('\n'));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Creates an SSE Response that streams persisted activity until the bound is
 * reached, membership is lost, or the client disconnects.
 *
 * Per-request query ceiling is 50 (007 budget): 3 setup reads in the route
 * (session, membership, chat) plus at most STREAM_QUERY_BUDGET internal
 * reads plus a worst-case final tick of 4 (membership recheck 2 + cursor
 * read 1 + rows read 1) = 47, held under 50 with margin. Budget expiry ends
 * the stream with a clean close — exactly like maxStreamMs expiry — so the
 * client reopens from its cursor with a cheap connect. It never emits
 * resync_required for budget: that event forces a full snapshot reload,
 * which is the expensive path reserved for genuinely stale cursors.
 */
export function createActivityStream(db: D1Database, options: StreamOptions): Response {
  const now = options.now ?? (() => Date.now());
  const pollIntervalMs = options.pollIntervalMs ?? ACTIVITY_BOUNDS.POLL_INTERVAL_MS;
  const maxStreamMs = options.maxStreamMs ?? ACTIVITY_BOUNDS.MAX_STREAM_MS;
  const heartbeatMs = options.heartbeatMs ?? ACTIVITY_BOUNDS.HEARTBEAT_MS;

  let cursor = options.afterCursor;
  let lastHeartbeat = now();
  let lastMembershipCheck = 0;
  let closed = false;
  const startedAt = now();
  const queryCount = { count: 0 };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode('retry: 2000\n\n'));
    },
    async pull(controller) {
      let emitted = false;

      while (!closed && now() - startedAt < maxStreamMs) {
        if (now() - startedAt >= maxStreamMs) break;

        // Budget rotation: end cleanly BEFORE the per-request query ceiling
        // so the client reconnects cheaply from its cursor. This is the same
        // clean close as maxStreamMs expiry — never resync_required, which
        // would force a full snapshot reload for a healthy stream.
        if (queryCount.count >= STREAM_QUERY_BUDGET) {
          closed = true;
          controller.close();
          return;
        }

        // Check membership on initial tick, on heartbeat cadence, or before new activity is delivered
        const shouldCheckMembership = lastMembershipCheck === 0 || now() - lastMembershipCheck >= heartbeatMs;
        if (shouldCheckMembership) {
          const isMember = await verifyStreamMembership(db, options, queryCount);
          lastMembershipCheck = now();
          if (!isMember) {
            controller.enqueue(formatEvent('membership_revoked', { workspace_id: options.workspaceId }));
            closed = true;
            controller.close();
            return;
          }
        }

        let read: ActivityReadResult;
        try {
          read = await readChatActivity(
            db,
            {
              workspaceId: options.workspaceId,
              chatId: options.chatId,
              afterCursor: cursor,
            },
            queryCount,
          );
        } catch (err) {
          if (err instanceof ActivityCursorSupersededError) {
            controller.enqueue(
              formatEvent('resync_required', { latest_cursor: err.latestCursor }),
            );
            closed = true;
            controller.close();
            return;
          }
          controller.enqueue(
            formatEvent('resync_required', { latest_cursor: cursor }),
          );
          closed = true;
          controller.close();
          return;
        }

        if (read.activities.length > 0) {
          // If membership was not verified on this tick, verify before emitting new activity
          if (!shouldCheckMembership) {
            const isMember = await verifyStreamMembership(db, options, queryCount);
            lastMembershipCheck = now();
            if (!isMember) {
              controller.enqueue(formatEvent('membership_revoked', { workspace_id: options.workspaceId }));
              closed = true;
              controller.close();
              return;
            }
          }

          for (const activity of read.activities) {
            controller.enqueue(formatEvent('activity', activity, activity.cursor));
            cursor = activity.cursor;
            emitted = true;
          }
        }

        if (emitted) return;

        if (now() - lastHeartbeat >= heartbeatMs) {
          lastHeartbeat = now();
          controller.enqueue(formatEvent('heartbeat', { cursor }));
          return;
        }

        await sleep(pollIntervalMs);
      }

      if (!closed) {
        closed = true;
        controller.close();
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'x-request-id': options.requestId ?? crypto.randomUUID(),
    },
  });
}

/** Rechecks session and membership as pure reads: zero D1 writes, so long-lived streams close on revocation without costing the write budget. */
async function verifyStreamMembership(
  db: D1Database,
  options: StreamOptions,
  queryCount: { count: number },
): Promise<boolean> {
  if (!options.sessionToken) return false;
  queryCount.count += 1;
  const verified = await verifySession(db, options.sessionToken);
  if (!verified || verified.user.id !== options.userId) return false;
  queryCount.count += 1;
  const membership = await checkMembership(db, options.workspaceId, options.userId);
  return membership !== null;
}
