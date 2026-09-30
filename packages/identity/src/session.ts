/**
 * Session management for Otis.
 * Issues opaque random tokens, stores SHA-256 hashes in D1, handles cookies and CSRF.
 */

import type { Session, User } from '@otis/contracts';
import { AUTH_BOUNDS } from '@otis/contracts';
import { generateRandomToken, sha256 } from './crypto.js';

export interface VerifiedSessionResult {
  session: Session;
  user: User;
}

/**
 * Creates a new session in D1 for a user, returning the raw token and stored session record.
 */
export async function createSession(
  db: D1Database,
  userId: string,
  ttlSeconds: number = AUTH_BOUNDS.SESSION_TTL_SECONDS,
): Promise<{ token: string; session: Session }> {
  const token = generateRandomToken(32);
  const tokenHash = await sha256(token);
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const createdAt = now.toISOString();

  await db
    .prepare(
      `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`
    )
    .bind(id, tokenHash, userId, createdAt, expiresAt, createdAt)
    .run();

  const session: Session = {
    id,
    token_hash: tokenHash,
    user_id: userId,
    created_at: createdAt,
    expires_at: expiresAt,
    revoked_at: null,
    last_seen_at: createdAt,
  };

  return { token, session };
}

/**
 * Verifies an opaque session token against D1.
 * Returns the session and user if valid, or null if expired, revoked, or non-existent.
 */
export async function verifySession(
  db: D1Database,
  token: string,
): Promise<VerifiedSessionResult | null> {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const tokenHash = await sha256(token);
  const nowIso = new Date().toISOString();

  const row = await db
    .prepare(
      `SELECT
         s.id AS s_id,
         s.token_hash AS s_token_hash,
         s.user_id AS s_user_id,
         s.created_at AS s_created_at,
         s.expires_at AS s_expires_at,
         s.revoked_at AS s_revoked_at,
         s.last_seen_at AS s_last_seen_at,
         u.id AS u_id,
         u.firebase_uid AS u_firebase_uid,
         u.email AS u_email,
         u.display_name AS u_display_name,
         u.created_at AS u_created_at,
         u.updated_at AS u_updated_at
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`
    )
    .bind(tokenHash, nowIso)
    .first<Record<string, unknown>>();

  if (!row) {
    return null;
  }

  // Update last_seen_at in background without blocking
  const updateLastSeen = async () => {
    try {
      await db
        .prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
        .bind(nowIso, tokenHash)
        .run();
    } catch {
      // Non-critical background update failure is ignored
    }
  };
  void updateLastSeen();

  const session: Session = {
    id: String(row['s_id']),
    token_hash: String(row['s_token_hash']),
    user_id: String(row['s_user_id']),
    created_at: String(row['s_created_at']),
    expires_at: String(row['s_expires_at']),
    revoked_at: null,
    last_seen_at: nowIso,
  };

  const user: User = {
    id: String(row['u_id']),
    firebase_uid: String(row['u_firebase_uid']),
    email: row['u_email'] ? String(row['u_email']) : null,
    display_name: row['u_display_name'] ? String(row['u_display_name']) : null,
    created_at: String(row['u_created_at']),
    updated_at: String(row['u_updated_at']),
  };

  return { session, user };
}

/**
 * Revokes a session by marking revoked_at in D1.
 */
export async function revokeSession(db: D1Database, token: string): Promise<boolean> {
  if (!token) return false;
  const tokenHash = await sha256(token);
  const nowIso = new Date().toISOString();

  const res = await db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .bind(nowIso, tokenHash)
    .run();

  return (res.meta.changes ?? 0) > 0;
}

/**
 * Formats a Set-Cookie header string for the session.
 */
export function createSessionCookie(
  token: string,
  expiresAtIso: string,
  isSecure = true,
): string {
  const maxAge = Math.max(
    0,
    Math.floor((new Date(expiresAtIso).getTime() - Date.now()) / 1000),
  );
  const secureFlag = isSecure ? ' Secure;' : '';
  return `${AUTH_BOUNDS.COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge};${secureFlag}`;
}

/**
 * Formats a Set-Cookie header to clear the session cookie.
 */
export function clearSessionCookie(isSecure = true): string {
  const secureFlag = isSecure ? ' Secure;' : '';
  return `${AUTH_BOUNDS.COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT;${secureFlag}`;
}

/**
 * Extracts session token from Cookie header or Authorization: Bearer header.
 */
export function extractSessionToken(request: Request): string | null {
  // 1. Check Authorization Bearer header
  const authHeader = request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7).trim();
    if (bearerToken) return bearerToken;
  }

  // 2. Check Cookie header
  const cookieHeader = request.headers.get('cookie');
  if (cookieHeader) {
    const cookies = cookieHeader.split(';');
    for (const cookie of cookies) {
      const [name, ...val] = cookie.trim().split('=');
      if (name === AUTH_BOUNDS.COOKIE_NAME) {
        return val.join('=').trim() || null;
      }
    }
  }

  return null;
}

/**
 * Validates request Origin and mandatory CSRF header for mutating requests (CSRF protection).
 */
export function validateCsrfAndOrigin(request: Request, allowedOrigins?: string[]): boolean {
  const method = request.method.toUpperCase();
  // Safe methods do not require origin check
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true;
  }

  // 1. Enforce mandatory CSRF header as declared in contracts
  const csrfHeader = request.headers.get(AUTH_BOUNDS.CSRF_HEADER);
  if (!csrfHeader || csrfHeader !== '1') {
    return false;
  }

  // 2. Explicit cross-site fetch must be rejected
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite === 'cross-site') {
    return false;
  }

  // 3. Origin check against request origin and allowed list
  const origin = request.headers.get('origin');
  const requestUrl = new URL(request.url);
  const requestOrigin = requestUrl.origin;

  if (origin) {
    if (origin === requestOrigin) {
      return true;
    }
    if (allowedOrigins && allowedOrigins.includes(origin)) {
      return true;
    }
    return false;
  }

  // 4. Fallback to Referer header if Origin is omitted
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      if (
        refererOrigin === requestOrigin ||
        (allowedOrigins && allowedOrigins.includes(refererOrigin))
      ) {
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
}
