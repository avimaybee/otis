/** Shared input rules for new entries and corrections, at every write boundary. */
export type InteractionKind = 'note' | 'visit' | 'contact' | 'quote';
export const INTERACTION_KINDS: readonly InteractionKind[] = ['note', 'visit', 'contact', 'quote'];

export type InteractionPayloadValidation =
  | { valid: true; payload: Record<string, unknown> }
  | { valid: false; code: string; message: string };

const PAYLOAD_KEYS: Record<InteractionKind, readonly string[]> = {
  note: ['text', 'description', 'notes', 'summary'],
  visit: ['summary', 'contact_made', 'location', 'description', 'notes'],
  contact: ['summary', 'channel', 'description', 'notes'],
  quote: ['amount', 'currency', 'role', 'description', 'summary', 'notes'],
};
const CONTACT_CHANNELS = new Set(['phone', 'email', 'in_person', 'telegram', 'whatsapp', 'other']);

export function validateInteractionPayload(kind: string, value: unknown): InteractionPayloadValidation {
  const invalid = (message: string): InteractionPayloadValidation => ({ valid: false, code: `invalid_${kind}`, message });
  if (!INTERACTION_KINDS.includes(kind as InteractionKind)) {
    return { valid: false, code: 'unsupported_event_kind', message: `Unsupported interaction kind '${kind}'.` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Payload must be an object.');
  const payload = { ...value } as Record<string, unknown>;
  const keys = PAYLOAD_KEYS[kind as InteractionKind];
  for (const key of Object.keys(payload)) {
    if (!keys.includes(key)) return invalid(`Payload field '${key}' is not allowed for ${kind}.`);
    if (['text', 'description', 'notes', 'summary', 'location'].includes(key)) {
      if (typeof payload[key] !== 'string') return invalid(`Payload field '${key}' must be a string.`);
      payload[key] = payload[key].trim();
    }
  }
  if (kind === 'note') {
    const text = payload['text'] ?? payload['description'] ?? payload['notes'] ?? payload['summary'];
    if (typeof text !== 'string' || !text) return invalid('Note requires non-empty text.');
    payload['text'] = text;
  } else if (kind === 'visit') {
    if (typeof payload['summary'] !== 'string' || typeof payload['contact_made'] !== 'boolean') {
      return invalid('Visit requires a summary and boolean contact_made.');
    }
  } else if (kind === 'contact') {
    if (typeof payload['summary'] !== 'string' || typeof payload['channel'] !== 'string' || !CONTACT_CHANNELS.has(payload['channel'])) {
      return invalid('Contact requires a summary and a valid contact channel.');
    }
  } else {
    if (!Number.isSafeInteger(payload['amount']) || (payload['amount'] as number) < 0 ||
        typeof payload['currency'] !== 'string' || !/^[a-zA-Z]{3}$/.test(payload['currency'].trim()) ||
        (payload['role'] !== 'offered' && payload['role'] !== 'expected')) {
      return invalid('Quote requires non-negative integer minor units, 3-letter currency, and offered/expected role.');
    }
    payload['currency'] = payload['currency'].trim().toUpperCase();
  }
  return { valid: true, payload };
}

/** Reject ambiguous/local/rolled-over dates; accepted instants sort correctly as UTC text. */
export function normalizeInteractionOccurredAt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! ||
      Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59 ||
      (zone !== 'Z' && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4, 6)) > 59))) return null;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return null;
  const normalized = new Date(instant).toISOString();
  return /^\d{4}-/.test(normalized) ? normalized : null;
}

export interface CurrentInteraction {
  interaction_id: string;
  head_event_id: string;
  entity_id: string | null;
  entity_name: string | null;
  kind: InteractionKind;
  revision: number;
  occurred_at: string;
  sequence: number;
  payload: Record<string, unknown>;
  actor_kind: string;
  actor_user_id: string | null;
  actor_name: string | null;
  channel: string;
  source_message_id: string | null;
  recorded_at: string;
  provenance: string;
  original_actor_user_id: string | null;
  original_actor_name: string | null;
  original_source_message_id: string | null;
  original_recorded_at: string;
}
