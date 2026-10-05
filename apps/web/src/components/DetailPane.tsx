import { useEffect, useRef, useState } from 'react';
import type { ActionDetailResponse, UndoPreviewResponse } from '@otis/contracts';
import { toast } from 'sonner';
import { api, ApiError } from '../api/client.js';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { CloseIcon, UndoIcon, CopyIcon } from './icons.js';
import { Overlay } from './Overlay.js';
import { Button } from './ui/button.js';
import { Alert, AlertDescription } from './ui/alert.js';
import { formatDayLabel } from '../i18n/format.js';
function cleanSummary(summary?: string | null): string | null {
  if (!summary) return null;
  const cleaned = summary.replace(/\b(mem|act)_[a-zA-Z0-9_-]+/g, '').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  return cleaned || null;
}

export interface DetailPaneProps { workspaceId: string; chatId: string; actionId: string; onClose: () => void; onUndone: () => void; onAccessLost?: () => void; }
export function DetailPane({ workspaceId, chatId, actionId, onClose, onUndone, onAccessLost }: DetailPaneProps) {
  const wide = useMediaQuery('(min-width: 1280px)');
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    return () => {
      try {
        previousFocusRef.current?.focus();
      } catch {
        /* best-effort focus restoration */
      }
    };
  }, []);
  const [detail, setDetail] = useState<ActionDetailResponse | null>(null); const [preview, setPreview] = useState<UndoPreviewResponse | null>(null);
  const [mode, setMode] = useState<'from_here' | 'single'>('from_here'); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(true); const [refresh, setRefresh] = useState(0);
  const [runActive, setRunActive] = useState(false);
  const failedAccess = (err: unknown) => { if (err instanceof ApiError && [401, 403].includes(err.status)) { onAccessLost?.(); return true; } return false; };
  const operation = useRef<{ mode: string; revision: number; id: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.action(workspaceId, actionId)
      .then(result => { if (!cancelled) setDetail(result); })
      .catch(err => {
        if (!cancelled && !failedAccess(err)) {
          if (err instanceof ApiError && err.status === 404) {
            setError('This change could not be found or has expired.');
          } else {
            setError('Could not load this change. Check connection and try again.');
          }
        }
      });
    return () => { cancelled = true; };
  }, [workspaceId, actionId, refresh]);
  useEffect(() => { let cancelled = false; setPreview(null); setPreviewLoading(true); setRunActive(false); api.undoPreview(workspaceId, actionId, mode).then(result => { if (!cancelled) setPreview(result); }).catch(err => { if (cancelled || failedAccess(err)) return; setRunActive(err instanceof ApiError && err.code === 'run_active'); setError(err instanceof ApiError && err.code === 'run_active' ? 'This run is still working. Wait for it to finish, or stop it before undoing saved changes.' : 'Could not prepare undo. Refresh to try again.'); }).finally(() => { if (!cancelled) setPreviewLoading(false); }); return () => { cancelled = true; }; }, [workspaceId, actionId, mode, refresh]);
  const commit = async () => {
    if (!preview || busy || preview.preview.dependencies.some(dependency => dependency.requires_clarification)) return;
    setBusy(true); setError(null);
    const revision = preview.preview.expected_revision;
    if (!operation.current || operation.current.mode !== mode || operation.current.revision !== revision) operation.current = { id: crypto.randomUUID(), mode, revision };
    try {
      const result = await api.undo(workspaceId, actionId, { mode, clientOperationId: operation.current.id, expectedRevision: revision, ...(chatId ? { chatId } : {}) });
      if (result.status === 'applied' || result.status === 'already_applied') { toast('Changes undone'); onUndone(); onClose(); }
      else { setError(result.summary); setRefresh(value => value + 1); }
    } catch { setError('Undo not confirmed. Retry uses the same operation ID. If the preview changed, review the updated changes first.'); setRefresh(value => value + 1); } finally { setBusy(false); }
  };
  const stopForUndo = async () => { if (!detail?.action.run_id || busy) return; setBusy(true); try { await api.stopRun(workspaceId, detail.action.run_id); setError(null); setRefresh(value => value + 1); } catch (err) { if (!failedAccess(err)) setError('Could not stop this run. Only its author can stop it.'); } finally { setBusy(false); } };
  const onlyOne = preview?.preview.selected_action_ids.length === 1;
  const blocked = preview?.preview.dependencies.some(dependency => dependency.requires_clarification);

  const draftEvent = detail?.action.events.find(e => e.kind === 'draft_created' || e.kind === 'draft_updated');
  const draftPayload = draftEvent?.payload as {
    draft_id?: string;
    channel?: string;
    recipient_address?: string | null;
    content_text?: string;
  } | undefined;
  const draftText = draftPayload?.content_text;
  const recipientPhone = draftPayload?.recipient_address?.replace(/[^\d+]/g, '');
  const cleanPhone = recipientPhone?.replace(/^\+/, '');
  const isE164Valid = Boolean(cleanPhone && /^\d{7,15}$/.test(cleanPhone));
  const waUrl = (isE164Valid && draftText)
    ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(draftText)}`
    : null;

  const content = <aside className="otis-detail" aria-label="Change detail"><header className="otis-pane-header"><h2 className="text-base font-medium">Change</h2><Button variant="ghost" size="icon" type="button" className="otis-iconbutton" onClick={onClose} aria-label="Close detail"><CloseIcon/></Button></header>
    {error && <div className="otis-detail__section flex flex-col gap-2"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert><Button variant="outline" size="sm" type="button" onClick={() => { setError(null); setRefresh(value => value + 1); }}>Try again</Button></div>}
    {!detail && !error && <p className="otis-detail__label text-xs">Loading the saved change…</p>}
    {detail && <><div className="otis-detail__section"><span className="otis-detail__label text-xs">What changed</span><p className="otis-detail__value text-sm">{cleanSummary(detail.action.summary) ?? detail.action.events.map(event => event.kind.replace(/_/g, ' ')).join(', ')}</p></div>
      {detail.action.source && <div className="otis-detail__section"><span className="otis-detail__label text-xs">Original source · {formatDayLabel(detail.action.source.created_at)}</span><blockquote className="otis-detail__value text-sm">{detail.action.source.text_preview ?? 'Source content is no longer available.'}</blockquote></div>}
      {draftText && (
        <div className="otis-detail__section flex flex-col gap-2">
          <span className="otis-detail__label text-xs">Draft message ({draftPayload?.channel ?? 'message'})</span>
          {draftPayload?.recipient_address && (
            <p className="text-xs text-subtle">Recipient: {draftPayload.recipient_address}</p>
          )}
          <blockquote className="otis-detail__value rounded-lg bg-card p-3 text-sm whitespace-pre-wrap border border-border">
            {draftText}
          </blockquote>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(draftText);
                toast('Draft copied to clipboard');
              }}
            >
              <CopyIcon /> Copy draft
            </Button>
            {waUrl && (
              <a
                href={waUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="otis-button otis-button--secondary inline-flex items-center text-xs h-8 px-3 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground"
              >
                Open WhatsApp
              </a>
            )}
          </div>
          <p className="otis-detail__label text-xs">
            Opening WhatsApp or copying does not record the message as sent. Tell Otis when you have sent it.
          </p>
        </div>
      )}
      {!detail.action.undo.available ? <p className="otis-detail__value text-sm">This change has already been undone.</p> : <>
        <div className="otis-detail__section"><span className="otis-detail__label text-xs">Undo scope</span><div className="otis-detail__actions"><Button variant={mode === 'from_here' ? 'default' : 'outline'} size="sm" type="button" aria-pressed={mode === 'from_here'} onClick={() => setMode('from_here')}>From here</Button><Button variant={mode === 'single' ? 'default' : 'outline'} size="sm" type="button" aria-pressed={mode === 'single'} onClick={() => setMode('single')}>Only this action</Button></div><p className="otis-detail__label text-xs">{mode === 'from_here' ? 'This change + later changes in the same run.' : 'This change only.'}</p></div>
        {runActive && detail.action.run_id && <Button variant="destructive" size="sm" type="button" disabled={busy} onClick={() => void stopForUndo()}>Stop work to prepare undo</Button>}
        {previewLoading && <p className="otis-detail__label text-xs">Preparing the exact changes…</p>}
        {preview && (
          <div className="otis-detail__section">
            <p className="text-sm">Revert {preview.preview.selected_action_ids.length} saved change{onlyOne ? '' : 's'}?</p>
            {preview.preview.affected_entities.length > 0 || preview.preview.affected_tasks.length > 0 ? (
              <ul className="otis-working__steps text-xs">
                {preview.preview.affected_entities.map(entity => (
                  <li className="otis-detail__value" key={entity.id}>{entity.name}: {entity.changes.join(' ')}</li>
                ))}
                {preview.preview.affected_tasks.map(task => (
                  <li className="otis-detail__value" key={task.id}>{task.title}: {task.changes.join(' ')}</li>
                ))}
              </ul>
            ) : (
              <p className="otis-detail__value text-xs text-muted-foreground">
                {onlyOne
                  ? `Reverts ${cleanSummary(detail.action.summary) ?? 'the selected change'} and restores prior context.`
                  : `Reverts ${preview.preview.selected_action_ids.length} saved context changes from this run and restores prior context.`}
              </p>
            )}
            {preview.preview.dependencies.map(dependency => (
              <p className="otis-entry__error text-sm" key={dependency.action_id}>{dependency.reason}</p>
            ))}
            {blocked && (
              <p className="otis-detail__label text-xs">Later work depends on this change. Resolve that dependency in your own conversation first.</p>
            )}
          </div>
        )}
        <Button type="button" className="otis-button otis-button--primary" disabled={!preview || previewLoading || busy || blocked} onClick={() => void commit()}>{busy ? <span className="otis-spinner" aria-hidden="true"/> : <UndoIcon/>}{busy ? 'Applying undo…' : mode === 'single' ? 'Undo only this action' : onlyOne ? 'Undo' : 'Undo from here'}</Button>
      </>}
    </>}
  </aside>;
  return wide ? content : <Overlay label="Change detail" className="otis-overlay--detail" onClose={onClose}>{content}</Overlay>;
}
