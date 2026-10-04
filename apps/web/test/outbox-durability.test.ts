/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { del as idbDel, get as idbGet, set as idbSet, update as idbUpdate } from 'idb-keyval';
import {
  clearOutboxStorage,
  clearUserOutbox,
  createOutboxEntry,
  entriesForChat,
  getNewChatMapping,
  outboxDurable,
  rehydrateOutbox,
  resetOutboxForTests,
  retryOutboxEntry,
  setNewChatMapping,
  subscribeOutbox,
} from '../src/api/outbox.js';
import { deriveTranscript } from '../src/api/transcript.js';

const getMock = vi.mocked(idbGet);
const setMock = vi.mocked(idbSet);
const updateMock = vi.mocked(idbUpdate);

async function idbStore(): Promise<Map<string, unknown>> {
  const mod = (await import('idb-keyval')) as unknown as { __store: Map<string, unknown> };
  return mod.__store;
}

function flushPersist(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 10));
}

describe('outbox durability ownership (R5)', () => {
  beforeEach(async () => {
    resetOutboxForTests();
    vi.clearAllMocks();
    (await idbStore()).clear();
    getMock.mockResolvedValue(undefined);
    setMock.mockResolvedValue(undefined);
  });

  it('a rejected write flips module durability false and notifies subscribers', async () => {
    updateMock.mockRejectedValueOnce(new Error('quota exceeded'));
    const notifications: number[] = [];
    const unsubscribe = subscribeOutbox(() => {
      notifications.push(1);
    });
    try {
      const entry = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'hi' });
      await flushPersist();
      expect(outboxDurable()).toBe(false);
      // Creation notify plus failure notify: subscribers re-render honest state.
      expect(notifications.length).toBeGreaterThanOrEqual(2);
      const derived = deriveTranscript([], [entry], outboxDurable());
      expect(derived.delivery[entry.clientId]).toMatchObject({ state: 'sending', durable: false });
    } finally {
      unsubscribe();
    }
  });

  it('recovery flips durability back and notifies again', async () => {
    updateMock.mockRejectedValueOnce(new Error('quota exceeded'));
    createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'hi' });
    await flushPersist();
    expect(outboxDurable()).toBe(false);
    const notifications: number[] = [];
    const unsubscribe = subscribeOutbox(() => {
      notifications.push(1);
    });
    try {
      createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'again' });
      await flushPersist();
      expect(outboxDurable()).toBe(true);
      expect(notifications.length).toBeGreaterThanOrEqual(1);
    } finally {
      unsubscribe();
    }
  });

  it('reload restores sending entries as unknown acceptance under current durability', async () => {
    const storedSending = {
      schemaVersion: 1,
      clientId: 'uuid-reload-1',
      userId: 'avi',
      workspaceId: 'ws',
      chatId: 'chat',
      newChatKey: null,
      text: 'reload me',
      createdAt: new Date().toISOString(),
      state: 'sending',
      attempts: 0,
      // Pre-fix shape carried a stale per-entry flag; it must not survive.
      durable: true,
    };
    getMock.mockResolvedValue({ schemaVersion: 1, entries: [storedSending], newChats: {} });
    await rehydrateOutbox('avi');
    const entries = entriesForChat('avi', 'ws', 'chat');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.state).toBe('sending');
    expect('durable' in entries[0]!).toBe(false);
    // Unknown acceptance reconciles with the original identity, never as new.
    const retried = retryOutboxEntry('uuid-reload-1')!;
    expect(retried.clientId).toBe('uuid-reload-1');
    expect(retried.text).toBe('reload me');
    const derived = deriveTranscript([], [retried], outboxDurable());
    expect(derived.delivery['uuid-reload-1']?.state).toBe('sending');
  });

  it('logout purges one user scope durably while the other survives', async () => {
    const aviEntry = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: null, text: 'avi secret' });
    setNewChatMapping(aviEntry.newChatKey!, 'chat-avi', 'avi');
    createOutboxEntry({ userId: 'hunor', workspaceId: 'ws', chatId: 'chat', text: 'hunor note' });
    setNewChatMapping('key-hunor', 'chat-hunor', 'hunor');
    clearUserOutbox('avi');
    await flushPersist();
    expect(entriesForChat('avi', 'ws', 'chat')).toHaveLength(0);
    expect(getNewChatMapping(aviEntry.newChatKey!, 'avi')).toBeUndefined();
    expect(entriesForChat('hunor', 'ws', 'chat', null)).toHaveLength(1);
    expect(getNewChatMapping('key-hunor', 'hunor')).toBe('chat-hunor');
    // The persisted per-account record must not retain the logged-out
    // user's content, while the other account survives untouched.
    const store = await idbStore();
    const aviRecord = store.get('otis/outbox/v1/user/avi') as
      | { entries: Record<string, { text: string; userId: string }>; newChats: Record<string, { userId: string }> }
      | undefined;
    expect(aviRecord).toBeDefined();
    expect(Object.values(aviRecord!.entries)).toHaveLength(0);
    expect(Object.values(aviRecord!.newChats)).toHaveLength(0);
    expect(JSON.stringify(aviRecord)).not.toContain('avi secret');
    const hunorRecord = store.get('otis/outbox/v1/user/hunor') as
      | { entries: Record<string, { text: string; userId: string }>; newChats: Record<string, { userId: string }> }
      | undefined;
    expect(Object.values(hunorRecord!.entries).map(entry => entry.text)).toEqual(['hunor note']);
    expect(Object.values(hunorRecord!.newChats).map(mapping => mapping.userId)).toEqual(['hunor']);
  });

  it('storage reset removes the persisted record durably', async () => {
    createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'hi' });
    await clearOutboxStorage();
    expect(idbDel).toHaveBeenCalledWith('otis/outbox/v1');
  });

  it('merges a delayed restore without losing input created mid-flight', async () => {
    let resolveLegacy!: (value: unknown) => void;
    getMock.mockImplementation((key: string) => {
      if (String(key) === 'otis/outbox/v1') {
        return new Promise(resolve => {
          resolveLegacy = resolve as never;
        });
      }
      return Promise.resolve(undefined);
    });
    const restoring = rehydrateOutbox('avi');
    // The app exposes send while the restore is still deferred.
    const live = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'typed during restore' });
    const stored = {
      schemaVersion: 1,
      entries: [
        {
          schemaVersion: 1,
          clientId: 'uuid-stored-1',
          userId: 'avi',
          workspaceId: 'ws',
          chatId: 'chat',
          newChatKey: null,
          text: 'stored earlier',
          createdAt: new Date().toISOString(),
          state: 'sending',
          attempts: 0,
        },
      ],
      newChats: {},
    };
    resolveLegacy(stored);
    await restoring;
    const ids = entriesForChat('avi', 'ws', 'chat').map(entry => entry.clientId);
    expect(ids).toContain(live.clientId);
    expect(ids).toContain('uuid-stored-1');
    const derived = deriveTranscript([], entriesForChat('avi', 'ws', 'chat'), outboxDurable());
    expect(derived.messages).toHaveLength(2);
  });

  it('a clear during a deferred restore never resurrects purged content', async () => {
    let resolveLegacy!: (value: unknown) => void;
    getMock.mockImplementation((key: string) => {
      if (String(key) === 'otis/outbox/v1') {
        return new Promise(resolve => {
          resolveLegacy = resolve as never;
        });
      }
      return Promise.resolve(undefined);
    });
    const restoring = rehydrateOutbox('avi');
    const doomed = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'logged out' });
    setNewChatMapping('key-doomed', 'chat-doomed', 'avi');
    clearUserOutbox('avi');
    resolveLegacy({
      schemaVersion: 1,
      entries: [
        {
          schemaVersion: 1,
          clientId: doomed.clientId,
          userId: 'avi',
          workspaceId: 'ws',
          chatId: 'chat',
          newChatKey: null,
          text: 'logged out',
          createdAt: new Date().toISOString(),
          state: 'sending',
          attempts: 0,
        },
      ],
      newChats: { 'key-doomed': { chatId: 'chat-doomed', userId: 'avi' } },
    });
    await restoring;
    expect(entriesForChat('avi', 'ws', 'chat')).toHaveLength(0);
    expect(getNewChatMapping('key-doomed', 'avi')).toBeUndefined();
  });
});
