import {
  getLocalDate,
  getWeekdayForLocalDate,
  nextDueUtc,
  resolveScheduledInstantForDate,
} from '@otis/brief';
import type { ReminderRule } from '@otis/contracts';
import { ENTITY_FAMILY_SQL, familyBinds } from '../entities/canonical.js';

const shiftDate = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
function weeklyNext(rule: ReminderRule, after: string): string | null {
  if (rule.spec.kind !== 'weekly') return null;
  const spec = rule.spec;
  const start =
    spec.start_date && getLocalDate(after, rule.timezone) < spec.start_date
      ? new Date(
          Date.parse(resolveScheduledInstantForDate(spec.start_date, '00:00', rule.timezone)) - 1,
        ).toISOString()
      : after;
  const due = nextDueUtc({
    schedule: {
      enabled: true,
      localTime: spec.local_time,
      timezone: rule.timezone,
      weekdays: spec.weekdays,
      channel: rule.channel,
      revision: rule.revision,
    },
    fromUtcIso: start,
    lastGeneratedLocalDate: null,
  });
  return due && spec.end_date && getLocalDate(due, rule.timezone) > spec.end_date ? null : due;
}
export function quoteFollowUpDue(rule: ReminderRule, occurredAt: string): string | null {
  if (rule.spec.kind !== 'after_quote') return null;
  const offset = rule.spec.offset;
  return 'hours' in offset
    ? new Date(Date.parse(occurredAt) + offset.hours * 3600000).toISOString()
    : resolveScheduledInstantForDate(
        shiftDate(getLocalDate(occurredAt, rule.timezone), offset.days),
        offset.local_time,
        rule.timezone,
      );
}

/** Indexed due/dirty cursors, bounded work and immutable occurrence keys. */
export async function processReminderRules(
  db: D1Database,
  now: string,
  limit = 2,
): Promise<number> {
  const rows =
    (
      await db
        .prepare(
          `SELECT r.*, c.rule_revision AS cursor_revision, c.next_due, c.dirty, c.last_delivered_at, w.business_revision AS read_revision
    FROM reminder_rule_cursors c JOIN reminder_rules r ON r.id = c.rule_id AND r.workspace_id = c.workspace_id JOIN workspaces w ON w.id = r.workspace_id
    WHERE c.dirty = 1 OR c.next_due <= ? ORDER BY c.dirty DESC, c.next_due LIMIT ?`,
        )
        .bind(now, limit)
        .all<Record<string, unknown>>()
    ).results ?? [];
  let occurrences = 0;
  for (const row of rows) {
    const rule = { ...row, spec: JSON.parse(String(row.spec_json)) } as unknown as ReminderRule;
    let next: string | null = null;
    const inserts: D1PreparedStatement[] = [];
    const occurrenceIndexes = new Set<number>();
    const add = (key: string, at: string, root?: string, head?: string) => {
      occurrenceIndexes.add(inserts.length);
      const id = `rem_${rule.id}_${key}`;
      inserts.push(
        db
          .prepare(
            `INSERT INTO reminders(id, workspace_id, user_id, action_id, text, remind_at, timezone, channel, status, created_at, updated_at, rule_id, rule_revision, occurrence_key, interaction_id, head_event_id)
        SELECT ?, r.workspace_id, r.user_id, ?, r.text, ?, r.timezone, r.channel, 'pending', ?, ?, r.id, r.revision, ?, ?, ? FROM reminder_rules r
        WHERE r.id = ? AND r.workspace_id = ? AND r.revision = ? AND r.status = 'active'
          AND EXISTS (SELECT 1 FROM workspace_users m WHERE m.workspace_id = r.workspace_id AND m.user_id = r.user_id)
        ON CONFLICT(rule_id, occurrence_key) WHERE rule_id IS NOT NULL DO NOTHING`,
          )
          .bind(
            id,
            id,
            at,
            now,
            now,
            key,
            root ?? null,
            head ?? null,
            rule.id,
            rule.workspace_id,
            rule.revision,
          ),
      );
    };
    if (rule.status === 'active') {
      if (rule.spec.kind === 'weekly') {
        const first =
          row.cursor_revision === rule.revision && row.next_due
            ? String(row.next_due)
            : weeklyNext(rule, new Date(Date.parse(rule.updated_at) - 1).toISOString());
        if (first && first <= now) {
          // One useful catch-up, rather than a flood of obsolete weekly nudges.
          const today = getLocalDate(now, rule.timezone);
          for (let n = 0; n < 7; n++) {
            const date = shiftDate(today, -n);
            if (
              !rule.spec.weekdays.includes(getWeekdayForLocalDate(date)) ||
              (rule.spec.start_date && date < rule.spec.start_date) ||
              (rule.spec.end_date && date > rule.spec.end_date)
            )
              continue;
            const at = resolveScheduledInstantForDate(date, rule.spec.local_time, rule.timezone);
            if (at <= now && at >= first) {
              inserts.push(
                db
                  .prepare(
                    "UPDATE reminders SET status = 'cancelled', last_error = 'Replaced by the latest weekly follow-up.', updated_at = ? WHERE workspace_id = ? AND rule_id = ? AND status = 'pending' AND remind_at < ?",
                  )
                  .bind(now, rule.workspace_id, rule.id, at),
              );
              add(`weekly:${date}`, at);
              break;
            }
          }
          next = weeklyNext(rule, now);
        } else next = first;
      } else if (rule.entity_id) {
        const quotes =
          (
            await db
              .prepare(
                `${ENTITY_FAMILY_SQL} SELECT i.root_event_id, i.head_event_id, i.occurred_at FROM interaction_state i
          WHERE i.workspace_id = ? AND i.entity_id IN (SELECT id FROM family) AND i.kind = 'quote' AND i.state = 'active' AND json_extract(i.head_value_json, '$.role') = ?
            AND NOT EXISTS (SELECT 1 FROM reminders delivered WHERE delivered.rule_id = ? AND delivered.occurrence_key = 'quote:' || i.root_event_id AND (delivered.status = 'sent' OR (delivered.head_event_id = i.head_event_id AND delivered.rule_revision = ? AND (delivered.status IN ('pending', 'failed') OR delivered.status = 'cancelled' AND COALESCE(delivered.last_error, '') NOT IN ('Follow-up changed.', 'Quote removed or no longer matches this follow-up.')))))
          ORDER BY i.occurred_at, i.root_event_id LIMIT 4`,
              )
              .bind(
                ...familyBinds(rule.workspace_id, rule.entity_id),
                rule.workspace_id,
                rule.spec.role,
                rule.id,
                rule.revision,
              )
              .all<{ root_event_id: string; head_event_id: string; occurred_at: string }>()
          ).results ?? [];
        for (const quote of quotes) {
          const due = quoteFollowUpDue(rule, quote.occurred_at)!;
          add(`quote:${quote.root_event_id}`, due, quote.root_event_id, quote.head_event_id);
          // Current head updates/reschedules only pending occurrences; a sent
          // occurrence for this root can never be recreated after correction.
          inserts.push(
            db
              .prepare(
                `UPDATE reminders SET remind_at = ?, head_event_id = ?, rule_revision = ?, status = 'pending', last_error = NULL, updated_at = ?
            WHERE workspace_id = ? AND rule_id = ? AND occurrence_key = ? AND (status = 'pending' OR (status = 'cancelled' AND last_error IN ('Follow-up changed.', 'Quote removed or no longer matches this follow-up.')))
            AND EXISTS (SELECT 1 FROM reminder_rules r WHERE r.id = reminders.rule_id AND r.revision = ? AND r.status = 'active')`,
              )
              .bind(
                due,
                quote.head_event_id,
                rule.revision,
                now,
                rule.workspace_id,
                rule.id,
                `quote:${quote.root_event_id}`,
                rule.revision,
              ),
          );
          if (due > now && (!next || due < next)) next = due;
        }
        if (quotes.length === 4) next = now; // continue the bounded set next tick
        inserts.push(
          db
            .prepare(
              `UPDATE reminders SET status = 'cancelled', last_error = 'Quote removed or no longer matches this follow-up.', updated_at = ? WHERE rule_id = ? AND status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM interaction_state i WHERE i.workspace_id = reminders.workspace_id AND i.root_event_id = reminders.interaction_id AND i.state = 'active' AND json_extract(i.head_value_json, '$.role') = ?)`,
            )
            .bind(now, rule.id, rule.spec.role),
        );
      }
    }
    const afterQuote = rule.status === 'active' && rule.spec.kind === 'after_quote';
    inserts.push(
      db
        .prepare(
          `UPDATE reminder_rule_cursors SET dirty = ?, next_due = CASE WHEN ? THEN (SELECT MIN(remind_at) FROM reminders WHERE rule_id = ? AND status = 'pending') ELSE ? END, updated_at = ? WHERE rule_id = ? AND rule_revision = ?
      AND EXISTS (SELECT 1 FROM reminder_rules r JOIN workspaces w ON w.id = r.workspace_id WHERE r.id = reminder_rule_cursors.rule_id AND r.revision = ? AND w.business_revision = ?)`,
        )
        .bind(
          afterQuote && next === now ? 1 : 0,
          Number(afterQuote),
          rule.id,
          next,
          now,
          rule.id,
          rule.revision,
          rule.revision,
          Number(row.read_revision),
        ),
    );
    const committed = await db.batch(inserts);
    occurrences += committed
      .filter((_, n) => occurrenceIndexes.has(n))
      .reduce((sum, r) => sum + r.meta.changes, 0);
  }
  return occurrences;
}
