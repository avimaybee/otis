/**
 * @otis/agent/providers/voice
 * Voice capability and route-resolution contract for Gate 005.
 *
 * Implements the automatic native-preferred / configured-Groq-STT routing
 * rules defined in decisions D23/D24, plans/005-provider-spike.md, and
 * plans/010-groq-stt-handoff.md:
 *
 * 1. Exact selected native model has verified transcription for recording format -> native
 * 2. Native unsupported or unverified, and workspace has verified Groq STT -> groq_stt
 * 3. Neither path usable -> unavailable
 * 4. Runtime native error (auth, 429, outage) -> reports failure, NEVER reroutes silently.
 *
 * Gate 005 defines capability and route-resolution contracts here; Gate 010
 * implements Groq transport, credential integration, and the recording pipeline.
 */

import type { ProviderStatus } from '@otis/contracts';
import type { ModelEntry } from './registry.js';
import type { ResolvedModel } from './types.js';

/** Required mobile & messaging audio formats: Android WebM, iPhone MP4/AAC, Telegram OGG/Opus. */
export const SUPPORTED_AUDIO_FORMATS = ['audio/webm', 'audio/mp4', 'audio/ogg'] as const;
export type SupportedAudioFormat = (typeof SUPPORTED_AUDIO_FORMATS)[number];

export interface WorkspaceSttConfig {
  enabled: boolean;
  provider: 'groq';
  model: 'whisper-large-v3-turbo' | 'whisper-large-v3';
  credentialStatus: ProviderStatus | null;
  /** Explicit verification evidence per format that the STT route was tested and working. */
  verifiedFormats?: Partial<Record<SupportedAudioFormat, boolean>>;
  /**
   * Explicit verification evidence that the STT model/route is tested and working.
   * Certifies that ALL THREE required formats (audio/webm, audio/mp4, audio/ogg)
   * have been tested and verified. Partial format approval must NOT set this to true.
   */
  transcriptionVerified?: boolean;
}

export type VoiceRouteReason =
  | 'no_model_selected'
  | 'unsupported_format'
  | 'native_not_implemented'
  | 'native_unsupported_and_stt_disabled'
  | 'stt_credential_unavailable'
  | 'stt_unverified';

/**
 * The native audio transcription handoff is not implemented in this baseline:
 * the provider turn pipeline consumes a text transcript, and no exact native
 * endpoint/format has verified evidence. Until the handoff lands, verified
 * native capability alone does not create an executable route; supported
 * voice resolves through the configured/verified Groq STT path, and
 * availability describes only implemented paths.
 *
 * The native outcome and per-format capability evidence remain part of this
 * contract, and the registry keeps recording native capability, so the
 * product target is preserved rather than relabeled as text-only. Flipping
 * this flag requires the actual native handoff plus endpoint evidence.
 */
export const NATIVE_AUDIO_TRANSCRIPTION_IMPLEMENTED = false;

export type VoiceRouteOutcome =
  | {
      route: 'native';
      model: ResolvedModel;
      format: SupportedAudioFormat;
    }
  | {
      route: 'groq_stt';
      sttModel: 'whisper-large-v3-turbo' | 'whisper-large-v3';
      conversationModel: ResolvedModel;
      format: SupportedAudioFormat;
    }
  | {
      route: 'unavailable';
      reason: VoiceRouteReason;
      message: string;
    };

export interface ParsedAudioMime {
  baseMime: string;
  parameters: Record<string, string>;
  format: SupportedAudioFormat | null;
}

/**
 * Parses MIME strings and parameters (e.g. `audio/webm;codecs=opus`, `audio/mp4;codecs=mp4a.40.2`).
 * Preserves parameter evidence for Gate 010 container validation and normalizes to the canonical container format.
 * Note: Raw `audio/aac` (ADTS bitstream) is NOT an MP4 container; disguising it as MP4 is rejected.
 */
export function parseAudioMime(mimeOrExt: string): ParsedAudioMime {
  const trimmed = mimeOrExt.trim().toLowerCase();
  const [mimePart, ...paramParts] = trimmed.split(';');
  const baseMime = (mimePart ?? '').trim();
  const parameters: Record<string, string> = {};
  for (const part of paramParts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx !== -1) {
      const k = part.slice(0, eqIdx).trim();
      const v = part.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (k) parameters[k] = v;
    }
  }

  let format: SupportedAudioFormat | null = null;
  if (baseMime === 'audio/webm' || baseMime.endsWith('.webm')) {
    format = 'audio/webm';
  } else if (
    baseMime === 'audio/mp4' ||
    baseMime === 'audio/m4a' ||
    baseMime.endsWith('.mp4') ||
    baseMime.endsWith('.m4a')
  ) {
    format = 'audio/mp4';
  } else if (
    baseMime === 'audio/ogg' ||
    baseMime === 'audio/opus' ||
    baseMime.endsWith('.ogg') ||
    baseMime.endsWith('.opus') ||
    baseMime.endsWith('.oga')
  ) {
    format = 'audio/ogg';
  }

  return { baseMime, parameters, format };
}

/**
 * Normalizes common mime types and file extensions to the canonical container MIME.
 */
export function normalizeAudioFormat(mimeOrExt: string): SupportedAudioFormat | null {
  return parseAudioMime(mimeOrExt).format;
}

function toResolved(entry: ModelEntry): ResolvedModel {
  return {
    commandKey: entry.commandKey,
    provider: entry.provider,
    modelId: entry.modelId,
    endpointFamily: entry.endpointFamily,
    endpointUrl: entry.endpointUrl,
  };
}

/**
 * Resolves the voice transcription route according to D23 / D24 rules.
 */
export function resolveVoiceRoute(params: {
  model: ModelEntry | null;
  audioMimeOrExt: string;
  sttConfig?: WorkspaceSttConfig | null;
}): VoiceRouteOutcome {
  if (!params.model) {
    return {
      route: 'unavailable',
      reason: 'no_model_selected',
      message: 'No conversation model selected for this chat.',
    };
  }

  const format = normalizeAudioFormat(params.audioMimeOrExt);
  if (!format) {
    return {
      route: 'unavailable',
      reason: 'unsupported_format',
      message: `Audio format '${params.audioMimeOrExt}' is not supported. Supported containers: WebM, MP4, OGG.`,
    };
  }

  // 1. Native path only when the handoff is actually implemented AND the
  // exact model/format has verified capability. Capability evidence alone
  // must not accept audio into a job the pipeline cannot execute.
  const formatNativeState = params.model.capabilities.nativeAudioFormats?.[format];
  const nativeCapable = formatNativeState === 'supported';
  const isNativeSupported = NATIVE_AUDIO_TRANSCRIPTION_IMPLEMENTED && nativeCapable;

  if (isNativeSupported) {
    return {
      route: 'native',
      model: toResolved(params.model),
      format,
    };
  }

  // 2. Fall back to workspace-configured Groq STT if verified and enabled.
  const stt = params.sttConfig;
  if (stt && stt.enabled && stt.provider === 'groq') {
    if (stt.credentialStatus !== 'available') {
      return {
        route: 'unavailable',
        reason: 'stt_credential_unavailable',
        message: 'Workspace Groq transcription credential is not available.',
      };
    }
    const isFormatVerified = Boolean(
      stt.verifiedFormats?.[format] ||
      (stt.transcriptionVerified && stt.verifiedFormats?.[format] !== false),
    );
    if (!isFormatVerified) {
      return {
        route: 'unavailable',
        reason: 'stt_unverified',
        message: `Workspace Groq transcription route is unverified for format '${format}'.`,
      };
    }
    return {
      route: 'groq_stt',
      sttModel: stt.model,
      conversationModel: toResolved(params.model),
      format,
    };
  }

  // 3. No executable route. A model with verified native capability is not
  // relabeled as text-only: the honest reason is the missing native handoff.
  if (nativeCapable) {
    return {
      route: 'unavailable',
      reason: 'native_not_implemented',
      message: `Model '${params.model.displayName}' has verified native audio for ${format}, but Otis has not implemented native transcription yet. Configure verified Groq STT or type the note.`,
    };
  }

  return {
    route: 'unavailable',
    reason: 'native_unsupported_and_stt_disabled',
    message: `Voice is unavailable: model '${params.model.displayName}' lacks verified native audio support for ${format} and workspace Groq STT is not configured.`,
  };
}

/**
 * Enforces D23 / zero-additional-spend policy:
 * Native requests that fail mid-inference due to auth, 429 quota exhaustion,
 * or provider outage must NEVER silently fail over to Groq or another provider.
 */
export function canFallbackOnNativeRuntimeError(): false {
  return false;
}
