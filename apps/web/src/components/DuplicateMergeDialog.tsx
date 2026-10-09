import { useState, useEffect } from 'react';
import { api } from '../api/client.js';
import { Overlay } from './Overlay.js';
import { Button } from './ui/button.js';
import { CloseIcon } from './icons.js';

interface DuplicateCandidate {
  entity_a: { id: string; name: string; kind?: string | null; status?: string | null; company?: string | null };
  entity_b: { id: string; name: string; kind?: string | null; status?: string | null; company?: string | null };
  similarity: number;
  reason: string;
}

export interface DuplicateMergeDialogProps {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  onMergeRequest?: (sourceId: string, targetId: string) => void;
  onMergeComplete?: () => void;
}

export function DuplicateMergeDialog({
  workspaceId,
  open,
  onClose,
  onMergeRequest,
  onMergeComplete,
}: DuplicateMergeDialogProps) {
  const [candidates, setCandidates] = useState<DuplicateCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setLoading(true);
      setError(null);
      api
        .duplicates(workspaceId)
        .then((res) => {
          setCandidates(res.candidates);
          setLoading(false);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Could not check for duplicates.');
          setLoading(false);
        });
    }
  }, [open, workspaceId]);

  if (!open) return null;

  return (
    <Overlay label="Duplicate records review" className="otis-overlay--dialog" onClose={onClose}>
      <div className="otis-dialog-card max-w-xl w-full flex flex-col overflow-hidden">
        <header className="otis-dialog-card__header flex items-center justify-between border-b border-border p-4 shrink-0">
          <div>
            <h2 className="text-base font-medium text-foreground">Possible duplicate records</h2>
            <p className="text-xs text-muted-foreground">
              Review similar records and choose which one to keep as canonical.
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            className="otis-iconbutton shrink-0"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <CloseIcon />
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {loading && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Scanning business records for similar names and variations…
            </div>
          )}

          {error && (
            <div className="py-4 text-center text-sm text-destructive">
              {error}
            </div>
          )}

          {!loading && !error && candidates.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">No duplicate records found</p>
              <p>All active clients, leads, and businesses appear unique.</p>
            </div>
          )}

          {!loading && candidates.length > 0 && (
            <div className="space-y-4">
              {candidates.map((pair, idx) => (
                <div
                  key={`dup-${idx}`}
                  className="p-3 rounded-lg border border-border bg-card space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium px-2 py-1 rounded bg-muted text-foreground">
                      {pair.reason} ({Math.round(pair.similarity * 100)}% match)
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="p-3 rounded border border-border/60 bg-background/50 space-y-1">
                      <p className="text-sm font-medium text-foreground">{pair.entity_a.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {[pair.entity_a.kind, pair.entity_a.status, pair.entity_a.company]
                          .filter(Boolean)
                          .join(' · ') || 'No extra details'}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full text-xs mt-2"
                        onClick={() => {
                          onClose();
                          onMergeRequest?.(pair.entity_b.id, pair.entity_a.id);
                          onMergeComplete?.();
                        }}
                      >
                        Keep &ldquo;{pair.entity_a.name}&rdquo;
                      </Button>
                    </div>

                    <div className="p-3 rounded border border-border/60 bg-background/50 space-y-1">
                      <p className="text-sm font-medium text-foreground">{pair.entity_b.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {[pair.entity_b.kind, pair.entity_b.status, pair.entity_b.company]
                          .filter(Boolean)
                          .join(' · ') || 'No extra details'}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full text-xs mt-2"
                        onClick={() => {
                          onClose();
                          onMergeRequest?.(pair.entity_a.id, pair.entity_b.id);
                          onMergeComplete?.();
                        }}
                      >
                        Keep &ldquo;{pair.entity_b.name}&rdquo;
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Overlay>
  );
}
