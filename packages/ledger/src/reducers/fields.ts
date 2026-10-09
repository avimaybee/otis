/**
 * @otis/ledger/reducers/fields
 * Reducer for entity_state, core fields, disputes, and conflict resolutions.
 */

import { quoteMajorUnits, type EntityStateField, type InteractionState, type LedgerEvent } from '@otis/contracts';

/** ISO 4217 zero-decimal currencies: the stored amount is already major units. */

/**
 * Display text for a stored quote. Amounts arrive in integer minor units
 * and must be rendered as major units: rendering the raw amount reads a
 * 4000 RON quote back as "400000 RON" in entity state and model context.
 * Whole amounts stay plain ("4000 RON"), fractions trim ("4000.50 RON"),
 * and no thousands separators are added so the text re-reads unambiguously.
 */
export function formatQuoteText(amount: number, currency: string, role: string): string {
  const major = quoteMajorUnits(amount, currency);
  const text = String(major);
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

interface QuoteAuthority {
  event_id: string | null;
  value_text: string | null;
  value_json: string | null;
  provenance: EntityStateField['provenance'];
  covered: Record<string, string | null>;
  pending_claims?: Array<{ id: string; sequence: number; text: string | null; json: string | null }>;
}

function rememberQuoteAuthority(
  fields: Map<string, EntityStateField>,
  interactions: Map<string, InteractionState>,
  event: LedgerEvent,
): void {
  const key = `${event.entity_id}:quote`;
  const field = fields.get(key);
  if (!field || field.state !== 'clear') return;
  const covered: Record<string, string | null> = {};
  for (const [root, row] of interactions) {
    if (row.entity_id === event.entity_id && row.kind === 'quote' && row.state === 'active') {
      covered[root] = row.head_value_json;
    }
  }
  const authority: QuoteAuthority = {
    event_id: event.id, value_text: field.value_text, value_json: field.value_json,
    provenance: field.provenance, covered: Object.fromEntries(Object.entries(covered).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
  };
  fields.set(key, { ...field, quote_authority_json: JSON.stringify(authority) });
}

/** An explicit decision covers existing claims, but a genuinely new/changed claim can dispute it. */
function recomputeQuoteField(
  fields: Map<string, EntityStateField>,
  interactions: Map<string, InteractionState>,
  event: LedgerEvent,
): void {
  const entityId = event.entity_id;
  if (!entityId) return;
  const key = `${entityId}:quote`;
  const existing = fields.get(key);
  const authority: QuoteAuthority | null = existing?.quote_authority_json
    ? JSON.parse(existing.quote_authority_json) as QuoteAuthority : null;
  type Claim = { id: string; sequence: number; text: string | null; json: string | null; valid: boolean; explicit: boolean };
  const claims: Claim[] = [];
  if (authority?.event_id) {
    claims.push({ id: authority.event_id, sequence: -1, text: authority.value_text,
      json: authority.value_json, valid: true, explicit: true });
  }
  for (const claim of authority?.pending_claims ?? []) claims.push({ ...claim, valid: true, explicit: false });
  for (const [root, row] of interactions) {
    if (row.entity_id !== entityId || row.kind !== 'quote' || row.state !== 'active') continue;
    // Descriptions and dates do not change the quote's financial claim.
    if (authority?.event_id && root in authority.covered && authority.covered[root] === row.head_value_json) continue;
    const triple = row.head_value_json ? quoteTripleOf(JSON.parse(row.head_value_json)) : null;
    claims.push({ id: row.head_event_id, sequence: row.sequence,
      text: triple ? formatQuoteText(triple.amount, triple.currency, triple.role) : null,
      json: triple ? JSON.stringify(triple) : null, valid: triple !== null, explicit: false });
  }
  // Support direct reducer calls, too: the triggering event is the trusted overlay.
  if (event.kind === 'quote' && !interactions.has(quoteRootOf(event))) {
    const triple = quoteTripleOf(event.payload);
    claims.push({ id: event.id, sequence: event.sequence,
      text: triple ? formatQuoteText(triple.amount, triple.currency, triple.role) : null,
      json: triple ? JSON.stringify(triple) : null, valid: triple !== null, explicit: false });
  }
  const distinct = new Map<string, Claim>();
  for (const claim of claims) {
    const triple = claim.json ? quoteTripleOf(JSON.parse(claim.json)) : null;
    const valueKey = !claim.valid ? `unknown:${claim.id}` : triple
      ? `${triple.amount}|${triple.currency}|${triple.role}` : `${claim.text}|${claim.json}`;
    const prior = distinct.get(valueKey);
    if (!prior || (!prior.explicit && (claim.explicit || claim.sequence > prior.sequence))) distinct.set(valueKey, claim);
  }
  const only = distinct.size === 1 ? [...distinct.values()][0]! : null;
  const clear = distinct.size === 0 || (only?.valid ?? false);
  fields.set(key, {
    id: `${entityId}_quote`, workspace_id: event.workspace_id, entity_id: entityId, field_name: 'quote',
    state: clear ? 'clear' : 'disputed',
    value_text: clear ? only?.text ?? null : null,
    value_json: clear ? only?.json ?? null : null,
    provenance: only?.explicit ? authority!.provenance : event.provenance,
    source_event_id: clear ? only?.id ?? null : null,
    candidate_event_ids: clear ? null : claims.sort((a, b) => a.sequence - b.sequence).map((claim) => claim.id),
    last_confirmed_value_text: clear && only ? only.text : existing?.last_confirmed_value_text ?? null,
    last_confirmed_value_json: clear && only ? only.json : existing?.last_confirmed_value_json ?? null,
    revision: (existing?.revision ?? 0) + 1, updated_at: event.recorded_at,
    quote_authority_json: existing?.quote_authority_json ?? null,
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

          let quoteAuthorityJson = existing.quote_authority_json ?? null;
          if (p.field_name === 'quote') {
            const authority: QuoteAuthority = quoteAuthorityJson ? JSON.parse(quoteAuthorityJson) as QuoteAuthority : {
              event_id: null, value_text: null, value_json: null, provenance: event.provenance, covered: {},
            };
            authority.pending_claims = [...(authority.pending_claims ?? []), {
              id: event.id, sequence: event.sequence, text: valText, json: valJson,
            }];
            quoteAuthorityJson = JSON.stringify(authority);
          }

          fields.set(fieldKey, {
            ...existing,
            state: 'disputed',
            value_text: null,
            value_json: null,
            provenance: event.provenance,
            source_event_id: null,
            candidate_event_ids: Array.from(candidateSet),
            ...(p.field_name === 'quote' ? { quote_authority_json: quoteAuthorityJson } : {}),
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
      if (p.field_name === 'quote') rememberQuoteAuthority(fields, interactions, event);
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
      if (p.field_name === 'quote') rememberQuoteAuthority(fields, interactions, event);
      break;
    }
  }
}
