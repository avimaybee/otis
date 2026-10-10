import { useEffect, useState } from 'react';
import type { DocumentDetailResponse } from '@otis/contracts';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api/client.js';
import { markdownComponents } from './MarkdownTable.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog.js';
import { Button } from './ui/button.js';
import { ArrowDownIcon, AlertCircleIcon, CheckIcon } from './icons.js';

export interface DocumentPreviewDialogProps {
  workspaceId: string;
  documentId: string;
  revisionId?: string | null;
  isOpen: boolean;
  onClose: () => void;
}

export function DocumentPreviewDialog({
  workspaceId,
  documentId,
  revisionId,
  isOpen,
  onClose,
}: DocumentPreviewDialogProps) {
  const [detail, setDetail] = useState<DocumentDetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'formatted' | 'raw'>('formatted');
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (!isOpen || !documentId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const promise = revisionId
      ? api.getDocumentRevision(workspaceId, documentId, revisionId)
      : api.getDocument(workspaceId, documentId);

    promise
      .then((res) => {
        if (!cancelled) {
          setDetail(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load document.');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, workspaceId, documentId, revisionId]);

  const currentRev = detail?.current_revision;
  const isPdfReady = currentRev?.render_state === 'ready' && Boolean(currentRev.output_media_id);
  const isFailed = currentRev?.render_state === 'failed';
  const isRendering = currentRev?.render_state === 'rendering' || currentRev?.render_state === 'source_ready';

  const pdfDownloadUrl = isPdfReady && currentRev?.output_media_id
    ? `/api/workspaces/${encodeURIComponent(workspaceId)}/media/${encodeURIComponent(currentRev.output_media_id)}`
    : null;

  const handleRetry = async () => {
    if (!currentRev?.id) return;
    setRetrying(true);
    try {
      await api.retryDocumentRender(workspaceId, documentId, currentRev.id);
      // Refresh details
      const refreshed = await api.getDocument(workspaceId, documentId);
      setDetail(refreshed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed.');
    } finally {
      setRetrying(false);
    }
  };

  const handleDownloadMarkdown = () => {
    if (!detail?.source_markdown) return;
    const blob = new Blob([detail.source_markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${detail.document.title || 'document'}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="otis-document-dialog flex flex-col p-6 overflow-hidden">
        <DialogHeader className="shrink-0 pb-2">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <DialogTitle className="truncate text-xl font-medium">
                {detail?.document.title ?? 'Document preview'}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-1">
                {currentRev ? `Revision ${currentRev.revision_number}` : ''}
                {isRendering && ' · Generating PDF…'}
                {isPdfReady && ' · PDF ready'}
                {isFailed && ' · PDF render failed'}
              </DialogDescription>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant={viewMode === 'formatted' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('formatted')}
              >
                Formatted
              </Button>
              <Button
                variant={viewMode === 'raw' ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('raw')}
              >
                Markdown
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2 border-b border-border/40 pb-3 pt-1 text-xs">
          <div className="flex items-center gap-2">
            {isPdfReady && (
              <span className="flex items-center gap-1 font-medium text-success">
                <CheckIcon className="size-3.5" />
                <span>PDF Available</span>
              </span>
            )}
            {isRendering && (
              <span className="flex items-center gap-1 font-medium text-warning">
                <span className="otis-spinner size-3" />
                <span>Preparing PDF…</span>
              </span>
            )}
            {isFailed && (
              <span className="flex items-center gap-1 font-medium text-destructive">
                <AlertCircleIcon className="size-3.5" />
                <span>PDF Failed: {currentRev?.render_error || 'Rendering error'}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isFailed && (
              <Button variant="outline" size="sm" onClick={handleRetry} disabled={retrying}>
                {retrying ? 'Retrying…' : 'Retry PDF'}
              </Button>
            )}
            {detail?.source_markdown && (
              <Button variant="ghost" size="sm" onClick={handleDownloadMarkdown}>
                <ArrowDownIcon className="size-3.5 mr-1" />
                Export Markdown
              </Button>
            )}
            {pdfDownloadUrl && (
              <Button asChild size="sm" variant="default">
                <a href={pdfDownloadUrl} download target="_blank" rel="noreferrer">
                  <ArrowDownIcon className="size-3.5 mr-1" />
                  Download PDF
                </a>
              </Button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pt-4 pr-1">
          {loading && (
            <div className="grid place-items-center py-12 text-muted-foreground">
              <span className="otis-spinner size-6" />
              <span className="mt-2 text-sm">Loading document…</span>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
              <p className="font-medium">Failed to load document</p>
              <p className="mt-1 text-xs opacity-90">{error}</p>
            </div>
          )}

          {!loading && !error && detail && (
            viewMode === 'formatted' ? (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>
                  {detail.source_markdown || '*No content.*'}
                </Markdown>
              </div>
            ) : (
              <pre className="overflow-x-auto rounded-xl bg-secondary/30 p-4 font-mono text-xs leading-relaxed text-foreground whitespace-pre-wrap">
                {detail.source_markdown || ''}
              </pre>
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
