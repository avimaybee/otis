/**
 * @otis/ledger/commands/interactions
 * C1 single-interaction revision and removal. A revision emits another
 * note/visit/contact/quote event with `supersedes_event_id` pointing at the
 * exact current head and a typed payload carrying the stable root ID. A
 * removal emits one `interaction_removed` event. Original reports stay in
 * append-only history; the `interaction_state` projection tracks the current
 * head, removal state and revision. Undo restores prior heads through replay.
 */

import type {
  CommandResult,
  InteractionRemovedPayload,
  LedgerEvent,
  QuoteValue,
  RemoveInteractionResult,
  ReviseInteractionResult,
} from '@otis/contracts';
import type {
  LedgerCommandContext,
  LedgerProjectionState,
  RemoveInteractionArgs,
  ReviseInteractionArgs,
} from '../types.js';
import { createLedgerEvent } from './events.js';
import { INTERACTION_KINDS, validateInteractionPayload } from './interactionPayload.js';
import { formatQuoteText, reduceFields } from '../reducers/fields.js';
import { reduceInteractions } from '../reducers/interactions.js';

const MAX_REASON_CHARS = 500;

function isValidOccurredAt(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || Number.isNaN(Date.parse(value))) return false;
  // Date.parse rolls impossible calendar dates forward (2026-02-30
  // becomes March 2), so an ISO date prefix must round-trip exactly.
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return true;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

function changeSummary(
  kind: string,
  payload: Record<string, unknown>,
  occurredAt: string | undefined,
): string {
  const when = occurredAt ? ` (occurred ${occurredAt})` : '';
  if (kind === 'quote') {
    const q = payload as unknown as QuoteValue;
    return `Revised quote to ${formatQuoteText(q.amount, q.currency, q.role)}${when}.`;
  }
  if (kind === 'note') {
    const raw = String(payload['text'] ?? 'note');
    const excerpt = raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
    return `Revised note: "${excerpt}"${when}.`;
  }
  const raw = String(payload['summary'] ?? kind);
  const excerpt = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
  return `Revised ${kind}: "${excerpt}"${when}.`;
}

export function handleReviseInteraction(
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: ReviseInteractionArgs,
): {
  result: CommandResult<ReviseInteractionResult>;
  events: LedgerEvent[];
  nextState?: LedgerProjectionState;
} {
  const row = state.interactions.get(args.interaction_id);
  if (!row) {
    return {
      result: {
        status: 'rejected',
        error: { code: 'not_found', message: `Interaction '${args.interaction_id}' not found.` },
      },
      events: [],
    };
  }
  if (row.state === 'removed') {
    return {
      result: {
        status: 'rejected',
        error: {
          code: 'interaction_removed',
          message: `Interaction '${args.interaction_id}' was removed; restore it with Undo before revising.`,
        },
      },
      events: [],
    };
  }
  if (row.head_event_id !== args.expected_head_event_id) {
    return {
      result: {
        status: 'conflict',
        action_id: context.action_id,
        error: {
          code: 'head_conflict',
          message: `Interaction '${args.interaction_id}' changed since the confirmed edit: expected head '${args.expected_head_event_id}'.`,
        },
      },
      events: [],
    };
  }
  if (!INTERACTION_KINDS.includes(args.kind) || args.kind !== row.kind) {
    return {
      result: {
        status: 'rejected',
        error: {
          code: 'kind_mismatch',
          message: `Interaction '${args.interaction_id}' is a ${row.kind}, not a ${String(args.kind)}; kinds never convert.`,
        },
      },
      events: [],
    };
  }
  if (row.entity_id) {
    const entity = state.entities.get(row.entity_id);
    if (!entity) {
      return {
        result: {
          status: 'rejected',
          error: {
            code: 'entity_not_found',
            message: `Entity '${row.entity_id}' for interaction '${args.interaction_id}' no longer exists.`,
          },
        },
        events: [],
      };
    }
  }

  // The replacement payload passes exactly the same validation as new
  // logging; a model-supplied root marker is ignored and rebound below.
  const validation = validateInteractionPayload(args.kind, args.payload);
  if (!validation.valid) {
    return {
      result: { status: 'rejected', error: { code: validation.code, message: validation.message } },
      events: [],
    };
  }
  if (args.occurred_at !== undefined && !isValidOccurredAt(args.occurred_at)) {
    return {
      result: {
        status: 'rejected',
        error: {
          code: 'invalid_occurred_at',
          message: `Occurred date '${String(args.occurred_at)}' is not a valid date.`,
        },
      },
      events: [],
    };
  }

  const payload = { ...(args.payload as Record<string, unknown>), interaction_id: row.root_event_id };
  // An omitted date keeps the head's occurrence: a content-only correction
  // must never silently move the original entry to today.
  const occurredAt = args.occurred_at ?? row.occurred_at;
  const event = createLedgerEvent(context, nextSequence, {
    entity_id: row.entity_id,
    kind: args.kind,
    payload,
    occurred_at: occurredAt,
    supersedes_event_id: row.head_event_id,
    provenance: 'stated',
  });

  const nextInteractions = new Map(state.interactions);
  reduceInteractions(nextInteractions, event);
  const nextFields = new Map(state.fields);
  reduceFields(nextFields, nextInteractions, event);

  return {
    result: {
      status: 'applied',
      action_id: context.action_id,
      affected_resource_ids: row.entity_id ? [row.entity_id, row.root_event_id] : [row.root_event_id],
      event_ids: [event.id],
      summary: changeSummary(args.kind, payload, occurredAt),
      data: { event_id: event.id, interaction_id: row.root_event_id, head_event_id: event.id },
    },
    events: [event],
    nextState: { ...state, interactions: nextInteractions, fields: nextFields },
  };
}

export function handleRemoveInteraction(
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: RemoveInteractionArgs,
): {
  result: CommandResult<RemoveInteractionResult>;
  events: LedgerEvent[];
  nextState?: LedgerProjectionState;
} {
  const row = state.interactions.get(args.interaction_id);
  if (!row) {
    return {
      result: {
        status: 'rejected',
        error: { code: 'not_found', message: `Interaction '${args.interaction_id}' not found.` },
      },
      events: [],
    };
  }
  if (row.state === 'removed') {
    return {
      result: {
        status: 'already_applied',
        action_id: context.action_id,
        summary: `Interaction '${args.interaction_id}' is already removed.`,
        data: {
          event_id: row.head_event_id,
          interaction_id: row.root_event_id,
          head_event_id: row.head_event_id,
        },
      },
      events: [],
    };
  }
  if (row.head_event_id !== args.expected_head_event_id) {
    return {
      result: {
        status: 'conflict',
        action_id: context.action_id,
        error: {
          code: 'head_conflict',
          message: `Interaction '${args.interaction_id}' changed since the confirmed removal: expected head '${args.expected_head_event_id}'.`,
        },
      },
      events: [],
    };
  }
  if (row.entity_id && !state.entities.get(row.entity_id)) {
    return {
      result: {
        status: 'rejected',
        error: {
          code: 'entity_not_found',
          message: `Entity '${row.entity_id}' for interaction '${args.interaction_id}' no longer exists.`,
        },
      },
      events: [],
    };
  }
  const reason = args.reason ?? null;
  if (reason !== null && (typeof reason !== 'string' || reason.trim().length === 0)) {
    return {
      result: {
        status: 'rejected',
        error: { code: 'invalid_reason', message: 'Removal reason must be a non-empty string when given.' },
      },
      events: [],
    };
  }
  if (typeof reason === 'string' && reason.length > MAX_REASON_CHARS) {
    return {
      result: {
        status: 'rejected',
        error: {
          code: 'invalid_reason',
          message: `Removal reason exceeds ${MAX_REASON_CHARS} characters.`,
        },
      },
      events: [],
    };
  }

  const payload: InteractionRemovedPayload = {
    root_event_id: row.root_event_id,
    head_event_id: row.head_event_id,
    target_kind: row.kind,
    reason: typeof reason === 'string' ? reason.trim() : null,
  };
  const event = createLedgerEvent(context, nextSequence, {
    entity_id: row.entity_id,
    kind: 'interaction_removed',
    payload,
    provenance: 'stated',
  });

  const nextInteractions = new Map(state.interactions);
  reduceInteractions(nextInteractions, event);
  // A removal recomputes dependent current values (quotes): dropping the
  // last active root empties the field instead of leaving a stale claim.
  const nextFields = new Map(state.fields);
  reduceFields(nextFields, nextInteractions, event);

  return {
    result: {
      status: 'applied',
      action_id: context.action_id,
      affected_resource_ids: row.entity_id ? [row.entity_id, row.root_event_id] : [row.root_event_id],
      event_ids: [event.id],
      summary: `Removed ${row.kind} '${row.root_event_id}' from current use; history retained.`,
      data: { event_id: event.id, interaction_id: row.root_event_id, head_event_id: event.id },
    },
    events: [event],
    nextState: { ...state, interactions: nextInteractions, fields: nextFields },
  };
}
