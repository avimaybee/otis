/** Review characterization: passing defect cases demonstrate current gaps. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryObserver, isCancelledError, type QueryClient } from '@tanstack/react-query';
import type { ChatMessage } from '@otis/contracts';
import { api, ApiError } from '../../apps/web/src/api/client.js';
import { createAppQueryClient, qk } from '../../apps/web/src/api/queries.js';
import { applyAcceptedMessage, fetchChatSnapshot, type ChatSnapshot } from '../../apps/web/src/api/snapshot.js';
import { deriveTranscript, reconciledClientIds } from '../../apps/web/src/api/transcript.js';
import { createOutboxEntry, entriesForChat, markOutboxSaved, pruneReconciledEntries, resetOutboxForTests } from '../../apps/web/src/api/outbox.js';

vi.mock('idb-keyval', () => ({ get: vi.fn(async () => undefined), update: vi.fn(async () => undefined), del: vi.fn(async () => undefined) }));

const USER = 'review_user';
const WS = 'review_workspace';
const CHAT = 'review_chat';
const key = qk.chat(USER, WS, CHAT);
const clients = new Set<QueryClient>();
function client() { const value = createAppQueryClient(); clients.add(value); return value; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function message(id: string, sequence: number): ChatMessage {
  return {
    id, workspace_id: WS, chat_id: CHAT, author_user_id: USER, author_display_name: null,
    author_kind: 'member', channel: 'web', inbound_message_id: null, client_message_id: null,
    media_id: null, image_media_ids: null, run_id: 'review_run', sequence,
    content_text: id, created_at: '2026-10-07T10:00:00Z', updated_at: '2026-10-07T10:00:00Z',
  };
}
function base(): ChatSnapshot {
  return {
    detail: { chat: { id: CHAT }, is_author: true } as ChatSnapshot['detail'],
    messages: [message('old_message', 1)], older: null, activities: [], questions: [], runs: {}, cursor: 0,
  };
}
function patchAccepted(queryClient: QueryClient) {
  const entry = createOutboxEntry({ userId: USER, workspaceId: WS, chatId: CHAT, text: 'accepted note' });
  markOutboxSaved(entry.clientId, { messageId: 'accepted_message', runId: 'accepted_run', sequence: 2 });
  queryClient.setQueryData<ChatSnapshot>(key, previous => previous && applyAcceptedMessage(previous, {
    id: 'accepted_message', workspace_id: WS, chat_id: CHAT, author_user_id: USER,
    client_message_id: entry.clientId, content_text: entry.text, media_id: null,
    run_id: 'accepted_run', sequence: 2, created_at: entry.createdAt,
  }));
  return entry;
}
beforeEach(() => {
  resetOutboxForTests();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const queryClient of clients) queryClient.clear();
  clients.clear();
  resetOutboxForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Surgery 1 real transport cancellation', () => {
  const reads = [
    () => api.getChat(WS, CHAT, controller.signal),
    () => api.listMessages(WS, CHAT, null, controller.signal),
    () => api.activity(WS, CHAT, 0, controller.signal),
    () => api.runs(WS, ['review_run'], controller.signal),
    () => api.clarifications(WS, CHAT, controller.signal),
  ];
  let controller: AbortController;
  it.each(reads.map((read, index) => [index + 1, read] as const))('aborts disposable read %i and cleans its listener', async (_index, read) => {
    controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let downstream!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => {
      downstream = init.signal!;
      downstream.addEventListener('abort', () => reject(downstream.reason), { once: true });
    })));
    const pending = read();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(downstream.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(console.error).not.toHaveBeenCalled();
  });
  it('keeps genuine pre-header network failure in the failure log', async () => {
    const failure = new TypeError('network down');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));
    await expect(api.getChat(WS, CHAT)).rejects.toBe(failure);
    expect(console.error).toHaveBeenCalledWith('[otis:api] network failure before HTTP', expect.any(Object));
  });
  it('rethrows an aborted runs batch instead of returning a partial success', async () => {
    const snapshot = base();
    vi.spyOn(api, 'getChat').mockResolvedValue(snapshot.detail);
    vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: CHAT, messages: snapshot.messages, next_before_sequence: null });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    const controller = new AbortController();
    const started = deferred<void>();
    vi.spyOn(api, 'runs').mockImplementation((_ws, _ids, signal) => new Promise((_, reject) => {
      expect(signal).toBe(controller.signal);
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      started.resolve();
    }));
    const pending = fetchChatSnapshot(WS, CHAT, controller.signal);
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toBe(controller.signal.reason);
  });
  it.each([401, 403])('characterization: run-batch HTTP %i is swallowed as optional metadata failure', async status => {
    const snapshot = base();
    vi.spyOn(api, 'getChat').mockResolvedValue(snapshot.detail);
    vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: CHAT, messages: snapshot.messages, next_before_sequence: null });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(api, 'runs').mockRejectedValue(new ApiError(status, 'forbidden', 'Access lost'));
    const result = await fetchChatSnapshot(WS, CHAT, new AbortController().signal);
    expect(result.messages).toEqual(snapshot.messages);
    expect(result.runs).toEqual({});
  });
});

describe('Snapshot/outbox race and proposed split-query boundary', () => {
  it('current unstaged snapshot replaces an accepted row after its outbox echo is pruned', async () => {
    const queryClient = client();
    const initial = base();
    queryClient.setQueryData(key, initial);
    vi.spyOn(api, 'getChat').mockResolvedValue(initial.detail);
    vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: CHAT, messages: initial.messages, next_before_sequence: null });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    const batch = deferred<{ runs: never[] }>();
    const started = deferred<void>();
    vi.spyOn(api, 'runs').mockImplementation(() => { started.resolve(); return batch.promise; });
    const pending = queryClient.fetchQuery({ queryKey: key, staleTime: 0, queryFn: ({ signal }) => fetchChatSnapshot(WS, CHAT, signal) });
    await started.promise;
    const accepted = patchAccepted(queryClient);
    const patched = queryClient.getQueryData<ChatSnapshot>(key)!;
    expect(patched.messages.some(row => row.id === 'accepted_message')).toBe(true);
    // Equivalent to the production effect after that accepted snapshot renders.
    pruneReconciledEntries(reconciledClientIds(patched.messages));
    expect(entriesForChat(USER, WS, CHAT)).toEqual([]);
    batch.resolve({ runs: [] });
    await pending;
    const final = queryClient.getQueryData<ChatSnapshot>(key)!;
    expect(final.messages.some(row => row.client_message_id === accepted.clientId)).toBe(false);
    expect(deriveTranscript(final.messages, entriesForChat(USER, WS, CHAT), true).messages.map(row => row.id)).toEqual(['old_message']);
  });
  it('counterexample: a separate primary query can still overwrite a manual acceptance', async () => {
    const queryClient = client();
    const initial = base();
    queryClient.setQueryData(key, initial);
    const delayedPrimary = deferred<ChatSnapshot>();
    const pending = queryClient.fetchQuery({ queryKey: key, staleTime: 0, queryFn: () => delayedPrimary.promise });
    patchAccepted(queryClient);
    expect(queryClient.getQueryData<ChatSnapshot>(key)!.messages).toHaveLength(2);
    delayedPrimary.resolve(initial);
    await pending;
    expect(queryClient.getQueryData<ChatSnapshot>(key)!.messages).toHaveLength(1);
  });
  it('negative control: navigation cancellation preserves manual accepted rows in installed TanStack 5.104.1', async () => {
    const queryClient = client();
    queryClient.setQueryData(key, base());
    let signal!: AbortSignal;
    const observer = new QueryObserver(queryClient, {
      queryKey: key, staleTime: 0,
      queryFn: context => { signal = context.signal; return new Promise<ChatSnapshot>(() => {}); },
    });
    const unsubscribe = observer.subscribe(() => {});
    patchAccepted(queryClient);
    unsubscribe();
    expect(signal.aborted).toBe(true);
    expect(queryClient.getQueryData<ChatSnapshot>(key)!.messages).toHaveLength(2);
  });
  it('negative control: cancel-before-patch prevents the stale query return without replacing TanStack', async () => {
    const queryClient = client();
    const initial = base();
    queryClient.setQueryData(key, initial);
    const delayed = deferred<ChatSnapshot>();
    const pending = queryClient.fetchQuery({ queryKey: key, staleTime: 0, queryFn: () => delayed.promise });
    const cancelled = pending.catch(error => { expect(isCancelledError(error)).toBe(true); });
    await queryClient.cancelQueries({ queryKey: key, exact: true });
    patchAccepted(queryClient);
    delayed.resolve(initial);
    await cancelled;
    expect(queryClient.getQueryData<ChatSnapshot>(key)!.messages).toHaveLength(2);
  });
});
