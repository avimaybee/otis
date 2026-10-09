import { validateReminderSpec, validReminderTimezone, type ChangeReminderRuleArgs, type CommandResult, type LedgerEvent, type ReminderRule } from '@otis/contracts';
import type { LedgerCommandContext, LedgerProjectionState } from '../types.js';
import { createLedgerEvent } from './events.js';

export function handleChangeReminderRule(context: LedgerCommandContext, state: LedgerProjectionState, seq: number, args: ChangeReminderRuleArgs): { result: CommandResult; events: LedgerEvent[]; nextState?: LedgerProjectionState } {
  const reject = (code: string, message: string) => ({ result: { status: 'rejected' as const, error: { code, message } }, events: [] });
  if (context.actor.kind !== 'member' || !context.actor.user_id) return reject('not_member', 'Only the member can change their follow-ups.');
  const before = args.rule_id ? state.reminderRules?.get(args.rule_id) : undefined;
  if (args.rule_id && (!before || before.user_id !== context.actor.user_id)) return reject('not_found', 'Follow-up not found.');
  if (before && args.expected_revision !== before.revision) return { result: { status: 'conflict', data: before, error: { code: 'rule_changed', message: 'This follow-up changed. Refresh before editing.' } }, events: [] };
  const text = args.text ?? before?.text, timezone = args.timezone ?? before?.timezone, spec = args.spec ?? before?.spec, channel = args.channel ?? before?.channel, entity = args.entity_id === undefined ? before?.entity_id ?? null : args.entity_id, status = args.status ?? before?.status ?? 'active';
  if (typeof text !== 'string' || !text.trim() || text.length > 1000 || !validReminderTimezone(timezone) || !validateReminderSpec(spec) || !channel || !['web', 'telegram'].includes(channel) || !['active', 'paused', 'cancelled'].includes(status)) return reject('invalid_rule', 'Choose the follow-up text, timing, timezone and delivery channel.');
  if (entity !== null && !state.entities.has(entity) || spec.kind === 'after_quote' && !entity) return reject('invalid_entity', 'After-quote follow-ups need a client in this workspace.');
  const rule: ReminderRule = { id: before?.id ?? `rule_${crypto.randomUUID()}`, workspace_id: context.workspace_id, user_id: context.actor.user_id, entity_id: entity, text: text.trim(), timezone, channel, spec, status, revision: (before?.revision ?? 0) + 1, source_event_id: '', updated_at: '' };
  if (before && ['text', 'timezone', 'channel', 'spec', 'status', 'entity_id'].every(k => JSON.stringify(before[k as keyof ReminderRule]) === JSON.stringify(rule[k as keyof ReminderRule]))) return { result: { status: 'already_applied', data: before }, events: [] };
  const event = createLedgerEvent(context, seq, { entity_id: entity, kind: 'reminder_rule_changed', payload: { rule }, provenance: 'stated', supersedes_event_id: before?.source_event_id });
  rule.source_event_id = event.id; rule.updated_at = event.recorded_at;
  return { result: { status: 'applied', action_id: context.action_id, event_ids: [event.id], affected_resource_ids: [rule.id, ...entity ? [entity] : []], summary: status === 'active' ? 'Saved this recurring follow-up.' : status === 'paused' ? 'Paused this follow-up.' : 'Cancelled this follow-up.', data: rule }, events: [event], nextState: { ...state, reminderRules: new Map(state.reminderRules) } };
}
