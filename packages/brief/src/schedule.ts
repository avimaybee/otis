/**
 * @otis/brief/schedule
 *
 * Pure chosen-time brief scheduling kernel (plan 011 slice 011A).
 *
 * - No enabled default and no hardcoded morning time: a schedule runs only
 *   when it is explicitly enabled with a chosen local time, IANA timezone
 *   and at least one weekday. A null time is unconfigured, never 09:00.
 * - Injected clock: callers pass the current UTC instant (`nowUtcIso`).
 * - No DB writes here. Integration persists the canonical brief and outbox
 *   with the existing infrastructure and `buildBriefDedupeKey` (see
 *   `./brief.ts`), passing the stored local date back as
 *   `lastGeneratedLocalDate` so a schedule edit cannot recreate an
 *   already-generated daily brief.
 *
 * Timezone math uses only built-in `Intl`; no scheduling framework.
 *
 * Cost design (serverless cron sweeps evaluate many schedules): `Intl`
 * formatters are shared from a small bounded per-timezone cache, cheap
 * decisions (disabled/incomplete/invalid/unselected weekday/already
 * generated) return before resolving the scheduled instant, and the
 * fall-back overlap scan runs only when an offset probe shows a transition
 * nearby — ordinary dates cost a handful of conversions, not a 240-minute
 * scan. `scheduleDiagnostics` exposes deterministic operation counts for
 * tests; it is process-wide and informational only.
 */

export interface BriefScheduleInput {
  enabled: boolean;
  /** Chosen local time "HH:MM" (24h). Null means unconfigured, never 09:00. */
  localTime: string | null;
  /** Chosen IANA timezone, e.g. "Europe/Bucharest". */
  timezone: string | null;
  /** Chosen weekdays, 0 (Sunday) through 6 (Saturday). */
  weekdays: number[] | null;
  channel: 'web' | 'telegram';
  revision?: number;
}

export type ScheduleDecision =
  | 'disabled'
  | 'incomplete'
  | 'invalid'
  | 'weekday_not_selected'
  | 'not_yet_due'
  | 'already_generated'
  | 'due';

export interface ScheduleEvaluation {
  runnable: boolean;
  decision: ScheduleDecision;
  /** Current local date (YYYY-MM-DD) in the schedule timezone, when known. */
  localDate: string | null;
  /**
   * Today's scheduled instant in UTC. Null when the schedule is not fully
   * specified or when a cheap short-circuit (unselected weekday, already
   * generated) skips resolution.
   */
  scheduledAtUtc: string | null;
  /** Weekday (0=Sunday..6=Saturday) of `localDate`, when known. */
  weekday: number | null;
}

export interface ScheduleDiagnostics {
  /** Number of wall-clock conversions performed (cached formatters). */
  wallConversions: number;
  /** Number of `Intl.DateTimeFormat` constructions (cache misses). */
  formatterConstructions: number;
}

export const scheduleDiagnostics: ScheduleDiagnostics = {
  wallConversions: 0,
  formatterConstructions: 0,
};

export function resetScheduleDiagnostics(): void {
  scheduleDiagnostics.wallConversions = 0;
  scheduleDiagnostics.formatterConstructions = 0;
}

const LOCAL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/** Covers any historical DST shift (shifts are <= 2h) with margin. */
const DST_SEARCH_MINUTES = 240;
/** Small bound: sweeps touch few distinct member timezones. */
const MAX_CACHED_FORMATTERS = 25;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const hit = formatterCache.get(timeZone);
  if (hit) return hit;
  // Throws RangeError for unknown zones; nothing is cached then.
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  if (formatterCache.size >= MAX_CACHED_FORMATTERS) {
    const oldest = formatterCache.keys().next();
    if (!oldest.done) formatterCache.delete(oldest.value);
  }
  formatterCache.set(timeZone, created);
  scheduleDiagnostics.formatterConstructions += 1;
  return created;
}

export function isValidLocalTime(value: string): boolean {
  return LOCAL_TIME_RE.test(value);
}

export function isValidTimezone(timezone: string): boolean {
  try {
    formatterFor(timezone);
    return true;
  } catch {
    return false;
  }
}

export function isValidLocalDate(value: string): boolean {
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

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function wallKey(parts: WallParts): string {
  return (
    `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` +
    `T${pad2(parts.hour)}:${pad2(parts.minute)}`
  );
}

function utcToWall(utcMs: number, timeZone: string): WallParts {
  const formatted = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string): number => {
    const part = formatted.find((entry) => entry.type === type);
    if (!part) throw new Error(`Missing ${type} in timezone formatting.`);
    return Number(part.value);
  };
  let hour = get('hour');
  // Some ICU builds report midnight as 24:00 even under h23.
  if (hour === 24) hour = 0;
  scheduleDiagnostics.wallConversions += 1;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
  };
}

/** Zone offset in ms at the given UTC instant (wall-as-UTC minus UTC). */
function offsetAt(utcMs: number, timeZone: string): number {
  const wall = utcToWall(utcMs, timeZone);
  return (
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0) - utcMs
  );
}

/** Approximate conversion of a zoned wall time to a UTC instant. */
function wallToUtcMs(parts: WallParts, timeZone: string): number {
  const targetAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    0,
  );
  let utc = targetAsUtc;
  for (let i = 0; i < 5; i += 1) {
    const wall = utcToWall(utc, timeZone);
    const wallAsUtc = Date.UTC(
      wall.year,
      wall.month - 1,
      wall.day,
      wall.hour,
      wall.minute,
      0,
    );
    const diff = targetAsUtc - wallAsUtc;
    if (diff === 0) break;
    utc += diff;
  }
  return utc;
}

function parseLocalDate(value: string): WallParts {
  const match = LOCAL_DATE_RE.exec(value);
  if (!match) throw new Error(`Invalid local date: ${value}.`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
  };
}

function parseLocalTime(value: string): { hour: number; minute: number } {
  const match = LOCAL_TIME_RE.exec(value);
  if (!match) throw new Error(`Invalid local time: ${value}.`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * Resolve a zoned local date + time to its UTC instant.
 *
 * - Nonexistent wall times (spring-forward gap) resolve to the next valid
 *   local instant onward from the requested time.
 * - Ambiguous wall times (fall-back overlap) resolve to the first occurrence.
 */
export function resolveScheduledInstantForDate(
  localDate: string,
  localTime: string,
  timeZone: string,
): string {
  if (!isValidLocalDate(localDate)) throw new Error(`Invalid local date: ${localDate}.`);
  if (!isValidTimezone(timeZone)) throw new Error(`Invalid timezone: ${timeZone}.`);
  const date = parseLocalDate(localDate);
  const time = parseLocalTime(localTime);
  const target: WallParts = {
    year: date.year,
    month: date.month,
    day: date.day,
    hour: time.hour,
    minute: time.minute,
  };
  const targetKey = wallKey(target);
  const baseMs = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    0,
  );

  let utc = wallToUtcMs(target, timeZone);
  if (wallKey(utcToWall(utc, timeZone)) !== targetKey) {
    // Spring-forward gap: the wall time has no UTC mapping. Everything past
    // the gap shares the post-transition offset, so each forward candidate
    // needs a single conversion check instead of a full iterative solve.
    const postOffset = offsetAt(baseMs + 12 * HOUR_MS, timeZone);
    let found: number | null = null;
    for (let step = 1; step <= DST_SEARCH_MINUTES; step += 1) {
      const shifted = new Date(baseMs + step * MINUTE_MS);
      const candidate: WallParts = {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
        hour: shifted.getUTCHours(),
        minute: shifted.getUTCMinutes(),
      };
      const candidateAsUtc = Date.UTC(
        candidate.year,
        candidate.month - 1,
        candidate.day,
        candidate.hour,
        candidate.minute,
        0,
      );
      const candidateUtc = candidateAsUtc - postOffset;
      if (wallKey(utcToWall(candidateUtc, timeZone)) === wallKey(candidate)) {
        found = candidateUtc;
        break;
      }
    }
    if (found === null) throw new Error(`Unresolvable local time: ${targetKey}.`);
    utc = found;
  } else if (
    offsetAt(utc - DST_SEARCH_MINUTES * MINUTE_MS, timeZone) !== offsetAt(utc, timeZone)
  ) {
    // A transition happened nearby, so this wall time may be ambiguous.
    // Scan backwards for the earliest UTC instant with the same wall clock:
    // that is the first overlap occurrence. Ordinary dates skip this scan
    // via the offset probe above (duplicate pairs are at most one shift,
    // well within the probe window, apart).
    for (let step = 1; step <= DST_SEARCH_MINUTES; step += 1) {
      const candidate = utc - step * MINUTE_MS;
      if (wallKey(utcToWall(candidate, timeZone)) === targetKey) {
        utc = candidate;
      }
    }
  }
  return new Date(utc).toISOString();
}

/** Current local date (YYYY-MM-DD) in the given IANA timezone. */
export function getLocalDate(nowUtcIso: string, timeZone: string): string {
  const nowMs = Date.parse(nowUtcIso);
  if (Number.isNaN(nowMs)) throw new Error(`Invalid now instant: ${nowUtcIso}.`);
  if (!isValidTimezone(timeZone)) throw new Error(`Invalid timezone: ${timeZone}.`);
  const wall = utcToWall(nowMs, timeZone);
  return `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)}`;
}

/** Weekday (0=Sunday..6=Saturday) of a YYYY-MM-DD local date. */
export function getWeekdayForLocalDate(localDate: string): number {
  const date = parseLocalDate(localDate);
  if (!isValidLocalDate(localDate)) throw new Error(`Invalid local date: ${localDate}.`);
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function normalizeWeekdays(weekdays: number[] | null): number[] | null {
  if (!weekdays || weekdays.length === 0) return null;
  const unique = new Set<number>();
  for (const day of weekdays) {
    if (!Number.isInteger(day) || day < 0 || day > 6) return null;
    unique.add(day);
  }
  return [...unique].sort((a, b) => a - b);
}

/**
 * Next UTC instant at which the schedule becomes runnable, strictly after
 * `fromUtcIso`. Only selected weekdays past `lastGeneratedLocalDate` count,
 * so a run (or a schedule edit after one) never recreates that day's brief.
 * Null when the schedule cannot run. Bounded to an 8-day walk: any weekly
 * cadence hits a selected weekday within 7 days of any start.
 */
export function nextDueUtc(input: {
  schedule: BriefScheduleInput;
  fromUtcIso: string;
  lastGeneratedLocalDate: string | null;
}): string | null {
  const { schedule, fromUtcIso, lastGeneratedLocalDate } = input;
  if (!schedule.enabled) return null;
  if (
    schedule.localTime === null ||
    schedule.timezone === null ||
    schedule.weekdays === null ||
    schedule.weekdays.length === 0
  ) {
    return null;
  }
  const days = normalizeWeekdays(schedule.weekdays);
  if (
    !isValidLocalTime(schedule.localTime) ||
    !isValidTimezone(schedule.timezone) ||
    days === null
  ) {
    return null;
  }
  const fromMs = Date.parse(fromUtcIso);
  if (Number.isNaN(fromMs)) throw new Error(`Invalid from instant: ${fromUtcIso}.`);
  if (lastGeneratedLocalDate !== null && !isValidLocalDate(lastGeneratedLocalDate)) {
    throw new Error(`Invalid last-generated date: ${lastGeneratedLocalDate}.`);
  }
  const startWall = utcToWall(fromMs, schedule.timezone);
  const startDate = new Date(
    Date.UTC(startWall.year, startWall.month - 1, startWall.day),
  );
  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = new Date(startDate.getTime() + offset * 24 * 60 * 60 * 1000);
    const localDate =
      `${candidate.getUTCFullYear()}-${pad2(candidate.getUTCMonth() + 1)}-${pad2(candidate.getUTCDate())}`;
    if (!days.includes(candidate.getUTCDay())) continue;
    if (lastGeneratedLocalDate !== null && localDate <= lastGeneratedLocalDate) continue;
    const instant = resolveScheduledInstantForDate(
      localDate,
      schedule.localTime,
      schedule.timezone,
    );
    if (Date.parse(instant) > fromMs) return instant;
  }
  return null;
}

/**
 * Decide whether a member schedule should generate a brief now.
 *
 * `lastGeneratedLocalDate` is the local date already persisted for
 * (workspace, user, kind `scheduled_daily`), or null when none exists.
 * It is compared by local date, so changing the chosen time after a run
 * never recreates that day's brief.
 *
 * Cheap outcomes (unselected weekday, already generated) return before the
 * scheduled instant is resolved; their `scheduledAtUtc` is null.
 */
export function evaluateBriefSchedule(
  schedule: BriefScheduleInput,
  nowUtcIso: string,
  lastGeneratedLocalDate: string | null,
): ScheduleEvaluation {
  if (!schedule.enabled) {
    return {
      runnable: false,
      decision: 'disabled',
      localDate: null,
      scheduledAtUtc: null,
      weekday: null,
    };
  }
  if (
    schedule.localTime === null ||
    schedule.timezone === null ||
    schedule.weekdays === null ||
    schedule.weekdays.length === 0
  ) {
    return {
      runnable: false,
      decision: 'incomplete',
      localDate: null,
      scheduledAtUtc: null,
      weekday: null,
    };
  }
  const days = normalizeWeekdays(schedule.weekdays);
  if (
    !isValidLocalTime(schedule.localTime) ||
    !isValidTimezone(schedule.timezone) ||
    days === null
  ) {
    return {
      runnable: false,
      decision: 'invalid',
      localDate: null,
      scheduledAtUtc: null,
      weekday: null,
    };
  }

  const nowMs = Date.parse(nowUtcIso);
  if (Number.isNaN(nowMs)) throw new Error(`Invalid now instant: ${nowUtcIso}.`);
  const localDate = getLocalDate(nowUtcIso, schedule.timezone);
  const weekday = getWeekdayForLocalDate(localDate);

  if (!days.includes(weekday)) {
    return { runnable: false, decision: 'weekday_not_selected', localDate, scheduledAtUtc: null, weekday };
  }
  if (lastGeneratedLocalDate === localDate) {
    return { runnable: false, decision: 'already_generated', localDate, scheduledAtUtc: null, weekday };
  }

  const scheduledAtUtc = resolveScheduledInstantForDate(
    localDate,
    schedule.localTime,
    schedule.timezone,
  );
  if (nowMs < Date.parse(scheduledAtUtc)) {
    return { runnable: false, decision: 'not_yet_due', localDate, scheduledAtUtc, weekday };
  }
  return { runnable: true, decision: 'due', localDate, scheduledAtUtc, weekday };
}
