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
import { sha256 } from '@otis/identity';
import type { Env } from '../src/index.js';
import { inspectImageBytes } from '../src/media/container.js';
import { handleVoiceMediaRoute } from '../src/media/routes.js';

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
