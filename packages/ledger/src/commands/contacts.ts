import type { ChangeContactArgs, CommandResult, EntityContact, LedgerEvent } from '@otis/contracts';
import type { LedgerCommandContext, LedgerProjectionState } from '../types.js';
import { createLedgerEvent } from './events.js';
import { canonicalId, contactComparison } from '../reducers/business.js';

export function validContactValue(method: string, value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 320) return false;
  return method === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) :
    method === 'phone' && /^\+?[\d\s().-]{3,40}(?:\s*(?:ext\.?|x)\s*\d{1,8})?$/i.test(value.trim()) && (value.match(/\d/g)?.length ?? 0) >= 3;
}
export function handleChangeContact(context: LedgerCommandContext, state: LedgerProjectionState, seq: number, args: ChangeContactArgs): { result: CommandResult; events: LedgerEvent[]; nextState?: LedgerProjectionState } {
  const reject = (code: string, message: string) => ({ result: { status: 'rejected' as const, error: { code, message } }, events: [] });
  if (!state.entities.has(args.entity_id)) return reject('not_found', 'Client not found.');
  const previous = args.contact_id ? state.contacts?.get(args.contact_id) : undefined;
  if (args.contact_id && (!previous || canonicalId(state, previous.entity_id) !== canonicalId(state, args.entity_id))) return reject('not_found', 'Contact not found on this client.');
  if (previous && args.expected_revision !== previous.revision) return { result: { status: 'conflict', error: { code: 'contact_changed', message: 'This contact changed. Inspect its current value before editing.' }, data: previous }, events: [] };
  if (!['save', 'remove', 'make_primary'].includes(args.operation) || (args.operation !== 'save' && !previous)) return reject('invalid_argument', 'Choose a contact and a valid operation.');
  const method = args.method ?? previous?.method;
  if (args.value !== undefined && typeof args.value !== 'string' || args.primary !== undefined && typeof args.primary !== 'boolean') return reject('invalid_argument', 'Enter a contact value and a valid primary choice.');
  const value = args.value?.trim() ?? previous?.value;
  if (!method || !validContactValue(method, value) || (previous && method !== previous.method)) return reject('invalid_contact', 'Enter a valid phone or email; changing its type requires a new contact.');
  if (args.label !== undefined && args.label !== null && (typeof args.label !== 'string' || args.label.length > 80)) return reject('invalid_argument', 'Contact label is too long.');
  const comparison = contactComparison(method, value);
  const duplicate = [...state.contacts?.values() ?? []].find(c => canonicalId(state, c.entity_id) === canonicalId(state, args.entity_id) && c.method === method && c.state === 'active' && contactComparison(c.method, c.value) === comparison && c.id !== previous?.id);
  if (duplicate && args.operation === 'save') {
    if (previous) return reject('duplicate_contact', 'That contact already exists. Remove this duplicate or use the existing contact.');
    return { result: { status: 'already_applied', summary: 'This contact is already saved.', data: duplicate }, events: [] };
  }
  const contact: EntityContact = {
    id: previous?.id ?? `contact_${crypto.randomUUID()}`, workspace_id: context.workspace_id, entity_id: previous?.entity_id ?? args.entity_id,
    method, value, comparison_key: comparison, label: args.label === undefined ? previous?.label ?? null : args.label,
    is_primary: args.operation === 'remove' ? false : args.operation === 'make_primary' ? true : args.primary ?? previous?.is_primary ?? false,
    state: args.operation === 'remove' ? 'removed' : 'active', revision: (previous?.revision ?? 0) + 1,
    source_event_id: '', original_event_id: previous?.original_event_id ?? '', updated_at: '',
  };
  if (previous && ['value', 'label', 'is_primary', 'state'].every(key => previous[key as keyof EntityContact] === contact[key as keyof EntityContact])) return { result: { status: 'already_applied', data: previous }, events: [] };
  const event = createLedgerEvent(context, seq, { entity_id: contact.entity_id, kind: 'contact_changed', payload: { contact }, supersedes_event_id: previous?.source_event_id, provenance: 'stated' });
  contact.source_event_id = event.id; contact.original_event_id ||= event.id; contact.updated_at = event.recorded_at;
  return { result: { status: 'applied', action_id: context.action_id, event_ids: [event.id], affected_resource_ids: [args.entity_id, contact.id], summary: args.operation === 'remove' ? 'Removed this contact; its history is preserved.' : `Saved ${method} contact.`, data: contact }, events: [event], nextState: { ...state, contacts: new Map(state.contacts) } };
}
