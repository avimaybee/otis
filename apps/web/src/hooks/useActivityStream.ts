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
  /**
   * The server closed the stream because this workspace revoked membership.
   * Workspace-scoped by construction (the URL carries the workspace); it
   * must never trigger a user-wide purge.
   */
  onMembershipRevoked?: () => void;
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
    handlers.onMembershipRevoked?.();
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

/**
 * Live transient preview text by run and round. Preview frames are never
 * persisted and never enter the snapshot: each frame carries its round's full
 * text so far, later sequences overwrite earlier ones, and durable coverage
 * drops preview rounds as their persisted chunks arrive. Reconnects start
 * empty and render durable state honestly.
 */
export type TransientPreview = Record<string, Record<number, { seq: number; text: string }>>;

export function mergeTransientPreview(current: TransientPreview, activity: PublicActivity): TransientPreview {
  const payload = activity.payload as { text?: unknown; round_index?: unknown; seq?: unknown } | null;
  if (
    !payload
    || typeof payload.text !== 'string'
    || typeof payload.round_index !== 'number'
    || typeof payload.seq !== 'number'
  ) {
    return current;
  }
  const rounds = current[activity.run_id] ?? {};
  const prev = rounds[payload.round_index];
  if (prev && prev.seq >= payload.seq) return current;
  return { ...current, [activity.run_id]: { ...rounds, [payload.round_index]: { seq: payload.seq, text: payload.text } } };
}

export function dropCoveredTransientPreview(
  current: TransientPreview,
  runId: string,
  roundIndex: number,
): TransientPreview {
  const rounds = current[runId];
  if (!rounds) return current;
  const kept: Record<number, { seq: number; text: string }> = {};
  for (const [round, frame] of Object.entries(rounds)) {
    if (Number(round) > roundIndex) kept[Number(round)] = frame;
  }
  if (Object.keys(kept).length === Object.keys(rounds).length) return current;
  const next = { ...current };
  if (Object.keys(kept).length === 0) delete next[runId];
  else next[runId] = kept;
  return next;
}

export function clearTransientPreview(current: TransientPreview, runId: string): TransientPreview {
  if (!current[runId]) return current;
  const next = { ...current };
  delete next[runId];
  return next;
}

export function transientTextForRun(current: TransientPreview, runId: string): string {
  const rounds = current[runId];
  if (!rounds) return '';
  return Object.keys(rounds)
    .map(Number)
    .sort((left, right) => left - right)
    .map((round) => rounds[round]!.text)
    .join('');
}

export function isAuthoritativeGap(page: ActivityPageResponse, appliedCursor: number): boolean {
  return page.next_cursor < appliedCursor;
}
