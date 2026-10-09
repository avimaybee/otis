import type { AttachmentLink, CommandResult, LedgerEvent, LinkAttachmentArgs, UnlinkAttachmentArgs, MediaAnnotation, UpdateAttachmentArgs } from '@otis/contracts';
import type { LedgerCommandContext, LedgerProjectionState } from '../types.js';
import { createLedgerEvent } from './events.js';

export function handleUpdateAttachment(context: LedgerCommandContext, state: LedgerProjectionState, seq: number, args: UpdateAttachmentArgs): { result: CommandResult; events: LedgerEvent[]; nextState?: LedgerProjectionState } {
  const before = state.mediaAnnotations?.get(args.media_id);
  if (![...state.attachmentLinks?.values() ?? []].some(l => l.media_id === args.media_id && l.entity_id === args.entity_id)) return { result: { status: 'rejected', error: { code: 'not_found', message: 'Choose a file saved with this client.' } }, events: [] };
  if (!Number.isSafeInteger(args.expected_revision) || args.expected_revision !== (before?.revision ?? 0)) return { result: { status: 'conflict', data: before, error: { code: 'file_changed', message: 'This file changed. Refresh before editing.' } }, events: [] };
  if (args.transcript === undefined && args.retention === undefined || args.transcript !== undefined && args.transcript !== null && (typeof args.transcript !== 'string' || !args.transcript.trim() || args.transcript.length > 50_000) || args.retention !== undefined && !['retain', 'release'].includes(args.retention)) return { result: { status: 'rejected', error: { code: 'invalid_file_edit', message: 'Choose a corrected transcript or retention change.' } }, events: [] };
  const transcript = args.transcript === undefined ? before?.transcript ?? null : args.transcript;
  const retention = args.retention ?? before?.retention ?? 'inherit';
  if (before && transcript === before.transcript && retention === before.retention) return { result: { status: 'already_applied', data: before }, events: [] };
  const event = createLedgerEvent(context, seq, { entity_id: args.entity_id, kind: 'attachment_updated', payload: {}, provenance: 'stated', supersedes_event_id: before?.source_event_id });
  const annotation: MediaAnnotation = { media_id: args.media_id, workspace_id: context.workspace_id, transcript, retention, release_after: retention === 'release' ? before?.retention === 'release' ? before.release_after : new Date(Date.parse(event.recorded_at) + 14 * 86400000).toISOString() : null, revision: (before?.revision ?? 0) + 1, source_event_id: event.id, updated_at: event.recorded_at };
  event.payload = { annotation };
  return { result: { status: 'applied', action_id: context.action_id, event_ids: [event.id], affected_resource_ids: [args.entity_id, args.media_id], summary: args.retention === 'release' ? 'Released retention. The original remains available for 14 days; Undo is available during that time.' : 'Saved the file change. Original audio and transcript remain intact.', data: annotation }, events: [event], nextState: { ...state, mediaAnnotations: new Map(state.mediaAnnotations) } };
}

export function handleLinkAttachment(context: LedgerCommandContext, state: LedgerProjectionState, seq: number, args: LinkAttachmentArgs): { result: CommandResult; events: LedgerEvent[]; nextState?: LedgerProjectionState } {
  if (!state.entities.has(args.entity_id) || typeof args.media_id !== 'string' || !args.media_id || args.label !== undefined && (typeof args.label !== 'string' || args.label.length > 200)) return { result: { status: 'rejected', error: { code: 'invalid_attachment', message: 'Choose a client, an available file and a short label.' } }, events: [] };
  if (args.interaction_id) { const root = state.interactions.get(args.interaction_id); if (!root || root.entity_id !== args.entity_id || root.state !== 'active') return { result: { status: 'rejected', error: { code: 'invalid_source', message: 'Choose a current entry on this client.' } }, events: [] }; }
  const previous = [...state.attachmentLinks?.values() ?? []].find(l => l.entity_id === args.entity_id && l.media_id === args.media_id && l.interaction_id === (args.interaction_id ?? null));
  if (previous?.state === 'active' && previous.label === (args.label ?? null)) return { result: { status: 'already_applied', data: previous }, events: [] };
  const link: AttachmentLink = { id: previous?.id ?? `file_${crypto.randomUUID()}`, workspace_id: context.workspace_id, entity_id: args.entity_id, media_id: args.media_id, interaction_id: args.interaction_id ?? null, label: args.label ?? null, state: 'active', revision: (previous?.revision ?? 0) + 1, source_event_id: '', updated_at: '' };
  const event = createLedgerEvent(context, seq, { entity_id: args.entity_id, kind: 'attachment_linked', payload: { link }, provenance: 'stated', supersedes_event_id: previous?.source_event_id });
  link.source_event_id = event.id; link.updated_at = event.recorded_at;
  return { result: { status: 'applied', action_id: context.action_id, event_ids: [event.id], affected_resource_ids: [args.entity_id, link.id], summary: 'Saved the file with this client. The original is retained.', data: link }, events: [event], nextState: { ...state, attachmentLinks: new Map(state.attachmentLinks) } };
}
export function handleUnlinkAttachment(context: LedgerCommandContext, state: LedgerProjectionState, seq: number, args: UnlinkAttachmentArgs): { result: CommandResult; events: LedgerEvent[]; nextState?: LedgerProjectionState } {
  const previous = state.attachmentLinks?.get(args.link_id);
  if (!previous) return { result: { status: 'rejected', error: { code: 'not_found', message: 'Linked file not found.' } }, events: [] };
  if (previous.revision !== args.expected_revision) return { result: { status: 'conflict', error: { code: 'file_changed', message: 'This file link changed. Refresh before removing it.' }, data: previous }, events: [] };
  if (previous.state === 'unlinked') return { result: { status: 'already_applied', data: previous }, events: [] };
  const link = { ...previous, state: 'unlinked' as const, revision: previous.revision + 1 };
  const event = createLedgerEvent(context, seq, { entity_id: previous.entity_id, kind: 'attachment_unlinked', payload: { link }, provenance: 'stated', supersedes_event_id: previous.source_event_id });
  return { result: { status: 'applied', action_id: context.action_id, event_ids: [event.id], affected_resource_ids: [link.entity_id, link.id], summary: 'Removed the file from this client; the original and history remain available to Undo.', data: link }, events: [event], nextState: { ...state, attachmentLinks: new Map(state.attachmentLinks) } };
}
