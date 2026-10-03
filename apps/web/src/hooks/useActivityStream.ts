/**
 * Activity stream subscription with durable catch-up.
 *
 * The stream delivers persisted rows. Reconnects start from the last applied
 * cursor, and a superseded cursor falls back to an authoritative transcript
 * fetch rather than silently showing a gap.
 */

import type { ActivityPageResponse, PublicActivity } from '@otis/contracts';
import { debugLog, failureLog } from '../api/log.js';

/** The stream URL is same-origin; log only the path so no host leaks into consoles. */
function stripOrigin(url: string): string {
  try {
    return new URL(url, 'http://local').pathname + new URL(url, 'http://local').search;
  } catch {
    return '(unparseable url)';
  }
}

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

  debugLog('stream', 'opening', { url: stripOrigin(url) });
  handlers.onStatus('connecting');
  const source = new EventSourceImpl(url, { withCredentials: true });
  let retry: ReturnType<typeof setTimeout> | undefined;

  source.addEventListener('open', () => {
    debugLog('stream', 'live', { url: stripOrigin(url) });
    handlers.onStatus('live');
  });

  source.addEventListener('activity', (event) => {
    handlers.onStatus('live');
    try {
      const activity = JSON.parse((event as MessageEvent<string>).data) as PublicActivity;
      if (activity.type === 'run_finished' || activity.type === 'partial_failure') {
        failureLog('stream', 'terminal run activity', { type: activity.type, cursor: activity.cursor, run_id: activity.run_id });
      } else {
        debugLog('stream', 'activity', { type: activity.type, cursor: activity.cursor, run_id: activity.run_id });
      }
      handlers.onActivity(activity);
    } catch {
      failureLog('stream', 'malformed frame dropped', { url: stripOrigin(url) });
      // A malformed frame is dropped; the next cursor still applies.
    }
  });

  source.addEventListener('resync_required', () => {
    debugLog('stream', 'resync required; reopening from snapshot cursor', { url: stripOrigin(url) });
    handlers.onStatus('resyncing');
    source.close();
    retry = (deps.setTimeoutFn ?? setTimeout)(handlers.onResyncRequired, 1500);
  });

  source.addEventListener('membership_revoked', () => {
    failureLog('stream', 'membership revoked; closing', { url: stripOrigin(url) });
    handlers.onStatus('closed');
    source.close();
    handlers.onAccessLost?.();
  });

  source.addEventListener('error', () => {
    failureLog('stream', 'transport error; will resync from snapshot cursor', { url: stripOrigin(url) });
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
