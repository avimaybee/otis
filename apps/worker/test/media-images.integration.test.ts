import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import {
  AUTH_BOUNDS,
  IMAGE_BOUNDS,
  IMAGE_FORMATS,
  normalizeImageFormat,
  validateCreateImageUploadRequest,
} from '@otis/contracts';
import { MAX_IMAGES_PER_MESSAGE, SUPPORTED_IMAGE_MIMES } from '@otis/agent';
import {
  FakeProviderAdapter,
  createRegistry,
  type FetchFn,
  type ModelEntry,
} from '@otis/agent';
import { AgentHandler } from '../src/agent/handler.js';
import { sha256 } from '@otis/identity';
import type { Env } from '../src/index.js';
import { inspectImageBytes } from '../src/media/container.js';
import { handleVoiceMediaRoute } from '../src/media/routes.js';
import { acceptWebMessage } from '../src/inbox/repository.js';
import { dispatchOutboxItem } from '../src/actor/dispatch.js';

const E = env as unknown as Env;
const BASE = 'http://localhost';
const WS = 'ws_img';
const AVI = 'usr_img_avi';
const CHAT = 'chat_img';

let aviCookie = '';

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

function pngBytes(): Uint8Array {
  const out = new Uint8Array(208);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return out;
}

function jpegBytes(): Uint8Array {
  const out = new Uint8Array(208);
  out.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return out;
}

function webpBytes(): Uint8Array {
  const out = new Uint8Array(208);
  const ascii = (s: string, at: number) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii('RIFF', 0);
  ascii('WEBP', 8);
  return out;
}

async function claimImage(clientMessageId: string, contentType: string, byteSize: number) {
  const response = await handleVoiceMediaRoute(
    new Request(`${BASE}/api/workspaces/${WS}/media/uploads`, {
      method: 'POST',
      headers: csrfHeaders(aviCookie, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        chat_id: CHAT,
        client_message_id: clientMessageId,
        content_type: contentType,
        byte_size: byteSize,
      }),
    }),
    E,
    'req-test',
  );
  const body = response ? ((await response.clone().json()) as Record<string, unknown>) : null;
  return { response: response!, body };
}

async function putBytes(uploadUrl: string, token: string, bytes: Uint8Array) {
  return handleVoiceMediaRoute(
    new Request(`${BASE}${uploadUrl}`, {
      method: 'PUT',
      headers: csrfHeaders(aviCookie, {
        'x-otis-upload-token': token,
        'content-type': 'application/octet-stream',
      }),
      body: bytes,
    }),
    E,
    'req-test',
  );
}

async function finalize(mediaId: string) {
  const response = await handleVoiceMediaRoute(
    new Request(`${BASE}/api/workspaces/${WS}/media/uploads/${mediaId}/finalize`, {
      method: 'POST',
      headers: csrfHeaders(aviCookie),
    }),
    E,
    'req-test',
  );
  const body = response ? ((await response.clone().json()) as Record<string, unknown>) : null;
  return { response: response!, body };
}

beforeAll(async () => {
  await applyMigrations(E.DB);
  const now = new Date().toISOString();
  await E.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(AVI, 'fb_img_avi', 'avi.img@kerning.test', 'Avi', now, now)
    .run();
  await E.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, ?, ?)`,
  )
    .bind(WS, 'Image WS', AVI, now, now)
    .run();
  await E.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(WS, AVI, 'owner', now, now, now)
    .run();
  await E.DB.prepare(
    `INSERT OR IGNORE INTO chats (id, workspace_id, author_user_id, title, model_override, is_archived, activity_cursor, created_at, updated_at, last_activity_at)
     VALUES (?, ?, ?, 'Image test', NULL, 0, 0, ?, ?, ?)`,
  )
    .bind(CHAT, WS, AVI, now, now, now)
    .run();
  aviCookie = await seedSession('sess_img_avi', 'tok_img_avi', AVI);
});

describe('image attachments upload spine (workerd)', () => {
  it('verifies image containers from magic bytes, never extensions', () => {
    expect(inspectImageBytes(pngBytes()).format).toBe('image/png');
    expect(inspectImageBytes(jpegBytes()).format).toBe('image/jpeg');
    expect(inspectImageBytes(webpBytes()).format).toBe('image/webp');
    expect(inspectImageBytes(new Uint8Array(200)).format).toBeNull();
    expect(normalizeImageFormat('image/png; charset=binary')).toBe('image/png');
    expect(normalizeImageFormat('photo.JPG')).toBe('image/jpeg');
    expect(validateCreateImageUploadRequest({
      chat_id: CHAT,
      client_message_id: 'cm_unit_1',
      content_type: 'image/png',
      byte_size: 1024,
    }).valid).toBe(true);
    expect(validateCreateImageUploadRequest({
      chat_id: CHAT,
      client_message_id: 'cm_unit_2',
      content_type: 'image/png',
      byte_size: IMAGE_BOUNDS.MAX_BYTES + 1,
    }).valid).toBe(false);
  });

  it.each([
    ['png', 'image/png', pngBytes()],
    ['jpeg', 'image/jpeg', jpegBytes()],
    ['webp', 'image/webp', webpBytes()],
  ])('round-trips a %s: claim, bytes, finalize, private read', async (_label, contentType, bytes) => {
    const clientMessageId = `cm_img_${_label}`;
    const claim = await claimImage(clientMessageId, contentType, bytes.byteLength);
    expect(claim.response.status).toBe(201);
    const mediaId = String(claim.body!['media_id']);
    const upload = claim.body!['upload'] as Record<string, unknown>;
    expect(String(upload['url'])).toContain(mediaId);

    const put = await putBytes(String(upload['url']), String(upload['token']), bytes);
    expect(put!.status).toBe(200);

    const done = await finalize(mediaId);
    expect(done.response.status).toBe(200);
    const media = done.body!['media'] as Record<string, unknown>;
    expect(media['state']).toBe('validated');
    expect(media['format']).toBe(contentType);

    const status = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/media/${mediaId}/status`, {
        method: 'GET',
        headers: csrfHeaders(aviCookie),
      }),
      E,
      'req-test',
    );
    expect(status!.status).toBe(200);

    const content = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/media/${mediaId}`, {
        method: 'GET',
        headers: csrfHeaders(aviCookie),
      }),
      E,
      'req-test',
    );
    expect(content!.status).toBe(200);
    expect(content!.headers.get('content-type')).toBe(contentType);
    const returned = new Uint8Array(await content!.arrayBuffer());
    expect(returned).toEqual(bytes);
  });

  it('rejects renamed bytes that do not match the claimed container', async () => {
    const claim = await claimImage('cm_img_mismatch', 'image/jpeg', jpegBytes().byteLength);
    expect(claim.response.status).toBe(201);
    const mediaId = String(claim.body!['media_id']);
    const upload = claim.body!['upload'] as Record<string, unknown>;
    const put = await putBytes(String(upload['url']), String(upload['token']), pngBytes());
    expect(put!.status).toBe(422);
    const status = await handleVoiceMediaRoute(
      new Request(`${BASE}/api/workspaces/${WS}/media/${mediaId}/status`, {
        method: 'GET',
        headers: csrfHeaders(aviCookie),
      }),
      E,
      'req-test',
    );
    expect(status!.status).toBe(200);
    const statusBody = (await status!.json()) as { media: { state: string } };
    expect(statusBody.media.state).toBe('rejected');
  });

  it('rejects oversize and unknown image claims at validation', async () => {
    const oversize = await claimImage('cm_img_big', 'image/png', IMAGE_BOUNDS.MAX_BYTES + 1);
    expect(oversize.response.status).toBe(422);
    const unknown = await claimImage('cm_img_unknown', 'text/plain', 1024);
    expect(unknown.response.status).toBe(422);
  });

  it('pins provider image bounds to the contracts source of truth', () => {
    expect(MAX_IMAGES_PER_MESSAGE).toBe(IMAGE_BOUNDS.MAX_PER_MESSAGE);
    expect([...SUPPORTED_IMAGE_MIMES]).toEqual([...IMAGE_FORMATS]);
  });
});

async function uploadImage(clientMessageId: string, bytes: Uint8Array, contentType: string): Promise<string> {
  const claim = await claimImage(clientMessageId, contentType, bytes.byteLength);
  expect(claim.response.status).toBe(201);
  const upload = claim.body!['upload'] as Record<string, unknown>;
  const put = await putBytes(String(upload['url']), String(upload['token']), bytes);
  expect(put!.status).toBe(200);
  const done = await finalize(String(claim.body!['media_id']));
  expect(done.response.status).toBe(200);
  return String(claim.body!['media_id']);
}

async function outboxIdForRun(runId: string): Promise<string> {
  const row = await E.DB.prepare(
    `SELECT id FROM outbox WHERE json_extract(payload_json, '$.run_id') = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(runId)
    .first<{ id: string }>();
  if (!row) throw new Error(`outbox for run ${runId} missing`);
  return row.id;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('image attachments in the agent turn (workerd, Slice 3)', () => {
  it('records image receipts atomically with acceptance', async () => {
    const first = await uploadImage('cm_s3_a1', pngBytes(), 'image/png');
    const second = await uploadImage('cm_s3_a2', jpegBytes(), 'image/jpeg');
    const accepted = await acceptWebMessage(E.DB, {
      workspaceId: WS,
      chatId: CHAT,
      userId: AVI,
      clientMessageId: 'cm_s3_msg1',
      text: 'What is in these photos?',
      imageMediaIds: [first, second],
    });
    expect(accepted.status).toBe('accepted');

    const links = await E.DB.prepare(
      `SELECT media_id, position FROM message_image_attachments WHERE chat_message_id = ? ORDER BY position ASC`,
    )
      .bind(accepted.message_id)
      .all<{ media_id: string; position: number }>();
    expect((links.results ?? []).map((r) => r.media_id)).toEqual([first, second]);

    const activity = await E.DB.prepare(
      `SELECT payload_json FROM run_activity WHERE workspace_id = ? AND run_id = ? AND type = 'message_accepted'`,
    )
      .bind(WS, accepted.run_id)
      .first<{ payload_json: string }>();
    expect(JSON.parse(String(activity?.payload_json))).toMatchObject({ image_media_ids: [first, second] });
  });

  it('refuses invalid image attachments', async () => {
    // Over the per-message bound, before touching any row.
    await expect(
      acceptWebMessage(E.DB, {
        workspaceId: WS,
        chatId: CHAT,
        userId: AVI,
        clientMessageId: 'cm_s3_over',
        text: 'too many',
        imageMediaIds: ['med_a', 'med_b', 'med_c', 'med_d', 'med_e'],
      }),
    ).rejects.toThrow(/At most 4 images/);

    // Claimed but never finalized: not ready to send.
    const pending = await claimImage('cm_s3_pending', 'image/png', pngBytes().byteLength);
    expect(pending.response.status).toBe(201);
    const pendingRow = await E.DB.prepare(`SELECT id FROM media_objects WHERE workspace_id = ? AND client_message_id = ?`)
      .bind(WS, 'cm_s3_pending')
      .first<{ id: string }>();
    expect(pendingRow?.id).toBeTypeOf('string');
    await expect(
      acceptWebMessage(E.DB, {
        workspaceId: WS,
        chatId: CHAT,
        userId: AVI,
        clientMessageId: 'cm_s3_pending_msg',
        text: 'not ready',
        imageMediaIds: [pendingRow!.id],
      }),
    ).rejects.toThrow(/not ready to send/);

    // Another chat's upload is not available here.
    const now = new Date().toISOString();
    await E.DB.prepare(
      `INSERT OR IGNORE INTO chats (id, workspace_id, author_user_id, title, model_override, is_archived, activity_cursor, created_at, updated_at, last_activity_at)
       VALUES ('chat_img_2', ?, ?, 'Second chat', NULL, 0, 0, ?, ?, ?)`,
    )
      .bind(WS, AVI, now, now, now)
      .run();
    const foreign = await uploadImage('cm_s3_foreign', pngBytes(), 'image/png');
    await E.DB.prepare(`UPDATE media_objects SET chat_id = 'chat_img_2' WHERE id = ?`)
      .bind(foreign)
      .run();
    await expect(
      acceptWebMessage(E.DB, {
        workspaceId: WS,
        chatId: CHAT,
        userId: AVI,
        clientMessageId: 'cm_s3_foreign_msg',
        text: 'foreign',
        imageMediaIds: [foreign],
      }),
    ).rejects.toThrow(/not available for this message/);

    // One upload, one message: double attachment is refused.
    const single = await uploadImage('cm_s3_single', webpBytes(), 'image/webp');
    const firstSend = await acceptWebMessage(E.DB, {
      workspaceId: WS,
      chatId: CHAT,
      userId: AVI,
      clientMessageId: 'cm_s3_single_msg1',
      text: 'first',
      imageMediaIds: [single],
    });
    expect(firstSend.status).toBe('accepted');
    await expect(
      acceptWebMessage(E.DB, {
        workspaceId: WS,
        chatId: CHAT,
        userId: AVI,
        clientMessageId: 'cm_s3_single_msg2',
        text: 'second',
        imageMediaIds: [single],
      }),
    ).rejects.toThrow(/already sent with another message/);

    // Steering runs cannot carry images, mirroring voice notes.
    await expect(
      acceptWebMessage(E.DB, {
        workspaceId: WS,
        chatId: CHAT,
        userId: AVI,
        clientMessageId: 'cm_s3_steer',
        text: 'steer',
        imageMediaIds: [single],
        steerRunId: 'run_steer_fake',
      }),
    ).rejects.toThrow(/running turn/);
  });

  it('carries text plus images through a multi-round turn, once', async () => {
    const png = pngBytes();
    const jpeg = jpegBytes();
    const first = await uploadImage('cm_s3_turn1', png, 'image/png');
    const second = await uploadImage('cm_s3_turn2', jpeg, 'image/jpeg');
    const accepted = await acceptWebMessage(E.DB, {
      workspaceId: WS,
      chatId: CHAT,
      userId: AVI,
      clientMessageId: 'cm_s3_turn_msg',
      text: 'What do these show?',
      imageMediaIds: [first, second],
    });

    const fakeAdapter = new FakeProviderAdapter({
      provider: 'gemini',
      scripts: [
        { kind: 'tool_calls', calls: [{ callId: 'c1', name: 'query', args: { resource: 'entities' } }] },
        { kind: 'text', text: 'Both photos show inventory labels.' },
      ],
    });
    const handler = new AgentHandler({
      providerAdapter: fakeAdapter,
      storage: E.STORAGE,
      limits: { maxDailyActions: 50, maxRoundsPerRun: 10 },
    });
    const result = await dispatchOutboxItem(E.DB, await outboxIdForRun(accepted.run_id), WS, { handler });
    expect(result.status).toBe('completed');

    expect(fakeAdapter.inputs.length).toBeGreaterThanOrEqual(2);
    const openingUsers = fakeAdapter.inputs[0]!.messages.filter((m) => m.role === 'user');
    const opening = openingUsers[openingUsers.length - 1]!;
    expect(opening.text).toContain('What do these show?');
    expect(opening.images).toHaveLength(2);
    expect(opening.images![0]).toEqual({ data: toBase64(png), mimeType: 'image/png' });
    expect(opening.images![1]).toEqual({ data: toBase64(jpeg), mimeType: 'image/jpeg' });

    // Later rounds never re-attach: the opening turn owns the bytes.
    for (const later of fakeAdapter.inputs.slice(1)) {
      expect(later.messages.some((m) => m.images && m.images.length > 0)).toBe(false);
    }

    const reply = await E.DB.prepare(
      `SELECT content_text FROM chat_messages WHERE run_id = ? AND author_kind = 'system'`,
    )
      .bind(accepted.run_id)
      .first<{ content_text: string }>();
    expect(reply?.content_text).toContain('inventory labels');
  });

  it('fails before spend when the pinned model cannot take images', async () => {
    // Acceptance resolves the production registry, where every entry is
    // vision-unverified, so this send queues normally; the run pins the
    // injected unsupported entry and must fail before any provider spend.
    const noVisionEntry: ModelEntry = {
      commandKey: 'novision-test',
      displayName: 'No Vision Fixture',
      provider: 'opencode_go',
      modelId: 'novision-fixture',
      endpointFamily: 'go-chat-completions',
      endpointUrl: 'https://opencode.ai/zen/go/v1/chat/completions',
      approved: true,
      lifecycle: 'active',
      capabilities: {
        text: 'supported',
        tools: 'supported',
        stream: 'supported',
        thoughtSummary: 'unverified',
        audio: 'unsupported',
        vision: 'unsupported',
      },
      trainingUse: 'fixture',
      dataRetention: 'fixture',
      evidenceRef: null,
      verifiedAt: null,
    };
    const registry = createRegistry([noVisionEntry]);
    const now = new Date().toISOString();
    await E.DB.prepare(
      `INSERT INTO workspace_settings (workspace_id, default_model, created_at, updated_at) VALUES (?, 'novision-test', ?, ?)`,
    )
      .bind(WS, now, now)
      .run();

    const mediaId = await uploadImage('cm_s3_blocked', pngBytes(), 'image/png');
    const accepted = await acceptWebMessage(E.DB, {
      workspaceId: WS,
      chatId: CHAT,
      userId: AVI,
      clientMessageId: 'cm_s3_blocked_msg',
      text: 'Look at this.',
      imageMediaIds: [mediaId],
    });
    expect(accepted.status).toBe('accepted');

    let fetches = 0;
    const fetchFn: FetchFn = async () => {
      fetches += 1;
      return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } });
    };
    const handler = new AgentHandler({
      registry,
      platformKeys: { opencode_go: 'test-key' },
      fetchFn,
      storage: E.STORAGE,
      limits: { maxDailyActions: 50, maxRoundsPerRun: 10 },
    });
    const result = await dispatchOutboxItem(E.DB, await outboxIdForRun(accepted.run_id), WS, { handler });
    expect(result.status).toBe('failed');
    expect(fetches).toBe(0);
    const run = await E.DB.prepare(`SELECT status, error_code FROM agent_runs WHERE id = ?`)
      .bind(accepted.run_id)
      .first<{ status: string; error_code: string | null }>();
    expect(run?.status).toBe('failed');
    expect(run?.error_code).toBe('model_unavailable');
  });
});
