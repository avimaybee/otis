/**
 * Activity stream subscription with durable catch-up.
 *
 * The stream delivers persisted rows. Reconnects start from the last applied
 * cursor, and a superseded cursor falls back to an authoritative transcript
 * fetch rather than silently showing a gap.
 */

import type { ActivityPageResponse, PublicActivity } from '@otis/contracts';

export type StreamStatus = 'idle' | 'connecting' | 'live' | 'resyncing' | 'closed';

export interface StreamHandlers {
  onActivity: (activity: PublicActivity) => void;
  onStatus: (status: StreamStatus) => void;
  onResyncRequired: () => void;
  onAccessLost?: () => void;
}

export interface ActivitySubscription {
  close: () => void;
}

export function subscribeToActivity(
  url: string,
  handlers: StreamHandlers,
  deps: { EventSourceCtor?: typeof EventSource; setTimeoutFn?: typeof setTimeout } = {},
): ActivitySubscription {
  const EventSourceImpl = deps.EventSourceCtor ?? globalThis.EventSource;
  if (!EventSourceImpl) {
    handlers.onStatus('closed');
    return { close: () => undefined };
  }

  handlers.onStatus('connecting');
  const source = new EventSourceImpl(url, { withCredentials: true });
  let retry: ReturnType<typeof setTimeout> | undefined;

  source.addEventListener('open', () => handlers.onStatus('live'));

  source.addEventListener('activity', (event) => {
    handlers.onStatus('live');
    try {
      handlers.onActivity(JSON.parse((event as MessageEvent<string>).data) as PublicActivity);
    } catch {
      // A malformed frame is dropped; the next cursor still applies.
    }
  });

  source.addEventListener('resync_required', () => {
    handlers.onStatus('resyncing');
    source.close();
    retry = (deps.setTimeoutFn ?? setTimeout)(handlers.onResyncRequired, 1500);
  });

  source.addEventListener('membership_revoked', () => {
    handlers.onStatus('closed');
    source.close();
    handlers.onAccessLost?.();
  });

  source.addEventListener('error', () => {
    // Refresh authority after a disconnect, then reopen from the snapshot cursor.
    handlers.onStatus('resyncing');
    source.close();
    retry = (deps.setTimeoutFn ?? setTimeout)(handlers.onResyncRequired, 1500);
  });

  return {
    close: () => { if (retry) clearTimeout(retry); source.close(); },
  };
}

/**
 * Applies an activity row to a transcript view.
 *
 * Chunked text is coalesced by run so a live stream renders prose instead of
 * per-token rows. Every other type is appended in cursor order.
 */
export function mergeActivity(
  existing: PublicActivity[],
  activity: PublicActivity,
): PublicActivity[] {
  if (existing.some((item) => item.id === activity.id || item.cursor === activity.cursor)) {
    return existing;
  }
  const next = [...existing, activity];
  return next.sort((left, right) => left.cursor - right.cursor);
}

export function isAuthoritativeGap(page: ActivityPageResponse, appliedCursor: number): boolean {
  return page.next_cursor < appliedCursor;
}
