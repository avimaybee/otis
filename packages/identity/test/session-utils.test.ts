import { describe, it, expect } from 'vitest';
import {
  createSessionCookie,
  clearSessionCookie,
  extractSessionToken,
  validateCsrfAndOrigin,
} from '../src/session.js';
import { AUTH_BOUNDS } from '@otis/contracts';

describe('Session Cookie and CSRF Utilities', () => {
  it('creates secure HttpOnly session cookie', () => {
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    const cookie = createSessionCookie('test_token_abc', expiresAt, true);

    expect(cookie).toContain(`${AUTH_BOUNDS.COOKIE_NAME}=test_token_abc;`);
    expect(cookie).toContain('HttpOnly;');
    expect(cookie).toContain('SameSite=Lax;');
    expect(cookie).toContain('Secure;');
    expect(cookie).toContain('Max-Age=');
  });

  it('creates clear session cookie with Max-Age=0', () => {
    const cookie = clearSessionCookie(true);
    expect(cookie).toContain(`${AUTH_BOUNDS.COOKIE_NAME}=;`);
    expect(cookie).toContain('Max-Age=0;');
  });

  it('extracts session token from Cookie header', () => {
    const req = new Request('http://localhost/api/me', {
      headers: {
        cookie: `other_pref=dark; ${AUTH_BOUNDS.COOKIE_NAME}=my_token_123; tracking=none`,
      },
    });

    const token = extractSessionToken(req);
    expect(token).toBe('my_token_123');
  });

  it('extracts session token from Authorization Bearer header', () => {
    const req = new Request('http://localhost/api/me', {
      headers: {
        authorization: 'Bearer bearer_token_xyz',
      },
    });

    const token = extractSessionToken(req);
    expect(token).toBe('bearer_token_xyz');
  });

  it('returns null when no session token is present', () => {
    const req = new Request('http://localhost/api/me');
    expect(extractSessionToken(req)).toBeNull();
  });

  it('validates CSRF origin and x-otis-csrf header matching request origin', () => {
    const req = new Request('http://localhost:8787/api/auth/session', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:8787',
        [AUTH_BOUNDS.CSRF_HEADER]: '1',
      },
    });

    expect(validateCsrfAndOrigin(req)).toBe(true);
  });

  it('rejects mutating requests without x-otis-csrf header even when origin matches', () => {
    const req = new Request('http://localhost:8787/api/auth/session', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:8787',
      },
    });

    expect(validateCsrfAndOrigin(req)).toBe(false);
  });

  it('rejects cross-origin mutations', () => {
    const req = new Request('http://localhost:8787/api/auth/session', {
      method: 'POST',
      headers: {
        origin: 'https://malicious-attacker.com',
      },
    });

    expect(validateCsrfAndOrigin(req)).toBe(false);
  });

  it('allows safe methods regardless of origin', () => {
    const req = new Request('http://localhost:8787/api/me', {
      method: 'GET',
      headers: {
        origin: 'https://other-site.com',
      },
    });

    expect(validateCsrfAndOrigin(req)).toBe(true);
  });
});
