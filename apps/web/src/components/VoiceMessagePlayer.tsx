import { useEffect, useRef, useState, useCallback } from 'react';
import { PlayIcon, PauseIcon, AlertCircleIcon } from './icons.js';
import { Button } from './ui/button.js';

export interface VoiceMessagePlayerProps {
  workspaceId: string;
  mediaId: string;
  text?: string | null;
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function VoiceMessagePlayer({ workspaceId, mediaId, text }: VoiceMessagePlayerProps) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'paused' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const cleanupAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      audioRef.current.load();
      audioRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      cleanupAudio();
    };
  }, [cleanupAudio]);

  const inspectError = useCallback(async () => {
    try {
      const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/media/${encodeURIComponent(mediaId)}`;
      const res = await fetch(url, { credentials: 'include' });
      if (res.status === 410) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        if (body?.error === 'audio_expired') {
          setErrorMessage('Recording expired. Transcript retained.');
        } else {
          setErrorMessage('Recording no longer available.');
        }
      } else if (res.status === 404) {
        setErrorMessage('Recording not found.');
      } else if (res.status === 403) {
        setErrorMessage('Access denied.');
      } else {
        setErrorMessage('Recording could not be loaded.');
      }
    } catch {
      setErrorMessage('Network error loading recording.');
    }
    setStatus('error');
  }, [workspaceId, mediaId]);

  const togglePlayback = useCallback(() => {
    if (status === 'error') return;

    if (status === 'playing') {
      audioRef.current?.pause();
      setStatus('paused');
      return;
    }

    if (status === 'paused' && audioRef.current) {
      void audioRef.current.play().then(
        () => setStatus('playing'),
        () => void inspectError(),
      );
      return;
    }

    // Idle or starting fresh
    cleanupAudio();
    setStatus('loading');
    const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/media/${encodeURIComponent(mediaId)}`;
    const audio = new Audio(url);
    audioRef.current = audio;

    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
    };

    audio.ontimeupdate = () => {
      setCurrentTime(audio.currentTime);
    };

    audio.onended = () => {
      setStatus('idle');
      setCurrentTime(0);
    };

    audio.onerror = () => {
      void inspectError();
    };

    void audio.play().then(
      () => setStatus('playing'),
      () => {
        // Play failed (e.g. 404/410 HTTP error)
        void inspectError();
      },
    );
  }, [status, workspaceId, mediaId, cleanupAudio, inspectError]);

  return (
    <div className="space-y-2" data-testid="voice-message-player">
      {text ? (
        <div className="text-base text-card-foreground">{text}</div>
      ) : (
        <div className="text-sm text-subtle italic">Voice note</div>
      )}
      <div className="flex items-center gap-2 pt-1 border-t border-border/40 text-xs text-subtle">
        {status === 'error' ? (
          <span className="flex items-center gap-1 text-xs text-destructive" role="alert">
            <AlertCircleIcon />
            <span>{errorMessage ?? 'Recording unavailable.'}</span>
          </span>
        ) : (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              className="otis-msg-action shrink-0"
              aria-label={status === 'playing' ? 'Pause voice note' : 'Play voice note'}
              title={status === 'playing' ? 'Pause' : 'Play'}
              disabled={status === 'loading'}
              onClick={togglePlayback}
            >
              {status === 'playing' ? <PauseIcon /> : <PlayIcon />}
            </Button>
            <span className="tabular-nums">
              {status === 'loading'
                ? 'Loading…'
                : status === 'playing' || status === 'paused'
                ? `${formatDuration(currentTime)} / ${formatDuration(duration)}`
                : duration > 0
                ? formatDuration(duration)
                : 'Play recording'}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
