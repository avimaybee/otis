import { useState } from 'react';
import type { DocumentRevision, GeneratedDocument } from '@otis/contracts';
import { api } from '../api/client.js';
import { Button } from './ui/button.js';
import { FileTextIcon, ArrowDownIcon, AlertCircleIcon, CheckIcon } from './icons.js';
import { DocumentPreviewDialog } from './DocumentPreviewDialog.js';

export interface DocumentArtifactCardProps {
  workspaceId: string;
  document: GeneratedDocument;
  revision: DocumentRevision | null;
  onRevisionUpdated?: (revision: DocumentRevision) => void;
}

export function DocumentArtifactCard({
  workspaceId,
  document,
  revision,
  onRevisionUpdated,
}: DocumentArtifactCardProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const isPdfReady = revision?.render_state === 'ready' && Boolean(revision.output_media_id);
  const isFailed = revision?.render_state === 'failed';
  const isRendering = revision?.render_state === 'rendering' || revision?.render_state === 'source_ready';

  const pdfDownloadUrl = isPdfReady && revision?.output_media_id
    ? `/api/workspaces/${encodeURIComponent(workspaceId)}/media/${encodeURIComponent(revision.output_media_id)}`
    : null;

  const handleRetry = async () => {
    if (!revision?.id) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await api.retryDocumentRender(workspaceId, document.id, revision.id);
      // Fetch fresh revision
      const detail = await api.getDocument(workspaceId, document.id);
      if (detail.current_revision) {
        onRevisionUpdated?.(detail.current_revision);
      }
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setRetrying(false);
    }
  };

  return (
    <>
      <div
        className="otis-document-artifact my-2 flex flex-col gap-2 rounded-2xl border border-border/50 bg-card p-3"
        data-testid="document-artifact-card"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <FileTextIcon className="size-5" />
            </div>
            <div className="min-w-0">
              <h4 className="truncate text-sm font-medium text-foreground">
                {document.title || 'Untitled Document'}
              </h4>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {revision && <span>Rev {revision.revision_number}</span>}
                {isPdfReady && (
                  <span className="flex items-center gap-1 font-medium text-success">
                    <CheckIcon className="size-3" />
                    <span>PDF ready</span>
                  </span>
                )}
                {isRendering && (
                  <span className="flex items-center gap-1 font-medium text-warning">
                    <span className="otis-spinner size-2.5" />
                    <span>Preparing PDF…</span>
                  </span>
                )}
                {isFailed && (
                  <span className="flex items-center gap-1 font-medium text-destructive">
                    <AlertCircleIcon className="size-3" />
                    <span>PDF failed</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs cursor-pointer"
              onClick={() => setDialogOpen(true)}
            >
              Open
            </Button>
            {pdfDownloadUrl && (
              <Button asChild size="sm" variant="default" className="h-8 text-xs">
                <a href={pdfDownloadUrl} download target="_blank" rel="noreferrer">
                  <ArrowDownIcon className="size-3 mr-1" />
                  PDF
                </a>
              </Button>
            )}
            {isFailed && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-destructive hover:bg-destructive/10"
                onClick={handleRetry}
                disabled={retrying}
              >
                {retrying ? 'Retrying…' : 'Retry PDF'}
              </Button>
            )}
          </div>
        </div>

        {retryError && (
          <p className="text-xs text-destructive mt-1" role="alert">
            {retryError}
          </p>
        )}
      </div>

      <DocumentPreviewDialog
        workspaceId={workspaceId}
        documentId={document.id}
        revisionId={revision?.id}
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
      />
    </>
  );
}
