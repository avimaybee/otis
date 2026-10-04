/**
 * @otis/brief/selection
 *
 * Deterministic brief item selection kernel (plan 011 slice 011A).
 *
 * Rank groups follow docs/contracts.md section 11:
 *   1. explicit promised deliverables due/overdue,
 *   2. other explicit tasks due/overdue,
 *   3. explicitly undated next actions,
 *   4. stale warm/hot leads.
 * At most five distinct items. Within a group: overdue/stale age first,
 * then currency bucket (lexicographic ISO code; unknown bucket first),
 * then stated value descending within the bucket, then stable task/entity
 * ID. Amounts are never compared across currencies.
 *
 * Excluded: completed/cancelled tasks, currently snoozed tasks, disputed
 * facts, future-dated work, and missing-deadline clarification (a null due
 * without an explicit no-deadline choice is pending clarification, never an
 * undated action).
 *
 * Input shapes mirror the ledger `Task` projection and the typed
 * last-contact definition (confirmed contact, member-confirmed sent draft,
 * or visit with `contact_made=true`; notes/unsent drafts do not count), but
 * are passed in pre-resolved: `reason` must be an explicit typed marker
 * (`promise` vs `task`), because the current task projection carries no
 * reason column and keyword matching is forbidden. Likewise
 * `explicitNoDeadline` and `lastContactAt` must already be resolved by the
 * integration layer. Malformed candidate rows are skipped, never promoted.
 *
 * Open policy inputs (no hidden defaults invented here):
 * - `staleAfterDays` is required: the kernel does not define staleness.
 * - A null/unknown last contact sorts as most stale (surfaced, not hidden).
 */

export const MAX_BRIEF_ITEMS = 5;

export type BriefTaskReason = 'promise' | 'task';

export interface BriefTaskInput {
  id: string;
  entityId: string | null;
  entityName?: string | null;
  title: string;
  status: 'open' | 'done' | 'cancelled';
  dueKind: 'date' | 'instant' | null;
  /** YYYY-MM-DD when `dueKind` is `date`. */
  dueLocalDate: string | null;
  /** UTC ISO instant when `dueKind` is `instant`. */
  dueInstantAt: string | null;
  dueTimezone: string | null;
  /** UTC ISO instant hiding notifications until then; original due is kept. */
  snoozeUntil: string | null;
  /** Explicit typed marker; never derived by keyword matching. */
  reason: BriefTaskReason;
  /** True only when the member explicitly chose no deadline. */
  explicitNoDeadline: boolean;
  /** Stated deal value in integer minor units, when known. */
  valueMinor: number | null;
  /** ISO currency of `valueMinor`, when known. */
  currency: string | null;
  sourceEventId: string;
  /** True when the underlying fact is currently disputed. */
  disputed: boolean;
}

export interface BriefLeadInput {
  entityId: string;
  name: string;
  status: string;
  /**
   * Typed confirmed last contact (UTC ISO), or null when never recorded.
   * Resolved by integration; notes and unsent drafts must not set it.
   */
  lastContactAt: string | null;
  valueMinor: number | null;
  currency: string | null;
  sourceEventId: string;
  disputed: boolean;
}

export type BriefItemKind = 'promise_due' | 'task_due' | 'undated' | 'stale_lead';

export interface BriefItem {
  kind: BriefItemKind;
  /** 1 = promise due, 2 = task due, 3 = undated, 4 = stale lead. */
  rankGroup: 1 | 2 | 3 | 4;
  taskId: string | null;
  entityId: string | null;
  title: string;
  /** Concrete selection reason, including the due date where known. */
  reason: string;
  sourceEventId: string;
  /** Raw due label (local date or instant); presentation formats it. */
  dueLabel: string | null;
  /** Overdue age (groups 1-2) or staleness (group 4) in ms; 0 for undated. */
  overdueMs: number;
  valueMinor: number | null;
  currency: string | null;
}

export interface SelectBriefInput {
  nowUtcIso: string;
  /** Brief-local date (YYYY-MM-DD) in the member's schedule timezone. */
  briefLocalDate: string;
  briefTimezone: string;
  tasks: BriefTaskInput[];
  leads: BriefLeadInput[];
  /** Required policy input: minimum days since last contact to count as stale. */
  staleAfterDays: number;
  /** Requested cap; the kernel never exceeds five. Defaults to five. */
  maxItems?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidLocalDate(value: string): boolean {
  const match = LOCAL_DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  return (
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day
  );
}

function dayIndex(localDate: string): number {
  return Math.floor(Date.parse(`${localDate}T00:00:00.000Z`) / DAY_MS);
}

function tieId(item: BriefItem): string {
  return item.taskId ?? item.entityId ?? '';
}

/**
 * Currency bucket key for ordering. Values are never compared across
 * currencies: items group by normalized currency code first (lexicographic
 * bucket order; unknown/missing currency sorts in the empty bucket), then by
 * stated value within the bucket, then by stable ID. This keeps the order
 * total and transitive, unlike comparing values only on currency match and
 * otherwise falling back to IDs (which can cycle: A> B by ID, B > C by ID,
 * C > A by same-currency value).
 */
function currencyBucket(item: BriefItem): string {
  return item.currency === null ? '' : item.currency.toUpperCase();
}

/** Value rank within one currency bucket; unknown value sorts last. */
function bucketedValue(item: BriefItem): number {
  return item.valueMinor ?? Number.NEGATIVE_INFINITY;
}

/** Total deterministic order: group, age, currency bucket, in-bucket value, stable ID. */
export function compareBriefItems(a: BriefItem, b: BriefItem): number {
  if (a.rankGroup !== b.rankGroup) return a.rankGroup - b.rankGroup;
  if (a.overdueMs !== b.overdueMs) return b.overdueMs - a.overdueMs;
  const bucketA = currencyBucket(a);
  const bucketB = currencyBucket(b);
  if (bucketA !== bucketB) return bucketA < bucketB ? -1 : 1;
  const valueA = bucketedValue(a);
  const valueB = bucketedValue(b);
  if (valueA !== valueB) return valueB - valueA;
  const left = tieId(a);
  const right = tieId(b);
  if (left !== right) return left < right ? -1 : 1;
  if (a.sourceEventId !== b.sourceEventId) {
    return a.sourceEventId < b.sourceEventId ? -1 : 1;
  }
  return 0;
}

function isSnoozed(task: BriefTaskInput, nowMs: number): boolean {
  if (task.snoozeUntil === null) return false;
  const untilMs = Date.parse(task.snoozeUntil);
  // Unparseable snooze metadata must not hide work; integration validates it.
  if (Number.isNaN(untilMs)) return false;
  return untilMs > nowMs;
}

function buildDueItem(
  task: BriefTaskInput,
  kind: BriefItemKind,
  rankGroup: 1 | 2,
  dueLabel: string,
  overdueMs: number,
): BriefItem {
  const label = task.reason === 'promise' ? 'Promise' : 'Task';
  return {
    kind,
    rankGroup,
    taskId: task.id,
    entityId: task.entityId,
    title: task.title,
    reason: `${label} due ${dueLabel}`,
    sourceEventId: task.sourceEventId,
    dueLabel,
    overdueMs,
    valueMinor: task.valueMinor,
    currency: task.currency,
  };
}

/**
 * Select up to five distinct brief items deterministically.
 * Pure: no I/O, no model calls, no invented obligations.
 */
export function selectBriefItems(input: SelectBriefInput): BriefItem[] {
  const nowMs = Date.parse(input.nowUtcIso);
  if (Number.isNaN(nowMs)) throw new Error(`Invalid now instant: ${input.nowUtcIso}.`);
  if (!isValidLocalDate(input.briefLocalDate)) {
    throw new Error(`Invalid brief local date: ${input.briefLocalDate}.`);
  }
  if (!Number.isFinite(input.staleAfterDays) || input.staleAfterDays < 0) {
    throw new Error(`Invalid staleAfterDays: ${input.staleAfterDays}.`);
  }
  const limit = Math.min(
    MAX_BRIEF_ITEMS,
    Math.max(1, Math.floor(input.maxItems ?? MAX_BRIEF_ITEMS)),
  );

  const seenTaskIds = new Set<string>();
  const promiseDue: BriefItem[] = [];
  const taskDue: BriefItem[] = [];
  const undated: BriefItem[] = [];

  for (const task of input.tasks) {
    if (task.status !== 'open') continue;
    if (task.disputed) continue;
    if (seenTaskIds.has(task.id)) continue;
    if (isSnoozed(task, nowMs)) continue;

    if (task.dueKind === 'date') {
      if (task.dueLocalDate === null || !isValidLocalDate(task.dueLocalDate)) continue;
      // Date-only deadlines are calendar dates, not timed notifications:
      // due when the date is reached in the brief-local calendar.
      if (task.dueLocalDate > input.briefLocalDate) continue;
      seenTaskIds.add(task.id);
      const overdueMs = (dayIndex(input.briefLocalDate) - dayIndex(task.dueLocalDate)) * DAY_MS;
      if (task.reason === 'promise') {
        promiseDue.push(buildDueItem(task, 'promise_due', 1, task.dueLocalDate, overdueMs));
      } else {
        taskDue.push(buildDueItem(task, 'task_due', 2, task.dueLocalDate, overdueMs));
      }
    } else if (task.dueKind === 'instant') {
      if (task.dueInstantAt === null) continue;
      const dueMs = Date.parse(task.dueInstantAt);
      if (Number.isNaN(dueMs)) continue;
      if (dueMs > nowMs) continue;
      seenTaskIds.add(task.id);
      if (task.reason === 'promise') {
        promiseDue.push(buildDueItem(task, 'promise_due', 1, task.dueInstantAt, nowMs - dueMs));
      } else {
        taskDue.push(buildDueItem(task, 'task_due', 2, task.dueInstantAt, nowMs - dueMs));
      }
    } else {
      // Null due is an undated action only with an explicit no-deadline
      // choice; otherwise it is pending clarification and stays out.
      if (!task.explicitNoDeadline) continue;
      seenTaskIds.add(task.id);
      undated.push({
        kind: 'undated',
        rankGroup: 3,
        taskId: task.id,
        entityId: task.entityId,
        title: task.title,
        reason: 'Next action with no deadline',
        sourceEventId: task.sourceEventId,
        dueLabel: null,
        overdueMs: 0,
        valueMinor: task.valueMinor,
        currency: task.currency,
      });
    }
  }

  const coveredEntities = new Set<string>();
  for (const item of [...promiseDue, ...taskDue, ...undated]) {
    if (item.entityId !== null) coveredEntities.add(item.entityId);
  }

  const stale: BriefItem[] = [];
  const seenEntities = new Set<string>();
  const staleThresholdMs = input.staleAfterDays * DAY_MS;
  for (const lead of input.leads) {
    const status = lead.status.toLowerCase();
    if (status !== 'warm' && status !== 'hot') continue;
    if (lead.disputed) continue;
    if (seenEntities.has(lead.entityId)) continue;
    // An entity already represented by a selected task is not repeated
    // as a stale lead for the same brief.
    if (coveredEntities.has(lead.entityId)) continue;

    let stalenessMs: number;
    let contactLabel: string;
    if (lead.lastContactAt === null) {
      // Unknown last contact sorts as most stale (surfaced, not hidden).
      stalenessMs = Number.MAX_SAFE_INTEGER;
      contactLabel = 'unknown';
    } else {
      const contactMs = Date.parse(lead.lastContactAt);
      if (Number.isNaN(contactMs)) {
        stalenessMs = Number.MAX_SAFE_INTEGER;
        contactLabel = 'unknown';
      } else {
        if (contactMs > nowMs) continue;
        if (nowMs - contactMs < staleThresholdMs) continue;
        stalenessMs = nowMs - contactMs;
        contactLabel = lead.lastContactAt.slice(0, 10);
      }
    }
    seenEntities.add(lead.entityId);
    const statusLabel = status === 'warm' ? 'Warm' : 'Hot';
    stale.push({
      kind: 'stale_lead',
      rankGroup: 4,
      taskId: null,
      entityId: lead.entityId,
      title: lead.name,
      reason: `${statusLabel} lead, last contact ${contactLabel}`,
      sourceEventId: lead.sourceEventId,
      dueLabel: null,
      overdueMs: stalenessMs,
      valueMinor: lead.valueMinor,
      currency: lead.currency,
    });
  }

  const ranked = [...promiseDue, ...taskDue, ...undated, ...stale].sort(compareBriefItems);
  return ranked.slice(0, limit);
}
