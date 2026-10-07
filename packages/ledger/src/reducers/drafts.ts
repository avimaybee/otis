/**
 * @otis/ledger/reducers/drafts
 * Reducer for outward draft projections.
 */

import type { DraftProjection, LedgerEvent } from '@otis/contracts';

export function reduceDrafts(
  drafts: Map<string, DraftProjection>,
  event: LedgerEvent,
): void {
  switch (event.kind) {
    case 'draft_created': {
      const p = event.payload as {
        draft_id: string;
        entity_id?: string | null;
        channel: 'whatsapp' | 'email' | 'sms' | 'other';
        recipient_address?: string | null;
        content_text: string;
      };
      drafts.set(p.draft_id, {
        id: p.draft_id,
        workspace_id: event.workspace_id,
        entity_id: p.entity_id || null,
        channel: p.channel,
        recipient_address: p.recipient_address || null,
        content_text: p.content_text,
        status: 'draft',
        source_event_id: event.id,
        revision: 1,
        created_at: event.recorded_at,
        updated_at: event.recorded_at,
      });
      break;
    }

    case 'draft_updated': {
      const p = event.payload as {
        draft_id: string;
        content_text?: string;
        recipient_address?: string | null;
        status?: 'draft' | 'member_confirmed_sent' | 'archived';
      };
      const draft = drafts.get(p.draft_id);
      if (draft) {
        if (p.content_text !== undefined) draft.content_text = p.content_text;
        if (p.recipient_address !== undefined) draft.recipient_address = p.recipient_address;
        if (p.status !== undefined) draft.status = p.status;
        draft.revision += 1;
        draft.updated_at = event.recorded_at;
      }
      break;
    }

    case 'message_sent_by_member': {
      const p = event.payload as { draft_id?: string };
      if (p.draft_id) {
        const draft = drafts.get(p.draft_id);
        if (draft) {
          draft.status = 'member_confirmed_sent';
          draft.revision += 1;
          draft.updated_at = event.recorded_at;
        }
      }
      break;
    }

    case 'entity_deleted': {
      if (!event.entity_id) return;
      for (const [id, draft] of drafts) {
        if (draft.entity_id === event.entity_id) drafts.delete(id);
      }
      break;
    }
  }
}
