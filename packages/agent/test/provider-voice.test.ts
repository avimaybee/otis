import { describe, expect, it } from 'vitest';
import {
  canFallbackOnNativeRuntimeError,
  normalizeAudioFormat,
  resolveVoiceRoute,
  type WorkspaceSttConfig,
} from '../src/providers/voice.js';
import type { ModelEntry } from '../src/providers/registry.js';
import { PRODUCTION_REGISTRY } from '../src/providers/registry.js';

function baseModel(): ModelEntry {
  return { ...PRODUCTION_REGISTRY.entries[0]! };
}

describe('voice capability and route resolution (D23 / D24)', () => {
  it('normalizes common mobile and Telegram formats and rejects unknown extensions', () => {
    expect(normalizeAudioFormat('audio/webm')).toBe('audio/webm');
    expect(normalizeAudioFormat('voice_note.webm')).toBe('audio/webm');
    expect(normalizeAudioFormat('audio/mp4')).toBe('audio/mp4');
    expect(normalizeAudioFormat('recording.m4a')).toBe('audio/mp4');
    expect(normalizeAudioFormat('audio/ogg')).toBe('audio/ogg');
    expect(normalizeAudioFormat('telegram_voice.opus')).toBe('audio/ogg');
    expect(normalizeAudioFormat('audio/wav')).toBeNull();
    expect(normalizeAudioFormat('sample.flac')).toBeNull();
  });

  it('selects native route when exact model has verified native audio for format', () => {
    const verifiedNative: ModelEntry = {
      ...baseModel(),
      capabilities: {
        text: 'supported',
        tools: 'supported',
        stream: 'supported',
        thoughtSummary: 'unverified',
        audio: 'supported',
        nativeAudioFormats: { 'audio/webm': 'supported', 'audio/mp4': 'unsupported' },
      },
    };

    const routeWebm = resolveVoiceRoute({
      model: verifiedNative,
      audioMimeOrExt: 'audio/webm',
      sttConfig: null,
    });
    expect(routeWebm).toEqual({
      route: 'native',
      model: {
        commandKey: verifiedNative.commandKey,
        provider: verifiedNative.provider,
        modelId: verifiedNative.modelId,
        endpointFamily: verifiedNative.endpointFamily,
        endpointUrl: verifiedNative.endpointUrl,
      },
      format: 'audio/webm',
    });
  });

  it('falls back to verified Groq STT when native is unverified or unsupported', () => {
    const unverifiedNative: ModelEntry = {
      ...baseModel(),
      capabilities: {
        text: 'supported',
        tools: 'supported',
        stream: 'supported',
        thoughtSummary: 'unverified',
        audio: 'unverified',
      },
    };

    const groqStt: WorkspaceSttConfig = {
      enabled: true,
      provider: 'groq',
      model: 'whisper-large-v3-turbo',
      credentialStatus: 'available',
      transcriptionVerified: true,
    };

    const route = resolveVoiceRoute({
      model: unverifiedNative,
      audioMimeOrExt: 'audio/ogg',
      sttConfig: groqStt,
    });

    expect(route).toEqual({
      route: 'groq_stt',
      sttModel: 'whisper-large-v3-turbo',
      conversationModel: {
        commandKey: unverifiedNative.commandKey,
        provider: unverifiedNative.provider,
        modelId: unverifiedNative.modelId,
        endpointFamily: unverifiedNative.endpointFamily,
        endpointUrl: unverifiedNative.endpointUrl,
      },
      format: 'audio/ogg',
    });
  });

  it('reports unavailable when native is unverified and Groq credential is not available', () => {
    const unverifiedNative = baseModel();
    const sttMissingKey: WorkspaceSttConfig = {
      enabled: true,
      provider: 'groq',
      model: 'whisper-large-v3-turbo',
      credentialStatus: 'invalid_credential',
    };

    const route = resolveVoiceRoute({
      model: unverifiedNative,
      audioMimeOrExt: 'audio/mp4',
      sttConfig: sttMissingKey,
    });

    expect(route).toMatchObject({
      route: 'unavailable',
      reason: 'stt_credential_unavailable',
    });
  });

  it('reports unavailable when native is unverified and Groq STT is disabled or unconfigured', () => {
    const unverifiedNative = baseModel();
    const routeNoStt = resolveVoiceRoute({
      model: unverifiedNative,
      audioMimeOrExt: 'audio/webm',
      sttConfig: null,
    });
    expect(routeNoStt).toMatchObject({
      route: 'unavailable',
      reason: 'native_unsupported_and_stt_disabled',
    });

    const routeDisabledStt = resolveVoiceRoute({
      model: unverifiedNative,
      audioMimeOrExt: 'audio/webm',
      sttConfig: { enabled: false, provider: 'groq', model: 'whisper-large-v3', credentialStatus: 'available' },
    });
    expect(routeDisabledStt).toMatchObject({
      route: 'unavailable',
      reason: 'native_unsupported_and_stt_disabled',
    });
  });

  it('reports unavailable for unselected model or unsupported audio format', () => {
    expect(resolveVoiceRoute({ model: null, audioMimeOrExt: 'audio/webm' })).toMatchObject({
      route: 'unavailable',
      reason: 'no_model_selected',
    });

    expect(resolveVoiceRoute({ model: baseModel(), audioMimeOrExt: 'audio/flac' })).toMatchObject({
      route: 'unavailable',
      reason: 'unsupported_format',
    });
  });

  it('enforces D23 zero-additional-spend policy: runtime native errors never silently fallback to Groq', () => {
    expect(canFallbackOnNativeRuntimeError()).toBe(false);
  });

  it('normalizes Android and iPhone MIME parameters appropriately and rejects raw AAC (finding 10 regression)', () => {
    expect(normalizeAudioFormat('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(normalizeAudioFormat('audio/mp4;codecs=mp4a.40.2')).toBe('audio/mp4');
    expect(normalizeAudioFormat('audio/ogg; codecs=opus')).toBe('audio/ogg');
    // Raw AAC stream is not an MP4 container and is not accepted
    expect(normalizeAudioFormat('audio/aac')).toBeNull();
  });

  it('does not enable native transcription from generic audio=supported without explicit format evidence (finding 10 regression)', () => {
    const genericAudioModel: ModelEntry = {
      ...baseModel(),
      capabilities: {
        text: 'supported',
        tools: 'supported',
        stream: 'supported',
        thoughtSummary: 'unverified',
        audio: 'supported', // Generic audio is supported, but nativeAudioFormats has no entry for ogg
      },
    };
    const route = resolveVoiceRoute({
      model: genericAudioModel,
      audioMimeOrExt: 'audio/ogg',
      sttConfig: null,
    });
    expect(route).toMatchObject({
      route: 'unavailable',
      reason: 'native_unsupported_and_stt_disabled',
    });
  });

  it('rejects Groq STT when credential is valid but transcription route is unverified (finding 10 regression)', () => {
    const unverifiedNative = baseModel();
    const sttValidKeyUnverified: WorkspaceSttConfig = {
      enabled: true,
      provider: 'groq',
      model: 'whisper-large-v3-turbo',
      credentialStatus: 'available',
      // transcriptionVerified is undefined / false
    };
    const route = resolveVoiceRoute({
      model: unverifiedNative,
      audioMimeOrExt: 'audio/webm',
      sttConfig: sttValidKeyUnverified,
    });
    expect(route).toMatchObject({
      route: 'unavailable',
      reason: 'stt_unverified',
    });
  });

  it('enforces format-specific STT verification: one verified format does not enable other formats (finding 5 follow-up regression)', () => {
    const unverifiedNative = baseModel();
    const sttWebmOnly: WorkspaceSttConfig = {
      enabled: true,
      provider: 'groq',
      model: 'whisper-large-v3-turbo',
      credentialStatus: 'available',
      verifiedFormats: { 'audio/webm': true },
    };

    // WebM is verified -> routes to groq_stt
    const webmRoute = resolveVoiceRoute({
      model: unverifiedNative,
      audioMimeOrExt: 'audio/webm',
      sttConfig: sttWebmOnly,
    });
    expect(webmRoute).toMatchObject({
      route: 'groq_stt',
      format: 'audio/webm',
    });

    // MP4 is not verified in verifiedFormats -> unavailable with stt_unverified
    const mp4Route = resolveVoiceRoute({
      model: unverifiedNative,
      audioMimeOrExt: 'audio/mp4',
      sttConfig: sttWebmOnly,
    });
    expect(mp4Route).toMatchObject({
      route: 'unavailable',
      reason: 'stt_unverified',
    });

    // OGG is not verified in verifiedFormats -> unavailable with stt_unverified
    const oggRoute = resolveVoiceRoute({
      model: unverifiedNative,
      audioMimeOrExt: 'audio/ogg',
      sttConfig: sttWebmOnly,
    });
    expect(oggRoute).toMatchObject({
      route: 'unavailable',
      reason: 'stt_unverified',
    });
  });

  it('prefers verified native audio over configured verified Groq STT', () => {
    const nativeWebmModel: ModelEntry = {
      ...baseModel(),
      capabilities: {
        text: 'supported',
        tools: 'supported',
        stream: 'supported',
        thoughtSummary: 'unverified',
        audio: 'supported',
        nativeAudioFormats: { 'audio/webm': 'supported' },
      },
    };
    const sttConfig: WorkspaceSttConfig = {
      enabled: true,
      provider: 'groq',
      model: 'whisper-large-v3-turbo',
      credentialStatus: 'available',
      transcriptionVerified: true,
    };
    const route = resolveVoiceRoute({
      model: nativeWebmModel,
      audioMimeOrExt: 'audio/webm',
      sttConfig,
    });
    expect(route).toMatchObject({
      route: 'native',
      format: 'audio/webm',
    });
  });
});
