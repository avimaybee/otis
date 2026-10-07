/**
 * @otis/worker/media/renditions
 * Standard inference renditions for retained conversation images.
 *
 * The validated original is always retained in R2. Ordinary analysis reuses
 * one deterministic standard rendition (2000px max edge, input container)
 * so repeated model rounds never pay repeated transforms; small originals
 * and explicit original-detail reads serve the original bytes directly.
 * Derived bytes die with the original under the existing media cleanup.
 * Without an Images binding, every read preserves original-image access.
 */

export const IMAGE_RENDITION_VERSION = 1;
export const RENDITION_MAX_EDGE_PX = 2000;
/** Originals at or under this size serve as-is; no transform is spent. */
export const RENDITION_SOURCE_MAX_BYTES = 512 * 1024;

export type ImageDetail = 'standard' | 'original';

export function renditionKeyFor(mediaId: string): string {
  return `renditions/v${IMAGE_RENDITION_VERSION}/${mediaId}.img`;
}

export interface RenditionSource {
  mediaId: string;
  objectKey: string;
  format: string | null;
  contentType: string | null;
  byteSize: number | null;
}

function outputFormatFor(inputFormat: string | null): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (inputFormat === 'image/png') return 'image/png';
  if (inputFormat === 'image/webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Loads inference-ready image bytes: the original for explicit
 * original-detail reads and small sources, otherwise the reused standard
 * rendition (transformed once, stored deterministically, served after).
 * Returns null only when the original bytes themselves are missing.
 * A failed transform degrades to the original, never to nothing.
 */
export async function loadInferenceImageBytes(args: {
  storage: R2Bucket;
  images?: ImagesBinding | null;
  media: RenditionSource;
  detail: ImageDetail;
}): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const inputMime = args.media.contentType || args.media.format || 'image/png';
  if (args.detail === 'original') {
    const original = await args.storage.get(args.media.objectKey);
    if (!original) return null;
    return { bytes: new Uint8Array(await original.arrayBuffer()), mimeType: inputMime };
  }

  const smallEnough =
    typeof args.media.byteSize === 'number' && args.media.byteSize <= RENDITION_SOURCE_MAX_BYTES;
  if (smallEnough || !args.images) {
    const original = await args.storage.get(args.media.objectKey);
    if (!original) return null;
    return { bytes: new Uint8Array(await original.arrayBuffer()), mimeType: inputMime };
  }

  const key = renditionKeyFor(args.media.mediaId);
  const stored = await args.storage.get(key);
  if (stored) {
    return { bytes: new Uint8Array(await stored.arrayBuffer()), mimeType: stored.httpMetadata?.contentType || outputFormatFor(args.media.format) };
  }

  const source = await args.storage.get(args.media.objectKey);
  if (!source || !source.body) return null;
  try {
    const outputFormat = outputFormatFor(args.media.format);
    const transformed = await args.images
      .input(source.body as ReadableStream<Uint8Array>)
      .transform({ width: RENDITION_MAX_EDGE_PX, height: RENDITION_MAX_EDGE_PX, fit: 'scale-down' })
      .output({ format: outputFormat });
    const bytes = new Uint8Array(await new Response(transformed.image()).arrayBuffer());
    const mimeType = typeof transformed.contentType === 'function' ? transformed.contentType() : outputFormat;
    await args.storage.put(key, bytes, { httpMetadata: { contentType: mimeType } });
    return { bytes, mimeType };
  } catch {
    const fallback = await args.storage.get(args.media.objectKey);
    if (!fallback) return null;
    return { bytes: new Uint8Array(await fallback.arrayBuffer()), mimeType: inputMime };
  }
}

/** Best-effort derived-byte cleanup; a missing rendition is not a failure. */
export async function deleteRendition(storage: R2Bucket, mediaId: string): Promise<void> {
  try {
    await storage.delete(renditionKeyFor(mediaId));
  } catch {
    // Renditions are derived and idempotent: absence is the desired end state.
  }
}
