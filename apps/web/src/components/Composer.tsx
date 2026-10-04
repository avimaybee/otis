import { useEffect, useId, useRef, useState } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import type { CommandDescriptor, ModelOption, VoiceMediaSummary } from '@otis/contracts';
import { DOMAIN_BOUNDS } from '@otis/contracts';
import { cancelDraftSave, deleteDraft, draftSession, flushDraftSaves, loadDraft, scheduleDraftSave } from '../api/drafts.js';
import type { VoiceUploadAdapter } from '../api/voice.js';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { useVoiceRecorder, type VoiceController, type VoiceRecorderEnvironment, type VoiceRecorderScope } from '../hooks/useVoiceRecorder.js';
import { CloseIcon, MicIcon, SendIcon, StopIcon } from './icons.js';
import { VoiceCapturePanel } from './VoiceCapturePanel.js';
import { Button } from './ui/button.js';
import { Command, CommandItem, CommandList } from './ui/command.js';

export interface ClarificationContext {
  id?: string; question: string; candidates?: string[] | null; missing_fields?: string[];
  intended_operation?: string; onCancel: () => void;
}
export interface VoiceComposerConfig {
  /** True only when the server reports a usable route and an adapter is confirmed. */
  available: boolean;
  adapter?: VoiceUploadAdapter | null;
  scope?: VoiceRecorderScope;
  environment?: VoiceRecorderEnvironment;
  /** Story/test seam: replaces the internal recorder hook entirely. */
  controller?: VoiceController;
  /** Resolves only after durable outbox acceptance; rejection retains local bytes. */
  onSent?: (result: { clientMessageId: string; media: VoiceMediaSummary; durationMs: number; mimeType: string }) => Promise<void>;
}
export interface ComposerProps {
  disabled?: boolean; disabledReason?: string; running: boolean;
  commands: CommandDescriptor[]; models?: ModelOption[]; workspaces?: { id: string; name: string }[];
  placeholder?: string; draftKey?: string; draftValue?: string | null; replyTo?: ClarificationContext;
  controlPending?: boolean; modelReady?: boolean; voice?: VoiceComposerConfig;
  onCommand?: (text: string) => Promise<boolean>;
  onStop?: () => Promise<void>; onSend: (text: string) => void | boolean | Promise<boolean>;
}
export interface SuggestionItem { name: string; label?: string; summary: string; insert: string; hasSubmenu?: boolean; }
// Only offer choices the server actually supplied. Never invent a due date or consent.
export function deriveCandidates(_question: string, candidates?: string[] | null, _missingFields?: string[], _intendedOp?: string): string[] { return candidates ?? []; }

export function Composer({ disabled, disabledReason, running, commands, models = [], workspaces = [],
  placeholder = 'Message Otis', draftKey, draftValue, replyTo, controlPending, modelReady = true, voice, onCommand, onStop, onSend }: ComposerProps) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);
  const [value, setValue] = useState('');
  // Drafts live in the scoped IndexedDB module; the component keeps its own
  // value while mounted and schedules debounced persists there. Each
  // scheduled write carries the owner session observed at keystroke time,
  // so a trailing save can never resurrect input after logout. Storage
  // failure never blocks typing: the in-memory draft stays fully usable.
  const valueRef = useRef('');
  const commitDraft = (next: string) => {
    setValue(next);
    valueRef.current = next;
    if (draftKey) scheduleDraftSave(draftKey, next);
  };
  const clearDraft = () => {
    setValue('');
    valueRef.current = '';
    if (draftKey) {
      cancelDraftSave(draftKey);
      void deleteDraft(draftKey);
    }
  };
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const [index, setIndex] = useState(0);
  const desktop = useMediaQuery('(min-width: 900px) and (pointer: fine)');
  // The internal recorder only runs when the composer owns the capture scope
  // and no story/test controller was injected. Capture never touches the
  // typed draft: the field is swapped out visually, not cleared.
  const internalVoice = useVoiceRecorder({
    scope: voice?.scope ?? null,
    adapter: voice?.adapter ?? null,
    environment: voice?.environment,
    enabled: Boolean(voice?.scope) && !voice?.controller,
    onSent: voice?.onSent,
  });
  const voiceController = voice?.controller ?? internalVoice;
  const voiceActive = voiceController.phase === 'recording'
    || voiceController.phase === 'finalizing'
    || voiceController.phase === 'review';
  const micVisible = Boolean(voice?.available) && !voiceActive;
  const voiceError = voiceActive ? null : voiceController.error;
  const voiceStorageWarning = voiceController.phase === 'recording' && !voiceController.durable
    ? 'This recording is not saved in the browser. Keep this tab open.'
    : '';
  const tooLong = value.length > DOMAIN_BOUNDS.MAX_INPUT_CHARS;
  const current = models.find(model => model.is_current);
  const modelQuery = /^\/model\s+(.*)$/i.exec(value);
  const thinkingQuery = /^\/thinking\s+(.*)$/i.exec(value);
  const workspaceQuery = /^\/workspace\s+(.*)$/i.exec(value);
  // A double slash is literal text, never a command.
  const isSlash = !value.startsWith('//') && /^\/\S*\s*[^\n]*$/.test(value);
  const root = commands.filter(command => command.available && command.name.toLowerCase().includes(value.slice(1).trim().toLowerCase())).map(command => ({
    name: command.name, label: `/${command.name}`, summary: command.summary,
    insert: `/${command.name}${['model', 'thinking', 'workspace'].includes(command.name) ? ' ' : ''}`,
  }));
  const suggestions: SuggestionItem[] = modelQuery
    ? [{ name: 'default', label: 'Workspace default', summary: models.find(model => model.is_default)?.display_name ?? 'No default model', insert: '/model default' }, ...models.filter(model => model.available).map(model => ({ name: model.command_key, label: model.display_name, summary: '', insert: `/model ${model.command_key}` }))].filter(row => `${row.name} ${row.label}`.toLowerCase().includes(modelQuery[1]!.toLowerCase()))
    : thinkingQuery
    ? (current?.thinking?.state === 'supported' ? [{ name: 'default', label: 'Provider default', summary: '', insert: '/thinking default' }, ...current.thinking.choices.map(choice => ({ name: choice.id, label: choice.label, summary: '', insert: `/thinking ${choice.id}` }))].filter(row => `${row.name} ${row.label}`.toLowerCase().includes(thinkingQuery[1]!.toLowerCase())) : [])
    : workspaceQuery
    ? workspaces.filter(workspace => workspace.name.toLowerCase().includes(workspaceQuery[1]!.toLowerCase())).map(workspace => ({ name: workspace.id, label: workspace.name, summary: '', insert: `/workspace ${workspace.name}` }))
    : root;
  const pickerOpen = !disabled && !dismissed && isSlash && suggestions.length > 0;
  const activeIndex = Math.min(index, Math.max(0, suggestions.length - 1));

  useEffect(() => { if (draftValue !== undefined && draftValue !== null) { commitDraft(draftValue); setDismissed(false); input.current?.focus(); } }, [draftValue]);
  useEffect(() => {
    if (!draftKey) return;
    const key = draftKey;
    const session = draftSession(key);
    let live = true;
    void loadDraft(key).then(text => {
      // Explicit edits and keystrokes since mount always win over storage. A
      // null mount session means this instance never observed the owner: the
      // load above adopted the persisted generation, so its result IS the
      // authenticated session and is accepted (this is the normal
      // reload/remount path). Otherwise a session move mid-hydration means a
      // purge landed — drop it instead of filling abolished input.
      if (live && text != null && (session === null || draftSession(key) === session)) {
        setValue(current => (current === '' ? text : current));
      }
    });
    return () => {
      live = false;
      // Flush a trailing debounced write so reload recovers the last word.
      // The flush replays the keystroke-time owner session, never a fresh
      // one, so an unmount after logout cannot resurrect purged input.
      flushDraftSaves(key);
    };
  }, [draftKey]);

  const command = async (text: string, clearCommandDraft = false) => {
    if (!onCommand || controlPending) return false;
    setError('');
    try { const applied = await onCommand(text); if (applied && clearCommandDraft) { if (valueRef.current.trim() === value.trim()) clearDraft(); } return applied; }
    catch { setError('Could not apply that command. Try again.'); return false; }
  };
  const select = async (selected: number) => {
    const row = suggestions[selected]; if (!row) return;
    if (row.insert.endsWith(' ')) { commitDraft(row.insert); setIndex(0); return; }
    setDismissed(true); await command(row.insert, true); input.current?.focus();
  };
  const submit = async () => {
    const text = value.trim(); if (!text || disabled || sendingRef.current || tooLong || controlPending) return;
    // A double slash is literal text (product command escape), never a command.
    if (text.startsWith('/') && !text.startsWith('//') && !replyTo) { await command(text, true); return; }
    if (!modelReady) return;
    // The submitted snapshot is accepted locally here: the outbox entry owns
    // retry and redraft, so the composer clears without waiting for HTTP and
    // a second message can submit immediately with its own identity.
    sendingRef.current = true;
    clearDraft();
    setSending(true); setError('');
    sendingRef.current = false;
    try {
      await onSend(text);
    } catch { setError('Message not confirmed. It is kept in the conversation with Retry.'); }
    finally { setSending(false); }
  };
  const stop = async () => { if (!onStop || stopping) return; setStopping(true); setError(''); try { await onStop(); } catch { setError('Could not stop yet. Try again.'); } finally { setStopping(false); } };

  return <div className="otis-composer"><div className="otis-composer__inner">
    {replyTo && <div className="otis-reply-context text-xs"><span>Replying to Otis</span><Button variant="ghost" size="icon-xs" type="button" aria-label="Dismiss question" onClick={replyTo.onCancel}><CloseIcon/></Button></div>}
    {replyTo?.candidates?.length ? <div className="otis-reply-choices" aria-label="Suggested responses">{replyTo.candidates.map(choice => <Button key={choice} variant="outline" size="sm" type="button" onClick={() => { commitDraft(choice); input.current?.focus(); }}>{choice}</Button>)}</div> : null}
    {pickerOpen && <Command label={modelQuery ? 'Models' : thinkingQuery ? 'Thinking effort options' : 'Commands'} value={suggestions[activeIndex]?.insert ?? ''} onValueChange={next => { const found = suggestions.findIndex(row => row.insert === next); if (found >= 0) setIndex(found); }} shouldFilter={false} loop>
      <CommandList id={`${id}-picker`}>
        {suggestions.map((row, rowIndex) => <CommandItem key={row.name} id={`${id}-option-${rowIndex}`} value={row.insert} disabled={controlPending} onSelect={() => void select(rowIndex)}><span>{row.label}</span>{row.summary && <small className="text-xs">{row.summary}</small>}</CommandItem>)}
      </CommandList>
    </Command>}
    <div className="otis-composer__field flex min-h-[52px] items-end gap-1 rounded-2xl bg-card py-2 pr-2 pl-4">
      {voiceActive ? (
        <VoiceCapturePanel
          controller={voiceController}
          canSend={Boolean(voice?.adapter) && Boolean(voice?.scope?.chatId)}
          onCancel={() => voiceController.cancel()}
          onSend={() => void voiceController.send()}
        />
      ) : (
        <>
          <label className="otis-visually-hidden" htmlFor={id}>{placeholder}</label>
          <TextareaAutosize id={id} ref={input} name="message" minRows={1} maxRows={6} className="otis-composer__input my-1.5 max-h-36 min-h-6 flex-1 resize-none bg-transparent text-base leading-6 outline-none placeholder:text-muted-foreground" placeholder={disabled ? disabledReason ?? placeholder : placeholder} autoComplete="off" value={value} disabled={disabled}
            aria-describedby={`${id}-status`} aria-haspopup="listbox" aria-controls={pickerOpen ? `${id}-picker` : undefined} aria-autocomplete="list"
            onChange={event => { commitDraft(event.target.value); setDismissed(false); setIndex(0); }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (pickerOpen) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length); return; }
                if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return; }
                if (event.key === 'Tab' || event.key === 'Enter') { event.preventDefault(); void select(activeIndex); return; }
              }
              if (event.key === 'Enter' && desktop && !event.shiftKey) { event.preventDefault(); void submit(); }
            }} />
          {micVisible && (
            <button type="button" className="otis-composer__action grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={voiceController.phase === 'requesting' ? 'Starting recording' : 'Record voice note'} aria-busy={voiceController.phase === 'requesting'} disabled={disabled || voiceController.phase === 'requesting'} onClick={() => void voiceController.start()}>{voiceController.phase === 'requesting' ? <span className="otis-spinner" aria-hidden="true"/> : <MicIcon/>}</button>
          )}
          {running && onStop && !value.trim() ? (
            <button type="button" className="otis-composer__action grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground" aria-label="Stop Otis" disabled={stopping} onClick={() => void stop()}><StopIcon/></button>
          ) : (
            <button type="button" className={`otis-composer__action grid size-9 shrink-0 place-items-center rounded-full ${value.trim() && !disabled ? 'bg-highlight text-highlight-foreground hover:bg-highlight-hover active:bg-highlight-pressed' : 'bg-accent text-subtle'}`} aria-label="Send" aria-busy={sending} disabled={disabled || tooLong || !value.trim() || controlPending || (!modelReady && !(value.trim().startsWith('/') && !value.trim().startsWith('//')))} onClick={() => void submit()}>{sending ? <span className="otis-spinner" aria-hidden="true"/> : <SendIcon/>}</button>
          )}
        </>
      )}
    </div>
    <div id={`${id}-status`} className={`otis-composer__status text-xs${tooLong || voiceError || error ? ' otis-composer__status--error' : ''}`} role="status">{tooLong ? `Keep the message under ${DOMAIN_BOUNDS.MAX_INPUT_CHARS.toLocaleString()} characters.` : voiceError || error || (!modelReady ? 'Choose a model to start. Connections are in Settings.' : voiceStorageWarning || 'Otis can make mistakes. Verify important business info.')}<span className="otis-visually-hidden">{sending ? 'Sending your message.' : ''}</span></div>
  </div></div>;
}
