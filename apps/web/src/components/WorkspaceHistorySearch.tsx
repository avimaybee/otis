import { useEffect, useRef, useState } from 'react';
import type { HistorySearchResponse, SearchWorkspaceHistoryArgs } from '@otis/contracts';
import { api } from '../api/client.js';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { ChoiceSelect } from './ui/select.js';
import { WorkspaceSource } from './WorkspaceSource.js';

export function WorkspaceHistorySearch({
  workspaceId,
  open,
  onClose,
  onOpenChat,
  members = {},
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  onOpenChat: (id: string) => void;
  members?: Record<string, string>;
}) {
  const [words, setWords] = useState(''),
    [kind, setKind] = useState('all'),
    [mode, setMode] = useState('relevance'),
    [author, setAuthor] = useState('all'),
    [from, setFrom] = useState(''),
    [to, setTo] = useState('');
  const [result, setResult] = useState<HistorySearchResponse | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [source, setSource] = useState<string | null>(null);
  const read = useRef<AbortController | null>(null),
    submitted = useRef<SearchWorkspaceHistoryArgs | null>(null);
  useEffect(() => {
    setResult(null);
    setError('');
    setSource(null);
    setPending(false);
    read.current?.abort();
    return () => read.current?.abort();
  }, [workspaceId, open]);
  const search = async (more = false) => {
    if ((!more && !words.trim()) || (more && !submitted.current)) return;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    setPending(true);
    setError('');
    const args: SearchWorkspaceHistoryArgs =
      more && submitted.current
        ? { ...submitted.current, cursor: result?.next_cursor ?? undefined }
        : {
            query: words.trim(),
            mode: mode as 'relevance' | 'chronological',
            ...(kind !== 'all' ? { source_kind: kind as 'member' | 'otis' | 'system' } : {}),
            ...(author !== 'all' ? { author_user_id: author } : {}),
            ...(from ? { from: `${from}T00:00:00Z` } : {}),
            ...(to ? { to: new Date(Date.parse(`${to}T00:00:00Z`) + 86400000).toISOString() } : {}),
          };
    if (!more) {
      submitted.current = args;
      setResult(null);
    }
    try {
      const response = await api.searchWorkspaceHistory(workspaceId, args, controller.signal);
      if (!controller.signal.aborted)
        setResult((previous) =>
          more && previous
            ? { ...response, items: [...previous.items, ...response.items] }
            : response,
        );
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'Search is unavailable.');
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };
  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(v) => {
          if (!v) onClose();
        }}
      >
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto bg-sidebar">
          <SheetHeader>
            <SheetTitle>Search conversations</SheetTitle>
            <SheetDescription>Find the original words across this workspace.</SheetDescription>
          </SheetHeader>
          <div className="p-4 space-y-4 min-w-0">
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void search();
              }}
            >
              <label htmlFor="history-words" className="text-sm block">
                Search words
                <Input
                  id="history-words"
                  type="search"
                  value={words}
                  onChange={(e) => setWords(e.target.value)}
                  placeholder="What did we promise Popescu?"
                  autoComplete="off"
                />
              </label>
              <details>
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  Narrow the search
                </summary>
                <div className="mt-3 space-y-3">
                  <ChoiceSelect
                    label="Evidence from"
                    value={kind}
                    onChange={setKind}
                    options={[
                      { value: 'all', label: 'All messages' },
                      { value: 'member', label: 'Team members' },
                      { value: 'otis', label: 'Otis replies' },
                      { value: 'system', label: 'System notices' },
                    ]}
                  />
                  <ChoiceSelect
                    label="Author"
                    value={author}
                    onChange={setAuthor}
                    options={[
                      { value: 'all', label: 'Everyone' },
                      ...Object.entries(members).map(([value, label]) => ({ value, label })),
                    ]}
                  />
                  <div className="grid sm:grid-cols-2 gap-3">
                    <label htmlFor="history-from" className="text-sm">
                      From date (UTC)
                      <Input
                        id="history-from"
                        type="date"
                        value={from}
                        onChange={(e) => setFrom(e.target.value)}
                      />
                    </label>
                    <label htmlFor="history-to" className="text-sm">
                      Through date (UTC)
                      <Input
                        id="history-to"
                        type="date"
                        value={to}
                        onChange={(e) => setTo(e.target.value)}
                      />
                    </label>
                  </div>
                </div>
              </details>
              <div className="flex flex-wrap gap-2">
                <ChoiceSelect
                  label="Search order"
                  className="flex-1 min-w-0"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'relevance', label: 'Best matches' },
                    { value: 'chronological', label: 'Newest first · all matching pages' },
                  ]}
                />
                <Button type="submit" disabled={!words.trim() || pending}>
                  {pending ? 'Searching…' : 'Search'}
                </Button>
              </div>
            </form>
            {error && (
              <div role="alert">
                <p className="text-destructive">{error}</p>
                <Button variant="outline" onClick={() => void search()}>
                  Retry search
                </Button>
              </div>
            )}
            {result && (
              <>
                <p role="status" className="text-sm text-muted-foreground">
                  {result.items.length} of {result.total} matches
                  {!result.coverage.index_complete
                    ? ' · Older conversations are still being indexed'
                    : ''}
                </p>
                {!result.items.length ? (
                  <p>No matching retained messages. Try a name or a few distinctive words.</p>
                ) : (
                  <ol className="space-y-4">
                    {result.items.map((hit) => (
                      <li key={hit.message_id} className="border-b border-border pb-4 space-y-2">
                        <p className="text-xs text-muted-foreground">
                          {hit.chat_title ?? 'Conversation'} ·{' '}
                          {hit.author_name ?? (hit.source_kind === 'otis' ? 'Otis' : 'System')} ·{' '}
                          {new Date(hit.recorded_at).toLocaleString()}
                        </p>
                        <p className="whitespace-pre-wrap break-words">{hit.excerpt}</p>
                        {hit.source_kind !== 'member' && (
                          <p className="text-xs text-muted-foreground">
                            {hit.source_kind === 'otis'
                              ? 'Otis reply — check the member’s original wording before treating this as a promise.'
                              : 'System notice'}
                          </p>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => setSource(hit.message_id)}>
                          Open original
                        </Button>
                      </li>
                    ))}
                  </ol>
                )}
                {result.next_cursor && (
                  <Button variant="outline" disabled={pending} onClick={() => void search(true)}>
                    {pending ? 'Loading…' : 'Load more matches'}
                  </Button>
                )}
                {result.has_more && !result.next_cursor && (
                  <p className="text-sm text-muted-foreground">
                    Choose Newest first to read every matching page.
                  </p>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <WorkspaceSource
        workspaceId={workspaceId}
        sourceId={source}
        onClose={() => setSource(null)}
        onOpenChat={(id) => {
          onOpenChat(id);
          onClose();
        }}
      />
    </>
  );
}
