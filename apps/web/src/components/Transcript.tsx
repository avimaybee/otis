import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import type { ChatMessage, PublicActivity, RunDetailResponse } from '@otis/contracts';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownComponents } from './MarkdownTable.js';
import { toast } from 'sonner';
import { ChevronDownIcon, CheckIcon, AlertCircleIcon, UndoIcon, TerminalIcon, FileTextIcon, SearchDocIcon, CopyIcon, ArrowDownIcon, PencilIcon } from './icons.js';
import { Button } from './ui/button.js';
import { ThinkingDisclosure } from './Thinking.js';
import { VoiceMessagePlayer } from './VoiceMessagePlayer.js';
import { MessageImages } from './MessageImages.js';
import { reduceThinking } from '../api/thinking.js';
import { dayKeyInZone, formatClockTime, formatDayLabel } from '../i18n/format.js';
import { transientTextForRun, type TransientPreview } from '../hooks/useActivityStream.js';

export interface WorkingStep { id: string; label: string; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'undone'; actionId?: string | null; summary?: string | null; }
export const STATES: Record<WorkingStep['state'], string> = { queued: 'Queued', running: 'Working', succeeded: 'Done', failed: 'Failed', skipped: 'Skipped', undone: 'Undone' };
const LABELS: Record<string, string> = { find_entities: 'Finding the business', query: 'Reading saved records', search_memory: 'Searching workspace memory', get_memory: 'Reading the source', upsert_entity: 'Saving the business', create_entity: 'Saving the business', set_fields: 'Updating the record', set_field: 'Updating the record', log_event: 'Saving the note', create_task: 'Saving the follow-up', update_task: 'Updating the follow-up', draft_message: 'Preparing the draft', record_draft: 'Saving the draft', remember_context: 'Saving workspace context', forget_memory: 'Forgetting saved context', undo: 'Reverting the change', update_preference: 'Updating your preference' };
export const stepLabel = (name?: string | null, target?: string | null) => {
  if (!name) return 'Working';
  const cleanTarget = target ? target.trim() : '';
  if (name === 'upsert_entity' || name === 'create_entity') {
    return cleanTarget ? `Saving "${cleanTarget}"` : 'Saving the business';
  }
  if (name === 'find_entities') {
    return cleanTarget ? `Finding "${cleanTarget}"` : 'Finding the business';
  }
  if (name === 'search_memory') {
    return cleanTarget ? `Searching memory for "${cleanTarget}"` : 'Searching workspace memory';
  }
  if (name === 'create_task') {
    return cleanTarget ? `Saving follow-up: "${cleanTarget}"` : 'Saving the follow-up';
  }
  if (name === 'update_task') {
    return cleanTarget ? `Updating follow-up: "${cleanTarget}"` : 'Updating the follow-up';
  }
  if (name === 'set_fields' || name === 'set_field') {
    return cleanTarget ? `Updating record for "${cleanTarget}"` : 'Updating the record';
  }
  if (name === 'forget_memory') {
    const sanitized = cleanTarget.replace(/^(?:forgotten memory entry\s*:?\s*|mem_[a-zA-Z0-9_-]+\s*:?\s*)/i, '').trim();
    return sanitized ? `Removing context: "${sanitized}"` : 'Removing saved context';
  }
  if (name === 'remember_context') {
    return cleanTarget ? `Saving context: "${cleanTarget}"` : 'Saving workspace context';
  }
  if (cleanTarget && LABELS[name]) {
    return `${LABELS[name]}: "${cleanTarget}"`;
  }
  return LABELS[name] ?? name.replace(/_/g, ' ');
};
function failureMessage(code: string | null | undefined) {
  if (code === 'model_unavailable') return 'Choose an available model to continue. Your message is saved.';
  if (code === 'provider_stream_error') return 'The model connection failed. Your message is saved.';
  if (code === 'missing_budgets') return 'Otis has a workspace setup problem. Your message is saved.';
  return 'I couldn’t finish that request. Your message is saved.';
}

/**
 * Receipt-backed failure copy: what the failed run actually committed,
 * from the partial_failure activity payload. Tool names print humanized;
 * at most three unfinished steps ever reach the bubble.
 */
export function formatFailureOutcome(committed: number, unfinished: string[]): string {
  const saved = `Saved ${committed} change${committed === 1 ? '' : 's'}`;
  const names = unfinished
    .filter((step): step is string => typeof step === 'string')
    .slice(0, 3)
    .map((step) => step.replace(/_/g, ' '));
  if (names.length === 0) return saved;
  return `${saved}; couldn't finish ${names.join(', ')}`;
}

function partialOutcome(activities: PublicActivity[], runId?: string): { committed: number; unfinished: string[] } | null {
  const item = activities.find((activity) => activity.type === 'partial_failure' && (!runId || activity.run_id === runId));
  const payload = item?.payload as { committed_actions?: unknown; unfinished_steps?: unknown } | null;
  if (!payload || typeof payload.committed_actions !== 'number' || !Number.isFinite(payload.committed_actions)) return null;
  const unfinished = Array.isArray(payload.unfinished_steps)
    ? payload.unfinished_steps.filter((step): step is string => typeof step === 'string').slice(0, 3)
    : [];
  return { committed: payload.committed_actions, unfinished };
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

export function formatOutcomeSummary(summary?: string | null, totalActions = 1): string {
  if (!summary || !summary.trim()) {
    return `${totalActions} change${totalActions === 1 ? '' : 's'} saved`;
  }
  let clean = summary.trim();
  // Strip raw technical IDs from the normal confirmation: e.g. "mem_01J...",
  // "act_..." or "ent_...". Durable ledger summaries stay intact; only the
  // display drops them, and a dangling "for entity" left behind goes too.
  clean = clean.replace(/\b(mem|act|ent)_[a-zA-Z0-9_-]+/g, '').trim();
  clean = clean.replace(/\(?\b(other_context|client_context|workspace_context|entity_context|unassigned_context)\b\)?/gi, '').trim();
  clean = clean.replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  clean = clean.replace(/\s+for entity\s*['"]?\s*['"]?\s*\.?$/i, '');
  if (!clean || /^[^a-zA-Z0-9]+$/.test(clean)) {
    return `${totalActions} change${totalActions === 1 ? '' : 's'} saved`;
  }
  clean = clean.replace(/\.+$/, '').trim();
  if (clean.toLowerCase().endsWith('saved') || /^(saved|created|updated|removed|recorded|reverted|logged)\b/i.test(clean)) {
    return clean;
  }
  return `${clean} saved`;
}

export function consolidateWorkingSteps(steps: WorkingStep[]): (WorkingStep & { count?: number })[] {
  const result: (WorkingStep & { count?: number })[] = [];
  for (const step of steps) {
    const prev = result[result.length - 1];
    const isReadStep = !step.actionId && (
      step.label.toLowerCase().includes('reading') ||
      step.label.toLowerCase().includes('searching') ||
      step.label.toLowerCase().includes('finding')
    );
    if (
      prev &&
      isReadStep &&
      !prev.actionId &&
      prev.label === step.label &&
      prev.state === step.state &&
      prev.summary === step.summary
    ) {
      prev.count = (prev.count ?? 1) + 1;
    } else {
      result.push({ ...step, count: 1 });
    }
  }
  return result;
}

export function WorkingDisclosure({ steps, finished, expanded, onToggle, onInspectAction, isWaiting, children }: { steps: WorkingStep[]; finished: boolean; expanded: boolean; onToggle: () => void; onInspectAction?: (actionId: string) => void; isWaiting?: boolean; children?: React.ReactNode }) {
  if (!steps.length) return null;
  const current = steps.find(step => step.state === 'running') ?? steps.at(-1)!;
  const displaySteps = consolidateWorkingSteps(steps);
  const active = !finished && !isWaiting;
  const hasRunningStep = displaySteps.some(step => step.state === 'running');
  const showHeaderDot = !finished && (!expanded || !hasRunningStep);
  return (
    <section className="otis-working" aria-label={finished ? 'Worked' : isWaiting ? 'Paused' : 'Working'} aria-live="off">
      <button type="button" className="otis-working__disclosure flex items-center gap-2 text-xs text-muted-foreground" aria-expanded={expanded} onClick={onToggle}>
        {showHeaderDot && (
          <span
            aria-hidden="true"
            className={`size-2 shrink-0 rounded-full ${isWaiting ? 'bg-muted-foreground/60' : 'bg-highlight otis-working__pulse-dot--active'}`}
          />
        )}
        <span className="size-4 text-subtle" aria-hidden="true"><ChevronDownIcon /></span>
        <span className={active ? 'otis-working__label--active' : undefined}>
          {finished
            ? `Worked · ${steps.length} step${steps.length === 1 ? '' : 's'}`
            : isWaiting
            ? 'Paused · Needs your answer'
            : `${current.label}…`}
        </span>
      </button>
      {expanded && (
        <>
          <ol className="otis-working__steps text-xs">
            {displaySteps.map(step => (
              <li key={step.id} className={`otis-working__step otis-working__step--${step.state}`}>
                <span className="otis-working__step-icon">
                  {step.state === 'running' && !isWaiting ? (
                    <span className="size-2 shrink-0 rounded-full bg-highlight otis-working__pulse-dot--active" aria-hidden="true" />
                  ) : (
                    <StepIcon label={step.label} state={step.state} />
                  )}
                </span>
                <div className="otis-working__description">
                  <span>{step.count && step.count > 1 ? `${step.label} (${step.count})` : step.label}</span>
                  {step.summary && !step.label.includes(step.summary) && <span className="text-subtle">{step.summary}</span>}
                </div>
                {step.actionId && step.state === 'succeeded' && onInspectAction && (
                  <Button variant="ghost" size="sm" type="button" className="otis-working__inspect" onClick={() => onInspectAction(step.actionId!)}>
                    Inspect / Undo
                  </Button>
                )}
              </li>
            ))}
          </ol>
          {children}
        </>
      )}
    </section>
  );
}
function RunWork({ run, steps, activities, onInspectAction, onReply, onRetryRun, onRetryQuestions, questionsFailed = false, hasAgentMessage = false }: { run?: RunDetailResponse; steps: WorkingStep[]; activities: PublicActivity[]; onInspectAction: (id: string) => void; onReply?: (id: string) => void; onRetryRun?: (runId: string) => void; onRetryQuestions?: () => void; questionsFailed?: boolean; hasAgentMessage?: boolean }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const finished = Boolean(run && ['succeeded', 'partial', 'failed', 'cancelled'].includes(run.status));
  const isWaiting = Boolean(run && (run.status === 'waiting_for_input' || Boolean(run.pending_clarification)));
  const expanded = manual ?? (!finished && !isWaiting);
  const thinking = reduceThinking(activities, run?.status);
  // Legacy summaries lack block metadata and keep their existing rendering;
  // block-carrying records render only inside the nested Thinking disclosure.
  const summaries = activities.filter(item => {
    if (item.type !== 'reasoning_summary') return false;
    const payload = item.payload as { block_id?: unknown } | null;
    return !payload || typeof payload.block_id !== 'string' || !payload.block_id;
  });
  return <div className="otis-run">
    {!finished && steps.length === 0 && thinking.blocks.length === 0 && (run?.status === 'queued' || run?.status === 'running' || !run) && (
      <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-highlight otis-working__pulse-dot--active" />
        <span className="otis-working__label--active">{run?.status === 'queued' ? 'Thinking…' : 'Working…'}</span>
      </div>
    )}
    {steps.length === 0 && thinking.blocks.length > 0 && (
      <ThinkingDisclosure
        blocks={thinking.blocks}
        active={!finished && !isWaiting}
        finished={finished}
        isWaiting={isWaiting}
      />
    )}
    {steps.length > 0 && (
      <WorkingDisclosure
        steps={steps}
        finished={finished}
        expanded={expanded}
        onToggle={() => setManual(!expanded)}
        onInspectAction={onInspectAction}
        isWaiting={isWaiting}
      >
        {thinking.blocks.length > 0 && <ThinkingDisclosure blocks={thinking.blocks} />}
        {summaries.map(summary => {
          const payload = summary.payload as { text?: string; provider?: string };
          return payload.text ? (
            <details key={summary.id} className="otis-provider-summary text-xs">
              <summary>{payload.provider ?? 'Provider'} public summary</summary>
              <p>{payload.text}</p>
            </details>
          ) : null;
        })}
      </WorkingDisclosure>
    )}
    {run?.pending_clarification && (
      <div className="otis-question text-base text-foreground" role="region" aria-label="Awaiting input">
        {!hasAgentMessage && <p>{run.pending_clarification.question}</p>}
        {hasAgentMessage && (
          <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Needs your answer</span>
          </div>
        )}
        {onReply && (
          <Button variant="ghost" size="sm" type="button" className="otis-question__reply-btn self-start" onClick={() => onReply(run.pending_clarification!.id)}>
            Answer question
          </Button>
        )}
        {questionsFailed && onRetryQuestions && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Couldn&apos;t load the question list.</span>
            <Button variant="ghost" size="sm" type="button" className="self-start" onClick={onRetryQuestions}>
              Retry
            </Button>
          </div>
        )}
      </div>
    )}
    {run?.status === 'waiting_for_input' && !run.pending_clarification && (
      <p className="otis-run__status text-sm text-subtle" role="status">Needs your answer</p>
    )}
    {run?.status === 'partial' && (() => {
      const outcome = partialOutcome(activities, run?.run.id);
      return <div><p className="otis-run__status otis-run__status--error text-sm" role="status">{
        outcome && outcome.committed > 0
          ? `${formatFailureOutcome(outcome.committed, outcome.unfinished)}. Inspect the completed changes above.`
          : 'Some changes were saved. The run could not finish; inspect the completed changes above.'
      }</p>{onRetryRun && <Button variant="outline" size="sm" type="button" onClick={() => onRetryRun(run!.run.id)}>Retry run</Button>}</div>;
    })()}
    {run?.status === 'failed' && (() => {
      const outcome = partialOutcome(activities, run?.run.id);
      return <div><p className="otis-run__status otis-run__status--error flex items-start gap-2 text-sm" role="status"><AlertCircleIcon /><span>{failureMessage(run.run.error_code)}</span></p>{outcome && outcome.committed > 0 && <p className="otis-run__status text-sm" role="status">{formatFailureOutcome(outcome.committed, outcome.unfinished)} before it stopped.</p>}{onRetryRun && <Button variant="outline" size="sm" type="button" onClick={() => onRetryRun(run!.run.id)}>Retry run</Button>}{run.run.error_code && <details className="otis-provider-summary text-xs"><summary>Error details</summary><p>{run.run.error_code}{run.run.error_message ? `: ${run.run.error_message}` : ''}</p></details>}</div>;
    })()}
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

/**
 * F12 grouping: one pass over activities builds the per-run lists, so the
 * message map below does lookups instead of scanning every activity for
 * every message. Order within each run is preserved.
 */
export function groupActivitiesByRun(activities: PublicActivity[]): Map<string, PublicActivity[]> {
  const byRun = new Map<string, PublicActivity[]>();
  for (const activity of activities) {
    const list = byRun.get(activity.run_id);
    if (list) list.push(activity);
    else byRun.set(activity.run_id, [activity]);
  }
  return byRun;
}

/** Joins one run's durable text chunks; non-string payloads contribute nothing. */
export function joinRunTextChunks(runActivities: PublicActivity[]): string {
  const roundChunks = new Map<number, string>();
  let unrounded = '';
  let hasRounds = false;

  for (const item of runActivities) {
    if (item.type !== 'text_chunk') continue;
    const payload = item.payload as { text?: unknown; round_index?: unknown } | null;
    let chunk = '';
    let roundIndex: unknown = undefined;

    if (typeof payload?.text === 'string') {
      chunk = payload.text;
      roundIndex = payload.round_index;
    } else if (payload?.text && typeof payload.text === 'object') {
      const nested = payload.text as { text?: unknown; round_index?: unknown };
      if (typeof nested.text === 'string') {
        chunk = nested.text;
        roundIndex = nested.round_index ?? payload.round_index;
      }
    } else if (typeof item.payload === 'string') {
      chunk = item.payload;
    }

    if (!chunk) continue;

    if (typeof roundIndex === 'number') {
      hasRounds = true;
      const prev = roundChunks.get(roundIndex) ?? '';
      roundChunks.set(roundIndex, prev + chunk);
    } else {
      unrounded += chunk;
    }
  }

  if (!hasRounds) {
    return unrounded;
  }

  const sortedRounds = Array.from(roundChunks.keys()).sort((a, b) => a - b);
  const sections = sortedRounds.map((r) => roundChunks.get(r)!.trim()).filter(Boolean);
  if (unrounded.trim()) {
    sections.unshift(unrounded.trim());
  }
  return sections.join('\n\n');
}

export interface RunAnswerState {
  hasAgentAnswer: boolean;
  lastMemberMessageId: string | null;
  firstAgentMessageId: string | null;
}

/**
 * One pass over messages records, per run, whether an agent answer exists,
 * the latest member message, and the first agent message — replacing the
 * per-message list scans previously done inside the render map.
 */
export function describeRunAnswers(messages: ChatMessage[]): Map<string, RunAnswerState> {
  const byRun = new Map<string, RunAnswerState>();
  for (const message of messages) {
    if (!message.run_id) continue;
    let state = byRun.get(message.run_id);
    if (!state) {
      state = { hasAgentAnswer: false, lastMemberMessageId: null, firstAgentMessageId: null };
      byRun.set(message.run_id, state);
    }
    if (message.author_kind === 'member') {
      state.lastMemberMessageId = message.id;
    } else {
      if (state.firstAgentMessageId === null) state.firstAgentMessageId = message.id;
      state.hasAgentAnswer = true;
    }
  }
  return byRun;
}

/**
 * Message content renders through Markdown once per message object.
 * Transient preview ticks re-render the parent, but historical bodies keep
 * their output while their message reference is unchanged.
 */
const MessageBody = memo(function MessageBody({ message }: { message: ChatMessage }) {
  if (message.author_kind === 'member') {
    return (
      <div className="otis-turn__bubble ml-auto w-fit max-w-[85%] rounded-2xl bg-card px-4 py-2 text-base text-card-foreground nav:max-w-[80%] whitespace-pre-wrap break-words">
        {(message.image_media_ids?.length ?? 0) > 0 && (
          <MessageImages workspaceId={message.workspace_id} mediaIds={message.image_media_ids ?? []} />
        )}
        {message.media_id ? (
          <VoiceMessagePlayer
            workspaceId={message.workspace_id}
            mediaId={message.media_id}
            text={message.content_text}
          />
        ) : (
          message.content_text
        )}
      </div>
    );
  }
  return <div className="otis-turn__body text-base text-foreground"><Markdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml disallowedElements={['img']}>{message.content_text}</Markdown></div>;
});
export interface TranscriptProps {
  messages: ChatMessage[]; members: Record<string, string>; currentUserId: string; run?: RunDetailResponse | null; runs?: Record<string, RunDetailResponse>;
  activities?: PublicActivity[]; steps: WorkingStep[]; pendingUnread?: number; onJumpToLatest?: () => void; onInspectAction: (id: string) => void;
  onReply?: (id: string) => void; onInspectSource?: (id: string) => void; onEditMessage?: (text: string) => void; loading?: boolean; hasOlder?: boolean; loadingOlder?: boolean; onLoadOlder?: () => void;
  /** Live transient preview text by run/round. Rendered only while no durable answer exists. */
  transients?: TransientPreview;
  /** Local delivery state by client UUID. Saved means durable acceptance, not a reply. */
  delivery?: Record<string, { state: 'sending' | 'saved' | 'failed'; error?: string; durable: boolean }>;
  onRetryMessage?: (clientId: string) => void;
  /** Retries a terminal failed/partial run through the server owner. Offered only on failed/partial run blocks. */
  onRetryRun?: (runId: string) => void;
  /** The question-list read failed while run details survived: the empty list is an outage. */
  questionsFailed?: boolean;
  /** Re-reads the question list. Offered beside a run-known pending question while the list is failed. */
  onRetryQuestions?: () => void;
  /** Removes one unsent local entry. Never offered for accepted rows. */
  onDiscardMessage?: (clientId: string) => void;
  /** In-place older-page failure; retry reuses the same cursor. */
  olderError?: string | null;
  /** Explicit send-triggered return to the newest message (not message-driven). */
  followSignal?: number;
  /** Scope key for saved reading position (user/workspace/chat). */
  positionKey?: string;
}
export function Transcript({ messages, members, currentUserId, steps, run, runs = {}, activities = [], transients = {}, pendingUnread = 0, onJumpToLatest, onInspectAction, onReply, onRetryRun, onRetryQuestions, questionsFailed = false, onInspectSource, onEditMessage, loading, hasOlder, loadingOlder, onLoadOlder, delivery = {}, onRetryMessage, onDiscardMessage, olderError = null, followSignal = 0, positionKey = '' }: TranscriptProps) {
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
  // F12: grouped once per input change; the message map below only looks up.
  const activitiesByRun = useMemo(() => groupActivitiesByRun(activities), [activities]);
  const runTextByRun = useMemo(() => {
    const joined = new Map<string, string>();
    for (const [runId, runActivities] of activitiesByRun) joined.set(runId, joinRunTextChunks(runActivities));
    return joined;
  }, [activitiesByRun]);
  const answerStateByRun = useMemo(() => describeRunAnswers(messages), [messages]);
  const stepsByRun = useMemo(() => {
    const merged: Record<string, RunDetailResponse | undefined> = { ...runs };
    if (run?.run?.id) merged[run.run.id] = run;
    const computed = new Map<string, WorkingStep[]>();
    for (const [runId, runActivities] of activitiesByRun) {
      const runData = merged[runId];
      computed.set(runId, runData ? stepsFromRun(runData, runActivities) : activityToSteps(runActivities, []));
    }
    for (const message of messages) {
      if (message.run_id && !computed.has(message.run_id)) {
        const runData = merged[message.run_id];
        computed.set(message.run_id, runData ? stepsFromRun(runData, []) : []);
      }
    }
    return computed;
  }, [activitiesByRun, messages, run, runs]);
  const restoredRef = useRef(false);

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      toast('Copied to clipboard');
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
      <div ref={contentRef} className={`otis-transcript__inner mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-4${!messages.length ? ' otis-transcript__inner--empty' : ''}`}>
        {hasOlder && <Button variant="ghost" size="sm" className="otis-load-older" type="button" disabled={loadingOlder} onClick={() => onLoadOlder?.()}>{olderError ?? (loadingOlder ? 'Loading…' : 'Load earlier messages')}</Button>}
        {loading && !messages.length ? <p className="otis-run__status text-sm">Opening conversation…</p> : !messages.length && !steps.length && <div className="otis-empty"><h2 className="otis-empty__title text-xl">What’s happening?</h2><p className="otis-empty__subtitle text-sm text-subtle mt-1">Keep track of visits, promises, and follow-ups.</p></div>}
        {messages.map((message, index) => {
          const isMember = message.author_kind === 'member'; const author = message.author_user_id ? message.author_display_name ?? members[message.author_user_id] ?? 'Teammate' : 'Otis';
          const runId = message.run_id;
          const answerState = runId ? answerStateByRun.get(runId) : undefined;
          const firstAgent = !isMember && !!runId && answerState?.firstAgentMessageId === message.id;
          const runActivities = runId ? activitiesByRun.get(runId) ?? [] : [];
          const runData = runId ? allRuns[runId] : undefined;
          const runSteps = runId ? stepsByRun.get(runId) ?? [] : [];
          const noAnswerYet = Boolean(isMember && runId && answerState && !answerState.hasAgentAnswer && answerState.lastMemberMessageId === message.id);
          const chunks = runId ? runTextByRun.get(runId) ?? '' : '';
          // A terminal run with no persisted answer keeps its streamed text as
          // an explicitly unfinished draft: never presented as a completed
          // reply beneath the terminal notice.
          const unfinishedRun = Boolean(runData && ['cancelled', 'failed', 'partial'].includes(runData.status));
          const localDelivery = message.client_message_id ? delivery[message.client_message_id] : undefined;
          return <div key={message.client_message_id ?? message.id} className="otis-message-group" aria-live={historyFloor !== null && message.sequence < historyFloor ? 'off' : undefined}>
            {(index > 0 && dayKey(message.created_at) !== dayKey(messages[index - 1]!.created_at)) && <div className="otis-dayseparator text-xs"><span>{formatDay(message.created_at)}</span></div>}
            {firstAgent && <RunWork run={runData} steps={runSteps} activities={runActivities} onInspectAction={onInspectAction} onReply={onReply} onRetryRun={onRetryRun} onRetryQuestions={onRetryQuestions} questionsFailed={questionsFailed} hasAgentMessage={Boolean(message.content_text?.trim())}/>}
            <article className={`otis-turn group otis-turn--${isMember ? 'member' : 'agent'}`} data-author-kind={message.author_kind}>
              {isMember && message.author_user_id !== currentUserId && <div className="otis-turn__meta text-xs text-subtle">{author}</div>}
              <MessageBody message={message} />
              {!isMember && runData?.actions?.length ? (
                <div className="otis-outcome mt-2 flex items-center gap-2 text-xs text-subtle" role="status">
                  <CheckIcon />
                  <span>{formatOutcomeSummary(runData.actions[0]?.summary, runData.actions.length)}</span>
                  {onInspectAction && (
                    <Button variant="ghost" size="sm" type="button" className="otis-outcome__link h-auto p-0 text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => onInspectAction(runData.actions[0]!.action_id)}>
                      View changes
                    </Button>
                  )}
                </div>
              ) : null}
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
                {!isMember && runData?.sources?.length && onInspectSource ? (
                  <div className="otis-sources flex items-center gap-1" aria-label="Sources">
                    {runData.sources.map(source => (
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        key={source.memory_id}
                        className="otis-source-link otis-msg-action h-6 px-2 text-xs text-subtle hover:text-foreground"
                        onClick={() => onInspectSource(source.memory_id)}
                        title={`View source: ${source.label}`}
                      >
                        <span>{source.label}{source.provenance === 'inferred' ? ' · inferred' : ''}</span>
                      </Button>
                    ))}
                  </div>
                ) : null}
                {message.content_text && (
                  <Button variant="ghost" size="icon-xs" type="button" className="otis-msg-action text-muted-foreground hover:text-foreground" aria-label={isMember ? 'Copy message' : 'Copy response'} title="Copy" onClick={() => void handleCopy(message.id, message.content_text)}>
                    {copiedId === message.id ? <CheckIcon /> : <CopyIcon />}
                  </Button>
                )}
                {isMember && message.author_user_id === currentUserId && onEditMessage && !message.media_id && (
                  <Button variant="ghost" size="icon-xs" type="button" className="otis-msg-action text-muted-foreground hover:text-foreground" aria-label="Use message as draft" title="Use as draft" onClick={() => onEditMessage(message.content_text)}>
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
            {noAnswerYet && <><RunWork run={runData} steps={runSteps} activities={runActivities} onInspectAction={onInspectAction} onReply={onReply} onRetryRun={onRetryRun} onRetryQuestions={onRetryQuestions} questionsFailed={questionsFailed} hasAgentMessage={false}/>{(() => {
              // Durable chunks plus live transient preview for rounds not yet
              // persisted. Transient frames carry each round's full text, so
              // joining is order-safe; durable coverage drops preview rounds.
              const transientText = runId ? transientTextForRun(transients, runId) : '';
              const streamText = chunks && transientText
                ? (chunks.endsWith('\n') ? `${chunks.trimEnd()}\n\n${transientText.trimStart()}` : `${chunks}\n\n${transientText.trimStart()}`)
                : (chunks || transientText);
              return streamText && (unfinishedRun ? (
              <div className="otis-turn__body otis-streamed text-base text-foreground [&>p+p]:mt-3" aria-live="off">
                <p className="otis-run__status text-xs text-subtle">
                  {runData?.status === 'cancelled'
                    ? 'Partial response — stopped.'
                    : 'Partial response — Otis could not finish.'}
                </p>
                <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml disallowedElements={['img']}>{streamText}</Markdown>
              </div>
            ) : (
              <div className="otis-turn__body otis-streamed text-base text-foreground" aria-live="off"><Markdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml disallowedElements={['img']}>{streamText}</Markdown></div>
            ));})()}</>}
          </div>;
        })}
        {!messages.length && steps.length > 0 && <RunWork run={run ?? undefined} steps={steps} activities={activities} onInspectAction={onInspectAction} onRetryRun={onRetryRun} onRetryQuestions={onRetryQuestions} questionsFailed={questionsFailed} hasAgentMessage={false}/>}
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
    const payload = (activity.payload ?? {}) as {
      tool_name?: string;
      status?: WorkingStep['state'];
      action_id?: string;
      command_name?: string;
      summary?: string;
      step_index?: number;
      target?: string;
    };
    if (payload.tool_name === 'turn:agent' || payload.tool_name === 'checkpoint' || payload.tool_name?.startsWith('turn:')) continue;
    if (activity.type === 'step_started') {
      steps.push({
        id: `${activity.run_id}:${payload.step_index ?? activity.id}`,
        label: stepLabel(payload.tool_name ?? 'Working', payload.target),
        state: 'running',
        summary: payload.target ?? null,
      });
    }
    if (activity.type === 'step_finished') {
      const last = [...steps].reverse().find(step => step.state === 'running');
      if (last) {
        last.state = payload.status ?? 'succeeded';
        if (payload.target && !last.summary) last.summary = payload.target;
      }
    }
    if (activity.type === 'action_applied') {
      const receipt = runActions.find(action => action.action_id === payload.action_id);
      const label = stepLabel(payload.command_name ?? 'Saved a change', receipt?.summary);
      const summary = receipt?.summary && label.includes(receipt.summary) ? null : (receipt?.summary ?? null);
      const existing = [...steps].reverse().find(step => !step.actionId || step.actionId === payload.action_id);
      if (existing) {
        existing.actionId = receipt?.action_id;
        existing.state = receipt ? 'succeeded' : 'running';
        if (receipt?.summary) {
          existing.label = label;
          existing.summary = summary;
        }
      } else {
        steps.push({
          id: activity.id,
          label,
          state: receipt ? 'succeeded' : 'running',
          actionId: receipt?.action_id,
          summary,
        });
      }
    }
    if (activity.type === 'action_reverted') {
      const target = steps.find(step => step.actionId === payload.action_id);
      if (target) target.state = 'undone';
    }
  }
  return steps;
}
export function stepsFromRun(run: RunDetailResponse, activities: PublicActivity[]): WorkingStep[] {
  const tools = run.steps.filter(step => step.tool_name !== 'turn:agent' && step.tool_name !== 'checkpoint' && !step.tool_name?.startsWith('turn:'));
  if (!tools.length) return activityToSteps(activities, run.actions);
  return tools.map(step => {
    const receipt = run.actions.find(action => action.action_id === step.action_id && ['applied', 'already_applied'].includes(action.result_status));
    const undone = activities.some(item => item.type === 'action_reverted' && (item.payload as { action_id?: string }).action_id === step.action_id);
    const label = stepLabel(step.tool_name, receipt?.summary);
    const summary = receipt?.summary && label.includes(receipt.summary) ? null : (receipt?.summary ?? null);
    return {
      id: String(step.step_index),
      label,
      state: undone ? 'undone' : step.status === 'planned' ? (activities.some(item => item.type === 'step_started' && (item.payload as { step_index?: number }).step_index === step.step_index) ? 'running' : 'queued') : step.status,
      actionId: receipt?.action_id,
      summary,
    };
  });
}
