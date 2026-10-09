import type { CommandResult, LedgerEvent, MergeEntitiesArgs } from '@otis/contracts';
import type { LedgerCommandContext, LedgerProjectionState } from '../types.js';
import { createLedgerEvent } from './events.js';
import { canonicalId } from '../reducers/business.js';

export function previewEntityMerge(state: LedgerProjectionState, sourceId: string, targetId: string) {
  const source = state.entities.get(sourceId), target = state.entities.get(targetId);
  if (!source || !target || sourceId === targetId) return null;
  const conflicts: { field: string; source: unknown; target: unknown }[] = [];
  if (source.status !== target.status) conflicts.push({ field: 'status', source: source.status, target: target.status });
  if (source.assigned_user_id !== target.assigned_user_id) conflicts.push({ field: 'assigned_member', source: source.assigned_user_id, target: target.assigned_user_id });
  for (const field of state.fields.values()) {
    if (field.entity_id !== sourceId) continue;
    const other = state.fields.get(`${targetId}:${field.field_name}`);
    if (other && (other.state === 'disputed' || field.state === 'disputed' || other.value_json !== field.value_json || other.value_text !== field.value_text) && !conflicts.some(c => c.field === (field.field_name === 'assigned_user_id' ? 'assigned_member' : field.field_name))) conflicts.push({ field: field.field_name === 'assigned_user_id' ? 'assigned_member' : field.field_name, source: field.value_json ?? field.value_text, target: other.value_json ?? other.value_text });
  }
  for (const method of ['phone', 'email']) {
    const a = [...state.contacts?.values() ?? []].filter(c => canonicalId(state, c.entity_id) === sourceId && c.method === method && c.is_primary && c.state === 'active');
    const b = [...state.contacts?.values() ?? []].filter(c => canonicalId(state, c.entity_id) === targetId && c.method === method && c.is_primary && c.state === 'active');
    if (a.length && b.length && a.some(c => b.some(d => c.comparison_key !== d.comparison_key))) conflicts.push({ field: `primary_${method}`, source: a.map(c => c.value), target: b.map(c => c.value) });
  }
  return { source: { id: source.id, name: source.name }, target: { id: target.id, name: target.name }, conflicts,
    manifest: [...state.entities.values()].map(e => ({ origin_entity_id: e.id, name: e.name, combined_entity_id: targetId, counts: state.mergeCounts?.get(e.id) ?? {}, counts_available: Boolean(state.mergeCounts) })),
    preservation: 'Both original files and every note, task, contact, source and attachment remain stored under their original identities. A combined file reads both; Undo removes this combination without moving later work.' };
}
export function handleMergeEntities(context: LedgerCommandContext, state: LedgerProjectionState, seq: number, args: MergeEntitiesArgs): { result: CommandResult; events: LedgerEvent[]; nextState?: LedgerProjectionState } {
  const preview = previewEntityMerge(state, args.source_entity_id, args.target_entity_id);
  if (!preview) return { result: { status: 'rejected', error: { code: 'invalid_merge', message: 'Choose two different clients in this workspace.' } }, events: [] };
  if (args.expected_revision !== context.expected_business_revision) return { result: { status: 'conflict', error: { code: 'merge_changed', message: 'The files changed since the preview. Review them again.' } }, events: [] };
  if (state.redirects?.has(args.source_entity_id) || state.redirects?.has(args.target_entity_id)) return { result: { status: 'conflict', error: { code: 'already_combined', message: 'Use the current combined files from lookup.' } }, events: [] };
  if (context.merge_identity_confirmed === false) return { result: { status: 'needs_clarification', clarification: { prompt: `Are ${preview.source.name} and ${preview.target.name} the same client? Confirm to combine their files while keeping every original record, or cancel. Conflicting facts remain disputed unless you choose a value.`, missing_fields: ['merge_identity'], candidates: ['confirm', 'cancel'] } }, events: [] };
  const decisions = args.decisions ?? {};
  for (const [field, choice] of Object.entries(decisions)) if (!preview.conflicts.some(c => c.field === field) || (choice !== args.source_entity_id && choice !== args.target_entity_id)) return { result: { status: 'rejected', error: { code: 'invalid_decision', message: 'A conflict decision must select one of these two original files.' } }, events: [] };
  const event = createLedgerEvent(context, seq, { entity_id: args.target_entity_id, kind: 'entity_merged', payload: { source_entity_id: args.source_entity_id, target_entity_id: args.target_entity_id, decisions }, provenance: 'stated' });
  return { result: { status: 'applied', action_id: context.action_id, event_ids: [event.id], affected_resource_ids: [args.source_entity_id, args.target_entity_id], summary: `Combined ${preview.source.name} with ${preview.target.name}; original information and sources are preserved.`, data: { ...preview, decisions, unresolved_fields: preview.conflicts.filter(c => !decisions[c.field]).map(c => c.field) } }, events: [event], nextState: { ...state, redirects: new Map(state.redirects) } };
}
