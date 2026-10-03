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
 */
export function createActivityStream(db: D1Database, options: StreamOptions): Response {
  const now = options.now ?? (() => Date.now());
  const pollIntervalMs = options.pollIntervalMs ?? ACTIVITY_BOUNDS.POLL_INTERVAL_MS;
  const maxStreamMs = options.maxStreamMs ?? ACTIVITY_BOUNDS.MAX_STREAM_MS;
  const heartbeatMs = options.heartbeatMs ?? ACTIVITY_BOUNDS.HEARTBEAT_MS;

  let cursor = options.afterCursor;
  let lastHeartbeat = now();
  let closed = false;
  const startedAt = now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode('retry: 2000\n\n'));
    },
    async pull(controller) {
      let emitted = false;

      while (!closed && now() - startedAt < maxStreamMs) {
        if (now() - startedAt >= maxStreamMs) break;

        if (!(await verifyStreamMembership(db, options))) {
          controller.enqueue(formatEvent('membership_revoked', { workspace_id: options.workspaceId }));
          closed = true;
          controller.close();
          return;
        }
        let read: ActivityReadResult;
        try {
          read = await readChatActivity(db, {
            workspaceId: options.workspaceId,
            chatId: options.chatId,
            afterCursor: cursor,
          });
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

        for (const activity of read.activities) {
          controller.enqueue(formatEvent('activity', activity, activity.cursor));
          cursor = activity.cursor;
          emitted = true;
        }

        if (emitted) return;

        const membership = await verifyStreamMembership(db, options);
        if (!membership) {
          controller.enqueue(formatEvent('membership_revoked', { workspace_id: options.workspaceId }));
          closed = true;
          controller.close();
          return;
        }

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

/** Rechecks session and membership so long-lived streams close on revocation. */
async function verifyStreamMembership(db: D1Database, options: StreamOptions): Promise<boolean> {
  if (!options.sessionToken) return false;
  const verified = await verifySession(db, options.sessionToken);
  if (!verified || verified.user.id !== options.userId) return false;
  const membership = await checkMembership(db, options.workspaceId, options.userId);
  return membership !== null;
}
