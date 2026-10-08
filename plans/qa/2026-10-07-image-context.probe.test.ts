import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../../apps/worker/test/migrations.js';
// Historical characterization of the pre-repair image replay bug. Current
// regression coverage lives in apps/worker/test/media-images.integration.test.ts.
import { AUTH_BOUNDS } from '../../packages/contracts/src/index.ts';
import { FakeProviderAdapter } from '../../packages/agent/src/index.ts';
import { AgentHandler } from '../../apps/worker/src/agent/handler.js';
import { sha256 } from '../../packages/identity/src/index.ts';
import type { Env } from '../../apps/worker/src/index.js';
import { handleVoiceMediaRoute } from '../../apps/worker/src/media/routes.js';
import { acceptWebMessage } from '../../apps/worker/src/inbox/repository.js';
import { dispatchOutboxItem } from '../../apps/worker/src/actor/dispatch.js';

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

describe('image context diagnostic, pre-repair baseline', () => {
  it('reproduces loss on a tool round and a new follow-up while original media remains stored', async () => {
    const photo = await uploadImage('cm_probe_image', pngBytes(), 'image/png');
    const adapter = new FakeProviderAdapter({scripts: [
      {kind:'tool_calls',calls:[{callId:'probe_query',name:'query',args:{resource:'entities'}}]},
      {kind:'text',text:'Synthetic original response.'},
      {kind:'text',text:'Synthetic follow-up response.'},
    ]});
    const handler = new AgentHandler({providerAdapter:adapter,storage:E.STORAGE,limits:{maxDailyActions:50,maxRoundsPerRun:10}});
    const original = await acceptWebMessage(E.DB,{workspaceId:WS,chatId:CHAT,userId:AVI,clientMessageId:'cm_probe_original',text:'What is in this image?',imageMediaIds:[photo]});
    expect((await dispatchOutboxItem(E.DB,await outboxIdForRun(original.run_id),WS,{handler})).status).toBe('completed');
    expect(adapter.inputs).toHaveLength(2);
    const counts = (input) => input.messages.reduce((n,m)=>n+(m.images?.length??0),0);
    expect(counts(adapter.inputs[0])).toBe(1);
    expect(counts(adapter.inputs[1])).toBe(0);
    const followup = await acceptWebMessage(E.DB,{workspaceId:WS,chatId:CHAT,userId:AVI,clientMessageId:'cm_probe_followup',text:'What color is it?'});
    expect((await dispatchOutboxItem(E.DB,await outboxIdForRun(followup.run_id),WS,{handler})).status).toBe('completed');
    expect(adapter.inputs).toHaveLength(3);
    const next = adapter.inputs[2];
    expect(next.messages.some(m=>m.text?.includes('What is in this image?'))).toBe(true);
    expect(next.messages.some(m=>m.text?.includes('Synthetic original response.'))).toBe(true);
    expect(counts(next)).toBe(0);
    expect(next.previousContinuation).toBeNull();
    const media = await E.DB.prepare('SELECT object_key,state FROM media_objects WHERE id = ?').bind(photo).first();
    expect(media.state).toBe('validated');
    expect(await E.STORAGE.head(media.object_key)).toBeTruthy();
    const receipt = await E.DB.prepare('SELECT count(*) AS n FROM message_image_attachments WHERE media_id = ?').bind(photo).first();
    expect(receipt.n).toBe(1);
    console.log(JSON.stringify({openingImages:counts(adapter.inputs[0]),nextToolRoundImages:counts(adapter.inputs[1]),followupImages:counts(next),historicalTextPresent:true,originalImageStillStored:true,followupContinuation:next.previousContinuation}));
  });
});
