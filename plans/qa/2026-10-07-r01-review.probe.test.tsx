/** Characterizations: passing defect cases reproduce the asserted gap. */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, ChatMessage } from '@otis/contracts';
import { ConversationScreen } from '../../apps/web/src/ConversationScreen.js';
import { api, ApiError } from '../../apps/web/src/api/client.js';
import { createAppQueryClient, qk } from '../../apps/web/src/api/queries.js';
import { applyAcceptedMessage, fetchChatSnapshot, type ChatSnapshot } from '../../apps/web/src/api/snapshot.js';
import { createOutboxEntry, entriesForChat, markOutboxSaved, resetOutboxForTests } from '../../apps/web/src/api/outbox.js';
import { resetFlushForTests } from '../../apps/web/src/api/flush.js';
import * as stream from '../../apps/web/src/hooks/useActivityStream.js';

vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
    update: vi.fn(async (key: string, updater: (old: unknown) => unknown) => { store.set(key, updater(store.get(key))); }),
    del: vi.fn(async (key: string) => { store.delete(key); }),
    __store: store,
  };
});
vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: vi.fn(() => ({ needRefresh: [false, vi.fn()], offlineReady: [false, vi.fn()], updateServiceWorker: vi.fn() })),
}));
// @ts-expect-error React act test flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const USER = 'r01_review_user';
const WS = 'r01_review_workspace';
const CHAT = 'r01_review_chat';
const key = qk.chat(USER, WS, CHAT);
const clients = new Set<QueryClient>();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function base(): ChatSnapshot {
  const chat = {
    id: CHAT, workspace_id: WS, title: 'Review', author_user_id: USER,
    author_display_name: 'Reviewer', model_override: null, is_archived: false,
    activity_cursor: 1, created_at: '2026-10-07T10:00:00Z', updated_at: '2026-10-07T10:00:00Z',
    last_activity_at: '2026-10-07T10:00:00Z',
  } as Chat;
  const message: ChatMessage = {
    id: 'old_message', workspace_id: WS, chat_id: CHAT, author_user_id: USER, author_display_name: 'Reviewer',
    author_kind: 'member', channel: 'web', inbound_message_id: null, client_message_id: null,
    media_id: null, image_media_ids: null, run_id: 'old_run', sequence: 1, content_text: 'Existing message',
    created_at: '2026-10-07T10:00:00Z', updated_at: '2026-10-07T10:00:00Z',
  };
  return { detail: { chat, is_author: true }, messages: [message], older: null, runs: {}, activities: [], questions: [], cursor: 1 };
}
function mocks(snapshot = base()) {
  vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [snapshot.detail.chat] });
  vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
  vi.spyOn(api, 'models').mockResolvedValue({ models: [], current_command_key: 'review', default_command_key: 'review' } as never);
  vi.spyOn(api, 'getChat').mockResolvedValue(snapshot.detail);
  vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: CHAT, messages: snapshot.messages, next_before_sequence: null });
  vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 1 } as never);
  vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
  vi.spyOn(api, 'runs').mockResolvedValue({ runs: [] });
  vi.spyOn(stream, 'subscribeToActivity').mockReturnValue({ close: vi.fn() });
}
async function mount(queryClient = createAppQueryClient()) {
  clients.add(queryClient);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => {
    root.render(<QueryClientProvider client={queryClient}><ConversationScreen workspaceId={WS} chat={CHAT}
      chatParamPresent={true} workspaces={[{ id: WS, name: 'Review workspace' }]} userId={USER}
      members={{ [USER]: 'Reviewer' }} onSignOut={vi.fn()} onNavigate={vi.fn()}/></QueryClientProvider>);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  return { host, queryClient, unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}
beforeEach(async () => {
  resetOutboxForTests(); resetFlushForTests(); sessionStorage.clear();
  const idb = await import('idb-keyval') as unknown as { __store: Map<string, unknown> };
  idb.__store.clear();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const queryClient of clients) queryClient.clear();
  clients.clear(); resetOutboxForTests(); resetFlushForTests(); sessionStorage.clear(); vi.restoreAllMocks();
});

describe('R01 secondary metadata errors and dependencies', () => {
  it.each(['activity', 'clarifications', 'runs'] as const)('characterization: %s swallows both auth statuses', async source => {
    mocks();
    for (const status of [401, 403]) {
      vi.mocked(api[source]).mockRejectedValue(new ApiError(status, 'forbidden', 'Access lost'));
      const full = await fetchChatSnapshot(WS, CHAT, new AbortController().signal);
      expect(full.messages).toEqual(base().messages);
      expect(full.questions).toEqual([]);
      expect(full.runs).toEqual({});
    }
  });
  it('characterization: metadata waits for primary and runs waits for unrelated metadata', async () => {
    mocks();
    const primary = deferred<ChatSnapshot['detail']>();
    const activity = deferred<{ activities: never[]; latest_cursor: number }>();
    vi.mocked(api.getChat).mockReturnValue(primary.promise);
    vi.mocked(api.activity).mockReturnValue(activity.promise);
    const onPrimary = vi.fn();
    const pending = fetchChatSnapshot(WS, CHAT, undefined, onPrimary);
    await Promise.resolve();
    expect(api.activity).not.toHaveBeenCalled();
    expect(api.clarifications).not.toHaveBeenCalled();
    primary.resolve(base().detail);
    await vi.waitFor(() => expect(onPrimary).toHaveBeenCalledOnce());
    expect(api.activity).toHaveBeenCalledOnce();
    expect(api.runs).not.toHaveBeenCalled();
    activity.resolve({ activities: [], latest_cursor: 1 });
    await pending;
    expect(api.runs).toHaveBeenCalledOnce();
  });
});

describe('R01 production screen boundaries', () => {
  it('characterization: a transient questions failure leaves a visible Answer question action unable to open its panel', async () => {
    mocks();
    vi.mocked(api.clarifications).mockRejectedValue(new ApiError(503, 'service_unavailable', 'Temporary outage'));
    vi.mocked(api.runs).mockResolvedValue({ runs: [{
      run: { id: 'old_run' } as never, status: 'waiting_for_input', steps: [], actions: [], activities: [],
      pending_clarification: { id: 'pending_question', question: 'When should this be ready?' } as never,
    }] });
    const view = await mount();
    try {
      await vi.waitFor(() => expect(view.host.querySelector('.otis-question__reply-btn')).not.toBeNull());
      await React.act(async () => { view.host.querySelector<HTMLButtonElement>('.otis-question__reply-btn')!.click(); });
      expect(view.host.querySelector('[aria-label="Question from Otis"]')).toBeNull();
      expect(api.clarifications).toHaveBeenCalledOnce();
      expect(view.queryClient.getQueryState(key)?.status).toBe('success');
      expect(view.host.textContent).not.toContain('Temporary outage');
    } finally { await view.unmount(); }
  });
  it('characterization: composer unlocks while live stream remains blocked by run metadata', async () => {
    mocks();
    const runs = deferred<{ runs: never[] }>();
    vi.mocked(api.runs).mockReturnValue(runs.promise);
    const view = await mount();
    try {
      await vi.waitFor(() => expect(view.host.textContent).toContain('Existing message'));
      expect(view.host.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.disabled).toBe(false);
      expect(stream.subscribeToActivity).not.toHaveBeenCalled();
      await React.act(async () => { runs.resolve({ runs: [] }); await new Promise(resolve => setTimeout(resolve, 0)); });
      await vi.waitFor(() => expect(stream.subscribeToActivity).toHaveBeenCalledOnce());
    } finally { runs.resolve({ runs: [] }); await view.unmount(); }
  });
  it('characterization: final return still removes a newer accepted bubble after actual screen pruning', async () => {
    const initial = base(); mocks(initial);
    const queryClient = createAppQueryClient(); queryClient.setQueryData(key, initial);
    const view = await mount(queryClient);
    const runs = deferred<{ runs: never[] }>();
    vi.mocked(api.runs).mockReturnValue(runs.promise);
    let refetch!: Promise<void>;
    try {
      await React.act(async () => { refetch = queryClient.invalidateQueries({ queryKey: key, exact: true }); });
      await vi.waitFor(() => expect(api.runs).toHaveBeenCalledOnce());
      let clientId = '';
      await React.act(async () => {
        const entry = createOutboxEntry({ userId: USER, workspaceId: WS, chatId: CHAT, text: 'Accepted during refetch' });
        clientId = entry.clientId;
        markOutboxSaved(clientId, { messageId: 'accepted_message', runId: 'accepted_run', sequence: 2 });
        queryClient.setQueryData<ChatSnapshot>(key, previous => previous && applyAcceptedMessage(previous, {
          id: 'accepted_message', workspace_id: WS, chat_id: CHAT, author_user_id: USER,
          client_message_id: clientId, content_text: entry.text, media_id: null, run_id: 'accepted_run',
          sequence: 2, created_at: entry.createdAt,
        }));
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      await vi.waitFor(() => expect(view.host.textContent).toContain('Accepted during refetch'));
      expect(entriesForChat(USER, WS, CHAT)).toEqual([]);
      await React.act(async () => { runs.resolve({ runs: [] }); await refetch; await new Promise(resolve => setTimeout(resolve, 0)); });
      await vi.waitFor(() => expect(view.host.textContent).not.toContain('Accepted during refetch'));
      expect(queryClient.getQueryData<ChatSnapshot>(key)!.messages.some(message => message.client_message_id === clientId)).toBe(false);
      expect(entriesForChat(USER, WS, CHAT)).toEqual([]);
    } finally { runs.resolve({ runs: [] }); await view.unmount(); }
  });
});
