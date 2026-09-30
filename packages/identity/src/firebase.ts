/**
 * Firebase ID Token verifier for Cloudflare Workers using Web Crypto API.
 * Follows official Google/Firebase specifications:
 * https://firebase.google.com/docs/auth/admin/verify-id-tokens
 */

import { base64UrlDecode } from './crypto.js';

export interface FirebaseTokenClaims {
  uid: string;
  email: string | null;
  email_verified: boolean;
  name: string | null;
  picture: string | null;
  signInProvider: string | null;
  iss: string;
  aud: string;
  auth_time: number;
  sub: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

export type FirebaseErrorCode =
  | 'invalid_format'
  | 'invalid_header'
  | 'key_not_found'
  | 'invalid_signature'
  | 'expired'
  | 'issued_in_future'
  | 'wrong_audience'
  | 'wrong_issuer'
  | 'missing_subject'
  | 'network_error';

export class FirebaseTokenError extends Error {
  public readonly code: FirebaseErrorCode;

  constructor(code: FirebaseErrorCode, message: string) {
    super(message);
    this.name = 'FirebaseTokenError';
    this.code = code;
  }
}

export interface JwkKey {
  kty: string;
  use?: string;
  alg?: string;
  n: string;
  e: string;
  kid: string;
}

export interface JwksResponse {
  keys: JwkKey[];
}

export interface FirebaseVerifierOptions {
  projectId: string;
  clockSkewSeconds?: number;
  customJwks?: JwksResponse;
  now?: () => number; // Unix timestamp in seconds
}

const GOOGLE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const MAX_STALE_KEY_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

let cachedJwks: { keys: JwkKey[]; expiresAt: number } | null = null;
let lastFetchAttempt = 0;

/**
 * Fetches Google JWKS with bounded caching.
 */
export async function getGoogleJwks(forceRefresh = false): Promise<JwkKey[]> {
  const now = Date.now();
  if (!forceRefresh && cachedJwks && cachedJwks.expiresAt > now) {
    return cachedJwks.keys;
  }

  // Prevent hammering the JWKS endpoint on rapid failed lookups (min 10s between fetches)
  if (now - lastFetchAttempt < 10000 && cachedJwks) {
    return cachedJwks.keys;
  }

  lastFetchAttempt = now;

  try {
    const res = await fetch(GOOGLE_JWKS_URL);
    if (!res.ok) {
      throw new FirebaseTokenError(
        'network_error',
        `Failed to fetch Google JWKS: HTTP ${res.status}`,
      );
    }

    const data = (await res.json()) as JwksResponse;
    const cacheControl = res.headers.get('cache-control') || '';
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
    const maxAgeSeconds = maxAgeMatch && maxAgeMatch[1] ? parseInt(maxAgeMatch[1], 10) : 3600;

    cachedJwks = {
      keys: data.keys,
      expiresAt: now + maxAgeSeconds * 1000,
    };

    return cachedJwks.keys;
  } catch (err) {
    if (cachedJwks && now - cachedJwks.expiresAt < MAX_STALE_KEY_AGE_MS) {
      return cachedJwks.keys;
    }
    if (err instanceof FirebaseTokenError) {
      throw err;
    }
    throw new FirebaseTokenError('network_error', `Could not fetch Google JWKS: ${String(err)}`);
  }
}

/**
 * Resets the in-memory JWKS cache (useful in tests).
 */
export function resetJwksCache(): void {
  cachedJwks = null;
  lastFetchAttempt = 0;
}

/**
 * Verifies a Firebase ID token.
 */
export async function verifyFirebaseIdToken(
  token: string,
  options: FirebaseVerifierOptions,
): Promise<FirebaseTokenClaims> {
  const { projectId, clockSkewSeconds = 60 } = options;
  const nowSeconds = options.now ? options.now() : Math.floor(Date.now() / 1000);

  if (!projectId || typeof projectId !== 'string') {
    throw new FirebaseTokenError('wrong_audience', 'Firebase Project ID is required for token verification.');
  }

  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new FirebaseTokenError('invalid_format', 'Firebase ID token must be a 3-part JWT.');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // 1. Decode and validate header
  let header: { alg?: string; kid?: string };
  try {
    const headerJson = new TextDecoder().decode(base64UrlDecode(headerB64));
    header = JSON.parse(headerJson) as { alg?: string; kid?: string };
  } catch {
    throw new FirebaseTokenError('invalid_header', 'JWT header is not valid JSON.');
  }

  if (header.alg !== 'RS256') {
    throw new FirebaseTokenError(
      'invalid_header',
      `Firebase ID token algorithm must be RS256, received '${header.alg}'.`,
    );
  }

  if (!header.kid || typeof header.kid !== 'string') {
    throw new FirebaseTokenError('invalid_header', 'JWT header missing required kid property.');
  }

  // 2. Decode and validate payload
  let payload: Record<string, unknown>;
  try {
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
    payload = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    throw new FirebaseTokenError('invalid_format', 'JWT payload is not valid JSON.');
  }

  const aud = payload['aud'];
  if (aud !== projectId) {
    throw new FirebaseTokenError(
      'wrong_audience',
      `Firebase ID token audience '${aud}' does not match expected project ID '${projectId}'.`,
    );
  }

  const expectedIssuer = `https://securetoken.google.com/${projectId}`;
  const iss = payload['iss'];
  if (iss !== expectedIssuer) {
    throw new FirebaseTokenError(
      'wrong_issuer',
      `Firebase ID token issuer '${iss}' does not match expected issuer '${expectedIssuer}'.`,
    );
  }

  const sub = payload['sub'];
  if (!sub || typeof sub !== 'string' || sub.trim().length === 0) {
    throw new FirebaseTokenError('missing_subject', 'Firebase ID token missing valid sub claim.');
  }

  const exp = typeof payload['exp'] === 'number' ? payload['exp'] : NaN;
  if (isNaN(exp) || exp + clockSkewSeconds < nowSeconds) {
    throw new FirebaseTokenError(
      'expired',
      `Firebase ID token has expired (exp: ${exp}, current: ${nowSeconds}).`,
    );
  }

  const iat = typeof payload['iat'] === 'number' ? payload['iat'] : NaN;
  if (isNaN(iat)) {
    throw new FirebaseTokenError('invalid_format', 'Firebase ID token missing valid numeric iat claim.');
  }
  if (iat - clockSkewSeconds > nowSeconds) {
    throw new FirebaseTokenError(
      'issued_in_future',
      `Firebase ID token was issued in the future (iat: ${iat}, current: ${nowSeconds}).`,
    );
  }

  const authTime = typeof payload['auth_time'] === 'number' ? payload['auth_time'] : NaN;
  if (isNaN(authTime)) {
    throw new FirebaseTokenError('invalid_format', 'Firebase ID token missing valid numeric auth_time claim.');
  }
  if (authTime - clockSkewSeconds > nowSeconds) {
    throw new FirebaseTokenError(
      'issued_in_future',
      `Firebase ID token auth_time is in the future (auth_time: ${authTime}, current: ${nowSeconds}).`,
    );
  }

  // 3. Find matching public key
  let keys: JwkKey[];
  if (options.customJwks) {
    keys = options.customJwks.keys;
  } else {
    keys = await getGoogleJwks();
  }

  let matchingKey = keys.find((k) => k.kid === header.kid);
  if (!matchingKey && !options.customJwks) {
    // Attempt one forced refresh in case keys were just rotated by Google
    keys = await getGoogleJwks(true);
    matchingKey = keys.find((k) => k.kid === header.kid);
  }

  if (!matchingKey) {
    throw new FirebaseTokenError(
      'key_not_found',
      `No public key found for kid '${header.kid}'.`,
    );
  }

  // 4. Verify cryptographic signature via Web Crypto RSASSA-PKCS1-v1_5
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: matchingKey.kty,
      n: matchingKey.n,
      e: matchingKey.e,
      alg: 'RS256',
      ext: true,
    },
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['verify'],
  );

  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signatureBytes = base64UrlDecode(signatureB64);

  const isValid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signatureBytes as unknown as BufferSource,
    signedData as unknown as BufferSource,
  );

  if (!isValid) {
    throw new FirebaseTokenError('invalid_signature', 'Firebase ID token signature verification failed.');
  }

  const firebaseClaim = payload['firebase'] as { sign_in_provider?: string } | undefined;
  const signInProvider =
    typeof firebaseClaim?.sign_in_provider === 'string'
      ? firebaseClaim.sign_in_provider
      : null;

  return {
    uid: sub,
    email: typeof payload['email'] === 'string' ? payload['email'] : null,
    email_verified: Boolean(payload['email_verified']),
    name: typeof payload['name'] === 'string' ? payload['name'] : null,
    picture: typeof payload['picture'] === 'string' ? payload['picture'] : null,
    signInProvider,
    iss: String(iss),
    aud: String(aud),
    auth_time: authTime,
    sub,
    iat,
    exp,
    ...payload,
  };
}
