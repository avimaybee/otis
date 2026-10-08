/**
 * @otis/ledger/reducers/fields
 * Reducer for entity_state, core fields, disputes, and conflict resolutions.
 */

import type { EntityStateField, InteractionState, LedgerEvent } from '@otis/contracts';

/** ISO 4217 zero-decimal currencies: the stored amount is already major units. */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/**
 * Display text for a stored quote. Amounts arrive in integer minor units
 * and must be rendered as major units: rendering the raw amount reads a
 * 4000 RON quote back as "400000 RON" in entity state and model context.
 * Whole amounts stay plain ("4000 RON"), fractions trim ("4000.50 RON"),
 * and no thousands separators are added so the text re-reads unambiguously.
 */
export function formatQuoteText(amount: number, currency: string, role: string): string {
  const code = (currency || '').toUpperCase();
  const major = ZERO_DECIMAL_CURRENCIES.has(code) ? amount : Math.round(amount) / 100;
  const text = Number.isInteger(major) ? String(major) : String(Math.round(major * 100) / 100);
  return `${text} ${currency} (${role})`;
}

interface QuoteTriple {
  amount: number;
  currency: string;
  role: string;
}

function quoteTripleOf(value: unknown): QuoteTriple | null {
  const record = (value ?? {}) as Record<string, unknown>;
  if (
    typeof record['amount'] !== 'number' ||
    typeof record['currency'] !== 'string' ||
    typeof record['role'] !== 'string'
  ) {
    return null;
  }
  return { amount: record['amount'], currency: record['currency'], role: record['role'] };
}

function quoteRootOf(event: LedgerEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const marker = payload['interaction_id'];
  if (typeof marker === 'string' && marker.length > 0) return marker;
  return event.id;
}

/**
 * Head-aware quote reduction: the current `quote` field is recomputed from
 * the active quote roots of the entity, never from one event alone. A
 * root-specific revision replaces only its own root's contribution, so an
 * unrelated dispute survives with its candidate swapped; removing the last
 * active root empties the field instead of leaving a stale value. One
 * distinct value across active heads reads clear; several dispute with
 * their head IDs as candidates. Reductions run interactions-first so the
 * triggering revision or removal is already reflected in the rows.
 */
function recomputeQuoteField(
  fields: Map<string, EntityStateField>,
  interactions: Map<string, InteractionState>,
  event: LedgerEvent,
): void {
  const entityId = event.entity_id;
  if (!entityId) return;
  const fieldKey = `${entityId}:quote`;
  const existing = fields.get(fieldKey);

  // Active contributions per root: persisted head snapshots, with the
  // triggering quote event overlaid for its own root (live targeted loads
  // still hold the previous head, and replay sees the pre-reduction row).
  const contributions = new Map<string, { triple: QuoteTriple | null; headId: string; sequence: number }>();
  for (const [root, row] of interactions) {
    if (row.entity_id !== entityId || row.kind !== 'quote' || row.state !== 'active') continue;
    contributions.set(root, {
      triple: row.head_value_json ? quoteTripleOf(JSON.parse(row.head_value_json)) : null,
      headId: row.head_event_id,
      sequence: row.sequence,
    });
  }
  if (event.kind === 'quote') {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    contributions.set(quoteRootOf(event), {
      triple: quoteTripleOf(payload),
      headId: event.id,
      sequence: event.sequence,
    });
  }

  const distinct = new Map<string, { triple: QuoteTriple | null; headId: string; sequence: number }>();
  for (const [root, contribution] of contributions) {
    const key = contribution.triple
      ? `${contribution.triple.amount}|${contribution.triple.currency}|${contribution.triple.role}`
      : `unknown:${root}`;
    if (!distinct.has(key)) distinct.set(key, contribution);
    else {
      const kept = distinct.get(key)!;
      if (contribution.sequence > kept.sequence) distinct.set(key, contribution);
    }
  }

  const revision = (existing?.revision || 0) + 1;
  if (distinct.size === 0) {
    // No active quote root: the field goes empty, preserving the last
    // agreed value for history instead of a stale current claim.
    fields.set(fieldKey, {
      id: `${entityId}_quote`,
      workspace_id: event.workspace_id,
      entity_id: entityId,
      field_name: 'quote',
      state: 'clear',
      value_text: null,
      value_json: null,
      provenance: event.provenance,
      source_event_id: null,
      candidate_event_ids: null,
      last_confirmed_value_text: existing?.last_confirmed_value_text ?? null,
      last_confirmed_value_json: existing?.last_confirmed_value_json ?? null,
      revision,
      updated_at: event.recorded_at,
    });
    return;
  }

  if (distinct.size === 1) {
    const only = [...distinct.values()][0]!;
    if (!only.triple) {
      // A single malformed contribution cannot format a value: keep it
      // visible as an unresolved candidate rather than inventing text.
      fields.set(fieldKey, {
        id: `${entityId}_quote`,
        workspace_id: event.workspace_id,
        entity_id: entityId,
        field_name: 'quote',
        state: 'disputed',
        value_text: null,
        value_json: null,
        provenance: event.provenance,
        source_event_id: null,
        candidate_event_ids: [only.headId],
        last_confirmed_value_text: existing?.last_confirmed_value_text ?? null,
        last_confirmed_value_json: existing?.last_confirmed_value_json ?? null,
        revision,
        updated_at: event.recorded_at,
      });
      return;
    }
    const formattedText = formatQuoteText(only.triple.amount, only.triple.currency, only.triple.role);
    const jsonStr = JSON.stringify(only.triple);
    fields.set(fieldKey, {
      id: `${entityId}_quote`,
      workspace_id: event.workspace_id,
      entity_id: entityId,
      field_name: 'quote',
      state: 'clear',
      value_text: formattedText,
      value_json: jsonStr,
      provenance: event.provenance,
      source_event_id: only.headId,
      candidate_event_ids: null,
      last_confirmed_value_text: formattedText,
      last_confirmed_value_json: jsonStr,
      revision,
      updated_at: event.recorded_at,
    });
    return;
  }

  const candidates = [...contributions.values()]
    .sort((a, b) => (a.sequence === b.sequence ? (a.headId < b.headId ? -1 : 1) : a.sequence - b.sequence))
    .map((contribution) => contribution.headId);
  fields.set(fieldKey, {
    id: `${entityId}_quote`,
    workspace_id: event.workspace_id,
    entity_id: entityId,
    field_name: 'quote',
    state: 'disputed',
    value_text: null,
    value_json: null,
    provenance: event.provenance,
    source_event_id: null,
    candidate_event_ids: candidates,
    last_confirmed_value_text: existing?.last_confirmed_value_text ?? null,
    last_confirmed_value_json: existing?.last_confirmed_value_json ?? null,
    revision,
    updated_at: event.recorded_at,
  });
}

export function reduceFields(
  fields: Map<string, EntityStateField>,
  interactions: Map<string, InteractionState>,
  event: LedgerEvent,
): void {
  if (!event.entity_id) return;

  switch (event.kind) {
    case 'status_change': {
      const p = event.payload as { new_status: string };
      const fieldKey = `${event.entity_id}:status`;
      const existing = fields.get(fieldKey);
      fields.set(fieldKey, {
        id: `${event.entity_id}_status`,
        workspace_id: event.workspace_id,
        entity_id: event.entity_id,
        field_name: 'status',
        state: 'clear',
        value_text: p.new_status,
        value_json: null,
        provenance: event.provenance,
        source_event_id: event.id,
        candidate_event_ids: null,
        last_confirmed_value_text: p.new_status,
        last_confirmed_value_json: null,
        revision: (existing?.revision || 0) + 1,
        updated_at: event.recorded_at,
      });
      break;
    }

    case 'quote': {
      recomputeQuoteField(fields, interactions, event);
      break;
    }

    case 'interaction_removed': {
      const payload = event.payload as { root_event_id?: unknown; target_kind?: unknown };
      if (payload.target_kind === 'quote') {
        recomputeQuoteField(fields, interactions, event);
      }
      break;
    }

    case 'field_change': {
      const p = event.payload as { field_name: string; new_value: unknown };
      const fieldKey = `${event.entity_id}:${p.field_name}`;
      const existing = fields.get(fieldKey);
      const isJson = typeof p.new_value === 'object' && p.new_value !== null;
      const valText = isJson ? null : String(p.new_value ?? '');
      const valJson = isJson ? JSON.stringify(p.new_value) : null;

      if (existing && !event.supersedes_event_id) {
        let isDifferent = false;
        if (existing.state === 'disputed') {
          isDifferent = true;
        } else if (isJson) {
          isDifferent = existing.value_json !== valJson;
        } else {
          isDifferent = existing.value_text !== valText;
        }

        if (isDifferent) {
          // Competing incompatible claims -> field enters disputed state, value becomes NULL
          const candidateSet = new Set<string>();
          if (existing.candidate_event_ids) {
            for (const id of existing.candidate_event_ids) candidateSet.add(id);
          } else if (existing.source_event_id) {
            candidateSet.add(existing.source_event_id);
          }
          candidateSet.add(event.id);

          fields.set(fieldKey, {
            ...existing,
            state: 'disputed',
            value_text: null,
            value_json: null,
            provenance: event.provenance,
            source_event_id: null,
            candidate_event_ids: Array.from(candidateSet),
            revision: existing.revision + 1,
            updated_at: event.recorded_at,
          });
          return;
        }
      }

      // Explicit superseding, first value, or matching report -> clear
      fields.set(fieldKey, {
        id: `${event.entity_id}_${p.field_name}`,
        workspace_id: event.workspace_id,
        entity_id: event.entity_id,
        field_name: p.field_name,
        state: 'clear',
        value_text: valText,
        value_json: valJson,
        provenance: event.provenance,
        source_event_id: event.id,
        candidate_event_ids: null,
        last_confirmed_value_text: valText,
        last_confirmed_value_json: valJson,
        revision: (existing?.revision || 0) + 1,
        updated_at: event.recorded_at,
      });
      break;
    }

    case 'entity_deleted': {
      if (!event.entity_id) return;
      for (const [key] of fields) {
        if (key.startsWith(`${event.entity_id}:`)) fields.delete(key);
      }
      break;
    }

    case 'conflict_resolved': {
      const p = event.payload as {
        entity_id: string;
        field_name: string;
        resolved_value: unknown;
        candidate_event_ids: string[];
      };
      const fieldKey = `${event.entity_id}:${p.field_name}`;
      const existing = fields.get(fieldKey);
      const isJson = typeof p.resolved_value === 'object' && p.resolved_value !== null;
      const valText = isJson ? null : String(p.resolved_value ?? '');
      const valJson = isJson ? JSON.stringify(p.resolved_value) : null;

      fields.set(fieldKey, {
        id: `${event.entity_id}_${p.field_name}`,
        workspace_id: event.workspace_id,
        entity_id: event.entity_id,
        field_name: p.field_name,
        state: 'clear',
        value_text: valText,
        value_json: valJson,
        provenance: 'stated', // Member resolution is explicitly stated
        source_event_id: event.id,
        candidate_event_ids: null,
        last_confirmed_value_text: valText,
        last_confirmed_value_json: valJson,
        revision: (existing?.revision || 0) + 1,
        updated_at: event.recorded_at,
      });
      break;
    }
  }
}
