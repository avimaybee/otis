import { useCallback, useEffect, useRef, useState } from 'react';
import { Toaster, toast } from 'sonner';
import Markdown from 'react-markdown';
import type { Chat, ChatMessage, ChatDetailResponse, CommandDescriptor, ModelOption, PublicActivity, RunDetailResponse, ClarificationSummary } from '@otis/contracts';
import { api, ApiError } from './api/client.js';
import { debugLog, failureLog } from './api/log.js';
import { mergeActivity, subscribeToActivity, type StreamStatus } from './hooks/useActivityStream.js';
import { useMediaQuery } from './hooks/useMediaQuery.js';
import { Composer } from './components/Composer.js';
import { DetailPane } from './components/DetailPane.js';
import { HistoryNav } from './components/HistoryNav.js';
import { SourcePane } from './components/SourcePane.js';
import { SettingsPane } from './components/SettingsPane.js';
import { Transcript } from './components/Transcript.js';
import { ComposeIcon, MenuIcon } from './components/icons.js';
import { Overlay } from './components/Overlay.js';

export interface ConversationScreenProps { workspaceId: string; workspaces: { id: string; name: string }[]; userId: string; members: Record<string, string>; onSignOut: () => void; }
type View = { workspaceId: string; chatId: string; detail: ChatDetailResponse; messages: ChatMessage[]; activities: PublicActivity[]; runs: Record<string, RunDetailResponse>; older: number | null; questions: ClarificationSummary[]; cursor: number };
function route(fallback: string, workspaces: { id: string }[]) { const params = new URLSearchParams(location.search); const requested = params.get('workspace'); return { workspace: workspaces.some(item => item.id === requested) ? requested! : fallback, chat: params.get('chat') === 'new' ? null : params.get('chat') }; }
function safeError(error: unknown, fallback: string) { if (error instanceof ApiError && error.status === 401) return 'Your session has expired. Sign in again.'; if (error instanceof ApiError && error.status === 404) return 'This conversation is unavailable or your access has changed.'; return fallback; }
function mergeMessages(previous: ChatMessage[], next: ChatMessage[]) { return [...new Map([...previous, ...next].map(message => [message.id, message])).values()].sort((a, b) => a.sequence - b.sequence); }

export function ConversationScreen({ workspaceId: initialWorkspace, workspaces, userId, members, onSignOut }: ConversationScreenProps) {
  const [selection, setSelection] = useState(() => route(initialWorkspace, workspaces));
  const { workspace: workspaceId, chat: activeChatId } = selection;
  const [ownChats, setOwnChats] = useState<Chat[]>([]); const [teamChats, setTeamChats] = useState<Chat[]>([]);
  const [navCursors, setNavCursors] = useState<{ mine?: string; team?: string }>({});
  const [view, setView] = useState<View | null>(null); const [commands, setCommands] = useState<CommandDescriptor[]>([]); const [models, setModels] = useState<ModelOption[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false); const [settingsOpen, setSettingsOpen] = useState(false); const [detailActionId, setDetailActionId] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('idle'); const [error, setError] = useState<string | null>(null); const [accessLost, setAccessLost] = useState(false);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const [loading, setLoading] = useState(false); const [loadingOlder, setLoadingOlder] = useState(false); const [navLoading, setNavLoading] = useState(true); const [replyId, setReplyId] = useState<string | null>(null);
  const [dismissedClarificationId, setDismissedClarificationId] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState<string | null>(null);
  const [controlPending, setControlPending] = useState(false);
  const [controlResult, setControlResult] = useState<string | null>(null);
  const [modelRevision, setModelRevision] = useState(0);
  const [followsDefault, setFollowsDefault] = useState(true);
  const modelRequest = useRef(0);
  const controlLock = useRef(false);
  const controlOperation = useRef<{ text: string; id: string; chatId: string } | null>(null);
  const preparedChat = useRef<{ workspaceId: string; promise: Promise<Chat> } | null>(null);
  const epoch = useRef(0); const selected = useRef(selection); selected.current = selection;
  const sendOperation = useRef<{ text: string; id: string; chatId: string | null; clarificationId?: string } | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const desktop = useMediaQuery('(min-width: 900px)');
  const navigate = useCallback((workspace: string, chat: string | null, replace = false) => {
    sendOperation.current = null; preparedChat.current = null; controlOperation.current = null; setControlResult(null); epoch.current++; selected.current = { workspace, chat }; setSelection({ workspace, chat }); setDrawerOpen(false); setSettingsOpen(false); setDetailActionId(null); setSourceId(null); setReplyId(null); setDismissedClarificationId(null); setDraftValue(null); setError(null); setAccessLost(false); setView(null); setModels([]);
    const url = new URL(location.href); url.searchParams.set('workspace', workspace); url.searchParams.set('chat', chat ?? 'new');
    history[replace ? 'replaceState' : 'pushState']({}, '', url);
    try { sessionStorage.setItem(`otis:view:${userId}:${workspace}`, chat ?? 'new'); } catch { /* URL remains authoritative */ }
  }, [userId]);
  useEffect(() => { const back = () => { epoch.current++; sendOperation.current = null; const next = route(initialWorkspace, workspaces); selected.current = next; setSelection(next); setView(null); setAccessLost(false); setReplyId(null); setDismissedClarificationId(null); setDraftValue(null); setDetailActionId(null); setSourceId(null); setDrawerOpen(false); setSettingsOpen(false); }; window.addEventListener('popstate', back); return () => window.removeEventListener('popstate', back); }, [initialWorkspace, workspaces]);
  useEffect(() => { if (desktop) setDrawerOpen(false); }, [desktop]);
  useEffect(() => {
    const viewport = window.visualViewport; const update = () => document.documentElement.style.setProperty('--otis-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
    update(); viewport?.addEventListener('resize', update); window.addEventListener('resize', update);
    return () => { viewport?.removeEventListener('resize', update); window.removeEventListener('resize', update); document.documentElement.style.removeProperty('--otis-viewport-height'); };
  }, []);
  const loseAccess = useCallback(() => { epoch.current++; setView(null); setModels([]); setOwnChats([]); setTeamChats([]); setDetailActionId(null); setSourceId(null); setDrawerOpen(false); setSettingsOpen(false); setAccessLost(true); setReplyId(null); setDismissedClarificationId(null); }, []);
  useEffect(() => {
    let cancelled = false; setOwnChats([]); setTeamChats([]); setNavLoading(true);
    Promise.all([api.listChats(workspaceId, 'mine'), api.listChats(workspaceId, 'team'), api.commands()]).then(([mine, team, registry]) => {
      if (cancelled) return; setOwnChats(mine.chats); setTeamChats(team.chats.filter(chat => chat.author_user_id !== userId)); setCommands(registry.commands); setNavCursors({ mine: mine.next_cursor, team: team.next_cursor });
      if (!new URLSearchParams(location.search).has('chat')) { let last: string | null = null; try { last = sessionStorage.getItem(`otis:view:${userId}:${workspaceId}`); } catch { /* use recent own chat */ } navigate(workspaceId, last === 'new' ? null : last ?? mine.chats[0]?.id ?? null, true); }
    }).catch(err => { if (!cancelled) { if (err instanceof ApiError && [401, 404].includes(err.status)) loseAccess(); else setError('Could not load conversations. Reload to try again.'); } }).finally(() => { if (!cancelled) setNavLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId, userId, navigate, loseAccess]);
  const loadChat = useCallback(async (chatId: string, generation = epoch.current) => {
    try {
      const [detail, page, firstActivity, questions] = await Promise.all([api.getChat(workspaceId, chatId), api.listMessages(workspaceId, chatId), api.activity(workspaceId, chatId, 0), api.clarifications(workspaceId, chatId)]);
      const cursor = firstActivity.latest_cursor;
      const runIds = [...new Set(page.messages.flatMap(message => message.run_id ? [message.run_id] : []))];
      const runData = await Promise.all(runIds.map(id => api.run(workspaceId, id)));
      for (const run of runData) {
        if (run.status === 'failed' || run.status === 'partial') {
          failureLog('chat', 'run settled abnormally', { chatId, run_id: run.run.id, status: run.status, error_code: run.run.error_code });
        } else {
          debugLog('chat', 'run state', { chatId, run_id: run.run.id, status: run.status });
        }
      }
      const activities = [...new Map([...firstActivity.activities, ...runData.flatMap(run => run.activities)].map(activity => [activity.id, activity])).values()].sort((a, b) => a.cursor - b.cursor);
      if (generation !== epoch.current || selected.current.workspace !== workspaceId || selected.current.chat !== chatId) return;
      setView(current => ({ workspaceId, chatId, detail, messages: mergeMessages(current?.chatId === chatId && current.workspaceId === workspaceId ? current.messages : [], page.messages), activities, runs: Object.fromEntries(runData.map(run => [run.run.id, run])), older: current?.chatId === chatId && current.messages.length > page.messages.length ? current.older : page.next_before_sequence, questions: questions.clarifications, cursor }));
      setLoading(false);
    } catch (err) { if (generation !== epoch.current) return; debugLog('chat', 'load failed', { chatId, status: err instanceof ApiError ? err.status : null, code: err instanceof ApiError ? err.code : null }); if (err instanceof ApiError && [401, 403, 404].includes(err.status)) loseAccess(); else { setError(safeError(err, 'Could not open this conversation. Try again.')); setLoading(false); } }
  }, [workspaceId, loseAccess]);
  useEffect(() => { if (!activeChatId) { setView(null); setLoading(false); return; } setLoading(true); void loadChat(activeChatId); return () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }; }, [activeChatId, loadChat]);
  const readyChatId = view?.workspaceId === workspaceId && view.chatId === activeChatId ? view.chatId : null;
  useEffect(() => {
    if (!readyChatId || accessLost) return;
    const generation = epoch.current;
    const subscription = subscribeToActivity(api.activityStreamUrl(workspaceId, readyChatId, view?.cursor ?? 0), {
      onActivity: activity => {
        if (generation !== epoch.current || activity.workspace_id !== workspaceId || activity.chat_id !== readyChatId) return;
        setView(current => current ? { ...current, activities: mergeActivity(current.activities, activity), cursor: Math.max(current.cursor, activity.cursor) } : current);
        if (activity.type !== 'text_chunk' && activity.type !== 'reasoning_summary') { if (refreshTimer.current) clearTimeout(refreshTimer.current); refreshTimer.current = setTimeout(() => { void loadChat(readyChatId, generation); }, 120); }
      }, onStatus: status => { if (generation === epoch.current) setStreamStatus(status); }, onResyncRequired: () => { void loadChat(readyChatId, generation).then(() => { if (generation === epoch.current) setStreamGeneration(value => value + 1); }); }, onAccessLost: loseAccess,
    });
    return () => subscription.close();
    // Cursor is the snapshot when this subscription opens; EventSource handles subsequent IDs.
  }, [readyChatId, workspaceId, loadChat, loseAccess, accessLost, streamGeneration]);
  useEffect(() => { let cancelled = false; const request = ++modelRequest.current; if (view && !view.detail.is_author) return; api.models(workspaceId, activeChatId ?? undefined).then(result => { if (!cancelled && request === modelRequest.current) { setModels(result.models ?? []); setFollowsDefault(!view?.detail.chat.model_override); } }).catch(() => { if (!cancelled && request === modelRequest.current) setModels([]); }); return () => { cancelled = true; }; }, [workspaceId, activeChatId, view?.detail.chat.model_override, view?.detail.chat.thinking_override?.choice_id, view?.detail.chat.thinking_override?.model_key, view?.detail.is_author, modelRevision]);
  const current = view?.workspaceId === workspaceId && view.chatId === activeChatId ? view : null;
  const readOnly = Boolean(current && !current.detail.is_author);
  const workspaceName = workspaces.find(workspace => workspace.id === workspaceId)?.name ?? 'Workspace';
  const activeRuns = Object.values(current?.runs ?? {}).filter(run => ['queued', 'running'].includes(run.status));
  const running = activeRuns.find(run => run.status === 'running') ?? activeRuns[0];
  const pendingQuestion = current?.questions.find(
    question => question.status === 'pending' && question.answerable_by_caller && question.id !== dismissedClarificationId
  );
  const activeClarification = replyId
    ? current?.questions.find(question => question.id === replyId && question.answerable_by_caller)
    : pendingQuestion;
  const ensureChat = async (clientId: string): Promise<string> => {
    if (activeChatId) return activeChatId;
    if (!preparedChat.current || preparedChat.current.workspaceId !== workspaceId) {
      const promise = api.createChat(workspaceId, `new-${clientId}`).then(result => result.chat);
      preparedChat.current = { workspaceId, promise };
      promise.catch(() => { if (preparedChat.current?.promise === promise) preparedChat.current = null; });
    }
    return (await preparedChat.current.promise).id;
  };
  const applyCommand = async (text: string): Promise<boolean> => {
    if (readOnly || accessLost || controlLock.current) return false;
    modelRequest.current++;
    controlLock.current = true; setControlPending(true);
    const generation = epoch.current;
    try {
      const id = controlOperation.current?.text === text ? controlOperation.current.id : crypto.randomUUID();
      const chatId = controlOperation.current?.text === text ? controlOperation.current.chatId : await ensureChat(id);
      controlOperation.current = { id, text, chatId };
      const applied = await api.executeCommand(workspaceId, chatId, id, text);
      if (generation !== epoch.current) return true;
      if (applied.selected_workspace_id && workspaces.some(workspace => workspace.id === applied.selected_workspace_id)) { switchWorkspace(applied.selected_workspace_id); return true; }
      const [options, detail] = await Promise.all([api.models(workspaceId, chatId), api.getChat(workspaceId, chatId)]);
      if (generation !== epoch.current) return true;
      setModels(options.models ?? []); setFollowsDefault(!detail.chat.model_override);
      setView(previous => previous?.chatId === chatId ? { ...previous, detail } : previous);
      controlOperation.current = null;
      if (!activeChatId) {
        try { const draft = sessionStorage.getItem(`otis:draft:${userId}:${workspaceId}:new`); if (draft && draft.trim() !== text.trim()) sessionStorage.setItem(`otis:draft:${userId}:${workspaceId}:${chatId}`, draft); sessionStorage.removeItem(`otis:draft:${userId}:${workspaceId}:new`); } catch { /* Browser storage is optional. */ }
        const created = await preparedChat.current?.promise;
        if (generation !== epoch.current) return true;
        if (created) setOwnChats(chats => [created, ...chats.filter(chat => chat.id !== created.id)]);
        navigate(workspaceId, chatId, true);
      }
      if (!/^\/(model|thinking|workspace)\s+\S/i.test(text) && applied.reply) setControlResult(applied.reply);
      return true;
    } catch (err) {
      if (generation === epoch.current) toast.error(err instanceof ApiError && err.status === 422 ? err.message : 'Could not apply the command. Try again.');
      return false;
    } finally { controlLock.current = false; setControlPending(false); }
  };
  const send = async (text: string): Promise<boolean> => {
    if (readOnly || accessLost) return false;
    const generation = epoch.current;
    const operationKey = `otis:send:${userId}:${workspaceId}:${activeChatId ?? 'new'}`;
    let operation = sendOperation.current;
    try { if (!operation) operation = JSON.parse(sessionStorage.getItem(operationKey) ?? 'null'); } catch { /* a fresh operation is safe when nothing was persisted */ }
    if (!operation || operation.text !== text || (activeChatId !== null && operation.chatId !== activeChatId) || operation.clarificationId !== (activeClarification?.id ?? undefined)) { operation = { text, id: crypto.randomUUID(), chatId: activeChatId, clarificationId: activeClarification?.id }; sendOperation.current = operation; }
    try {
      debugLog('send', 'starting', { operationId: operation.id, chatId: operation.chatId ?? null, chars: text.length, clarificationId: operation.clarificationId ?? null });
      let chatId = operation.chatId;
      try { sessionStorage.setItem(operationKey, JSON.stringify(operation)); } catch { /* keep the in-memory retry identity */ }
      if (!chatId) { chatId = await ensureChat(operation.id); const created = await preparedChat.current?.promise; if (generation === epoch.current && created) setOwnChats(chats => [created, ...chats.filter(chat => chat.id !== chatId)]); operation.chatId = chatId; try { sessionStorage.setItem(operationKey, JSON.stringify(operation)); } catch { /* in-memory identity remains */ } }
      const accepted = await api.sendMessage(workspaceId, chatId, operation.id, text, operation.clarificationId);
      debugLog('send', 'accepted; run queued server-side', { chatId, message_id: accepted.message_id, run_id: accepted.run_id, sequence: accepted.acceptance_sequence });
      sendOperation.current = null; try { sessionStorage.removeItem(operationKey); } catch { /* accepted response is authoritative */ }
      if (generation !== epoch.current) return true;
      setError(null); setReplyId(null); setDismissedClarificationId(null); setDraftValue(null);
      if (!activeChatId) {
        try { const nextDraft = sessionStorage.getItem(`otis:draft:${userId}:${workspaceId}:new`); if (nextDraft && nextDraft.trim() !== text.trim()) sessionStorage.setItem(`otis:draft:${userId}:${workspaceId}:${chatId}`, nextDraft); sessionStorage.removeItem(`otis:draft:${userId}:${workspaceId}:new`); } catch { /* Browser storage is optional. */ }
        navigate(workspaceId, chatId);
      }
      if (accepted.selected_workspace_id && workspaces.some(workspace => workspace.id === accepted.selected_workspace_id)) { switchWorkspace(accepted.selected_workspace_id); return true; }
      void loadChat(chatId, epoch.current); return true;
    } catch (err) { debugLog('send', 'failed before acceptance', { operationId: operation.id, status: err instanceof ApiError ? err.status : null, code: err instanceof ApiError ? err.code : null }); if (generation === epoch.current) { setError(safeError(err, 'Message not confirmed. Your draft is retained; send again to retry the same message.')); if (err instanceof ApiError && [401, 403, 404].includes(err.status)) loseAccess(); } return false; }
  };
  const switchWorkspace = (id: string) => { if (!workspaces.some(workspace => workspace.id === id)) return; let last: string | null = null; try { last = sessionStorage.getItem(`otis:view:${userId}:${id}`); } catch { /* start new */ } navigate(id, last === 'new' ? null : last); };
  const loadOlder = async () => { if (!current?.older) return; setLoadingOlder(true); const generation = epoch.current; try { const page = await api.listMessages(workspaceId, current.chatId, current.older); const ids = [...new Set(page.messages.flatMap(message => message.run_id ? [message.run_id] : []))]; const runs = await Promise.all(ids.map(id => api.run(workspaceId, id))); if (generation !== epoch.current) return; setView(value => value ? { ...value, messages: mergeMessages(page.messages, value.messages), older: page.next_before_sequence, runs: { ...value.runs, ...Object.fromEntries(runs.map(run => [run.run.id, run])) } } : value); } catch { setError('Could not load earlier messages. Try again.'); } finally { setLoadingOlder(false); } };
  const loadMoreChats = async () => { const generation = epoch.current; try { const [mine, team] = await Promise.all([navCursors.mine ? api.listChats(workspaceId, 'mine', navCursors.mine) : null, navCursors.team ? api.listChats(workspaceId, 'team', navCursors.team) : null]); if (generation !== epoch.current) return; if (mine) setOwnChats(chats => [...new Map([...chats, ...mine.chats].map(chat => [chat.id, chat])).values()]); if (team) setTeamChats(chats => [...new Map([...chats, ...team.chats.filter(chat => chat.author_user_id !== userId)].map(chat => [chat.id, chat])).values()]); setNavCursors({ mine: mine?.next_cursor, team: team?.next_cursor }); } catch { setError('Could not load more conversations.'); } };
  const navProps = { workspaceId, workspaceName, workspaces, ownChats, teamChats, members, activeChatId, loading: navLoading, onSelectChat: (id: string) => navigate(workspaceId, id), onNewChat: () => navigate(workspaceId, null), onSwitchWorkspace: switchWorkspace, onOpenSettings: () => { setDrawerOpen(false); setSettingsOpen(true); }, hasMore: Boolean(navCursors.mine || navCursors.team), onLoadMore: () => void loadMoreChats() };
  return <div className="otis-shell">
    <Toaster theme="dark" position="top-center" visibleToasts={2} closeButton toastOptions={{ className: 'otis-toast', duration: 3000 }} offset={64}/>
    {!accessLost && <HistoryNav variant="sidebar" {...navProps}/>} {drawerOpen && !accessLost && <HistoryNav variant="drawer" {...navProps} onClose={() => setDrawerOpen(false)}/>}
    <main className="otis-main"><header className="otis-topbar"><button type="button" className="otis-iconbutton otis-topbar__menu" aria-label="Open history" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)} disabled={accessLost}><MenuIcon/></button><div className="otis-topbar__identity"><h1 className="otis-topbar__title" title={current?.detail.chat.title ?? workspaceName}>{current?.detail.chat.title ?? workspaceName}</h1><span className="otis-topbar__subtitle">{readOnly ? `${current!.detail.chat.author_display_name ?? members[current!.detail.chat.author_user_id] ?? 'Teammate'} · read only` : activeChatId ? workspaceName : 'New conversation'}</span></div><button type="button" className="otis-iconbutton" aria-label="New chat" onClick={() => navigate(workspaceId, null)} disabled={accessLost}><ComposeIcon/></button></header>
    {accessLost ? <div className="otis-access"><h2>Conversation unavailable</h2><p>Your session may have expired or your workspace access has changed. Private content has been closed.</p><button className="otis-button" type="button" onClick={() => location.reload()}>Reload access</button><button className="otis-button" type="button" onClick={onSignOut}>Sign out</button></div> : <div className="otis-chat">
      {streamStatus === 'resyncing' && <p className="otis-connection" role="status">Reconnecting to activity… Your conversation is retained.</p>}
      <Transcript key={`${workspaceId}:${activeChatId ?? 'new'}`} messages={current?.messages ?? []} members={members} currentUserId={userId} runs={current?.runs ?? {}} activities={current?.activities ?? []} steps={[]} onInspectSource={setSourceId} onInspectAction={setDetailActionId} onReply={readOnly ? undefined : setReplyId} onEditMessage={readOnly ? undefined : setDraftValue} loading={loading} hasOlder={Boolean(current?.older)} loadingOlder={loadingOlder} onLoadOlder={() => void loadOlder()}/>
      {error && <div className="otis-chat-error" role="alert"><p>{error}</p>{activeChatId && !loading && <button type="button" className="otis-textbutton" onClick={() => void loadChat(activeChatId)}>Reload conversation</button>}</div>}
      {readOnly ? <div className="otis-readonly"><p>This is {current!.detail.chat.author_display_name ?? members[current!.detail.chat.author_user_id] ?? 'a teammate'}’s conversation.</p><button className="otis-textbutton" type="button" onClick={() => navigate(workspaceId, ownChats[0]?.id ?? null)}>Continue in your own chat</button></div> : <Composer key={`${workspaceId}:${userId}:${activeChatId ?? 'new'}`} draftKey={`otis:draft:${userId}:${workspaceId}:${activeChatId ?? 'new'}`} draftValue={draftValue} disabled={Boolean(activeChatId && !current)} disabledReason="Opening conversation…" running={Boolean(running)} queuedCount={activeRuns.filter(run => run.status === 'queued').length} commands={commands} models={models} workspaces={workspaces} controlPending={controlPending} modelReady={models.some(model => model.is_current && model.available)} followsDefault={followsDefault} onCommand={applyCommand} onStop={running ? async () => { await api.stopRun(workspaceId, running.run.id); if (activeChatId) void loadChat(activeChatId); } : undefined} replyTo={activeClarification ? { id: activeClarification.id, question: activeClarification.question, candidates: activeClarification.candidates, missing_fields: activeClarification.missing_fields, intended_operation: activeClarification.intended_operation, onCancel: () => { setDismissedClarificationId(activeClarification.id); setReplyId(null); } } : undefined} onSend={send}/>}
    </div>}</main>
    {controlResult && <Overlay label="Command result" className="otis-overlay--settings" onClose={() => setControlResult(null)}><section className="otis-settings"><header className="otis-pane-header"><h2>Result</h2><button type="button" className="otis-button" onClick={() => setControlResult(null)}>Close</button></header><div className="otis-settings__content"><Markdown skipHtml disallowedElements={['img']}>{controlResult}</Markdown></div></section></Overlay>}
    {sourceId && <SourcePane workspaceId={workspaceId} memoryId={sourceId} onClose={() => setSourceId(null)} onAccessLost={loseAccess} onOpenChat={id => navigate(workspaceId, id)}/>} {detailActionId && <DetailPane onAccessLost={loseAccess} workspaceId={workspaceId} chatId={readOnly ? '' : activeChatId ?? ''} actionId={detailActionId} onClose={() => setDetailActionId(null)} onUndone={() => { if (activeChatId) void loadChat(activeChatId); }}/>} {settingsOpen && <SettingsPane onAccessLost={loseAccess} workspaceId={workspaceId} workspaceName={workspaceName} members={members} onUpdated={() => setModelRevision(value => value + 1)} onClose={() => setSettingsOpen(false)} onSignOut={onSignOut}/>}
  </div>;
}
