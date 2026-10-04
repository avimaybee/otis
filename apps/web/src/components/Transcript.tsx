import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import type { ChatMessage, PublicActivity, RunDetailResponse } from '@otis/contracts';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import { ChevronDownIcon, CheckIcon, AlertCircleIcon, UndoIcon, TerminalIcon, FileTextIcon, SearchDocIcon, CopyIcon, ArrowDownIcon, PencilIcon } from './icons.js';
import { Button } from './ui/button.js';
import { ThinkingDisclosure } from './Thinking.js';
import { reduceThinking } from '../api/thinking.js';
import { dayKeyInZone, formatClockTime, formatDayLabel } from '../i18n/format.js';

export interface WorkingStep { id: string; label: string; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'undone'; actionId?: string | null; summary?: string | null; }
export const STATES: Record<WorkingStep['state'], string> = { queued: 'Queued', running: 'Working', succeeded: 'Done', failed: 'Failed', skipped: 'Skipped', undone: 'Undone' };
const LABELS: Record<string, string> = { find_entities: 'Finding the business', query: 'Reading saved records', search_memory: 'Searching workspace memory', get_memory: 'Reading the source', upsert_entity: 'Saving the business', create_entity: 'Saving the business', set_fields: 'Updating the record', set_field: 'Updating the record', log_event: 'Saving the note', create_task: 'Saving the follow-up', update_task: 'Updating the follow-up', draft_message: 'Preparing the draft', record_draft: 'Saving the draft', remember_context: 'Saving workspace context', forget_memory: 'Forgetting saved context', undo: 'Reverting the change', update_preference: 'Updating your preference' };
export const stepLabel = (name?: string | null) => (name ? (LABELS[name] ?? name.replace(/_/g, ' ')) : 'Working');
function failureMessage(code: string | null | undefined) {
  if (code === 'model_unavailable') return 'Choose an available model to continue. Your message is saved.';
  if (code === 'provider_stream_error') return 'The model connection failed. Your message is saved.';
  if (code === 'missing_budgets') return 'Otis has a workspace setup problem. Your message is saved.';
  return 'I couldn’t finish that request. Your message is saved.';
}

function StepIcon({ label, state }: { label: string; state: WorkingStep['state'] }) {
  if (state === 'failed') return <AlertCircleIcon />;
  if (state === 'undone') return <UndoIcon />;
  const lower = label.toLowerCase();
  if (lower.includes('search') || lower.includes('find') || lower.includes('reading')) return <SearchDocIcon />;
  if (lower.includes('saving') || lower.includes('updating') || lower.includes('draft') || lower.includes('record')) return <FileTextIcon />;
  if (lower.includes('command')) return <TerminalIcon />;
  return <CheckIcon />;
}

export function WorkingDisclosure({ steps, finished, expanded, onToggle, onInspectAction }: { steps: WorkingStep[]; finished: boolean; expanded: boolean; onToggle: () => void; onInspectAction?: (actionId: string) => void }) {
  if (!steps.length) return null;
  const current = steps.find(step => step.state === 'running') ?? steps.at(-1)!;
  return (
    <section className="otis-working" aria-label={finished ? 'Worked' : 'Working'} aria-live="off">
      <button type="button" className="otis-working__disclosure mb-2 flex items-center gap-2 text-xs text-muted-foreground" aria-expanded={expanded} onClick={onToggle}>
        {!finished && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-highlight" />}
        <span className="size-4 text-subtle" aria-hidden="true"><ChevronDownIcon /></span>
        <span>
          {finished ? `Worked · ${steps.length} step${steps.length === 1 ? '' : 's'}` : `${current.label}…`}
        </span>
      </button>
      {expanded && (
        <ol className="otis-working__steps text-xs">
          {steps.map(step => (
            <li key={step.id} className={`otis-working__step otis-working__step--${step.state}`}>
              <span className="otis-working__step-icon">
                {step.state === 'running' ? (
                  <span className="size-2 shrink-0 rounded-full bg-highlight" aria-hidden="true" />
                ) : (
                  <StepIcon label={step.label} state={step.state} />
                )}
              </span>
              <div className="otis-working__description">
                <span>{step.label}</span>
                {step.summary && <span className="text-subtle">{step.summary}</span>}
              </div>
              {step.actionId && step.state === 'succeeded' && onInspectAction && (
                <Button variant="ghost" size="sm" type="button" className="otis-working__inspect" onClick={() => onInspectAction(step.actionId!)}>
                  Inspect / Undo
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
function RunWork({ run, steps, activities, onInspectAction, onReply }: { run?: RunDetailResponse; steps: WorkingStep[]; activities: PublicActivity[]; onInspectAction: (id: string) => void; onReply?: (id: string) => void }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const finished = Boolean(run && ['succeeded', 'partial', 'failed', 'cancelled'].includes(run.status));
  const expanded = manual ?? !finished;
  const thinking = reduceThinking(activities, run?.status);
  // Legacy summaries lack block metadata and keep their existing rendering;
  // block-carrying records render only inside the nested Thinking disclosure.
  const summaries = activities.filter(item => {
    if (item.type !== 'reasoning_summary') return false;
    const payload = item.payload as { block_id?: unknown } | null;
    return !payload || typeof payload.block_id !== 'string' || !payload.block_id;
  });
  return <div className="otis-run">
    {run?.status === 'queued' && <p className="otis-run__status text-sm" role="status">Starting…</p>}
    {run?.status === 'running' && !steps.length && thinking.blocks.length === 0 && (
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-highlight" />
        <span>Working…</span>
      </div>
    )}
    {steps.length === 0 && thinking.blocks.length > 0 && (
      <button type="button" className="otis-working__disclosure mb-2 flex items-center gap-2 text-xs text-muted-foreground" aria-expanded={expanded} onClick={() => setManual(!expanded)}>
        {!finished && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-highlight" />}
        <span className="size-4 text-subtle" aria-hidden="true"><ChevronDownIcon /></span>
        <span>{finished ? 'Worked' : 'Working…'}</span>
      </button>
    )}
    <WorkingDisclosure steps={steps} finished={finished} expanded={expanded} onToggle={() => setManual(!expanded)} onInspectAction={onInspectAction}/>
    {expanded && <ThinkingDisclosure blocks={thinking.blocks} />}
    {expanded && summaries.map(summary => { const payload = summary.payload as { text?: string; provider?: string }; return payload.text ? <details key={summary.id} className="otis-provider-summary text-xs"><summary>{payload.provider ?? 'Provider'} public summary</summary><p>{payload.text}</p></details> : null; })}
    {run?.pending_clarification && (
      <div className="otis-question text-base text-foreground" role="region" aria-label="Awaiting input">
        <p>{run.pending_clarification.question}</p>
        {onReply && (
          <Button variant="ghost" size="sm" type="button" className="otis-question__reply-btn self-start" onClick={() => onReply(run.pending_clarification!.id)}>
            Answer below
          </Button>
        )}
      </div>
    )}
    {run?.status === 'partial' && <p className="otis-run__status otis-run__status--error text-sm" role="status">Some changes were saved. The run could not finish; inspect the completed changes above.</p>}
    {run?.status === 'failed' && <div><p className="otis-run__status otis-run__status--error flex items-start gap-2 text-sm" role="status"><AlertCircleIcon /><span>{failureMessage(run.run.error_code)}</span></p>{run.run.error_code && <details className="otis-provider-summary text-xs"><summary>Error details</summary><p>{run.run.error_code}{run.run.error_message ? `: ${run.run.error_message}` : ''}</p></details>}</div>}
    {run?.status === 'cancelled' && <p className="otis-run__status text-sm">Stopped. Saved changes remain available to inspect or undo.</p>}
  </div>;
}
const dayKey = (iso: string) => dayKeyInZone(iso);
const formatDay = (iso: string) => formatDayLabel(iso);

/** Saved reading anchors per chat scope. Positions, never content. Bounded. */
export interface SavedAnchor { top: number; follow: boolean }
const savedAnchors = new Map<string, SavedAnchor>();
export function readScrollPosition(key: string): SavedAnchor | undefined {
  return savedAnchors.get(key);
}
export function saveScrollPosition(key: string, anchor: SavedAnchor): void {
  savedAnchors.delete(key);
  savedAnchors.set(key, anchor);
  while (savedAnchors.size > 20) {
    const oldest = savedAnchors.keys().next();
    if (oldest.done) break;
    savedAnchors.delete(oldest.value);
  }
}
export function clearScrollPositionsForTests(): void {
  savedAnchors.clear();
}
export interface TranscriptProps {
  messages: ChatMessage[]; members: Record<string, string>; currentUserId: string; run?: RunDetailResponse | null; runs?: Record<string, RunDetailResponse>;
  activities?: PublicActivity[]; steps: WorkingStep[]; pendingUnread?: number; onJumpToLatest?: () => void; onInspectAction: (id: string) => void;
  onReply?: (id: string) => void; onInspectSource?: (id: string) => void; onEditMessage?: (text: string) => void; loading?: boolean; hasOlder?: boolean; loadingOlder?: boolean; onLoadOlder?: () => void;
  /** Local delivery state by client UUID. Saved means durable acceptance, not a reply. */
  delivery?: Record<string, { state: 'sending' | 'saved' | 'failed'; error?: string; durable: boolean }>;
  onRetryMessage?: (clientId: string) => void;
  /** Removes one unsent local entry. Never offered for accepted rows. */
  onDiscardMessage?: (clientId: string) => void;
  /** In-place older-page failure; retry reuses the same cursor. */
  olderError?: string | null;
  /** Explicit send-triggered return to the newest message (not message-driven). */
  followSignal?: number;
  /** Scope key for saved reading position (user/workspace/chat). */
  positionKey?: string;
}
export function Transcript({ messages, members, currentUserId, steps, run, runs = {}, activities = [], pendingUnread = 0, onJumpToLatest, onInspectAction, onReply, onInspectSource, onEditMessage, loading, hasOlder, loadingOlder, onLoadOlder, delivery = {}, onRetryMessage, onDiscardMessage, olderError = null, followSignal = 0, positionKey = '' }: TranscriptProps) {
  // Sole follow/release/Jump owner. Instant adjustments only: no animated
  // token-driven scrolling, so reduced motion is honored by construction.
  // Native overflow-anchor (default) owns prepend/in-place anchoring; no
  // custom scrollHeight compensation runs alongside it.
  const { scrollRef, contentRef, scrollToBottom, isAtBottom } = useStickToBottom({ resize: 'instant', initial: false });
  const followRef = useRef(isAtBottom);
  useEffect(() => {
    followRef.current = isAtBottom;
  }, [isAtBottom]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const allRuns = run?.run?.id ? { ...runs, [run.run.id]: run } : runs;
  const used = new Set<string>();
  const restoredRef = useRef(false);

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(current => (current === id ? null : current)), 2000);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  useLayoutEffect(() => {
    // First paint with content: no saved position opens at the latest;
    // a saved position restores the exact reading anchor and follow mode.
    if (restoredRef.current || messages.length === 0) return;
    restoredRef.current = true;
    const node = (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current;
    const saved = positionKey ? readScrollPosition(positionKey) : undefined;
    if (saved) {
      if (node) node.scrollTop = saved.top;
      if (saved.follow) void scrollToBottom();
    } else {
      void scrollToBottom();
    }
  }, [messages.length, positionKey, scrollRef, scrollToBottom]);

  useEffect(() => {
    const node = (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current;
    return () => {
      // Leaving the chat preserves the reading anchor, not just the bottom.
      if (positionKey && node) saveScrollPosition(positionKey, { top: node.scrollTop, follow: followRef.current });
    };
  }, [positionKey, scrollRef]);

  const followSignalRef = useRef(followSignal);
  useEffect(() => {
    // Explicit send-triggered return to the newly sent message. Message-list
    // changes never drive this on their own.
    if (followSignal !== followSignalRef.current) {
      followSignalRef.current = followSignal;
      void scrollToBottom();
    }
  }, [followSignal, scrollToBottom]);

  const jump = () => { void scrollToBottom(); onJumpToLatest?.(); };
  const busy = Boolean(loading) || Object.values(allRuns).some(item => item.status === 'queued' || item.status === 'running');

  // Completed-only announcements without muting completions: messages that
  // arrived through older-page pagination render with aria-live="off" on
  // their own group, so historical loads never announce as new activity,
  // while the single polite log keeps announcing each newly completed
  // message exactly once. The floor is the minimum sequence at first paint
  // (the newest page); anything below it is history, anything at or above
  // is live conversation, including local echoes and reconciled answers.
  // This replaces timer-based whole-log muting, which swallowed completions
  // that settled while a prepend was in flight.
  const historyFloorRef = useRef<number | null>(null);
  if (historyFloorRef.current === null && messages.length > 0) {
    historyFloorRef.current = messages.reduce((min, message) => Math.min(min, message.sequence), Number.POSITIVE_INFINITY);
  }
  const historyFloor = historyFloorRef.current;
  return <div className="otis-transcript-region">
    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the transcript is the conversation's only scroller; keyboard users need it focusable to scroll and review. */}
    <div className="otis-transcript flex-1 overflow-y-auto" ref={scrollRef} tabIndex={0} role="log" aria-label="Conversation" aria-live="polite" aria-busy={busy}>
      <div ref={contentRef} className={`otis-transcript__inner mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 py-6${!messages.length ? ' otis-transcript__inner--empty' : ''}`}>
        {hasOlder && <Button variant="ghost" size="sm" className="otis-load-older" type="button" disabled={loadingOlder} onClick={() => onLoadOlder?.()}>{olderError ?? (loadingOlder ? 'Loading…' : 'Load earlier messages')}</Button>}
        {loading && !messages.length ? <p className="otis-run__status text-sm">Opening conversation…</p> : !messages.length && !steps.length && <div className="otis-empty"><h2 className="otis-empty__title text-xl">What’s happening?</h2></div>}
        {messages.map((message, index) => {
          const isMember = message.author_kind === 'member'; const author = message.author_user_id ? message.author_display_name ?? members[message.author_user_id] ?? 'Teammate' : 'Otis';
          const runId = message.run_id; const firstAgent = !isMember && runId && !used.has(runId); if (firstAgent && runId) used.add(runId);
          const runActivities = activities.filter(item => item.run_id === runId);
          const runData = runId ? allRuns[runId] : undefined;
          const runSteps = runData ? stepsFromRun(runData, runActivities) : activityToSteps(runActivities, []);
          const noAnswerYet = isMember && runId && !messages.some(item => item.run_id === runId && item.author_kind !== 'member') && messages.filter(item => item.run_id === runId && item.author_kind === 'member').at(-1)?.id === message.id;
          const chunks = runActivities.filter(item => item.type === 'text_chunk').map(item => (item.payload as { text?: string }).text ?? '').join('');
          // A terminal run with no persisted answer keeps its streamed text as
          // an explicitly unfinished draft: never presented as a completed
          // reply beneath the terminal notice.
          const unfinishedRun = Boolean(runData && ['cancelled', 'failed', 'partial'].includes(runData.status));
          const localDelivery = message.client_message_id ? delivery[message.client_message_id] : undefined;
          return <div key={message.client_message_id ?? message.id} className="otis-message-group" aria-live={historyFloor !== null && message.sequence < historyFloor ? 'off' : undefined}>
            {(index > 0 && dayKey(message.created_at) !== dayKey(messages[index - 1]!.created_at)) && <div className="otis-dayseparator text-xs"><span>{formatDay(message.created_at)}</span></div>}
            {firstAgent && <RunWork run={runData} steps={runSteps} activities={runActivities} onInspectAction={onInspectAction} onReply={onReply}/>}
            <article className={`otis-turn group otis-turn--${isMember ? 'member' : 'agent'}`} data-author-kind={message.author_kind}>
              {isMember && message.author_user_id !== currentUserId && <div className="otis-turn__meta text-xs text-subtle">{author}</div>}
              {isMember
                ? <div className="otis-turn__bubble ml-auto w-fit max-w-[85%] rounded-2xl bg-card px-4 py-2 text-base text-card-foreground nav:max-w-[80%]">{message.content_text}</div>
                : <div className="otis-turn__body text-base text-foreground [&>p+p]:mt-3"><Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']}>{message.content_text}</Markdown></div>}
              {!isMember && runData?.sources?.length && onInspectSource ? <div className="otis-sources" aria-label="Sources">{runData.sources.map(source => <Button variant="ghost" size="sm" type="button" key={source.memory_id} className="otis-source-link" onClick={() => onInspectSource(source.memory_id)}>{source.label}{source.provenance === 'inferred' ? ' · inferred' : ''}</Button>)}</div> : null}
              {localDelivery && localDelivery.state !== 'saved' && (
                <div className="otis-delivery">
                  {localDelivery.state === 'sending' && (
                    <span className="text-xs text-subtle" role="status">
                      {localDelivery.durable ? 'Sending…' : 'Sending… Keeping on this device only.'}
                    </span>
                  )}
                  {localDelivery.state === 'failed' && (
                    <>
                      <span className="text-xs text-destructive" role="alert">{localDelivery.error ?? 'Not sent.'}</span>
                      {message.client_message_id && onRetryMessage && (
                        <Button variant="ghost" size="sm" type="button" onClick={() => onRetryMessage(message.client_message_id!)}>
                          Retry
                        </Button>
                      )}
                      {message.client_message_id && onDiscardMessage && (
                        <Button variant="ghost" size="sm" type="button" aria-label="Discard unsent message" onClick={() => onDiscardMessage(message.client_message_id!)}>
                          Discard
                        </Button>
                      )}
                    </>
                  )}
                </div>
              )}
              <div className="otis-turn__actions">
                <time className="text-xs text-subtle tabular-nums" dateTime={message.created_at}>{formatClockTime(message.created_at)}</time>
                <Button variant="ghost" size="icon-xs" type="button" className="otis-msg-action" aria-label={isMember ? 'Copy message' : 'Copy response'} title="Copy" onClick={() => void handleCopy(message.id, message.content_text)}>
                  {copiedId === message.id ? <CheckIcon /> : <CopyIcon />}
                </Button>
                {isMember && message.author_user_id === currentUserId && onEditMessage && (
                  <Button variant="ghost" size="icon-xs" type="button" className="otis-msg-action" aria-label="Use message as draft" title="Use as draft" onClick={() => onEditMessage(message.content_text)}>
                    <PencilIcon />
                  </Button>
                )}
                {!isMember && runData?.actions?.length && onInspectAction ? (
                  <Button variant="ghost" size="sm" type="button" className="otis-msg-action" aria-label="Inspect or undo action" onClick={() => onInspectAction(runData.actions[0]!.action_id)}>
                    <UndoIcon /><span className="text-xs">Undo</span>
                  </Button>
                ) : null}
              </div>
            </article>
            {noAnswerYet && <><RunWork run={runData} steps={runSteps} activities={runActivities} onInspectAction={onInspectAction} onReply={onReply}/>{chunks && (unfinishedRun ? (
              <div className="otis-turn__body otis-streamed text-base text-foreground [&>p+p]:mt-3" aria-live="off">
                <p className="otis-run__status text-xs text-subtle">
                  {runData?.status === 'cancelled'
                    ? 'Partial response — stopped.'
                    : 'Partial response — Otis could not finish.'}
                </p>
                <Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']}>{chunks}</Markdown>
              </div>
            ) : (
              <div className="otis-turn__body otis-streamed text-base text-foreground [&>p+p]:mt-3" aria-live="off"><Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']}>{chunks}</Markdown></div>
            ))}</>}
          </div>;
        })}
        {!messages.length && steps.length > 0 && <RunWork run={run ?? undefined} steps={steps} activities={activities} onInspectAction={onInspectAction}/>}
      </div>
    </div>
    {(messages.length > 0 && (pendingUnread > 0 || !isAtBottom)) && (
      <Button variant="ghost" size="icon" type="button" className="otis-iconbutton otis-jump" aria-label="Jump to latest messages" onClick={jump}>
        <ArrowDownIcon />
        {pendingUnread > 0 && <span className="text-xs tabular-nums">{pendingUnread}</span>}
      </Button>
    )}
  </div>;
}
export function activityToSteps(activities: PublicActivity[], runActions: RunDetailResponse['actions']): WorkingStep[] {
  const steps: WorkingStep[] = [];
  for (const activity of activities) {
    const payload = (activity.payload ?? {}) as { tool_name?: string; status?: WorkingStep['state']; action_id?: string; command_name?: string; summary?: string; step_index?: number };
    if (payload.tool_name === 'turn:agent') continue;
    if (activity.type === 'step_started') steps.push({ id: `${activity.run_id}:${payload.step_index ?? activity.id}`, label: stepLabel(payload.tool_name ?? 'Working'), state: 'running' });
    if (activity.type === 'step_finished') { const last = [...steps].reverse().find(step => step.state === 'running'); if (last) { last.state = payload.status ?? 'succeeded'; } }
    if (activity.type === 'action_applied') { const receipt = runActions.find(action => action.action_id === payload.action_id); steps.push({ id: activity.id, label: stepLabel(payload.command_name ?? 'Saved a change'), state: receipt ? 'succeeded' : 'running', actionId: receipt?.action_id, summary: receipt?.summary ?? null }); }
    if (activity.type === 'action_reverted') { const target = steps.find(step => step.actionId === payload.action_id); if (target) target.state = 'undone'; }
  }
  return steps;
}
export function stepsFromRun(run: RunDetailResponse, activities: PublicActivity[]): WorkingStep[] {
  const tools = run.steps.filter(step => step.tool_name !== 'turn:agent');
  if (!tools.length) return activityToSteps(activities, run.actions);
  return tools.map(step => { const receipt = run.actions.find(action => action.action_id === step.action_id && ['applied', 'already_applied'].includes(action.result_status)); const undone = activities.some(item => item.type === 'action_reverted' && (item.payload as { action_id?: string }).action_id === step.action_id); return { id: String(step.step_index), label: stepLabel(step.tool_name), state: undone ? 'undone' : step.status === 'planned' ? activities.some(item => item.type === 'step_started' && (item.payload as { step_index?: number }).step_index === step.step_index) ? 'running' : 'queued' : step.status, actionId: receipt?.action_id, summary: receipt?.summary ?? null }; });
}
