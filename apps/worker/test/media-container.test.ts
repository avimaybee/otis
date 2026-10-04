import { describe, expect, it } from 'vitest';
import {
  inspectAudioBytes,
  readAudioDurationMs,
  sniffAudioContainer,
} from '../src/media/container.js';
import {
  mp4WithDuration,
  oggOpus,
  webmMagic,
  webmLiveClusters,
  webmWithInfoDuration,
} from './media-fixtures.js';

describe('media container inspection', () => {
  it('detects containers from magic bytes, never from a declared MIME', () => {
    expect(sniffAudioContainer(oggOpus(1))).toBe('audio/ogg');
    expect(sniffAudioContainer(webmWithInfoDuration(1000))).toBe('audio/webm');
    expect(sniffAudioContainer(mp4WithDuration(1000))).toBe('audio/mp4');
    expect(sniffAudioContainer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
    // A raw AAC/ADTS stream is not an MP4 container and is never renamed.
    expect(sniffAudioContainer(new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });

  it('reads actual durations where the container makes it parseable', () => {
    expect(readAudioDurationMs(oggOpus(12.5), 'audio/ogg')).toBe(12_500);
    expect(readAudioDurationMs(webmWithInfoDuration(5_000), 'audio/webm')).toBe(5_000);
    expect(readAudioDurationMs(mp4WithDuration(3_000), 'audio/mp4')).toBe(3_000);
  });

  it('derives real MediaRecorder WebM duration from cluster timecodes', () => {
    // Chrome/Android MediaRecorder WebM: unknown-size Segment, no Info
    // Duration, A_OPUS Tracks, signed block timecodes. Duration must come
    // from the last block timecode.
    expect(readAudioDurationMs(webmLiveClusters(2_000), 'audio/webm')).toBe(2_000);
    expect(readAudioDurationMs(webmLiveClusters(12_500), 'audio/webm')).toBe(12_500);
    expect(readAudioDurationMs(webmLiveClusters(200_000), 'audio/webm')).toBe(200_000);
    // Non-default TimecodeScale (0.1 ms units) is converted correctly.
    expect(readAudioDurationMs(webmLiveClusters(5_000, { timecodeScaleNs: 100_000 }), 'audio/webm')).toBe(5_000);
  });

  it('returns null for unparseable bytes instead of trusting a declared value', () => {
    const inspection = inspectAudioBytes(webmMagic());
    expect(inspection.format).toBe('audio/webm');
    expect(inspection.durationMs).toBeNull();

    const garbage = inspectAudioBytes(new Uint8Array(64));
    expect(garbage.format).toBeNull();
    expect(garbage.durationMs).toBeNull();
  });
});
