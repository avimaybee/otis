/**
 * Web voice recorder hook (010 capture baseline).
 *
 * Owns the real MediaRecorder lifecycle: explicit-tap permission, capability
 * negotiation via `MediaRecorder.isTypeSupported` (never OS sniffing), a 1 s
 * timeslice persisted as ordered IndexedDB chunks, a real AnalyserNode meter,
 * the three-minute cap, background/interruption handling and Review.
 *
 * Stop finalizes into Review and never sends. Send hands the frozen blob to
 * the isolated `VoiceUploadAdapter` with one stable `clientMessageId` reused
 * on every retry. Cancel/discard release tracks, meter, AudioContext and
 * local bytes. Interrupted capture checkpoints what exists and reports the
 * playable portion honestly; incomplete containers are not offered as
 * playable recordings.
 *
 * Tests inject `environment` (fake MediaRecorder/analyser/validator); the
 * production defaults use the platform APIs and degrade honestly when one is
 * missing. This hook is not device evidence.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VOICE_BOUNDS, type VoiceMediaSummary } from '@otis/contracts';
import {
  appendVoiceChunk,
  checkpointVoiceSession,
  createVoiceSession,
  deleteVoiceSession,
  finalizeVoiceSession,
  listVoiceSessions,
  rehydrateVoiceSessions,
} from '../api/voiceSessions.js';
import { uploadVoiceNote, voiceFilename, type VoiceUploadAdapter } from '../api/voice.js';

export const VOICE_MAX_DURATION_MS = VOICE_BOUNDS.MAX_DURATION_SECONDS * 1000;
const TICK_MS = 250;
const LEVEL_INTERVAL_MS = 80;
const LEVEL_SAMPLES = 28;

/** Capability-ordered candidates: Android WebM/Opus first, iPhone MP4/AAC next. */
export const RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

export function pickRecorderMime(isTypeSupported: (mime: string) => boolean): string | null {
  for (const mime of RECORDER_MIME_CANDIDATES) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      /* Keep probing; one bad candidate must not fail negotiation. */
    }
  }
  return null;
}

export interface VoiceMediaRecorder {
  readonly state: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface VoiceMeter {
  /** Current 0..1 level measured from the live microphone stream. */
  read(): number;
  close(): void;
}

export interface VoiceBlobValidation {
  ok: boolean;
  durationMs: number | null;
}

export interface VoiceRecorderEnvironment {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createRecorder?: (stream: MediaStream, mimeType: string) => VoiceMediaRecorder;
  isTypeSupported?: (mimeType: string) => boolean;
  createMeter?: (stream: MediaStream) => VoiceMeter | null;
  validateBlob?: (blob: Blob) => Promise<VoiceBlobValidation>;
  vibrate?: (pattern: number) => void;
  now?: () => number;
}

export interface VoiceRecorderScope {
  userId: string;
  workspaceId: string;
  chatId: string | null;
}

export type VoiceRecorderPhase = 'idle' | 'requesting' | 'recording' | 'finalizing' | 'review';
export type VoiceErrorCode = 'permission' | 'unavailable' | 'unsupported' | 'upload';
export type VoiceUploadState = 'idle' | 'uploading' | 'failed';

export interface VoiceReviewInfo {
  sessionId: string;
  durationMs: number;
  mimeType: string;
  clientMessageId: string;
}

export interface VoiceControllerState {
  phase: VoiceRecorderPhase;
  elapsedMs: number;
  /** Rolling real levels; never synthesized from elapsed time. */
  levels: number[];
  error: string | null;
  errorCode: VoiceErrorCode | null;
  /** True when capture stopped because of backgrounding or a recorder error. */
  interrupted: boolean;
  /** True when the three-minute cap stopped capture. */
  capReached: boolean;
  /** False when IndexedDB could not retain this session (memory only). */
  durable: boolean;
  /** False when the assembled container failed playback validation. */
  recoverable: boolean;
  missingChunks: number;
  uploadState: VoiceUploadState;
  review: VoiceReviewInfo | null;
  playing: boolean;
}

export interface VoiceController extends VoiceControllerState {
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  discard: () => void;
  send: () => Promise<void>;
  togglePlayback: () => void;
}

export interface UseVoiceRecorderOptions {
  scope: VoiceRecorderScope | null;
  adapter: VoiceUploadAdapter | null;
  environment?: VoiceRecorderEnvironment;
  enabled?: boolean;
  /**
   * Hands the finalized recording to the durable send owner (the scoped
   * outbox) and resolves only after the message is durably accepted. A
   * rejection keeps the local recording for same-identity retry; a scope move
   * or logout during the await aborts before this callback is invoked.
   */
  onSent?: (result: {
    clientMessageId: string;
    media: VoiceMediaSummary;
    durationMs: number;
    mimeType: string;
  }) => Promise<void>;
}

const INITIAL_STATE: VoiceControllerState = {
  phase: 'idle',
  elapsedMs: 0,
  levels: [],
  error: null,
  errorCode: null,
  interrupted: false,
  capReached: false,
  durable: true,
  recoverable: true,
  missingChunks: 0,
  uploadState: 'idle',
  review: null,
  playing: false,
};

function startError(error: unknown): { code: VoiceErrorCode; message: string } {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return { code: 'permission', message: 'Microphone access is blocked. Allow it in your browser, then try again.' };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return { code: 'unavailable', message: 'No microphone was found on this device.' };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return { code: 'unavailable', message: 'The microphone is in use by another app. Close it and try again.' };
  }
  return { code: 'unavailable', message: 'Could not start recording. Try again.' };
}

function stopTracks(stream: MediaStream | null): void {
  if (!stream) return;
  try {
    for (const track of stream.getTracks()) track.stop();
  } catch {
    /* Already ended. */
  }
}

/** Real microphone meter; null when Web Audio is unavailable. */
function createAnalyserMeter(stream: MediaStream): VoiceMeter | null {
  try {
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    return {
      read: () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) {
          const centered = (value - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        // Headroom so ordinary speech visibly moves the meter.
        return Math.min(1, rms * 3);
      },
      close: () => {
        try {
          source.disconnect();
        } catch {
          /* Already disconnected. */
        }
        void context.close().catch(() => {});
      },
    };
  } catch {
    return null;
  }
}

/**
 * Playback validation: the container must load real metadata before Review
 * offers Send. A missing header/final chunk fails here instead of shipping a
 * broken file.
 */
export function readAudioMetadata(blob: Blob, timeoutMs = 5000): Promise<VoiceBlobValidation> {
  return new Promise(resolve => {
    let settled = false;
    const url = URL.createObjectURL(blob);
    let audio: HTMLAudioElement;
    try {
      audio = new Audio();
    } catch {
      URL.revokeObjectURL(url);
      resolve({ ok: false, durationMs: null });
      return;
    }
    const finish = (result: VoiceBlobValidation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        audio.removeAttribute('src');
        audio.load();
      } catch {
        /* Detached. */
      }
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, durationMs: null }), timeoutMs);
    audio.onloadedmetadata = () => finish({
      ok: true,
      durationMs: Number.isFinite(audio.duration) && audio.duration > 0 ? Math.round(audio.duration * 1000) : null,
    });
    audio.onerror = () => finish({ ok: false, durationMs: null });
    audio.src = url;
  });
}

function defaultEnvironment(): Required<VoiceRecorderEnvironment> {
  return {
    getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
    createRecorder: (stream, mimeType) =>
      new MediaRecorder(stream, { mimeType }) as unknown as VoiceMediaRecorder,
    isTypeSupported: mimeType =>
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mimeType),
    createMeter: createAnalyserMeter,
    validateBlob: readAudioMetadata,
    vibrate: pattern => {
      try {
        navigator.vibrate?.(pattern);
      } catch {
        /* Haptics are optional. */
      }
    },
    now: () => Date.now(),
  };
}

export function useVoiceRecorder({
  scope,
  adapter,
  environment,
  enabled = true,
  onSent,
}: UseVoiceRecorderOptions): VoiceController {
  const env = useMemo<Required<VoiceRecorderEnvironment>>(
    () => ({ ...defaultEnvironment(), ...environment }),
    [environment],
  );
  const [state, setState] = useState<VoiceControllerState>(INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const mounted = useRef(true);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  /** Finalized upload cached per recording identity, reused on attach retry. */
  const uploadedRef = useRef<{ clientMessageId: string; media: VoiceMediaSummary } | null>(null);

  const recorderRef = useRef<VoiceMediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const meterRef = useRef<VoiceMeter | null>(null);
  const sessionRef = useRef<{ sessionId: string; mimeType: string } | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const sequenceRef = useRef(0);
  const startedAtRef = useRef(0);
  const durationRef = useRef(0);
  const interruptedRef = useRef(false);
  const capRef = useRef(false);
  const clientMessageIdRef = useRef<string | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastLevelAtRef = useRef(0);
  const levelsRef = useRef<number[]>([]);
  const playbackUrlRef = useRef<string | null>(null);
  const playbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const reviewBlobRef = useRef<Blob | null>(null);
  const finalizingRef = useRef(false);
  const stopFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearStopFallback = useCallback(() => {
    if (stopFallbackRef.current !== null) {
      clearTimeout(stopFallbackRef.current);
      stopFallbackRef.current = null;
    }
  }, []);

  const clearTimers = useCallback(() => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const releaseHardware = useCallback(() => {
    clearTimers();
    meterRef.current?.close();
    meterRef.current = null;
    stopTracks(streamRef.current);
    streamRef.current = null;
  }, [clearTimers]);

  const releasePlayback = useCallback(() => {
    const audio = playbackAudioRef.current;
    if (audio) {
      try {
        audio.pause();
      } catch {
        /* Already detached. */
      }
      audio.onended = null;
      audio.onerror = null;
    }
    playbackAudioRef.current = null;
    if (playbackUrlRef.current) {
      URL.revokeObjectURL(playbackUrlRef.current);
      playbackUrlRef.current = null;
    }
    reviewBlobRef.current = null;
  }, []);

  const resetToIdle = useCallback(() => {
    clearStopFallback();
    sessionRef.current = null;
    chunksRef.current = [];
    sequenceRef.current = 0;
    durationRef.current = 0;
    interruptedRef.current = false;
    capRef.current = false;
    clientMessageIdRef.current = null;
    uploadedRef.current = null;
    levelsRef.current = [];
    releasePlayback();
    if (mounted.current) setState(INITIAL_STATE);
  }, [clearStopFallback, releasePlayback]);

  const currentElapsed = useCallback(() => {
    if (stateRef.current.phase === 'idle' || startedAtRef.current === 0) return durationRef.current;
    return Math.max(durationRef.current, env.now() - startedAtRef.current);
  }, [env]);

  const preparePlayback = useCallback((blob: Blob) => {
    releasePlayback();
    reviewBlobRef.current = blob;
    try {
      const url = URL.createObjectURL(blob);
      playbackUrlRef.current = url;
      const audio = new Audio(url);
      audio.onended = () => {
        if (mounted.current) setState(previous => ({ ...previous, playing: false }));
      };
      audio.onerror = () => {
        if (mounted.current) setState(previous => ({ ...previous, recoverable: false, playing: false }));
      };
      playbackAudioRef.current = audio;
    } catch {
      /* Validation already decided recoverability. */
    }
  }, [releasePlayback]);

  const finalizeRecording = useCallback(async () => {
    clearStopFallback();
    if (finalizingRef.current) return;
    finalizingRef.current = true;
    const session = sessionRef.current;
    const wasInterrupted = interruptedRef.current;
    const capReached = capRef.current;
    const elapsed = Math.min(VOICE_MAX_DURATION_MS, Math.max(durationRef.current, currentElapsed()));
    releaseHardware();
    try {
      if (!session) {
        resetToIdle();
        return;
      }
      const complete = !wasInterrupted;
      await checkpointVoiceSession({
        sessionId: session.sessionId,
        durationMs: elapsed,
        complete,
        interruption: wasInterrupted ? 'background' : 'none',
      });
      const stored = await finalizeVoiceSession(session.sessionId);
      const blob = stored?.blob ?? (chunksRef.current.length > 0
        ? new Blob(chunksRef.current, { type: session.mimeType })
        : null);
      if (!blob || blob.size === 0) {
        await deleteVoiceSession(session.sessionId);
        sessionRef.current = null;
        if (mounted.current) {
          setState({ ...INITIAL_STATE, error: 'Nothing was captured. Try again.', errorCode: 'unavailable' });
        }
        return;
      }
      const validation = await env.validateBlob(blob);
      const durationMs = Math.max(1, Math.min(VOICE_MAX_DURATION_MS, validation.durationMs ?? elapsed));
      const clientMessageId = clientMessageIdRef.current ?? crypto.randomUUID();
      clientMessageIdRef.current = clientMessageId;
      await checkpointVoiceSession({
        sessionId: session.sessionId,
        durationMs,
        complete,
        interruption: wasInterrupted ? 'background' : 'none',
        clientMessageId,
      });
      if (!mounted.current) return;
      if (validation.ok) preparePlayback(blob);
      setState({
        ...INITIAL_STATE,
        phase: 'review',
        elapsedMs: durationMs,
        review: { sessionId: session.sessionId, durationMs, mimeType: session.mimeType, clientMessageId },
        interrupted: wasInterrupted,
        capReached,
        recoverable: validation.ok,
        missingChunks: stored?.missing ?? 0,
        durable: true,
      });
    } finally {
      finalizingRef.current = false;
    }
  }, [clearStopFallback, currentElapsed, env, preparePlayback, releaseHardware, resetToIdle]);

  const stopRef = useRef<() => void>(() => {});
  const beginStop = useCallback((interrupted: boolean) => {
    if (stateRef.current.phase !== 'recording') return;
    if (interrupted) interruptedRef.current = true;
    clearTimers();
    if (mounted.current) setState(previous => ({ ...previous, phase: 'finalizing' }));
    try {
      recorderRef.current?.stop();
    } catch {
      void finalizeRecording();
      return;
    }
    // Some mobile browsers never deliver onstop (or the final
    // dataavailable) after backgrounding; the bounded fallback still
    // finalizes whatever chunks committed.
    if (stopFallbackRef.current === null) {
      stopFallbackRef.current = setTimeout(() => {
        stopFallbackRef.current = null;
        void finalizeRecording();
      }, 1500);
    }
  }, [clearTimers, finalizeRecording]);
  const stop = useCallback(() => beginStop(false), [beginStop]);
  stopRef.current = stop;

  const startingRef = useRef(false);

  const start = useCallback(async () => {
    if (!scope || !enabled || startingRef.current) return;
    const phase = stateRef.current.phase;
    if (phase === 'requesting' || phase === 'recording' || phase === 'finalizing') return;
    startingRef.current = true;
    releasePlayback();
    chunksRef.current = [];
    sequenceRef.current = 0;
    durationRef.current = 0;
    interruptedRef.current = false;
    capRef.current = false;
    clientMessageIdRef.current = null;
    levelsRef.current = [];
    if (mounted.current) {
      setState({ ...INITIAL_STATE, phase: 'requesting' });
    }
    let stream: MediaStream | null = null;
    try {
      stream = await env.getUserMedia({ audio: true });
      if (!mounted.current) {
        stopTracks(stream);
        return;
      }
      const mimeType = pickRecorderMime(env.isTypeSupported);
      if (!mimeType) {
        stopTracks(stream);
        setState({
          ...INITIAL_STATE,
          error: 'This browser cannot record a supported voice format.',
          errorCode: 'unsupported',
        });
        return;
      }
      const recorder = env.createRecorder(stream, mimeType);
      const sessionId = crypto.randomUUID();
      const created = await createVoiceSession({
        sessionId,
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        chatId: scope.chatId,
        mimeType,
      });
      if (!mounted.current) {
        stopTracks(stream);
        void deleteVoiceSession(sessionId);
        return;
      }
      sessionRef.current = { sessionId, mimeType };
      streamRef.current = stream;
      recorderRef.current = recorder;
      meterRef.current = env.createMeter(stream);
      startedAtRef.current = env.now();
      recorder.ondataavailable = event => {
        const chunk = event.data;
        if (!chunk || chunk.size === 0) return;
        sequenceRef.current += 1;
        const sequence = sequenceRef.current;
        chunksRef.current.push(chunk);
        const elapsed = Math.min(VOICE_MAX_DURATION_MS, env.now() - startedAtRef.current);
        durationRef.current = Math.max(durationRef.current, elapsed);
        void appendVoiceChunk({ sessionId, sequence, chunk, durationMs: elapsed }).then(result => {
          if (!result.durable && mounted.current) {
            setState(previous => ({ ...previous, durable: false }));
          }
        });
        if (mounted.current) setState(previous => ({ ...previous, elapsedMs: elapsed }));
      };
      recorder.onstop = () => {
        void finalizeRecording();
      };
      recorder.onerror = () => {
        interruptedRef.current = true;
        void finalizeRecording();
      };
      recorder.start(1000);
      env.vibrate(10);
      setState({
        ...INITIAL_STATE,
        phase: 'recording',
        durable: created.durable,
        levels: [],
      });
      tickRef.current = setInterval(() => {
        const elapsed = env.now() - startedAtRef.current;
        durationRef.current = Math.max(durationRef.current, elapsed);
        if (elapsed >= VOICE_MAX_DURATION_MS && !capRef.current) {
          capRef.current = true;
          if (mounted.current) setState(previous => ({ ...previous, capReached: true, elapsedMs: VOICE_MAX_DURATION_MS }));
          stopRef.current();
          return;
        }
        if (mounted.current) setState(previous => ({ ...previous, elapsedMs: elapsed }));
      }, TICK_MS);
      const loop = () => {
        rafRef.current = requestAnimationFrame(loop);
        const meter = meterRef.current;
        if (!meter) return;
        const at = env.now();
        if (at - lastLevelAtRef.current < LEVEL_INTERVAL_MS) return;
        lastLevelAtRef.current = at;
        const next = [...levelsRef.current.slice(-(LEVEL_SAMPLES - 1)), meter.read()];
        levelsRef.current = next;
        if (mounted.current) setState(previous => ({ ...previous, levels: next }));
      };
      rafRef.current = requestAnimationFrame(loop);
    } catch (error) {
      stopTracks(stream);
      releaseHardware();
      if (mounted.current) {
        const mapped = startError(error);
        setState({ ...INITIAL_STATE, error: mapped.message, errorCode: mapped.code });
      }
    } finally {
      startingRef.current = false;
    }
  }, [scope, enabled, env, finalizeRecording, releaseHardware, releasePlayback]);

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        recorder.stop();
      } catch {
        /* Already inactive. */
      }
    }
    recorderRef.current = null;
    releaseHardware();
    if (session) void deleteVoiceSession(session.sessionId);
    resetToIdle();
  }, [releaseHardware, resetToIdle]);

  const discard = useCallback(() => {
    cancel();
  }, [cancel]);

  const send = useCallback(async () => {
    const current = stateRef.current;
    if (!scope || !current.review || current.uploadState === 'uploading') return;
    if (!current.recoverable) return;
    if (!adapter) {
      setState(previous => ({
        ...previous,
        error: 'Voice is unavailable right now. The recording is kept on this device.',
        errorCode: 'upload',
      }));
      return;
    }
    if (!scope.chatId) {
      setState(previous => ({ ...previous, error: 'Open a conversation before sending a voice note.', errorCode: 'upload' }));
      return;
    }
    if (!onSent) {
      setState(previous => ({ ...previous, error: 'Voice send is not connected. The recording is kept on this device.', errorCode: 'upload' }));
      return;
    }
    const blob = reviewBlobRef.current;
    if (!blob) {
      setState(previous => ({ ...previous, error: 'The recording is no longer available. Discard it.', errorCode: 'upload' }));
      return;
    }
    // Captured at send start: a scope move or logout during a slow upload
    // must never invoke the send owner or delete bytes for another scope.
    const started = { userId: scope.userId, workspaceId: scope.workspaceId, chatId: scope.chatId };
    const stillCurrent = () => {
      const live = scopeRef.current;
      return mounted.current
        && live !== null
        && live.userId === started.userId
        && live.workspaceId === started.workspaceId
        && live.chatId === started.chatId;
    };
    setState(previous => ({ ...previous, uploadState: 'uploading', error: null, errorCode: null }));
    try {
      let uploaded = uploadedRef.current;
      if (!uploaded || uploaded.clientMessageId !== current.review.clientMessageId) {
        const result = await uploadVoiceNote(adapter, {
          workspaceId: started.workspaceId,
          chatId: started.chatId,
          clientMessageId: current.review.clientMessageId,
          blob,
          mimeType: current.review.mimeType,
          durationMs: current.review.durationMs,
          filename: voiceFilename(current.review.mimeType),
        });
        if (!stillCurrent()) return;
        uploaded = { clientMessageId: current.review.clientMessageId, media: result.media };
        uploadedRef.current = uploaded;
      }
      // Local bytes are deleted only after the send owner confirms durable
      // outbox acceptance; an attach failure keeps the recording and retries
      // the same message identity (reusing the finalized media when possible).
      await onSent({
        clientMessageId: current.review.clientMessageId,
        media: uploaded.media,
        durationMs: current.review.durationMs,
        mimeType: current.review.mimeType,
      });
      if (!stillCurrent()) return;
      await deleteVoiceSession(current.review.sessionId);
      resetToIdle();
    } catch {
      if (!stillCurrent()) return;
      setState(previous => ({
        ...previous,
        uploadState: 'failed',
        error: 'Could not send the recording. It is kept on this device. Try again.',
        errorCode: 'upload',
      }));
    }
  }, [scope, adapter, onSent, resetToIdle]);

  const togglePlayback = useCallback(() => {
    const audio = playbackAudioRef.current;
    if (!audio) return;
    if (stateRef.current.playing) {
      audio.pause();
      setState(previous => ({ ...previous, playing: false }));
      return;
    }
    void audio.play().then(
      () => {
        if (mounted.current) setState(previous => ({ ...previous, playing: true }));
      },
      () => {
        if (mounted.current) setState(previous => ({ ...previous, recoverable: false, playing: false }));
      },
    );
  }, []);

  // Backgrounding stops capture deterministically; no automatic resume and no
  // automatic submission. iOS may kill the recorder first, which the same
  // path handles because checkpointing happens from whatever chunks exist.
  useEffect(() => {
    if (!enabled) return;
    const onVisibility = () => {
      if (!document.hidden) return;
      beginStop(true);
    };
    const onPageHide = () => {
      beginStop(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [enabled, beginStop]);

  // Reload/temporary-navigation recovery: only validated playable content is
  // offered for Review. Incomplete containers report unrecoverable.
  const scopeUserId = scope?.userId ?? null;
  const scopeWorkspaceId = scope?.workspaceId ?? null;
  const scopeChatId = scope?.chatId ?? null;
  useEffect(() => {
    if (!enabled || !scopeUserId || !scopeWorkspaceId) return;
    let live = true;
    const recoveryScope = { userId: scopeUserId, workspaceId: scopeWorkspaceId, chatId: scopeChatId };
    void (async () => {
      await rehydrateVoiceSessions(recoveryScope.userId);
      if (!live || stateRef.current.phase !== 'idle') return;
      const sessions = await listVoiceSessions(recoveryScope);
      if (!live || stateRef.current.phase !== 'idle' || sessions.length === 0) return;
      const newest = sessions[0];
      if (!newest) return;
      const result = await finalizeVoiceSession(newest.sessionId);
      if (!live || stateRef.current.phase !== 'idle' || !result) return;
      const validation = await env.validateBlob(result.blob);
      if (!live || stateRef.current.phase !== 'idle') return;
      const clientMessageId = newest.clientMessageId ?? crypto.randomUUID();
      clientMessageIdRef.current = clientMessageId;
      sessionRef.current = { sessionId: newest.sessionId, mimeType: newest.mimeType };
      await checkpointVoiceSession({
        sessionId: newest.sessionId,
        durationMs: Math.max(1, newest.durationMs),
        clientMessageId,
      });
      if (validation.ok) preparePlayback(result.blob);
      setState({
        ...INITIAL_STATE,
        phase: 'review',
        elapsedMs: Math.max(1, validation.durationMs ?? newest.durationMs),
        review: {
          sessionId: newest.sessionId,
          durationMs: Math.max(1, validation.durationMs ?? newest.durationMs),
          mimeType: newest.mimeType,
          clientMessageId,
        },
        interrupted: newest.interruption !== 'none' || !newest.complete,
        recoverable: validation.ok,
        missingChunks: result.missing,
        durable: true,
      });
    })();
    return () => {
      live = false;
    };
  }, [enabled, scopeUserId, scopeWorkspaceId, scopeChatId, env, preparePlayback]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        interruptedRef.current = true;
        try {
          recorder.stop();
        } catch {
          /* onstop may not fire; the checkpoint below still records state. */
        }
        const session = sessionRef.current;
        if (session) {
          void checkpointVoiceSession({
            sessionId: session.sessionId,
            durationMs: durationRef.current,
            complete: false,
            interruption: 'background',
          });
        }
      } else {
        releaseHardware();
      }
      releasePlayback();
    };
  }, [releaseHardware, releasePlayback]);

  return {
    ...state,
    start,
    stop,
    cancel,
    discard,
    send,
    togglePlayback,
  };
}
