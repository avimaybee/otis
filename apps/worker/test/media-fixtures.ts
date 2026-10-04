/**
 * Synthetic audio fixtures for Gate 010 tests. Not a test suite: helpers
 * build minimal but structurally valid OGG/Opus, WebM and MP4 containers so
 * the server-side inspection paths are exercised without real recordings.
 */

export function asciiBytes(text: string): Uint8Array {
  return new Uint8Array([...text].map((char) => char.charCodeAt(0)));
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function oggPage(headerType: number, granule: number, sequence: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(28 + payload.length);
  const view = new DataView(out.buffer);
  out.set(asciiBytes('OggS'), 0);
  out[4] = 0;
  out[5] = headerType;
  view.setUint32(6, granule >>> 0, true);
  view.setUint32(10, Math.floor(granule / 2 ** 32), true);
  view.setUint32(14, 1, true);
  view.setUint32(18, sequence, true);
  view.setUint32(22, 0, true);
  out[26] = 1;
  out[27] = payload.length;
  out.set(payload, 28);
  return out;
}

/** Minimal OGG/Opus stream whose last page granule reports the duration. */
export function oggOpus(durationSeconds: number): Uint8Array {
  const head = new Uint8Array(19);
  head.set(asciiBytes('OpusHead'), 0);
  head[8] = 1;
  head[9] = 1;
  // Payload stays under one 255-byte lacing value so the page math is exact.
  const body = new Uint8Array(200);
  body.fill(0x42);
  return concatBytes(
    oggPage(0x02, 0, 0, head),
    oggPage(0x04, Math.round(durationSeconds * 48_000), 1, body),
  );
}

/** Leading bytes of a WebM/Matroska stream (enough for container sniffing). */
export function webmMagic(): Uint8Array {
  const bytes = new Uint8Array(1024);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  return bytes;
}

// --- EBML / WebM builders ---

/** EBML size vint for explicit lengths; all-ones sizes are reserved. */
function ebmlSize(value: number): Uint8Array {
  for (let length = 1; length <= 8; length++) {
    const max = 2 ** (7 * length) - 2;
    if (value <= max) {
      const out = new Uint8Array(length);
      let remaining = value;
      for (let i = length - 1; i >= 0; i--) {
        out[i] = remaining & 0xff;
        remaining = Math.floor(remaining / 256);
      }
      out[0] = out[0]! | (1 << (8 - length));
      return out;
    }
  }
  throw new Error('value too large for an EBML size');
}

function ebmlElement(id: number[], payload: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array(id), ebmlSize(payload.length), payload);
}

function uintBytes(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return out;
}

/** Minimal big-endian unsigned encoding that fits the value. */
function uintFor(value: number, minLength = 1): Uint8Array {
  let length = minLength;
  while (value >= 2 ** (8 * length)) length += 1;
  return uintBytes(value, length);
}

function int16Bytes(value: number): Uint8Array {
  const raw = value < 0 ? value + 0x10000 : value;
  return new Uint8Array([(raw >> 8) & 0xff, raw & 0xff]);
}

function float64Bytes(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, false);
  return out;
}

const EBML_HEADER = ebmlElement([0x1a, 0x45, 0xdf, 0xa3], new Uint8Array(0));
const WEBM_SEGMENT_ID = [0x18, 0x53, 0x80, 0x67];
const WEBM_INFO_ID = [0x15, 0x49, 0xa9, 0x66];
const WEBM_TIMECODE_SCALE_ID = [0x2a, 0xd7, 0xb1];
const WEBM_DURATION_ID = [0x44, 0x89];
const WEBM_CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];
const WEBM_TIMECODE_ID = [0xe7];
const WEBM_SIMPLE_BLOCK_ID = [0xa3];

/** WebM with a finalized Segment Info Duration (known-size Segment). */
export function webmWithInfoDuration(durationMs: number): Uint8Array {
  const scale = ebmlElement(WEBM_TIMECODE_SCALE_ID, uintFor(1_000_000, 3));
  const duration = new Uint8Array(4);
  new DataView(duration.buffer).setFloat32(0, durationMs, false);
  const info = ebmlElement(WEBM_INFO_ID, concatBytes(scale, ebmlElement(WEBM_DURATION_ID, duration)));
  return concatBytes(EBML_HEADER, ebmlElement(WEBM_SEGMENT_ID, info));
}

/**
 * Live MediaRecorder-shaped WebM: unknown-size Segment, Info without
 * Duration (MuxingApp/WritingApp only), Tracks with an A_OPUS TrackEntry,
 * clusters every second carrying ~20 ms SimpleBlocks (one negative-relative
 * block to exercise signed timecodes), and Void padding. Duration is only
 * discoverable from cluster/block timecodes, exactly like Chrome/Android
 * MediaRecorder output. `timecodeScaleNs` defaults to the Chrome 1 ms scale;
 * pass 100_000 to exercise scale conversion.
 */
export function webmLiveClusters(durationMs: number, options: { timecodeScaleNs?: number } = {}): Uint8Array {
  const timecodeScaleNs = options.timecodeScaleNs ?? 1_000_000;
  const unitsForMs = (ms: number) => Math.round((ms * 1_000_000) / timecodeScaleNs);
  const info = ebmlElement(
    WEBM_INFO_ID,
    concatBytes(
      ebmlElement(WEBM_TIMECODE_SCALE_ID, uintFor(timecodeScaleNs, 3)),
      ebmlElement([0x4d, 0x80], asciiBytes('Chrome')),
      ebmlElement([0x57, 0x41], asciiBytes('Chrome')),
    ),
  );
  const tracks = ebmlElement(
    [0x16, 0x54, 0xae, 0x6b],
    ebmlElement(
      [0xae],
      concatBytes(
        ebmlElement([0xd7], uintFor(1)),
        ebmlElement([0x73, 0xc5], uintFor(0x12345678, 4)),
        ebmlElement([0x83], uintFor(2)), // audio
        ebmlElement([0x86], asciiBytes('A_OPUS')),
        ebmlElement([0xe1], concatBytes(ebmlElement([0xb5], float64Bytes(48_000)), ebmlElement([0x9f], uintFor(1)))),
      ),
    ),
  );
  const clusters: Uint8Array[] = [];
  for (let clusterMs = 0; clusterMs <= durationMs; clusterMs += 1000) {
    const blocks: Uint8Array[] = [];
    const firstRel = clusterMs === 0 ? 0 : -20;
    for (let relMs = firstRel; relMs < 1000 && clusterMs + relMs <= durationMs; relMs += 20) {
      blocks.push(
        ebmlElement(
          WEBM_SIMPLE_BLOCK_ID,
          concatBytes(
            ebmlSize(1), // track number vint
            int16Bytes(unitsForMs(relMs)),
            new Uint8Array([0x80]), // keyframe flag (audio SimpleBlock)
            new Uint8Array(40).fill(0x55),
          ),
        ),
      );
    }
    clusters.push(
      ebmlElement(
        WEBM_CLUSTER_ID,
        concatBytes(ebmlElement(WEBM_TIMECODE_ID, uintFor(unitsForMs(clusterMs), 2)), ...blocks),
      ),
    );
    // Chrome sometimes pads; the walker must skip unknown elements.
    clusters.push(ebmlElement([0xec], new Uint8Array(8)));
  }
  const segment = concatBytes(
    new Uint8Array(WEBM_SEGMENT_ID),
    new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), // unknown size
    info,
    tracks,
    ...clusters,
  );
  return concatBytes(EBML_HEADER, segment);
}

/** Minimal MP4 with an mvhd duration; padded above the minimum byte bound. */
export function mp4WithDuration(durationMs: number): Uint8Array {
  const ftyp = mp4Box('ftyp', concatBytes(asciiBytes('isom'), new Uint8Array([0, 0, 0, 0])));
  const mvhdPayload = new Uint8Array(20);
  const view = new DataView(mvhdPayload.buffer);
  view.setUint32(12, 1000, false);
  view.setUint32(16, durationMs, false);
  const free = mp4Box('free', new Uint8Array(320));
  return concatBytes(ftyp, free, mp4Box('moov', mp4Box('mvhd', mvhdPayload)));
}

function mp4Box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  out.set(asciiBytes(type), 4);
  out.set(payload, 8);
  return out;
}
