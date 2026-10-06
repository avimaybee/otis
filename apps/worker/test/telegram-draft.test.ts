import { describe, expect, it } from 'vitest';
import {
  createTelegramDraftPreview,
  draftIdForRun,
  sendTelegramMessageDraft,
  TELEGRAM_DRAFT_TEXT_LIMIT,
} from '../src/inbox/telegramDelivery.js';

interface RecordedCall {
  url: string;
  body: Record<string, unknown>;
}

function recordingFetch(responses: Array<{ ok: boolean; status?: number }> = [{ ok: true }]) {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const scripted = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(JSON.stringify({ ok: scripted.ok }), { status: scripted.status ?? (scripted.ok ? 200 : 400) });
  };
  return { calls, fetchFn: fetchFn as typeof fetch };
}

function clock() {
  let now = 1_000_000;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('Telegram draft preview', () => {
  it('derives a stable positive int32 draft ID per run', () => {
    expect(draftIdForRun('run_abc')).toBe(draftIdForRun('run_abc'));
    expect(draftIdForRun('run_abc')).not.toBe(draftIdForRun('run_xyz'));
    for (const id of [draftIdForRun('run_abc'), draftIdForRun('run_xyz'), draftIdForRun('')]) {
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThanOrEqual(0x7fffffff);
    }
  });

  it('posts the exact sendMessageDraft wire shape with truncated text', async () => {
    const { calls, fetchFn } = recordingFetch();
    const ok = await sendTelegramMessageDraft('token', '777002', 42, `x`.repeat(TELEGRAM_DRAFT_TEXT_LIMIT + 100), fetchFn);
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/sendMessageDraft');
    expect(calls[0]!.body).toMatchObject({ chat_id: '777002', draft_id: 42 });
    expect(String(calls[0]!.body['text'])).toHaveLength(TELEGRAM_DRAFT_TEXT_LIMIT);
  });

  it('reports failure without throwing on transport errors and rejections', async () => {
    const throwing = async (): Promise<Response> => { throw new Error('net down'); };
    expect(await sendTelegramMessageDraft('token', '1', 1, 'hi', throwing as typeof fetch)).toBe(false);
    const { fetchFn } = recordingFetch([{ ok: false, status: 400 }]);
    expect(await sendTelegramMessageDraft('token', '1', 1, 'hi', fetchFn)).toBe(false);
  });

  it('coalesces rapid updates to one send per window and skips unchanged text', async () => {
    const { calls, fetchFn } = recordingFetch();
    const time = clock();
    const preview = createTelegramDraftPreview({
      botToken: 'token',
      telegramChatId: '777002',
      runId: 'run_coalesce',
      fetchFn,
      now: time.now,
    })!;
    preview.update(0, 'Hello');
    preview.update(0, 'Hello world');
    preview.update(0, 'Hello world');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body['text']).toBe('Hello');
    time.advance(3000);
    preview.update(0, 'Hello world');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toMatchObject({ draft_id: calls[0]!.body['draft_id'], text: 'Hello world' });
    await preview.stop();
  });

  it('joins multi-round text and clears best-effort on stop without throwing', async () => {
    const { calls, fetchFn } = recordingFetch();
    const time = clock();
    const preview = createTelegramDraftPreview({
      botToken: 'token',
      telegramChatId: '777002',
      runId: 'run_rounds',
      fetchFn,
      now: time.now,
    })!;
    preview.update(1, 'second round');
    preview.update(0, 'first round');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body['text']).toBe('second round');
    time.advance(3000);
    preview.update(1, 'second round');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body['text']).toBe('first roundsecond round');
    await preview.stop();
    expect(calls[calls.length - 1]!.body['text']).toBe('');
    preview.update(0, 'late');
    expect(calls.filter((call) => call.body['text'] === 'late')).toHaveLength(0);
    const failing = createTelegramDraftPreview({
      botToken: 'token',
      telegramChatId: '777002',
      runId: 'run_fail',
      fetchFn: (async () => { throw new Error('net down'); }) as typeof fetch,
      now: time.now,
    })!;
    await expect(failing.stop()).resolves.toBeUndefined();
  });

  it('refuses group chats and non-numeric chat IDs', () => {
    expect(createTelegramDraftPreview({ botToken: 't', telegramChatId: '-100123', runId: 'r' })).toBeNull();
    expect(createTelegramDraftPreview({ botToken: 't', telegramChatId: 'not-a-number', runId: 'r' })).toBeNull();
    expect(createTelegramDraftPreview({ botToken: 't', telegramChatId: '777002', runId: 'r' })).not.toBeNull();
  });
});
