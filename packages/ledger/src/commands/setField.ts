/**
 * @otis/ledger/commands/setField
 * Handles set_field command with core field allowlist and lead-status clarification gating.
 */

import type { CommandResult, LeadStatus, LedgerEvent } from '@otis/contracts';
import type { LedgerCommandContext, LedgerProjectionState, SetFieldArgs } from '../types.js';
import { createLedgerEvent } from './events.js';
import { reduceFields } from '../reducers/fields.js';
import { reduceEntity } from '../reducers/entities.js';

const ALLOWED_CORE_FIELDS = new Set([
  'status',
  'phone',
  'preferred_language',
  'assigned_user_id',
  'quote',
]);

export { ALLOWED_CORE_FIELDS };

const VALID_LEAD_STATUSES = new Set([
  'new',
  'cold',
  'warm',
  'hot',
  'won',
  'lost',
  'deprioritized',
]);

export { VALID_LEAD_STATUSES };

export function handleSetField(
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: SetFieldArgs,
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

  if (!ALLOWED_CORE_FIELDS.has(args.field_name)) {
    return {
      result: {
        status: 'rejected',
        error: {
          code: 'disallowed_field',
          message: `Field '${args.field_name}' is not in the core field allowlist.`,
        },
      },
      events: [],
    };
  }

  // --- Lead Status Enforcement ---
  if (args.field_name === 'status') {
    const statusVal = String(args.value || '').trim().toLowerCase();

    // 1. Ambiguous "closed" status asks won or lost
    if (statusVal === 'closed') {
      return {
        result: {
          status: 'needs_clarification',
          action_id: context.action_id,
          affected_resource_ids: [entity.id],
          summary: `'Closed' is ambiguous between won and lost. Was the lead won or lost?`,
          clarification: {
            prompt: `'Closed' is ambiguous between won and lost. Was '${entity.name}' won or lost?`,
            candidates: ['won', 'lost'],
            missing_fields: ['status'],
          },
        },
        events: [],
      };
    }

    if (!VALID_LEAD_STATUSES.has(statusVal)) {
      return {
        result: {
          status: 'rejected',
          error: {
            code: 'invalid_status',
            message: `Status '${statusVal}' is invalid. Allowed: ${Array.from(VALID_LEAD_STATUSES).join(', ')}.`,
          },
        },
        events: [],
      };
    }

    // 2. Inferred lead-status change MUST ask before mutation
    const provenance = args.provenance || 'stated';
    if (provenance === 'inferred') {
      return {
        result: {
          status: 'needs_clarification',
          action_id: context.action_id,
          affected_resource_ids: [entity.id],
          summary: `Inferred status change to '${statusVal}' for '${entity.name}' requires member confirmation before mutation.`,
          clarification: {
            prompt: `Did '${entity.name}' change status to '${statusVal}'?`,
            candidates: [statusVal],
            missing_fields: ['status'],
          },
        },
        events: [],
      };
    }

    // Explicit status change
    const event = createLedgerEvent(context, nextSequence, {
      entity_id: entity.id,
      kind: 'status_change',
      payload: {
        old_status: entity.status,
        new_status: statusVal as LeadStatus,
      },
      supersedes_event_id: args.supersedes_event_id,
      provenance: 'stated',
    });

    const nextEntities = new Map(state.entities);
    const nextAliases = new Map(state.aliases);
    const nextFields = new Map(state.fields);

    reduceEntity(nextEntities, nextAliases, event);
    reduceFields(nextFields, state.interactions, event);

    return {
      result: {
        status: 'applied',
        action_id: context.action_id,
        affected_resource_ids: [entity.id],
        event_ids: [event.id],
        summary: `Updated status of '${entity.name}' to '${statusVal}'.`,
        data: { entity_id: entity.id, field_name: 'status' },
      },
      events: [event],
      nextState: {
        ...state,
        entities: nextEntities,
        aliases: nextAliases,
        fields: nextFields,
      },
    };
  }

  // --- Other Core Fields ---
  const event = createLedgerEvent(context, nextSequence, {
    entity_id: entity.id,
    kind: 'field_change',
    payload: {
      field_name: args.field_name,
      new_value: args.value,
    },
    supersedes_event_id: args.supersedes_event_id,
    provenance: args.provenance || 'stated',
  });

  const nextEntities = new Map(state.entities);
  const nextAliases = new Map(state.aliases);
  const nextFields = new Map(state.fields);

  reduceEntity(nextEntities, nextAliases, event);
  reduceFields(nextFields, state.interactions, event);

  return {
    result: {
      status: 'applied',
      action_id: context.action_id,
      affected_resource_ids: [entity.id],
      event_ids: [event.id],
      summary: `Updated field '${args.field_name}' on '${entity.name}'.`,
      data: { entity_id: entity.id, field_name: args.field_name },
    },
    events: [event],
    nextState: {
      ...state,
      entities: nextEntities,
      aliases: nextAliases,
      fields: nextFields,
    },
  };
}
