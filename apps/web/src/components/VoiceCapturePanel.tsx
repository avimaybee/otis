/**
 * Composer capture surface for recording and Review (010 baseline).
 *
 * Presentational only: the recorder hook owns capture state, this component
 * renders the approved composer surface content (elapsed time, measured
 * level meter, Cancel and the Stop/Send slots) and reports honest local,
 * interrupted, unrecoverable and retry states. No motion framework and no
 * fake waveform: every bar reads a real AnalyserNode level.
 */

import { useEffect, useRef } from 'react';
import type { VoiceController } from '../hooks/useVoiceRecorder.js';
import { PauseIcon, PlayIcon, SendIcon, StopIcon } from './icons.js';
import { Button } from './ui/button.js';

/** Approved neutral meter geometry: 2 px bars, hairline gap, 24 px lane. */
const LEVEL_BARS = 28;

export function formatVoiceDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function VoiceMeter({ levels }: { levels: number[] }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    for (let index = 0; index < LEVEL_BARS; index += 1) {
      const element = bars.current[index];
      if (!element) continue;
      const level = levels[Math.max(0, levels.length - LEVEL_BARS + index)] ?? 0;
      element.style.transform = `scaleY(${Math.max(0.12, Math.min(1, level)).toFixed(3)})`;
    }
  }, [levels]);
  return (
    <span className="flex h-6 flex-1 items-center justify-end gap-px overflow-hidden" aria-hidden="true">
      {Array.from({ length: LEVEL_BARS }, (_, index) => (
        <span
          key={index}
          ref={element => {
            bars.current[index] = element;
          }}
          className="h-6 w-0.5 origin-center rounded-full bg-muted-foreground"
        />
      ))}
    </span>
  );
}

function reviewNotice(controller: VoiceController, canSend: boolean): string {
  if (!controller.recoverable) return 'That recording could not be recovered. Discard it.';
  if (controller.uploadState === 'failed' && controller.error) return controller.error;
  if (!canSend) return 'Voice is unavailable right now. The recording is kept on this device.';
  if (controller.interrupted) return 'Recording stopped when the app went to the background.';
  if (controller.capReached) return 'Three-minute limit reached.';
  return '';
}

export interface VoiceCapturePanelProps {
  controller: VoiceController;
  /** True only when a confirmed server handoff exists. */
  canSend: boolean;
  onCancel: () => void;
  onSend: () => void;
}

export function VoiceCapturePanel({ controller, canSend, onCancel, onSend }: VoiceCapturePanelProps) {
  if (controller.phase === 'finalizing') {
    return (
      <div className="flex w-full items-center gap-2" role="status">
        <span className="otis-spinner" aria-hidden="true" />
        <span className="text-sm text-muted-foreground">Finishing recording…</span>
      </div>
    );
  }
  if (controller.phase === 'recording') {
    return (
      <div className="flex w-full items-center gap-2">
        <span className="w-10 text-sm tabular-nums text-muted-foreground">
          {formatVoiceDuration(controller.elapsedMs)}
        </span>
        <VoiceMeter levels={controller.levels} />
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>Cancel</Button>
        <button
          type="button"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
          aria-label="Stop recording"
          onClick={controller.stop}
        >
          <StopIcon />
        </button>
      </div>
    );
  }
  const notice = reviewNotice(controller, canSend);
  const uploading = controller.uploadState === 'uploading';
  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex w-full items-center gap-2">
        <button
          type="button"
          className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={controller.playing ? 'Pause recording' : 'Play recording'}
          disabled={!controller.recoverable}
          onClick={controller.togglePlayback}
        >
          {controller.playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <span className="text-sm tabular-nums text-muted-foreground">{formatVoiceDuration(controller.elapsedMs)}</span>
        <span className="flex-1" />
        {/* While the message is being accepted, Cancel must not read as
            "unsend"; the outbox owns delivery from that point. */}
        <Button variant="ghost" size="sm" type="button" disabled={uploading} onClick={onCancel}>
          {controller.recoverable ? 'Cancel' : 'Discard'}
        </Button>
        {controller.recoverable && canSend && (
          <button
            type="button"
            className="grid size-9 shrink-0 place-items-center rounded-full bg-highlight text-highlight-foreground hover:bg-highlight-hover active:bg-highlight-pressed"
            aria-label={controller.uploadState === 'failed' ? 'Retry sending voice note' : 'Send voice note'}
            aria-busy={uploading}
            disabled={uploading}
            onClick={onSend}
          >
            {uploading ? <span className="otis-spinner" aria-hidden="true" /> : <SendIcon />}
          </button>
        )}
      </div>
      {notice && <p className={`text-xs${controller.recoverable ? ' text-subtle' : ' text-destructive'}`}>{notice}</p>}
    </div>
  );
}
