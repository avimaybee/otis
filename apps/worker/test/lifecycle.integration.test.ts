import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
// @ts-expect-error vite raw import
import migration0001Sql from '../../../migrations/0001_identity.sql?raw';
// @ts-expect-error vite raw import
import migration0002Sql from '../../../migrations/0002_conversations_sources.sql?raw';
// @ts-expect-error vite raw import
import migration0004Sql from '../../../migrations/0004_lifecycle_settings.sql?raw';
// @ts-expect-error vite raw import
import migration0016Sql from '../../../migrations/0016_brief_next_due.sql?raw';
import { AUTH_BOUNDS } from '@otis/contracts';
import type { HttpErrorResponse } from '@otis/contracts';
import {
  acceptInvite,
  base64UrlEncode,
  createInvite,
  decryptProviderKey,
  decryptWorkspaceCredential,
  importWrappingKey,
  InviteError,
  markCredentialStatus,
  removeMember,
  rotateCredentialWrappingKey,
  setMemberSettings,
  setWorkspaceCredential,
  sha256,
} from '@otis/identity';

const CSRF = {
  origin: 'http://localhost',
  [AUTH_BOUNDS.CSRF_HEADER]: '1',
  'Content-Type': 'application/json',
};

describe('Worker Lifecycle, Settings & Credentials Integration (workerd)', () => {
  const wsA = 'ws-lifecycle-a';
  const wsB = 'ws-lifecycle-b';
  const wsSolo = 'ws-lifecycle-solo';
  const aviId = 'usr_lc_avi';
  const hunorId = 'usr_lc_hunor';
  const elenaId = 'usr_lc_elena';
  const fionaId = 'usr_lc_fiona';
  let aviCookie: string;
  let hunorCookie: string;
  let elenaCookie: string;
  let fionaCookie: string;
  let wrappingKey1: string;
  let wrappingKey2: string;

  async function seedSession(sessionId: string, rawToken: string, userId: string): Promise<string> {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
      .bind(sessionId, await sha256(rawToken), userId, now, expiresAt, now)
      .run();
    return `${AUTH_BOUNDS.COOKIE_NAME}=${rawToken}`;
  }

  beforeAll(async () => {
    for (const sql of [migration0001Sql, migration0002Sql, migration0004Sql, migration0016Sql]) {
      const statements = sql
        .split(';')
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);
      for (const stmt of statements) {
        await env.DB.prepare(stmt).run();
      }
    }

    env.ENVIRONMENT = 'test';
    const k1 = new Uint8Array(32);
    const k2 = new Uint8Array(32);
    crypto.getRandomValues(k1);
    crypto.getRandomValues(k2);
    wrappingKey1 = base64UrlEncode(k1);
    wrappingKey2 = base64UrlEncode(k2);
    env.CREDENTIALS_KEY = wrappingKey1;

    const now = new Date().toISOString();
    for (const [id, fb, email, name] of [
      [aviId, 'fb_lc_avi', 'avi@kerning.test', 'Avi'],
      [hunorId, 'fb_lc_hunor', 'hunor@kerning.test', 'Hunor'],
      [elenaId, 'fb_lc_elena', 'elena@kerning.test', 'Elena'],
      [fionaId, 'fb_lc_fiona', 'fiona@kerning.test', 'Fiona'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, fb, email, name, now, now)
        .run();
    }

    for (const [ws, name, owner] of [
      [wsA, 'Kerning LC', aviId],
      [wsB, 'Second LC', aviId],
      [wsSolo, 'Solo LC', aviId],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
         VALUES (?, ?, ?, 0, 1, ?, ?)`,
      )
        .bind(ws, name, owner, now, now)
        .run();
      await env.DB.prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
         VALUES (?, ?, 'owner', ?, ?, ?)`,
      )
        .bind(ws, owner, now, now, now)
        .run();
    }
    // Hunor joins ws-a, Elena and Fiona join ws-b
    for (const [ws, user] of [
      [wsA, hunorId],
      [wsB, elenaId],
      [wsB, fionaId],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
         VALUES (?, ?, 'member', ?, ?, ?)`,
      )
        .bind(ws, user, now, now, now)
        .run();
    }

    aviCookie = await seedSession('sess_lc_avi', 'lc_token_avi', aviId);
    hunorCookie = await seedSession('sess_lc_hunor', 'lc_token_hunor', hunorId);
    elenaCookie = await seedSession('sess_lc_elena', 'lc_token_elena', elenaId);
    fionaCookie = await seedSession('sess_lc_fiona', 'lc_token_fiona', fionaId);
  });

  it('creates an invite over HTTP with a single-display token', async () => {
    const res = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/invites`, {
      method: 'POST',
      headers: { cookie: aviCookie, ...CSRF },
      body: JSON.stringify({ email: 'newbie@kerning.test' }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { token: string; invite_id: string; expires_at: string };
    expect(data.invite_id).toBeTruthy();
    expect(data.token.length).toBeGreaterThan(20);
    expect(data.expires_at).toBeTruthy();
  });

  it('accepts invites, rejects reuse and email mismatch', async () => {
    const invite = await createInvite(env.DB, {
      workspaceId: wsA,
      invitedEmail: 'elena@kerning.test',
      invitedByUserId: aviId,
    });
    const accepted = await acceptInvite(env.DB, {
      token: invite.token,
      userId: elenaId,
      userEmail: 'elena@kerning.test',
    });
    expect(accepted.workspaceId).toBe(wsA);

    await expect(
      acceptInvite(env.DB, { token: invite.token, userId: elenaId, userEmail: 'elena@kerning.test' }),
    ).rejects.toMatchObject({ code: 'already_accepted' });

    const other = await createInvite(env.DB, {
      workspaceId: wsA,
      invitedEmail: 'someone@else.test',
      invitedByUserId: aviId,
    });
    await expect(
      acceptInvite(env.DB, { token: other.token, userId: elenaId, userEmail: 'elena@kerning.test' }),
    ).rejects.toMatchObject({ code: 'email_mismatch' });
    expect(InviteError).toBeDefined();
  });

  it('lists members for a current member', async () => {
    const res = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/members`, {
      headers: { cookie: hunorCookie },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { members: Array<{ user_id: string; role: string }> };
    expect(data.members.map((m) => m.user_id).sort()).toEqual([aviId, elenaId, hunorId].sort());
    expect(data.members.find((m) => m.user_id === aviId)?.role).toBe('owner');
  });

  it('removes a member, bumps revision, audits, and clears Telegram routing', async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO telegram_users (telegram_user_id, user_id, selected_workspace_id, active_chat_id, created_at, updated_at)
       VALUES ('tg_hunor', ?, ?, NULL, ?, ?)`,
    )
      .bind(hunorId, wsA, now, now)
      .run();

    const before = (await env.DB.prepare(`SELECT membership_revision FROM workspaces WHERE id = ?`)
      .bind(wsA)
      .first<Record<string, unknown>>()) as Record<string, unknown>;

    const res = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/members/${hunorId}/remove`, {
      method: 'POST',
      headers: { cookie: aviCookie, ...CSRF },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { membership_revision: number };
    expect(data.membership_revision).toBe(Number(before['membership_revision']) + 1);

    const tg = await env.DB.prepare(`SELECT selected_workspace_id FROM telegram_users WHERE user_id = ?`)
      .bind(hunorId)
      .first<Record<string, unknown>>();
    expect(tg?.['selected_workspace_id']).toBeNull();

    const audit = await env.DB.prepare(
      `SELECT action, actor_user_id FROM membership_audit WHERE workspace_id = ? AND user_id = ? ORDER BY occurred_at DESC`,
    )
      .bind(wsA, hunorId)
      .first<Record<string, unknown>>();
    expect(audit?.['action']).toBe('removed');
    expect(audit?.['actor_user_id']).toBe(aviId);
  });

  it('denies removed members workspace, member, invite, and chat access', async () => {
    for (const [path, method] of [
      [`/api/workspaces/${wsA}`, 'GET'],
      [`/api/workspaces/${wsA}/members`, 'GET'],
      [`/api/workspaces/${wsA}/invites`, 'POST'],
      [`/api/workspaces/${wsA}/chats`, 'POST'],
    ] as const) {
      const res = await SELF.fetch(`http://localhost${path}`, {
        method,
        headers: { cookie: hunorCookie, ...CSRF, 'Content-Type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ email: 'x@y.test', title: 'x' }) : undefined,
      });
      expect(res.status).toBe(404);
      const err = (await res.json()) as HttpErrorResponse;
      // Denial is what matters; chat routes use a generic not_found code.
      expect(['workspace_not_found', 'not_found']).toContain(err.error.code);
    }
  });

  it('rejects committing writes from a member removed after the route check', async () => {
    // Hunor is currently removed: service-level guards must abort the batch.
    await expect(
      setMemberSettings(env.DB, {
        workspaceId: wsA,
        userId: hunorId,
        actorUserId: hunorId,
        input: { preferred_language: 'hu' },
      }),
    ).rejects.toMatchObject({ code: 'not_member' });

    await expect(
      setWorkspaceCredential(env.DB, {
        workspaceId: wsA,
        provider: 'gemini',
        rawKey: 'sk-should-never-commit',
        wrappingKey: await importWrappingKey(wrappingKey1),
        keyVersion: 99,
        actorUserId: hunorId,
      }),
    ).rejects.toMatchObject({ code: 'not_member' });

    await expect(
      createInvite(env.DB, {
        workspaceId: wsA,
        invitedEmail: 'ghost@kerning.test',
        invitedByUserId: hunorId,
      }),
    ).rejects.toMatchObject({ code: 'not_member' });

    // Nothing was committed: no settings row, no credential, no invite.
    const settings = await env.DB.prepare(
      `SELECT 1 AS ok FROM member_settings WHERE workspace_id = ? AND user_id = ?`,
    )
      .bind(wsA, hunorId)
      .first();
    expect(settings).toBeNull();
    const cred = await env.DB.prepare(
      `SELECT 1 AS ok FROM provider_credentials WHERE workspace_id = ? AND provider = 'gemini'`,
    )
      .bind(wsA)
      .first();
    expect(cred).toBeNull();
    const invite = await env.DB.prepare(`SELECT 1 AS ok FROM invites WHERE invited_email = 'ghost@kerning.test'`).first();
    expect(invite).toBeNull();
  });

  it('forbids removing the owner and leaving as an owner', async () => {
    // Re-add Hunor via a fresh invite
    const invite = await createInvite(env.DB, {
      workspaceId: wsA,
      invitedEmail: 'hunor@kerning.test',
      invitedByUserId: aviId,
    });
    await acceptInvite(env.DB, { token: invite.token, userId: hunorId, userEmail: 'hunor@kerning.test' });

    const removeOwner = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/members/${aviId}/remove`, {
      method: 'POST',
      headers: { cookie: hunorCookie, ...CSRF },
    });
    expect(removeOwner.status).toBe(403);
    expect(((await removeOwner.json()) as HttpErrorResponse).error.code).toBe('cannot_remove_owner');

    const ownerLeave = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/leave`, {
      method: 'POST',
      headers: { cookie: aviCookie, ...CSRF },
    });
    expect(ownerLeave.status).toBe(403);
    expect(((await ownerLeave.json()) as HttpErrorResponse).error.code).toBe('owner_must_transfer');

    const soloLeave = await SELF.fetch(`http://localhost/api/workspaces/${wsSolo}/leave`, {
      method: 'POST',
      headers: { cookie: aviCookie, ...CSRF },
    });
    expect(soloLeave.status).toBe(403);
    expect(((await soloLeave.json()) as HttpErrorResponse).error.code).toBe('owner_must_transfer');
  });

  it('refuses to remove the last remaining member', async () => {
    // Scratch workspace where the owner row is gone: only Hunor remains.
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
       VALUES ('ws-lc-tmp', 'Tmp', ?, 0, 1, ?, ?)`,
    )
      .bind(aviId, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES ('ws-lc-tmp', ?, 'member', ?, ?, ?)`,
    )
      .bind(hunorId, now, now, now)
      .run();
    await expect(
      removeMember(env.DB, { workspaceId: 'ws-lc-tmp', actorUserId: hunorId, targetUserId: hunorId }),
    ).rejects.toMatchObject({ code: 'last_member' });
  });

  it('transfers ownership once; the former owner loses transfer power', async () => {
    const res = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/transfer`, {
      method: 'POST',
      headers: { cookie: aviCookie, ...CSRF },
      body: JSON.stringify({ new_owner_user_id: hunorId }),
    });
    expect(res.status).toBe(200);

    const members = (await (
      await SELF.fetch(`http://localhost/api/workspaces/${wsA}/members`, {
        headers: { cookie: aviCookie },
      })
    ).json()) as { members: Array<{ user_id: string; role: string }> };
    expect(members.members.find((m) => m.user_id === hunorId)?.role).toBe('owner');
    expect(members.members.find((m) => m.user_id === aviId)?.role).toBe('member');

    const again = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/transfer`, {
      method: 'POST',
      headers: { cookie: aviCookie, ...CSRF },
      body: JSON.stringify({ new_owner_user_id: aviId }),
    });
    expect(again.status).toBe(403);
    expect(((await again.json()) as HttpErrorResponse).error.code).toBe('not_owner');
  });

  it('serializes concurrent removals: exactly one applies', async () => {
    const results = await Promise.allSettled([
      removeMember(env.DB, { workspaceId: wsA, actorUserId: hunorId, targetUserId: elenaId }),
      removeMember(env.DB, { workspaceId: wsA, actorUserId: hunorId, targetUserId: elenaId }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as { code: string };
    expect(['target_not_member', 'concurrent_change']).toContain(reason.code);

    // Re-add Elena for later tests
    const invite = await createInvite(env.DB, {
      workspaceId: wsA,
      invitedEmail: 'elena@kerning.test',
      invitedByUserId: hunorId,
    });
    await acceptInvite(env.DB, { token: invite.token, userId: elenaId, userEmail: 'elena@kerning.test' });

    // Re-added member can read again
    const relist = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/members`, {
      headers: { cookie: elenaCookie },
    });
    expect(relist.status).toBe(200);
  });

  it('stores a credential write-only and reports status-only metadata', async () => {
    const rawKey = 'sk-test-gemini-key-001';
    const put = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/credentials/gemini`, {
      method: 'PUT',
      headers: { cookie: aviCookie, ...CSRF },
      body: JSON.stringify({ key: rawKey }),
    });
    expect(put.status).toBe(200);
    const putText = await put.text();
    expect(putText).not.toContain(rawKey);
    expect(putText).not.toContain('encrypted_key');
    const putData = JSON.parse(putText) as { credential: { status: string; key_version: number } };
    expect(putData.credential.status).toBe('unverified');
    expect(putData.credential.key_version).toBe(1);

    const stored = await env.DB.prepare(
      `SELECT encrypted_key, key_nonce FROM provider_credentials WHERE workspace_id = ? AND provider = 'gemini'`,
    )
      .bind(wsA)
      .first<Record<string, unknown>>();
    expect(String(stored?.['encrypted_key'])).not.toContain(rawKey);

    const status = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/credentials/gemini`, {
      headers: { cookie: aviCookie },
    });
    expect(status.status).toBe(200);
    const statusText = await status.text();
    expect(statusText).not.toContain(rawKey);
  });

  it('rejects unknown providers and missing wrapping-key configuration', async () => {
    const unknown = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/credentials/nope`, {
      method: 'PUT',
      headers: { cookie: aviCookie, ...CSRF },
      body: JSON.stringify({ key: 'x' }),
    });
    expect(unknown.status).toBe(404);

    const saved = env.CREDENTIALS_KEY;
    env.CREDENTIALS_KEY = undefined as unknown as string;
    const misconfigured = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/credentials/gemini`, {
      method: 'PUT',
      headers: { cookie: aviCookie, ...CSRF },
      body: JSON.stringify({ key: 'x' }),
    });
    expect(misconfigured.status).toBe(500);
    expect(((await misconfigured.json()) as HttpErrorResponse).error.code).toBe('server_misconfigured');
    env.CREDENTIALS_KEY = saved;
  });

  it('rotates the wrapping key via the operator procedure and isolates workspaces', async () => {
    await markCredentialStatus(env.DB, { workspaceId: wsA, provider: 'gemini', status: 'available' });

    // Rotation is a package-level operator procedure, not a member API route:
    // the rotate endpoint no longer exists.
    const unknownRoute = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/credentials/gemini/rotate`, {
      method: 'POST',
      headers: { cookie: aviCookie, ...CSRF },
      body: JSON.stringify({ old_wrapping_key: wrappingKey1, new_wrapping_key: wrappingKey2 }),
    });
    expect(unknownRoute.status).toBe(404);

    const rotated = await rotateCredentialWrappingKey(env.DB, {
      workspaceId: wsA,
      provider: 'gemini',
      oldWrappingKey: await importWrappingKey(wrappingKey1),
      newWrappingKey: await importWrappingKey(wrappingKey2),
      newKeyVersion: 2,
      actorUserId: aviId,
    });
    expect(rotated.key_version).toBe(2);
    expect(rotated.status).toBe('available');

    // The re-wrapped key still decrypts under the new wrapping key.
    const { rawKey } = await decryptWorkspaceCredential(env.DB, {
      workspaceId: wsA,
      provider: 'gemini',
      wrappingKey: await importWrappingKey(wrappingKey2),
    });
    expect(rawKey).toBe('sk-test-gemini-key-001');

    // Cross-workspace ciphertext is useless: AAD binds workspace at both ends.
    const row = await env.DB.prepare(
      `SELECT encrypted_key, key_nonce, key_version FROM provider_credentials
       WHERE workspace_id = ? AND provider = 'gemini'`,
    )
      .bind(wsA)
      .first<Record<string, unknown>>();
    await expect(
      decryptProviderKey(await importWrappingKey(wrappingKey2), {
        workspaceId: wsB,
        provider: 'gemini',
        keyVersion: Number(row?.['key_version']),
        ciphertext_b64: String(row?.['encrypted_key']),
        nonce_b64: String(row?.['key_nonce']),
      }),
    ).rejects.toMatchObject({ code: 'decrypt_failed' });

    // A missing row reports not-found, never a decryption oracle.
    await expect(
      decryptWorkspaceCredential(env.DB, {
        workspaceId: wsB,
        provider: 'gemini',
        wrappingKey: await importWrappingKey(wrappingKey2),
      }),
    ).rejects.toMatchObject({ code: 'credential_not_found' });

    // Rotation with the wrong old key leaves the stored row untouched
    await expect(
      rotateCredentialWrappingKey(env.DB, {
        workspaceId: wsA,
        provider: 'gemini',
        oldWrappingKey: await importWrappingKey(wrappingKey1),
        newWrappingKey: await importWrappingKey(wrappingKey1),
        newKeyVersion: 3,
        actorUserId: aviId,
      }),
    ).rejects.toMatchObject({ code: 'decrypt_failed' });
    const version = await env.DB.prepare(
      `SELECT key_version FROM provider_credentials WHERE workspace_id = ? AND provider = 'gemini'`,
    )
      .bind(wsA)
      .first<Record<string, unknown>>();
    expect(Number(version?.['key_version'])).toBe(2);
  });

  it('keeps briefs disabled until a complete schedule is chosen', async () => {
    const initial = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/me/settings`, {
      headers: { cookie: hunorCookie },
    });
    expect(initial.status).toBe(200);
    expect(((await initial.json()) as { settings: { brief_enabled: boolean } }).settings.brief_enabled).toBe(false);

    const incomplete = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/me/settings`, {
      method: 'PUT',
      headers: { cookie: hunorCookie, ...CSRF },
      body: JSON.stringify({ brief_enabled: true }),
    });
    expect(incomplete.status).toBe(422);
    expect(((await incomplete.json()) as HttpErrorResponse).error.code).toBe('brief_incomplete');

    // A schedule without an explicit channel choice is still incomplete.
    const noChannel = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/me/settings`, {
      method: 'PUT',
      headers: { cookie: hunorCookie, ...CSRF },
      body: JSON.stringify({
        brief_enabled: true,
        brief_local_time: '08:30',
        brief_timezone: 'Europe/Bucharest',
        brief_weekdays: [1, 2, 3, 4, 5],
      }),
    });
    expect(noChannel.status).toBe(422);
    expect(((await noChannel.json()) as HttpErrorResponse).error.code).toBe('brief_incomplete');

    const badTz = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/me/settings`, {
      method: 'PUT',
      headers: { cookie: hunorCookie, ...CSRF },
      body: JSON.stringify({ brief_timezone: 'Not/AZone' }),
    });
    expect(badTz.status).toBe(422);

    const complete = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/me/settings`, {
      method: 'PUT',
      headers: { cookie: hunorCookie, ...CSRF },
      body: JSON.stringify({
        brief_enabled: true,
        brief_local_time: '08:30',
        brief_timezone: 'Europe/Bucharest',
        brief_weekdays: [1, 2, 3, 4, 5],
        brief_channel: 'telegram',
        preferred_language: 'ro',
      }),
    });
    expect(complete.status).toBe(200);
    const saved = (await complete.json()) as {
      settings: { brief_enabled: boolean; brief_local_time: string; brief_weekdays: number[] };
    };
    expect(saved.settings.brief_enabled).toBe(true);
    expect(saved.settings.brief_local_time).toBe('08:30');
    expect(saved.settings.brief_weekdays).toEqual([1, 2, 3, 4, 5]);

    const audit = await env.DB.prepare(
      `SELECT scope FROM settings_audit WHERE workspace_id = ? AND user_id = ? ORDER BY occurred_at DESC`,
    )
      .bind(wsA, hunorId)
      .first<Record<string, unknown>>();
    expect(audit?.['scope']).toBe('member');
  });

  it('stores the shared default model and isolates workspaces', async () => {
    const initial = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/settings`, {
      headers: { cookie: aviCookie },
    });
    expect(initial.status).toBe(200);
    expect(((await initial.json()) as { settings: { default_model: string | null } }).settings.default_model).toBeNull();

    // Plan 005 validates defaults against the operator registry: unknown
    // keys are rejected and never stored.
    const update = await SELF.fetch(`http://localhost/api/workspaces/${wsA}/settings`, {
      method: 'PUT',
      headers: { cookie: aviCookie, ...CSRF },
      body: JSON.stringify({ default_model: 'gemini-3-flash' }),
    });
    expect(update.status).toBe(422);
    expect(((await update.json()) as HttpErrorResponse).error.code).toBe('invalid_model');

    // Fiona belongs to ws-b only: ws-a lifecycle, settings, and credentials are invisible.
    // (Elena joined ws-a mid-suite, so she cannot serve as the isolation probe.)
    for (const [path, method] of [
      [`/api/workspaces/${wsA}/settings`, 'GET'],
      [`/api/workspaces/${wsA}/me/settings`, 'PUT'],
      [`/api/workspaces/${wsA}/members`, 'GET'],
      [`/api/workspaces/${wsA}/credentials/gemini`, 'GET'],
    ] as const) {
      const res = await SELF.fetch(`http://localhost${path}`, {
        method,
        headers: { cookie: fionaCookie, ...CSRF, 'Content-Type': 'application/json' },
        body: method === 'PUT' ? JSON.stringify({ preferred_language: 'hu' }) : undefined,
      });
      expect(res.status).toBe(404);
    }
  });
});
