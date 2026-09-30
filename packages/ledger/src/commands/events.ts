/**
 * @otis/ledger/commands/events
 * Event factory and invariant checking for the Otis append-only ledger.
 */

import type { LedgerEvent, LedgerEventKind, Provenance } from '@otis/contracts';
import type { LedgerCommandContext } from '../types.js';

export function assertEventInvariant(event: LedgerEvent): boolean {
  if (!event.id || !event.workspace_id || !event.actor_kind || !event.kind) {
    return false;
  }
  const hasMessage = Boolean(event.source_message_id);
  const hasJob = Boolean(event.source_job_id);

  // Invariant: exactly one source reference (member message ID or system job ID)
  if (!((hasMessage || hasJob) && !(hasMessage && hasJob))) {
    return false;
  }

  // Invariant: channel must match source
  if (hasJob && event.channel !== 'system') {
    return false;
  }

  // Invariant: actor attribution
  if (event.actor_kind === 'system' && (!event.actor_job_id || !hasJob)) {
    return false;
  }
  if (event.actor_kind === 'member' && (!event.actor_user_id || !hasMessage)) {
    return false;
  }

  return true;
}

export interface CreateEventOptions<T> {
  entity_id?: string | null;
  kind: LedgerEventKind;
  payload: T;
  occurred_at?: string;
  supersedes_event_id?: string | null;
  reverts_event_id?: string | null;
  provenance?: Provenance;
}

export function createLedgerEvent<T>(
  context: LedgerCommandContext,
  sequence: number,
  options: CreateEventOptions<T>,
): LedgerEvent<T> {
  const now = new Date().toISOString();
  const eventId = `evt_${crypto.randomUUID()}`;

  const channel: 'web' | 'telegram' | 'system' = context.source_job_id
    ? 'system'
    : (context.source_channel || (context.actor.kind === 'system' ? 'system' : 'web'));

  const event: LedgerEvent<T> = {
    id: eventId,
    workspace_id: context.workspace_id,
    sequence,
    entity_id: options.entity_id || null,
    actor_kind: context.actor.kind,
    actor_user_id: context.actor.user_id || null,
    actor_job_id: context.actor.system_job || null,
    kind: options.kind,
    schema_version: 1,
    payload: options.payload,
    occurred_at: options.occurred_at || now,
    recorded_at: now,
    channel,
    source_message_id: context.source_message_id || null,
    source_job_id: context.source_job_id || null,
    action_id: context.action_id,
    supersedes_event_id: options.supersedes_event_id || null,
    reverts_event_id: options.reverts_event_id || null,
    provenance: options.provenance || 'stated',
    created_at: now,
  };

  if (!assertEventInvariant(event)) {
    throw new Error(
      `Event invariant violation: exactly one source message or job required. Got message=${context.source_message_id}, job=${context.source_job_id}`,
    );
  }

  return event;
}
