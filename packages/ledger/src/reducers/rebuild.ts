/**
 * @otis/ledger/reducers/rebuild
 * Deterministic pure projection rebuild from immutable append-only event stream.
 * In accordance with architecture.md section 8 and docs/archive/plans/002-ledger.md.
 */

import type { LedgerEvent, RevertPayload } from '@otis/contracts';
import type { LedgerProjectionState } from '../types.js';
import { reduceEntity } from './entities.js';
import { reduceFields } from './fields.js';
import { reduceInteractions } from './interactions.js';
import { reduceTasks } from './tasks.js';
import { reduceDrafts } from './drafts.js';
import { reduceMemory } from './memory.js';

export function rebuildProjections(events: LedgerEvent[]): LedgerProjectionState {
  // 1. Identify all reverted event IDs from causal revert events
  const revertedEventIds = new Set<string>();
  for (const evt of events) {
    if (evt.kind === 'revert') {
      if (evt.reverts_event_id) {
        revertedEventIds.add(evt.reverts_event_id);
      }
      const p = evt.payload as RevertPayload | undefined;
      if (p?.target_event_id) {
        revertedEventIds.add(p.target_event_id);
      }
    }
  }

  // 2. Filter out reverted events and revert directives, then sort deterministically by committed sequence
  const activeEvents = events
    .filter((evt) => !revertedEventIds.has(evt.id) && evt.kind !== 'revert')
    .sort((a, b) => a.sequence - b.sequence);

  // 3. Initialize fresh projection state
  const state: LedgerProjectionState = {
    entities: new Map(),
    aliases: new Map(),
    fields: new Map(),
    interactions: new Map(),
    tasks: new Map(),
    drafts: new Map(),
    memoryEntries: new Map(),
    memorySuppressions: new Map(),
  };

  // 4. Apply pure reducers in strict sequence order. Interactions reduce
  // before fields so head-aware quote reduction sees the triggering
  // revision or removal already reflected in the rows.
  for (const evt of activeEvents) {
    reduceEntity(state.entities, state.aliases, evt);
    reduceInteractions(state.interactions, evt);
    reduceFields(state.fields, state.interactions, evt);
    reduceTasks(state.tasks, evt);
    reduceDrafts(state.drafts, evt);
    reduceMemory(state.memoryEntries, state.memorySuppressions, evt);
  }

  return state;
}
