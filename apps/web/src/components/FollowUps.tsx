import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FollowUpPage, FollowUpRow, ReminderSpec } from '@otis/contracts';
import { api } from '../api/client.js';
import { Button } from './ui/button.js';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet.js';
import { WorkspaceSource } from './WorkspaceSource.js';
const SavedChange = lazy(() =>
  import('./DetailPane.js').then((module) => ({ default: module.DetailPane })),
);

export function describeFollowUp(spec: ReminderSpec): string {
  if (spec.kind === 'weekly')
    return `Every ${spec.weekdays.map((d) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d]).join(', ')} at ${spec.local_time}${spec.start_date ? ` · from ${spec.start_date}` : ''}${spec.end_date ? ` · until ${spec.end_date}` : ''}`;
  return `${'hours' in spec.offset ? `${spec.offset.hours} hours` : `${spec.offset.days} calendar days at ${spec.offset.local_time}`} after an ${spec.role} quote${spec.if_no_contact ? ', unless someone contacted the client' : ''}`;
}

export function FollowUps({
  workspaceId,
  userId,
  open,
  onClose,
  initialPage,
}: {
  workspaceId: string;
  userId: string;
  open: boolean;
  onClose: () => void;
  initialPage?: FollowUpPage;
}) {
  const queryClient = useQueryClient(),
    key = ['followups', userId, workspaceId];
  const query = useQuery({
    queryKey: key,
    enabled: open,
    queryFn: ({ signal }) => api.followUps(workspaceId, undefined, signal),
    initialData: initialPage,
    staleTime: initialPage ? Infinity : 30_000,
  });
  const [extra, setExtra] = useState<FollowUpRow[]>([]),
    [cursor, setCursor] = useState<string | null | undefined>(undefined),
    [pending, setPending] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [lastAction, setLastAction] = useState<string | null>(null),
    [detail, setDetail] = useState<string | null>(null),
    [source, setSource] = useState<string | null>(null);
  const retry = useRef<{ signature: string; id: string } | null>(null),
    reads = useRef<AbortController | null>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      reads.current?.abort();
    };
  }, []);
  useEffect(() => {
    setExtra([]);
    setCursor(undefined);
    reads.current?.abort();
  }, [workspaceId, userId, query.data?.as_of_business_revision]);
  const change = async (row: FollowUpRow, status: string) => {
    if (!query.data || pending) return;
    const args = { rule_id: row.id, expected_revision: row.revision, status },
      signature = JSON.stringify([args, query.data.as_of_business_revision]);
    if (retry.current?.signature !== signature)
      retry.current = { signature, id: crypto.randomUUID() };
    setPending(row.id);
    setError('');
    setNotice('');
    try {
      const result = await api.followUpAction(
        workspaceId,
        {
          args,
          operation_id: retry.current.id,
          expected_revision: query.data.as_of_business_revision,
        },
        userId,
      );
      if (!['applied', 'already_applied'].includes(result.status))
        throw new Error(result.error?.message ?? 'Unable to change this follow-up.');
      retry.current = null;
      if (alive.current) {
        setNotice(result.summary ?? 'Saved.');
        setLastAction(result.action_id ?? null);
        await queryClient.cancelQueries({ queryKey: key });
        await queryClient.invalidateQueries({ queryKey: key });
      }
    } catch (failure) {
      if (alive.current)
        setError(failure instanceof Error ? failure.message : 'Unable to save. Retry this change.');
    } finally {
      if (alive.current) setPending('');
    }
  };
  const next = cursor === undefined ? query.data?.next_cursor : cursor;
  const load = async () => {
    if (!next || pending) return;
    reads.current?.abort();
    const controller = new AbortController();
    reads.current = controller;
    setPending('page');
    setError('');
    try {
      const page = await api.followUps(workspaceId, next, controller.signal);
      if (!controller.signal.aborted) {
        setExtra((previous) => [...previous, ...page.rows]);
        setCursor(page.next_cursor);
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'Unable to load more.');
    } finally {
      if (!controller.signal.aborted && alive.current) setPending('');
    }
  };
  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(value) => {
          if (!value) onClose();
        }}
      >
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Your follow-ups</SheetTitle>
            <SheetDescription>
              Only reminders you asked for. Ask Otis to change their wording or timing.
            </SheetDescription>
          </SheetHeader>
          <div className="p-4 space-y-4">
            {query.isPending ? (
              <p role="status">Loading follow-ups…</p>
            ) : query.data ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {query.data.rows.length + extra.length} of {query.data.total} follow-ups
                </p>
                {query.data.total === 0 && (
                  <p>No recurring follow-ups yet. Tell Otis when and what to remind you about.</p>
                )}
                <ul className="space-y-4">
                  {[...query.data.rows, ...extra].map((row) => (
                    <li key={row.id} className="space-y-2 border-b border-border pb-4 break-words">
                      <p>{row.text}</p>
                      <p className="text-sm text-muted-foreground">
                        {describeFollowUp(row.spec)} · {row.timezone} · {row.channel}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {row.actor_name ?? 'Member'} · {new Date(row.recorded_at).toLocaleString()}
                      </p>
                      {row.source_message_id && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSource(row.source_message_id)}
                        >
                          Original source
                        </Button>
                      )}
                      <p className="text-sm text-muted-foreground">
                        {row.status === 'paused'
                          ? 'Paused'
                          : row.next_due
                            ? `Next: ${new Date(row.next_due).toLocaleString()}`
                            : 'Waiting for a matching occurrence'}
                        {row.last_delivered_at
                          ? ` · Last delivered: ${new Date(row.last_delivered_at).toLocaleString()}`
                          : ''}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={Boolean(pending)}
                          onClick={() =>
                            void change(row, row.status === 'paused' ? 'active' : 'paused')
                          }
                        >
                          {row.status === 'paused' ? 'Resume' : 'Pause'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={Boolean(pending)}
                          onClick={() => void change(row, 'cancelled')}
                        >
                          Cancel follow-up
                        </Button>
                      </div>
                      {pending === row.id && <p role="status">Saving…</p>}
                    </li>
                  ))}
                </ul>
                {next && (
                  <Button variant="outline" disabled={Boolean(pending)} onClick={() => void load()}>
                    {pending === 'page' ? 'Loading…' : 'Load more'}
                  </Button>
                )}
              </>
            ) : (
              <p role="alert">
                {query.error instanceof Error ? query.error.message : 'Unable to load follow-ups.'}
              </p>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            {notice && <p role="status">{notice}</p>}
            {lastAction && (
              <Button variant="outline" size="sm" onClick={() => setDetail(lastAction)}>
                Review / Undo
              </Button>
            )}
            <Button
              variant="outline"
              disabled={Boolean(pending) || query.isFetching}
              onClick={() => void query.refetch()}
            >
              Refresh
            </Button>
          </div>
        </SheetContent>
      </Sheet>
      <WorkspaceSource
        workspaceId={workspaceId}
        sourceId={source}
        onClose={() => setSource(null)}
      />
      {detail && (
        <Suspense fallback={<p role="status">Opening saved change…</p>}>
          <SavedChange
            workspaceId={workspaceId}
            chatId=""
            actionId={detail}
            onClose={() => setDetail(null)}
            onUndone={() => {
              setLastAction(null);
              setNotice('Changes undone.');
              void queryClient.invalidateQueries({ queryKey: key });
            }}
          />
        </Suspense>
      )}
    </>
  );
}
