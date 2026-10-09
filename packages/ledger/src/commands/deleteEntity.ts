/**
 * @otis/ledger/commands/deleteEntity
 * Conversational entity deletion: removes a lead and all of its projected
 * information (fields, aliases, tasks, drafts, entity-scoped memory) while
 * the event history stays append-only. Deleted rows never surface in future
 * reads; a revert of the delete event restores everything through replay,
 * so the standard Undo flow covers accidental deletions.
 */

import type { CommandResult, LedgerEvent } from '@otis/contracts';
import type { DeleteEntityArgs, LedgerCommandContext, LedgerProjectionState } from '../types.js';
import { createLedgerEvent } from './events.js';
import { reduceDrafts } from '../reducers/drafts.js';
import { reduceEntity } from '../reducers/entities.js';
import { reduceFields } from '../reducers/fields.js';
import { reduceInteractions } from '../reducers/interactions.js';
import { reduceMemory } from '../reducers/memory.js';
import { reduceTasks } from '../reducers/tasks.js';
import { canonicalId } from '../reducers/business.js';

const CONFIRM_VALUES = new Set(['yes', 'confirm', 'confirmed', 'delete', 'da', 'igen']);

export function handleDeleteEntity(
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: DeleteEntityArgs,
): {
  result: CommandResult<{ entity_id: string; name: string }>;
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

  const confirm = (args.confirm ?? '').trim().toLowerCase();
  if (!confirm) {
    return {
      result: {
        status: 'rejected',
        error: {
          code: 'confirmation_required',
          message: `Deleting '${entity.name}' and all of its details cannot be undone by editing. Confirm explicitly to proceed.`,
        },
      },
      events: [],
    };
  }
  if (!CONFIRM_VALUES.has(confirm)) {
    return {
      result: {
        status: 'rejected',
        error: {
          code: 'cancelled_by_member',
          message: `Deletion of '${entity.name}' declined; nothing changed.`,
        },
      },
      events: [],
    };
  }

  const canonical = canonicalId(state, entity.id);
  const family = [...state.entities.values()].filter(e => canonicalId(state, e.id) === canonical);
  const events = family.map((e, n) => createLedgerEvent(context, nextSequence + n, { entity_id: e.id, kind: 'entity_deleted', payload: { name: e.name, reason: args.reason ?? null, combined_client_id: family.length > 1 ? canonical : null }, provenance: 'stated' }));

  const nextEntities = new Map(state.entities);
  const nextAliases = new Map(state.aliases);
  const nextFields = new Map(state.fields);
  const nextInteractions = new Map(state.interactions);
  const nextTasks = new Map(state.tasks);
  const nextDrafts = new Map(state.drafts);
  const nextMemoryEntries = new Map(state.memoryEntries);
  const nextSuppressions = new Map(state.memorySuppressions);
  for (const event of events) {
    reduceEntity(nextEntities, nextAliases, event);
    reduceInteractions(nextInteractions, event);
    reduceFields(nextFields, nextInteractions, event);
    reduceTasks(nextTasks, event);
    reduceDrafts(nextDrafts, event);
    reduceMemory(nextMemoryEntries, nextSuppressions, event);
  }

  return {
    result: {
      status: 'applied',
      action_id: context.action_id,
      affected_resource_ids: family.map(e => e.id),
      event_ids: events.map(e => e.id),
      summary: `Deleted '${entity.name}' and its ${family.length > 1 ? 'combined files and ' : ''}current details. History remains available for Undo.`,
      data: { entity_id: entity.id, name: entity.name },
    },
    events,
    nextState: {
      ...state,
      entities: nextEntities,
      aliases: nextAliases,
      fields: nextFields,
      interactions: nextInteractions,
      tasks: nextTasks,
      drafts: nextDrafts,
      memoryEntries: nextMemoryEntries,
      memorySuppressions: nextSuppressions,
    },
  };
}
