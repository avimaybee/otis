import { useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage, PublicActivity, RunDetailResponse } from '@otis/contracts';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import { ChevronDownIcon, CheckIcon, AlertCircleIcon, UndoIcon, TerminalIcon, FileTextIcon, SearchDocIcon, QuestionIcon, CopyIcon, ArrowDownIcon, PencilIcon } from './icons.js';

export interface WorkingStep { id: string; label: string; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'undone'; actionId?: string | null; summary?: string | null; }
export const STATES: Record<WorkingStep['state'], string> = { queued: 'Queued', running: 'Working', succeeded: 'Done', failed: 'Failed', skipped: 'Skipped', undone: 'Undone' };
const LABELS: Record<string, string> = { find_entities: 'Finding the business', query: 'Reading saved records', search_memory: 'Searching workspace memory', get_memory: 'Reading the source', upsert_entity: 'Saving the business', create_entity: 'Saving the business', set_fields: 'Updating the record', set_field: 'Updating the record', log_event: 'Saving the note', create_task: 'Saving the follow-up', update_task: 'Updating the follow-up', draft_message: 'Preparing the draft', record_draft: 'Saving the draft', remember_context: 'Saving workspace context', forget_memory: 'Forgetting saved context', undo: 'Reverting the change', update_preference: 'Updating your preference' };
export const stepLabel = (name: string) => LABELS[name] ?? name.replace(/_/g, ' ');
function failureMessage(code: string | null | undefined) {
  if (code === 'model_unavailable') return 'Choose an available model to continue. Your message is saved.';
  if (code === 'provider_stream_error') return 'The model connection failed. Your message is saved.';
  if (code === 'missing_budgets') return 'Otis has a workspace setup problem. Your message is saved.';
  return 'I couldn’t finish that request. Your message is saved.';
}

function StepIcon({ label, state }: { label: string; state: WorkingStep['state'] }) {
  if (state === 'failed') return <AlertCircleIcon />;
  if (state === 'undone') return <UndoIcon size={13} />;
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
    <section className={`otis-working${!finished ? ' otis-working--running' : ''}`} aria-label={finished ? 'Worked' : 'Working'}>
      <button type="button" className="otis-working__disclosure" aria-expanded={expanded} onClick={onToggle}>
        <ChevronDownIcon size={14}/>
        <span className="otis-working__label">
          {finished ? `Worked · ${steps.length} step${steps.length === 1 ? '' : 's'}` : `${current.label}…`}
        </span>
      </button>
      {expanded && (
        <ol className="otis-working__steps">
          {steps.map(step => (
            <li key={step.id} className={`otis-working__step otis-working__step--${step.state}`}>
              <span className="otis-working__step-icon">
                {step.state === 'running' ? (
                  <span className="otis-working__pulse-dot" />
                ) : (
                  <StepIcon label={step.label} state={step.state} />
                )}
              </span>
              <div className="otis-working__description">
                <span className="otis-working__step-title">{step.label}</span>
                {step.summary && <span className="otis-detail__label">{step.summary}</span>}
              </div>
              {step.actionId && step.state === 'succeeded' && onInspectAction && (
                <button type="button" className="otis-textbutton otis-working__inspect" onClick={() => onInspectAction(step.actionId!)}>
                  Inspect / Undo
                </button>
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
  const summaries = activities.filter(item => item.type === 'reasoning_summary');
  return <div className="otis-run">
    {run?.status === 'queued' && <p className="otis-run__status" role="status">Starting…</p>}
    {run?.status === 'running' && !steps.length && (
      <div className="otis-working otis-working--running">
        <div className="otis-working__disclosure">
          <span className="otis-working__pulse-dot" />
          <span className="otis-working__label" role="status">Working…</span>
        </div>
      </div>
    )}
    <WorkingDisclosure steps={steps} finished={finished} expanded={expanded} onToggle={() => setManual(!expanded)} onInspectAction={onInspectAction}/>
    {expanded && summaries.map(summary => { const payload = summary.payload as { text?: string; provider?: string }; return payload.text ? <details key={summary.id} className="otis-provider-summary"><summary>{payload.provider ?? 'Provider'} public summary</summary><p>{payload.text}</p></details> : null; })}
    {run?.pending_clarification && (
      <div className="otis-question" role="region" aria-label="Awaiting input">
        <div className="otis-question__header">
          <span className="otis-question__badge">
            <QuestionIcon />
            Awaiting input
          </span>
          <span className="otis-question__tag">Question</span>
        </div>
        <p className="otis-question__text">{run.pending_clarification.question}</p>
        {onReply && (
          <button type="button" className="otis-textbutton otis-question__reply-btn" onClick={() => onReply(run.pending_clarification!.id)}>
            Answer below
          </button>
        )}
      </div>
    )}
    {run?.status === 'partial' && <p className="otis-run__status otis-run__status--error">Some changes were saved. The run could not finish; inspect the completed changes above.</p>}
    {run?.status === 'failed' && <div><p className="otis-run__status otis-run__status--error" role="status">{failureMessage(run.run.error_code)}</p>{run.run.error_code && <details className="otis-provider-summary"><summary>Error details</summary><p>{run.run.error_code}{run.run.error_message ? `: ${run.run.error_message}` : ''}</p></details>}</div>}
    {run?.status === 'cancelled' && <p className="otis-run__status">Stopped. Saved changes remain available to inspect or undo.</p>}
  </div>;
}
const dayKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA');
const formatDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
export interface TranscriptProps {
  messages: ChatMessage[]; members: Record<string, string>; currentUserId: string; run?: RunDetailResponse | null; runs?: Record<string, RunDetailResponse>;
  activities?: PublicActivity[]; steps: WorkingStep[]; pendingUnread?: number; onJumpToLatest?: () => void; onInspectAction: (id: string) => void;
  onReply?: (id: string) => void; onInspectSource?: (id: string) => void; onEditMessage?: (text: string) => void; loading?: boolean; hasOlder?: boolean; loadingOlder?: boolean; onLoadOlder?: () => void;
}
export function Transcript({ messages, members, currentUserId, steps, run, runs = {}, activities = [], pendingUnread = 0, onJumpToLatest, onInspectAction, onReply, onInspectSource, onEditMessage, loading, hasOlder, loadingOlder, onLoadOlder }: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true); const initial = useRef(true); const anchor = useRef<{ height: number; top: number } | null>(null);
  const [away, setAway] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const allRuns = run?.run?.id ? { ...runs, [run.run.id]: run } : runs;
  const used = new Set<string>();

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
    const node = scrollRef.current; if (!node) return;
    if (anchor.current && !loadingOlder) { node.scrollTop = anchor.current.top + node.scrollHeight - anchor.current.height; anchor.current = null; }
    else if (initial.current || follow.current) { node.scrollTop = node.scrollHeight; }
    if (messages.length) initial.current = false;
  }, [messages, activities, steps, loadingOlder]);
  const jump = () => { const node = scrollRef.current; if (node) node.scrollTop = node.scrollHeight; follow.current = true; setAway(false); onJumpToLatest?.(); };
  return <div className="otis-transcript-region">
    <div className="otis-transcript" ref={scrollRef} tabIndex={0} role="log" aria-label="Conversation" aria-live="off" aria-busy={loading} onScroll={() => { const node = scrollRef.current!; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; setAway(!follow.current); }}>
      <div className={`otis-transcript__inner${!messages.length ? ' otis-transcript__inner--empty' : ''}`}>
        {hasOlder && <button className="otis-textbutton otis-load-older" type="button" disabled={loadingOlder} onClick={() => { const node = scrollRef.current!; anchor.current = { height: node.scrollHeight, top: node.scrollTop }; onLoadOlder?.(); }}>{loadingOlder ? 'Loading…' : 'Load earlier messages'}</button>}
        {loading && !messages.length ? <p className="otis-run__status">Opening conversation…</p> : !messages.length && !steps.length && <div className="otis-empty"><h2 className="otis-empty__title">What’s happening?</h2></div>}
        {messages.map((message, index) => {
          const isMember = message.author_kind === 'member'; const author = message.author_user_id ? message.author_display_name ?? members[message.author_user_id] ?? 'Teammate' : 'Otis';
          const runId = message.run_id; const firstAgent = !isMember && runId && !used.has(runId); if (firstAgent && runId) used.add(runId);
          const runActivities = activities.filter(item => item.run_id === runId);
          const runData = runId ? allRuns[runId] : undefined;
          const runSteps = runData ? stepsFromRun(runData, runActivities) : activityToSteps(runActivities, []);
          const noAnswerYet = isMember && runId && !messages.some(item => item.run_id === runId && item.author_kind !== 'member') && messages.filter(item => item.run_id === runId && item.author_kind === 'member').at(-1)?.id === message.id;
          const chunks = runActivities.filter(item => item.type === 'text_chunk').map(item => (item.payload as { text?: string }).text ?? '').join('');
          return <div key={message.id} className="otis-message-group">
            {(index > 0 && dayKey(message.created_at) !== dayKey(messages[index - 1]!.created_at)) && <div className="otis-dayseparator">{formatDay(message.created_at)}</div>}
            {firstAgent && <RunWork run={runData} steps={runSteps} activities={runActivities} onInspectAction={onInspectAction} onReply={onReply}/>}
            <article className={`otis-turn otis-turn--${isMember ? 'member' : 'agent'}`} data-author-kind={message.author_kind}>
              {isMember && message.author_user_id !== currentUserId && <div className="otis-turn__meta">{author}</div>}
              <div className={isMember ? 'otis-turn__bubble' : 'otis-turn__body'}>{isMember ? message.content_text : <Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']}>{message.content_text}</Markdown>}</div>
              {!isMember && runData?.sources?.length && onInspectSource ? <div className="otis-sources" aria-label="Sources">{runData.sources.map(source => <button className="otis-source-link" type="button" key={source.memory_id} onClick={() => onInspectSource(source.memory_id)}>{source.label}{source.provenance === 'inferred' ? ' · inferred' : ''}</button>)}</div> : null}
              <div className="otis-turn__actions">
                <time className="otis-turn__time" dateTime={message.created_at}>{new Date(message.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>
                <button type="button" className="otis-msg-action" aria-label={isMember ? 'Copy message' : 'Copy response'} title="Copy" onClick={() => void handleCopy(message.id, message.content_text)}>
                  {copiedId === message.id ? <CheckIcon /> : <CopyIcon />}
                </button>
                {isMember && message.author_user_id === currentUserId && onEditMessage && (
                  <button type="button" className="otis-msg-action" aria-label="Use message as draft" title="Use as draft" onClick={() => onEditMessage(message.content_text)}>
                    <PencilIcon />
                  </button>
                )}
                {!isMember && runData?.actions?.length && onInspectAction ? (
                  <button type="button" className="otis-msg-action otis-msg-action--pill" aria-label="Inspect or undo action" onClick={() => onInspectAction(runData.actions[0]!.action_id)}>
                    <UndoIcon size={12}/><span>Undo</span>
                  </button>
                ) : null}
              </div>
            </article>
            {noAnswerYet && <><RunWork run={runData} steps={runSteps} activities={runActivities} onInspectAction={onInspectAction} onReply={onReply}/>{chunks && <div className="otis-turn__body otis-streamed"><Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={['img']}>{chunks}</Markdown></div>}</>}
          </div>;
        })}
        {!messages.length && steps.length > 0 && <RunWork run={run ?? undefined} steps={steps} activities={activities} onInspectAction={onInspectAction}/>}
      </div>
    </div>
    {(away || pendingUnread > 0) && (
      <button type="button" className="otis-jump" aria-label="Jump to latest messages" onClick={jump}>
        <ArrowDownIcon size={16}/>
        {pendingUnread > 0 && <span className="otis-jump__badge">{pendingUnread}</span>}
      </button>
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
