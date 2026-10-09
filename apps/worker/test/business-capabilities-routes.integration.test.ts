// HTTP transport fixtures have their own Worker instance, separate from
// projection/cleanup fixtures. Every response body is drained before teardown.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { DEFAULT_COMMAND_HANDLERS, executeLedgerCommand, type LedgerCommandContext } from '@otis/ledger';
import { AUTH_BOUNDS, type EntityFile } from '@otis/contracts';
import { sha256 } from '@otis/identity';
import { applyMigrations } from './migrations.js';

const user = 'capabilities_member';
let workspace: string, source: string, chat: string;
beforeAll(async () => {
  await applyMigrations(env.DB);
  await env.DB.prepare(
    "INSERT INTO users(id, firebase_uid, display_name, created_at, updated_at) VALUES (?, ?, 'Member', '2026-10-01', '2026-10-01')",
  )
    .bind(user, user)
    .run();
});
beforeEach(async () => {
  workspace = crypto.randomUUID();
  source = crypto.randomUUID();
  chat = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO workspaces(id, name, owner_user_id, created_at, updated_at) VALUES (?, 'Capabilities', ?, '2026-10-01', '2026-10-01')",
  )
    .bind(workspace, user)
    .run();
  await env.DB.prepare(
    "INSERT INTO workspace_users(workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'owner', '2026-10-01', '2026-10-01', '2026-10-01')",
  )
    .bind(workspace, user)
    .run();
  await env.DB.prepare(
    "INSERT INTO chats(id, workspace_id, author_user_id, title, created_at, updated_at, last_activity_at) VALUES (?, ?, ?, 'A conversation', '2026-10-01', '2026-10-01', '2026-10-01')",
  )
    .bind(chat, workspace, user)
    .run();
  await env.DB.prepare(
    "INSERT INTO messages_in(id, workspace_id, user_id, chat_id, channel, external_id, payload_fingerprint, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'web', ?, 'synthetic', 'processed', '2026-10-01', '2026-10-01')",
  )
    .bind(source, workspace, user, chat, source)
    .run();
});
async function context(): Promise<LedgerCommandContext> {
  const meta = await env.DB.prepare('SELECT business_revision FROM workspaces WHERE id = ?')
    .bind(workspace)
    .first<{ business_revision: number }>();
  return {
    workspace_id: workspace,
    actor: { kind: 'member', user_id: user },
    source_message_id: source,
    membership_revision: 1,
    request_id: crypto.randomUUID(),
    action_id: crypto.randomUUID(),
    expected_business_revision: meta!.business_revision,
  };
}
const command = async (name: string, args: unknown) =>
  executeLedgerCommand(env.DB, await context(), name, args, DEFAULT_COMMAND_HANDLERS[name]!);
async function authenticated(path: string, init: RequestInit = {}) {
  const token = crypto.randomUUID(),
    now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions(id, token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(
      crypto.randomUUID(),
      await sha256(token),
      user,
      now,
      new Date(Date.now() + 3600000).toISOString(),
      now,
    )
    .run();
  const headers = new Headers(init.headers);
  headers.set('cookie', `${AUTH_BOUNDS.COOKIE_NAME}=${token}`);
  headers.set('origin', 'http://localhost');
  headers.set(AUTH_BOUNDS.CSRF_HEADER, '1');
  return SELF.fetch(`http://localhost/api/workspaces/${workspace}${path}`, { ...init, headers });
}
async function responseStatus(response: Response) {
  await response.arrayBuffer();
  return response.status;
}
async function entity(name: string) {
  const result = await command('create_entity', { name, kind: 'lead', initial_status: 'warm' });
  expect(result.status).toBe('applied');
  return (result.data as { entity_id: string }).entity_id;
}
describe('business file HTTP routes', () => {
  it('enforces authentication, selected-client ownership and stale heads at the actual file routes', async () => {
    const selected = await entity('Quiet Maple'),
      other = await entity('Copper Forge');
    const entry = await command('log_event', {
      entity_id: other,
      kind: 'note',
      payload: { text: 'Foreign client entry' },
    });
    const path = `/entities/${selected}/actions`,
      revision = (await context()).expected_business_revision;
    const edit = {
      command: 'remove_interaction',
      args: { interaction_id: entry.event_ids![0], expected_head_event_id: entry.event_ids![0] },
      operation_id: crypto.randomUUID(),
      expected_revision: revision,
    };
    expect(
      await responseStatus(
        await SELF.fetch(`http://localhost/api/workspaces/${workspace}/entities/${selected}/file`),
      ),
    ).toBe(401);
    expect(
      await responseStatus(
        await authenticated(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(edit),
        }),
      ),
    ).toBe(404);
    expect((await context()).expected_business_revision).toBe(revision);
    const read = await authenticated(`/entities/${other}/file`);
    expect(read.status).toBe(200);
    expect((await read.json<EntityFile>()).notes.total).toBe(1);
    const stale = await authenticated(`/entities/${other}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...edit,
        args: { ...edit.args, expected_head_event_id: 'a-stale-head' },
      }),
    });
    expect(await responseStatus(stale)).toBe(409);
  });
  it('uploads a private PDF once, rejects altered/expired retries and blocks a revoked member', async () => {
    const id = crypto.randomUUID(),
      headers = {
        'content-type': 'application/pdf',
        'x-upload-id': id,
        'x-filename': encodeURIComponent('Offer.pdf'),
      },
      body = '%PDF-1.7\nSynthetic transport fixture';
    const upload = () => authenticated('/documents/uploads', { method: 'POST', headers, body });
    expect(await responseStatus(await upload())).toBe(201);
    expect(await responseStatus(await upload())).toBe(200);
    const original = await authenticated(`/media/${id}`);
    expect(original.status).toBe(200);
    expect(original.headers.get('content-type')).toBe('application/pdf');
    expect(new TextDecoder().decode(await original.arrayBuffer())).toBe(body);
    expect(
      await responseStatus(
        await authenticated('/documents/uploads', {
          method: 'POST',
          headers,
          body: `${body} altered`,
        }),
      ),
    ).toBe(409);
    await env.DB.prepare("UPDATE media_objects SET expires_at = '2000-01-01' WHERE id = ?")
      .bind(id)
      .run();
    expect(await responseStatus(await upload())).toBe(409);
    await env.DB.prepare('DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?')
      .bind(workspace, user)
      .run();
    expect(await responseStatus(await upload())).toBe(404);
  });
});
