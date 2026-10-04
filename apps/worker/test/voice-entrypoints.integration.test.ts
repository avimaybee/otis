/**
 * Voice entrypoint integration (Gate 010 wiring).
 *
 * Proves the integration-owned surface only:
 *   1. `handleVoiceMediaRoute` is mounted once through the production fetch
 *      entrypoint, behind the shared auth and error boundaries.
 *   2. A queue wake-up for a workspace whose voice run is parked on its
 *      transcription receipt advances the due job and answers in the same
 *      tick (no cron), with a synthetic STT transport and scripted handler.
 *   3. A still-pending transcript schedules a prompt continuation instead of
 *      waiting for the five-minute cron sweep.
 *   4. Cron recovers due transcription work, dispatches the run and applies
 *      the bounded retention cleanup.
 *   5. Ordinary text dispatch through the queue keeps working unchanged.
 *
 * Real workerd D1/R2 with migration 0012; no live provider and no network.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { AUTH_BOUNDS } from '@otis/contracts';
import type { FetchFn } from '@otis/agent';
import {
  base64UrlEncode,
  importWrappingKey,
  recordVoiceFormatEvidence,
  setWorkspaceCredential,
  setWorkspaceVoiceSettings,
} from '@otis/identity';
import type { Env } from '../src/index.js';
import worker from '../src/index.js';
import type { TurnHandler } from '../src/actor/dispatch.js';
import { acceptWebMessage } from '../src/inbox/repository.js';
import { createValidatedMedia } from '../src/media/repository.js';
import { applyMigrations } from './migrations.js';
import { oggOpus } from './media-fixtures.js';

const E = env as unknown as Env;
const BASE = 'http://localhost';
const WS = 'ws_voice_entry';
const AVI = 'usr_voice_entry_avi';
const CHAT = 'chat_voice_entry_avi';
const GROQ_KEY = 'gsk_voice_entry_synthetic';
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const CTX = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

let mediaSeq = 0;

interface SentMessage {
  body: unknown;
  options: { delaySeconds?: number } | undefined;
}

function fakeDispatchQueue(): { sent: SentMessage[]; queue: Queue } {
  const sent: SentMessage[] = [];
  const queue = {
    send: async (body: unknown, options?: { delaySeconds?: number }) => {
      sent.push({ body, options });
    },
  } as unknown as Queue;
  return { sent, queue };
}

function scriptedHandler(replyText: string): TurnHandler & { seen: string[] } {
  const seen: string[] = [];
  return {
    name: 'voice-entry-script',
    seen,
    async runTurn(ctx) {
      seen.push(ctx.sourceText);
      return { kind: 'completed', replyText };
    },
  };
}

function fakeStt(transcript: string): { calls: string[]; fetchFn: FetchFn } {
  const calls: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ text: transcript, language: 'en', duration: 2.5 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchFn };
}

function rateLimitedStt(retryAfterSeconds: number): { calls: string[]; fetchFn: FetchFn } {
  const calls: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) },
    });
  };
  return { calls, fetchFn };
}

async function prepareVoiceMessage(): Promise<{ runId: string; mediaId: string }> {
  mediaSeq += 1;
  const mediaId = `med_entry_${mediaSeq}`;
  const objectKey = `workspace/${WS}/media/${mediaId}`;
  const bytes = oggOpus(2);
  const nowIso = new Date().toISOString();
  await E.STORAGE!.put(objectKey, bytes, { httpMetadata: { contentType: 'audio/ogg' } });
  await createValidatedMedia(E.DB, {
    mediaId,
    workspaceId: WS,
    chatId: CHAT,
    uploaderUserId: AVI,
    format: 'audio/ogg',
    contentType: 'audio/ogg',
    byteSize: bytes.byteLength,
    durationMs: 2000,
    objectKey,
    nowIso,
  });
  const accepted = await acceptWebMessage(E.DB, {
    workspaceId: WS,
    chatId: CHAT,
    userId: AVI,
    clientMessageId: `cm_voice_entry_${mediaSeq}`,
    text: '',
    mediaId,
  });
  return { runId: accepted.run_id, mediaId };
}

async function runStatus(runId: string): Promise<string | undefined> {
  const row = await E.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`).bind(runId).first<{ status: string }>();
  return row?.status;
}

async function replyText(runId: string): Promise<string | undefined> {
  const row = await E.DB
    .prepare(`SELECT content_text FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`)
    .bind(runId)
    .first<{ content_text: string }>();
  return row?.content_text;
}

beforeAll(async () => {
  await applyMigrations(E.DB);
  E.ENVIRONMENT = 'test';
  const keyBytes = new Uint8Array(32);
  crypto.getRandomValues(keyBytes);
  E.CREDENTIALS_KEY = base64UrlEncode(keyBytes);
  const wrappingKey = await importWrappingKey(E.CREDENTIALS_KEY);

  const now = new Date().toISOString();
  await E.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(AVI, 'fb_voice_entry', 'voice.entry@kerning.test', 'Voice Entry Avi', now, now)
    .run();
  await E.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
     VALUES (?, 'Voice Entry WS', ?, 0, 1, ?, ?)`,
  )
    .bind(WS, AVI, now, now)
    .run();
  await E.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)`,
  )
    .bind(WS, AVI, now, now, now)
    .run();
  await E.DB.prepare(
    `INSERT INTO chats (id, workspace_id, author_user_id, title, model_override, is_archived, activity_cursor, created_at, updated_at, last_activity_at)
     VALUES (?, ?, ?, 'Voice Entry Chat', NULL, 0, 0, ?, ?, ?)`,
  )
    .bind(CHAT, WS, AVI, now, now, now)
    .run();
  await E.DB.prepare(
    `INSERT INTO workspace_settings (workspace_id, default_model, created_at, updated_at) VALUES (?, 'mimo-25', ?, ?)`,
  )
    .bind(WS, now, now)
    .run();
  await E.DB.prepare(
    `INSERT INTO provider_credentials (workspace_id, provider, encrypted_key, key_nonce, key_version, status, last_verified_at, created_at, updated_at)
     VALUES (?, 'opencode_go', 'synthetic-test-only', 'synthetic', 1, 'available', ?, ?, ?)`,
  )
    .bind(WS, now, now, now)
    .run();
  await setWorkspaceCredential(E.DB, {
    workspaceId: WS,
    provider: 'groq',
    rawKey: GROQ_KEY,
    wrappingKey,
    keyVersion: 1,
    actorUserId: AVI,
  });
  await E.DB.prepare(`UPDATE provider_credentials SET status = 'available' WHERE workspace_id = ? AND provider = 'groq'`)
    .bind(WS)
    .run();
  await setWorkspaceVoiceSettings(E.DB, {
    workspaceId: WS,
    actorUserId: AVI,
    input: { enabled: true, model: 'whisper-large-v3-turbo' },
  });
  await recordVoiceFormatEvidence(E.DB, {
    workspaceId: WS,
    actorUserId: AVI,
    format: 'audio/ogg',
    model: 'whisper-large-v3-turbo',
  });
});

beforeEach(() => {
  E.TRANSCRIPTION_TEST_FETCH = undefined;
  E.DISPATCH_TEST_HANDLER = undefined;
  E.DISPATCH_QUEUE = undefined;
});

describe('voice entrypoints (workerd)', () => {
  it('mounts the voice media dispatcher once behind the entrypoint auth boundary', async () => {
    const methodNotAllowed = await worker.fetch(
      new Request(`${BASE}/api/workspaces/${WS}/media/uploads`, { method: 'PUT' }),
      E,
      CTX,
    );
    expect(methodNotAllowed.status).toBe(405);

    const anonymousClaim = await worker.fetch(
      new Request(`${BASE}/api/workspaces/${WS}/media/uploads`, {
        method: 'POST',
        headers: {
          origin: BASE,
          [AUTH_BOUNDS.CSRF_HEADER]: '1',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
      E,
      CTX,
    );
    expect(anonymousClaim.status).toBe(401);

    const anonymousStatus = await worker.fetch(
      new Request(`${BASE}/api/workspaces/${WS}/media/med_entry_x/status`),
      E,
      CTX,
    );
    expect(anonymousStatus.status).toBe(401);

    const anonymousVoiceSettings = await worker.fetch(
      new Request(`${BASE}/api/workspaces/${WS}/voice/settings`),
      E,
      CTX,
    );
    expect(anonymousVoiceSettings.status).toBe(401);

    const unknownApi = await worker.fetch(new Request(`${BASE}/api/workspaces/${WS}/not-a-surface`), E, CTX);
    expect(unknownApi.status).toBe(404);
    const unknownBody = (await unknownApi.json()) as { error?: { code?: string } };
    expect(unknownBody.error?.code).toBe('not_found');
  });

  it('advances a due voice transcription on a queue wake-up and answers in the same tick', async () => {
    const prepared = await prepareVoiceMessage();
    const stt = fakeStt('Ask Avi about the Friday boiler service');
    E.TRANSCRIPTION_TEST_FETCH = stt.fetchFn;
    const handler = scriptedHandler('Noted - Friday boiler service.');
    E.DISPATCH_TEST_HANDLER = handler;
    const { sent, queue } = fakeDispatchQueue();
    E.DISPATCH_QUEUE = queue;

    await worker.queue(
      { messages: [{ body: { workspace_id: WS } }] } as unknown as Parameters<typeof worker.queue>[0],
      E,
    );

    expect(stt.calls).toEqual([GROQ_ENDPOINT]);
    const job = await E.DB
      .prepare(`SELECT state, transcript_text FROM media_transcriptions WHERE media_id = ?`)
      .bind(prepared.mediaId)
      .first<{ state: string; transcript_text: string }>();
    expect(job?.state).toBe('ready');
    expect(job?.transcript_text).toContain('Friday boiler service');

    expect(await runStatus(prepared.runId)).toBe('succeeded');
    expect(handler.seen).toHaveLength(1);
    expect(handler.seen[0]).toContain('Friday boiler service');
    expect(await replyText(prepared.runId)).toContain('Friday boiler service.');
    // The receipt committed inside the wake-up: no continuation was needed.
    expect(sent).toHaveLength(0);
  });

  it('keeps ordinary text dispatch behavior through the queue entrypoint', async () => {
    const accepted = await acceptWebMessage(E.DB, {
      workspaceId: WS,
      chatId: CHAT,
      userId: AVI,
      clientMessageId: `cm_voice_entry_text_${Date.now()}`,
      text: 'Plain text turn',
    });
    const handler = scriptedHandler('Text answered.');
    E.DISPATCH_TEST_HANDLER = handler;
    const { sent, queue } = fakeDispatchQueue();
    E.DISPATCH_QUEUE = queue;

    await worker.queue(
      { messages: [{ body: { workspace_id: WS } }] } as unknown as Parameters<typeof worker.queue>[0],
      E,
    );

    expect(await runStatus(accepted.run_id)).toBe('succeeded');
    expect(handler.seen).toEqual(['Plain text turn']);
    expect(await replyText(accepted.run_id)).toContain('Text answered.');
    expect(sent).toHaveLength(0);
  });

  it('cron recovers due transcription work and applies the retention sweep', async () => {
    const prepared = await prepareVoiceMessage();
    const stt = fakeStt('Book the boiler service for Friday');
    E.TRANSCRIPTION_TEST_FETCH = stt.fetchFn;
    const handler = scriptedHandler('Cron answered.');
    E.DISPATCH_TEST_HANDLER = handler;

    const now = new Date().toISOString();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const expiredKey = `workspace/${WS}/media/med_entry_expired`;
    const abandonedKey = `workspace/${WS}/media/med_entry_abandoned`;
    await E.STORAGE!.put(expiredKey, oggOpus(2));
    await E.STORAGE!.put(abandonedKey, oggOpus(2));
    await E.DB.prepare(
      `INSERT INTO media_objects
         (id, workspace_id, chat_id, uploader_user_id, state, object_key, content_type, format,
          byte_size, duration_ms, upload_completed_at, validated_at, expires_at, created_at, updated_at)
       VALUES ('med_entry_expired', ?, ?, ?, 'validated', ?, 'audio/ogg', 'audio/ogg', 4096, 2000, ?, ?, ?, ?, ?)`,
    )
      .bind(WS, CHAT, AVI, expiredKey, past, past, past, now, now)
      .run();
    await E.DB.prepare(
      `INSERT INTO media_objects
         (id, workspace_id, chat_id, uploader_user_id, state, object_key, content_type, format,
          byte_size, duration_ms, upload_token_expires_at, expires_at, created_at, updated_at)
       VALUES ('med_entry_abandoned', ?, ?, ?, 'quarantine', ?, 'audio/ogg', 'audio/ogg', 4096, 2000, ?, ?, ?, ?)`,
    )
      .bind(WS, CHAT, AVI, abandonedKey, past, future, now, now)
      .run();

    await worker.scheduled({} as ScheduledEvent, E, CTX);

    expect(stt.calls).toEqual([GROQ_ENDPOINT]);
    expect(await runStatus(prepared.runId)).toBe('succeeded');
    expect(await replyText(prepared.runId)).toContain('Cron answered.');

    const expired = await E.DB.prepare(`SELECT state FROM media_objects WHERE id = 'med_entry_expired'`)
      .first<{ state: string }>();
    expect(expired?.state).toBe('expired');
    expect(await E.STORAGE!.get(expiredKey)).toBeNull();

    const abandoned = await E.DB.prepare(`SELECT state FROM media_objects WHERE id = 'med_entry_abandoned'`)
      .first<{ state: string }>();
    expect(abandoned?.state).toBe('deleted');
    expect(await E.STORAGE!.get(abandonedKey)).toBeNull();
  });

  it('wakes once at the durable retry instant after a rate-limited attempt, without polling', async () => {
    const prepared = await prepareVoiceMessage();
    const limited = rateLimitedStt(30);
    E.TRANSCRIPTION_TEST_FETCH = limited.fetchFn;
    const handler = scriptedHandler('Retry answered.');
    E.DISPATCH_TEST_HANDLER = handler;
    const { sent, queue } = fakeDispatchQueue();
    E.DISPATCH_QUEUE = queue;

    // First wake-up makes one provider attempt; Retry-After: 30 must produce
    // exactly one delayed intent at that durable due instant, never a loop.
    await worker.queue(
      { messages: [{ body: { workspace_id: WS } }] } as unknown as Parameters<typeof worker.queue>[0],
      E,
    );

    expect(limited.calls).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ workspace_id: WS });
    const firstDelay = sent[0]!.options?.delaySeconds ?? 0;
    expect(firstDelay).toBeGreaterThanOrEqual(25);
    expect(firstDelay).toBeLessThanOrEqual(30);
    expect(await runStatus(prepared.runId)).toBe('queued');
    const job = await E.DB
      .prepare(`SELECT state, next_attempt_at FROM media_transcriptions WHERE media_id = ?`)
      .bind(prepared.mediaId)
      .first<{ state: string; next_attempt_at: string | null }>();
    expect(job?.state).toBe('pending');
    expect(job?.next_attempt_at).toBeTruthy();

    // An early duplicate wake-up before the due instant must not redispatch
    // the provider and must not emit another delayed intent.
    await worker.queue(
      { messages: [{ body: { workspace_id: WS } }] } as unknown as Parameters<typeof worker.queue>[0],
      E,
    );
    expect(limited.calls).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(await runStatus(prepared.runId)).toBe('queued');

    // At the due instant the single scheduled wake retries the job once and
    // the run answers in that same tick.
    await E.DB.prepare(`UPDATE media_transcriptions SET next_attempt_at = ? WHERE media_id = ?`)
      .bind(new Date(Date.now() - 1000).toISOString(), prepared.mediaId)
      .run();
    const success = fakeStt('The boiler service is booked');
    E.TRANSCRIPTION_TEST_FETCH = success.fetchFn;
    await worker.queue(
      { messages: [{ body: { workspace_id: WS } }] } as unknown as Parameters<typeof worker.queue>[0],
      E,
    );

    expect(success.calls).toHaveLength(1);
    expect(await runStatus(prepared.runId)).toBe('succeeded');
    expect(await replyText(prepared.runId)).toContain('Retry answered.');
    expect(sent).toHaveLength(1);
  });

  it('does not schedule a wake while a voice transcript attempt is in flight', async () => {
    const prepared = await prepareVoiceMessage();
    const { sent, queue } = fakeDispatchQueue();
    E.DISPATCH_QUEUE = queue;

    await worker.queue(
      { messages: [{ body: { workspace_id: WS } }] } as unknown as Parameters<typeof worker.queue>[0],
      E,
    );

    // No synthetic transport in a test runtime: the job stays pending and no
    // provider is dialed. The run is not polled; the durable retry instant or
    // the cron sweep wakes it, never a fixed short loop.
    expect(await runStatus(prepared.runId)).toBe('queued');
    const job = await E.DB
      .prepare(`SELECT state FROM media_transcriptions WHERE media_id = ?`)
      .bind(prepared.mediaId)
      .first<{ state: string }>();
    expect(job?.state).toBe('pending');
    expect(sent).toHaveLength(0);
  });
});
