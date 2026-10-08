/**
 * @otis/ledger/commands/resolveConflict
 * Handles resolve_conflict command, clearing disputes and persisting member's explicit choice.
 */

import type { CommandResult, LedgerEvent } from '@otis/contracts';
import type { LedgerCommandContext, LedgerProjectionState, ResolveConflictArgs } from '../types.js';
import { createLedgerEvent } from './events.js';
import { reduceFields } from '../reducers/fields.js';

export function handleResolveConflict(
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: ResolveConflictArgs,
): {
  result: CommandResult<{ entity_id: string; field_name: string }>;
  events: LedgerEvent[];
  nextState?: LedgerProjectionState;
} {
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

  // 1. Validate field exists on entity
  const fieldKey = `${args.entity_id}:${args.field_name}`;
  const field = state.fields.get(fieldKey);
  if (!field) {
    return {
      result: {
        status: 'rejected',
        error: {
          code: 'field_not_found',
          message: `Field '${args.field_name}' not found on entity '${entity.name}'.`,
        },
      },
      events: [],
    };
  }

  // 2. Validate field is in disputed state
  if (field.state !== 'disputed') {
    return {
      result: {
        status: 'rejected',
        error: {
          code: 'field_not_disputed',
          message: `Field '${args.field_name}' on entity '${entity.name}' is not in a disputed state (current state: '${field.state}').`,
        },
      },
      events: [],
    };
  }

  // 3. Validate candidate event IDs match the active disputed candidates
  if (
    !args.candidate_event_ids ||
    !Array.isArray(args.candidate_event_ids) ||
    args.candidate_event_ids.length === 0
  ) {
    return {
      result: {
        status: 'rejected',
        error: {
          code: 'invalid_candidates',
          message: `candidate_event_ids must be a non-empty array of event IDs.`,
        },
      },
      events: [],
    };
  }

  const activeCandidates = field.candidate_event_ids || [];
  const activeSet = new Set(activeCandidates);
  const providedSet = new Set(args.candidate_event_ids);

  if (
    activeSet.size !== providedSet.size ||
    !args.candidate_event_ids.every((id) => activeSet.has(id))
  ) {
    return {
      result: {
        status: 'rejected',
        error: {
          code: 'candidate_mismatch',
          message: `Provided candidate_event_ids do not match active disputed candidates for field '${args.field_name}'. Expected: [${activeCandidates.join(', ')}].`,
        },
      },
      events: [],
    };
  }

  const event = createLedgerEvent(context, nextSequence, {
    entity_id: entity.id,
    kind: 'conflict_resolved',
    payload: {
      entity_id: entity.id,
      field_name: args.field_name,
      resolved_value: args.resolved_value,
      candidate_event_ids: args.candidate_event_ids,
      rationale: args.rationale,
    },
    provenance: 'stated',
  });

  const nextFields = new Map(state.fields);
  reduceFields(nextFields, state.interactions, event);

  return {
    result: {
      status: 'applied',
      action_id: context.action_id,
      affected_resource_ids: [entity.id],
      event_ids: [event.id],
      summary: `Resolved conflict for field '${args.field_name}' on '${entity.name}'.`,
      data: { entity_id: entity.id, field_name: args.field_name },
    },
    events: [event],
    nextState: { ...state, fields: nextFields },
  };
}
