/**
 * @otis/ledger/commands/markMessageSent
 * Command handler for mark_message_sent.
 * In accordance with docs/archive/plans/006-implementation-handoff.md Section 5.
 */

import type { CommandResult, LedgerEvent, MessageSentByMemberPayload } from '@otis/contracts';
import type { LedgerCommandContext, LedgerProjectionState, MarkMessageSentArgs } from '../types.js';
import { createLedgerEvent } from './events.js';
import { reduceDrafts } from '../reducers/drafts.js';

export function handleMarkMessageSent(
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: MarkMessageSentArgs,
): {
  result: CommandResult;
  events: LedgerEvent[];
  nextState?: LedgerProjectionState;
} {
  if (!args || typeof args !== 'object' || !args.draft_id) {
    return {
      result: {
        status: 'rejected',
        action_id: context.action_id,
        error: { code: 'missing_draft_id', message: 'Missing draft_id in mark_message_sent.' },
      },
      events: [],
    };
  }

  const draft = state.drafts.get(args.draft_id);
  if (!draft) {
    return {
      result: {
        status: 'rejected',
        action_id: context.action_id,
        error: {
          code: 'not_found',
          message: `Draft '${args.draft_id}' not found in workspace.`,
        },
      },
      events: [],
    };
  }

  if (draft.status === 'member_confirmed_sent') {
    return {
      result: {
        status: 'already_applied',
        action_id: context.action_id,
        summary: `Draft '${args.draft_id}' is already marked sent.`,
      },
      events: [],
    };
  }

  const payload: MessageSentByMemberPayload = {
    draft_id: args.draft_id,
    confirmed_by_user_id: args.confirmed_by_user_id || context.actor.user_id || undefined,
  };

  const event = createLedgerEvent<MessageSentByMemberPayload>(context, nextSequence, {
    kind: 'message_sent_by_member',
    entity_id: draft.entity_id,
    payload,
    provenance: 'stated',
  });

  const nextState: LedgerProjectionState = {
    entities: new Map(state.entities),
    aliases: new Map(state.aliases),
    fields: new Map(state.fields),
    tasks: new Map(state.tasks),
    drafts: new Map(state.drafts),
    memoryEntries: new Map(state.memoryEntries),
    memorySuppressions: new Map(state.memorySuppressions),
  };

  reduceDrafts(nextState.drafts, event);

  return {
    result: {
      status: 'applied',
      action_id: context.action_id,
      affected_resource_ids: [args.draft_id],
      event_ids: [event.id],
      committed_revision: nextSequence,
      summary: `Marked draft '${args.draft_id}' as sent by member.`,
    },
    events: [event],
    nextState,
  };
}
