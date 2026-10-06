import { afterEach, describe, expect, it, vi } from 'vitest';
import { processScheduledDailyBriefs } from '../../apps/worker/src/brief/cron.js';
import { api, ApiError } from '../../apps/web/src/api/client.js';
import { createWorkerVoiceAdapter, createWorkerVoiceTransport, type VoiceTransport } from '../../apps/web/src/api/voice.js';
import { appendVoiceChunk, createVoiceSession, deleteVoiceSession, finalizeVoiceSession } from '../../apps/web/src/api/voiceSessions.js';
import { OpenCodeGoAdapter, GO_CHAT_COMPLETIONS_URL } from '../../packages/agent/src/providers/opencode-go.js';
import type { ServerContinuation, TurnInput } from '../../packages/agent/src/providers/types.js';

const storage = vi.hoisted(() => ({ values: new Map<string, unknown>(), reads: [] as string[], deletes: [] as string[] }));
vi.mock('idb-keyval', () => ({
  get: async (key: string) => { storage.reads.push(key); return storage.values.get(key); },
  getMany: async (keys: string[]) => { storage.reads.push(`many:${keys.length}`); return keys.map(key => storage.values.get(key)); },
  set: async (key: string, value: unknown) => { storage.values.set(key, value); },
  update: async (key: string, update: (old: unknown) => unknown) => { storage.values.set(key, update(storage.values.get(key))); },
  del: async (key: string) => { storage.deletes.push(key); storage.values.delete(key); },
  delMany: async (keys: string[]) => { storage.deletes.push(`many:${keys.length}`); for (const key of keys) storage.values.delete(key); },
}));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Expanded audit: fixed behavior (reproductions now prove the cures)', () => {
  it('not-yet-due brief members are evaluated once, then never re-read until due', async () => {
    const calls: string[] = [];
    const stamps = new Map<string, string>();
    const NOW = '2026-10-06T12:00:00.000Z';
    const db = {
      prepare(sql: string) {
        const bound: unknown[] = [];
        const statement = {
          bind: (...values: unknown[]) => {
            bound.push(...values);
            return statement;
          },
          async all() {
            calls.push(sql);
            return { results: Array.from({ length: 17 }, (_, i) => ({ workspace_id: 'audit-brief', user_id: `member-${i}` }))
              .filter(member => {
                const stamp = stamps.get(member.user_id);
                return stamp === undefined || stamp <= NOW;
              }) };
          },
          async first() {
            calls.push(sql);
            if (sql.includes('SELECT 1 AS ok')) return { ok: 1 };
            if (sql.includes('SELECT brief_enabled')) return {
              brief_enabled: 1, brief_local_time: '23:59', brief_timezone: 'UTC',
              brief_weekdays: '[0,1,2,3,4,5,6]', brief_channel: 'web',
            };
            return null;
          },
          async run() {
            calls.push(`RUN ${sql.split(' ').slice(0, 2).join(' ')}`);
            if (sql.startsWith('UPDATE member_settings')) {
              stamps.set(String(bound[3]), String(bound[0]));
            }
            return { success: true };
          },
        };
        return statement;
      },
    };
    const first = await processScheduledDailyBriefs(db as unknown as D1Database, NOW);
    expect(first).toEqual({ evaluated: 17, generated: 0, skipped: 17, errors: 0 });
    // Legacy NULL stamps evaluate once, then park at the coming slot.
    expect(calls.filter(call => call.startsWith('RUN UPDATE'))).toHaveLength(17);
    const second = await processScheduledDailyBriefs(db as unknown as D1Database, NOW);
    expect(second).toEqual({ evaluated: 0, generated: 0, skipped: 0, errors: 0 });
  });

  it.each([
    ['chat', () => api.me(), 31_000],
    ['voice', () => createWorkerVoiceTransport().mediaStatus('audit-ws', 'med_audit'), 46_000],
  ] as const)('%s request deadline stays armed while its body is stalled', async (_name, read, elapsed) => {
    vi.useFakeTimers();
    let releaseBody!: (text: string) => void;
    let signal!: AbortSignal;
    let completed = false;
    const body = new Promise<string>(resolve => { releaseBody = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal!;
      return { ok: true, status: 200, headers: new Headers(), text: () => body } as Response;
    }));
    const pending = read().then(value => { completed = true; return value; });
    await vi.advanceTimersByTimeAsync(elapsed);
    // The deadline fires while the body is still stalled (a signal-ignoring
    // stub cannot simulate the resulting transport rejection, so completion
    // afterwards is a stub artifact, not production behavior).
    expect(signal.aborted).toBe(true);
    expect(completed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    releaseBody('{}');
    await pending;
  });

  it('a committed finalize with a lost response recovers on same-identity retry', async () => {
    let finalizedCalls = 0;
    const createUpload = vi.fn(async () => {
      if (finalizedCalls > 0) {
        throw new ApiError(409, 'upload_already_finalized', 'This recording was already uploaded.', undefined, undefined, { media_id: 'med_audit' });
      }
      return { media: { media_id: 'med_audit' }, upload: { url: '/audit/upload', token: 'fixture' } };
    });
    const putBytes = vi.fn(async () => ({}));
    const finalizeUpload = vi.fn(async () => {
      finalizedCalls += 1;
      if (finalizedCalls === 1) throw new Error('Finalize response lost');
      return { media: { media_id: 'med_audit' } };
    });
    const transport = { createUpload, putBytes, finalizeUpload, mediaStatus: vi.fn() } as unknown as VoiceTransport;
    const adapter = createWorkerVoiceAdapter(transport);
    const request = { userId: 'audit-user', workspaceId: 'audit-ws', chatId: 'audit-chat', clientMessageId: 'stable-voice-id',
      blob: new Blob(['fixture']), mimeType: 'audio/webm', durationMs: 1_000, filename: 'audit.webm' };
    await expect(adapter.upload(request)).rejects.toThrow('Finalize response lost');
    // Same identity meets the finalized claim: bytes are already stored, so
    // recovery finalizes directly instead of retrying a permanent conflict.
    const recovered = await adapter.upload(request);
    expect(recovered.media.media_id).toBe('med_audit');
    expect(createUpload).toHaveBeenCalledTimes(2);
    expect(putBytes).toHaveBeenCalledTimes(1);
    expect(finalizeUpload).toHaveBeenCalledTimes(2);
    expect(transport.mediaStatus).not.toHaveBeenCalled();
  });

  it('a 180-chunk recording finalizes in bounded batch reads and one batch delete', async () => {
    const sessionId = 'audit-voice-chunks';
    await createVoiceSession({ sessionId, userId: 'audit-voice-owner', workspaceId: 'audit-ws', chatId: null, mimeType: 'audio/webm' });
    for (let sequence = 1; sequence <= 180; sequence++) {
      await appendVoiceChunk({ sessionId, sequence, chunk: new Blob(['x']), durationMs: sequence * 1_000 });
    }
    storage.reads.length = 0;
    const result = await finalizeVoiceSession(sessionId);
    expect(result?.blob.size).toBe(180);
    expect(result?.missing).toBe(0);
    // One owner-record read plus six 32-key batch reads instead of 181 serial gets.
    expect(storage.reads).toHaveLength(7);
    expect(storage.reads.filter(key => key.startsWith('many:'))).toHaveLength(6);
    storage.deletes.length = 0;
    await deleteVoiceSession(sessionId);
    expect(storage.deletes).toEqual(['many:180']);
  });

  it('Go continuation history amplifies serialized completed-round checkpoint bytes', async () => {
    const profiles = [];
    for (const rounds of [4, 8]) {
      let call = 0;
      const adapter = new OpenCodeGoAdapter({ apiKey: 'fixture', endpointFamily: 'go-chat-completions', fetchFn: async () => {
        const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${call++}`, function: { name: 'find_entities', arguments: '{"query":"audit"}' } }] }, finish_reason: null }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      } });
      let continuation: ServerContinuation | null = null;
      const completedRounds = [];
      for (let round = 0; round < rounds; round++) {
        const previousCall = continuation?.assistantToolCalls?.[0];
        const input: TurnInput = {
          workspaceId: 'audit-ws', chatId: 'audit-chat', runId: 'audit-run', requestId: `round-${round}`, sessionId: 'audit-chat',
          model: { commandKey: 'mimo-25', provider: 'opencode_go', modelId: 'mimo-v2.5', endpointFamily: 'go-chat-completions', endpointUrl: GO_CHAT_COMPLETIONS_URL },
          messages: [{ role: 'user', text: 'Audit fixture' }], tools: [], maxOutputTokens: 512, timeoutMs: 5_000,
          previousContinuation: continuation,
          pendingToolResults: previousCall ? [{ callId: previousCall.id, name: previousCall.name, arguments: previousCall.arguments, resultText: 'x'.repeat(4_096) }] : [],
        };
        for await (const event of adapter.streamTurn(input)) {
          if (event.type === 'error') throw new Error(event.error.message);
          if (event.type === 'finish') continuation = event.continuation;
        }
        completedRounds.push({ roundIndex: round, assistantCalls: continuation!.assistantToolCalls,
          toolResults: [{ resultText: 'x'.repeat(4_096) }], continuation });
      }
      const compact = completedRounds.map(item => ({ ...item, continuation: { kind: item.continuation!.kind, assistantToolCalls: item.continuation!.assistantToolCalls } }));
      const expandedBytes = JSON.stringify(completedRounds).length;
      const compactBytes = JSON.stringify(compact).length;
      profiles.push({ rounds, toolResultChars: 4_096, expandedBytes, compactBytes });
      if (rounds === 8) expect(expandedBytes).toBeGreaterThan(compactBytes * 3);
    }
    expect(profiles).toMatchSnapshot('checkpoint byte comparison');
  });
});
