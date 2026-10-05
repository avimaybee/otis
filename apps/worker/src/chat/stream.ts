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
  const sessionCache = { sessionVerifiedAt: 0, sessionValid: false };

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

      // 2. Initial catch-up read: single read from D1 for existing activities after cursor
      try {
        const read = await readChatActivity(
          db,
          {
            workspaceId: options.workspaceId,
            chatId: options.chatId,
            afterCursor: cursor,
          },
          queryCount,
        );
        for (const activity of read.activities) {
          controller.enqueue(formatEvent('activity', activity, activity.cursor));
          cursor = Math.max(cursor, activity.cursor);
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

      // 3. Subscribe to in-memory liveChatBus (events pushed in RAM directly as tokens arrive)
      unsubscribeLiveBus = liveChatBus.subscribe(options.workspaceId, options.chatId, (event) => {
        if (closed) return;
        try {
          controller.enqueue(formatEvent(event.name, event.data, event.id));
          if (event.id !== undefined && event.id > cursor) {
            cursor = event.id;
          }
        } catch {
          // Closed stream
        }
      });

      // 4. In-memory heartbeat timer (ZERO D1 queries while connection remains open)
      heartbeatTimer = setInterval(() => {
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
          controller.enqueue(formatEvent('heartbeat', { cursor }));
        } catch {
          closed = true;
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          unsubscribeLiveBus?.();
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
  cache?: { sessionVerifiedAt: number; sessionValid: boolean },
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
  queryCount.count += 1;
  const membership = await checkMembership(db, options.workspaceId, options.userId);
  return membership !== null;
}
