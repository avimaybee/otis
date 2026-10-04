/**
 * One formatting owner for viewer-facing times, day separators and money.
 *
 * Inputs are the viewer's locale plus an explicit display timezone when the
 * product contract supplies one. No workspace display-timezone field exists
 * in @otis/contracts today (only member brief_timezone for brief schedules
 * and per-deadline source-member timezones), so callers pass `undefined` and
 * the device (viewer) zone applies. Brief, member and hardcoded zones are
 * never substituted silently; deadlines keep their server-side
 * source-member interpretation and only display through here.
 *
 * Display formatting never rewrites stored UTC instants or ledger facts.
 * Missing/invalid inputs render as empty strings, never "Invalid Date".
 * No currency is invented for a value that lacks one.
 */

const SUPPORTED_APP_LANGUAGES = ['ro', 'hu', 'en'] as const;
export type AppLanguage = (typeof SUPPORTED_APP_LANGUAGES)[number];

/** Validates a language tag and keeps only the supported ro/hu/en base. */
export function parseAppLanguage(tag: string | null | undefined): AppLanguage | null {
  if (!tag) return null;
  const base = tag.trim().toLowerCase().split('-')[0] ?? '';
  return (SUPPORTED_APP_LANGUAGES as readonly string[]).includes(base) ? (base as AppLanguage) : null;
}

/** The viewer's locale for Intl display; falls back to en when unavailable. */
export function viewerLocale(): string {
  try {
    const tag = navigator.language;
    if (typeof tag === 'string' && tag && Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0) return tag;
  } catch { /* Happy-dom and privacy-hardened browsers may lack Intl data. */ }
  return 'en';
}

function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Clock time in the viewer's locale and display zone; '' when unknown. */
export function formatClockTime(iso: string, locale?: string, timeZone?: string): string {
  const date = toDate(iso);
  if (!date) return '';
  try {
    return new Intl.DateTimeFormat(locale ?? viewerLocale(), {
      hour: '2-digit',
      minute: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch { return ''; }
}

/** Day separator label in the viewer's locale and display zone. */
export function formatDayLabel(iso: string, locale?: string, timeZone?: string): string {
  const date = toDate(iso);
  if (!date) return '';
  try {
    return new Intl.DateTimeFormat(locale ?? viewerLocale(), {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch { return ''; }
}

/**
 * Calendar-date key compared in the display zone, not from UTC substrings,
 * so a UTC-midnight record lands on the viewer's correct local day.
 */
export function dayKeyInZone(iso: string, timeZone?: string): string {
  const date = toDate(iso);
  if (!date) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch { return ''; }
}

/** Money with its actual unit; a missing currency renders as a plain number. */
export function formatMoney(amount: number, currency?: string | null, locale?: string): string {
  if (!Number.isFinite(amount)) return '';
  const activeLocale = locale ?? viewerLocale();
  if (!currency) {
    try {
      return new Intl.NumberFormat(activeLocale).format(amount);
    } catch { return String(amount); }
  }
  try {
    return new Intl.NumberFormat(activeLocale, { style: 'currency', currency }).format(amount);
  } catch { return `${amount} ${currency}`; }
}
