/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { ApiError, api } from '../src/api/client.js';
import * as stream from '../src/hooks/useActivityStream.js';
import {
  createOutboxEntry,
  entriesForUser,
  resetOutboxForTests,
} from '../src/api/outbox.js';
import { resetFlushForTests } from '../src/api/flush.js';
import { mountRoute } from './route.js';
import type { Chat, ChatMessage } from '@otis/contracts';

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

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: vi.fn(() => ({
    needRefresh: [false, vi.fn()],
    offlineReady: [false, vi.fn()],
    updateServiceWorker: vi.fn(),
  })),
}));

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const USER = 'usr_wl';
const WA = 'ws_wl_a';
const WB = 'ws_wl_b';

beforeEach(async () => {
  resetOutboxForTests();
  resetFlushForTests();
  sessionStorage.clear();
  vi.clearAllMocks();
  history.replaceState({}, '', '/');
  const idb = (await import('idb-keyval')) as unknown as { __store: Map<string, unknown> };
  idb.__store.clear();
});

afterEach(() => {
  resetOutboxForTests();
  resetFlushForTests();
  sessionStorage.clear();
  vi.restoreAllMocks();
  history.replaceState({}, '', '/');
});

function chatRow(workspaceId: string, id: string, title: string): Chat {
  return {
    id,
    workspace_id: workspaceId,
    title,
    author_user_id: USER,
    author_display_name: 'Avi',
    model_override: null,
    is_archived: false,
    activity_cursor: 1,
    created_at: '2026-10-03T12:00:00.000Z',
    updated_at: '2026-10-03T12:00:00.000Z',
    last_activity_at: '2026-10-03T12:00:00.000Z',
  };
}

function chatMessage(workspaceId: string, chatId: string, id: string, text: string): ChatMessage {
  return {
    id,
    workspace_id: workspaceId,
    chat_id: chatId,
    author_user_id: USER,
    author_display_name: 'Avi',
    author_kind: 'member',
    channel: 'web',
    inbound_message_id: `in_${id}`,
    client_message_id: null,
    content_text: text,
    media_id: null,
    run_id: null,
    sequence: 1,
    created_at: '2026-10-03T12:00:00.000Z',
    updated_at: '2026-10-03T12:00:00.000Z',
  };
}

function baseMocks(chatsByWorkspace: Record<string, Chat[]>, messagesByChat: Record<string, ChatMessage[]>) {
  vi.spyOn(api, 'listChats').mockImplementation(async (workspaceId) => ({ chats: chatsByWorkspace[workspaceId] ?? [] }));
  vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
  vi.spyOn(api, 'models').mockResolvedValue({
    models: [
      {
        command_key: 'mimo-25',
        display_name: 'MiMo V2.5',
        provider: 'opencode_go',
        available: true,
        is_current: true,
        is_default: true,
        native_audio_supported: false,
        voice_available: false,
      },
    ],
    current_command_key: 'mimo-25',
    default_command_key: 'mimo-25',
  } as never);
  vi.spyOn(api, 'getChat').mockImplementation(async (workspaceId, id) => {
    const chat = (chatsByWorkspace[workspaceId] ?? []).find((item) => item.id === id);
    if (!chat) throw new ApiError(404, 'not_found', 'Gone');
    return { chat, is_author: true };
  });
  vi.spyOn(api, 'listMessages').mockImplementation(async (_ws, id) => ({
    chat_id: id,
    messages: messagesByChat[id] ?? [],
    next_before_sequence: null,
  }));
  vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
  vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
  vi.spyOn(stream, 'subscribeToActivity').mockReturnValue({ close: vi.fn() });
}

async function sendFromComposer(view: { host: HTMLElement }, text: string) {
  const input = view.host.querySelector('textarea')!;
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const send = view.host.querySelector('[aria-label="Send"]') as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  await React.act(async () => send.click());
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('workspace-scoped access loss', () => {
  it('files a foreground 403 send as a failed bubble without purging the session', async () => {
    baseMocks({ [WA]: [chatRow(WA, 'chat_A', 'Alpha')] }, { chat_A: [chatMessage(WA, 'chat_A', 'm1', 'Alpha note')] });
    vi.spyOn(api, 'sendMessage').mockRejectedValue(
      new ApiError(403, 'forbidden', 'Only the chat author can append messages to this conversation.'),
    );
    const view = await mountRoute(`/?workspace=${WA}&chat=chat_A`, {
      userId: USER,
      workspaces: [{ id: WA, name: 'Kerning' }],
      members: { [USER]: 'Avi' },
    });
    try {
      await sendFromComposer(view, 'Hello work');
      await React.act(async () => { await tick(); });
      await React.act(async () => { await tick(); });
      // The verdict is filed honestly on the bubble; nothing is purged.
      expect(view.host.textContent).toContain('Hello work');
      expect(view.host.textContent).not.toContain('Conversation unavailable');
      const entries = entriesForUser(USER);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.state).toBe('failed');
      expect(entries[0]!.errorMessage).toContain('Only the chat author');
    } finally {
      await view.unmount();
    }
  });

  it('keeps another workspace unsent work when this workspace snapshot 403s', async () => {
    baseMocks(
      { [WA]: [chatRow(WA, 'chat_A', 'Alpha')], [WB]: [chatRow(WB, 'chat_B', 'Beta')] },
      { chat_A: [chatMessage(WA, 'chat_A', 'm1', 'Alpha note')], chat_B: [chatMessage(WB, 'chat_B', 'm2', 'Beta note')] },
    );
    // Workspace B revoked the member on a legacy route: the snapshot 403s.
    vi.spyOn(api, 'getChat').mockImplementation(async (workspaceId, id) => {
      if (workspaceId === WB) throw new ApiError(403, 'forbidden', 'User is not a member of this workspace.');
      const chat = [chatRow(WA, 'chat_A', 'Alpha')].find((item) => item.id === id);
      if (!chat) throw new ApiError(404, 'not_found', 'Gone');
      return { chat, is_author: true };
    });
    // Unsent work lives in workspace A while B is on screen. The background
    // send stays in flight (hung mock) so the entry is provably untouched.
    vi.spyOn(api, 'sendMessage').mockImplementation(() => new Promise(() => {}));
    const kept = createOutboxEntry({ userId: USER, workspaceId: WA, chatId: 'chat_A', text: 'Keep me' });
    const view = await mountRoute(`/?workspace=${WB}&chat=chat_B`, {
      userId: USER,
      workspaces: [{ id: WA, name: 'Kerning' }, { id: WB, name: 'Second' }],
      members: { [USER]: 'Avi' },
    });
    try {
      await React.act(async () => { await tick(); });
      await React.act(async () => { await tick(); });
      // The denial parks only workspace B with its unsent work kept: never
      // the session-wide access screen, and never a retry loop.
      expect(view.host.textContent).toContain('Workspace unavailable');
      expect(view.host.textContent).toContain('unsent work are kept');
      expect(view.host.textContent).not.toContain('Reload access');
      // Workspace A's unsent entry and server cache survive untouched.
      expect(entriesForUser(USER).map((entry) => entry.clientId)).toEqual([kept.clientId]);
      expect(entriesForUser(USER)[0]!.state).toBe('sending');
    } finally {
      await view.unmount();
    }
  });

  it('parks a revoked workspace from the live stream without touching siblings', async () => {
    baseMocks(
      { [WA]: [chatRow(WA, 'chat_A', 'Alpha')], [WB]: [chatRow(WB, 'chat_B', 'Beta')] },
      { chat_A: [chatMessage(WA, 'chat_A', 'm1', 'Alpha note')], chat_B: [chatMessage(WB, 'chat_B', 'm2', 'Beta note')] },
    );
    let revoked: (() => void) | null = null;
    const closes: Array<() => void> = [];
    vi.spyOn(stream, 'subscribeToActivity').mockImplementation((_url, handlers) => {
      revoked = () => handlers.onMembershipRevoked?.();
      const close = vi.fn();
      closes.push(close);
      return { close };
    });
    const kept = createOutboxEntry({ userId: USER, workspaceId: WB, chatId: 'chat_B', text: 'Sibling work' });
    // Sibling sends stay in flight so retention is provable, not raced.
    vi.spyOn(api, 'sendMessage').mockImplementation(() => new Promise(() => {}));
    const view = await mountRoute(`/?workspace=${WA}&chat=chat_A`, {
      userId: USER,
      workspaces: [{ id: WA, name: 'Kerning' }, { id: WB, name: 'Second' }],
      members: { [USER]: 'Avi' },
    });
    try {
      expect(view.host.textContent).toContain('Alpha note');
      await React.act(async () => { revoked!(); });
      await React.act(async () => { await tick(); });
      // Active workspace parks with an explicit notice and a way back.
      expect(view.host.textContent).toContain('Workspace unavailable');
      expect(view.host.textContent).toContain('unsent work are kept');
      expect(view.host.querySelector('button')?.textContent).toBeDefined();
      // The revoked stream closed (no resubscribe while parked).
      expect(closes.some((close) => (close as ReturnType<typeof vi.fn>).mock.calls.length > 0)).toBe(true);
      // Sibling workspace unsent work survives; no session-wide closure.
      expect(entriesForUser(USER).map((entry) => entry.clientId)).toEqual([kept.clientId]);
      expect(view.host.textContent).not.toContain('Reload access');
    } finally {
      await view.unmount();
    }
  });

  it('still purges user-wide state when the session itself dies with 401', async () => {
    baseMocks({ [WA]: [chatRow(WA, 'chat_A', 'Alpha')] }, { chat_A: [chatMessage(WA, 'chat_A', 'm1', 'Alpha note')] });
    vi.spyOn(api, 'getChat').mockRejectedValue(new ApiError(401, 'session_expired', 'Session is invalid or expired.'));
    vi.spyOn(api, 'sendMessage').mockImplementation(() => new Promise(() => {}));
    const kept = createOutboxEntry({ userId: USER, workspaceId: WA, chatId: 'chat_A', text: 'Doomed' });
    expect(entriesForUser(USER).map((entry) => entry.clientId)).toEqual([kept.clientId]);
    const view = await mountRoute(`/?workspace=${WA}&chat=chat_A`, {
      userId: USER,
      workspaces: [{ id: WA, name: 'Kerning' }],
      members: { [USER]: 'Avi' },
    });
    try {
      await React.act(async () => { await tick(); });
      await React.act(async () => { await tick(); });
      expect(view.host.textContent).toContain('Conversation unavailable');
      expect(view.host.textContent).toContain('Reload access');
      expect(entriesForUser(USER)).toHaveLength(0);
    } finally {
      await view.unmount();
    }
  });
});
