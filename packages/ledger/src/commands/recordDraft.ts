/**
 * @otis/ledger/commands/recordDraft
 * Handles record_draft command for outward drafts (preparation only, no outward provider send).
 */

import type { CommandResult, LedgerEvent } from '@otis/contracts';
import type { LedgerCommandContext, LedgerProjectionState, RecordDraftArgs } from '../types.js';
import { createLedgerEvent } from './events.js';
import { reduceDrafts } from '../reducers/drafts.js';

export function handleRecordDraft(
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: RecordDraftArgs,
): {
  result: CommandResult<{ draft_id: string }>;
  events: LedgerEvent[];
  nextState?: LedgerProjectionState;
} {
  const trimmedText = args.content_text.trim();
  if (!trimmedText) {
    return {
      result: {
        status: 'rejected',
        error: { code: 'bad_request', message: 'Draft content text cannot be empty.' },
      },
      events: [],
    };
  }

  const draftId = args.draft_id || `dft_${crypto.randomUUID()}`;
  const existing = state.drafts.get(draftId);

  const event = createLedgerEvent(context, nextSequence, {
    entity_id: args.entity_id || null,
    kind: existing ? 'draft_updated' : 'draft_created',
    payload: {
      draft_id: draftId,
      entity_id: args.entity_id || null,
      channel: args.channel,
      recipient_address: args.recipient_address || null,
      content_text: trimmedText,
    },
    provenance: 'stated',
  });

  const nextDrafts = new Map(state.drafts);
  reduceDrafts(nextDrafts, event);

  return {
    result: {
      status: 'applied',
      action_id: context.action_id,
      affected_resource_ids: [draftId],
      event_ids: [event.id],
      summary: `${existing ? 'Updated' : 'Recorded'} draft for channel '${args.channel}'.`,
      data: { draft_id: draftId },
    },
    events: [event],
    nextState: { ...state, drafts: nextDrafts },
  };
}
