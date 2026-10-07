/** @vitest-environment happy-dom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchChatSnapshot } from '../src/api/snapshot.js';
import { api } from '../src/api/client.js';

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
