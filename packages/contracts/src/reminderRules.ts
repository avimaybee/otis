import type { ReminderSpec } from './business.js';

const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const localTime = (v: unknown) => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v);
const localDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
export function validReminderTimezone(v: unknown): v is string { if (typeof v !== 'string' || v.length > 100) return false; try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }
export function validateReminderSpec(v: unknown): v is ReminderSpec {
  if (!plain(v)) return false;
  if (v.kind === 'weekly') return keys(v, ['kind', 'weekdays', 'local_time', 'start_date', 'end_date']) && Array.isArray(v.weekdays) && v.weekdays.length >= 1 && v.weekdays.length <= 7 && new Set(v.weekdays).size === v.weekdays.length && v.weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6) && localTime(v.local_time) && (v.start_date === undefined || localDate(v.start_date)) && (v.end_date === undefined || localDate(v.end_date)) && (!v.start_date || !v.end_date || String(v.start_date) <= String(v.end_date));
  if (v.kind !== 'after_quote' || !keys(v, ['kind', 'role', 'offset', 'if_no_contact']) || !['offered', 'expected'].includes(String(v.role)) || typeof v.if_no_contact !== 'boolean' || !plain(v.offset)) return false;
  const o = v.offset;
  return keys(o, ['hours']) && Number.isInteger(o.hours) && Number(o.hours) >= 1 && Number(o.hours) <= 8760 || keys(o, ['days', 'local_time']) && Number.isInteger(o.days) && Number(o.days) >= 1 && Number(o.days) <= 365 && localTime(o.local_time);
}
