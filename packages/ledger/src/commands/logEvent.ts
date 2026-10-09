/**
 * @otis/ledger/commands/logEvent
 * Handles log_event command for closed kinds: note, visit, contact, quote.
 */

import type { CommandResult, LedgerEvent } from '@otis/contracts';
import { normalizeInteractionOccurredAt } from '@otis/contracts';
import type { LedgerCommandContext, LedgerProjectionState, LogEventArgs } from '../types.js';
import { createLedgerEvent } from './events.js';
import { validateInteractionPayload } from './interactionPayload.js';
import { reduceFields } from '../reducers/fields.js';
import { reduceInteractions } from '../reducers/interactions.js';

export function handleLogEvent(
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: LogEventArgs,
): {
  result: CommandResult<{ event_id: string }>;
  events: LedgerEvent[];
  nextState?: LedgerProjectionState;
} {
  if (args.entity_id) {
    const entity = state.entities.get(args.entity_id);
    if (!entity) {
      return {
        result: {
          status: 'rejected',
          error: { code: 'not_found', message: `Entity '${args.entity_id}' not found.` },
        },
        events: [],
      };
    }
  }

  // Validate payload by kind through the shared interaction validator so
  // corrections accept exactly what new logging accepts.
  const { interaction_id: _dropped, ...freshPayload } = args.payload as Record<string, unknown>;
  void _dropped;
  const validation = validateInteractionPayload(args.kind, freshPayload);
  if (!validation.valid) {
    return {
      result: {
        status: 'rejected',
        error: {
          code: validation.code,
          message: validation.message,
        },
      },
      events: [],
    };
  }

  // A new log is always a fresh root: a model-supplied interaction_id
  // marker is stripped, never attached to another root. Only the revision
  // command may chain onto an existing root, through its validated
  // root/head arguments. The agent schemas reject this key up front; this
  // lower boundary stays safe for every other trusted command caller.
  const occurredAt = args.occurred_at === undefined ? undefined : normalizeInteractionOccurredAt(args.occurred_at);
  if (occurredAt === null) {
    return { result: { status: 'rejected', error: { code: 'invalid_occurred_at', message: 'Occurred date must be a valid ISO timestamp with a timezone.' } }, events: [] };
  }

  const event = createLedgerEvent(context, nextSequence, {
    entity_id: args.entity_id || null,
    kind: args.kind,
    payload: validation.payload,
    occurred_at: occurredAt,
    provenance: args.provenance || 'stated',
  });

  const nextFields = new Map(state.fields);
  const nextInteractions = new Map(state.interactions);
  reduceInteractions(nextInteractions, event);
  reduceFields(nextFields, nextInteractions, event);

  return {
    result: {
      status: 'applied',
      action_id: context.action_id,
      affected_resource_ids: args.entity_id ? [args.entity_id] : [],
      event_ids: [event.id],
      summary: `Logged ${args.kind} event${args.entity_id ? ` for entity '${args.entity_id}'` : ''}.`,
      data: { event_id: event.id },
    },
    events: [event],
    nextState: { ...state, fields: nextFields, interactions: nextInteractions },
  };
}
