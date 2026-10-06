import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import { AUTH_BOUNDS, VOICE_BOUNDS } from '@otis/contracts';
import {
  NATIVE_AUDIO_TRANSCRIPTION_IMPLEMENTED,
  type FetchFn,
  type ModelEntry,
  type ProviderAdapter,
  type ProviderEvent,
  type TurnInput,
} from '@otis/agent';
import {
  base64UrlEncode,
  importWrappingKey,
  recordVoiceFormatEvidence,
  setWorkspaceCredential,
  setWorkspaceVoiceSettings,
  sha256,
} from '@otis/identity';
import type { Env } from '../src/index.js';
import { EchoHandler, dispatchOutboxItem, stopRun } from '../src/actor/dispatch.js';
import { AgentHandler } from '../src/agent/handler.js';
import { acceptWebMessage } from '../src/inbox/repository.js';
import { acceptTelegramInbound } from '../src/inbox/telegram.js';
import { cleanupExpiredMedia } from '../src/media/cleanup.js';
import { handleVoiceMediaRoute } from '../src/media/routes.js';
import { processTranscriptionJobs } from '../src/media/transcription.js';
import { resolveVoiceRouteForWorkspace } from '../src/providers/service.js';
import { handleListModels } from '../src/routes/commands.js';
import { mp4WithDuration, oggOpus, webmMagic, webmLiveClusters } from './media-fixtures.js';

const E = env as unknown as Env;
const BASE = 'http://localhost';
const WS = 'ws_voice';
const WS_OTHER = 'ws_voice_other';
const WS_NO_KEY = 'ws_voice_nokey';
const WS_VERIFY = 'ws_voice_verify';
const AVI = 'usr_voice_avi';
const HUNOR = 'usr_voice_hunor';
const OTHER = 'usr_voice_other';
const CHAT = 'chat_voice_avi';
const GROQ_KEY = 'gsk_voice_synthetic_test_key';
const OPENCODE_KEY_PLACEHOLDER = 'synthetic-test-only';

let aviCookie = '';
let hunorCookie = '';
let otherCookie = '';
let wrappingKey: CryptoKey;

function csrfHeaders(cookie: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    origin: BASE,
    [AUTH_BOUNDS.CSRF_HEADER]: '1',
    cookie,
    ...extra,
  };
}

async function seedSession(id: string, rawToken: string, userId: string): Promise<string> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
  await E.DB.prepare(
    `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(id, await sha256(rawToken), userId, now, expiresAt, now)
    .run();
  return `${AUTH_BOUNDS.COOKIE_NAME}=${rawToken}`;
}

async function ensureChat(chatId: string, workspaceId: string, authorId: string): Promise<void> {
  const now = new Date().toISOString();
  await E.DB.prepare(
    `INSERT OR IGNORE INTO chats (id, workspace_id, author_user_id, title, model_override, is_archived, activity_cursor, created_at, updated_at, last_activity_at)
     VALUES (?, ?, ?, 'Voice test', NULL, 0, 0, ?, ?, ?)`,
  )
    .bind(chatId, workspaceId, authorId, now, now, now)
    .run();
}

interface ClaimedUpload {
  mediaId: string;
  uploadUrl: string;
  uploadToken: string;
  state: string;
}

async function createClaim(params: {
  cookie: string;
  workspaceId?: string;
  chatId?: string;
  clientMessageId: string;
  contentType?: string;
  byteSize?: number;
  durationMs?: number;
}): Promise<{ response: Response; body: Record<string, unknown> | null }> {
  const workspaceId = params.workspaceId ?? WS;
  const response = await handleVoiceMediaRoute(
    new Request(`${BASE}/api/workspaces/${workspaceId}/media/uploads`, {
      method: 'POST',
      headers: csrfHeaders(params.cookie, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        chat_id: params.chatId ?? CHAT,
        client_message_id: params.clientMessageId,
        content_type: params.contentType ?? 'audio/ogg',
        byte_size: params.byteSize ?? 4096,
        duration_ms: params.durationMs ?? 2000,
      }),
    }),
    E,
    'req-test',
  );
  const body = response ? ((await response.clone().json()) as Record<string, unknown>) : null;
  return { response: response!, body };
}

async function claimValidUpload(params: {
  cookie: string;
  workspaceId?: string;
  chatId?: string;
  clientMessageId: string;
  contentType?: string;
  bytes: Uint8Array;
  durationMs?: number;
}): Promise<ClaimedUpload> {
  const contentType = params.contentType ?? 'audio/ogg';
  const claim = await createClaim({
    cookie: params.cookie,
    ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
    ...(params.chatId ? { chatId: params.chatId } : {}),
    clientMessageId: params.clientMessageId,
    contentType,
    byteSize: params.bytes.byteLength,
    durationMs: params.durationMs ?? 2000,
  });
  expect(claim.response.status).toBe(201);
  const media = claim.body!['media'] as Record<string, unknown>;
  const upload = claim.body!['upload'] as Record<string, unknown>;
  const workspaceId = params.workspaceId ?? WS;
  const put = await handleVoiceMediaRoute(
    new Request(`${BASE}${String(upload['url'])}`, {
      method: 'PUT',
      headers: csrfHeaders(params.cookie, {
        'x-otis-upload-token': String(upload['token']),
        'content-type': 'application/octet-stream',
      }),
      body: params.bytes,
    }),
    E,
    'req-test',
  );
  expect(put!.status).toBe(200);
  const finalize = await handleVoiceMediaRoute(
    new Request(`${BASE}/api/workspaces/${workspaceId}/media/uploads/${String(media['media_id'])}/finalize`, {
      method: 'POST',
      headers: csrfHeaders(params.cookie),
    }),
    E,
    'req-test',
  );
  expect(finalize!.status).toBe(200);
  const finalizeBody = (await finalize!.json()) as { media: { state: string } };
  return {
    mediaId: String(media['media_id']),
    uploadUrl: String(upload['url']),
    uploadToken: String(upload['token']),
    state: finalizeBody.media.state,
  };
}

function fakeGroq(handler: (call: number) => Response | Promise<Response>) {
  const calls: Array<{ url: string; authorization: string | null; model: string | null; filename: string | null }> = [];
  let count = 0;
  const fn = async (url: string, init: RequestInit): Promise<Response> => {
    count += 1;
    const headers = new Headers(init.headers);
    const form = init.body as FormData;
    const file = form.get('file') as File;
    calls.push({
      url,
      authorization: headers.get('authorization'),
      model: typeof form.get('model') === 'string' ? String(form.get('model')) : null,
      filename: file?.name ?? null,
    });
    return handler(count);
  };
  return { fn, calls };
}

function transcriptResponse(text: string, language = 'ro'): Response {
  return new Response(JSON.stringify({ text, language, duration: 2.5 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function prepareVoiceMessage(params: {
  clientMessageId: string;
  chatId?: string;
  durationSeconds?: number;
  contentType?: string;
}): Promise<{ mediaId: string; runId: string; jobId: string; outboxId: string }> {
  const chatId = params.chatId ?? CHAT;
  await ensureChat(chatId, WS, AVI);
  const bytes = oggOpus(params.durationSeconds ?? 2);
  const upload = await claimValidUpload({
    cookie: aviCookie,
    chatId,
    clientMessageId: params.clientMessageId,
    bytes,
    contentType: params.contentType ?? 'audio/ogg',
    durationMs: (params.durationSeconds ?? 2) * 1000,
  });
  expect(upload.state).toBe('validated');
  const accepted = await acceptWebMessage(E.DB, {
    workspaceId: WS,
    chatId,
    userId: AVI,
    clientMessageId: params.clientMessageId,
    text: '',
    mediaId: upload.mediaId,
  });
  const job = await E.DB.prepare(`SELECT id, state FROM media_transcriptions WHERE media_id = ?`)
    .bind(upload.mediaId)
    .first<{ id: string; state: string }>();
  expect(job?.state).toBe('pending');
  const outbox = await E.DB.prepare(
    `SELECT id FROM outbox WHERE workspace_id = ? AND json_extract(payload_json, '$.run_id') = ?`,
  )
    .bind(WS, accepted.run_id)
    .first<{ id: string }>();
  return { mediaId: upload.mediaId, runId: accepted.run_id, jobId: String(job!.id), outboxId: String(outbox!.id) };
}

beforeAll(async () => {
  await applyMigrations(E.DB);
  env.ENVIRONMENT = 'test';
  const keyBytes = new Uint8Array(32);
  crypto.getRandomValues(keyBytes);
  env.CREDENTIALS_KEY = base64UrlEncode(keyBytes);
  wrappingKey = await importWrappingKey(env.CREDENTIALS_KEY!);

  const now = new Date().toISOString();
  for (const [id, uid, email, name] of [
    [AVI, 'fb_voice_avi', 'avi.voice@kerning.test', 'Avi'],
    [HUNOR, 'fb_voice_hunor', 'hunor.voice@kerning.test', 'Hunor'],
    [OTHER, 'fb_voice_other', 'other.voice@kerning.test', 'Other'],
  ] as const) {
    await E.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, uid, email, name, now, now)
      .run();
  }
  for (const [workspaceId, name, ownerId] of [
    [WS, 'Voice WS', AVI],
    [WS_OTHER, 'Voice Other', OTHER],
    [WS_NO_KEY, 'Voice No Key', AVI],
    [WS_VERIFY, 'Voice Verify', AVI],
  ] as const) {
    await E.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
       VALUES (?, ?, ?, 0, 1, ?, ?)`,
    )
      .bind(workspaceId, name, ownerId, now, now)
      .run();
  }
  for (const [workspaceId, userId, role] of [
    [WS, AVI, 'owner'],
    [WS, HUNOR, 'member'],
    [WS_OTHER, OTHER, 'owner'],
    [WS_NO_KEY, AVI, 'owner'],
    [WS_VERIFY, AVI, 'owner'],
  ] as const) {
    await E.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(workspaceId, userId, role, now, now, now)
      .run();
  }
  await ensureChat(CHAT, WS, AVI);
  await ensureChat('chat_voice_other', WS_OTHER, OTHER);
  await ensureChat('chat_voice_nokey', WS_NO_KEY, AVI);
  await ensureChat('chat_voice_verify', WS_VERIFY, AVI);

  for (const workspaceId of [WS, WS_OTHER, WS_NO_KEY, WS_VERIFY]) {
    await E.DB.prepare(
      `INSERT INTO workspace_settings (workspace_id, default_model, created_at, updated_at) VALUES (?, 'mimo-25', ?, ?)`,
    )
      .bind(workspaceId, now, now)
      .run();
    await E.DB.prepare(
      `INSERT INTO provider_credentials (workspace_id, provider, encrypted_key, key_nonce, key_version, status, last_verified_at, created_at, updated_at)
       VALUES (?, 'opencode_go', ?, 'synthetic', 1, 'available', ?, ?, ?)`,
    )
      .bind(workspaceId, OPENCODE_KEY_PLACEHOLDER, now, now, now)
      .run();
  }

  // Real encrypted Groq credential for WS and the verification workspace;
  // WS_NO_KEY deliberately has none.
  for (const workspaceId of [WS, WS_VERIFY]) {
    await setWorkspaceCredential(E.DB, {
      workspaceId,
      provider: 'groq',
      rawKey: GROQ_KEY,
      wrappingKey,
      keyVersion: 1,
      actorUserId: AVI,
    });
    await E.DB.prepare(`UPDATE provider_credentials SET status = 'available' WHERE workspace_id = ? AND provider = 'groq'`)
      .bind(workspaceId)
      .run();
  }

  for (const workspaceId of [WS, WS_NO_KEY, WS_VERIFY]) {
    await setWorkspaceVoiceSettings(E.DB, {
      workspaceId,
      actorUserId: AVI,
      input: { enabled: true, model: 'whisper-large-v3-turbo' },
    });
  }
  // Server-recorded evidence only: the same mutation the verify route performs.
  for (const format of ['audio/webm', 'audio/mp4', 'audio/ogg'] as const) {
    await recordVoiceFormatEvidence(E.DB, { workspaceId: WS, actorUserId: AVI, format, model: 'whisper-large-v3-turbo' });
  }
  await recordVoiceFormatEvidence(E.DB, { workspaceId: WS_NO_KEY, actorUserId: AVI, format: 'audio/ogg', model: 'whisper-large-v3-turbo' });

  aviCookie = await seedSession('sess_voice_avi', 'tok_voice_avi', AVI);
  hunorCookie = await seedSession('sess_voice_hunor', 'tok_voice_hunor', HUNOR);
  otherCookie = await seedSession('sess_voice_other', 'tok_voice_other', OTHER);
});

describe('voice media integration (workerd)', () => {
  it('requires an authenticated workspace member and the chat author for claims', async () => {
    const anonymous = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/media/uploads`, {
        method: 'POST',
        headers: { origin: BASE, [AUTH_BOUNDS.CSRF_HEADER]: '1', 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT, client_message_id: 'cm_auth_1', content_type: 'audio/ogg', byte_size: 4096, duration_ms: 2000 }),
      }),
      E,
      'req-test',
    );
    expect(anonymous!.status).toBe(401);

    const nonAuthor = await createClaim({ cookie: hunorCookie, clientMessageId: 'cm_auth_2' });
    expect(nonAuthor.response.status).toBe(403);

    const outOfScope = await createClaim({
      cookie: otherCookie,
      workspaceId: WS,
      clientMessageId: 'cm_auth_3',
    });
    expect(outOfScope.response.status).toBe(404);

    const status = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/media/med_missing/status`),
      E,
      'req-test',
    );
    expect(status!.status).toBe(401);
  });

  it('rejects over-limit and unsupported claims before any bytes move', async () => {
    const tooBig = await createClaim({
      cookie: aviCookie,
      clientMessageId: 'cm_limit_bytes',
      byteSize: VOICE_BOUNDS.MAX_BYTES + 1,
    });
    expect(tooBig.response.status).toBe(422);

    const tooLong = await createClaim({
      cookie: aviCookie,
      clientMessageId: 'cm_limit_duration',
      durationMs: VOICE_BOUNDS.MAX_DURATION_SECONDS * 1000 + 1,
    });
    expect(tooLong.response.status).toBe(422);

    const badFormat = await createClaim({
      cookie: aviCookie,
      clientMessageId: 'cm_limit_format',
      contentType: 'audio/flac',
    });
    expect(badFormat.response.status).toBe(422);

    const noMediaRows = await E.DB.prepare(
      `SELECT COUNT(*) AS n FROM media_objects WHERE workspace_id = ? AND object_key LIKE '%cm_limit%'`,
    )
      .bind(WS)
      .first<{ n: number }>();
    expect(Number(noMediaRows?.n ?? 0)).toBe(0);
  });

  it('validates actual container bytes, deletes mismatched quarantine and rejects real over-duration audio', async () => {
    const mismatchClaim = await createClaim({
      cookie: aviCookie,
      clientMessageId: 'cm_mismatch',
      contentType: 'audio/ogg',
      byteSize: webmMagic().byteLength,
      durationMs: 2000,
    });
    expect(mismatchClaim.response.status).toBe(201);
    const mismatchMedia = mismatchClaim.body!['media'] as Record<string, unknown>;
    const mismatchUpload = mismatchClaim.body!['upload'] as Record<string, unknown>;
    const mismatchId = String(mismatchMedia['media_id']);
    const putMismatch = await handleVoiceMediaRoute(
      new Request(`${BASE}${String(mismatchUpload['url'])}`, {
        method: 'PUT',
        headers: csrfHeaders(aviCookie, {
          'x-otis-upload-token': String(mismatchUpload['token']),
          'content-type': 'application/octet-stream',
        }),
        body: webmMagic(),
      }),
      E,
      'req-test',
    );
    expect(putMismatch!.status).toBe(422);
    const mismatchRow = await E.DB.prepare(`SELECT state FROM media_objects WHERE id = ?`)
      .bind(mismatchId)
      .first<{ state: string }>();
    expect(mismatchRow?.state).toBe('rejected');
    expect(await E.STORAGE!.head(`workspace/${WS}/media/${mismatchId}`)).toBeNull();

    const overDurationClaim = await createClaim({
      cookie: aviCookie,
      clientMessageId: 'cm_over_duration',
      contentType: 'audio/ogg',
      byteSize: oggOpus(200).byteLength,
      durationMs: 2000,
    });
    const overDurationMedia = overDurationClaim.body!['media'] as Record<string, unknown>;
    const overDurationUpload = overDurationClaim.body!['upload'] as Record<string, unknown>;
    const overDurationId = String(overDurationMedia['media_id']);
    const putOver = await handleVoiceMediaRoute(
      new Request(`${BASE}${String(overDurationUpload['url'])}`, {
        method: 'PUT',
        headers: csrfHeaders(aviCookie, {
          'x-otis-upload-token': String(overDurationUpload['token']),
          'content-type': 'application/octet-stream',
        }),
        body: oggOpus(200),
      }),
      E,
      'req-test',
    );
    expect(putOver!.status).toBe(422);
    expect((await putOver!.json() as { error: { code: string } }).error.code).toBe('duration_limit');
    expect(await E.STORAGE!.head(`workspace/${WS}/media/${overDurationId}`)).toBeNull();
  });

  it('rejects containers whose actual duration cannot be verified from the bytes', async () => {
    const magicOnly = webmMagic();
    const claim = await createClaim({
      cookie: aviCookie,
      clientMessageId: 'cm_duration_unverified',
      contentType: 'audio/webm',
      byteSize: magicOnly.byteLength,
      durationMs: 2000,
    });
    expect(claim.response.status).toBe(201);
    const media = claim.body!['media'] as Record<string, unknown>;
    const upload = claim.body!['upload'] as Record<string, unknown>;
    const mediaId = String(media['media_id']);
    const put = await handleVoiceMediaRoute(
      new Request(`${BASE}${String(upload['url'])}`, {
        method: 'PUT',
        headers: csrfHeaders(aviCookie, {
          'x-otis-upload-token': String(upload['token']),
          'content-type': 'application/octet-stream',
        }),
        body: magicOnly,
      }),
      E,
      'req-test',
    );
    expect(put!.status).toBe(422);
    expect((await put!.json() as { error: { code: string } }).error.code).toBe('duration_unverified');
    const row = await E.DB.prepare(`SELECT state FROM media_objects WHERE id = ?`)
      .bind(mediaId)
      .first<{ state: string }>();
    expect(row?.state).toBe('rejected');
    expect(await E.STORAGE!.head(`workspace/${WS}/media/${mediaId}`)).toBeNull();
  });

  it('enforces the three-minute cap on real MediaRecorder containers, not declared metadata', async () => {
    // Chrome/Android MediaRecorder WebM: no Info Duration, unknown-size
    // Segment, forged small declared duration. The cluster timecodes show
    // 200 seconds, so the upload is rejected and its bytes deleted.
    const overWebm = webmLiveClusters(200_000);
    const overClaim = await createClaim({
      cookie: aviCookie,
      clientMessageId: 'cm_live_webm_over',
      contentType: 'audio/webm',
      byteSize: overWebm.byteLength,
      durationMs: 2000,
    });
    expect(overClaim.response.status).toBe(201);
    const overMediaId = String((overClaim.body!['media'] as Record<string, unknown>)['media_id']);
    const overUpload = overClaim.body!['upload'] as Record<string, unknown>;
    const overPut = await handleVoiceMediaRoute(
      new Request(`${BASE}${String(overUpload['url'])}`, {
        method: 'PUT',
        headers: csrfHeaders(aviCookie, {
          'x-otis-upload-token': String(overUpload['token']),
          'content-type': 'application/octet-stream',
        }),
        body: overWebm,
      }),
      E,
      'req-test',
    );
    expect(overPut!.status).toBe(422);
    expect((await overPut!.json() as { error: { code: string } }).error.code).toBe('duration_limit');
    expect(await E.STORAGE!.head(`workspace/${WS}/media/${overMediaId}`)).toBeNull();

    // Live WebM within the cap: accepted with the duration parsed from the
    // bytes (5 s), never the forged 2 s declared value.
    const okWebm = webmLiveClusters(5000);
    const webmClaim = await createClaim({
      cookie: aviCookie,
      clientMessageId: 'cm_live_webm_ok',
      contentType: 'audio/webm',
      byteSize: okWebm.byteLength,
      durationMs: 2000,
    });
    expect(webmClaim.response.status).toBe(201);
    const webmMediaId = String((webmClaim.body!['media'] as Record<string, unknown>)['media_id']);
    const webmUpload = webmClaim.body!['upload'] as Record<string, unknown>;
    const webmPut = await handleVoiceMediaRoute(
      new Request(`${BASE}${String(webmUpload['url'])}`, {
        method: 'PUT',
        headers: csrfHeaders(aviCookie, {
          'x-otis-upload-token': String(webmUpload['token']),
          'content-type': 'application/octet-stream',
        }),
        body: okWebm,
      }),
      E,
      'req-test',
    );
    expect(webmPut!.status).toBe(200);
    const webmFinalize = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/media/uploads/${webmMediaId}/finalize`, {
        method: 'POST',
        headers: csrfHeaders(aviCookie),
      }),
      E,
      'req-test',
    );
    expect(webmFinalize!.status).toBe(200);
    expect((await webmFinalize!.json() as { media: { duration_ms: number } }).media.duration_ms).toBe(5000);

    // iPhone-style MP4 with a forged small declared duration and an over-cap
    // mvhd is rejected; an under-cap one stores the mvhd duration.
    const overMp4 = mp4WithDuration(200_000);
    const mp4OverClaim = await createClaim({
      cookie: aviCookie,
      clientMessageId: 'cm_mp4_over',
      contentType: 'audio/mp4',
      byteSize: overMp4.byteLength,
      durationMs: 2000,
    });
    expect(mp4OverClaim.response.status).toBe(201);
    const mp4OverId = String((mp4OverClaim.body!['media'] as Record<string, unknown>)['media_id']);
    const mp4OverUpload = mp4OverClaim.body!['upload'] as Record<string, unknown>;
    const mp4OverPut = await handleVoiceMediaRoute(
      new Request(`${BASE}${String(mp4OverUpload['url'])}`, {
        method: 'PUT',
        headers: csrfHeaders(aviCookie, {
          'x-otis-upload-token': String(mp4OverUpload['token']),
          'content-type': 'application/octet-stream',
        }),
        body: overMp4,
      }),
      E,
      'req-test',
    );
    expect(mp4OverPut!.status).toBe(422);
    expect((await mp4OverPut!.json() as { error: { code: string } }).error.code).toBe('duration_limit');
    expect(await E.STORAGE!.head(`workspace/${WS}/media/${mp4OverId}`)).toBeNull();

    const okMp4 = mp4WithDuration(5000);
    const mp4Claim = await createClaim({
      cookie: aviCookie,
      clientMessageId: 'cm_mp4_ok',
      contentType: 'audio/mp4',
      byteSize: okMp4.byteLength,
      durationMs: 2000,
    });
    expect(mp4Claim.response.status).toBe(201);
    const mp4Id = String((mp4Claim.body!['media'] as Record<string, unknown>)['media_id']);
    const mp4Upload = mp4Claim.body!['upload'] as Record<string, unknown>;
    const mp4Put = await handleVoiceMediaRoute(
      new Request(`${BASE}${String(mp4Upload['url'])}`, {
        method: 'PUT',
        headers: csrfHeaders(aviCookie, {
          'x-otis-upload-token': String(mp4Upload['token']),
          'content-type': 'application/octet-stream',
        }),
        body: okMp4,
      }),
      E,
      'req-test',
    );
    expect(mp4Put!.status).toBe(200);
    const mp4Finalize = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/media/uploads/${mp4Id}/finalize`, {
        method: 'POST',
        headers: csrfHeaders(aviCookie),
      }),
      E,
      'req-test',
    );
    expect(mp4Finalize!.status).toBe(200);
    expect((await mp4Finalize!.json() as { media: { duration_ms: number } }).media.duration_ms).toBe(5000);
  });

  it('reuses one media identity and R2 object across claim retries for the same message UUID', async () => {
    const clientMessageId = 'cm_identity_retry';
    const first = await createClaim({ cookie: aviCookie, clientMessageId, contentType: 'audio/ogg' });
    expect(first.response.status).toBe(201);
    const firstMediaId = String((first.body!['media'] as Record<string, unknown>)['media_id']);

    // Same UUID claim again: same media id, rotated ticket.
    const second = await createClaim({ cookie: aviCookie, clientMessageId, contentType: 'audio/ogg' });
    expect(second.response.status).toBe(201);
    const secondMedia = second.body!['media'] as Record<string, unknown>;
    const secondUpload = second.body!['upload'] as Record<string, unknown>;
    expect(String(secondMedia['media_id'])).toBe(firstMediaId);
    expect(String(secondUpload['token'])).not.toBe(String((first.body!['upload'] as Record<string, unknown>)['token']));

    // A different UUID gets its own identity.
    const other = await createClaim({ cookie: aviCookie, clientMessageId: 'cm_identity_other', contentType: 'audio/ogg' });
    expect(String((other.body!['media'] as Record<string, unknown>)['media_id'])).not.toBe(firstMediaId);

    // Bytes PUT with the rotated ticket overwrite the single object.
    const bytes = oggOpus(2);
    const put = await handleVoiceMediaRoute(
      new Request(`${BASE}${String(secondUpload['url'])}`, {
        method: 'PUT',
        headers: csrfHeaders(aviCookie, {
          'x-otis-upload-token': String(secondUpload['token']),
          'content-type': 'application/octet-stream',
        }),
        body: bytes,
      }),
      E,
      'req-test',
    );
    expect(put!.status).toBe(200);
    const listed = await E.STORAGE!.list({ prefix: `workspace/${WS}/media/` });
    expect(listed.objects.filter((object) => object.key.includes(firstMediaId))).toHaveLength(1);

    // Finalized media refuses a re-upload claim with the same UUID.
    const finalize = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/media/uploads/${firstMediaId}/finalize`, {
        method: 'POST',
        headers: csrfHeaders(aviCookie),
      }),
      E,
      'req-test',
    );
    expect(finalize!.status).toBe(200);
    const afterFinalize = await createClaim({ cookie: aviCookie, clientMessageId, contentType: 'audio/ogg' });
    expect(afterFinalize.response.status).toBe(409);
    expect((afterFinalize.body!['error'] as { code: string }).code).toBe('upload_already_finalized');

    // A rejected upload can be retried on the same identity and object key.
    const rejectId = 'cm_identity_reject';
    const rejectClaim = await createClaim({
      cookie: aviCookie,
      clientMessageId: rejectId,
      contentType: 'audio/ogg',
      byteSize: webmMagic().byteLength,
    });
    const rejectMediaId = String((rejectClaim.body!['media'] as Record<string, unknown>)['media_id']);
    const rejectUpload = rejectClaim.body!['upload'] as Record<string, unknown>;
    const badPut = await handleVoiceMediaRoute(
      new Request(`${BASE}${String(rejectUpload['url'])}`, {
        method: 'PUT',
        headers: csrfHeaders(aviCookie, {
          'x-otis-upload-token': String(rejectUpload['token']),
          'content-type': 'application/octet-stream',
        }),
        body: webmMagic(),
      }),
      E,
      'req-test',
    );
    expect(badPut!.status).toBe(422);
    const retryClaim = await createClaim({
      cookie: aviCookie,
      clientMessageId: rejectId,
      contentType: 'audio/ogg',
      byteSize: bytes.byteLength,
    });
    expect(retryClaim.response.status).toBe(201);
    expect(String((retryClaim.body!['media'] as Record<string, unknown>)['media_id'])).toBe(rejectMediaId);
    expect((retryClaim.body!['media'] as { state: string }).state).toBe('quarantine');
    const retryUpload = retryClaim.body!['upload'] as Record<string, unknown>;
    const goodPut = await handleVoiceMediaRoute(
      new Request(`${BASE}${String(retryUpload['url'])}`, {
        method: 'PUT',
        headers: csrfHeaders(aviCookie, {
          'x-otis-upload-token': String(retryUpload['token']),
          'content-type': 'application/octet-stream',
        }),
        body: bytes,
      }),
      E,
      'req-test',
    );
    expect(goodPut!.status).toBe(200);

    // Acceptance must use the same stable UUID the media was claimed under.
    const mismatch = await acceptWebMessage(E.DB, {
      workspaceId: WS,
      chatId: CHAT,
      userId: AVI,
      clientMessageId: 'cm_identity_mismatch',
      text: '',
      mediaId: rejectMediaId,
    })
      .then(() => null)
      .catch((err: unknown) => err);
    expect(mismatch).toBeInstanceOf(Error);
  });

  it('records format capability only from a server-observed transcription', async () => {
    const bytes = oggOpus(2);
    const claim = await createClaim({
      cookie: aviCookie,
      workspaceId: WS_VERIFY,
      chatId: 'chat_voice_verify',
      clientMessageId: 'cm_verify_sample',
      contentType: 'audio/ogg',
      byteSize: bytes.byteLength,
      durationMs: 2000,
    });
    expect(claim.response.status).toBe(201);
    expect(claim.body!['verification_sample']).toBe(true);
    const media = claim.body!['media'] as Record<string, unknown>;
    const upload = claim.body!['upload'] as Record<string, unknown>;
    const mediaId = String(media['media_id']);
    const put = await handleVoiceMediaRoute(
      new Request(`${BASE}${String(upload['url'])}`, {
        method: 'PUT',
        headers: csrfHeaders(aviCookie, {
          'x-otis-upload-token': String(upload['token']),
          'content-type': 'application/octet-stream',
        }),
        body: bytes,
      }),
      E,
      'req-test',
    );
    expect(put!.status).toBe(200);
    const finalize = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS_VERIFY}/media/uploads/${mediaId}/finalize`, {
        method: 'POST',
        headers: csrfHeaders(aviCookie),
      }),
      E,
      'req-test',
    );
    expect(finalize!.status).toBe(200);

    const fake = fakeGroq(() => transcriptResponse('Verificare reușită pentru format.'));
    (env as unknown as { TRANSCRIPTION_TEST_FETCH?: typeof fake.fn }).TRANSCRIPTION_TEST_FETCH = fake.fn;
    try {
      const verify = await handleVoiceMediaRoute(
        new Request(`${BASE}/api/workspaces/${WS_VERIFY}/voice/verify/${mediaId}`, {
          method: 'POST',
          headers: csrfHeaders(aviCookie),
        }),
        E,
        'req-test',
      );
      expect(verify!.status).toBe(200);
      const body = (await verify!.json()) as {
        verified_format: string;
        verified_formats: string[];
        transcription_verified: boolean;
        sample_deleted: boolean;
      };
      expect(body.verified_format).toBe('audio/ogg');
      expect(body.verified_formats).toEqual(['audio/ogg']);
      expect(body.transcription_verified).toBe(false);
      expect(body.sample_deleted).toBe(true);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]!.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    } finally {
      delete (env as unknown as { TRANSCRIPTION_TEST_FETCH?: typeof fake.fn }).TRANSCRIPTION_TEST_FETCH;
    }

    // Sample bytes and identity are consumed; verification creates no message.
    expect(await E.STORAGE!.head(`workspace/${WS_VERIFY}/media/${mediaId}`)).toBeNull();
    const sampleRow = await E.DB.prepare(`SELECT state FROM media_objects WHERE id = ?`)
      .bind(mediaId)
      .first<{ state: string }>();
    expect(sampleRow?.state).toBe('deleted');
    const messages = await E.DB.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = 'chat_voice_verify'`)
      .first<{ n: number }>();
    expect(Number(messages?.n ?? 0)).toBe(0);

    // The recorded evidence now makes ordinary message uploads available.
    const settings = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS_VERIFY}/voice/settings`, { headers: { cookie: aviCookie } }),
      E,
      'req-test',
    );
    expect(((await settings!.json()) as { settings: { verified_formats: string[] } }).settings.verified_formats).toEqual(['audio/ogg']);

    const messageBytes = oggOpus(2);
    const messageClaim = await createClaim({
      cookie: aviCookie,
      workspaceId: WS_VERIFY,
      chatId: 'chat_voice_verify',
      clientMessageId: 'cm_verify_message',
      contentType: 'audio/ogg',
      byteSize: messageBytes.byteLength,
      durationMs: 2000,
    });
    expect(messageClaim.body!['verification_sample']).toBe(false);

    // A client still cannot write evidence directly.
    const clientEvidence = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS_VERIFY}/voice/settings`, {
        method: 'PUT',
        headers: csrfHeaders(aviCookie, { 'content-type': 'application/json' }),
        body: JSON.stringify({ verified_formats: ['audio/webm'] }),
      }),
      E,
      'req-test',
    );
    expect(clientEvidence!.status).toBe(422);
  });

  it('routes native-capable models to native route and rejects invalid routes defensively in transcription processor', async () => {
    expect(NATIVE_AUDIO_TRANSCRIPTION_IMPLEMENTED).toBe(true);
    const nativeCapable: ModelEntry = {
      commandKey: 'native-capable-fixture',
      displayName: 'Native Capable Fixture',
      provider: 'gemini',
      modelId: 'gemini-fixture',
      endpointFamily: 'gemini-interactions',
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      approved: true,
      lifecycle: 'active',
      capabilities: {
        text: 'supported',
        tools: 'supported',
        stream: 'supported',
        thoughtSummary: 'unverified',
        audio: 'supported',
        nativeAudioFormats: { 'audio/webm': 'supported', 'audio/mp4': 'supported', 'audio/ogg': 'supported' },
      },
      trainingUse: 'test only',
      dataRetention: 'test only',
      evidenceRef: null,
      verifiedAt: null,
    };

    // The resolver used by claim/finalize/acceptance returns native when implemented
    for (const format of ['audio/webm', 'audio/mp4', 'audio/ogg'] as const) {
      const withStt = await resolveVoiceRouteForWorkspace(E.DB, {
        workspaceId: WS,
        model: nativeCapable,
        audioMimeOrExt: format,
      });
      expect(withStt.route).toBe('native');

      const withoutStt = await resolveVoiceRouteForWorkspace(E.DB, {
        workspaceId: WS_OTHER,
        model: nativeCapable,
        audioMimeOrExt: format,
      });
      expect(withoutStt.route).toBe('native');
    }

    // Defensive worker behavior: if an unsupported route snapshot ever reached the
    // Groq transcription processor, the processor rejects it before any provider call.
    const prepared = await prepareVoiceMessage({ clientMessageId: 'cm_native_reject', chatId: 'chat_voice_native_reject' });
    await E.DB.prepare(`UPDATE media_transcriptions SET route = 'native', provider = NULL, model = NULL WHERE id = ?`)
      .bind(prepared.jobId)
      .run();
    const pass = await processTranscriptionJobs(E.DB, E.STORAGE!, { jobId: prepared.jobId, wrappingKey });
    expect(pass.failed[0]?.code).toBe('route_unavailable');
    const job = await E.DB.prepare(`SELECT state FROM media_transcriptions WHERE id = ?`)
      .bind(prepared.jobId)
      .first<{ state: string }>();
    expect(job?.state).toBe('failed');
  });

  it('keeps quarantine inaccessible and serves validated private audio with range support', async () => {
    const bytes = oggOpus(2);
    const claim = await createClaim({
      cookie: aviCookie,
      clientMessageId: 'cm_playback',
      contentType: 'audio/ogg',
      byteSize: bytes.byteLength,
      durationMs: 2000,
    });
    const media = claim.body!['media'] as Record<string, unknown>;
    const upload = claim.body!['upload'] as Record<string, unknown>;
    const mediaId = String(media['media_id']);
    const put = await handleVoiceMediaRoute(
      new Request(`${BASE}${String(upload['url'])}`, {
        method: 'PUT',
        headers: csrfHeaders(aviCookie, {
          'x-otis-upload-token': String(upload['token']),
          'content-type': 'application/octet-stream',
        }),
        body: bytes,
      }),
      E,
      'req-test',
    );
    expect(put!.status).toBe(200);

    const quarantineRead = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/media/${mediaId}`, { headers: { cookie: aviCookie } }),
      E,
      'req-test',
    );
    expect(quarantineRead!.status).toBe(404);

    const finalize = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/media/uploads/${mediaId}/finalize`, {
        method: 'POST',
        headers: csrfHeaders(aviCookie),
      }),
      E,
      'req-test',
    );
    expect(finalize!.status).toBe(200);

    const full = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/media/${mediaId}`, { headers: { cookie: aviCookie } }),
      E,
      'req-test',
    );
    expect(full!.status).toBe(200);
    expect(full!.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await full!.arrayBuffer())).toEqual(bytes);

    const range = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/media/${mediaId}`, {
        headers: { cookie: aviCookie, range: 'bytes=0-3' },
      }),
      E,
      'req-test',
    );
    expect(range!.status).toBe(206);
    expect(range!.headers.get('content-range')).toBe(`bytes 0-3/${bytes.byteLength}`);
    expect((await range!.arrayBuffer()).byteLength).toBe(4);
  });

  it('defers agent dispatch until the durable transcript is ready and reuses it exactly once', async () => {
    const prepared = await prepareVoiceMessage({ clientMessageId: 'cm_transcript_ready', chatId: 'chat_voice_ready' });

    const earlyDispatch = await dispatchOutboxItem(E.DB, prepared.outboxId, WS, { handler: EchoHandler });
    expect(earlyDispatch.status).toBe('deferred');
    expect(earlyDispatch.detail).toBe('transcript_pending');

    const fake = fakeGroq(() => transcriptResponse('Salut, confirm că Ion a plătit 300 de lei.'));
    const firstPass = await processTranscriptionJobs(E.DB, E.STORAGE!, {
      jobId: prepared.jobId,
      fetchFn: fake.fn,
      wrappingKey,
    });
    expect(firstPass.ready).toHaveLength(1);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(fake.calls[0]!.authorization).toBe(`Bearer ${GROQ_KEY}`);
    expect(fake.calls[0]!.model).toBe('whisper-large-v3-turbo');
    expect(fake.calls[0]!.filename).toMatch(/^voice-med_.*\.ogg$/);

    const job = await E.DB.prepare(`SELECT state, transcript_text, transcript_language, attempt_count FROM media_transcriptions WHERE id = ?`)
      .bind(prepared.jobId)
      .first<{ state: string; transcript_text: string; transcript_language: string; attempt_count: number }>();
    expect(job?.state).toBe('ready');
    expect(job?.transcript_text).toBe('Salut, confirm că Ion a plătit 300 de lei.');
    expect(job?.transcript_language).toBe('ro');

    const media = await E.DB.prepare(`SELECT state FROM media_objects WHERE id = ?`)
      .bind(prepared.mediaId)
      .first<{ state: string }>();
    expect(media?.state).toBe('ready');

    const memberMessage = await E.DB.prepare(`SELECT content_text FROM chat_messages WHERE run_id = ? AND media_id = ?`)
      .bind(prepared.runId, prepared.mediaId)
      .first<{ content_text: string }>();
    expect(memberMessage?.content_text).toBe('Salut, confirm că Ion a plătit 300 de lei.');

    // Replay: a committed transcript is never retranscribed.
    const replay = await processTranscriptionJobs(E.DB, E.STORAGE!, {
      jobId: prepared.jobId,
      fetchFn: fake.fn,
      wrappingKey,
    });
    expect(replay.processed).toBe(0);
    expect(fake.calls).toHaveLength(1);

    const completed = await dispatchOutboxItem(E.DB, prepared.outboxId, WS, { handler: EchoHandler });
    expect(completed.status).toBe('completed');
    const reply = await E.DB.prepare(`SELECT content_text FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`)
      .bind(prepared.runId)
      .first<{ content_text: string }>();
    expect(reply?.content_text).toContain('Ion a plătit 300 de lei');

    // Exactly one logical run and one system reply for the accepted input.
    const again = await dispatchOutboxItem(E.DB, prepared.outboxId, WS, { handler: EchoHandler });
    expect(again.status).toBe('already_done');
    const runs = await E.DB.prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE chat_id = ?`)
      .bind('chat_voice_ready')
      .first<{ n: number }>();
    expect(Number(runs?.n ?? 0)).toBe(1);
    const replies = await E.DB.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ? AND author_kind = 'system'`)
      .bind('chat_voice_ready')
      .first<{ n: number }>();
    expect(Number(replies?.n ?? 0)).toBe(1);
  });

  it('retries a rate-limited transcription within bounds and never switches providers', async () => {
    const prepared = await prepareVoiceMessage({ clientMessageId: 'cm_retry', chatId: 'chat_voice_retry' });
    const baseTime = new Date().toISOString();
    const fake = fakeGroq((call) =>
      call === 1
        ? new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '2' },
          })
        : transcriptResponse('Notă repetată cu succes.'),
    );

    const first = await processTranscriptionJobs(E.DB, E.STORAGE!, {
      jobId: prepared.jobId,
      fetchFn: fake.fn,
      wrappingKey,
      nowIso: baseTime,
    });
    expect(first.deferred).toBe(1);
    const afterFirst = await E.DB.prepare(`SELECT state, attempt_count, next_attempt_at FROM media_transcriptions WHERE id = ?`)
      .bind(prepared.jobId)
      .first<{ state: string; attempt_count: number; next_attempt_at: string }>();
    expect(afterFirst?.state).toBe('pending');
    expect(afterFirst?.attempt_count).toBe(1);
    expect(afterFirst?.next_attempt_at > baseTime).toBe(true);

    const tooSoon = await processTranscriptionJobs(E.DB, E.STORAGE!, {
      jobId: prepared.jobId,
      fetchFn: fake.fn,
      wrappingKey,
      nowIso: baseTime,
    });
    expect(tooSoon.processed).toBe(0);

    const later = new Date(new Date(baseTime).getTime() + 3000).toISOString();
    const second = await processTranscriptionJobs(E.DB, E.STORAGE!, {
      jobId: prepared.jobId,
      fetchFn: fake.fn,
      wrappingKey,
      nowIso: later,
    });
    expect(second.ready).toHaveLength(1);
    expect(fake.calls).toHaveLength(2);
    expect(new Set(fake.calls.map((call) => call.url)).size).toBe(1);
    const finalJob = await E.DB.prepare(`SELECT state, attempt_count FROM media_transcriptions WHERE id = ?`)
      .bind(prepared.jobId)
      .first<{ state: string; attempt_count: number }>();
    expect(finalJob?.state).toBe('ready');
    expect(finalJob?.attempt_count).toBe(2);
  });

  it('rejects late publication when the run is stopped during inference', async () => {
    const prepared = await prepareVoiceMessage({ clientMessageId: 'cm_stop', chatId: 'chat_voice_stop' });
    const fake = fakeGroq(() => transcriptResponse('Această notă nu trebuie publicată.'));
    const pass = await processTranscriptionJobs(E.DB, E.STORAGE!, {
      jobId: prepared.jobId,
      fetchFn: fake.fn,
      wrappingKey,
      testHooks: {
        beforeProviderCall: async () => {
          await stopRun(E.DB, { workspaceId: WS, runId: prepared.runId, actorUserId: AVI });
        },
      },
    });
    expect(pass.ready).toHaveLength(0);
    const message = await E.DB.prepare(`SELECT content_text FROM chat_messages WHERE run_id = ? AND media_id = ?`)
      .bind(prepared.runId, prepared.mediaId)
      .first<{ content_text: string }>();
    expect(message?.content_text).toBe('');
    const media = await E.DB.prepare(`SELECT state FROM media_objects WHERE id = ?`)
      .bind(prepared.mediaId)
      .first<{ state: string }>();
    expect(media?.state).not.toBe('ready');

    const expiredClaimTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const next = await processTranscriptionJobs(E.DB, E.STORAGE!, {
      jobId: prepared.jobId,
      fetchFn: fake.fn,
      wrappingKey,
      nowIso: expiredClaimTime,
    });
    expect(next.cancelled).toBe(1);
    const finalJob = await E.DB.prepare(`SELECT state, transcript_text FROM media_transcriptions WHERE id = ?`)
      .bind(prepared.jobId)
      .first<{ state: string; transcript_text: string | null }>();
    expect(finalJob?.state).toBe('cancelled');
    expect(finalJob?.transcript_text).toBeNull();
  });

  it('does not publish a late transcript after the uploader is removed during inference', async () => {
    const prepared = await prepareVoiceMessage({ clientMessageId: 'cm_late_member', chatId: 'chat_voice_late_member' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gatedFetch: FetchFn = async () => {
      entered();
      await gate;
      return transcriptResponse('Această transcriere nu trebuie publicată.');
    };
    const pending = processTranscriptionJobs(E.DB, E.STORAGE!, {
      jobId: prepared.jobId,
      fetchFn: gatedFetch,
      wrappingKey,
    });
    await enteredPromise;

    // Membership is revoked while the provider call is in flight.
    await E.DB.prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`).bind(WS, AVI).run();
    release();
    const stalePass = await pending;
    expect(stalePass.ready).toHaveLength(0);

    // Zero transcript/chat/publication writes from the stale attempt.
    const job = await E.DB.prepare(`SELECT state, transcript_text FROM media_transcriptions WHERE id = ?`)
      .bind(prepared.jobId)
      .first<{ state: string; transcript_text: string | null }>();
    expect(job?.state).toBe('running');
    expect(job?.transcript_text).toBeNull();
    const media = await E.DB.prepare(`SELECT state FROM media_objects WHERE id = ?`)
      .bind(prepared.mediaId)
      .first<{ state: string }>();
    expect(media?.state).toBe('transcribing');
    const message = await E.DB.prepare(`SELECT content_text FROM chat_messages WHERE run_id = ? AND media_id = ?`)
      .bind(prepared.runId, prepared.mediaId)
      .first<{ content_text: string }>();
    expect(message?.content_text).toBe('');
    const replies = await E.DB.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`)
      .bind(prepared.runId)
      .first<{ n: number }>();
    expect(Number(replies?.n ?? 0)).toBe(0);

    // A later pass while membership is still gone fails visibly.
    const later = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const retryPass = await processTranscriptionJobs(E.DB, E.STORAGE!, {
      jobId: prepared.jobId,
      fetchFn: gatedFetch,
      wrappingKey,
      nowIso: later,
    });
    expect(retryPass.failed[0]?.code).toBe('member_removed');
    const failedJob = await E.DB.prepare(`SELECT state, error_code FROM media_transcriptions WHERE id = ?`)
      .bind(prepared.jobId)
      .first<{ state: string; error_code: string }>();
    expect(failedJob?.state).toBe('failed');
    expect(failedJob?.error_code).toBe('member_removed');
    const failedRun = await E.DB.prepare(`SELECT status FROM agent_runs WHERE id = ?`)
      .bind(prepared.runId)
      .first<{ status: string }>();
    expect(failedRun?.status).toBe('failed');

    // Restore the owner for the remaining suites.
    const now = new Date().toISOString();
    await E.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'owner', ?, ?, ?)`,
    )
      .bind(WS, AVI, now, now, now)
      .run();
  });

  it('does not publish after the audio expires during inference', async () => {
    const prepared = await prepareVoiceMessage({ clientMessageId: 'cm_late_expiry', chatId: 'chat_voice_late_expiry' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gatedFetch: FetchFn = async () => {
      entered();
      await gate;
      return transcriptResponse('Transcriere expirată.');
    };
    const pending = processTranscriptionJobs(E.DB, E.STORAGE!, {
      jobId: prepared.jobId,
      fetchFn: gatedFetch,
      wrappingKey,
    });
    await enteredPromise;
    await E.DB.prepare(`UPDATE media_objects SET expires_at = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 1000).toISOString(), prepared.mediaId)
      .run();
    release();
    const stalePass = await pending;
    expect(stalePass.ready).toHaveLength(0);

    const job = await E.DB.prepare(`SELECT state, transcript_text FROM media_transcriptions WHERE id = ?`)
      .bind(prepared.jobId)
      .first<{ state: string; transcript_text: string | null }>();
    expect(job?.state).toBe('running');
    expect(job?.transcript_text).toBeNull();
    const media = await E.DB.prepare(`SELECT state FROM media_objects WHERE id = ?`)
      .bind(prepared.mediaId)
      .first<{ state: string }>();
    expect(media?.state).toBe('transcribing');
    const message = await E.DB.prepare(`SELECT content_text FROM chat_messages WHERE run_id = ? AND media_id = ?`)
      .bind(prepared.runId, prepared.mediaId)
      .first<{ content_text: string }>();
    expect(message?.content_text).toBe('');

    // Restore retention metadata so the dedicated expiry test owns its count.
    await E.DB.prepare(`UPDATE media_objects SET expires_at = ? WHERE id = ?`)
      .bind(new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(), prepared.mediaId)
      .run();
  });

  it('never lets a stale attempt cancel or overwrite a successor-owned receipt', async () => {
    const prepared = await prepareVoiceMessage({ clientMessageId: 'cm_stale_successor', chatId: 'chat_voice_stale' });
    let current = new Date().toISOString();
    const clock = () => current;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const staleFetch: FetchFn = async () => {
      entered();
      await gate;
      return transcriptResponse('Răspuns întârziat.');
    };
    const staleAttempt = processTranscriptionJobs(E.DB, E.STORAGE!, {
      jobId: prepared.jobId,
      fetchFn: staleFetch,
      wrappingKey,
      clock,
    });
    await enteredPromise;

    // Claim TTL elapses while the provider call is in flight: a successor
    // claims the expired job and commits its own canonical transcript.
    current = new Date(new Date(current).getTime() + 5 * 60 * 1000).toISOString();
    const successor = fakeGroq(() => transcriptResponse('Răspunsul succesorului.'));
    const successorPass = await processTranscriptionJobs(E.DB, E.STORAGE!, {
      jobId: prepared.jobId,
      fetchFn: successor.fn,
      wrappingKey,
      clock,
    });
    expect(successorPass.ready).toHaveLength(1);

    release();
    const stalePass = await staleAttempt;
    expect(stalePass.ready).toHaveLength(0);
    expect(stalePass.deferred).toBe(1);

    // The successor's receipt stands; the stale attempt neither overwrote
    // nor failed/cancelled it.
    const job = await E.DB.prepare(`SELECT state, transcript_text, error_code FROM media_transcriptions WHERE id = ?`)
      .bind(prepared.jobId)
      .first<{ state: string; transcript_text: string | null; error_code: string | null }>();
    expect(job?.state).toBe('ready');
    expect(job?.transcript_text).toBe('Răspunsul succesorului.');
    expect(job?.error_code).toBeNull();
    const message = await E.DB.prepare(`SELECT content_text FROM chat_messages WHERE run_id = ? AND media_id = ?`)
      .bind(prepared.runId, prepared.mediaId)
      .first<{ content_text: string }>();
    expect(message?.content_text).toBe('Răspunsul succesorului.');
  });

  it('fails visibly on an empty transcript and never invents text', async () => {
    const prepared = await prepareVoiceMessage({ clientMessageId: 'cm_empty', chatId: 'chat_voice_empty' });
    const fake = fakeGroq(() => transcriptResponse('   '));
    const pass = await processTranscriptionJobs(E.DB, E.STORAGE!, {
      jobId: prepared.jobId,
      fetchFn: fake.fn,
      wrappingKey,
    });
    expect(pass.failed).toHaveLength(1);
    expect(pass.failed[0]!.code).toBe('empty_transcript');
    const run = await E.DB.prepare(`SELECT status, error_code FROM agent_runs WHERE id = ?`)
      .bind(prepared.runId)
      .first<{ status: string; error_code: string }>();
    expect(run?.status).toBe('failed');
    expect(run?.error_code).toBe('transcription_empty_transcript');
    const reply = await E.DB.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`)
      .bind(prepared.runId)
      .first<{ n: number }>();
    expect(Number(reply?.n ?? 0)).toBe(0);
    const lateDispatch = await dispatchOutboxItem(E.DB, prepared.outboxId, WS, { handler: EchoHandler });
    expect(lateDispatch.status).toBe('already_done');
  });

  it('scopes media reads to current workspace membership including teammates', async () => {
    const prepared = await prepareVoiceMessage({ clientMessageId: 'cm_scope', chatId: 'chat_voice_scope' });
    const fake = fakeGroq(() => transcriptResponse('Notă pentru echipă.'));
    await processTranscriptionJobs(E.DB, E.STORAGE!, { jobId: prepared.jobId, fetchFn: fake.fn, wrappingKey });

    const teammateStatus = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/media/${prepared.mediaId}/status`, { headers: { cookie: hunorCookie } }),
      E,
      'req-test',
    );
    expect(teammateStatus!.status).toBe(200);
    const teammateBody = (await teammateStatus!.json()) as { media: { transcript: string } };
    expect(teammateBody.media.transcript).toBe('Notă pentru echipă.');

    const teammateAudio = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/media/${prepared.mediaId}`, { headers: { cookie: hunorCookie } }),
      E,
      'req-test',
    );
    expect(teammateAudio!.status).toBe(200);

    const foreign = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS_OTHER}/media/${prepared.mediaId}/status`, { headers: { cookie: otherCookie } }),
      E,
      'req-test',
    );
    expect(foreign!.status).toBe(404);
  });

  it('expires raw audio after retention while keeping the committed transcript', async () => {
    const prepared = await prepareVoiceMessage({ clientMessageId: 'cm_expiry', chatId: 'chat_voice_expiry' });
    const fake = fakeGroq(() => transcriptResponse('Transcriere păstrată după expirare.'));
    await processTranscriptionJobs(E.DB, E.STORAGE!, { jobId: prepared.jobId, fetchFn: fake.fn, wrappingKey });

    const past = new Date(Date.now() - 60_000).toISOString();
    await E.DB.prepare(`UPDATE media_objects SET expires_at = ? WHERE id = ?`).bind(past, prepared.mediaId).run();
    const cleanup = await cleanupExpiredMedia(E.DB, E.STORAGE!, { nowIso: new Date().toISOString() });
    expect(cleanup.expired).toBeGreaterThanOrEqual(1);
    expect(await E.STORAGE!.head(`workspace/${WS}/media/${prepared.mediaId}`)).toBeNull();

    const status = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/media/${prepared.mediaId}/status`, { headers: { cookie: aviCookie } }),
      E,
      'req-test',
    );
    const statusBody = (await status!.json()) as { media: { state: string; transcript: string | null } };
    expect(statusBody.media.state).toBe('expired');
    expect(statusBody.media.transcript).toBe('Transcriere păstrată după expirare.');

    const audio = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/media/${prepared.mediaId}`, { headers: { cookie: aviCookie } }),
      E,
      'req-test',
    );
    expect(audio!.status).toBe(410);
  });

  it('reports voice unavailable without a verified route or key and exposes effective availability', async () => {
    const noKey = await createClaim({
      cookie: aviCookie,
      workspaceId: WS_NO_KEY,
      chatId: 'chat_voice_nokey',
      clientMessageId: 'cm_no_key',
    });
    expect(noKey.response.status).toBe(422);
    expect((noKey.body!['error'] as { code: string }).code).toBe('voice_unavailable');

    const modelsResponse = await handleListModels(
      new Request(`${BASE}/api/workspaces/${WS}/models?chat_id=${CHAT}`, { headers: { cookie: aviCookie } }),
      E,
      WS,
      'req-test',
    );
    const modelsBody = (await modelsResponse.json()) as { models: Array<{ command_key: string; voice_available: boolean; native_audio_supported: boolean }> };
    expect(modelsBody.models.length).toBeGreaterThan(0);
    for (const model of modelsBody.models) {
      if (model.command_key === 'gemini-3.5-flash-lite' || model.command_key === 'gemini-3.1-flash-lite') {
        expect(model.native_audio_supported).toBe(true);
      } else {
        expect(model.native_audio_supported).toBe(false);
      }
      expect(model.voice_available).toBe(true);
    }

    const noKeyModels = await handleListModels(
      new Request(`${BASE}/api/workspaces/${WS_NO_KEY}/models?chat_id=chat_voice_nokey`, { headers: { cookie: aviCookie } }),
      E,
      WS_NO_KEY,
      'req-test',
    );
    const noKeyBody = (await noKeyModels.json()) as { models: Array<{ voice_available: boolean }> };
    expect(noKeyBody.models.every((model) => model.voice_available === false)).toBe(true);
  });

  it('ingests Telegram OGG voice notes through the fixed file endpoints and reuses the transcript', async () => {
    await ensureChat('chat_voice_tg', WS, HUNOR);
    const now = new Date().toISOString();
    await E.DB.prepare(
      `INSERT OR REPLACE INTO telegram_users (telegram_user_id, user_id, selected_workspace_id, active_chat_id, created_at, updated_at)
       VALUES ('777003', ?, ?, 'chat_voice_tg', ?, ?)`,
    )
      .bind(HUNOR, WS, now, now)
      .run();

    const bytes = oggOpus(2);
    const calls: string[] = [];
    const fileTransport = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      if (url.endsWith('/getFile')) {
        expect(String(init.body)).toContain('file_ogg_1');
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/file_1.oga', file_size: bytes.byteLength } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(bytes, { status: 200, headers: { 'content-type': 'audio/ogg' } });
    };
    const update = {
      update_id: 9001,
      message: {
        message_id: 42,
        from: { id: 777003, is_bot: false, first_name: 'Hunor' },
        chat: { id: 777003, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        voice: { file_id: 'file_ogg_1', duration: 2, mime_type: 'audio/ogg' },
      },
    };
    const result = await acceptTelegramInbound(E.DB, 'test_bot', update, {
      botToken: '123456:synthetic-token',
      storage: E.STORAGE!,
      fileTransport,
    });
    expect(result.status).toBe('accepted');
    expect(calls[0]).toContain('https://api.telegram.org/bot123456:synthetic-token/getFile');
    expect(calls[1]).toContain('https://api.telegram.org/file/bot123456:synthetic-token/voice/file_1.oga');

    const job = await E.DB.prepare(
      `SELECT t.id, t.state, t.route, t.model, m.state AS media_state
       FROM media_transcriptions t JOIN media_objects m ON m.id = t.media_id
       WHERE t.run_id = ?`,
    )
      .bind(result.run_id)
      .first<{ id: string; state: string; route: string; model: string; media_state: string }>();
    expect(job?.state).toBe('pending');
    expect(job?.route).toBe('groq_stt');
    expect(job?.model).toBe('whisper-large-v3-turbo');
    expect(job?.media_state).toBe('transcribing');

    const fake = fakeGroq(() => transcriptResponse('Notă vocală Telegram cu suma de 300 de lei.'));
    const pass = await processTranscriptionJobs(E.DB, E.STORAGE!, {
      jobId: String(job!.id),
      fetchFn: fake.fn,
      wrappingKey,
    });
    expect(pass.ready).toHaveLength(1);
    const message = await E.DB.prepare(`SELECT content_text FROM chat_messages WHERE run_id = ? AND media_id IS NOT NULL`)
      .bind(result.run_id)
      .first<{ content_text: string }>();
    expect(message?.content_text).toBe('Notă vocală Telegram cu suma de 300 de lei.');

    // A declared oversized Telegram file is refused before any provider work.
    const oversized = await acceptTelegramInbound(
      E.DB,
      'test_bot',
      {
        ...update,
        update_id: 9002,
        message: { ...update.message, message_id: 43, voice: { file_id: 'file_big', duration: 2, mime_type: 'audio/ogg' } },
      },
      {
        botToken: '123456:synthetic-token',
        storage: E.STORAGE!,
        fileTransport: async (url, _init) => {
          if (url.endsWith('/getFile')) {
            return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/big.oga', file_size: VOICE_BOUNDS.MAX_BYTES + 1 } }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(bytes, { status: 200 });
        },
      },
    );
    expect(oversized.status).toBe('unsupported');
  });

  it('validates shared STT settings and reports status without ciphertext', async () => {
    const getResponse = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/voice/settings`, { headers: { cookie: aviCookie } }),
      E,
      'req-test',
    );
    expect(getResponse!.status).toBe(200);
    const body = (await getResponse!.json()) as {
      settings: { enabled: boolean; model: string; transcription_verified: boolean; credential_status: string; verified_formats: string[] };
    };
    expect(body.settings.enabled).toBe(true);
    expect(body.settings.model).toBe('whisper-large-v3-turbo');
    expect(body.settings.transcription_verified).toBe(true);
    expect(body.settings.credential_status).toBe('available');
    expect(JSON.stringify(body)).not.toContain(GROQ_KEY);

    const incomplete = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS_NO_KEY}/voice/settings`, {
        method: 'PUT',
        headers: csrfHeaders(aviCookie, { 'content-type': 'application/json' }),
        body: JSON.stringify({ enabled: true, model: null }),
      }),
      E,
      'req-test',
    );
    expect(incomplete!.status).toBe(422);

    const complete = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS_NO_KEY}/voice/settings`, {
        method: 'PUT',
        headers: csrfHeaders(aviCookie, { 'content-type': 'application/json' }),
        body: JSON.stringify({ enabled: true, model: 'whisper-large-v3' }),
      }),
      E,
      'req-test',
    );
    expect(complete!.status).toBe(200);
    const completeBody = (await complete!.json()) as { settings: { transcription_verified: boolean; credential_status: string | null } };
    expect(completeBody.settings.transcription_verified).toBe(false);
    expect(completeBody.settings.credential_status).toBeNull();

    // Ordinary choices can change the model without wiping or granting
    // verification evidence; the evidence mutation is server-audited.
    await setWorkspaceVoiceSettings(E.DB, {
      workspaceId: WS,
      actorUserId: AVI,
      input: { model: 'whisper-large-v3' },
    });
    const afterModelChange = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/voice/settings`, { headers: { cookie: aviCookie } }),
      E,
      'req-test',
    );
    const afterBody = (await afterModelChange!.json()) as {
      settings: { model: string; verified_formats: string[]; transcription_verified: boolean };
    };
    expect(afterBody.settings.model).toBe('whisper-large-v3');
    expect(afterBody.settings.verified_formats).toEqual(['audio/webm', 'audio/mp4', 'audio/ogg']);
    expect(afterBody.settings.transcription_verified).toBe(true);

    const audit = await E.DB.prepare(
      `SELECT changed_fields_json FROM settings_audit
       WHERE workspace_id = ? AND changed_fields_json LIKE '%server_transcription%' LIMIT 1`,
    )
      .bind(WS)
      .first<{ changed_fields_json: string }>();
    expect(audit?.changed_fields_json).toContain('server_transcription');
  });

  it('natively executes a turn with attached voice audio and marks media ready', async () => {
    const nowIso = new Date().toISOString();
    await E.DB.prepare(
      `INSERT OR REPLACE INTO provider_credentials (workspace_id, provider, encrypted_key, key_nonce, key_version, status, last_verified_at, created_at, updated_at)
       VALUES (?, 'gemini', 'synthetic-test-only', 'synthetic', 1, 'available', ?, ?, ?)`,
    )
      .bind(WS, nowIso, nowIso, nowIso)
      .run();

    // Set chat to gemini-3.5-flash-lite (native audio supported with available gemini credential)
    await E.DB.prepare(`UPDATE chats SET model_override = 'gemini-3.5-flash-lite' WHERE id = ?`)
      .bind(CHAT)
      .run();

    const prepared = await prepareVoiceMessage({
      clientMessageId: 'cm_native_turn_test',
      chatId: CHAT,
    });

    let capturedInput: TurnInput | null = null;
    const testAdapter: ProviderAdapter = {
      provider: 'gemini',
      async *streamTurn(input: TurnInput): AsyncGenerator<ProviderEvent> {
        capturedInput = input;
        yield { type: 'text_delta', text: 'I heard your voice note.' };
        yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, totalTokens: 60, cumulative: true } };
        yield { type: 'finish', reason: 'success', continuation: null };
      },
      audioSupport() {
        return { support: 'supported', detail: 'Native audio supported by Gemini.' };
      },
    };

    const handler = new AgentHandler({
      providerAdapter: testAdapter,
      limits: { maxDailyActions: 10, maxRoundsPerRun: 5 },
      storage: E.STORAGE!,
    });

    const runRow = await E.DB.prepare(`SELECT id FROM agent_runs WHERE id = ?`).bind(prepared.runId).first<{ id: string }>();
    expect(runRow).toBeDefined();

    const transcriptionBefore = await E.DB.prepare(`SELECT route, model, provider FROM media_transcriptions WHERE media_id = ?`).bind(prepared.mediaId).first<{ route: string }>();
    expect(transcriptionBefore?.route).toBe('native');

    const outboxRow = await E.DB
      .prepare(`SELECT id FROM outbox WHERE json_extract(payload_json, '$.run_id') = ?`)
      .bind(prepared.runId)
      .first<{ id: string }>();
    expect(outboxRow).toBeDefined();

    await E.DB.prepare('UPDATE workspaces SET lease_owner = NULL, lease_attempt_id = NULL, lease_expires_at = NULL WHERE id = ?').bind(WS).run();
    const dispatchResult = await dispatchOutboxItem(E.DB, outboxRow!.id, WS, { handler });
    expect(dispatchResult).toMatchObject({ status: 'completed' });
    expect(capturedInput).not.toBeNull();
    const userMsg = capturedInput!.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg?.audio).toBeDefined();
    expect(userMsg?.audio?.mimeType).toContain('audio/');
    expect(typeof userMsg?.audio?.data).toBe('string');

    // Assert media records are marked ready
    const mediaRow = await E.DB.prepare(`SELECT state FROM media_objects WHERE id = ?`).bind(prepared.mediaId).first<{ state: string }>();
    expect(mediaRow?.state).toBe('ready');

    const transcriptionRow = await E.DB.prepare(`SELECT state, transcript_text FROM media_transcriptions WHERE media_id = ?`).bind(prepared.mediaId).first<{ state: string; transcript_text: string }>();
    expect(transcriptionRow?.state).toBe('ready');
    expect(transcriptionRow?.transcript_text).toContain('natively');
  });
});
