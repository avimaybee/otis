import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CurrentInteraction,
  EntityContact,
  EntityFile,
  EntityFileSection,
  EntityFileSectionResponse,
  FilePage,
  FileTask,
} from '@otis/contracts';
import { api, ApiError } from '../api/client.js';
import { parseQuoteAmount, quoteMajorUnits } from '@otis/contracts';
import { describeFollowUp } from './FollowUps.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Textarea } from './ui/textarea.js';
import { ChoiceSelect } from './ui/select.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
import { WorkspaceSource } from './WorkspaceSource.js';
import { FileGallery, type GalleryFile } from './FileGallery.js';
const SavedChange = lazy(() =>
  import('./DetailPane.js').then((module) => ({ default: module.DetailPane })),
);

const labels: Record<string, string> = {
  facts: 'Current information',
  contacts: 'Contact details',
  tasks: 'Next steps',
  quotes: 'Quotes',
  timeline: 'Timeline',
  notes: 'Notes',
  attachments: 'Files',
  drafts: 'Draft messages',
  reminders: 'Follow-ups',
  memory: 'Saved context',
  history: 'History',
};
const sections: EntityFileSection[] = [
  'facts',
  'contacts',
  'tasks',
  'quotes',
  'timeline',
  'notes',
  'attachments',
  'drafts',
  'reminders',
  'memory',
  'history',
];
const display = (value: unknown) =>
  value === null || value === undefined
    ? 'Unknown'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
const entryText = (entry: CurrentInteraction) =>
  display(
    entry.payload.text ??
      entry.payload.summary ??
      entry.payload.description ??
      entry.payload.notes ??
      entry.kind,
  );
const timestamp = (value: string) =>
  Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleString();
function historyText(row: Record<string, unknown>): string {
  const payload = row.payload as Record<string, unknown> | undefined;
  if (!payload) return String(row.kind).replaceAll('_', ' ');
  const content = (payload.payload ?? payload) as Record<string, unknown>;
  if (typeof content.text === 'string') return content.text;
  if (typeof content.summary === 'string') return content.summary;
  if (typeof content.amount === 'number' && typeof content.currency === 'string')
    return `${quoteMajorUnits(content.amount, content.currency)} ${content.currency}`;
  return (
    Object.entries(content)
      .filter(
        ([key, value]) =>
          !/(^id$|_id$|revision|sequence)/.test(key) &&
          ['string', 'number', 'boolean'].includes(typeof value),
      )
      .slice(0, 6)
      .map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`)
      .join(' · ') || 'Saved change'
  );
}
type Editor =
  | { kind: 'entry'; entry: CurrentInteraction }
  | { kind: 'contact'; contact?: EntityContact }
  | { kind: 'transcript'; file: Record<string, unknown> };

/** Optional inspection only. Its explicit entry Save never touches Records drafts. */
export function EntityFilePane({
  workspaceId,
  userId,
  entityId,
  onAsk,
  onOpenChat,
  initialFile,
  initialSection = 'facts',
}: {
  workspaceId: string;
  userId: string;
  entityId: string;
  onAsk?: (name: string) => void;
  onOpenChat?: (id: string) => void;
  initialFile?: EntityFile;
  initialSection?: EntityFileSection;
}) {
  const client = useQueryClient(),
    key = ['entity-file', userId, workspaceId, entityId];
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      (await api.entityFile(workspaceId, entityId, {}, signal)) as EntityFile,
    initialData: initialFile,
    staleTime: initialFile ? Infinity : 30_000,
  });
  const file = query.data;
  const [section, setSection] = useState<EntityFileSection>(initialSection),
    [pages, setPages] = useState<Partial<Record<EntityFileSection, FilePage>>>({}),
    [source, setSource] = useState<string | null>(null),
    [editor, setEditor] = useState<Editor | null>(null),
    [pending, setPending] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [text, setText] = useState(''),
    [date, setDate] = useState(''),
    [currency, setCurrency] = useState('EUR'),
    [role, setRole] = useState('offered'),
    [method, setMethod] = useState('phone'),
    [label, setLabel] = useState(''),
    [primary, setPrimary] = useState(false);
  const [gallery, setGallery] = useState<number | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null),
    [detail, setDetail] = useState<string | null>(null);
  const [staleEdit, setStaleEdit] = useState(false),
    [fileOptions, setFileOptions] = useState<{
      include_removed?: boolean;
      author_user_id?: string;
      from?: string;
      to?: string;
      order?: string;
    }>({});
  const [authorFilter, setAuthorFilter] = useState('all'),
    [fromFilter, setFromFilter] = useState(''),
    [toFilter, setToFilter] = useState(''),
    [orderFilter, setOrderFilter] = useState('occurred');
  const [latestEntry, setLatestEntry] = useState<CurrentInteraction | null>(null);
  const retry = useRef<{ signature: string; id: string } | null>(null),
    alive = useRef(true),
    reads = useRef<AbortController | null>(null),
    upload = useRef<{ file: File; id: string; mediaId?: string } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      reads.current?.abort();
    };
  }, []);
  useEffect(() => {
    reads.current?.abort();
    setPages({});
    setPending('');
    setFileOptions({});
    setAuthorFilter('all');
    setFromFilter('');
    setToFilter('');
    setOrderFilter('occurred');
    setGallery(null);
  }, [entityId, workspaceId, file?.as_of_business_revision]);
  const refresh = async () => {
    reads.current?.abort();
    setPages({});
    await client.cancelQueries({ queryKey: key });
    await client.invalidateQueries({ queryKey: key });
  };
  const change = async (command: string, args: unknown, control: string) => {
    if (!file || pending) return false;
    const signature = JSON.stringify([command, args, file.as_of_business_revision]);
    if (retry.current?.signature !== signature)
      retry.current = { signature, id: crypto.randomUUID() };
    setPending(control);
    setError('');
    setNotice('');
    try {
      const result = await api.entityAction(
        workspaceId,
        entityId,
        {
          command,
          args,
          operation_id: retry.current.id,
          expected_revision: file.as_of_business_revision,
        },
        userId,
      );
      if (!['applied', 'already_applied'].includes(result.status))
        throw new Error(
          result.clarification?.prompt ??
            result.error?.message ??
            'This edit needs more information.',
        );
      retry.current = null;
      if (alive.current) {
        setNotice(result.summary ?? 'Saved.');
        setLastAction(result.action_id ?? null);
        await refresh();
      }
      return true;
    } catch (failure) {
      if (alive.current) {
        setError(failure instanceof Error ? failure.message : 'Unable to save. Retry this edit.');
        if (failure instanceof ApiError && failure.status === 409) {
          setStaleEdit(true);
          await refresh();
        }
      }
      return false;
    } finally {
      if (alive.current) setPending('');
    }
  };
  const openEditor = (next: Editor) => {
    setError('');
    setStaleEdit(false);
    setLatestEntry(null);
    setEditor(next);
    if (next.kind === 'entry') {
      const entry = next.entry;
      setText(
        entry.kind === 'quote'
          ? String(quoteMajorUnits(Number(entry.payload.amount), String(entry.payload.currency)))
          : entryText(entry),
      );
      setDate(entry.occurred_at);
      setCurrency(String(entry.payload.currency ?? 'EUR'));
      setRole(String(entry.payload.role ?? 'offered'));
    } else if (next.kind === 'transcript') setText(String(next.file.transcript ?? ''));
    else {
      setText(next.contact?.value ?? '');
      setMethod(next.contact?.method ?? 'phone');
      setLabel(next.contact?.label ?? '');
      setPrimary(next.contact?.is_primary ?? false);
    }
  };
  const saveEditor = async () => {
    if (!editor || staleEdit) return;
    let saved = false;
    if (editor.kind === 'contact')
      saved = await change(
        'change_contact',
        {
          entity_id: editor.contact?.entity_id ?? entityId,
          operation: 'save',
          ...(editor.contact
            ? { contact_id: editor.contact.id, expected_revision: editor.contact.revision }
            : {}),
          method,
          value: text,
          label,
          primary,
        },
        'editor',
      );
    else if (editor.kind === 'transcript')
      saved = await change(
        'update_attachment',
        {
          entity_id: editor.file.entity_id,
          media_id: editor.file.media_id,
          expected_revision: editor.file.annotation_revision,
          transcript: text,
        },
        'editor',
      );
    else {
      const entry = editor.entry,
        amount = entry.kind === 'quote' ? parseQuoteAmount(text, currency) : null;
      if (entry.kind === 'quote' && amount === null) {
        setError('Enter a non-negative amount with the currency’s exact decimal precision.');
        return;
      }
      const payload = {
        ...entry.payload,
        ...(entry.kind === 'quote'
          ? { amount, currency, role }
          : entry.kind === 'note'
            ? { text }
            : { summary: text }),
      };
      saved = await change(
        'revise_interaction',
        {
          interaction_id: entry.interaction_id,
          expected_head_event_id: entry.head_event_id,
          kind: entry.kind,
          payload,
          occurred_at: date,
        },
        'editor',
      );
    }
    if (saved && alive.current) setEditor(null);
  };
  const load = async (selected: EntityFileSection, more = false, options = fileOptions) => {
    if (pending) return;
    reads.current?.abort();
    const controller = new AbortController();
    reads.current = controller;
    setPending('page');
    setError('');
    const current =
      pages[selected] ?? (file?.[selected as keyof EntityFile] as FilePage | undefined);
    try {
      const response = (await api.entityFile(
        workspaceId,
        entityId,
        {
          ...options,
          section: selected,
          ...(more && current?.next_cursor ? { cursor: current.next_cursor } : {}),
        },
        controller.signal,
      )) as EntityFileSectionResponse;
      if (!controller.signal.aborted)
        setPages((prior) => ({
          ...prior,
          [selected]: {
            ...response.page,
            items: more ? [...(current?.items ?? []), ...response.page.items] : response.page.items,
          },
        }));
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'Unable to read this section.');
    } finally {
      if (!controller.signal.aborted && alive.current) setPending('');
    }
  };
  const uploadPdf = async (selected: File) => {
    if (selected.size > 20 * 1024 * 1024) {
      setError('Choose a PDF up to 20 MB.');
      return;
    }
    if (upload.current?.file !== selected)
      upload.current = { file: selected, id: crypto.randomUUID() };
    setPending('upload');
    setError('');
    try {
      const result = upload.current.mediaId
        ? { media_id: upload.current.mediaId }
        : await api.uploadDocument(workspaceId, selected, upload.current.id, userId);
      if (!alive.current) return;
      upload.current.mediaId = result.media_id;
      setPending('');
      if (
        await change(
          'link_attachment',
          { entity_id: entityId, media_id: result.media_id, label: selected.name },
          'upload',
        )
      )
        upload.current = null;
    } catch (failure) {
      if (alive.current) {
        setError(failure instanceof Error ? failure.message : 'Upload failed.');
        setPending('');
      }
    }
  };
  if (query.isPending) return <p role="status">Opening client file…</p>;
  if (!file)
    return (
      <div role="alert">
        <p>{query.error instanceof Error ? query.error.message : 'Unable to open this file.'}</p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  const page = pages[section] ?? (file[section as keyof EntityFile] as FilePage | undefined);
  const rows = page?.items as Record<string, unknown>[] | undefined;
  return (
    <div className="min-w-0 space-y-4 text-base">
      <header className="space-y-2">
        <h2 className="text-xl font-medium break-words">{file.entity.name}</h2>
        <p className="text-sm text-muted-foreground">
          {file.entity.status} · {file.entity.assigned_name ?? 'Unassigned'}
          {file.last_contact ? ` · Last contact ${timestamp(file.last_contact)}` : ''}
        </p>
        {file.entity.merged_from.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Includes {file.entity.merged_from.map((e) => e.name).join(', ')}. Original sources are
            preserved.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={Boolean(pending) || query.isFetching}
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
          {onAsk && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                onAsk(
                  `Show me everything on ${file.entity.name}, including pending work and sources. Client reference: ${file.entity.id}`,
                )
              }
            >
              Ask Otis about this
            </Button>
          )}
        </div>
      </header>
      <ChoiceSelect
        disabled={Boolean(pending)}
        label="File section"
        value={section}
        options={sections.map((s) => ({ value: s, label: labels[s]! }))}
        onChange={(value) => {
          setSection(value as EntityFileSection);
          // Filters apply to this section only. A different section starts from
          // its current unfiltered page instead of inheriting a hidden filter.
          setFileOptions({});
          setAuthorFilter('all');
          setFromFilter('');
          setToFilter('');
          setOrderFilter('occurred');
          setPages((prior) => ({ ...prior, [value]: undefined }));
          if (value === 'history') void load('history', false, {});
        }}
      />
      {['timeline', 'notes', 'quotes', 'history'].includes(section) && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const options = {
              order: orderFilter,
              ...(authorFilter !== 'all' ? { author_user_id: authorFilter } : {}),
              ...(fromFilter ? { from: new Date(`${fromFilter}T00:00:00`).toISOString() } : {}),
              ...(toFilter ? { to: new Date(`${toFilter}T00:00:00`).toISOString() } : {}),
            };
            setFileOptions(options);
            void load(section, false, options);
          }}
        >
          <ChoiceSelect
            label="Reported or corrected by"
            value={authorFilter}
            options={[
              { value: 'all', label: 'Everyone' },
              ...Object.entries(
                Object.fromEntries(
                  [
                    ...file.timeline.items.flatMap((entry) => [
                      [entry.original_actor_user_id, entry.original_actor_name],
                      [entry.actor_user_id, entry.actor_name],
                    ]),
                    ...file.facts.items.map((fact) => [
                      fact.source.actor_user_id,
                      fact.source.actor_name,
                    ]),
                  ].filter(([id]) => id),
                ),
              ).map(([value, name]) => ({ value, label: String(name ?? 'Member') })),
            ]}
            onChange={setAuthorFilter}
          />
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm" htmlFor="file-from">
              From
              <Input
                id="file-from"
                type="date"
                value={fromFilter}
                onChange={(e) => setFromFilter(e.target.value)}
              />
            </label>
            <label className="text-sm" htmlFor="file-to">
              Until (exclusive)
              <Input
                id="file-to"
                type="date"
                value={toFilter}
                onChange={(e) => setToFilter(e.target.value)}
              />
            </label>
          </div>
          <ChoiceSelect
            label="Sort and filter dates by"
            value={orderFilter}
            options={[
              { value: 'occurred', label: 'When it happened' },
              { value: 'recorded', label: 'When it was recorded' },
            ]}
            onChange={setOrderFilter}
          />
          <p className="text-xs text-muted-foreground">
            Dates use your device timezone. Authors come from loaded sources.
          </p>
          <Button type="submit" variant="outline" disabled={Boolean(pending)}>
            Apply filters
          </Button>
        </form>
      )}
      {section === 'attachments' && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={Boolean(fileOptions.include_removed)}
            disabled={Boolean(pending)}
            onChange={(e) => {
              const options = { include_removed: e.target.checked };
              setFileOptions(options);
              void load('attachments', false, options);
            }}
          />
          Show removed file links
        </label>
      )}
      {error && (
        <p role="alert" className="text-destructive break-words">
          {error}
        </p>
      )}
      {notice && (
        <div className="space-y-2">
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
          {lastAction && (
            <Button variant="outline" size="sm" onClick={() => setDetail(lastAction)}>
              Review / Undo
            </Button>
          )}
        </div>
      )}
      {section === 'contacts' && (
        <Button variant="outline" onClick={() => openEditor({ kind: 'contact' })}>
          Add phone or email
        </Button>
      )}
      {section === 'attachments' && (
        <div>
          <label className="text-sm" htmlFor={`pdf-${entityId}`}>
            Add a PDF
          </label>
          <Input
            id={`pdf-${entityId}`}
            type="file"
            accept="application/pdf,.pdf"
            disabled={Boolean(pending)}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadPdf(f);
            }}
          />
          {upload.current && !pending && (
            <Button variant="outline" onClick={() => void uploadPdf(upload.current!.file)}>
              Retry upload
            </Button>
          )}
        </div>
      )}
      {!page ? (
        <p role="status">Reading {labels[section]?.toLowerCase()}…</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {page.items.length} of {page.total} {labels[section]?.toLowerCase()}
            {page.has_more ? ' · More available below' : ''}
          </p>
          {page.availability === 'unavailable' ? (
            <p>
              This section is unavailable.{' '}
              <Button variant="outline" onClick={() => void load(section)}>
                Retry
              </Button>
            </p>
          ) : page.total === 0 ? (
            <p className="text-muted-foreground">Nothing saved here yet.</p>
          ) : (
            <ul className="space-y-4">
              {rows?.map((row, n) => {
                const id = String(row.id ?? row.interaction_id ?? row.field ?? n),
                  entry = row as unknown as CurrentInteraction,
                  contact = row as unknown as EntityContact;
                const sourceRef = row.source as
                  | { message_id?: string; actor_name?: string; recorded_at?: string }
                  | undefined;
                const sourceId =
                  section === 'timeline' || section === 'notes' || section === 'quotes'
                    ? (entry.original_source_message_id ?? entry.source_message_id)
                    : sourceRef?.message_id;
                return (
                  <li key={id} className="space-y-2 border-b border-border pb-4 break-words">
                    {section === 'facts' ? (
                      <>
                        <p className="text-sm text-muted-foreground">
                          {String(row.field).replaceAll('_', ' ')}
                        </p>
                        <p>
                          {row.state === 'disputed'
                            ? 'Disputed — choose a value with Otis'
                            : display(row.value)}
                        </p>
                      </>
                    ) : section === 'timeline' || section === 'notes' || section === 'quotes' ? (
                      <>
                        <p>
                          {entry.kind === 'quote'
                            ? `${entry.payload.role === 'expected' ? 'Expected budget' : 'Offered quote'}: ${quoteMajorUnits(Number(entry.payload.amount), String(entry.payload.currency))} ${entry.payload.currency}`
                            : entryText(entry)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {timestamp(entry.occurred_at)} · Reported by{' '}
                          {entry.original_actor_name ?? 'Member'}
                          {entry.head_event_id !== entry.interaction_id
                            ? ` · Corrected by ${entry.actor_name ?? 'Member'} on ${timestamp(entry.recorded_at)}`
                            : ''}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={Boolean(pending)}
                            onClick={() => openEditor({ kind: 'entry', entry })}
                          >
                            Edit entry
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={Boolean(pending)}
                            onClick={() => {
                              if (
                                window.confirm(
                                  'Remove this entry from current information? History remains available for Undo.',
                                )
                              )
                                void change(
                                  'remove_interaction',
                                  {
                                    interaction_id: entry.interaction_id,
                                    expected_head_event_id: entry.head_event_id,
                                  },
                                  id,
                                );
                            }}
                          >
                            Remove entry
                          </Button>
                        </div>
                      </>
                    ) : section === 'contacts' ? (
                      <>
                        <p>
                          {contact.value}
                          {contact.label ? ` · ${contact.label}` : ''}
                          {contact.state === 'disputed'
                            ? ' · Disputed'
                            : contact.is_primary
                              ? ' · Primary'
                              : ''}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEditor({ kind: 'contact', contact })}
                          >
                            Edit contact
                          </Button>
                          {!contact.is_primary && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={Boolean(pending)}
                              onClick={() =>
                                void change(
                                  'change_contact',
                                  {
                                    entity_id: contact.entity_id,
                                    contact_id: contact.id,
                                    expected_revision: contact.revision,
                                    operation: 'make_primary',
                                  },
                                  id,
                                )
                              }
                            >
                              Use as primary
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={Boolean(pending)}
                            onClick={() => {
                              if (window.confirm('Remove this contact? You can undo this change.'))
                                void change(
                                  'change_contact',
                                  {
                                    entity_id: contact.entity_id,
                                    contact_id: contact.id,
                                    expected_revision: contact.revision,
                                    operation: 'remove',
                                  },
                                  id,
                                );
                            }}
                          >
                            Remove contact
                          </Button>
                        </div>
                      </>
                    ) : section === 'tasks' ? (
                      <>
                        <p>
                          {String(row.title)}
                          {row.overdue ? ' · Overdue' : ''}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {display(row.due_local_date ?? row.due_instant)} ·{' '}
                          {display(row.assignee_name)} · {display(row.status)}
                        </p>
                        {row.status === 'open' && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={Boolean(pending)}
                            onClick={() =>
                              void change(
                                'update_task',
                                {
                                  task_id: (row as unknown as FileTask).id,
                                  status: 'done',
                                  expected_revision: Number(row.revision),
                                },
                                id,
                              )
                            }
                          >
                            Mark done
                          </Button>
                        )}
                      </>
                    ) : section === 'attachments' ? (
                      <>
                        <p>
                          {display(row.label ?? row.filename ?? 'File')}
                          {row.link_state === 'unlinked' ? ' · Removed link' : ''}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {row.media_state === 'expired' || row.media_state === 'deleted'
                            ? 'Original no longer available'
                            : row.retention === 'release'
                              ? `Original available until ${timestamp(String(row.release_after))}`
                              : row.retained
                                ? 'Original retained'
                                : `Original available until ${timestamp(String(row.expires_at))}`}
                        </p>
                        {row.format === 'application/pdf' && (
                          <p className="text-sm text-muted-foreground">
                            Text extraction: {display(row.extraction_state)}
                            {row.extraction_error ? ` · ${row.extraction_error}` : ''}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" size="sm" onClick={() => setGallery(n)}>
                            Open original
                          </Button>
                          {String(row.format).startsWith('audio/') && Boolean(row.transcript) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={Boolean(pending)}
                              onClick={() => openEditor({ kind: 'transcript', file: row })}
                            >
                              Correct transcript
                            </Button>
                          )}
                          {Boolean(row.original_transcript) &&
                            row.transcript !== row.original_transcript && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={Boolean(pending)}
                                onClick={() =>
                                  void change(
                                    'update_attachment',
                                    {
                                      entity_id: row.entity_id,
                                      media_id: row.media_id,
                                      expected_revision: row.annotation_revision,
                                      restore_original_transcript: true,
                                    },
                                    id,
                                  )
                                }
                              >
                                Restore original transcript
                              </Button>
                            )}
                          {row.link_state === 'active' ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={Boolean(pending)}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    'Remove this file link? The original and history remain available.',
                                  )
                                )
                                  void change(
                                    'unlink_attachment',
                                    { link_id: row.id, expected_revision: row.revision },
                                    id,
                                  );
                              }}
                            >
                              Remove link
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={Boolean(pending)}
                              onClick={() => {
                                if (
                                  row.retention === 'release' ||
                                  window.confirm(
                                    'Release this original after 14 days? Every active client link must first be removed. Undo can keep it during that grace period.',
                                  )
                                )
                                  void change(
                                    'update_attachment',
                                    {
                                      entity_id: row.entity_id,
                                      media_id: row.media_id,
                                      expected_revision: row.annotation_revision,
                                      retention: row.retention === 'release' ? 'retain' : 'release',
                                    },
                                    id,
                                  );
                              }}
                            >
                              {row.retention === 'release'
                                ? 'Keep original'
                                : 'Release original after 14 days'}
                            </Button>
                          )}
                          {row.format === 'application/pdf' &&
                            ['failed', 'needs_visual'].includes(String(row.extraction_state)) && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={Boolean(pending)}
                                onClick={async () => {
                                  setPending(id);
                                  setError('');
                                  try {
                                    await api.retryDocument(
                                      workspaceId,
                                      String(row.media_id),
                                      userId,
                                    );
                                    if (alive.current) {
                                      await refresh();
                                      setNotice(
                                        'Text extraction queued. Refresh after it finishes.',
                                      );
                                    }
                                  } catch (failure) {
                                    if (alive.current)
                                      setError(
                                        failure instanceof Error
                                          ? failure.message
                                          : 'Retry failed.',
                                      );
                                  } finally {
                                    if (alive.current) setPending('');
                                  }
                                }}
                              >
                                Retry text extraction
                              </Button>
                            )}
                        </div>
                      </>
                    ) : section === 'reminders' ? (
                      <>
                        <p>{display(row.text)}</p>
                        <p className="text-sm text-muted-foreground">
                          {display(row.status)} ·{' '}
                          {describeFollowUp(row.spec as import('@otis/contracts').ReminderSpec)} ·{' '}
                          {display(row.timezone)} · {display(row.delivery_channel)}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={Boolean(pending)}
                            onClick={() =>
                              void change(
                                'change_reminder_rule',
                                {
                                  rule_id: row.id,
                                  expected_revision: row.revision,
                                  status: row.status === 'paused' ? 'active' : 'paused',
                                },
                                id,
                              )
                            }
                          >
                            {row.status === 'paused' ? 'Resume' : 'Pause'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={Boolean(pending)}
                            onClick={() =>
                              void change(
                                'change_reminder_rule',
                                {
                                  rule_id: row.id,
                                  expected_revision: row.revision,
                                  status: 'cancelled',
                                },
                                id,
                              )
                            }
                          >
                            Cancel follow-up
                          </Button>
                          {onAsk && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                onAsk(
                                  `Change the follow-up ${display(row.text)} for ${file.entity.name}`,
                                )
                              }
                            >
                              Change with Otis
                            </Button>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        <p>{display(row.content_text ?? row.content ?? row.kind ?? row.text)}</p>
                        {section === 'history' && (
                          <>
                            <p className="text-xs text-muted-foreground">
                              {timestamp(
                                String(
                                  (row.source as { recorded_at?: string })?.recorded_at ??
                                    row.occurred_at,
                                ),
                              )}
                              {row.is_reverted
                                ? ' · Undone'
                                : row.current_head_event_id && row.current_head_event_id !== row.id
                                  ? ' · Replaced'
                                  : ''}
                            </p>
                            <p className="whitespace-pre-wrap break-words text-sm">
                              {historyText(row)}
                            </p>
                          </>
                        )}
                      </>
                    )}
                    {!['timeline', 'notes', 'quotes'].includes(section) && sourceRef && (
                      <p className="text-xs text-muted-foreground">
                        {sourceRef.actor_name ?? 'Member'}
                        {sourceRef.recorded_at ? ` · ${timestamp(sourceRef.recorded_at)}` : ''}
                      </p>
                    )}
                    {section === 'attachments' && Boolean(row.corrected_at) && (
                      <p className="text-xs text-muted-foreground">
                        Updated by {String(row.corrector_name ?? 'Member')} ·{' '}
                        {timestamp(String(row.corrected_at))}
                      </p>
                    )}
                    {sourceId && (
                      <Button variant="ghost" size="sm" onClick={() => setSource(sourceId)}>
                        Original source
                      </Button>
                    )}
                    {entry.head_event_id !== entry.interaction_id &&
                      entry.source_message_id &&
                      entry.source_message_id !== sourceId &&
                      ['timeline', 'notes', 'quotes'].includes(section) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSource(entry.source_message_id!)}
                        >
                          Correction source
                        </Button>
                      )}
                    {section === 'attachments' && Boolean(row.correction_message_id) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSource(String(row.correction_message_id))}
                      >
                        Update source
                      </Button>
                    )}
                    {pending === id && (
                      <p role="status" className="text-sm">
                        Saving…
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {page.has_more && (
            <Button
              variant="outline"
              disabled={Boolean(pending)}
              onClick={() => void load(section, true)}
            >
              {pending === 'page' ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </>
      )}
      <FileGallery
        workspaceId={workspaceId}
        userId={userId}
        files={(pages.attachments ?? file.attachments).items as GalleryFile[]}
        selected={gallery}
        onSelect={setGallery}
        onClose={() => setGallery(null)}
      />
      <WorkspaceSource
        workspaceId={workspaceId}
        sourceId={source}
        onClose={() => setSource(null)}
        onOpenChat={onOpenChat}
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
              void refresh();
            }}
          />
        </Suspense>
      )}
      <Dialog
        open={Boolean(editor)}
        onOpenChange={(open) => {
          if (!open && !pending) setEditor(null);
        }}
      >
        <DialogContent className="otis-file-dialog">
          <DialogHeader>
            <DialogTitle>
              {editor?.kind === 'entry'
                ? 'Correct this entry'
                : editor?.kind === 'transcript'
                  ? 'Correct the voice transcript'
                  : 'Phone or email'}
            </DialogTitle>
            <DialogDescription>
              Save applies this change only. Other unsaved spreadsheet edits stay as they are.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void saveEditor();
            }}
          >
            {editor?.kind === 'transcript' ? (
              <label className="block text-sm" htmlFor="transcript-text">
                Transcript
                <Textarea
                  id="transcript-text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
            ) : editor?.kind === 'contact' ? (
              <>
                <ChoiceSelect
                  label="Contact type"
                  disabled={Boolean(editor.contact)}
                  value={method}
                  options={[
                    { value: 'phone', label: 'Phone' },
                    { value: 'email', label: 'Email' },
                  ]}
                  onChange={setMethod}
                />
                <label className="block text-sm" htmlFor="contact-value">
                  Contact value
                  <Input
                    id="contact-value"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    autoComplete="off"
                  />
                </label>
                <label className="block text-sm" htmlFor="contact-label">
                  Label (optional)
                  <Input
                    id="contact-label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={primary}
                    onChange={(e) => setPrimary(e.target.checked)}
                  />
                  Use as primary
                </label>
              </>
            ) : (
              <>
                <label className="block text-sm" htmlFor="entry-text">
                  {editor?.kind === 'entry' && editor.entry.kind === 'quote' ? 'Amount' : 'Entry'}
                  {editor?.kind === 'entry' && editor.entry.kind === 'quote' ? (
                    <Input
                      id="entry-text"
                      inputMode="decimal"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                  ) : (
                    <Textarea
                      id="entry-text"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                  )}
                </label>
                {editor?.kind === 'entry' && editor.entry.kind === 'quote' && (
                  <>
                    <label className="block text-sm" htmlFor="quote-currency">
                      Currency
                      <Input
                        id="quote-currency"
                        maxLength={3}
                        value={currency}
                        onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                      />
                    </label>
                    <ChoiceSelect
                      label="Quote type"
                      value={role}
                      options={[
                        { value: 'offered', label: 'Offered quote' },
                        { value: 'expected', label: 'Expected budget' },
                      ]}
                      onChange={setRole}
                    />
                  </>
                )}
                <label className="block text-sm" htmlFor="entry-date">
                  Occurred at (include timezone)
                  <Input id="entry-date" value={date} onChange={(e) => setDate(e.target.value)} />
                </label>
              </>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              {staleEdit && (
                <p className="w-full text-sm">
                  Your draft is preserved.{' '}
                  {editor?.kind === 'entry'
                    ? 'Compare it with the saved entry before continuing.'
                    : 'Copy your changes, then reopen the current contact or transcript before saving.'}
                </p>
              )}
              {staleEdit && editor?.kind === 'entry' && (
                <div className="w-full space-y-2 text-sm">
                  {latestEntry ? (
                    <>
                      <p className="whitespace-pre-wrap break-words">
                        Saved:{' '}
                        {latestEntry.kind === 'quote'
                          ? `${quoteMajorUnits(Number(latestEntry.payload.amount), String(latestEntry.payload.currency))} ${latestEntry.payload.currency}`
                          : entryText(latestEntry)}{' '}
                        · {timestamp(latestEntry.occurred_at)}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => openEditor({ kind: 'entry', entry: latestEntry })}
                      >
                        Use saved version
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setEditor({ kind: 'entry', entry: latestEntry });
                          setStaleEdit(false);
                        }}
                      >
                        Apply my correction to this version
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={Boolean(pending)}
                      onClick={async () => {
                        reads.current?.abort();
                        const controller = new AbortController();
                        reads.current = controller;
                        setPending('compare');
                        try {
                          const response = (await api.entityFile(
                            workspaceId,
                            entityId,
                            { section: 'timeline', interaction_id: editor.entry.interaction_id },
                            controller.signal,
                          )) as EntityFileSectionResponse;
                          if (controller.signal.aborted) return;
                          const current = response.page.items[0] as CurrentInteraction | undefined;
                          if (current) setLatestEntry(current);
                          else
                            setError(
                              'This entry was removed. Your text is still preserved; save it as a new entry with Otis if needed.',
                            );
                        } catch (failure) {
                          if (!controller.signal.aborted)
                            setError(
                              failure instanceof Error ? failure.message : 'Unable to compare.',
                            );
                        } finally {
                          if (!controller.signal.aborted && alive.current) setPending('');
                        }
                      }}
                    >
                      Compare saved entry
                    </Button>
                  )}
                </div>
              )}
              <Button
                type="button"
                variant="ghost"
                disabled={Boolean(pending)}
                onClick={() => setEditor(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!text.trim() || Boolean(pending) || staleEdit}>
                {pending === 'editor' ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
