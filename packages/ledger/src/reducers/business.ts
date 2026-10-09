import type { AttachmentLink, EntityContact, EntityRedirect, EntityStateField, LedgerEvent, ReminderRule } from '@otis/contracts';
import type { LedgerProjectionState } from '../types.js';
import { reduceFields } from './fields.js';
import { reduceEntity } from './entities.js';

export function canonicalId(state: LedgerProjectionState, id: string): string {
  const seen = new Set<string>();
  while (state.redirects?.has(id)) {
    if (seen.has(id) || seen.size >= 32) throw new Error('Invalid client redirect chain.');
    seen.add(id); id = state.redirects.get(id)!.target_entity_id;
  }
  return id;
}
function mergeFields(state: LedgerProjectionState, event: LedgerEvent, sourceId: string, targetId: string, decisions: Record<string, string>) {
  const source = state.entities.get(sourceId)!, target = state.entities.get(targetId)!;
  for (const entity of [source, target]) {
    for (const name of ['status', 'assigned_user_id']) {
      const key = `${entity.id}:${name}`;
      if (state.fields.has(key)) continue;
      const alias = [...state.aliases.values()].filter(a => a.entity_id === entity.id).sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
      const value = name === 'status' ? entity.status : entity.assigned_user_id ?? '';
      state.fields.set(key, { id: `${entity.id}_${name}`, workspace_id: event.workspace_id, entity_id: entity.id, field_name: name, state: 'clear', value_text: value, value_json: null, provenance: 'stated', source_event_id: alias?.source_event_id ?? event.id, candidate_event_ids: null, last_confirmed_value_text: value, last_confirmed_value_json: null, revision: 1, updated_at: entity.updated_at });
    }
  }
  for (const field of [...state.fields.values()]) {
    if (field.entity_id !== sourceId) continue;
    const key = `${targetId}:${field.field_name}`, other = state.fields.get(key);
    const pick = decisions[field.field_name === 'assigned_user_id' ? 'assigned_member' : field.field_name];
    let combined: EntityStateField;
    if (!other || pick === sourceId) combined = { ...field, id: `${targetId}_${field.field_name}`, entity_id: targetId, revision: (other?.revision ?? 0) + 1 };
    else if (pick === targetId || (other.state === 'clear' && field.state === 'clear' && other.value_text === field.value_text && other.value_json === field.value_json)) continue;
    else combined = { ...other, state: 'disputed', value_text: null, value_json: null, last_confirmed_value_text: null, last_confirmed_value_json: null,
      source_event_id: event.id, candidate_event_ids: [...new Set([...(other.candidate_event_ids ?? [other.source_event_id!]), ...(field.candidate_event_ids ?? [field.source_event_id!])].filter(Boolean))], revision: other.revision + 1, updated_at: event.recorded_at };
    state.fields.set(key, combined);
  }
  const quote = state.fields.get(`${targetId}:quote`);
  if (decisions.quote && quote?.state === 'clear') {
    const covered = Object.fromEntries([...state.interactions].filter(([, i]) => i.kind === 'quote' && i.state === 'active' && i.entity_id && canonicalId(state, i.entity_id) === targetId).map(([root, i]) => [root, i.head_value_json]).sort(([a], [b]) => String(a).localeCompare(String(b))));
    state.fields.set(`${targetId}:quote`, { ...quote, quote_authority_json: JSON.stringify({ event_id: event.id, value_text: quote.value_text, value_json: quote.value_json, provenance: 'stated', covered }) });
  }
  const status = state.fields.get(`${targetId}:status`), owner = state.fields.get(`${targetId}:assigned_user_id`);
  state.entities.set(targetId, { ...target, ...(status?.state === 'clear' && status.value_text ? { status: status.value_text as typeof target.status } : {}), ...(owner?.state === 'clear' ? { assigned_user_id: owner.value_text || null } : {}), updated_at: event.recorded_at });
}

/** Forward only the current projection; the saved event retains its immutable originating client. */
function forwardCurrentFacts(state: LedgerProjectionState, event: LedgerEvent) {
  if (!event.entity_id || !state.redirects?.size) return;
  if (!['field_change', 'status_change', 'conflict_resolved', 'quote', 'interaction_removed'].includes(event.kind)) return;
  const target = canonicalId(state, event.entity_id);
  if (target === event.entity_id && !['quote', 'interaction_removed', 'conflict_resolved'].includes(event.kind)) return;
  if (!state.entities.has(target)) return;
  const projected = { ...event, entity_id: target };
  const interactions = new Map([...state.interactions].map(([id, row]) => [id, { ...row, entity_id: row.entity_id ? canonicalId(state, row.entity_id) : null }]));
  reduceEntity(state.entities, state.aliases, projected);
  reduceFields(state.fields, interactions, projected);
}

export function contactComparison(method: 'phone' | 'email', value: string): string {
  if (method === 'phone') return value.replace(/[\s().-]/g, '');
  const at = value.lastIndexOf('@');
  return `${value.slice(0, at)}@${value.slice(at + 1).toLowerCase()}`;
}
export function reduceBusinessDetails(state: LedgerProjectionState, event: LedgerEvent): void {
  forwardCurrentFacts(state, event);
  if (event.kind === 'conflict_resolved' && event.entity_id) {
    const field = (event.payload as { field_name: string }).field_name, id = canonicalId(state, event.entity_id), entity = state.entities.get(id), value = state.fields.get(`${id}:${field}`);
    if (entity && value?.state === 'clear' && (field === 'status' || field === 'assigned_user_id')) state.entities.set(id, { ...entity, ...(field === 'status' ? { status: value.value_text as typeof entity.status } : { assigned_user_id: value.value_text || null }), updated_at: event.recorded_at });
  }
  if (event.kind === 'entity_deleted' && event.entity_id) {
    for (const map of [state.contacts, state.attachmentLinks, state.reminderRules]) {
      for (const [id, row] of map ?? []) if (row.entity_id === event.entity_id) map!.delete(id);
    }
    for (const [id, row] of state.redirects ?? []) if (row.source_entity_id === event.entity_id || row.target_entity_id === event.entity_id) state.redirects!.delete(id);
    return;
  }
  if (event.kind === 'field_change' && event.entity_id) {
    const p = event.payload as { field_name: string; new_value: unknown };
    if (p.field_name !== 'phone') return;
    const field = state.fields.get(`${event.entity_id}:phone`);
    if (!field) return;
    const contacts = state.contacts ?? (state.contacts = new Map());
    const id = `legacy_phone_${event.entity_id}`, before = contacts.get(id);
    const value = field.value_text ?? '';
    const hasPrimary = [...contacts.values()].some(c => canonicalId(state, c.entity_id) === canonicalId(state, event.entity_id!) && c.method === 'phone' && c.is_primary && c.state === 'active' && c.id !== id);
    contacts.set(id, { id, workspace_id: event.workspace_id, entity_id: event.entity_id, method: 'phone', value,
      comparison_key: contactComparison('phone', value), label: null, is_primary: !hasPrimary,
      state: field.state === 'disputed' ? 'disputed' : value ? 'active' : 'removed',
      revision: (before?.revision ?? 0) + 1, source_event_id: event.id, original_event_id: before?.original_event_id ?? event.id, updated_at: event.recorded_at });
  } else if (event.kind === 'contact_changed') {
    const p = event.payload as { contact: EntityContact };
    const contacts = state.contacts ?? (state.contacts = new Map());
    const row = { ...p.contact, workspace_id: event.workspace_id, source_event_id: event.id, updated_at: event.recorded_at };
    if (row.is_primary && row.state === 'active') {
      for (const [id, other] of contacts) if (canonicalId(state, other.entity_id) === canonicalId(state, row.entity_id) && other.method === row.method && other.is_primary && id !== row.id) contacts.set(id, { ...other, is_primary: false, source_event_id: event.id, revision: other.revision + 1, updated_at: event.recorded_at });
    }
    contacts.set(row.id, row);
  } else if (event.kind === 'entity_merged') {
    const p = event.payload as { source_entity_id: string; target_entity_id: string; decisions: Record<string, string> };
    const redirects = state.redirects ?? (state.redirects = new Map());
    // Resolve contact primaries against their pre-merge identities. Retain
    // every value, but leave no misleading primary when the member hasn't chosen.
    for (const method of ['phone', 'email']) {
      const primaries = [...state.contacts?.values() ?? []].filter(c => c.method === method && c.state === 'active' && c.is_primary && [p.source_entity_id, p.target_entity_id].includes(canonicalId(state, c.entity_id)));
      if (primaries.length < 2) continue;
      const choice = p.decisions[`primary_${method}`];
      const winner = choice ? primaries.find(c => canonicalId(state, c.entity_id) === choice) : primaries.every(c => c.comparison_key === primaries[0]!.comparison_key) ? primaries.find(c => canonicalId(state, c.entity_id) === p.target_entity_id) : undefined;
      for (const c of primaries) state.contacts!.set(c.id, { ...c, is_primary: c.id === winner?.id, revision: c.revision + 1, source_event_id: event.id, updated_at: event.recorded_at });
    }
    const row: EntityRedirect = { workspace_id: event.workspace_id, ...p, source_event_id: event.id, revision: 1, updated_at: event.recorded_at };
    redirects.set(row.source_entity_id, row);
    mergeFields(state, event, row.source_entity_id, row.target_entity_id, row.decisions);
  } else if (event.kind === 'attachment_linked' || event.kind === 'attachment_unlinked') {
    const p = event.payload as { link: AttachmentLink };
    const links = state.attachmentLinks ?? (state.attachmentLinks = new Map());
    links.set(p.link.id, { ...p.link, workspace_id: event.workspace_id, source_event_id: event.id, updated_at: event.recorded_at });
    const annotation = state.mediaAnnotations?.get(p.link.media_id);
    if (event.kind === 'attachment_linked' && annotation?.retention === 'release') state.mediaAnnotations!.set(p.link.media_id, { ...annotation, retention: 'retain', release_after: null, revision: annotation.revision + 1, source_event_id: event.id, updated_at: event.recorded_at });
  } else if (event.kind === 'attachment_updated') {
    const p = event.payload as { annotation: import('@otis/contracts').MediaAnnotation };
    const annotations = state.mediaAnnotations ?? (state.mediaAnnotations = new Map());
    annotations.set(p.annotation.media_id, { ...p.annotation, workspace_id: event.workspace_id, source_event_id: event.id, updated_at: event.recorded_at });
  } else if (event.kind === 'reminder_rule_changed') {
    const p = event.payload as { rule: ReminderRule };
    const rules = state.reminderRules ?? (state.reminderRules = new Map());
    rules.set(p.rule.id, { ...p.rule, workspace_id: event.workspace_id, source_event_id: event.id, updated_at: event.recorded_at });
  }
}
