import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import type { ClarificationSummary } from '@otis/contracts';
import { cancelDraftSave, deleteDraft, draftSession, flushDraftSaves, loadDraft, scheduleDraftSave } from '../api/drafts.js';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { CloseIcon } from './icons.js';
import { Button } from './ui/button.js';

export interface QuestionPanelProps {
  question: ClarificationSummary;
  /** Question-scoped draft key, independent of the main chat draft. */
  draftKey: string;
  /** Incremented by an explicit "Answer question" action; mount alone never focuses. */
  focusSignal?: number;
  /** Returns false when the question is no longer answerable; the field is kept. */
  onSubmit: (questionId: string, text: string) => boolean | void;
  onSkip: (questionId: string) => void;
  onClose: (questionId: string) => void;
}

/**
 * Codex-style explicit answer panel (design.md section 6, token 8.12). One
 * production component for application and stories. Choosing a suggestion
 * fills the answer field without submitting; typed text always wins. Only
 * this panel's Send attaches the question identity — ordinary chat, commands
 * and voice notes never inherit it. No voice control until a recorded note
 * can carry the same target through transcription and resume.
 */
export function QuestionPanel({ question, draftKey, focusSignal = 0, onSubmit, onSkip, onClose }: QuestionPanelProps) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState('');
  const valueRef = useRef('');
  const desktop = useMediaQuery('(min-width: 900px) and (pointer: fine)');
  const choices = question.candidates ?? [];

  const commitDraft = (next: string) => {
    setValue(next);
    valueRef.current = next;
    scheduleDraftSave(draftKey, next);
  };
  const clearDraft = () => {
    setValue('');
    valueRef.current = '';
    cancelDraftSave(draftKey);
    void deleteDraft(draftKey);
  };

  // Scoped draft restore, same session discipline as the main composer:
  // explicit edits win over storage; a session move mid-hydration drops.
  useEffect(() => {
    const key = draftKey;
    const session = draftSession(key);
    let live = true;
    void loadDraft(key).then(text => {
      if (live && text != null && (session === null || draftSession(key) === session)) {
        setValue(current => (current === '' ? text : current));
      }
    });
    return () => {
      live = false;
      flushDraftSaves(key);
    };
  }, [draftKey]);

  // Explicit requests focus the answer field; arrival alone never steals it
  // from ongoing typing in the main composer.
  useEffect(() => {
    if (focusSignal > 0) input.current?.focus();
  }, [focusSignal]);

  const submit = () => {
    const text = valueRef.current.trim();
    if (!text) return;
    const accepted = onSubmit(question.id, text);
    if (accepted !== false) clearDraft();
  };

  const selected = (choice: string) => value === choice;
  // Escape closes the panel from any of its own controls; arrival alone
  // never moves focus, so closure is always the focused user's choice.
  const escapeToClose = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose(question.id);
    }
  };

  return (
    <section
      aria-label="Question from Otis"
      className="flex max-h-[min(320px,45dvh)] flex-col gap-2 overflow-y-auto overscroll-contain rounded-xl border border-border bg-card p-3"
    >
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Question</span>
        <Button variant="ghost" size="icon-xs" type="button" aria-label="Close question panel" onClick={() => onClose(question.id)} onKeyDown={escapeToClose}>
          <CloseIcon />
        </Button>
      </div>
      <p className="text-base text-foreground text-wrap-pretty">{question.question}</p>
      {choices.length > 0 && (
        <div className="flex flex-col gap-1" role="group" aria-label="Suggested answers">
          {choices.map((choice, index) => (
            <button
              key={`${index}:${choice}`}
              type="button"
              aria-pressed={selected(choice)}
              onClick={() => {
                commitDraft(choice);
                input.current?.focus();
              }}
              onKeyDown={escapeToClose}
              className={`flex min-h-9 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent nav:min-h-8 ${selected(choice) ? 'bg-accent' : ''}`}
            >
              <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-sm bg-accent text-xs text-muted-foreground">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">{choice}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-lg border border-input bg-transparent p-2">
        <label className="otis-visually-hidden" htmlFor={`${id}-answer`}>
          Answer {question.question}
        </label>
        <TextareaAutosize
          id={`${id}-answer`}
          ref={input}
          minRows={1}
          maxRows={6}
          placeholder="Answer Otis"
          autoComplete="off"
          value={value}
          onChange={event => commitDraft(event.target.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Escape') {
              escapeToClose(event);
              return;
            }
            if (event.key === 'Enter' && desktop && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          className="otis-question__answer max-h-36 min-h-6 min-w-0 flex-1 resize-none bg-transparent text-base leading-6 outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={() => onSkip(question.id)} onKeyDown={escapeToClose}>
          Skip
        </Button>
        <Button size="sm" type="button" disabled={value.trim() === ''} onClick={submit} onKeyDown={escapeToClose}>
          Send
        </Button>
      </div>
    </section>
  );
}
