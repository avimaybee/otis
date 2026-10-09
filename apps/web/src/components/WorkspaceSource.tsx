import { useEffect, useState } from 'react';
import type { WorkspaceMessageSource } from '@otis/contracts';
import { api } from '../api/client.js';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet.js';
import { Button } from './ui/button.js';

export function WorkspaceSource({
  workspaceId,
  sourceId,
  onClose,
  onOpenChat,
}: {
  workspaceId: string;
  sourceId: string | null;
  onClose: () => void;
  onOpenChat?: (id: string) => void;
}) {
  const [source, setSource] = useState<WorkspaceMessageSource | null>(null),
    [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setSource(null);
    setError('');
    if (!sourceId) return;
    const controller = new AbortController();
    void api.workspaceSource(workspaceId, sourceId, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setSource(value);
      },
      (failure) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'Unable to open this source.');
      },
    );
    return () => controller.abort();
  }, [workspaceId, sourceId, retry]);
  return (
    <Sheet
      open={Boolean(sourceId)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto bg-sidebar">
        <SheetHeader>
          <SheetTitle>Original source</SheetTitle>
          <SheetDescription>The original wording and nearby conversation.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6 space-y-4 min-w-0">
          {error ? (
            <div role="alert">
              <p>{error}</p>
              <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>
                Retry
              </Button>
            </div>
          ) : !source ? (
            <p role="status">Opening source…</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {source.author_name ?? 'Otis'} · {new Date(source.recorded_at).toLocaleString()} ·{' '}
                {source.channel}
              </p>
              <p className="whitespace-pre-wrap break-words">{source.text}</p>
              {source.chat_id && onOpenChat && (
                <Button
                  variant="outline"
                  onClick={() => {
                    onOpenChat(source.chat_id!);
                    onClose();
                  }}
                >
                  Open conversation
                </Button>
              )}
              {source.context.length > 1 && (
                <details>
                  <summary className="cursor-pointer text-sm">Nearby messages</summary>
                  <ol className="mt-3 space-y-4">
                    {source.context
                      .filter((r) => r.id !== source.id)
                      .map((r) => (
                        <li key={r.id}>
                          <p className="text-xs text-muted-foreground">
                            {r.author_name ?? (r.author_kind === 'member' ? 'Member' : 'Otis')}
                          </p>
                          <p className="whitespace-pre-wrap break-words">{r.text}</p>
                        </li>
                      ))}
                  </ol>
                </details>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
