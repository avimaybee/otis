import { useEffect, useId, useRef, useState } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import type { CommandDescriptor, ModelOption, VoiceMediaSummary } from '@otis/contracts';
import { DOMAIN_BOUNDS, IMAGE_BOUNDS } from '@otis/contracts';
import { cancelDraftSave, deleteDraft, draftSession, flushDraftSaves, loadDraft, scheduleDraftSave } from '../api/drafts.js';
import type { VoiceUploadAdapter } from '../api/voice.js';
import { validateImageFile, type ImageUploadRequest, type ImageUploadResult } from '../api/images.js';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { useVoiceRecorder, type VoiceController, type VoiceRecorderEnvironment, type VoiceRecorderScope } from '../hooks/useVoiceRecorder.js';
import { ChevronDownIcon, CloseIcon, MicIcon, PlusIcon, SendIcon, StopIcon } from './icons.js';
import { VoiceCapturePanel } from './VoiceCapturePanel.js';
import { Button } from './ui/button.js';
import { Command, CommandItem, CommandList } from './ui/command.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';

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
  onSent?: (result: { clientMessageId: string; media: VoiceMediaSummary; durationMs: number; mimeType: string; chatId?: string }) => Promise<void>;
}
export interface ImageComposerConfig {
  /** True when the chat scope can take attachments (workspace always; chat ensured at send). */
  available: boolean;
  workspaceId: string;
  chatId: string | null;
  /** Creates the conversation for a first message, or returns the active id. Null aborts the send. */
  onEnsureChat: () => Promise<string | null>;
  /** Claim/PUT/finalize handoff for one file; resolves only with a server media identity. */
  upload: (request: ImageUploadRequest) => Promise<ImageUploadResult>;
  /** Story/test seam: bypasses the transport with scripted results. */
  controller?: ImageAttachmentController;
}
export interface ImageAttachment {
  id: string;
  file: File;
  previewUrl: string;
  status: 'ready' | 'uploading' | 'done' | 'error';
  mediaId?: string;
  error?: string;
}
export interface ImageAttachmentController {
  attachments: ImageAttachment[];
  addFiles: (files: File[]) => void;
  remove: (id: string) => void;
  clear: () => void;
}
export interface ComposerProps {
  disabled?: boolean; disabledReason?: string; running: boolean;
  commands: CommandDescriptor[]; models?: ModelOption[]; workspaces?: { id: string; name: string }[];
  placeholder?: string; draftKey?: string; draftValue?: string | null; replyTo?: ClarificationContext;
  controlPending?: boolean; modelReady?: boolean; modelsLoading?: boolean; voice?: VoiceComposerConfig;
  images?: ImageComposerConfig;
  modelsError?: string; onRetryModels?: () => void;
  onCommand?: (text: string) => Promise<boolean>;
  onStop?: () => Promise<void>; onSend: (text: string, imageMediaIds?: string[]) => void | boolean | Promise<boolean>;
}
export interface SuggestionItem { name: string; label?: string; summary: string; insert: string; hasSubmenu?: boolean; }
// Only offer choices the server actually supplied. Never invent a due date or consent.
export function deriveCandidates(_question: string, candidates?: string[] | null, _missingFields?: string[], _intendedOp?: string): string[] { return candidates ?? []; }

export function Composer({ disabled, disabledReason, running, commands, models = [], workspaces = [],
  placeholder = 'Message Otis', draftKey, draftValue, replyTo, controlPending, modelReady = true, modelsLoading = false, voice, images, modelsError, onRetryModels, onCommand, onStop, onSend }: ComposerProps) {
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
  // Attached still images are session-local previews, never drafted: each
  // file carries a stable upload UUID so a retried handoff reuses one media
  // identity, and object URLs are revoked on remove/send/unmount.
  const fileInput = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const attachmentsRef = useRef<ImageAttachment[]>([]);
  const setAttachmentList = (next: ImageAttachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  };
  const revokeAttachments = (list: ImageAttachment[]) => {
    for (const attachment of list) URL.revokeObjectURL(attachment.previewUrl);
  };
  useEffect(() => () => revokeAttachments(attachmentsRef.current), []);
  const patchAttachment = (id: string, patch: Partial<ImageAttachment>) => {
    setAttachmentList(attachmentsRef.current.map(item => (item.id === id ? { ...item, ...patch } : item)));
  };
  const internalAttachments: ImageAttachmentController = {
    attachments,
    addFiles: files => {
      const room = IMAGE_BOUNDS.MAX_PER_MESSAGE - attachmentsRef.current.length;
      if (room <= 0) {
        setError(`At most ${IMAGE_BOUNDS.MAX_PER_MESSAGE} photos per message.`);
        return;
      }
      const accepted: ImageAttachment[] = [];
      for (const file of files.slice(0, room)) {
        const gate = validateImageFile(file);
        if (!gate.valid) {
          setError(gate.message);
          continue;
        }
        accepted.push({
          id: crypto.randomUUID(),
          file,
          previewUrl: URL.createObjectURL(file),
          status: 'ready',
        });
      }
      if (accepted.length > 0) {
        setError('');
        setAttachmentList([...attachmentsRef.current, ...accepted]);
      }
    },
    remove: id => {
      const target = attachmentsRef.current.find(item => item.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      setAttachmentList(attachmentsRef.current.filter(item => item.id !== id));
    },
    clear: () => {
      revokeAttachments(attachmentsRef.current);
      setAttachmentList([]);
    },
  };
  const imageController = images?.controller ?? internalAttachments;
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
  // Answers to Otis questions cannot carry photos yet (the clarification
  // endpoint takes text only), so the affordance hides while replying or
  // while a recording takes over the field.
  const attachVisible = Boolean(images?.available) && !voiceActive && !replyTo;
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
    const text = value.trim();
    const pending = imageController.attachments;
    const hasImages = images && pending.length > 0;
    if ((!text && !hasImages) || disabled || sendingRef.current || tooLong || controlPending) return;
    // A double slash is literal text (product command escape), never a command.
    if (text.startsWith('/') && !text.startsWith('//') && !replyTo && !hasImages) { await command(text, true); return; }
    if (!modelReady) return;
    // Attached photos upload first: acceptance only takes finalized media,
    // so the message send below carries server identities, never local
    // bytes. A failed handoff keeps its preview with the precise reason and
    // blocks this submit without touching the draft.
    let imageMediaIds: string[] | undefined;
    if (hasImages && images && !images.controller) {
      const chatId = images.chatId ?? await images.onEnsureChat();
      if (!chatId) {
        setError('Could not open a conversation. Try again.');
        return;
      }
      const uploaded: string[] = [];
      for (const attachment of pending) {
        if (attachment.status === 'done' && attachment.mediaId) {
          uploaded.push(attachment.mediaId);
          continue;
        }
        patchAttachment(attachment.id, { status: 'uploading', error: undefined });
        try {
          const result = await images.upload({
            workspaceId: images.workspaceId,
            chatId,
            clientMessageId: attachment.id,
            file: attachment.file,
          });
          patchAttachment(attachment.id, { status: 'done', mediaId: result.mediaId });
          uploaded.push(result.mediaId);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Photo upload failed. Try again.';
          patchAttachment(attachment.id, { status: 'error', error: message });
          setError(message);
          return;
        }
      }
      imageMediaIds = uploaded;
    } else if (hasImages && images?.controller) {
      // Story/test controller: attachments are fixtures, not uploads.
      imageMediaIds = pending.map(attachment => attachment.mediaId ?? attachment.id);
    }
    // The submitted snapshot is accepted locally here: the outbox entry owns
    // retry and redraft, so the composer clears without waiting for HTTP and
    // a second message can submit immediately with its own identity.
    sendingRef.current = true;
    clearDraft();
    const sentAttachments = imageController.attachments;
    if (!images?.controller) {
      revokeAttachments(sentAttachments);
      setAttachmentList([]);
    }
    if (fileInput.current) fileInput.current.value = '';
    setSending(true); setError('');
    sendingRef.current = false;
    try {
      if (imageMediaIds === undefined) await onSend(text);
      else await onSend(text, imageMediaIds);
    } catch { setError('Message not confirmed. It is kept in the conversation with Retry.'); }
    finally { setSending(false); }
  };
  const stop = async () => { if (!onStop || stopping) return; setStopping(true); setError(''); try { await onStop(); } catch { setError('Could not stop yet. Try again.'); } finally { setStopping(false); } };

  const currentModelLabel = current?.display_name ?? 'Model';
  const currentThinking = current?.thinking;
  const currentThinkingLabel =
    !currentThinking || currentThinking.is_default || !currentThinking.current_choice_id
      ? 'Provider default'
      : (currentThinking.choices.find(c => c.id === currentThinking.current_choice_id)?.label ?? 'Provider default');
  const followsDefault = !models.some(m => m.is_current && !m.is_default);

  return <div className="otis-composer"><div className="otis-composer__inner">
    {replyTo && <div className="otis-reply-context text-xs flex items-center justify-between"><span className="truncate">Replying to Otis: {replyTo.question}</span><Button variant="ghost" size="icon-xs" type="button" aria-label="Dismiss question" onClick={replyTo.onCancel}><CloseIcon/></Button></div>}
    {replyTo?.candidates?.length ? <div className="otis-reply-choices" aria-label="Suggested responses">{replyTo.candidates.map(choice => <Button key={choice} variant="outline" size="sm" type="button" onClick={() => { commitDraft(choice); input.current?.focus(); }}>{choice}</Button>)}</div> : null}
    {pickerOpen && <Command label={modelQuery ? 'Models' : thinkingQuery ? 'Thinking effort options' : 'Commands'} value={suggestions[activeIndex]?.insert ?? ''} onValueChange={next => { const found = suggestions.findIndex(row => row.insert === next); if (found >= 0) setIndex(found); }} shouldFilter={false} loop>
      <CommandList id={`${id}-picker`}>
        {suggestions.map((row, rowIndex) => <CommandItem key={row.name} id={`${id}-option-${rowIndex}`} value={row.insert} disabled={controlPending} onSelect={() => void select(rowIndex)}><span>{row.label}</span>{row.summary && <small className="text-xs">{row.summary}</small>}</CommandItem>)}
      </CommandList>
    </Command>}
    <div className="otis-composer__field flex flex-col min-h-[52px] rounded-2xl bg-card p-3 gap-2">
      {imageController.attachments.length > 0 && (
        <div className="otis-composer__attachments flex gap-2 overflow-x-auto" role="list" aria-label="Attached photos">
          {imageController.attachments.map(attachment => (
            <div key={attachment.id} role="listitem" className="relative shrink-0">
              <img
                src={attachment.previewUrl}
                alt="Attached file preview"
                className="h-20 w-20 rounded-xl border border-border/40 object-cover"
              />
              {attachment.status === 'uploading' && (
                <span className="absolute inset-0 grid place-items-center rounded-xl bg-card/60" aria-label="Uploading photo">
                  <span className="otis-spinner" aria-hidden="true" />
                </span>
              )}
              {attachment.status === 'error' && (
                <span className="absolute inset-x-0 bottom-0 rounded-b-xl bg-destructive/90 px-1 text-xs text-destructive-foreground" role="alert">
                  Failed
                </span>
              )}
              <button
                type="button"
                className="otis-attach-remove absolute -right-2 -top-2 grid size-6 place-items-center rounded-full border border-border bg-card text-muted-foreground hover:text-foreground"
                aria-label="Remove photo"
                disabled={sending}
                onClick={() => imageController.remove(attachment.id)}
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
      )}
      {voiceActive ? (
        <VoiceCapturePanel
          controller={voiceController}
          canSend={Boolean(voice?.adapter) && Boolean(voice?.scope?.workspaceId)}
          onCancel={() => voiceController.cancel()}
          onSend={() => void voiceController.send()}
        />
      ) : (
        <>
          <label className="otis-visually-hidden" htmlFor={id}>{placeholder}</label>
          <TextareaAutosize id={id} ref={input} name="message" minRows={1} maxRows={6} className="otis-composer__input max-h-36 min-h-6 w-full resize-none bg-transparent text-base leading-6 outline-none placeholder:text-muted-foreground" placeholder={disabled ? disabledReason ?? placeholder : placeholder} autoComplete="off" value={value} disabled={disabled}
            aria-describedby={`${id}-status`} aria-haspopup="listbox" aria-expanded={pickerOpen ? 'true' : undefined} aria-controls={pickerOpen ? `${id}-picker` : undefined} aria-activedescendant={pickerOpen && suggestions[activeIndex] ? `${id}-option-${activeIndex}` : undefined} aria-autocomplete="list"
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
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-2 flex-wrap">
              {modelsError && (
                <div className="flex items-center gap-2 text-xs text-destructive" role="alert">
                  <span>{modelsError}</span>
                  {onRetryModels && (
                    <button type="button" className="underline hover:text-foreground" onClick={onRetryModels}>
                      Retry
                    </button>
                  )}
                </div>
              )}
              {models.length > 0 && current && (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded-full border border-border bg-card/70 px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer select-none"
                      disabled={controlPending}
                      aria-label="Select model and thinking effort"
                    >
                      <span className="font-medium text-foreground">{currentModelLabel}</span>
                      {currentThinking?.state === 'supported' && currentThinkingLabel !== 'Provider default' && (
                        <span className="text-subtle">· {currentThinkingLabel}</span>
                      )}
                      <ChevronDownIcon />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="top" className="w-56" aria-label="Select model">
                    <DropdownMenuLabel>Model</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={followsDefault ? 'default' : current.command_key}
                      onValueChange={key => { void onCommand?.(`/model ${key}`); }}
                    >
                      <DropdownMenuRadioItem value="default" disabled={controlPending}>
                        <div className="flex flex-col">
                          <span className="font-medium">Workspace default</span>
                          <span className="text-xs text-muted-foreground">
                            {models.find(m => m.is_default)?.display_name ?? 'No default model'}
                          </span>
                        </div>
                      </DropdownMenuRadioItem>
                      {models.filter(m => m.available).map(m => (
                        <DropdownMenuRadioItem key={m.command_key} value={m.command_key} disabled={controlPending}>
                          <span className="font-medium">{m.display_name}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>

                    {currentThinking?.state === 'supported' && currentThinking.choices.length > 0 && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>Thinking effort</DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                          value={currentThinking.is_default ? 'default' : currentThinking.current_choice_id ?? 'default'}
                          onValueChange={key => { void onCommand?.(`/thinking ${key}`); }}
                        >
                          <DropdownMenuRadioItem value="default" disabled={controlPending}>Provider default</DropdownMenuRadioItem>
                          {currentThinking.choices.map(choice => (
                            <DropdownMenuRadioItem key={choice.id} value={choice.id} disabled={controlPending}>
                              {choice.label}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="otis-visually-hidden"
                aria-label="Attach photos"
                disabled={disabled || sending}
                onChange={event => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = '';
                  if (files.length > 0) imageController.addFiles(files);
                }}
              />
              {attachVisible && (
                <button
                  type="button"
                  className="otis-composer__action grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="Attach photos"
                  disabled={disabled || sending}
                  onClick={() => fileInput.current?.click()}
                >
                  <PlusIcon />
                </button>
              )}
              {micVisible && (
                <button
                  type="button"
                  className="otis-composer__action grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={voiceController.phase === 'requesting' ? 'Starting recording' : 'Record voice note'}
                  aria-busy={voiceController.phase === 'requesting'}
                  disabled={disabled || voiceController.phase === 'requesting'}
                  onClick={() => void voiceController.start()}
                >
                  {voiceController.phase === 'requesting' ? <span className="otis-spinner" aria-hidden="true"/> : <MicIcon/>}
                </button>
              )}
              {running && onStop && !value.trim() && imageController.attachments.length === 0 ? (
                <button
                  type="button"
                  className="otis-composer__action otis-composer__send grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
                  aria-label="Stop Otis"
                  disabled={stopping}
                  onClick={() => void stop()}
                >
                  <StopIcon/>
                </button>
              ) : (
                <button
                  type="button"
                  className={`otis-composer__action otis-composer__send grid size-9 shrink-0 place-items-center rounded-full ${
                    (value.trim() || imageController.attachments.length > 0) && !disabled
                      ? 'bg-highlight text-highlight-foreground hover:bg-highlight-hover active:bg-highlight-pressed'
                      : 'bg-accent text-subtle'
                  }`}
                  aria-label="Send"
                  aria-busy={sending}
                  disabled={disabled || tooLong || (value.trim() === '' && imageController.attachments.length === 0) || controlPending || (!modelReady && !(value.trim().startsWith('/') && !value.trim().startsWith('//')))}
                  onClick={() => void submit()}
                >
                  {sending ? <span className="otis-spinner" aria-hidden="true"/> : <SendIcon/>}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
    <div id={`${id}-status`} className={`otis-composer__status text-xs${tooLong || voiceError || error ? ' otis-composer__status--error' : ''}`} role="status">{tooLong ? `Keep the message under ${DOMAIN_BOUNDS.MAX_INPUT_CHARS.toLocaleString()} characters.` : voiceError || error || (modelsLoading ? 'Checking available model…' : !modelReady ? 'Choose a model to start. Connections are in Settings.' : voiceStorageWarning || 'Otis can make mistakes. Verify important business info.')}<span className="otis-visually-hidden">{sending ? 'Sending your message.' : ''}</span></div>
  </div></div>;
}
