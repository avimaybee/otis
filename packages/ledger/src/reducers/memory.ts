/**
 * @otis/ledger/reducers/memory
 * Deterministic pure reducers for curated memory entries and suppressions.
 */

import type {
  LedgerEvent,
  MemoryEntry,
  MemoryForgottenPayload,
  MemoryNotePayload,
  MemorySuppression,
} from '@otis/contracts';

export function reduceMemory(
  entries: Map<string, MemoryEntry>,
  suppressions: Map<string, MemorySuppression>,
  event: LedgerEvent,
): void {
  switch (event.kind) {
    case 'memory_note': {
      const p = event.payload as MemoryNotePayload;
      if (!p || !p.memory_id) return;

      if (p.supersedes_memory_id) {
        const existing = entries.get(p.supersedes_memory_id);
        if (existing) {
          entries.set(p.supersedes_memory_id, {
            ...existing,
            status: 'superseded',
            superseding_event_id: event.id,
          });
        }
      }

      entries.set(p.memory_id, {
        id: p.memory_id,
        workspace_id: event.workspace_id,
        scope: p.scope,
        subject_id: p.subject_id || null,
        category: p.category,
        content: p.content,
        status: 'active',
        provenance: event.provenance,
        source_event_id: event.id,
        source_message_id: event.source_message_id || null,
        author_user_id: event.actor_user_id || null,
        observed_at: event.occurred_at,
        created_at: event.recorded_at,
        superseding_event_id: null,
        business_revision: event.sequence,
      });
      break;
    }

    case 'memory_forgotten': {
      const p = event.payload as MemoryForgottenPayload;
      if (!p || !p.memory_id) return;

      const target = entries.get(p.memory_id);
      if (target) {
        entries.set(p.memory_id, {
          ...target,
          status: 'forgotten',
        });
        const suppressionId = `sup_${event.id}_${p.memory_id}`;
        suppressions.set(suppressionId, {
          id: suppressionId,
          workspace_id: event.workspace_id,
          target_memory_id: p.memory_id,
          source_event_id: target.source_event_id,
          source_message_id: target.source_message_id,
          suppression_event_id: event.id,
          revision: event.sequence,
          created_at: event.recorded_at,
        });
      }
      break;
    }

    case 'entity_deleted': {
      // Entity-scoped notes leave with their subject; member- and
      // workspace-scoped notes stay. Suppressions aimed at removed notes
      // leave with them so no tombstone dangles.
      if (!event.entity_id) return;
      const removedIds = new Set<string>();
      for (const [id, entry] of entries) {
        if (entry.scope === 'entity' && entry.subject_id === event.entity_id) {
          entries.delete(id);
          removedIds.add(id);
        }
      }
      if (removedIds.size > 0) {
        for (const [id, suppression] of suppressions) {
          if (removedIds.has(suppression.target_memory_id)) suppressions.delete(id);
        }
      }
      break;
    }
  }
}
