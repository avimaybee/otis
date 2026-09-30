/**
 * @otis/ledger/commands/renameEntity
 * Handles rename_entity and add_alias commands, preserving former names as aliases.
 */

import type { CommandResult, LedgerEvent } from '@otis/contracts';
import type { AddAliasArgs, LedgerCommandContext, LedgerProjectionState, RenameEntityArgs } from '../types.js';
import { createLedgerEvent } from './events.js';
import { reduceEntity } from '../reducers/entities.js';

export function handleRenameEntity(
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: RenameEntityArgs,
): {
  result: CommandResult<{ entity_id: string; new_name: string }>;
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

  const trimmedNewName = args.new_name.trim();
  if (!trimmedNewName) {
    return {
      result: {
        status: 'rejected',
        error: { code: 'bad_request', message: 'New entity name cannot be empty.' },
      },
      events: [],
    };
  }

  if (entity.name.toLowerCase() === trimmedNewName.toLowerCase()) {
    return {
      result: {
        status: 'already_applied',
        action_id: context.action_id,
        affected_resource_ids: [entity.id],
        summary: `Entity is already named '${trimmedNewName}'.`,
        data: { entity_id: entity.id, new_name: trimmedNewName },
      },
      events: [],
    };
  }

  // Check collision with another entity
  const aliasKey = `${context.workspace_id}:${trimmedNewName.toLowerCase()}`;
  const existingAlias = state.aliases.get(aliasKey);
  if (existingAlias && existingAlias.entity_id !== entity.id) {
    return {
      result: {
        status: 'conflict',
        error: {
          code: 'name_collision',
          message: `Cannot rename to '${trimmedNewName}': name or alias already belongs to another entity.`,
        },
      },
      events: [],
    };
  }

  const event = createLedgerEvent(context, nextSequence, {
    entity_id: entity.id,
    kind: 'entity_renamed',
    payload: {
      old_name: entity.name,
      new_name: trimmedNewName,
    },
    provenance: 'stated',
  });

  const nextEntities = new Map(state.entities);
  const nextAliases = new Map(state.aliases);
  reduceEntity(nextEntities, nextAliases, event);

  return {
    result: {
      status: 'applied',
      action_id: context.action_id,
      affected_resource_ids: [entity.id],
      event_ids: [event.id],
      summary: `Renamed entity from '${entity.name}' to '${trimmedNewName}'.`,
      data: { entity_id: entity.id, new_name: trimmedNewName },
    },
    events: [event],
    nextState: { ...state, entities: nextEntities, aliases: nextAliases },
  };
}

export function handleAddAlias(
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: AddAliasArgs,
): {
  result: CommandResult<{ entity_id: string; alias: string }>;
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

  const trimmedAlias = args.alias.trim();
  if (!trimmedAlias) {
    return {
      result: {
        status: 'rejected',
        error: { code: 'bad_request', message: 'Alias cannot be empty.' },
      },
      events: [],
    };
  }

  const aliasKey = `${context.workspace_id}:${trimmedAlias.toLowerCase()}`;
  const existingAlias = state.aliases.get(aliasKey);
  if (existingAlias) {
    if (existingAlias.entity_id === entity.id) {
      return {
        result: {
          status: 'already_applied',
          action_id: context.action_id,
          affected_resource_ids: [entity.id],
          summary: `Alias '${trimmedAlias}' already exists for this entity.`,
          data: { entity_id: entity.id, alias: trimmedAlias },
        },
        events: [],
      };
    }
    return {
      result: {
        status: 'conflict',
        error: {
          code: 'alias_collision',
          message: `Alias '${trimmedAlias}' already belongs to another entity.`,
        },
      },
      events: [],
    };
  }

  const event = createLedgerEvent(context, nextSequence, {
    entity_id: entity.id,
    kind: 'alias_added',
    payload: { alias: trimmedAlias },
    provenance: 'stated',
  });

  const nextEntities = new Map(state.entities);
  const nextAliases = new Map(state.aliases);
  reduceEntity(nextEntities, nextAliases, event);

  return {
    result: {
      status: 'applied',
      action_id: context.action_id,
      affected_resource_ids: [entity.id],
      event_ids: [event.id],
      summary: `Added alias '${trimmedAlias}' to entity '${entity.name}'.`,
      data: { entity_id: entity.id, alias: trimmedAlias },
    },
    events: [event],
    nextState: { ...state, entities: nextEntities, aliases: nextAliases },
  };
}
