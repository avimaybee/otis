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
import { liveChatBus } from './liveBus.js';

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

/** Stream-internal D1 reads before a clean budget rotation (reduced to 15 to stay strictly within Cloudflare Free 10ms CPU limits). */
const STREAM_QUERY_BUDGET = 15;

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

/** Live event held while catch-up pages drain, in arrival order. */
interface BufferedLiveEvent {
  name: StreamEventName;
  data: unknown;
  id?: number;
}

/** Bounded race buffer: catch-up is a fast D1 read, so real floods cannot
 * fill this; overflow fails closed to a client resync, never a silent gap. */
const MAX_BUFFERED_LIVE = 200;

/**
 * Creates an SSE Response that streams activity until the bound is
 * reached, membership is lost, or the client disconnects.
 *
 * In production (when pollIntervalMs is undefined), streams in-memory
 * directly via liveChatBus without periodic D1 queries.
 */
export function createActivityStream(db: D1Database, options: StreamOptions): Response {
  const now = options.now ?? (() => Date.now());
  const maxStreamMs = options.maxStreamMs ?? ACTIVITY_BOUNDS.MAX_STREAM_MS;
  const heartbeatMs = options.heartbeatMs ?? ACTIVITY_BOUNDS.HEARTBEAT_MS;

  let cursor = options.afterCursor;
  let closed = false;
  const startedAt = now();
  const queryCount = { count: 0 };
  const sessionCache = {
    sessionVerifiedAt: 0,
    sessionValid: false,
    membershipVerifiedAt: 0,
    membershipValid: false,
  };

  // Explicit pollIntervalMs is provided in deterministic integration tests
  if (options.pollIntervalMs !== undefined) {
    const pollIntervalMs = options.pollIntervalMs;
    let lastHeartbeat = now();
    let lastMembershipCheck = 0;
    let currentPollMs = pollIntervalMs;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('retry: 2000\n\n'));
      },
      async pull(controller) {
        let emitted = false;

        while (!closed && now() - startedAt < maxStreamMs) {
          if (now() - startedAt >= maxStreamMs) break;

          if (queryCount.count >= STREAM_QUERY_BUDGET) {
            closed = true;
            controller.close();
            return;
          }

          const shouldCheckMembership = lastMembershipCheck === 0 || now() - lastMembershipCheck >= heartbeatMs;
          if (shouldCheckMembership) {
            const isMember = await verifyStreamMembership(db, options, queryCount, sessionCache, now());
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
            currentPollMs = pollIntervalMs;
            if (!shouldCheckMembership) {
              const isMember = await verifyStreamMembership(db, options, queryCount, sessionCache, now());
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

          await sleep(currentPollMs);
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

  // --- Production In-Memory Streaming Mode (Zero D1 Polling Loop) ---
  let unsubscribeLiveBus: (() => void) | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode('retry: 2000\n\n'));

      // 1. Initial membership check
      const isMember = await verifyStreamMembership(db, options, queryCount, sessionCache, now());
      if (!isMember) {
        controller.enqueue(formatEvent('membership_revoked', { workspace_id: options.workspaceId }));
        closed = true;
        controller.close();
        return;
      }

      // 2. Subscribe BEFORE the catch-up read, buffering live arrivals: an
      // event published between the read and a later subscribe would
      // otherwise race the cursor forward past undrained catch-up rows.
      // 3. Drain every catch-up page fully before touching live cursors.
      let draining = true;
      let bufferOverflow = false;
      const buffered: BufferedLiveEvent[] = [];
      unsubscribeLiveBus = liveChatBus.subscribe(options.workspaceId, options.chatId, (event) => {
        if (closed) return;
        if (draining) {
          if (buffered.length >= MAX_BUFFERED_LIVE) {
            bufferOverflow = true;
            return;
          }
          buffered.push({ name: event.name, data: event.data, ...(event.id !== undefined ? { id: event.id } : {}) });
          return;
        }
        try {
          controller.enqueue(formatEvent(event.name, event.data, event.id));
          if (event.id !== undefined && event.id > cursor) {
            cursor = event.id;
          }
        } catch {
          // Closed stream
        }
      });
      try {
        for (;;) {
          const read = await readChatActivity(
            db,
            {
              workspaceId: options.workspaceId,
              chatId: options.chatId,
              afterCursor: cursor,
            },
            queryCount,
          );
          if (read.activities.length === 0) break;
          for (const activity of read.activities) {
            controller.enqueue(formatEvent('activity', activity, activity.cursor));
            cursor = Math.max(cursor, activity.cursor);
          }
          if (read.activities.length < ACTIVITY_BOUNDS.MAX_CATCHUP_PAGE || cursor >= read.latestCursor) break;
        }
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
      draining = false;
      if (bufferOverflow) {
        controller.enqueue(formatEvent('resync_required', { latest_cursor: cursor }));
        closed = true;
        controller.close();
        return;
      }
      // 4. Replay buffered live events newer than the drained mark in arrival
      // order; older ones already went out via catch-up above.
      for (const event of buffered) {
        if (event.id !== undefined && event.id <= cursor) continue;
        try {
          controller.enqueue(formatEvent(event.name, event.data, event.id));
        } catch {
          closed = true;
          break;
        }
        if (closed) break;
        if (event.id !== undefined && event.id > cursor) {
          cursor = event.id;
        }
      }

      // 4. In-memory heartbeat timer with periodic membership re-check and D1 catch-up
      heartbeatTimer = setInterval(async () => {
        if (closed) {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          return;
        }
        if (now() - startedAt >= maxStreamMs) {
          closed = true;
          unsubscribeLiveBus?.();
          try {
            controller.close();
          } catch {
            // Controller already closed
          }
          return;
        }
        try {
          const isMember = await verifyStreamMembership(db, options, queryCount, sessionCache, now());
          if (!isMember) {
            closed = true;
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            unsubscribeLiveBus?.();
            controller.enqueue(formatEvent('membership_revoked', { workspace_id: options.workspaceId }));
            controller.close();
            return;
          }
          const read = await readChatActivity(
            db,
            { workspaceId: options.workspaceId, chatId: options.chatId, afterCursor: cursor },
            queryCount,
          );
          for (const activity of read.activities) {
            controller.enqueue(formatEvent('activity', activity, activity.cursor));
            cursor = Math.max(cursor, activity.cursor);
          }
          controller.enqueue(formatEvent('heartbeat', { cursor }));
        } catch {
          try {
            controller.enqueue(formatEvent('heartbeat', { cursor }));
          } catch {
            closed = true;
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            unsubscribeLiveBus?.();
          }
        }
      }, heartbeatMs);
    },
    cancel() {
      closed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      unsubscribeLiveBus?.();
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


/** Rechecks session and membership as pure reads with short in-memory cache to prevent WebCrypto SHA-256 and duplicate D1 churn on every heartbeat. */
async function verifyStreamMembership(
  db: D1Database,
  options: StreamOptions,
  queryCount: { count: number },
  cache?: { sessionVerifiedAt: number; sessionValid: boolean; membershipVerifiedAt: number; membershipValid: boolean },
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!options.sessionToken) return false;
  if (!cache || !cache.sessionValid || nowMs - cache.sessionVerifiedAt > 30_000) {
    queryCount.count += 1;
    const verified = await verifySession(db, options.sessionToken);
    if (!verified || verified.user.id !== options.userId) {
      if (cache) cache.sessionValid = false;
      return false;
    }
    if (cache) {
      cache.sessionValid = true;
      cache.sessionVerifiedAt = nowMs;
    }
  }
  if (!cache || !cache.membershipValid || nowMs - cache.membershipVerifiedAt > 30_000) {
    queryCount.count += 1;
    const membership = await checkMembership(db, options.workspaceId, options.userId);
    if (!membership) {
      if (cache) cache.membershipValid = false;
      return false;
    }
    if (cache) {
      cache.membershipValid = true;
      cache.membershipVerifiedAt = nowMs;
    }
  }
  return true;
}
