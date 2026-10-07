/**
 * @otis/ledger/reducers/fields
 * Reducer for entity_state, core fields, disputes, and conflict resolutions.
 */

import type { EntityStateField, LedgerEvent, QuoteValue } from '@otis/contracts';

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

export function reduceFields(
  fields: Map<string, EntityStateField>,
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
      const quote = event.payload as QuoteValue;
      const fieldKey = `${event.entity_id}:quote`;
      const existing = fields.get(fieldKey);
      const formattedText = formatQuoteText(quote.amount, quote.currency, quote.role);
      const jsonStr = JSON.stringify(quote);

      if (existing && !event.supersedes_event_id) {
        let isDifferent = false;
        if (existing.state === 'disputed') {
          isDifferent = true;
        } else if (existing.value_json) {
          try {
            const parsed = JSON.parse(existing.value_json) as QuoteValue;
            if (
              parsed.amount !== quote.amount ||
              parsed.currency !== quote.currency ||
              parsed.role !== quote.role
            ) {
              isDifferent = true;
            }
          } catch {
            isDifferent = true;
          }
        } else {
          isDifferent = true;
        }

        if (isDifferent) {
          // Competing incompatible quote claims -> field becomes disputed, current value NULL
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

      // Explicit superseding, resolution, or initial clean quote
      fields.set(fieldKey, {
        id: `${event.entity_id}_quote`,
        workspace_id: event.workspace_id,
        entity_id: event.entity_id,
        field_name: 'quote',
        state: 'clear',
        value_text: formattedText,
        value_json: jsonStr,
        provenance: event.provenance,
        source_event_id: event.id,
        candidate_event_ids: null,
        last_confirmed_value_text: formattedText,
        last_confirmed_value_json: jsonStr,
        revision: (existing?.revision || 0) + 1,
        updated_at: event.recorded_at,
      });
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
