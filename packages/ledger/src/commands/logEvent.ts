/**
 * @otis/ledger/commands/logEvent
 * Handles log_event command for closed kinds: note, visit, contact, quote.
 */

import type { CommandResult, LedgerEvent, QuoteValue } from '@otis/contracts';
import type { LedgerCommandContext, LedgerProjectionState, LogEventArgs } from '../types.js';
import { createLedgerEvent } from './events.js';
import { reduceFields } from '../reducers/fields.js';

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

  // Validate payload by kind
  switch (args.kind) {
    case 'quote': {
      const q = args.payload as Partial<QuoteValue>;
      if (
        typeof q.amount !== 'number' ||
        !Number.isInteger(q.amount) ||
        q.amount < 0 ||
        typeof q.currency !== 'string' ||
        q.currency.trim().length !== 3 ||
        (q.role !== 'offered' && q.role !== 'expected')
      ) {
        return {
          result: {
            status: 'rejected',
            error: {
              code: 'invalid_quote',
              message:
                'Quote requires integer minor units (amount >= 0), 3-letter currency, and role ("offered" | "expected").',
            },
          },
          events: [],
        };
      }
      break;
    }

    case 'visit': {
      const v = args.payload as { summary?: unknown; contact_made?: unknown };
      if (typeof v.summary !== 'string' || typeof v.contact_made !== 'boolean') {
        return {
          result: {
            status: 'rejected',
            error: {
              code: 'invalid_visit',
              message: 'Visit event requires string summary and boolean contact_made flag.',
            },
          },
          events: [],
        };
      }
      break;
    }

    case 'contact': {
      const c = args.payload as { summary?: unknown; channel?: unknown };
      if (typeof c.summary !== 'string' || typeof c.channel !== 'string') {
        return {
          result: {
            status: 'rejected',
            error: {
              code: 'invalid_contact',
              message: 'Contact event requires string summary and valid channel.',
            },
          },
          events: [],
        };
      }
      break;
    }

    case 'note': {
      const n = args.payload as { text?: unknown };
      if (typeof n.text !== 'string' || n.text.trim().length === 0) {
        return {
          result: {
            status: 'rejected',
            error: {
              code: 'invalid_note',
              message: 'Note event requires non-empty text string.',
            },
          },
          events: [],
        };
      }
      break;
    }

    default:
      return {
        result: {
          status: 'rejected',
          error: {
            code: 'unsupported_event_kind',
            message: `Event kind '${String(args.kind)}' is not permitted for log_event.`,
          },
        },
        events: [],
      };
  }

  const event = createLedgerEvent(context, nextSequence, {
    entity_id: args.entity_id || null,
    kind: args.kind,
    payload: args.payload,
    occurred_at: args.occurred_at,
    provenance: args.provenance || 'stated',
  });

  const nextFields = new Map(state.fields);
  reduceFields(nextFields, event);

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
    nextState: { ...state, fields: nextFields },
  };
}
