import { useEffect, useId, useRef, useState } from 'react';
import type { CommandDescriptor, ModelOption } from '@otis/contracts';
import { DOMAIN_BOUNDS } from '@otis/contracts';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { CloseIcon, SendIcon, StopIcon } from './icons.js';
import { ModelControls } from './ModelControls.js';
import { Button } from './ui/button.js';

export interface ClarificationContext {
  id?: string; question: string; candidates?: string[] | null; missing_fields?: string[];
  intended_operation?: string; onCancel: () => void;
}
export interface ComposerProps {
  disabled?: boolean; disabledReason?: string; running: boolean; queuedCount: number;
  commands: CommandDescriptor[]; models?: ModelOption[]; workspaces?: { id: string; name: string }[];
  placeholder?: string; draftKey?: string; draftValue?: string | null; replyTo?: ClarificationContext;
  controlPending?: boolean; followsDefault?: boolean; modelReady?: boolean; onCommand?: (text: string) => Promise<boolean>;
  onStop?: () => Promise<void>; onSend: (text: string) => void | boolean | Promise<boolean>;
}
export interface SuggestionItem { name: string; label?: string; summary: string; insert: string; hasSubmenu?: boolean; }
// Only offer choices the server actually supplied. Never invent a due date or consent.
export function deriveCandidates(_question: string, candidates?: string[] | null, _missingFields?: string[], _intendedOp?: string): string[] { return candidates ?? []; }

export function Composer({ disabled, disabledReason, running, commands, models = [], workspaces = [],
  placeholder = 'Message Otis', draftKey, draftValue, replyTo, controlPending, followsDefault, modelReady = true, onCommand, onStop, onSend }: ComposerProps) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);
  const [value, setValue] = useState(() => { try { return draftKey ? sessionStorage.getItem(draftKey) ?? '' : ''; } catch { return ''; } });
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const [index, setIndex] = useState(0);
  const desktop = useMediaQuery('(min-width: 900px) and (pointer: fine)');
  const tooLong = value.length > DOMAIN_BOUNDS.MAX_INPUT_CHARS;
  const current = models.find(model => model.is_current);
  const modelQuery = /^\/model\s+(.*)$/i.exec(value);
  const thinkingQuery = /^\/thinking\s+(.*)$/i.exec(value);
  const workspaceQuery = /^\/workspace\s+(.*)$/i.exec(value);
  const isSlash = /^\/\S*\s*[^\n]*$/.test(value);
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

  useEffect(() => { if (draftValue !== undefined && draftValue !== null) { setValue(draftValue); setDismissed(false); input.current?.focus(); } }, [draftValue]);
  useEffect(() => { try { if (draftKey) { if (value) sessionStorage.setItem(draftKey, value); else sessionStorage.removeItem(draftKey); } } catch { /* Input remains available when browser storage is full. */ } }, [draftKey, value]);
  useEffect(() => {
    const node = input.current; if (!node) return;
    const measure = () => { node.style.height = 'auto'; node.style.height = `${Math.min(Math.max(24, node.scrollHeight), 160)}px`; };
    measure(); const observer = new ResizeObserver(measure); observer.observe(node); return () => observer.disconnect();
  }, [value]);

  const command = async (text: string, clearCommandDraft = false) => {
    if (!onCommand || controlPending) return false;
    setError('');
    try { const applied = await onCommand(text); if (applied && clearCommandDraft) setValue(previous => previous.trim() === value.trim() ? '' : previous); return applied; }
    catch { setError('Could not apply that command. Try again.'); return false; }
  };
  const select = async (selected: number) => {
    const row = suggestions[selected]; if (!row) return;
    if (row.insert.endsWith(' ')) { setValue(row.insert); setIndex(0); return; }
    setDismissed(true); await command(row.insert, true); input.current?.focus();
  };
  const submit = async () => {
    const text = value.trim(); if (!text || disabled || sendingRef.current || tooLong || controlPending) return;
    if (text.startsWith('/') && !replyTo) { await command(text, true); return; }
    if (!modelReady) return;
    sendingRef.current = true; setSending(true); setError('');
    try {
      const accepted = await onSend(text);
      if (accepted !== false) setValue(previous => previous === value ? '' : previous);
      else setError('Message not confirmed. Your draft is saved; try again.');
    } catch { setError('Message not confirmed. Your draft is saved; try again.'); }
    finally { sendingRef.current = false; setSending(false); }
  };
  const stop = async () => { if (!onStop || stopping) return; setStopping(true); setError(''); try { await onStop(); } catch { setError('Could not stop yet. Try again.'); } finally { setStopping(false); } };

  return <div className="otis-composer"><div className="otis-composer__inner">
    {replyTo && <div className="otis-reply-context"><span>Replying to Otis</span><Button variant="ghost" size="icon-xs" type="button" aria-label="Dismiss question" onClick={replyTo.onCancel}><CloseIcon/></Button></div>}
    {replyTo?.candidates?.length ? <div className="otis-reply-choices" aria-label="Suggested responses">{replyTo.candidates.map(choice => <Button key={choice} variant="outline" size="sm" type="button" className="otis-button" onClick={() => { setValue(choice); input.current?.focus(); }}>{choice}</Button>)}</div> : null}
    {pickerOpen && <div id={`${id}-picker`} className="otis-command-picker" role="listbox" aria-label={modelQuery ? 'Models' : thinkingQuery ? 'Thinking effort options' : 'Commands'}>
      {suggestions.map((row, rowIndex) => <button key={row.name} id={`${id}-option-${rowIndex}`} type="button" role="option" aria-selected={rowIndex === activeIndex} className="otis-command-picker__item" tabIndex={-1} disabled={controlPending} onMouseDown={event => event.preventDefault()} onClick={() => void select(rowIndex)}><span>{row.label}</span>{row.summary && <small>{row.summary}</small>}</button>)}
    </div>}
    <div className="otis-composer__field">
      <label className="otis-visually-hidden" htmlFor={id}>{placeholder}</label>
      <textarea id={id} ref={input} name="message" className="otis-composer__input" placeholder={disabled ? disabledReason ?? placeholder : placeholder} autoComplete="off" rows={1} value={value} disabled={disabled}
        aria-describedby={`${id}-status`} aria-controls={pickerOpen ? `${id}-picker` : undefined} aria-expanded={pickerOpen} aria-autocomplete="list" aria-activedescendant={pickerOpen ? `${id}-option-${activeIndex}` : undefined}
        onChange={event => { setValue(event.target.value); setDismissed(false); setIndex(0); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (pickerOpen) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length); return; }
            if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return; }
            if (event.key === 'Tab' || event.key === 'Enter') { event.preventDefault(); void select(activeIndex); return; }
          }
          if (event.key === 'Enter' && desktop && !event.shiftKey) { event.preventDefault(); void submit(); }
        }}/>
      <div className="otis-composer__toolbar">
        <ModelControls models={models} followsDefault={followsDefault} disabled={disabled} pending={controlPending} onCommand={text => command(text)}/>
        <div className="otis-composer__submit-controls">
          {running && onStop && <Button variant="ghost" size="icon" type="button" className="otis-composer__stop otis-iconbutton" aria-label="Stop Otis" disabled={stopping} onClick={() => void stop()}><StopIcon/></Button>}
          <Button size="icon" type="button" className="otis-composer__send" aria-label="Send" aria-busy={sending} disabled={disabled || sending || tooLong || !value.trim() || controlPending || (!modelReady && !value.startsWith('/'))} onClick={() => void submit()}>{sending ? <span className="otis-spinner" aria-hidden="true"/> : <SendIcon/>}</Button>
        </div>
      </div>
    </div>
    <div id={`${id}-status`} className={`otis-composer__status${error || tooLong ? ' otis-composer__status--error' : ''}`} role="status">{tooLong ? `Keep the message under ${DOMAIN_BOUNDS.MAX_INPUT_CHARS.toLocaleString()} characters.` : error || (!modelReady ? 'Choose a model to start. Connections are in Settings.' : 'Otis can make mistakes. Verify important business info.')}<span className="otis-visually-hidden">{sending ? 'Sending your message.' : ''}</span></div>
  </div></div>;
}
