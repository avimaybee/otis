/**
 * @otis/worker/media/container
 * Bounded audio container inspection for Gate 010 quarantine validation.
 *
 * Client metadata is never trusted: the server confirms the actual container
 * from the leading bytes and reads an actual duration from the bytes
 * (OGG/Opus granule, WebM/Matroska Segment Info Duration or cluster block
 * timecodes, MP4/M4A mvhd). Unreadable duration is null and the caller must
 * reject rather than fall back to the declared value. Renaming bytes never
 * changes the detected container.
 */

import type { VoiceFormat, ImageFormat } from '@otis/contracts';

export interface AudioInspection {
  format: VoiceFormat | null;
  /**
   * Actual duration parsed from the container bytes. Null means the server
   * could not verify duration; callers must reject rather than trust a
   * client-declared value.
   */
  durationMs: number | null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

/** Detects the image container from magic bytes; never from the declared MIME. */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export interface ImageInspection {
  format: ImageFormat | null;
  byteSize: number;
}

/** Verifies image bytes server-side: magic container plus non-trivial size. */
export function inspectImageBytes(bytes: Uint8Array): ImageInspection {
  return { format: sniffImageFormat(bytes), byteSize: bytes.length };
}

/** Detects the container from magic bytes; never from the declared MIME. */
export function sniffAudioContainer(bytes: Uint8Array): VoiceFormat | null {
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'audio/webm';
  }
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'OggS') return 'audio/ogg';
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') return 'audio/mp4';
  return null;
}

// --- OGG / Opus ---

function readOggDurationMs(bytes: Uint8Array): number | null {
  let offset = 0;
  let lastGranule: number | null = null;
  let sawOpus = false;
  let pages = 0;
  while (offset + 27 <= bytes.length && pages < 4096) {
    if (ascii(bytes, offset, 4) !== 'OggS') return null;
    const granuleLow = (bytes[offset + 6]! | (bytes[offset + 7]! << 8) | (bytes[offset + 8]! << 16) | (bytes[offset + 9]! << 24)) >>> 0;
    const granuleHigh = (bytes[offset + 10]! | (bytes[offset + 11]! << 8) | (bytes[offset + 12]! << 16) | (bytes[offset + 13]! << 24)) >>> 0;
    const granule = granuleHigh * 2 ** 32 + granuleLow;
    const segmentCount = bytes[offset + 26]!;
    const tableStart = offset + 27;
    if (tableStart + segmentCount > bytes.length) return null;
    let pageBody = 0;
    for (let i = 0; i < segmentCount; i++) pageBody += bytes[tableStart + i]!;
    if (!sawOpus) {
      const payloadStart = tableStart + segmentCount;
      if (payloadStart + 8 <= bytes.length && ascii(bytes, payloadStart, 8) === 'OpusHead') sawOpus = true;
    }
    lastGranule = granule;
    offset = tableStart + segmentCount + pageBody;
    pages += 1;
  }
  if (lastGranule === null || !sawOpus) return null;
  // Opus granule positions are always 48 kHz sample units.
  return Math.round((lastGranule / 48_000) * 1000);
}

// --- WebM / Matroska ---

/**
 * Real MediaRecorder WebM output (Chrome/Android) frequently omits the
 * Segment Info Duration and uses an unknown-size Segment, so duration must be
 * derived from cluster/block timecodes. This is a bounded EBML walk over the
 * already size-capped object; anything it cannot parse returns null and the
 * route rejects instead of trusting client metadata.
 */
const EBML_MAX_ELEMENTS = 200_000;
const WEBM_ID = {
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
} as const;

interface EbmlElement {
  id: number;
  dataStart: number;
  dataEnd: number;
}

/** Reads an EBML element ID (marker bits preserved, max 4 bytes). */
function readEbmlId(bytes: Uint8Array, offset: number): { value: number; length: number } | null {
  if (offset >= bytes.length) return null;
  const first = bytes[offset]!;
  if (first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && (first & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (length > 4 || offset + length > bytes.length) return null;
  let value = first;
  for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i]!;
  return { value, length };
}

/** Reads an EBML size vint; `unknown` marks an all-ones size (live stream). */
function readEbmlSize(
  bytes: Uint8Array,
  offset: number,
): { value: number; length: number; unknown: boolean } | null {
  if (offset >= bytes.length) return null;
  const first = bytes[offset]!;
  if (first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (length > 8 || offset + length > bytes.length) return null;
  let value = first & (mask - 1);
  let unknown = value === mask - 1;
  for (let i = 1; i < length; i++) {
    const byte = bytes[offset + i]!;
    value = value * 256 + byte;
    if (byte !== 0xff) unknown = false;
  }
  return { value, length, unknown };
}

function readEbmlElement(bytes: Uint8Array, offset: number, parentEnd: number): EbmlElement | null {
  const id = readEbmlId(bytes, offset);
  if (!id) return null;
  const size = readEbmlSize(bytes, offset + id.length);
  if (!size) return null;
  const dataStart = offset + id.length + size.length;
  const dataEnd = size.unknown ? parentEnd : Math.min(parentEnd, dataStart + size.value);
  if (dataEnd < dataStart) return null;
  return { id: id.value, dataStart, dataEnd };
}

function readUintValue(bytes: Uint8Array, element: EbmlElement): number | null {
  const length = element.dataEnd - element.dataStart;
  if (length < 1 || length > 8) return null;
  let value = 0;
  for (let i = element.dataStart; i < element.dataEnd; i++) value = value * 256 + bytes[i]!;
  return Number.isSafeInteger(value) ? value : null;
}

function readFloatValue(bytes: Uint8Array, element: EbmlElement): number | null {
  const length = element.dataEnd - element.dataStart;
  if (length !== 4 && length !== 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + element.dataStart, length);
  const value = length === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
  return Number.isFinite(value) ? value : null;
}

/** Relative timecode (signed int16) of a SimpleBlock/Block after its track vint. */
function readBlockRelativeTimecode(bytes: Uint8Array, element: EbmlElement): number | null {
  const track = readEbmlSize(bytes, element.dataStart);
  if (!track) return null;
  const relStart = element.dataStart + track.length;
  if (relStart + 2 > element.dataEnd) return null;
  const raw = (bytes[relStart]! << 8) | bytes[relStart + 1]!;
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

interface WebmScan {
  timecodeScale: number;
  infoDuration: number | null;
  lastBlockTimecode: number | null;
}

function scanWebm(bytes: Uint8Array): WebmScan | null {
  let elements = 0;
  const overBudget = () => elements > EBML_MAX_ELEMENTS;

  // Top level: EBML header then Segment.
  let offset = 0;
  let segment: EbmlElement | null = null;
  while (offset < bytes.length) {
    const element = readEbmlElement(bytes, offset, bytes.length);
    elements += 1;
    if (!element || overBudget()) return null;
    if (element.id === WEBM_ID.segment) {
      segment = element;
      break;
    }
    if (element.dataEnd <= offset) return null;
    offset = element.dataEnd;
  }
  if (!segment) return null;

  let timecodeScale = 1_000_000;
  let infoDuration: number | null = null;
  let lastBlockTimecode: number | null = null;

  let pos = segment.dataStart;
  while (pos < segment.dataEnd) {
    const element = readEbmlElement(bytes, pos, segment.dataEnd);
    elements += 1;
    if (!element || overBudget()) break;
    if (element.id === WEBM_ID.info) {
      let infoPos = element.dataStart;
      while (infoPos < element.dataEnd) {
        const info = readEbmlElement(bytes, infoPos, element.dataEnd);
        elements += 1;
        if (!info || overBudget()) break;
        if (info.id === WEBM_ID.timecodeScale) {
          const value = readUintValue(bytes, info);
          if (value !== null && value > 0) timecodeScale = value;
        } else if (info.id === WEBM_ID.duration) {
          infoDuration = readFloatValue(bytes, info);
        }
        if (info.dataEnd <= infoPos) break;
        infoPos = info.dataEnd;
      }
    } else if (element.id === WEBM_ID.cluster) {
      let clusterTimecode: number | null = null;
      let maxRelative = 0;
      let sawBlock = false;
      let clusterPos = element.dataStart;
      while (clusterPos < element.dataEnd) {
        const child = readEbmlElement(bytes, clusterPos, element.dataEnd);
        elements += 1;
        if (!child || overBudget()) break;
        if (child.id === WEBM_ID.timecode) {
          clusterTimecode = readUintValue(bytes, child);
        } else if (child.id === WEBM_ID.simpleBlock) {
          const relative = readBlockRelativeTimecode(bytes, child);
          if (relative !== null) {
            sawBlock = true;
            if (relative > maxRelative) maxRelative = relative;
          }
        } else if (child.id === WEBM_ID.blockGroup) {
          let groupPos = child.dataStart;
          while (groupPos < child.dataEnd) {
            const group = readEbmlElement(bytes, groupPos, child.dataEnd);
            elements += 1;
            if (!group || overBudget()) break;
            if (group.id === WEBM_ID.block) {
              const relative = readBlockRelativeTimecode(bytes, group);
              if (relative !== null) {
                sawBlock = true;
                if (relative > maxRelative) maxRelative = relative;
              }
            }
            if (group.dataEnd <= groupPos) break;
            groupPos = group.dataEnd;
          }
        }
        if (child.dataEnd <= clusterPos) break;
        clusterPos = child.dataEnd;
      }
      if (clusterTimecode !== null && sawBlock) {
        const absolute = clusterTimecode + maxRelative;
        if (lastBlockTimecode === null || absolute > lastBlockTimecode) lastBlockTimecode = absolute;
      }
    }
    if (element.dataEnd <= pos) break;
    pos = element.dataEnd;
  }

  if (overBudget()) return null;
  return { timecodeScale, infoDuration, lastBlockTimecode };
}

function readWebmDurationMs(bytes: Uint8Array): number | null {
  const scan = scanWebm(bytes);
  if (!scan) return null;
  if (scan.infoDuration !== null && scan.infoDuration >= 0) {
    return Math.round((scan.infoDuration * scan.timecodeScale) / 1_000_000);
  }
  if (scan.lastBlockTimecode === null) return null;
  // Last block start in TimecodeScale units; the route's small tolerance
  // covers the final block's own span. Never the declared client value.
  return Math.round((scan.lastBlockTimecode * scan.timecodeScale) / 1_000_000);
}

// --- MP4 / M4A ---

function findBox(bytes: Uint8Array, type: string, from: number, to: number): number {
  let offset = from;
  while (offset + 8 <= to) {
    let size =
      ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
    const boxType = ascii(bytes, offset + 4, 4);
    if (size === 1) {
      if (offset + 16 > bytes.length) return -1;
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 8, 8);
      const large = Number(view.getBigUint64(0, false));
      if (!Number.isFinite(large) || large < 16) return -1;
      if (boxType === type) return offset;
      size = large;
    } else {
      if (boxType === type) return offset;
      if (size === 0) return -1;
    }
    if (size < 8 || offset + size > bytes.length) return -1;
    offset += size;
  }
  return -1;
}

/** Box size at an offset; handles 32-bit, 64-bit and extend-to-end sizes. */
function readBoxSize(bytes: Uint8Array, offset: number): number | null {
  if (offset + 8 > bytes.length) return null;
  const size =
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
  if (size === 1) {
    if (offset + 16 > bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 8, 8);
    const large = view.getBigUint64(0, false);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(large);
  }
  if (size === 0) return bytes.length - offset;
  return size;
}

function readMp4DurationMs(bytes: Uint8Array): number | null {
  // The box chain advances by declared sizes, so the whole file can be
  // searched in bounded steps even when moov trails a large mdat.
  const moovAt = findBox(bytes, 'moov', 0, bytes.length);
  if (moovAt < 0) return null;
  const moovSize = readBoxSize(bytes, moovAt);
  if (moovSize === null || moovSize < 8) return null;
  const moovEnd = Math.min(bytes.length, moovAt + moovSize);
  const mvhdAt = findBox(bytes, 'mvhd', moovAt + 8, moovEnd);
  if (mvhdAt < 0) return null;
  const payload = mvhdAt + 8;
  if (payload + 20 > bytes.length) return null;
  const version = bytes[payload]!;
  const view = new DataView(bytes.buffer, bytes.byteOffset + payload, Math.min(bytes.length - payload, 32));
  if (version === 1) {
    if (payload + 32 > bytes.length) return null;
    const timescale = view.getUint32(20, false);
    const duration = Number(view.getBigUint64(24, false));
    if (timescale === 0) return null;
    return Math.round((duration / timescale) * 1000);
  }
  const timescale = view.getUint32(12, false);
  const duration = view.getUint32(16, false);
  if (timescale === 0) return null;
  return Math.round((duration / timescale) * 1000);
}

/** Best-effort actual duration; null when the container cannot be parsed. */
export function readAudioDurationMs(bytes: Uint8Array, format: VoiceFormat): number | null {
  if (format === 'audio/ogg') return readOggDurationMs(bytes);
  if (format === 'audio/webm') return readWebmDurationMs(bytes);
  return readMp4DurationMs(bytes);
}

/** Actual duration or null; the declared client value is never substituted. */
export function inspectAudioBytes(bytes: Uint8Array): AudioInspection {
  const format = sniffAudioContainer(bytes);
  if (!format) return { format: null, durationMs: null };
  return { format, durationMs: readAudioDurationMs(bytes, format) };
}
