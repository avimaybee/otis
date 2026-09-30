import { describe, it, expect, beforeAll } from 'vitest';
import {
  verifyFirebaseIdToken,
  FirebaseTokenError,
  type JwksResponse,
} from '../src/firebase.js';
import { base64UrlEncode } from '../src/crypto.js';

describe('Firebase ID Token Verification', () => {
  let privateKey: CryptoKey;
  let jwks: JwksResponse;
  const testKid = 'test-key-id-1';
  const projectId = 'test-firebase-project';

  beforeAll(async () => {
    // Generate RSA key pair for testing Web Crypto verification
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

    privateKey = keyPair.privateKey;
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

    jwks = {
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
    };
  });

  async function createTestJwt(
    headerOverrides: Record<string, unknown> = {},
    payloadOverrides: Record<string, unknown> = {},
    corruptSignature = false,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = {
      alg: 'RS256',
      kid: testKid,
      typ: 'JWT',
      ...headerOverrides,
    };

    const payload = {
      iss: `https://securetoken.google.com/${projectId}`,
      aud: projectId,
      auth_time: now - 10,
      sub: 'test-firebase-uid-123',
      iat: now - 10,
      exp: now + 3600,
      email: 'test@kerning.studio',
      email_verified: true,
      name: 'Test Member',
      ...payloadOverrides,
    };

    const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
    const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
    const dataToSign = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

    const signatureBuf = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      privateKey,
      dataToSign as unknown as BufferSource,
    );

    let signatureBytes = new Uint8Array(signatureBuf);
    if (corruptSignature) {
      signatureBytes = new Uint8Array(signatureBytes);
      signatureBytes[0] = (signatureBytes[0] ?? 0) ^ 0xff;
    }

    const signatureB64 = base64UrlEncode(signatureBytes);
    return `${headerB64}.${payloadB64}.${signatureB64}`;
  }

  it('successfully verifies a valid Firebase token and extracts claims', async () => {
    const token = await createTestJwt();
    const claims = await verifyFirebaseIdToken(token, {
      projectId,
      customJwks: jwks,
    });

    expect(claims.uid).toBe('test-firebase-uid-123');
    expect(claims.email).toBe('test@kerning.studio');
    expect(claims.email_verified).toBe(true);
    expect(claims.name).toBe('Test Member');
  });

  it('rejects a token with a corrupted or forged signature', async () => {
    const token = await createTestJwt({}, {}, true);
    await expect(
      verifyFirebaseIdToken(token, { projectId, customJwks: jwks }),
    ).rejects.toThrowError(FirebaseTokenError);

    try {
      await verifyFirebaseIdToken(token, { projectId, customJwks: jwks });
    } catch (err) {
      expect((err as FirebaseTokenError).code).toBe('invalid_signature');
    }
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await createTestJwt({}, { exp: now - 300, iat: now - 600, auth_time: now - 600 });

    try {
      await verifyFirebaseIdToken(token, { projectId, customJwks: jwks, clockSkewSeconds: 0 });
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as FirebaseTokenError).code).toBe('expired');
    }
  });

  it('rejects a token with wrong audience', async () => {
    const token = await createTestJwt({}, { aud: 'wrong-project-id' });

    try {
      await verifyFirebaseIdToken(token, { projectId, customJwks: jwks });
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as FirebaseTokenError).code).toBe('wrong_audience');
    }
  });

  it('rejects a token with wrong issuer', async () => {
    const token = await createTestJwt({}, { iss: 'https://securetoken.google.com/other-project' });

    try {
      await verifyFirebaseIdToken(token, { projectId, customJwks: jwks });
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as FirebaseTokenError).code).toBe('wrong_issuer');
    }
  });

  it('rejects a token with missing or empty subject', async () => {
    const token = await createTestJwt({}, { sub: '' });

    try {
      await verifyFirebaseIdToken(token, { projectId, customJwks: jwks });
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as FirebaseTokenError).code).toBe('missing_subject');
    }
  });

  it('rejects a token with unknown kid', async () => {
    const token = await createTestJwt({ kid: 'unknown-kid-999' });

    try {
      await verifyFirebaseIdToken(token, { projectId, customJwks: jwks });
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as FirebaseTokenError).code).toBe('key_not_found');
    }
  });

  it('rejects non-RS256 algorithm', async () => {
    const token = await createTestJwt({ alg: 'HS256' });

    try {
      await verifyFirebaseIdToken(token, { projectId, customJwks: jwks });
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as FirebaseTokenError).code).toBe('invalid_header');
    }
  });
});
