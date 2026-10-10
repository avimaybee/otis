import { useState } from 'react';
import { AlertCircleIcon, FileTextIcon } from './icons.js';

export interface MessageDocumentsProps {
  workspaceId: string;
  mediaIds: string[];
}

/**
 * Attached documents (PDF, text, markdown) on a member message, rendered
 * through the scoped private media route.
 */
export function MessageDocuments({ workspaceId, mediaIds }: MessageDocumentsProps) {
  const [failed] = useState<Record<string, boolean>>({});
  if (mediaIds.length === 0) return null;

  return (
    <div className="otis-message-documents flex flex-col gap-1 pb-2 pt-1" data-testid="message-documents">
      {mediaIds.map((mediaId) => {
        const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/media/${encodeURIComponent(mediaId)}`;
        if (failed[mediaId]) {
          return (
            <span key={mediaId} className="flex items-center gap-1 text-xs text-subtle" role="note">
              <AlertCircleIcon />
              <span>Document unavailable.</span>
            </span>
          );
        }
        return (
          <a
            key={mediaId}
            href={url}
            target="_blank"
            rel="noreferrer"
            download
            className="flex items-center gap-2 rounded-xl border border-border/40 bg-secondary/30 px-3 py-2 text-sm text-foreground transition-colors hover:bg-secondary/60 hover:text-foreground cursor-pointer"
          >
            <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">Attached document</span>
          </a>
        );
      })}
    </div>
  );
}
