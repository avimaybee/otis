/** @vitest-environment happy-dom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { fetchChatSnapshot, type ChatPrimary } from '../src/api/snapshot.js';
import { ApiError, api } from '../src/api/client.js';
import * as stream from '../src/hooks/useActivityStream.js';
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

afterEach(() => vi.restoreAllMocks());

const WS = 'ws_snap';
const CHAT = 'chat_snap';

function message(id: string, sequence: number, runId: string | null = null) {
  return {
    id, workspace_id: WS, chat_id: CHAT, author_user_id: 'usr_1', author_kind: 'member',
    channel: 'web', inbound_message_id: null, client_message_id: null, media_id: null,
    run_id: runId, sequence, created_at: '2026-10-02T10:00:00.000Z', updated_at: '2026-10-02T10:00:00.000Z',
    content_text: `note ${id}`,
  } as never;
}

function primary() {
  vi.spyOn(api, 'getChat').mockResolvedValue({ chat: { id: CHAT, title: 'Snap' } } as never);
  vi.spyOn(api, 'listMessages').mockResolvedValue({
    chat_id: CHAT,
    messages: [message('m1', 1, 'run_1'), message('m2', 2)],
    next_before_sequence: null,
  } as never);
}

describe('fetchChatSnapshot cancellation', () => {
  it('threads the abort signal into every disposable snapshot read', async () => {
    primary();
    const signal = new AbortController().signal;
    const activity = vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    const clarifications = vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    const getChat = vi.spyOn(api, 'getChat');
    const listMessages = vi.spyOn(api, 'listMessages');
    await fetchChatSnapshot(WS, CHAT, signal);
    expect(getChat).toHaveBeenCalledWith(WS, CHAT, signal);
    expect(listMessages).toHaveBeenCalledWith(WS, CHAT, null, signal);
    expect(activity).toHaveBeenCalledWith(WS, CHAT, 0, signal);
    expect(clarifications).toHaveBeenCalledWith(WS, CHAT, signal);
  });

  it('propagates cancellation so navigation drops the in-flight fetch', async () => {
    primary();
    const controller = new AbortController();
    vi.spyOn(api, 'activity').mockImplementation(
      () => new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason))),
    );
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    const pending = fetchChatSnapshot(WS, CHAT, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
  });

  it('degrades to a detail-less transcript when the run batch fails', async () => {
    primary();
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 3 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(api, 'runs').mockRejectedValue(new Error('boom'));

    const full = await fetchChatSnapshot(WS, CHAT);
    expect(full.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(full.runs).toEqual({});
    expect(full.cursor).toBe(3);
  });
});

describe('fetchChatSnapshot authorization failures', () => {
  it('rejects when activity fails with 401 instead of reporting an empty transcript', async () => {
    primary();
    const auth = new ApiError(401, 'unauthorized', 'Session expired.');
    vi.spyOn(api, 'activity').mockRejectedValue(auth);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    const onPrimary = vi.fn();
    await expect(fetchChatSnapshot(WS, CHAT, undefined, onPrimary)).rejects.toBe(auth);
    // The primary still painted before the failure surfaced.
    expect(onPrimary).toHaveBeenCalledTimes(1);
  });

  it('rejects when clarifications fail with 403 instead of hiding the denial', async () => {
    primary();
    const forbidden = new ApiError(403, 'forbidden', 'No longer a member.');
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockRejectedValue(forbidden);
    await expect(fetchChatSnapshot(WS, CHAT)).rejects.toBe(forbidden);
  });

  it('rejects when the runs batch fails with 401 instead of silently dropping run state', async () => {
    primary();
    const auth = new ApiError(401, 'unauthorized', 'Session expired.');
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 3 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(api, 'runs').mockRejectedValue(auth);
    await expect(fetchChatSnapshot(WS, CHAT)).rejects.toBe(auth);
  });

  it('still degrades ordinary metadata outages: 503 runs and 500 activity stay non-fatal', async () => {
    primary();
    vi.spyOn(api, 'activity').mockRejectedValue(new ApiError(500, 'internal_server_error', 'Outage.'));
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(api, 'runs').mockRejectedValue(new ApiError(503, 'unavailable', 'Passing outage.'));

    const full = await fetchChatSnapshot(WS, CHAT);
    expect(full.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(full.activities).toEqual([]);
    expect(full.runs).toEqual({});
  });
});

describe('fetchChatSnapshot staged primary', () => {
  it('calls onPrimary with the primary transcript before secondary metadata resolves', async () => {
    primary();
    let releaseSecondary!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSecondary = resolve; });
    vi.spyOn(api, 'activity').mockImplementation(() => gate.then(() => ({ activities: [], latest_cursor: 3 } as never)));
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(api, 'runs').mockResolvedValue({ runs: [] });

    const seen: ChatPrimary[] = [];
    const pending = fetchChatSnapshot(WS, CHAT, undefined, (staged) => { seen.push(staged); });
    await vi.waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]!.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(seen[0]!.detail).toEqual({ chat: { id: CHAT, title: 'Snap' } });
    releaseSecondary();
    const full = await pending;
    expect(full.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(full.cursor).toBe(3);
  });

  it('degrades secondary metadata failure to the primary transcript instead of sinking the snapshot', async () => {
    primary();
    vi.spyOn(api, 'activity').mockRejectedValue(new Error('boom'));
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [{ id: 'q1' }] as never });
    vi.spyOn(api, 'runs').mockResolvedValue({ runs: [] });

    const seen: ChatPrimary[] = [];
    const full = await fetchChatSnapshot(WS, CHAT, undefined, (staged) => { seen.push(staged); });
    expect(seen.length).toBe(1);
    expect(full.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(full.activities).toEqual([]);
    expect(full.questions.map((question) => question.id)).toEqual(['q1']);
    expect(full.cursor).toBe(0);
  });

  it('still rejects when the primary transcript itself fails, without calling onPrimary', async () => {
    vi.spyOn(api, 'getChat').mockRejectedValue(new Error('nope'));
    vi.spyOn(api, 'listMessages').mockResolvedValue({
      chat_id: CHAT,
      messages: [],
      next_before_sequence: null,
    } as never);
    const onPrimary = vi.fn();
    await expect(fetchChatSnapshot(WS, CHAT, undefined, onPrimary)).rejects.toThrow('nope');
    expect(onPrimary).not.toHaveBeenCalled();
  });

  it('never calls onPrimary after abort', async () => {
    const controller = new AbortController();
    vi.spyOn(api, 'getChat').mockImplementation(
      () => new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason))),
    );
    vi.spyOn(api, 'listMessages').mockResolvedValue({
      chat_id: CHAT,
      messages: [],
      next_before_sequence: null,
    } as never);
    const onPrimary = vi.fn();
    const pending = fetchChatSnapshot(WS, CHAT, controller.signal, onPrimary);
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(onPrimary).not.toHaveBeenCalled();
  });
});

describe('staged primary paint', () => {
  const STAGE_WS = 'ws_stage';
  const STAGE_USER = 'usr_stage';

  function stageMocks(releaseSecondary: () => void, gate: Promise<void>) {
    const chat = {
      id: 'chat_A',
      workspace_id: STAGE_WS,
      title: 'Alpha',
      author_user_id: STAGE_USER,
      author_display_name: 'Avi',
      model_override: null,
      is_archived: false,
      activity_cursor: 1,
      created_at: '2026-10-03T12:00:00.000Z',
      updated_at: '2026-10-03T12:00:00.000Z',
      last_activity_at: '2026-10-03T12:00:00.000Z',
    } as Chat;
    const note = {
      id: 'm1',
      workspace_id: STAGE_WS,
      chat_id: 'chat_A',
      author_user_id: STAGE_USER,
      author_display_name: 'Avi',
      author_kind: 'member',
      channel: 'web',
      inbound_message_id: 'in_m1',
      client_message_id: null,
      content_text: 'Alpha note',
      media_id: null,
      run_id: null,
      sequence: 1,
      created_at: '2026-10-03T12:00:00.000Z',
      updated_at: '2026-10-03T12:00:00.000Z',
    } as ChatMessage;
    vi.spyOn(api, 'listChats').mockImplementation(async () => ({ chats: [chat] }));
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'models').mockResolvedValue({
      models: [],
      current_command_key: 'mimo-25',
      default_command_key: 'mimo-25',
    } as never);
    vi.spyOn(api, 'getChat').mockImplementation(async () => ({ chat, is_author: true }));
    vi.spyOn(api, 'listMessages').mockImplementation(async () => ({
      chat_id: 'chat_A',
      messages: [note],
      next_before_sequence: null,
    }));
    // Secondary metadata stays in flight while the primary paints.
    vi.spyOn(api, 'activity').mockImplementation(() => gate.then(() => ({ activities: [], latest_cursor: 0 } as never)));
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(stream, 'subscribeToActivity').mockReturnValue({ close: vi.fn() });
    return { releaseSecondary };
  }

  it('paints the transcript from the primary before secondary metadata resolves', async () => {
    let releaseSecondary!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSecondary = resolve; });
    stageMocks(releaseSecondary, gate);
    const view = await mountRoute(`/?workspace=${STAGE_WS}&chat=chat_A`, {
      userId: STAGE_USER,
      workspaces: [{ id: STAGE_WS, name: 'Kerning' }],
      members: { [STAGE_USER]: 'Avi' },
    });
    try {
      // The secondary batch is still gated, yet the primary transcript is
      // already painted: no endless opening spinner for the slow tail.
      const bubbles = () => Array.from(view.host.querySelectorAll('.otis-turn__bubble'));
      expect(bubbles().filter((node) => node.textContent === 'Alpha note')).toHaveLength(1);
      expect(view.host.textContent).not.toContain('Opening conversation…');
      releaseSecondary();
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(bubbles().filter((node) => node.textContent === 'Alpha note')).toHaveLength(1);
    } finally {
      releaseSecondary();
      await view.unmount();
    }
  });

  it('parks only the workspace when secondary metadata is forbidden (403)', async () => {
    let releaseSecondary!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSecondary = resolve; });
    stageMocks(releaseSecondary, gate);
    // Membership revoked mid-view: the question read denies the workspace.
    vi.spyOn(api, 'clarifications').mockRejectedValue(new ApiError(403, 'forbidden', 'No longer a member.'));
    const view = await mountRoute(`/?workspace=${STAGE_WS}&chat=chat_A`, {
      userId: STAGE_USER,
      workspaces: [{ id: STAGE_WS, name: 'Kerning' }],
      members: { [STAGE_USER]: 'Avi' },
    });
    try {
      releaseSecondary();
      // Workspace-scoped loss parks this workspace with its unsent work kept;
      // it never becomes a user-wide sign-out.
      await vi.waitFor(() => expect(view.host.textContent).toContain('Workspace unavailable'));
      expect(view.host.textContent).toContain('unsent work are kept');
      expect(view.host.textContent).not.toContain('Alpha note');
    } finally {
      await view.unmount();
    }
  });
});
