import { useState } from 'react';
import { AlertCircleIcon } from './icons.js';

export interface MessageImagesProps {
  workspaceId: string;
  mediaIds: string[];
}

/**
 * Attached still images on a member message, rendered through the scoped
 * private media route (session cookie, no public URL). Thumbnails load
 * lazily; each image fails independently with a quiet inline note so one
 * expired object never blanks the message. Voice-note rendering is untouched.
 */
export function MessageImages({ workspaceId, mediaIds }: MessageImagesProps) {
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  if (mediaIds.length === 0) return null;
  return (
    <div className="otis-message-images grid grid-cols-2 gap-2 pb-1" data-testid="message-images">
      {mediaIds.map(mediaId => {
        const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/media/${encodeURIComponent(mediaId)}`;
        if (failed[mediaId]) {
          return (
            <span key={mediaId} className="flex items-center gap-1 text-xs text-subtle" role="note">
              <AlertCircleIcon />
              <span>Image unavailable.</span>
            </span>
          );
        }
        return (
          <a key={mediaId} href={url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-border/40">
            <img
              src={url}
              alt="Attached file"
              loading="lazy"
              className="max-h-56 w-full object-cover"
              onError={() => setFailed(previous => ({ ...previous, [mediaId]: true }))}
            />
          </a>
        );
      })}
    </div>
  );
}
