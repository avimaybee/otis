/**
 * @otis/brief/brief
 *
 * Stable brief identity, save ordering and deterministic plain-text fallback
 * (plan 011 slice 011A). Pure: no DB writes, no delivery, no model calls.
 *
 * Integration persists one canonical brief per
 * (workspace, user, local date, kind `scheduled_daily`) and delivers it
 * through the existing canonical web + outbox path. An empty selection
 * renders to `''`: a scheduled run with no qualifying work sends no
 * notification; on-demand `/today` renders its own empty state.
 */

import { compareBriefItems, type BriefItem, type BriefItemKind } from './selection.js';

export const BRIEF_KIND_SCHEDULED_DAILY = 'scheduled_daily';

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Daily idempotency key material: `workspace:user:localDate:kind`.
 * The local date is the member-schedule calendar date, so repeated cron
 * ticks and schedule edits after generation map to the same key.
 */
export function buildBriefDedupeKey(
  workspaceId: string,
  userId: string,
  localDate: string,
  kind: string = BRIEF_KIND_SCHEDULED_DAILY,
): string {
  if (!workspaceId || !userId) throw new Error('Workspace and user IDs are required.');
  if (!LOCAL_DATE_RE.test(localDate)) throw new Error(`Invalid local date: ${localDate}.`);
  if (!kind) throw new Error('Brief kind is required.');
  return `${workspaceId}:${userId}:${localDate}:${kind}`;
}

export interface SavedBriefItem {
  /** Stable 1-based display position; saved so replies resolve ("did the first one"). */
  position: number;
  kind: BriefItemKind;
  taskId: string | null;
  entityId: string | null;
  title: string;
  reason: string;
  sourceEventId: string;
  dueLabel: string | null;
}

/**
 * Order selections for persistence. Re-sorts defensively with the same
 * total order used at selection time, then assigns stable positions.
 */
export function orderSelectionsForSave(items: BriefItem[]): SavedBriefItem[] {
  return [...items].sort(compareBriefItems).map((item, index) => ({
    position: index + 1,
    kind: item.kind,
    taskId: item.taskId,
    entityId: item.entityId,
    title: item.title,
    reason: item.reason,
    sourceEventId: item.sourceEventId,
    dueLabel: item.dueLabel,
  }));
}

export interface BriefTextOptions {
  /** Heading line. Defaults to "Your brief." (never "morning": schedules may run in the evening). */
  header?: string;
}

/**
 * Deterministic plain-text fallback from saved selections: the model may
 * phrase the same selections, but this rendering never invents obligations.
 * Returns `''` for an empty selection (scheduled silence).
 */
export function renderBriefText(
  items: SavedBriefItem[],
  options: BriefTextOptions = {},
): string {
  if (items.length === 0) return '';
  const header = options.header ?? 'Your brief.';
  const lines = items.map((item) => `${item.position}. ${item.title} - ${item.reason}`);
  return `${header}\n${lines.join('\n')}`;
}
