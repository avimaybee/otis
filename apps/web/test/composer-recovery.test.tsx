/** @vitest-environment happy-dom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../src/components/Composer.js';

vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    update: vi.fn(async (key: string, updater: (old: unknown) => unknown) => {
      store.set(key, updater(store.get(key)));
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    __store: store,
  };
});

import { update as idbUpdate } from 'idb-keyval';
import {
  createOutboxEntry,
  isOutboxEntryDurable,
  resetOutboxForTests,
} from '../src/api/outbox.js';

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const USER_ID = 'u-recovery';
const DRAFT_KEY = 'test-recovery-order-key';
const RECOVERY_KEY = `${DRAFT_KEY}:pasted-recovery`;

type RecoveryEntries = Record<string, { id: string; pastedText: string; surroundingText: string; createdAt: string }>;

function readRecovery(): RecoveryEntries {
  const raw = localStorage.getItem(RECOVERY_KEY);
  if (!raw) return {};
  return (JSON.parse(raw) as { entries?: RecoveryEntries }).entries ?? {};
}

function seedLegacyEntry(): void {
  localStorage.setItem(
    RECOVERY_KEY,
    JSON.stringify({
      entries: {
        'legacy-stale': {
          id: 'legacy-stale',
          pastedText: 'stale unsent paste that never rebuilt',
          surroundingText: '',
          createdAt: new Date().toISOString(),
        },
      },
    }),
  );
}

async function mount(element: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => root.render(element));
  return {
    host,
    unmount: async () => {
      await React.act(async () => root.unmount());
      host.remove();
    },
  };
}

/**
 * Production-like send: creates a real outbox entry (deferred persistence,
 * like the timer path) and returns its identity for the durability ack.
 */
function acceptSend(
  text: string,
  imageMediaIds?: string[],
  extra?: { documentMediaIds?: string[]; isPastedText?: boolean },
): string {
  const entry = createOutboxEntry({
    userId: USER_ID,
    workspaceId: 'ws_1',
    chatId: 'chat_1',
    text,
    ...(imageMediaIds && imageMediaIds.length > 0 ? { imageMediaIds } : {}),
    ...(extra?.documentMediaIds && extra.documentMediaIds.length > 0
      ? { documentMediaIds: extra.documentMediaIds }
      : {}),
    ...(extra?.isPastedText ? { isPastedText: true } : {}),
  });
  return entry.clientId;
}

function mountComposer(onSend: (...args: never[]) => unknown) {
  return mount(
    <Composer
      commands={[]}
      running={false}
      draftKey={DRAFT_KEY}
      onSend={onSend as never}
      documents={{
        available: true,
        workspaceId: 'ws_1',
        userId: USER_ID,
        chatId: 'chat_1',
        onEnsureChat: async () => 'chat_1',
        upload: async () => ({ mediaId: 'doc_pasted', format: 'text/plain' as const, filename: 'Pasted text.txt' }),
      }}
    />,
  );
}

async function pasteOversized(host: HTMLElement): Promise<void> {
  const textarea = host.querySelector('textarea')!;
  const oversizedClipboard = 'Q'.repeat(16200);
  const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(pasteEvent, 'clipboardData', {
    value: {
      getData: (format: string) => (format === 'text/plain' ? oversizedClipboard : ''),
    },
  });
  await React.act(async () => {
    textarea.dispatchEvent(pasteEvent);
  });
  expect(host.textContent).toContain('Pasted text.txt');
}

async function clickSend(host: HTMLElement): Promise<void> {
  const sendBtn = host.querySelector('[aria-label="Send"]') as HTMLElement;
  expect(sendBtn).toBeTruthy();
  await React.act(async () => {
    sendBtn.click();
  });
}

describe('Composer paste-recovery send ordering', () => {
  beforeEach(() => {
    localStorage.clear();
    resetOutboxForTests();
    vi.clearAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  it('clears submitted recovery only after the entry is durably acked, keeping unrelated legacy slots', async () => {
    let submittedClientId: string | null = null;
    const onSend = vi.fn(async (...args: unknown[]) => {
      const [text, imageMediaIds, extra] = args as [
        string,
        string[] | undefined,
        { documentMediaIds?: string[]; isPastedText?: boolean } | undefined,
      ];
      submittedClientId = acceptSend(text, imageMediaIds, extra);
      return submittedClientId;
    });
    const view = await mountComposer(onSend);
    // Seeded after mount so no rebuild migrates it: an unrelated send must
    // not purge this unsent text.
    seedLegacyEntry();
    await pasteOversized(view.host);
    const before = readRecovery();
    expect(Object.keys(before)).toContain('legacy-stale');
    expect(Object.keys(before).length).toBeGreaterThan(1);

    await clickSend(view.host);
    expect(onSend).toHaveBeenCalled();

    // The ack covers the exact submitted entry identity, not a global flag.
    expect(submittedClientId).toBeTruthy();
    expect(isOutboxEntryDurable(submittedClientId!)).toBe(true);
    const after = readRecovery();
    expect(after['legacy-stale']?.pastedText).toBe('stale unsent paste that never rebuilt');
    expect(Object.keys(after)).toEqual(['legacy-stale']);
    await view.unmount();
  });

  it('keeps recovery entries when the send is refused', async () => {
    const onSend = vi.fn().mockResolvedValue(false);
    const view = await mountComposer(onSend);
    await pasteOversized(view.host);
    expect(Object.keys(readRecovery()).length).toBeGreaterThan(0);

    await clickSend(view.host);
    expect(onSend).toHaveBeenCalled();
    // Refused: the backup stays for the next attempt.
    expect(Object.keys(readRecovery()).length).toBeGreaterThan(0);
    await view.unmount();
  });

  it('keeps recovery entries when the send throws', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('network down'));
    const view = await mountComposer(onSend);
    await pasteOversized(view.host);
    expect(Object.keys(readRecovery()).length).toBeGreaterThan(0);

    await clickSend(view.host);
    expect(view.host.textContent).toContain('Retry');
    expect(Object.keys(readRecovery()).length).toBeGreaterThan(0);
    await view.unmount();
  });

  it('keeps recovery entries when outbox persistence fails after an accepted send', async () => {
    vi.mocked(idbUpdate).mockRejectedValueOnce(new Error('idb unavailable'));
    const onSend = vi.fn(async (...args: unknown[]) => {
      const [text, imageMediaIds, extra] = args as [
        string,
        string[] | undefined,
        { documentMediaIds?: string[]; isPastedText?: boolean } | undefined,
      ];
      return acceptSend(text, imageMediaIds, extra);
    });
    const view = await mountComposer(onSend);
    await pasteOversized(view.host);
    const liveKeys = Object.keys(readRecovery());
    expect(liveKeys.length).toBeGreaterThan(0);

    await clickSend(view.host);
    expect(onSend).toHaveBeenCalled();
    // Accepted locally but never durable: the backup must survive.
    expect(Object.keys(readRecovery())).toEqual(liveKeys);
    await view.unmount();
  });
});
