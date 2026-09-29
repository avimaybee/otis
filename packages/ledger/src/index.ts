/**
 * @daybook/ledger
 * Append-only event ledger and deterministic state projections for Daybook.
 */

export interface LedgerEvent<T = unknown> {
  id: string;
  workspaceId: string;
  entityId?: string;
  actorUserId: string;
  kind: string;
  body: string;
  data?: T;
  occurredAt: string;
  recordedAt: string;
  channel: string;
  sourceMessageId?: string;
  sourceJobId?: string;
  revertsEventId?: string;
  untrusted: boolean;
}

export function assertEventInvariant(event: LedgerEvent): boolean {
  if (!event.id || !event.workspaceId || !event.actorUserId || !event.kind) {
    return false;
  }
  const hasMessage = Boolean(event.sourceMessageId);
  const hasJob = Boolean(event.sourceJobId);
  // Invariant 4: exactly one source reference (member message ID or system job ID)
  return (hasMessage || hasJob) && !(hasMessage && hasJob);
}
