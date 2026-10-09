/**
 * @otis/ledger/reducers/interactions
 * C1 single-interaction lifecycle projection: one row per stable root with
 * the current head, removal state and revision. Content stays in events.
 *
 * Root rule: a revision payload carries its stable root in
 * `interaction_id`; legacy rows without the marker are each their own root.
 * Revert events never reach this reducer: rebuild excludes them before
 * reduction, and live Undo commits replay through rebuild, so removing a
 * revision or a removal restores the prior head automatically.
 */

import type { InteractionState, LedgerEvent, InteractionRemovedPayload } from '@otis/contracts';
import { normalizeInteractionOccurredAt } from '@otis/contracts';

function rootOf(event: LedgerEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const marker = payload['interaction_id'];
  if (typeof marker === 'string' && marker.length > 0) return marker;
  return event.id;
}

/**
 * Bounded snapshot of a quote head for head-aware field recompute. Only
 * the triple the reducer compares is kept; malformed payloads snapshot
 * nothing and count as their own distinct contribution downstream.
 */
function quoteHeadSnapshot(event: LedgerEvent): string | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const amount = payload['amount'];
  const currency = payload['currency'];
  const role = payload['role'];
  if (typeof amount !== 'number' || typeof currency !== 'string' || typeof role !== 'string') return null;
  return JSON.stringify({ amount, currency, role });
}

export function reduceInteractions(
  rows: Map<string, InteractionState>,
  event: LedgerEvent,
): void {
  switch (event.kind) {
    case 'note':
    case 'visit':
    case 'contact':
    case 'quote': {
      const root = rootOf(event);
      const existing = rows.get(root);
      if (existing && existing.state === 'removed') {
        // Writers never revise a removed root; replay ignores such an
        // event rather than resurrecting the interaction.
        return;
      }
      rows.set(root, {
        workspace_id: event.workspace_id,
        root_event_id: root,
        entity_id: event.entity_id ?? null,
        kind: event.kind,
        head_event_id: event.id,
        revision: (existing?.revision ?? 0) + 1,
        state: 'active',
        occurred_at: normalizeInteractionOccurredAt(event.occurred_at) ?? event.occurred_at,
        sequence: event.sequence,
        updated_at: event.recorded_at,
        head_value_json: event.kind === 'quote' ? quoteHeadSnapshot(event) : null,
      });
      break;
    }

    case 'interaction_removed': {
      const payload = event.payload as InteractionRemovedPayload;
      const existing = rows.get(payload.root_event_id);
      // Writers always remove a known active head; an unknown root here
      // means a foreign replay artifact, which stays out of the projection.
      if (!existing) return;
      rows.set(payload.root_event_id, {
        ...existing,
        head_event_id: event.id,
        revision: existing.revision + 1,
        state: 'removed',
        occurred_at: event.occurred_at,
        sequence: event.sequence,
        updated_at: event.recorded_at,
      });
      break;
    }

    case 'entity_deleted': {
      if (!event.entity_id) return;
      for (const [key, row] of rows) {
        if (row.entity_id === event.entity_id) rows.delete(key);
      }
      break;
    }

    default:
      break;
  }
}
