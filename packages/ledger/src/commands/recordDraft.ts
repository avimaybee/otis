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
  const draftId = args.draft_id || `dft_${crypto.randomUUID()}`;
  const existing = state.drafts.get(draftId);

  if (existing && args.expected_revision !== undefined && existing.revision !== args.expected_revision) {
    return {
      result: {
        status: 'conflict',
        error: {
          code: 'revision_conflict',
          message: `Stale draft revision: expected ${args.expected_revision}, current is ${existing.revision}.`,
        },
      },
      events: [],
    };
  }

  let trimmedText: string | undefined;
  if (args.content_text !== undefined) {
    trimmedText = args.content_text.trim();
    if (!trimmedText) {
      return {
        result: {
          status: 'rejected',
          error: { code: 'bad_request', message: 'Draft content text cannot be empty.' },
        },
        events: [],
      };
    }
  } else if (!existing) {
    return {
      result: {
        status: 'rejected',
        error: { code: 'bad_request', message: 'Draft content text cannot be empty.' },
      },
      events: [],
    };
  }

  const channel = args.channel || (existing ? existing.channel : undefined);
  if (!channel) {
    return {
      result: {
        status: 'rejected',
        error: { code: 'bad_request', message: 'Draft channel is required.' },
      },
      events: [],
    };
  }

  const event = createLedgerEvent(context, nextSequence, {
    entity_id: args.entity_id !== undefined ? (args.entity_id || null) : (existing ? existing.entity_id : null),
    kind: existing ? 'draft_updated' : 'draft_created',
    payload: existing
      ? {
          draft_id: draftId,
          content_text: trimmedText,
          recipient_address: args.recipient_address !== undefined ? (args.recipient_address || null) : undefined,
        }
      : {
          draft_id: draftId,
          entity_id: args.entity_id || null,
          channel,
          recipient_address: args.recipient_address || null,
          content_text: trimmedText!,
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
      summary: `${existing ? 'Updated' : 'Recorded'} draft for channel '${channel}'.`,
      data: { draft_id: draftId },
    },
    events: [event],
    nextState: { ...state, drafts: nextDrafts },
  };
}
