/**
 * @otis/ledger/commands/setFields
 * Atomic multi-field batch beside setField.ts: one validated transaction,
 * one parent action receipt and one business revision for a whole field
 * request, instead of one executor call per field.
 *
 * Ready (non-status, or explicitly member-instructed status) items commit
 * together with per-fact events folded through the existing reducers. An
 * uncertain status item never blocks the ready facts: it is attached as the
 * pending question on the applied result (mixed commit), or returned alone
 * as needs_clarification when nothing else is ready.
 */

import type { CommandResult, LeadStatus, LedgerEvent } from '@otis/contracts';
import type {
  LedgerCommandContext,
  LedgerProjectionState,
  SetFieldsArgs,
  SetFieldsFieldItem,
} from '../types.js';
import { createLedgerEvent } from './events.js';
import { reduceFields } from '../reducers/fields.js';
import { reduceEntity } from '../reducers/entities.js';
import { ALLOWED_CORE_FIELDS, VALID_LEAD_STATUSES } from './setField.js';

/** Bounded member answers for a parked status question. Nothing else counts. */
export const STATUS_CONFIRM_WORDS = new Set(['confirm', 'yes', 'y']);
export const STATUS_DECLINE_WORDS = new Set(['cancel', 'no', 'n']);

export interface SetFieldsAppliedData {
  entity_id: string;
  applied_fields: string[];
  applied_event_ids: string[];
  pending_field?: { field_name: 'status'; value: string };
}

export type StatusResumeDecision =
  | { action: 'apply'; value: string }
  | { action: 'cancel' }
  | { action: 'ambiguous'; message: string };

/**
 * Narrow status-answer normalization for the resumption owner. The stored
 * pending operation carries the proposed status; the member's persisted
 * answer only selects it. An explicit confirmation maps to the original
 * value with stated provenance, a decline cancels, and anything ambiguous
 * leaves the same question pending. Supplied entity/field identity is never
 * taken from the answer.
 */
export function normalizeStatusResumeAnswer(
  proposedValue: unknown,
  rawAnswer: unknown,
): StatusResumeDecision {
  const text = String(rawAnswer ?? '').trim().toLowerCase();
  if (STATUS_DECLINE_WORDS.has(text)) return { action: 'cancel' };
  if (STATUS_CONFIRM_WORDS.has(text)) {
    return { action: 'apply', value: String(proposedValue ?? '').trim().toLowerCase() };
  }
  if (VALID_LEAD_STATUSES.has(text as LeadStatus) && text !== 'closed') {
    return { action: 'apply', value: text };
  }
  return {
    action: 'ambiguous',
    message: `Answer '${String(rawAnswer ?? '').trim().slice(0, 80)}' does not confirm or decline the proposed status. Reply confirm to apply it or cancel to drop it.`,
  };
}

function canonicalItem(value: unknown, provenance: unknown): string {
  return JSON.stringify({ value, provenance });
}

export function handleSetFields(
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: SetFieldsArgs,
): {
  result: CommandResult<SetFieldsAppliedData>;
  events: LedgerEvent[];
  nextState?: LedgerProjectionState;
  actionCost?: number;
} {
  const entityId = typeof args?.entity_id === 'string' ? args.entity_id : '';
  const rawFields = Array.isArray(args?.fields) ? args.fields : [];
  if (!entityId || rawFields.length === 0 || rawFields.length > 20) {
    return {
      result: {
        status: 'rejected',
        error: {
          code: 'invalid_argument',
          message: 'set_fields requires an entity_id and 1–20 field updates.',
        },
      },
      events: [],
    };
  }

  const entity = state.entities.get(entityId);
  if (!entity) {
    return {
      result: {
        status: 'rejected',
        error: { code: 'not_found', message: `Entity '${entityId}' not found.` },
      },
      events: [],
    };
  }

  // Preflight every item before any business effect: a hard failure anywhere
  // rejects the whole request so earlier ready items never partially commit.
  // Exact repeats collapse to one; the same field with different
  // value/provenance is a conflicting request, never last-wins.
  const seen = new Map<string, string>();
  const unique: { field_name: string; value: unknown; provenance: string }[] = [];
  for (const raw of rawFields) {
    const item = (raw ?? {}) as Partial<SetFieldsFieldItem>;
    const fieldName = typeof item.field_name === 'string' ? item.field_name : '';
    if (!ALLOWED_CORE_FIELDS.has(fieldName)) {
      return {
        result: {
          status: 'rejected',
          error: {
            code: 'disallowed_field',
            message: `Field '${fieldName}' is not in the core field allowlist.`,
          },
        },
        events: [],
      };
    }
    const provenance = item.provenance === 'inferred' ? 'inferred' : 'stated';
    const prior = seen.get(fieldName);
    const fingerprint = canonicalItem(item.value, provenance);
    if (prior !== undefined) {
      if (prior !== fingerprint) {
        return {
          result: {
            status: 'rejected',
            error: {
              code: 'conflicting_fields',
              message: `Field '${fieldName}' appears twice with different values. Send one value per request.`,
            },
          },
          events: [],
        };
      }
      continue;
    }
    seen.set(fieldName, fingerprint);
    unique.push({ field_name: fieldName, value: item.value, provenance });
  }

  // Classify status intent per item against the trusted agent verdict.
  // Model provenance can never grant confirmation: only an index the agent
  // bridge derived from the member's own words counts as explicit.
  const explicit = new Set(
    (Array.isArray(args.explicit_status_indexes) ? args.explicit_status_indexes : []).filter(
      (i) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < rawFields.length,
    ) as number[],
  );
  // Map original positions to unique entries for the explicitness verdict.
  const uniqueOriginalIndex = new Map<string, number>();
  rawFields.forEach((raw, index) => {
    const name = (raw as Partial<SetFieldsFieldItem> | null)?.field_name;
    if (typeof name === 'string' && !uniqueOriginalIndex.has(name)) uniqueOriginalIndex.set(name, index);
  });

  const readyItems: { field_name: string; value: unknown; provenance: string }[] = [];
  let uncertainStatus: { value: string } | null = null;
  for (const u of unique) {
    if (u.field_name !== 'status') {
      readyItems.push(u);
      continue;
    }
    const statusVal = String(u.value ?? '').trim().toLowerCase();
    const originalIndex = uniqueOriginalIndex.get('status') ?? -1;
    // Explicitness comes only from the trusted agent verdict over the
    // member's own words. Model provenance is untrusted in both directions:
    // it can neither grant confirmation nor veto an explicit instruction,
    // and the committed event records the member's words as stated.
    if (
      statusVal !== 'closed' &&
      VALID_LEAD_STATUSES.has(statusVal as LeadStatus) &&
      explicit.has(originalIndex)
    ) {
      readyItems.push(u);
      continue;
    }
    if (statusVal === 'closed' || VALID_LEAD_STATUSES.has(statusVal as LeadStatus)) {
      // One uncertain status per request: duplicates already collapsed above.
      uncertainStatus = { value: statusVal };
      continue;
    }
    return {
      result: {
        status: 'rejected',
        error: {
          code: 'invalid_status',
          message: `Status '${String(u.value ?? '')}' is invalid. Allowed: ${Array.from(VALID_LEAD_STATUSES).join(', ')}.`,
        },
      },
      events: [],
    };
  }

  const appliedSummary = (names: string[]) =>
    names.length > 0 ? `Saved ${names.join(', ')} for '${entity.name}'.` : '';

  // Question-only: nothing ready, one uncertain status. The executor stores
  // the single-status pending operation; resumption applies it as set_field.
  if (readyItems.length === 0 && uncertainStatus) {
    const statusVal = uncertainStatus.value;
    return {
      result: {
        status: 'needs_clarification',
        action_id: context.action_id,
        affected_resource_ids: [entity.id],
        summary: `Inferred status change to '${statusVal}' for '${entity.name}' requires member confirmation before mutation.`,
        clarification: {
          prompt: `Did '${entity.name}' change status to '${statusVal}'?`,
          candidates: [statusVal],
          missing_fields: ['status_confirmation'],
          pending_operation: {
            version: 1,
            command_name: 'set_field',
            action_id: context.action_id,
            args: { entity_id: entity.id, field_name: 'status', value: statusVal },
            missing_fields: ['status_confirmation'],
            candidates: ['confirm', 'cancel'],
            source_revision: context.expected_business_revision,
          },
        },
        data: { entity_id: entity.id, applied_fields: [], applied_event_ids: [], pending_field: { field_name: 'status', value: statusVal } },
      },
      events: [],
    };
  }

  // Fold every ready item through the existing reducers in memory, sharing
  // one working state so assignment/status interactions see preceding
  // changes. Sequences are consecutive under the single parent action.
  const nextEntities = new Map(state.entities);
  const nextAliases = new Map(state.aliases);
  const nextFields = new Map(state.fields);
  const events: LedgerEvent[] = [];
  let seq = nextSequence;
  for (const item of readyItems) {
    if (item.field_name === 'status') {
      const statusVal = String(item.value ?? '').trim().toLowerCase() as LeadStatus;
      const working = nextEntities.get(entity.id);
      const event = createLedgerEvent(context, seq++, {
        entity_id: entity.id,
        kind: 'status_change',
        payload: { old_status: working?.status ?? entity.status, new_status: statusVal },
        provenance: 'stated',
      });
      reduceEntity(nextEntities, nextAliases, event);
      reduceFields(nextFields, state.interactions, event);
      events.push(event);
    } else {
      const event = createLedgerEvent(context, seq++, {
        entity_id: entity.id,
        kind: 'field_change',
        payload: { field_name: item.field_name, new_value: item.value },
        provenance: item.provenance === 'inferred' ? 'inferred' : 'stated',
      });
      reduceEntity(nextEntities, nextAliases, event);
      reduceFields(nextFields, state.interactions, event);
      events.push(event);
    }
  }

  const appliedNames = readyItems.map((i) => i.field_name);
  const nextState: LedgerProjectionState = {
    ...state,
    entities: nextEntities,
    aliases: nextAliases,
    fields: nextFields,
  };

  // Mixed commit: ready facts saved, uncertain status parked as the pending
  // question on the same applied result. The pending payload carries only
  // the uncertain status operation, never the already-saved fields.
  if (uncertainStatus) {
    const statusVal = uncertainStatus.value;
    const saved = appliedSummary(appliedNames);
    return {
      result: {
        status: 'applied',
        action_id: context.action_id,
        affected_resource_ids: [entity.id],
        event_ids: events.map((e) => e.id),
        summary: `${saved} Did '${entity.name}' change status to '${statusVal}'?`.trim(),
        clarification: {
          prompt: `${saved} Did '${entity.name}' change status to '${statusVal}'?`.trim(),
          candidates: [statusVal],
          missing_fields: ['status_confirmation'],
          pending_operation: {
            version: 1,
            command_name: 'set_field',
            action_id: context.action_id,
            args: { entity_id: entity.id, field_name: 'status', value: statusVal },
            missing_fields: ['status_confirmation'],
            candidates: ['confirm', 'cancel'],
            source_revision: context.expected_business_revision + 1,
          },
        },
        data: {
          entity_id: entity.id,
          applied_fields: appliedNames,
          applied_event_ids: events.map((e) => e.id),
          pending_field: { field_name: 'status', value: statusVal },
        },
      },
      events,
      nextState,
      actionCost: readyItems.length,
    };
  }

  return {
    result: {
      status: 'applied',
      action_id: context.action_id,
      affected_resource_ids: [entity.id],
      event_ids: events.map((e) => e.id),
      summary: `Updated fields ${appliedNames.join(', ')} on '${entity.name}'.`,
      data: { entity_id: entity.id, applied_fields: appliedNames, applied_event_ids: events.map((e) => e.id) },
    },
    events,
    nextState,
    actionCost: readyItems.length,
  };
}
