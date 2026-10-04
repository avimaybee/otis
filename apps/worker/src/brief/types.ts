/**
 * @otis/worker/brief/types
 *
 * Structural contracts for the 011B brief service (plan 011 slice 011B).
 *
 * These mirror the @otis/brief 011A kernel I/O shapes field-for-field, but
 * are declared locally: the worker package has no @otis/brief dependency
 * yet (linking is owned by the coordinator), so the service receives the
 * real kernel through the `BriefKernel` interface (dependency injection).
 * Tests inject the actual kernel by relative import and prove the service
 * never reimplements ranking; production wiring passes the same functions
 * once linking lands. No ranking, date or copy logic lives here.
 */

export interface LocalBriefSchedule {
  enabled: boolean;
  localTime: string | null;
  timezone: string | null;
  weekdays: number[] | null;
  channel: 'web' | 'telegram';
}

/** Mirrors the kernel ScheduleDecision. */
export type LocalScheduleDecision =
  | 'disabled'
  | 'incomplete'
  | 'invalid'
  | 'weekday_not_selected'
  | 'not_yet_due'
  | 'already_generated'
  | 'due';

export interface LocalScheduleEvaluation {
  runnable: boolean;
  decision: LocalScheduleDecision;
  localDate: string | null;
  scheduledAtUtc: string | null;
  weekday: number | null;
}

export interface LocalBriefTask {
  id: string;
  entityId: string | null;
  title: string;
  status: 'open' | 'done' | 'cancelled';
  dueKind: 'date' | 'instant' | null;
  dueLocalDate: string | null;
  dueInstantAt: string | null;
  dueTimezone: string | null;
  snoozeUntil: string | null;
  /** Explicit typed marker only; the service never invents it (see read.ts). */
  reason: 'promise' | 'task';
  /** True only when explicitly proven; unprovable rows pass false. */
  explicitNoDeadline: boolean;
  valueMinor: number | null;
  currency: string | null;
  sourceEventId: string;
  disputed: boolean;
}

export interface LocalBriefLead {
  entityId: string;
  name: string;
  status: string;
  /** Typed confirmed last contact (UTC ISO) or null when never recorded. */
  lastContactAt: string | null;
  valueMinor: number | null;
  currency: string | null;
  sourceEventId: string;
  disputed: boolean;
}

export type LocalBriefItemKind = 'promise_due' | 'task_due' | 'undated' | 'stale_lead';

export interface LocalBriefItem {
  kind: LocalBriefItemKind;
  rankGroup: 1 | 2 | 3 | 4;
  taskId: string | null;
  entityId: string | null;
  title: string;
  reason: string;
  sourceEventId: string;
  dueLabel: string | null;
  overdueMs: number;
  valueMinor: number | null;
  currency: string | null;
}

export interface LocalSavedBriefItem {
  position: number;
  kind: LocalBriefItemKind;
  taskId: string | null;
  entityId: string | null;
  title: string;
  reason: string;
  sourceEventId: string;
  dueLabel: string | null;
}

export interface KernelSelectInput {
  nowUtcIso: string;
  briefLocalDate: string;
  briefTimezone: string;
  tasks: LocalBriefTask[];
  leads: LocalBriefLead[];
  staleAfterDays: number;
  maxItems?: number;
}

/**
 * The deterministic 011A kernel, injected. Structural typing (not nominal)
 * means the real kernel satisfies this interface without adaptation.
 */
export interface BriefKernel {
  evaluateSchedule(
    schedule: LocalBriefSchedule,
    nowIso: string,
    lastGenerated: string | null,
  ): LocalScheduleEvaluation;
  selectItems(input: KernelSelectInput): LocalBriefItem[];
  dedupeKey(workspaceId: string, userId: string, localDate: string): string;
  orderForSave(items: LocalBriefItem[]): LocalSavedBriefItem[];
  renderText(items: LocalSavedBriefItem[]): string;
  localDate(nowIso: string, timezone: string): string;
  isValidTimezone(timezone: string): boolean;
}
