/**
 * Standard inference renditions: deterministic reuse, original fallback,
 * and lifecycle cleanup. A scripted Images binding stands in for the
 * Cloudflare transform; no network or account access is used.
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import {
  deleteRendition,
  IMAGE_RENDITION_VERSION,
  loadInferenceImageBytes,
  RENDITION_MAX_EDGE_PX,
  RENDITION_SOURCE_MAX_BYTES,
  renditionKeyFor,
  type ImageDetail,
} from '../src/media/renditions.js';

const E = env as unknown as Env;

function pngBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let i = 8; i < size; i++) out[i] = i % 251;
  return out;
}

interface FakeTransformCall {
  transform: unknown;
  output: unknown;
}

function fakeImages(output: Uint8Array, mime: string, calls: FakeTransformCall[]): ImagesBinding {
  const transformer = {
    transform: (transform: unknown) => {
      calls.push({ transform, output: undefined });
      return transformer;
    },
    draw: () => transformer,
    output: async (options: unknown) => {
      calls[calls.length - 1]!.output = options;
      return {
        response: () => new Response(output),
        contentType: () => mime,
        image: () => new Response(output).body!,
      };
    },
  };
  return {
    info: async () => {
      throw new Error('unused in rendition tests');
    },
    input: () => transformer,
  } as unknown as ImagesBinding;
}

function source(mediaId: string, objectKey: string, bytes: Uint8Array, format: string | null = 'image/png') {
  return { mediaId, objectKey, format, contentType: format, byteSize: bytes.length };
}

describe('image inference renditions (workerd R2)', () => {
  it('uses a versioned deterministic rendition key', () => {
    expect(renditionKeyFor('med_abc')).toBe(`renditions/v${IMAGE_RENDITION_VERSION}/med_abc.img`);
    expect(renditionKeyFor('med_abc')).toBe(renditionKeyFor('med_abc'));
  });

  it('transforms a large image once, then reuses the stored rendition', async () => {
    const original = pngBytes(RENDITION_SOURCE_MAX_BYTES + 1024);
    await E.STORAGE!.put('test-rendition-large', original);
    const calls: FakeTransformCall[] = [];
    const images = fakeImages(pngBytes(4096), 'image/png', calls);
    const media = source('med_large_1', 'test-rendition-large', original);

    const first = await loadInferenceImageBytes({ storage: E.STORAGE!, images, media, detail: 'standard' });
    expect(first).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.transform).toEqual({ width: RENDITION_MAX_EDGE_PX, height: RENDITION_MAX_EDGE_PX, fit: 'scale-down' });
    expect(calls[0]!.output).toEqual({ format: 'image/png' });
    expect(first!.bytes).toHaveLength(4096);
    expect(first!.mimeType).toBe('image/png');

    const stored = await E.STORAGE!.get(renditionKeyFor('med_large_1'));
    expect(stored).not.toBeNull();

    const second = await loadInferenceImageBytes({ storage: E.STORAGE!, images, media, detail: 'standard' });
    expect(second!.bytes).toEqual(first!.bytes);
    expect(calls).toHaveLength(1);

    await E.STORAGE!.delete('test-rendition-large');
    await E.STORAGE!.delete(renditionKeyFor('med_large_1'));
  });

  it('serves small originals directly without spending a transform', async () => {
    const original = pngBytes(1024);
    await E.STORAGE!.put('test-rendition-small', original);
    const calls: FakeTransformCall[] = [];
    const loaded = await loadInferenceImageBytes({
      storage: E.STORAGE!,
      images: fakeImages(pngBytes(64), 'image/png', calls),
      media: source('med_small_1', 'test-rendition-small', original),
      detail: 'standard' as ImageDetail,
    });
    expect(loaded!.bytes).toEqual(original);
    expect(calls).toHaveLength(0);
    expect(await E.STORAGE!.get(renditionKeyFor('med_small_1'))).toBeNull();
    await E.STORAGE!.delete('test-rendition-small');
  });

  it('serves the original for explicit original detail and without a binding', async () => {
    const original = pngBytes(RENDITION_SOURCE_MAX_BYTES + 512);
    await E.STORAGE!.put('test-rendition-orig', original);
    const calls: FakeTransformCall[] = [];
    const media = source('med_orig_1', 'test-rendition-orig', original);
    const explicit = await loadInferenceImageBytes({
      storage: E.STORAGE!,
      images: fakeImages(pngBytes(64), 'image/png', calls),
      media,
      detail: 'original',
    });
    expect(explicit!.bytes).toEqual(original);
    expect(calls).toHaveLength(0);

    const unconfigured = await loadInferenceImageBytes({ storage: E.STORAGE!, images: undefined, media, detail: 'standard' });
    expect(unconfigured!.bytes).toEqual(original);
    await E.STORAGE!.delete('test-rendition-orig');
  });

  it('falls back to the original when the transform fails', async () => {
    const original = pngBytes(RENDITION_SOURCE_MAX_BYTES + 256);
    await E.STORAGE!.put('test-rendition-fail', original);
    const failing = {
      input: () => {
        throw new Error('transform unavailable');
      },
    } as unknown as ImagesBinding;
    const loaded = await loadInferenceImageBytes({
      storage: E.STORAGE!,
      images: failing,
      media: source('med_fail_1', 'test-rendition-fail', original),
      detail: 'standard',
    });
    expect(loaded!.bytes).toEqual(original);
    await E.STORAGE!.delete('test-rendition-fail');
  });

  it('returns null for missing originals and deletes derived bytes', async () => {
    const missing = await loadInferenceImageBytes({
      storage: E.STORAGE!,
      images: undefined,
      media: source('med_gone', 'test-rendition-missing', pngBytes(16)),
      detail: 'standard',
    });
    expect(missing).toBeNull();

    await E.STORAGE!.put(renditionKeyFor('med_gone'), pngBytes(32));
    await deleteRendition(E.STORAGE!, 'med_gone');
    expect(await E.STORAGE!.get(renditionKeyFor('med_gone'))).toBeNull();
    await deleteRendition(E.STORAGE!, 'med_never_existed');
  });
});
