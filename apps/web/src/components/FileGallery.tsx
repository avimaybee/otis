import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
import { Button } from './ui/button.js';

export type GalleryFile = {
  media_id: string;
  format: string;
  filename?: string | null;
  label?: string | null;
  transcript?: string | null;
  original_transcript?: string | null;
  source?: { actor_name?: string | null; recorded_at?: string | null };
};
function OriginalAudio({ url }: { url: string }) {
  // eslint-disable-next-line jsx-a11y/media-has-caption -- Prerecorded audio has the adjacent text transcript (WCAG 1.2.1); no invented timed captions.
  return <audio controls src={url} aria-label="Original voice note" className="w-full" />;
}
export function FileGallery({
  workspaceId,
  userId,
  files,
  selected,
  onSelect,
  onClose,
}: {
  workspaceId: string;
  userId: string;
  files: GalleryFile[];
  selected: number | null;
  onSelect: (n: number) => void;
  onClose: () => void;
}) {
  const file = selected === null ? null : files[selected];
  const mediaId = file?.media_id;
  const resourceKey = file ? JSON.stringify([workspaceId, userId, mediaId]) : '';
  const [original, setOriginal] = useState<{ key: string; url: string; error: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const url = original?.key === resourceKey ? original.url : '';
  const error = original?.key === resourceKey ? original.error : '';
  useEffect(() => {
    setOriginal(null);
    swipeStart.current = null;
    if (!mediaId) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    const timer = setTimeout(
      () => controller.abort(new DOMException('File download timed out.', 'TimeoutError')),
      60_000,
    );
    void fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/media/${encodeURIComponent(mediaId)}`,
      {
        credentials: 'same-origin',
        headers: { 'x-expected-user-id': userId },
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 410
              ? 'This original is no longer available.'
              : 'Unable to open this private file.',
          );
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setOriginal({ key: resourceKey, url: objectUrl, error: '' });
      })
      .catch((failure) => {
        if (!controller.signal.aborted || controller.signal.reason?.name === 'TimeoutError')
          setOriginal({
            key: resourceKey,
            url: '',
            error: failure instanceof Error ? failure.message : 'Unable to open this file.',
          });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      controller.abort();
      clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [workspaceId, userId, mediaId, resourceKey, retry]);
  return (
    <Dialog
      open={Boolean(file)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="otis-file-dialog"
        onKeyDown={(e) => {
          if (
            (e.target as HTMLElement).closest(
              'input, textarea, select, audio, video, [contenteditable=true]',
            )
          )
            return;
          if (e.key === 'ArrowLeft' && selected !== null && selected > 0) {
            e.preventDefault();
            onSelect(selected - 1);
          }
          if (e.key === 'ArrowRight' && selected !== null && selected + 1 < files.length) {
            e.preventDefault();
            onSelect(selected + 1);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{file?.label ?? file?.filename ?? 'Original file'}</DialogTitle>
          <DialogDescription>
            {selected === null ? '' : `${selected + 1} of ${files.length}`} · Private workspace file
          </DialogDescription>
        </DialogHeader>
        {file?.source && (
          <p className="text-sm text-muted-foreground">
            {file.source.actor_name ?? 'Member'}
            {file.source.recorded_at
              ? ` · ${new Date(file.source.recorded_at).toLocaleString()}`
              : ''}
          </p>
        )}
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>
              Retry
            </Button>
          </div>
        ) : !url ? (
          <p role="status">Opening file…</p>
        ) : file?.format.startsWith('image/') ? (
          <img
            className="otis-file-original"
            src={url}
            alt={file.label ?? file.filename ?? 'Client attachment'}
            onTouchStart={(e) => {
              const touch = e.touches[0];
              swipeStart.current =
                e.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
            }}
            onTouchEnd={(e) => {
              const start = swipeStart.current;
              swipeStart.current = null;
              const touch = e.changedTouches[0];
              if (!start || !touch || e.touches.length !== 0 || selected === null) return;
              const horizontal = touch.clientX - start.x;
              const vertical = touch.clientY - start.y;
              if (Math.abs(horizontal) < 48 || Math.abs(horizontal) <= Math.abs(vertical) * 1.5)
                return;
              const next = selected + (horizontal < 0 ? 1 : -1);
              if (next >= 0 && next < files.length) onSelect(next);
            }}
            onTouchCancel={() => {
              swipeStart.current = null;
            }}
          />
        ) : file?.format.startsWith('audio/') ? (
          <>
            <OriginalAudio url={url} />
            {file.transcript && (
              <details open>
                <summary>Transcript</summary>
                <p className="whitespace-pre-wrap break-words mt-2">{file.transcript}</p>
              </details>
            )}
            {file.original_transcript && file.original_transcript !== file.transcript && (
              <details>
                <summary>Original transcript</summary>
                <p className="whitespace-pre-wrap break-words mt-2">{file.original_transcript}</p>
              </details>
            )}
          </>
        ) : (
          <iframe
            title={file?.filename ?? 'Original PDF'}
            src={url}
            className="otis-file-original border-0"
          />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={selected === null || selected === 0}
            onClick={() => onSelect(selected! - 1)}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            disabled={selected === null || selected + 1 >= files.length}
            onClick={() => onSelect(selected! + 1)}
          >
            Next
          </Button>
          {url && (
            <a
              href={url}
              download={file?.filename ?? 'Original file'}
              className="text-sm underline underline-offset-4 ml-auto"
            >
              Download original
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
