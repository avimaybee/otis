import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
// @ts-expect-error vite raw import
import migrationSql from '../../../migrations/0001_identity.sql?raw';
import type {
  AuthSessionResponse,
  MeResponse,
  HttpErrorResponse,
} from '@otis/contracts';
import { AUTH_BOUNDS } from '@otis/contracts';
import {
  base64UrlEncode,
  createInvite,
  sha256,
  buildWorkspaceContext,
} from '@otis/identity';

describe('Worker Identity & Session Integration (workerd runtime)', () => {
  let rsaPrivateKey: CryptoKey;
  let testKid: string;
  let projectId: string;

  beforeAll(async () => {
    // 1. Apply the ACTUAL shipped migration directly from disk via Vite ?raw import

    // Split SQL by semicolon, clean comments and empty lines
    const statements = migrationSql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      await env.DB.prepare(stmt).run();
    }

    // 2. Generate RSA Keypair for Web-Crypto token verification
    testKid = 'worker-test-kid';
    projectId = 'otis-test';

    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );

    rsaPrivateKey = keyPair.privateKey;
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

    // Inject test configuration into Worker env bindings
    env.ENVIRONMENT = 'test';
    env.FIREBASE_PROJECT_ID = projectId;
    env.BOOTSTRAP_WORKSPACE_ID = 'ws-kerning';
    env.BOOTSTRAP_WORKSPACE_NAME = 'Kerning';
    env.BOOTSTRAP_OWNER_UID = 'uid-avi';
    env.TEST_JWKS = JSON.stringify({
      keys: [
        {
          kty: publicJwk.kty ?? 'RSA',
          n: publicJwk.n ?? '',
          e: publicJwk.e ?? '',
          kid: testKid,
          alg: 'RS256',
          use: 'sig',
        },
      ],
    });
  });

  async function createSignedToken(claims: {
    uid: string;
    email: string;
    name?: string;
    exp?: number;
    iat?: number | string;
    auth_time?: number | string;
    email_verified?: boolean;
    signInProvider?: string;
    omitSignInProvider?: boolean;
    aud?: string;
    iss?: string;
    corrupt?: boolean;
  }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = {
      alg: 'RS256',
      kid: testKid,
      typ: 'JWT',
    };

    const payload: Record<string, unknown> = {
      iss: claims.iss ?? `https://securetoken.google.com/${projectId}`,
      aud: claims.aud ?? projectId,
      auth_time: claims.auth_time !== undefined ? claims.auth_time : now - 5,
      sub: claims.uid,
      iat: claims.iat !== undefined ? claims.iat : now - 5,
      exp: claims.exp !== undefined ? claims.exp : now + 3600,
      email: claims.email,
      email_verified: claims.email_verified !== undefined ? claims.email_verified : true,
      name: claims.name ?? 'Avi',
      firebase: claims.omitSignInProvider
        ? {}
        : {
            sign_in_provider: claims.signInProvider ?? 'google.com',
          },
    };

    const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
    const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
    const dataToSign = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

    const signatureBuf = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      rsaPrivateKey,
      dataToSign as unknown as BufferSource,
    );

    let signatureBytes = new Uint8Array(signatureBuf);
    if (claims.corrupt) {
      signatureBytes = new Uint8Array(signatureBytes);
      signatureBytes[0] = (signatureBytes[0] ?? 0) ^ 0xff;
    }

    return `${headerB64}.${payloadB64}.${base64UrlEncode(signatureBytes)}`;
  }

  it('ID-01: Rejects forged, expired, or invalid Firebase ID tokens with 401', async () => {
    // 1. Forged signature
    const forgedToken = await createSignedToken({
      uid: 'attacker',
      email: 'attacker@evil.com',
      corrupt: true,
    });

    const resForged = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://localhost',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
      body: JSON.stringify({ id_token: forgedToken }),
    });
    expect(resForged.status).toBe(401);
    const forgedJson = (await resForged.json()) as HttpErrorResponse;
    expect(forgedJson.error.code).toBe('auth_invalid_signature');

    // 2. Expired token
    const now = Math.floor(Date.now() / 1000);
    const expiredToken = await createSignedToken({
      uid: 'uid-old',
      email: 'old@kerning.studio',
      exp: now - 100,
    });

    const resExpired = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://localhost',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
      body: JSON.stringify({ id_token: expiredToken }),
    });
    expect(resExpired.status).toBe(401);
    const expiredJson = (await resExpired.json()) as HttpErrorResponse;
    expect(expiredJson.error.code).toBe('auth_expired');

    // 3. Missing / non-numeric iat claim
    const invalidIatToken = await createSignedToken({
      uid: 'uid-invalid-iat',
      email: 'invalid@kerning.studio',
      iat: 'not-a-number',
    });

    const resInvalidIat = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://localhost',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
      body: JSON.stringify({ id_token: invalidIatToken }),
    });
    expect(resInvalidIat.status).toBe(401);
    const invalidIatJson = (await resInvalidIat.json()) as HttpErrorResponse;
    expect(invalidIatJson.error.code).toBe('auth_invalid_format');

    // 4. Unverified email -> 403
    const unverifiedToken = await createSignedToken({
      uid: 'uid-unverified',
      email: 'unverified@kerning.studio',
      email_verified: false,
    });
    const resUnverified = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://localhost',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
      body: JSON.stringify({ id_token: unverifiedToken }),
    });
    expect(resUnverified.status).toBe(403);
    const unverifiedJson = (await resUnverified.json()) as HttpErrorResponse;
    expect(unverifiedJson.error.code).toBe('unverified_email');

    // 5. Non-Google sign-in provider -> 403
    const passwordToken = await createSignedToken({
      uid: 'uid-pwd',
      email: 'pwd@kerning.studio',
      signInProvider: 'password',
    });
    const resPwd = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://localhost',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
      body: JSON.stringify({ id_token: passwordToken }),
    });
    expect(resPwd.status).toBe(403);
    const pwdJson = (await resPwd.json()) as HttpErrorResponse;
    expect(pwdJson.error.code).toBe('invalid_auth_provider');

    // 6. Absent sign-in provider -> 403
    const noProviderToken = await createSignedToken({
      uid: 'uid-no-provider',
      email: 'noprovider@kerning.studio',
      omitSignInProvider: true,
    });
    const resNoProvider = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://localhost',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
      body: JSON.stringify({ id_token: noProviderToken }),
    });
    expect(resNoProvider.status).toBe(403);
    const noProviderJson = (await resNoProvider.json()) as HttpErrorResponse;
    expect(noProviderJson.error.code).toBe('invalid_auth_provider');
  });

  it('CSRF: Rejects mutations without x-otis-csrf header or with cross-origin', async () => {
    const validToken = await createSignedToken({
      uid: 'uid-avi',
      email: 'avi@kerning.studio',
    });

    // 1. Missing x-otis-csrf header -> 403
    const resNoHeader = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify({ id_token: validToken }),
    });
    expect(resNoHeader.status).toBe(403);
    const jsonNoHeader = (await resNoHeader.json()) as HttpErrorResponse;
    expect(jsonNoHeader.error.code).toBe('csrf_violation');

    // 2. Cross-origin request -> 403
    const resCrossOrigin = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'https://malicious-site.com',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
      body: JSON.stringify({ id_token: validToken }),
    });
    expect(resCrossOrigin.status).toBe(403);
    const jsonCross = (await resCrossOrigin.json()) as HttpErrorResponse;
    expect(jsonCross.error.code).toBe('csrf_violation');
  });

  it('Bootstrap Scoping: Non-owner UID cannot bootstrap workspace or obtain ownership', async () => {
    // Attempt sign-in with non-owner UID
    const nonOwnerToken = await createSignedToken({
      uid: 'uid-random-user',
      email: 'random@example.com',
      name: 'Random User',
    });

    const res = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://localhost',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
      body: JSON.stringify({ id_token: nonOwnerToken }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as AuthSessionResponse;
    // Must NOT have received ownership of ws-kerning
    expect(data.workspaces).toHaveLength(0);

    // Verify in D1 that ws-kerning was not created by this user
    const ws = await env.DB.prepare('SELECT id FROM workspaces WHERE id = ?')
      .bind('ws-kerning')
      .first();
    expect(ws).toBeNull();
  });

  it('signs in Avi, bootstraps Kerning workspace with initial membership_revision=1, hashes session in D1', async () => {
    const validToken = await createSignedToken({
      uid: 'uid-avi',
      email: 'avi@kerning.studio',
      name: 'Avi',
    });

    const res = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://localhost',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
      body: JSON.stringify({ id_token: validToken }),
    });

    expect(res.status).toBe(200);
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('otis_session=');
    expect(setCookie).toContain('HttpOnly');

    const data = (await res.json()) as AuthSessionResponse;
    expect(data.status).toBe('ok');
    expect(data.user.firebase_uid).toBe('uid-avi');
    expect(data.workspaces).toHaveLength(1);
    expect(data.workspaces[0]?.id).toBe('ws-kerning');
    expect(data.workspaces[0]?.role).toBe('owner');

    // Extract session token from cookie
    const tokenMatch = setCookie?.match(/otis_session=([^;]+)/);
    const sessionToken = tokenMatch?.[1];
    expect(sessionToken).toBeDefined();

    // Verify raw session token is NEVER stored in D1, only its SHA-256 hash!
    const tokenHash = await sha256(sessionToken!);
    const dbSession = await env.DB.prepare(
      'SELECT id, token_hash, user_id FROM sessions WHERE token_hash = ?',
    )
      .bind(tokenHash)
      .first<Record<string, unknown>>();

    expect(dbSession).toBeDefined();
    expect(dbSession?.['token_hash']).toBe(tokenHash);

    // Verify workspace membership_revision is 1
    const wsRow = await env.DB.prepare('SELECT membership_revision FROM workspaces WHERE id = ?')
      .bind('ws-kerning')
      .first<{ membership_revision: number }>();
    expect(wsRow?.membership_revision).toBe(1);

    // Verify buildWorkspaceContext returns true membership_revision = 1
    const aviUser = await env.DB.prepare('SELECT id FROM users WHERE firebase_uid = ?')
      .bind('uid-avi')
      .first<{ id: string }>();
    const context = await buildWorkspaceContext(env.DB, {
      workspaceId: 'ws-kerning',
      userId: aviUser!.id,
      requestId: 'req-1',
    });
    expect(context.membership_revision).toBe(1);
  });

  it('GET /api/me resolves current user and workspaces using session cookie', async () => {
    const token = await createSignedToken({
      uid: 'uid-avi',
      email: 'avi@kerning.studio',
      name: 'Avi',
    });

    const authRes = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://localhost',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
      body: JSON.stringify({ id_token: token }),
    });

    const setCookie = authRes.headers.get('Set-Cookie')!;
    const cookie = setCookie.split(';')[0]!;

    const meRes = await SELF.fetch('http://localhost/api/me', {
      headers: { cookie },
    });

    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as MeResponse;
    expect(me.user.firebase_uid).toBe('uid-avi');
    expect(me.workspaces[0]?.id).toBe('ws-kerning');
  });

  it('DELETE /api/auth/session revokes session and subsequent requests return 401', async () => {
    const token = await createSignedToken({
      uid: 'uid-avi',
      email: 'avi@kerning.studio',
    });

    const authRes = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://localhost',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
      body: JSON.stringify({ id_token: token }),
    });

    const setCookie = authRes.headers.get('Set-Cookie')!;
    const cookie = setCookie.split(';')[0]!;

    const logoutRes = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'DELETE',
      headers: {
        cookie,
        origin: 'http://localhost',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
    });

    expect(logoutRes.status).toBe(200);

    const meRes = await SELF.fetch('http://localhost/api/me', {
      headers: { cookie },
    });
    expect(meRes.status).toBe(401);
  });

  it('Invites: enforces email_verified, google.com provider, and atomic exactly-once redemption', async () => {
    const aviUser = await env.DB.prepare('SELECT id FROM users WHERE firebase_uid = ?')
      .bind('uid-avi')
      .first<{ id: string }>();
    expect(aviUser).toBeDefined();

    const { token: inviteToken } = await createInvite(env.DB, {
      workspaceId: 'ws-kerning',
      invitedEmail: 'hunor@kerning.studio',
      invitedByUserId: aviUser!.id,
    });

    // 1. Rejection: Account with unverified email
    const unverifiedEmailToken = await createSignedToken({
      uid: 'uid-hunor-unverified',
      email: 'hunor@kerning.studio',
      email_verified: false,
    });

    const resUnverified = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://localhost',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
      body: JSON.stringify({
        id_token: unverifiedEmailToken,
        invite_token: inviteToken,
      }),
    });
    expect(resUnverified.status).toBe(403);
    const unverifiedJson = (await resUnverified.json()) as HttpErrorResponse;
    expect(unverifiedJson.error.code).toBe('unverified_email');

    // 2. Rejection: Non-Google sign-in provider (e.g. password or phone)
    const passwordToken = await createSignedToken({
      uid: 'uid-hunor-pwd',
      email: 'hunor@kerning.studio',
      signInProvider: 'password',
    });

    const resNonGoogle = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://localhost',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
      body: JSON.stringify({
        id_token: passwordToken,
        invite_token: inviteToken,
      }),
    });
    expect(resNonGoogle.status).toBe(403);
    const nonGoogleJson = (await resNonGoogle.json()) as HttpErrorResponse;
    expect(nonGoogleJson.error.code).toBe('invalid_auth_provider');

    // 2b. Rejection: Absent sign-in provider claim
    const absentProviderToken = await createSignedToken({
      uid: 'uid-hunor-no-provider',
      email: 'hunor@kerning.studio',
      omitSignInProvider: true,
    });

    const resAbsentProvider = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://localhost',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
      body: JSON.stringify({
        id_token: absentProviderToken,
        invite_token: inviteToken,
      }),
    });
    expect(resAbsentProvider.status).toBe(403);
    const absentProviderJson = (await resAbsentProvider.json()) as HttpErrorResponse;
    expect(absentProviderJson.error.code).toBe('invalid_auth_provider');

    // 3. Successful redemption with verified Google account
    const hunorToken = await createSignedToken({
      uid: 'uid-hunor',
      email: 'hunor@kerning.studio',
      name: 'Hunor',
      email_verified: true,
      signInProvider: 'google.com',
    });

    const resHunor = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://localhost',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
      body: JSON.stringify({
        id_token: hunorToken,
        invite_token: inviteToken,
      }),
    });

    expect(resHunor.status).toBe(200);
    const hunorData = (await resHunor.json()) as AuthSessionResponse;
    expect(hunorData.workspaces[0]?.id).toBe('ws-kerning');
    expect(hunorData.workspaces[0]?.role).toBe('member');

    // Verify that membership_revision was incremented from 1 to 2
    const wsRow = await env.DB.prepare('SELECT membership_revision FROM workspaces WHERE id = ?')
      .bind('ws-kerning')
      .first<{ membership_revision: number }>();
    expect(wsRow?.membership_revision).toBe(2);

    // Verify invite_redemptions table has the guard record
    const redemption = await env.DB.prepare('SELECT * FROM invite_redemptions')
      .first<Record<string, unknown>>();
    expect(redemption).toBeDefined();
    expect(redemption?.['guard_ok']).toBe(1);

    // 4. Atomic exactly-once check: Reused invite fails atomically with 409
    const resReused = await SELF.fetch('http://localhost/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://localhost',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
      body: JSON.stringify({
        id_token: hunorToken,
        invite_token: inviteToken,
      }),
    });
    expect(resReused.status).toBe(409);
    const reusedJson = (await resReused.json()) as HttpErrorResponse;
    expect(reusedJson.error.code).toBe('already_accepted');
  });
});
