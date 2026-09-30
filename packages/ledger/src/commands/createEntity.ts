/**
 * @otis/ledger/commands/createEntity
 * Handles create_entity command with duplicate search and neutral initial status.
 */

import type { CommandResult, LedgerEvent } from '@otis/contracts';
import type { CreateEntityArgs, LedgerCommandContext, LedgerProjectionState } from '../types.js';
import { createLedgerEvent } from './events.js';
import { findPotentialDuplicate } from './similarity.js';
import { reduceEntity } from '../reducers/entities.js';

export function handleCreateEntity(
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: CreateEntityArgs,
): {
  result: CommandResult<{ entity_id: string }>;
  events: LedgerEvent[];
  nextState?: LedgerProjectionState;
} {
  const trimmedName = args.name.trim();
  if (!trimmedName) {
    return {
      result: {
        status: 'rejected',
        error: { code: 'bad_request', message: 'Entity name cannot be empty.' },
      },
      events: [],
    };
  }

  // 1. Duplicate & near-duplicate check against current entities and aliases
  const existingNames = Array.from(state.entities.values()).map((e) => ({
    id: e.id,
    name: e.name,
  }));
  const dupCheck = findPotentialDuplicate(trimmedName, existingNames);

  if (dupCheck.exactMatch) {
    return {
      result: {
        status: 'already_applied',
        action_id: context.action_id,
        affected_resource_ids: [dupCheck.exactMatch.id],
        summary: `Entity '${dupCheck.exactMatch.name}' already exists.`,
        data: { entity_id: dupCheck.exactMatch.id },
      },
      events: [],
    };
  }

  if (dupCheck.nearDuplicate) {
    return {
      result: {
        status: 'needs_clarification',
        action_id: context.action_id,
        affected_resource_ids: [dupCheck.nearDuplicate.id],
        summary: `Possible duplicate entity found: '${trimmedName}' is very similar to existing '${dupCheck.nearDuplicate.name}'. Did you mean the existing entity?`,
        clarification: {
          prompt: `Possible duplicate entity found: '${trimmedName}' is very similar to existing '${dupCheck.nearDuplicate.name}'. Did you mean '${dupCheck.nearDuplicate.name}' or a new entity?`,
          candidates: [dupCheck.nearDuplicate.name, trimmedName],
          missing_fields: ['entity_id'],
        },
        data: { entity_id: dupCheck.nearDuplicate.id },
      },
      events: [],
    };
  }

  // 2. Create entity event with neutral initial status 'new' unless explicitly specified
  const entityId = `ent_${crypto.randomUUID()}`;
  const initialStatus = args.initial_status || 'new';

  const event = createLedgerEvent(context, nextSequence, {
    entity_id: entityId,
    kind: 'entity_created',
    payload: {
      name: trimmedName,
      kind: args.kind || 'lead',
      initial_status: initialStatus,
      assigned_user_id: args.assigned_user_id || null,
    },
    provenance: 'stated',
  });

  // 3. Compute proposed next state
  const nextEntities = new Map(state.entities);
  const nextAliases = new Map(state.aliases);
  reduceEntity(nextEntities, nextAliases, event);

  const nextState: LedgerProjectionState = {
    ...state,
    entities: nextEntities,
    aliases: nextAliases,
  };

  return {
    result: {
      status: 'applied',
      action_id: context.action_id,
      affected_resource_ids: [entityId],
      event_ids: [event.id],
      summary: `Created entity '${trimmedName}' with status '${initialStatus}'.`,
      data: { entity_id: entityId },
    },
    events: [event],
    nextState,
  };
}
