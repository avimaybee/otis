import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { CommandDescriptor, ModelOption } from '@otis/contracts';
import { DOMAIN_BOUNDS } from '@otis/contracts';
import { shouldSuggestCommands } from '@otis/commands';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import {
  SendIcon,
  PlusIcon,
  ExpandIcon,
  CloseIcon,
  CommandIcon,
  QuestionIcon,
  PencilIcon,
  MicIcon,
  BrainIcon,
  AudioLinesIcon,
  ChevronRightIcon,
} from './icons.js';
import { Overlay } from './Overlay.js';

export interface ClarificationContext {
  id?: string;
  question: string;
  candidates?: string[] | null;
  missing_fields?: string[];
  intended_operation?: string;
  onCancel: () => void;
}

export interface ComposerProps {
  disabled?: boolean;
  disabledReason?: string;
  running: boolean;
  queuedCount: number;
  commands: CommandDescriptor[];
  models?: ModelOption[];
  placeholder?: string;
  draftKey?: string;
  draftValue?: string | null;
  replyTo?: ClarificationContext;
  onSend: (text: string) => void | boolean | Promise<boolean>;
}

export interface SuggestionItem {
  name: string;
  label?: string;
  summary: string;
  insert: string;
  hasSubmenu?: boolean;
}

export function deriveCandidates(
  question: string,
  candidates?: string[] | null,
  missingFields?: string[],
  _intendedOp?: string
): string[] {
  if (candidates && candidates.length > 0) return candidates;
  const q = question.toLowerCase();
  const fields = (missingFields ?? []).map(f => f.toLowerCase());
  if (fields.includes('due') || fields.includes('deadline') || /when|deadline|due|ready|schedule|date/i.test(q)) {
    return ['Friday', 'Tomorrow', 'No deadline needed'];
  }
  if (fields.includes('confirm') || /confirm|proceed|sure|approve/i.test(q)) {
    return ['Yes, confirm', 'Cancel'];
  }
  if (fields.includes('status') || /status|lead.*status|cold|warm|hot|lost|won/i.test(q)) {
    return ['Yes, update status', 'Keep current status'];
  }
  if (/delete|erase|remove/i.test(q)) {
    return ['Yes, remove', 'Keep it'];
  }
  return [];
}

export function Composer({
  disabled,
  disabledReason,
  running,
  queuedCount,
  commands,
  models = [],
  placeholder = 'Message Otis',
  draftKey,
  draftValue,
  replyTo,
  onSend,
}: ComposerProps) {
  const [value, setValue] = useState(() => {
    try {
      return draftKey ? sessionStorage.getItem(draftKey) ?? '' : '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    if (draftValue !== undefined && draftValue !== null) {
      setValue(draftValue);
      inputRef.current?.focus();
    }
  }, [draftValue]);

  const [customValue, setCustomValue] = useState('');
  const [pickerIndex, setPickerIndex] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolModels, setToolModels] = useState(false);
  const [toolThinking, setToolThinking] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const thinkingMenuRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);
  const [dismissed, setDismissed] = useState(false);
  const [multiline, setMultiline] = useState(false);
  const [expandedEditor, setExpandedEditor] = useState(false);
  const [expandable, setExpandable] = useState(false);
  const [sending, setSending] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const isDesktop = useMediaQuery('(min-width: 900px) and (pointer: fine)');
  const id = useId();

  const options = replyTo
    ? deriveCandidates(replyTo.question, replyTo.candidates, replyTo.missing_fields, replyTo.intended_operation)
    : [];

  const handleChoice = async (choiceText: string) => {
    setSending(true);
    setSubmitFailed(false);
    try {
      const result = await onSend(choiceText);
      if (result === false) setSubmitFailed(true);
    } catch {
      setSubmitFailed(true);
    } finally {
      setSending(false);
    }
  };

  const handleCustomSubmit = async () => {
    const text = customValue.trim();
    if (!text || sending) return;
    setSending(true);
    setSubmitFailed(false);
    try {
      const result = await onSend(text);
      if (result !== false) {
        setCustomValue('');
      } else {
        setSubmitFailed(true);
      }
    } catch {
      setSubmitFailed(true);
    } finally {
      setSending(false);
    }
  };

  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      replyTo?.onCancel();
      return;
    }
    if (document.activeElement !== customInputRef.current && options.length > 0) {
      const num = parseInt(event.key, 10);
      if (num >= 1 && num <= options.length) {
        event.preventDefault();
        void handleChoice(options[num - 1]!);
      }
    }
  };

  const currentModel = models.find(m => m.is_current) ?? models.find(m => m.is_default);
  const currentThinking = currentModel?.thinking;

  const modelQuery = /^\/model\s*(.*)$/i.exec(value);
  const modelSuggestions: SuggestionItem[] = [
    { name: 'default', label: 'default', summary: 'Follow the workspace model', insert: '/model default', hasSubmenu: false },
    ...models.filter(model => model.available).map(model => ({
      name: model.command_key,
      label: model.display_name,
      summary: `${model.is_current ? 'Current · ' : ''}${model.is_default ? 'Workspace default · ' : ''}${model.voice_available ? 'Voice available' : 'Text only'}`,
      insert: `/model ${model.command_key}`,
      hasSubmenu: false,
    })),
  ];

  const thinkingQuery = /^\/thinking\s*(.*)$/i.exec(value);
  const thinkingSuggestions: SuggestionItem[] = currentThinking?.state === 'supported' ? [
    {
      name: 'default',
      label: 'Provider default',
      summary: `${currentThinking.is_default ? 'Current · ' : ''}Standard reasoning effort`,
      insert: '/thinking default',
      hasSubmenu: false,
    },
    ...currentThinking.choices.map(c => ({
      name: c.id,
      label: c.label,
      summary: `${c.id === currentThinking.current_choice_id ? 'Current · ' : ''}Thinking effort`,
      insert: `/thinking ${c.id}`,
      hasSubmenu: false,
    })),
  ] : [];

  const toolSuggestions: SuggestionItem[] = [
    { name: '/model', label: 'Model', summary: 'Change from current model or workspace default', insert: '/model', hasSubmenu: true },
    ...(currentThinking?.state === 'supported' && currentThinking.choices.length > 0
      ? [{
          name: '/thinking',
          label: 'Thinking',
          summary: `Effort level (${currentThinking.current_choice_id ? (currentThinking.choices.find(c => c.id === currentThinking.current_choice_id)?.label ?? currentThinking.current_choice_id) : 'Default'})`,
          insert: '/thinking',
          hasSubmenu: true,
        }]
      : []),
    { name: '/today', label: 'Today’s Brief', summary: 'Check due work and daily briefing without notifications', insert: '/today', hasSubmenu: false },
    { name: '/undo', label: 'Undo', summary: 'Inspect and revert the latest business action', insert: '/undo', hasSubmenu: false },
    { name: 'voice', label: 'Voice note', summary: 'Record authenticated voice note (Groq Whisper)', insert: '', hasSubmenu: false },
    { name: '/help', label: 'Help & Syntax', summary: 'View available commands and formatting', insert: '/help', hasSubmenu: false },
  ];

  const suggestions: SuggestionItem[] = toolsOpen
    ? toolModels
      ? modelSuggestions
      : toolThinking
      ? thinkingSuggestions
      : toolSuggestions
    : modelQuery
    ? modelSuggestions.filter(row => row.name.toLowerCase().includes(modelQuery[1]!.toLowerCase()) || (row.label && row.label.toLowerCase().includes(modelQuery[1]!.toLowerCase())))
    : thinkingQuery && thinkingSuggestions.length > 0
    ? thinkingSuggestions.filter(row => row.name.toLowerCase().includes(thinkingQuery[1]!.toLowerCase()) || (row.label && row.label.toLowerCase().includes(thinkingQuery[1]!.toLowerCase())))
    : commands
        .filter(command => command.available && `${command.name} ${command.summary}`.toLowerCase().includes(value.toLowerCase().replace(/^\//, '')))
        .map(command => ({
          name: `/${command.name}`,
          label: `/${command.name}`,
          summary: command.summary,
          insert: `/${command.name} `,
          hasSubmenu: ['model', 'workspace', 'thinking'].includes(command.name),
        }));

  const pickerOpen = !disabled && !dismissed && (toolsOpen || Boolean(modelQuery) || Boolean(thinkingQuery && thinkingSuggestions.length > 0) || shouldSuggestCommands(value, value.length)) && suggestions.length > 0;
  const tooLong = value.length > DOMAIN_BOUNDS.MAX_INPUT_CHARS;

  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    const measure = () => {
      node.style.height = 'auto';
      const textHeight = node.scrollHeight;
      const isMulti = textHeight > 34 || value.includes('\n');
      setMultiline(isMulti);
      node.style.height = `${Math.min(Math.max(24, textHeight), 180)}px`;
      setExpandable(textHeight > 180);
    };
    measure();
    const observer = new ResizeObserver(() => measure());
    if (node.parentElement) observer.observe(node.parentElement);
    return () => observer.disconnect();
  }, [value]);

  useEffect(() => {
    if (draftKey) {
      try {
        if (value) sessionStorage.setItem(draftKey, value);
        else sessionStorage.removeItem(draftKey);
      } catch {
        /* draft still held in the composer */
      }
    }
  }, [value, draftKey]);

  useEffect(() => {
    if (!toolsOpen) return;
    const outside = (event: PointerEvent) => {
      if (!composerRef.current?.contains(event.target as Node)) {
        setToolsOpen(false);
        setToolModels(false);
        setToolThinking(false);
      }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [toolsOpen]);

  useEffect(() => {
    if (!thinkingMenuOpen) return;
    const outside = (event: PointerEvent) => {
      if (!thinkingMenuRef.current?.contains(event.target as Node)) {
        setThinkingMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [thinkingMenuOpen]);

  const change = (text: string) => {
    setToolsOpen(false);
    setToolModels(false);
    setToolThinking(false);
    setValue(text);
    setDismissed(false);
    setPickerIndex(0);
  };

  const select = async (index: number) => {
    const row = suggestions[index];
    if (!row) return;
    if (toolsOpen && !toolModels && !toolThinking) {
      if (row.name === '/model') {
        setToolModels(true);
        setPickerIndex(0);
        return;
      }
      if (row.name === '/thinking') {
        setToolThinking(true);
        setPickerIndex(0);
        return;
      }
      if (row.name === 'voice') {
        toast.info('Voice notes are retained and transcribed via Groq Whisper in Gate 010.');
        setToolsOpen(false);
        return;
      }
      setSending(true);
      setSubmitFailed(false);
      try {
        const result = await onSend(row.insert);
        setSubmitFailed(result === false);
        setToolsOpen(false);
      } catch {
        setSubmitFailed(true);
      } finally {
        setSending(false);
        inputRef.current?.focus();
      }
      return;
    }
    if (toolsOpen && (toolModels || toolThinking)) {
      setSending(true);
      setSubmitFailed(false);
      try {
        const result = await onSend(row.insert);
        setSubmitFailed(result === false);
        setToolsOpen(false);
        setToolModels(false);
        setToolThinking(false);
      } catch {
        setSubmitFailed(true);
      } finally {
        setSending(false);
        inputRef.current?.focus();
      }
      return;
    }
    setValue(row.insert);
    setDismissed(!row.insert.endsWith(' '));
    setPickerIndex(0);
    inputRef.current?.focus();
  };

  const submit = async () => {
    const text = value.trim();
    if (!text || disabled || sending || tooLong) return;
    setSending(true);
    setSubmitFailed(false);
    try {
      const result = await onSend(text);
      if (result !== false) {
        setExpandedEditor(false);
        if (draftKey) {
          try {
            sessionStorage.removeItem(draftKey);
          } catch {
            /* input still clears */
          }
        }
        setValue(current => (current === value ? '' : current));
      } else {
        setSubmitFailed(true);
      }
    } catch {
      setSubmitFailed(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="otis-composer" ref={composerRef}>
      <div className="otis-composer__inner">
        {!replyTo && (
          <p className="otis-composer__disclaimer">
            Otis can make mistakes. Verify important business info.
          </p>
        )}

        {replyTo ? (
          <div className="otis-question-card" role="region" aria-label="Question from Otis" onKeyDown={handleCardKeyDown}>
            <div className="otis-question-card__header">
              <div className="otis-question-card__title">
                <QuestionIcon />
                <span>Question</span>
              </div>
              <button
                type="button"
                className="otis-question-card__close"
                aria-label="Dismiss question"
                onClick={replyTo.onCancel}
              >
                <CloseIcon />
              </button>
            </div>
            <div className="otis-question-card__prompt">{replyTo.question}</div>
            {options.length > 0 && (
              <div className="otis-question-card__options" role="group" aria-label="Suggested responses">
                {options.map((option, idx) => (
                  <button
                    key={option}
                    type="button"
                    className="otis-question-card__option"
                    disabled={sending}
                    onClick={() => void handleChoice(option)}
                  >
                    <span className="otis-question-card__badge">{idx + 1}</span>
                    <span className="otis-question-card__option-text">{option}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="otis-question-card__custom">
              <span className="otis-question-card__custom-icon" aria-hidden="true">
                <PencilIcon />
              </span>
              <input
                ref={customInputRef}
                type="text"
                className="otis-question-card__custom-input"
                placeholder="Or write your own response"
                value={customValue}
                disabled={sending}
                onChange={event => setCustomValue(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void handleCustomSubmit();
                  }
                }}
              />
              <button type="button" className="otis-question-card__skip" disabled={sending} onClick={replyTo.onCancel}>
                Skip
              </button>
              <button
                type="button"
                className="otis-question-card__send"
                disabled={sending || !customValue.trim()}
                onClick={() => void handleCustomSubmit()}
                aria-label="Send response"
              >
                <SendIcon />
              </button>
            </div>
            {submitFailed && (
              <p className="otis-entry__error" role="alert">
                Response not confirmed. Please try again.
              </p>
            )}
          </div>
        ) : (
          <>
            {pickerOpen && (
              <div
                id={`${id}-picker`}
                className="otis-picker"
                role="listbox"
                aria-label={
                  toolModels && toolsOpen || modelQuery && !toolsOpen
                    ? 'Models'
                    : toolsOpen
                    ? 'Chat tools'
                    : 'Commands'
                }
              >
                {toolsOpen && (toolModels || toolThinking) && (
                  <div className="otis-picker__header">
                    <button
                      type="button"
                      className="otis-picker__back"
                      onClick={() => {
                        setToolModels(false);
                        setToolThinking(false);
                        setPickerIndex(0);
                      }}
                    >
                      ← Back to tools
                    </button>
                  </div>
                )}
                <ul className="otis-picker__list">
                  {suggestions.map((row, index) => (
                    <li key={row.name}>
                      <button
                        id={`${id}-${index}`}
                        type="button"
                        role="option"
                        aria-selected={index === pickerIndex}
                        className="otis-picker__option"
                        tabIndex={-1}
                        onMouseDown={event => event.preventDefault()}
                        disabled={sending}
                        onClick={() => void select(index)}
                      >
                        <span className="otis-picker__icon-slot">
                          {row.name === 'voice' ? <MicIcon /> : <CommandIcon name={row.name} />}
                        </span>
                        <span className="otis-picker__text">
                          <span className="otis-picker__name">
                            {row.label ?? (toolsOpen && !toolModels && !toolThinking ? row.name.slice(1).replace(/^./, l => l.toUpperCase()) : row.name)}
                          </span>
                          <span className="otis-picker__summary">{row.summary}</span>
                        </span>
                        {row.hasSubmenu && (
                          <span className="otis-picker__chevron" aria-hidden="true">
                            <ChevronRightIcon />
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className={`otis-composer__field${multiline ? ' otis-composer__field--multiline' : ''}`}>
              <div className="otis-composer__input-wrap">
                <label className="otis-visually-hidden" htmlFor={id}>
                  {placeholder}
                </label>
                <textarea
                  id={id}
                  ref={inputRef}
                  name="message"
                  autoComplete="off"
                  className="otis-composer__input"
                  placeholder={disabled ? disabledReason ?? placeholder : placeholder}
                  value={value}
                  rows={1}
                  disabled={disabled || sending}
                  aria-describedby={tooLong ? `${id}-limit` : undefined}
                  aria-controls={pickerOpen ? `${id}-picker` : undefined}
                  aria-expanded={pickerOpen}
                  aria-autocomplete="list"
                  aria-activedescendant={pickerOpen ? `${id}-${pickerIndex}` : undefined}
                  onChange={event => change(event.target.value)}
                  onKeyDown={event => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (pickerOpen) {
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        setPickerIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
                        return;
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setDismissed(true);
                        setToolsOpen(false);
                        setToolModels(false);
                        setToolThinking(false);
                        setThinkingMenuOpen(false);
                        return;
                      }
                      if (event.key === 'Enter' || event.key === 'Tab') {
                        event.preventDefault();
                        void select(pickerIndex);
                        return;
                      }
                    }
                    if (event.key === 'Enter' && isDesktop && !event.shiftKey) {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                />
                {expandable && multiline && (
                  <button
                    className="otis-composer__expand otis-iconbutton"
                    type="button"
                    aria-label="Expand message editor"
                    onClick={() => setExpandedEditor(true)}
                  >
                    <ExpandIcon />
                  </button>
                )}
              </div>

              <div className="otis-composer__actions-bar">
                <button
                  className={`otis-composer__plus otis-iconbutton${toolsOpen ? ' otis-composer__plus--open' : ''}`}
                  type="button"
                  disabled={disabled || sending}
                  aria-label="Chat tools"
                  aria-expanded={toolsOpen}
                  aria-controls={toolsOpen ? `${id}-picker` : undefined}
                  onClick={() => {
                    setToolsOpen(open => !open);
                    setToolModels(false);
                    setToolThinking(false);
                    setDismissed(false);
                    setPickerIndex(0);
                    inputRef.current?.focus();
                  }}
                >
                  <PlusIcon />
                </button>

                <div className="otis-composer__trailing">
                  {currentThinking?.state === 'supported' && currentThinking.choices.length > 0 && (
                    <div className="otis-thinking-menu-wrap" ref={thinkingMenuRef}>
                      <button
                        type="button"
                        className={`otis-composer__think-btn${currentThinking.current_choice_id && currentThinking.current_choice_id !== 'default' ? ' otis-composer__think-btn--active' : ''}`}
                        aria-label="Thinking effort"
                        aria-haspopup="menu"
                        aria-expanded={thinkingMenuOpen}
                        disabled={disabled || sending}
                        onClick={() => setThinkingMenuOpen(open => !open)}
                        title="Choose model thinking effort"
                      >
                        <BrainIcon />
                        <span>
                          {currentThinking.current_choice_id && currentThinking.current_choice_id !== 'default'
                            ? `Think · ${currentThinking.choices.find(c => c.id === currentThinking.current_choice_id)?.label ?? currentThinking.current_choice_id}`
                            : 'Think'}
                        </span>
                      </button>
                      {thinkingMenuOpen && (
                        <div className="otis-thinking-menu" role="menu" aria-label="Thinking effort options">
                          <button
                            type="button"
                            role="menuitem"
                            className={`otis-thinking-menu__item${currentThinking.is_default ? ' otis-thinking-menu__item--active' : ''}`}
                            onClick={async () => {
                              setThinkingMenuOpen(false);
                              setSending(true);
                              try {
                                await onSend('/thinking default');
                              } finally {
                                setSending(false);
                              }
                            }}
                          >
                            <span>Provider default</span>
                            {currentThinking.is_default && <span className="otis-thinking-menu__check">✓</span>}
                          </button>
                          {currentThinking.choices.map(c => {
                            const isActive = c.id === currentThinking.current_choice_id;
                            return (
                              <button
                                key={c.id}
                                type="button"
                                role="menuitem"
                                className={`otis-thinking-menu__item${isActive ? ' otis-thinking-menu__item--active' : ''}`}
                                onClick={async () => {
                                  setThinkingMenuOpen(false);
                                  setSending(true);
                                  try {
                                    await onSend(`/thinking ${c.id}`);
                                  } finally {
                                    setSending(false);
                                  }
                                }}
                              >
                                <span>{c.label}</span>
                                {isActive && <span className="otis-thinking-menu__check">✓</span>}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  <button
                    type="button"
                    className="otis-composer__mic-btn otis-iconbutton"
                    aria-label="Record voice note"
                    onClick={() => {
                      toast.info('Voice notes are retained and transcribed via Groq Whisper in Gate 010.');
                    }}
                    title="Record voice note"
                  >
                    <MicIcon />
                  </button>

                  <button
                    type="button"
                    className={`otis-composer__send${!value.trim() ? ' otis-composer__send--voice' : ''}`}
                    disabled={disabled || sending || tooLong || !value.trim()}
                    onClick={() => void submit()}
                    aria-label={running ? 'Steer Otis' : 'Send'}
                  >
                    {value.trim() ? <SendIcon /> : <AudioLinesIcon />}
                  </button>
                </div>
              </div>
            </div>

            {tooLong ? (
              <p id={`${id}-limit`} className="otis-entry__error">
                Keep the message under {DOMAIN_BOUNDS.MAX_INPUT_CHARS.toLocaleString()} characters.
              </p>
            ) : (
              (sending || running || queuedCount > 0) && (
                <p className="otis-composer__hint" role="status">
                  {sending ? 'Sending…' : running ? 'Steer the current work' : `${queuedCount} queued`}
                </p>
              )
            )}

            {expandedEditor && (
              <Overlay initialFocus={editorRef} label="Message editor" onClose={() => setExpandedEditor(false)}>
                <div className="otis-message-editor">
                  <header className="otis-pane-header">
                    <h2>Message</h2>
                    <button
                      className="otis-iconbutton"
                      type="button"
                      aria-label="Close message editor"
                      onClick={() => setExpandedEditor(false)}
                    >
                      <CloseIcon />
                    </button>
                  </header>
                  <label className="otis-visually-hidden" htmlFor={`${id}-expanded`}>
                    Message Otis
                  </label>
                  <textarea
                    ref={editorRef}
                    id={`${id}-expanded`}
                    name="message"
                    autoComplete="off"
                    autoFocus
                    value={value}
                    onChange={event => change(event.target.value)}
                    disabled={sending}
                  />
                  {submitFailed && (
                    <p className="otis-entry__error" role="alert">
                      Message not confirmed. Your draft is retained; retry to send it.
                    </p>
                  )}
                  <footer>
                    <button className="otis-button" type="button" onClick={() => setExpandedEditor(false)}>
                      Done
                    </button>
                    <button
                      className="otis-button otis-button--primary"
                      type="button"
                      disabled={sending || tooLong || !value.trim()}
                      onClick={() => void submit()}
                    >
                      {running ? 'Steer' : 'Send'}
                      <SendIcon />
                    </button>
                  </footer>
                </div>
              </Overlay>
            )}
          </>
        )}
      </div>
    </div>
  );
}
