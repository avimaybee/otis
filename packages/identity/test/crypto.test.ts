import { describe, it, expect } from 'vitest';
import {
  sha256,
  generateRandomToken,
  base64UrlEncode,
  base64UrlDecode,
  timingSafeEqual,
} from '../src/crypto.js';

describe('Identity Crypto Utilities', () => {
  it('computes known SHA-256 hashes correctly', async () => {
    // Known test vector: SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const emptyHash = await sha256('');
    expect(emptyHash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

    // Known test vector: SHA-256("otis")
    const otisHash = await sha256('otis');
    expect(otisHash).toBe('d4ef0c1431e0c1d35909a8e83d10903023a7d85fe83d148355165f9e5778a808');
  });

  it('generates random tokens of specified length and valid base64url characters', () => {
    const token1 = generateRandomToken(32);
    const token2 = generateRandomToken(32);

    expect(token1).not.toBe(token2);
    expect(token1.length).toBeGreaterThanOrEqual(40);
    expect(token1).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('roundtrips base64url encode and decode', () => {
    const original = new Uint8Array([0, 1, 2, 250, 255, 128, 64]);
    const encoded = base64UrlEncode(original);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');

    const decoded = base64UrlDecode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it('performs timing safe equality', () => {
    expect(timingSafeEqual('secret_token_123', 'secret_token_123')).toBe(true);
    expect(timingSafeEqual('secret_token_123', 'secret_token_124')).toBe(false);
    expect(timingSafeEqual('secret_token_123', 'short')).toBe(false);
  });
});
