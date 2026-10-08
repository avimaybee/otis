/**
 * @otis/ledger/commands/interactionPayload
 * Shared validation for single-interaction payloads (note, visit, contact,
 * quote). New logging and C1 revision use this one validator so a correction
 * is accepted by exactly the same rules as the original report.
 */

export type InteractionKind = 'note' | 'visit' | 'contact' | 'quote';

export const INTERACTION_KINDS: readonly InteractionKind[] = ['note', 'visit', 'contact', 'quote'];

export type InteractionPayloadValidation =
  | { valid: true }
  | { valid: false; code: string; message: string };

export function validateInteractionPayload(
  kind: string,
  payload: unknown,
): InteractionPayloadValidation {
  switch (kind) {
    case 'quote': {
      const q = payload as Partial<import('@otis/contracts').QuoteValue>;
      if (
        typeof q?.amount !== 'number' ||
        !Number.isInteger(q.amount) ||
        q.amount < 0 ||
        typeof q.currency !== 'string' ||
        q.currency.trim().length !== 3 ||
        (q.role !== 'offered' && q.role !== 'expected')
      ) {
        return {
          valid: false,
          code: 'invalid_quote',
          message:
            'Quote requires integer minor units (amount >= 0), 3-letter currency, and role ("offered" | "expected").',
        };
      }
      return { valid: true };
    }

    case 'visit': {
      const v = payload as { summary?: unknown; contact_made?: unknown };
      if (typeof v?.summary !== 'string' || typeof v.contact_made !== 'boolean') {
        return {
          valid: false,
          code: 'invalid_visit',
          message: 'Visit event requires string summary and boolean contact_made flag.',
        };
      }
      return { valid: true };
    }

    case 'contact': {
      const c = payload as { summary?: unknown; channel?: unknown };
      if (typeof c?.summary !== 'string' || typeof c.channel !== 'string') {
        return {
          valid: false,
          code: 'invalid_contact',
          message: 'Contact event requires string summary and valid channel.',
        };
      }
      return { valid: true };
    }

    case 'note': {
      const n = payload as { text?: unknown };
      if (typeof n?.text !== 'string' || n.text.trim().length === 0) {
        return {
          valid: false,
          code: 'invalid_note',
          message: 'Note event requires non-empty text string.',
        };
      }
      return { valid: true };
    }

    default:
      return {
        valid: false,
        code: 'unsupported_event_kind',
        message: `Event kind '${String(kind)}' is not permitted for log_event.`,
      };
  }
}
