import { describe, it, expect } from 'vitest';
import { assertEventInvariant, type LedgerEvent } from '../src/index.js';

describe('Ledger Invariants (Pure)', () => {
  it('enforces that an event must have exactly one source reference (message or job)', () => {
    const validMessageEvent: LedgerEvent = {
      id: 'evt-1',
      workspaceId: 'ws-kerning',
      actorUserId: 'usr-hunor',
      kind: 'visit',
      body: 'Pitched restaurant 2',
      occurredAt: '2026-09-29T10:00:00Z',
      recordedAt: '2026-09-29T10:00:02Z',
      channel: 'telegram',
      sourceMessageId: 'msg-101',
      untrusted: false,
    };

    expect(assertEventInvariant(validMessageEvent)).toBe(true);

    const invalidDualSourceEvent: LedgerEvent = {
      ...validMessageEvent,
      sourceJobId: 'job-brief-1',
    };
    expect(assertEventInvariant(invalidDualSourceEvent)).toBe(false);

    const invalidNoSourceEvent: LedgerEvent = {
      ...validMessageEvent,
      sourceMessageId: undefined,
      sourceJobId: undefined,
    };
    expect(assertEventInvariant(invalidNoSourceEvent)).toBe(false);
  });
});
