/**
 * @otis/ledger/reducers/entities
 * Reducer for entities and entity_aliases.
 */

import type { Entity, EntityAlias, LeadStatus, LedgerEvent } from '@otis/contracts';

export function reduceEntity(
  entities: Map<string, Entity>,
  aliases: Map<string, EntityAlias>,
  event: LedgerEvent,
): void {
  switch (event.kind) {
    case 'entity_created': {
      const p = event.payload as {
        name: string;
        kind?: string;
        initial_status?: LeadStatus;
        assigned_user_id?: string | null;
      };
      const entityId = event.entity_id || event.id;
      const entity: Entity = {
        id: entityId,
        workspace_id: event.workspace_id,
        name: p.name,
        kind: p.kind || 'lead',
        status: p.initial_status || 'new',
        assigned_user_id: p.assigned_user_id || null,
        created_at: event.recorded_at,
        updated_at: event.recorded_at,
      };
      entities.set(entityId, entity);

      // Add initial name as alias
      const aliasKey = `${event.workspace_id}:${p.name.trim().toLowerCase()}`;
      aliases.set(aliasKey, {
        id: `alias_${event.id}`,
        workspace_id: event.workspace_id,
        entity_id: entityId,
        alias: p.name.trim(),
        source_event_id: event.id,
        created_at: event.recorded_at,
      });
      break;
    }

    case 'entity_renamed': {
      const p = event.payload as { new_name: string };
      if (!event.entity_id) return;
      const entity = entities.get(event.entity_id);
      if (entity) {
        entity.name = p.new_name;
        entity.updated_at = event.recorded_at;

        // Add new name as alias; former name remains an alias
        const aliasKey = `${event.workspace_id}:${p.new_name.trim().toLowerCase()}`;
        aliases.set(aliasKey, {
          id: `alias_${event.id}`,
          workspace_id: event.workspace_id,
          entity_id: entity.id,
          alias: p.new_name.trim(),
          source_event_id: event.id,
          created_at: event.recorded_at,
        });
      }
      break;
    }

    case 'alias_added': {
      const p = event.payload as { alias: string };
      if (!event.entity_id) return;
      const aliasKey = `${event.workspace_id}:${p.alias.trim().toLowerCase()}`;
      aliases.set(aliasKey, {
        id: `alias_${event.id}`,
        workspace_id: event.workspace_id,
        entity_id: event.entity_id,
        alias: p.alias.trim(),
        source_event_id: event.id,
        created_at: event.recorded_at,
      });
      break;
    }

    case 'status_change': {
      const p = event.payload as { new_status: LeadStatus };
      if (!event.entity_id) return;
      const entity = entities.get(event.entity_id);
      if (entity) {
        entity.status = p.new_status;
        entity.updated_at = event.recorded_at;
      }
      break;
    }

    case 'field_change': {
      const p = event.payload as { field_name: string; new_value: unknown };
      if (!event.entity_id) return;
      if (p.field_name === 'assigned_user_id') {
        const entity = entities.get(event.entity_id);
        if (entity) {
          entity.assigned_user_id = typeof p.new_value === 'string' ? p.new_value : null;
          entity.updated_at = event.recorded_at;
        }
      }
      break;
    }

    case 'entity_deleted': {
      if (!event.entity_id) return;
      entities.delete(event.entity_id);
      for (const [key, alias] of aliases) {
        if (alias.entity_id === event.entity_id) aliases.delete(key);
      }
      break;
    }
  }
}
