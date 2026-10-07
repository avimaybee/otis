import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Toaster, toast } from 'sonner';
import Markdown from 'react-markdown';
import type { ClarificationSummary, CommandDescriptor, ModelOption, VoiceMediaSummary } from '@otis/contracts';
import { api, ApiError } from './api/client.js';
import { createWorkerImageTransport, uploadImageFile } from './api/images.js';
import { debugLog } from './api/log.js';
import { subscribeToActivity, type StreamStatus } from './hooks/useActivityStream.js';
import {
  clearTransientPreview,
  dropCoveredTransientPreview,
  mergeTransientPreview,
  type TransientPreview,
} from './hooks/useActivityStream.js';
import { useMediaQuery } from './hooks/useMediaQuery.js';
import { useViewportComposer } from './hooks/useViewportComposer.js';
import { Composer } from './components/Composer.js';
import { ChatOverflow } from './components/ChatOverflow.js';
import { DetailPane } from './components/DetailPane.js';
import { HistoryNav } from './components/HistoryNav.js';
import { QuestionPanel } from './components/QuestionPanel.js';
import { SourcePane } from './components/SourcePane.js';
import { SettingsPane } from './components/SettingsPane.js';
import { Transcript } from './components/Transcript.js';
import { CloseIcon, ComposeIcon, MenuIcon } from './components/icons.js';
import { Overlay } from './components/Overlay.js';
import { Button } from './components/ui/button.js';
import { Input } from './components/ui/input.js';
import {
  awaitOutboxSettlement,
  claimDelivery,
  clearPendingNewChat,
  clearUserOutbox,
  createOutboxEntry,
  deferOutboxRetry,
  discardUnsentEntry,
  entriesForChat,
  getNewChatMapping,
  getOrCreatePendingNewChat,
  getOutboxEntry,
  markOutboxFailed,
  markOutboxSaved,
  outboxDurable,
  outboxVersion,
  pruneReconciledEntries,
  rehydrateOutbox,
  releaseDelivery,
  retryOutboxEntry,
  setNewChatMapping,
  subscribeOutbox,
  updateOutboxChatId,
  type OutboxEntry,
} from './api/outbox.js';
import { classifySendError, computeBackoffMs, registerFlushOwner, requestFlush, unregisterFlushOwner } from './api/flush.js';
import { deleteDraftsForUser, draftSession, moveDraft } from './api/drafts.js';
import { voiceUploadAdapter } from './api/voice.js';
import { deleteVoiceSessionsForUser } from './api/voiceSessions.js';
import { deriveTranscript, reconciledClientIds } from './api/transcript.js';
import {
  applyAcceptedMessage,
  applyActivitySnapshot,
  applyAnswerSaved,
  applyDetail,
  applyLatestMessages,
  applyOlderMessages,
  applyQuestions,
  applyRunSnapshot,
  useChatSnapshot,
  type ChatSnapshot,
} from './api/snapshot.js';
import {
  clearUserQueries,
  clearWorkspaceQueries,
  fetchMoreChats,
  qk,
  useAppQueryClient,
  useCommands,
  useModels,
  useNavChats,
} from './api/queries.js';

export interface ConversationScreenProps {
  /** Route-owned workspace; the router guarantees it names an accessible workspace. */
  workspaceId: string;
  /** Route-owned chat, or null for the new-chat entry. */
  chat: string | null;
  /** Whether ?chat is present (absent restores the last view; chat=new stays new). */
  chatParamPresent: boolean;
  workspaces: { id: string; name: string; role?: string }[]; userId: string; members: Record<string, string>;
  onSignOut: () => void;
  /** The single typed navigation owner; replaces manual pushState/popstate. */
  onNavigate: (workspace: string, chat: string | null, replace?: boolean) => void;
  onRefreshSession?: () => Promise<void>;
}
function safeError(error: unknown, fallback: string) { if (error instanceof ApiError && error.status === 401) return 'Your session has expired. Sign in again.'; if (error instanceof ApiError && error.status === 404) return 'This conversation is unavailable or your access has changed.'; return fallback; }
/**
 * Session death (expired/invalid credentials) is the only condition that
 * discards user-wide local state. A 403 is always object- or
 * workspace-scoped (not the chat author, removed member on a legacy route):
 * it surfaces in the affected control and never purges the session, sibling
 * workspaces, or unsent work.
 */
function isSessionError(error: unknown): boolean { return error instanceof ApiError && error.status === 401; }
function isNotFoundError(error: unknown): boolean { return error instanceof ApiError && error.status === 404; }
function isForbiddenError(error: unknown): boolean { return error instanceof ApiError && error.status === 403; }

/**
 * Resolves a pending question from run details when the question-list read
 * failed. Mirrors the server's answerability rule (requester answers while
 * pending) and parses candidates defensively; anything unparseable reads as
 * no candidates rather than a broken panel.
 */
function runKnownQuestion(
  snapshot: ChatSnapshot,
  questionId: string,
  callerUserId: string,
): ClarificationSummary | undefined {
  for (const run of Object.values(snapshot.runs)) {
    const pending = run.pending_clarification;
    if (!pending || pending.id !== questionId || pending.status !== 'pending') continue;
    let candidates: string[] | null = null;
    if (typeof pending.candidates_json === 'string' && pending.candidates_json !== '') {
      try {
        const parsed: unknown = JSON.parse(pending.candidates_json);
        candidates = Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : null;
      } catch {
        candidates = null;
      }
    }
    return {
      id: pending.id,
      chat_id: pending.chat_id,
      run_id: pending.run_id,
      question: pending.question,
      intended_operation: pending.intended_operation,
      missing_fields: pending.missing_fields,
      candidates,
      status: pending.status,
      created_at: pending.created_at,
      answerable_by_caller: pending.requester_user_id === callerUserId,
    };
  }
  return undefined;
}

export function ConversationScreen({ workspaceId, chat: routeChat, chatParamPresent, workspaces, userId, members, onSignOut, onNavigate, onRefreshSession }: ConversationScreenProps) {
  const activeChatId = routeChat;
  const [drawerOpen, setDrawerOpen] = useState(false); const [settingsOpen, setSettingsOpen] = useState(false); const [detailActionId, setDetailActionId] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('idle'); const [error, setError] = useState<string | null>(null); const [accessLost, setAccessLost] = useState(false);
  // Live transient preview text by run/round. Memory-only: never persisted,
  // never in the snapshot; durable chunks and answers replace it on arrival.
  const [transients, setTransients] = useState<TransientPreview>({});
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renamingChat, setRenamingChat] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [deletingChat, setDeletingChat] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [creatingWs, setCreatingWs] = useState(false);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [followSignal, setFollowSignal] = useState(0);
  const [replyId, setReplyId] = useState<string | null>(null);  const [dismissedClarificationIds, setDismissedClarificationIds] = useState<string[]>([]);
  const [draftValue, setDraftValue] = useState<string | null>(null);
  const [controlPending, setControlPending] = useState(false);
  const [controlResult, setControlResult] = useState<string | null>(null);
  const [modelRevision, setModelRevision] = useState(0);
  const queryClient = useAppQueryClient();

  // Delivery store version: re-renders the transcript on echo/save/failure.
  const outboxTick = useSyncExternalStore(subscribeOutbox, outboxVersion);
  void outboxTick;
  const modelRequest = useRef(0);
  const controlLock = useRef(false);
  const controlOperation = useRef<{ text: string; id: string; chatId: string } | null>(null);
  const epoch = useRef(0);
  // Latest committed route plus synchronous programmatic intent. Updated by
  // navigate() immediately and by the committed-selection effect below, but
  // never during render: a stale-props render must not clobber navigate()'s
  // write before the router commits, or operation fences would read a route
  // the reader already left (or never confirmed).
  const selected = useRef({ workspace: workspaceId, chat: activeChatId });
  const refreshTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const desktop = useMediaQuery('(min-width: 900px)');
  // One measured viewport/composer owner: opening or closing the keyboard
  // keeps the draft, clarification, reading position and active run, since
  // geometry changes never drive follow or selection here. The hook tracks
  // the mounted composer element, so the read-only view (no composer) and
  // later own chats are observed correctly as nodes come and go.
  const composerRef = useViewportComposer();

  const clearRefreshTimers = useCallback(() => {
    for (const timer of refreshTimers.current.values()) clearTimeout(timer);
    refreshTimers.current.clear();
  }, []);

  const navigate = useCallback((workspace: string, chat: string | null, replace = false) => {
    if (chat === null) clearPendingNewChat(userId, workspace);
    controlOperation.current = null; setControlResult(null); epoch.current++; selected.current = { workspace, chat }; setDrawerOpen(false); setSettingsOpen(false); setDetailActionId(null); setSourceId(null); setReplyId(null); setDismissedClarificationIds([]); setDraftValue(null); setError(null); setOlderError(null); setAccessLost(false);
    clearRefreshTimers();
    onNavigate(workspace, chat, replace);
    try { sessionStorage.setItem(`otis:view:${userId}:${workspace}`, chat ?? 'new'); } catch { /* URL remains authoritative */ }
  }, [userId, clearRefreshTimers, onNavigate]);

  const loseAccess = useCallback(() => {
    epoch.current++;
    clearRefreshTimers();
    clearUserQueries(queryClient, userId);
    clearUserOutbox(userId);
    void deleteDraftsForUser(userId);
    void deleteVoiceSessionsForUser(userId);
    unregisterFlushOwner(userId);
    setDetailActionId(null); setSourceId(null); setDrawerOpen(false); setSettingsOpen(false); setAccessLost(true); setReplyId(null); setDismissedClarificationIds([]);
  }, [queryClient, userId, clearRefreshTimers]);

  // Workspaces the server stopped serving (removed member, deleted
  // workspace). Only that workspace's server snapshots are dropped; the
  // session, sibling workspaces, drafts and unsent work all survive. The
  // lost workspace's own pending entries fail honestly on the next send
  // (403/404 becomes a failed bubble with Retry) instead of being silently
  // deleted. No epoch bump and no timer clear: in-flight work for other
  // workspaces must continue, and their updaters no-op against removed
  // cache by construction.
  const [workspaceLost, setWorkspaceLost] = useState<string[]>([]);
  const loseWorkspace = useCallback((lostWorkspaceId: string, reason: 'revoked' | 'forbidden') => {
    clearWorkspaceQueries(queryClient, userId, lostWorkspaceId);
    setWorkspaceLost(previous => (previous.includes(lostWorkspaceId) ? previous : [...previous, lostWorkspaceId]));
    if (lostWorkspaceId === selected.current.workspace) {
      setDetailActionId(null); setSourceId(null); setDrawerOpen(false); setSettingsOpen(false);
      setReplyId(null); setDismissedClarificationIds([]);
    } else {
      const name = workspaces.find(workspace => workspace.id === lostWorkspaceId)?.name ?? 'A workspace';
      toast.warning(`${name} is no longer available. Your other workspaces and unsent work are kept.`);
    }
    debugLog('chat', 'workspace access lost; scope retained', { workspaceId: lostWorkspaceId, reason });
  }, [queryClient, userId, workspaces]);

  const refreshSession = useCallback(async () => {
    await onRefreshSession?.();
    // Session refresh re-resolves membership: a restored workspace rejoins
    // through its normal queries instead of staying parked as lost.
    setWorkspaceLost([]);
    setError(null);
  }, [onRefreshSession]);

  // Browser Back/Forward arrives as new route props: detach transient UI from
  // the previous chat exactly like a programmatic navigation, without
  // resending, restarting a run or creating another chat. The scoped query
  // keys and epoch guards ignore late responses from the previous chat.
  const selectionKey = `${workspaceId}:${activeChatId ?? 'new'}`;
  useEffect(() => {
    // Committed route change: sync the operation fence mirror, drop timer
    // callbacks fenced to the previous selection, and detach transient UI.
    // Timer callbacks are re-scheduled by their owners after acceptance;
    // clearing here only drops callbacks fenced to the previous selection.
    // Epoch is left alone: self-created navigations re-anchor their own
    // generation and must not be invalidated by this effect.
    selected.current = { workspace: workspaceId, chat: activeChatId };
    clearRefreshTimers();
    setDrawerOpen(false); setSettingsOpen(false); setDetailActionId(null); setSourceId(null);
    setReplyId(null); setDismissedClarificationIds([]); setDraftValue(null);
  }, [selectionKey, clearRefreshTimers]);

  useEffect(() => { if (desktop) setDrawerOpen(false); }, [desktop]);
  useEffect(() => () => clearRefreshTimers(), [clearRefreshTimers]);

  // F12-SSE: a hidden tab holds no live stream. The subscription effect
  // below closes on hide and resubscribes from the snapshot cursor on
  // foreground, so catch-up replays anything missed with no gap.
  const [isVisible, setIsVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    const onVisibility = () => setIsVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Scoped server snapshots. Keys carry the user so a late result can never
  // restore another account's content, and navigation swaps keys instead of
  // showing stale results while the new snapshot loads.
  const mineQuery = useNavChats(userId, workspaceId, 'mine', accessLost);
  const teamQuery = useNavChats(userId, workspaceId, 'team', accessLost);
  const ownChats = useMemo(() => mineQuery.data?.chats ?? [], [mineQuery.data]);
  const teamChats = useMemo(() => (teamQuery.data?.chats ?? []).filter(chat => chat.author_user_id !== userId), [teamQuery.data, userId]);
  const navLoading = mineQuery.isPending || teamQuery.isPending;

  useEffect(() => {
    if (accessLost || !mineQuery.data || chatParamPresent) return;
    let last: string | null = null;
    try { last = sessionStorage.getItem(`otis:view:${userId}:${workspaceId}`); } catch { /* use recent own chat */ }
    navigate(workspaceId, last === 'new' ? null : last ?? mineQuery.data.chats[0]?.id ?? null, true);
  }, [accessLost, mineQuery.data, chatParamPresent, navigate, userId, workspaceId]);
  useEffect(() => {
    // Only a dead session discards user-wide state. A 403/404 on the
    // workspace listing is scoped: the session stays alive and the error
    // below names the affected workspace instead of closing everything.
    const sessionLost = (mineQuery.error && isSessionError(mineQuery.error))
      || (teamQuery.error && isSessionError(teamQuery.error));
    if (sessionLost) { if (!accessLost) loseAccess(); return; }
    if (mineQuery.error && !accessLost) setError('Could not load conversations. Reload to try again.');
  }, [mineQuery.error, teamQuery.error, accessLost, loseAccess]);

  const snapshotQuery = useChatSnapshot(userId, workspaceId, activeChatId, accessLost);
  // Staged paint: the primary transcript (detail + messages) renders as soon
  // as its two reads resolve; runs, activities and questions fill when the
  // full snapshot lands. The staged value is local state merged here at read
  // time, never a cache write, so live patches cannot be clobbered by it.
  const snapshot = snapshotQuery.data ?? snapshotQuery.primarySnapshot ?? null;
  // Cache-mutating consumers split by hazard: the live subscription starts
  // off the staged transcript at cursor 0 (server catch-up replays anything
  // the empty cache cannot yet apply, and merges dedupe by id), while older
  // pagination waits for the committed full snapshot — paginating off an
  // uncommitted primary would fetch against state the cache never held.
  // Cache-mutating consumers (live stream cursor, older pagination) wait for
  // the committed full snapshot: paginating or subscribing off an
  // uncommitted primary would fetch against, then be overwritten by, state
  // the cache never held.
  const fullSnapshot = snapshotQuery.data ?? null;
  const chatNotFound = Boolean(activeChatId && snapshotQuery.error && isNotFoundError(snapshotQuery.error));
  useEffect(() => {
    if (!snapshotQuery.error || accessLost) return;
    if (isSessionError(snapshotQuery.error)) loseAccess();
    // A forbidden workspace read parks only that workspace: the session,
    // sibling workspaces and their unsent work all survive. A 404 stays a
    // per-conversation message because a deleted chat must not park a live
    // workspace. The parked guard matters: clearing the scope refetches the
    // read, and every retry 403s, so re-parking must not loop.
    else if (isForbiddenError(snapshotQuery.error) && !workspaceLost.includes(workspaceId)) {
      loseWorkspace(workspaceId, 'forbidden');
    }
    else if (isNotFoundError(snapshotQuery.error)) setError('This conversation is unavailable or was deleted.');
    else setError(safeError(snapshotQuery.error, 'Could not open this conversation. Try again.'));
  }, [snapshotQuery.error, accessLost, loseAccess, loseWorkspace, workspaceId, workspaceLost]);

  const readOnly = Boolean(snapshot && !snapshot.detail.is_author);
  // A fresh view has no snapshot yet; workspace-scoped models must still load
  // or the composer can never become ready (R8). Authoritative chats gate on
  // authorship; the query key already scopes user/workspace/chat.
  const modelsQuery = useModels(userId, workspaceId, activeChatId, modelRevision, accessLost || (snapshot ? !snapshot.detail.is_author : false));
  const models: ModelOption[] = modelsQuery.data?.models ?? [];
  const followsDefault = !snapshot?.detail.chat.model_override;
  const commandsQuery = useCommands(accessLost);

  const commands: CommandDescriptor[] = commandsQuery.data?.commands ?? [];
  // Live voice requires the server-reported usable route plus a confirmed
  // upload adapter, and an existing chat for the contract's chat_id. Until
  // both exist the mic stays absent rather than shipping a dead action.
  const voiceAdapter = voiceUploadAdapter();
  const voiceAvailable = Boolean(voiceAdapter) && (
    models.length === 0 ||
    models.some(model => (model.is_current ? (model.available && model.voice_available) : false)) ||
    models.some(model => model.available && model.voice_available) ||
    models.some(model => model.provider === 'gemini')
  );

  const chatOutbox = useMemo(
    () => entriesForChat(userId, workspaceId, activeChatId),
    [userId, workspaceId, activeChatId, outboxTick],
  );
  const derived = useMemo(
    () => deriveTranscript(snapshot?.messages ?? [], chatOutbox, outboxDurable()),
    [snapshot?.messages, chatOutbox],
  );
  useEffect(() => {
    if (snapshot) pruneReconciledEntries(reconciledClientIds(snapshot.messages));
  }, [snapshot]);

  const scheduleRefresh = useCallback((key: string, work: () => Promise<void>) => {
    const existing = refreshTimers.current.get(key);
    if (existing) clearTimeout(existing);
    refreshTimers.current.set(key, setTimeout(() => {
      refreshTimers.current.delete(key);
      const generation = epoch.current;
      void work().catch(err => {
        if (generation !== epoch.current) return;
        if (isSessionError(err)) loseAccess();
        else debugLog('chat', 'targeted refresh failed', { key, status: err instanceof ApiError ? err.status : null });
      });
    }, 120));
  }, [loseAccess]);

  const refreshRun = useCallback((scopeWorkspaceId: string, chatId: string, runId: string) => {
    scheduleRefresh(`run:${runId}`, async () => {
      const run = await api.run(scopeWorkspaceId, runId);
      if (selected.current.workspace !== scopeWorkspaceId || selected.current.chat !== chatId) return;
      queryClient.setQueryData<ChatSnapshot>(qk.chat(userId, scopeWorkspaceId, chatId), previous =>
        previous ? applyRunSnapshot(previous, run) : previous);
    });
  }, [queryClient, userId, scheduleRefresh]);

  const refreshMessages = useCallback((scopeWorkspaceId: string, chatId: string) => {
    scheduleRefresh(`messages:${chatId}`, async () => {
      const page = await api.listMessages(scopeWorkspaceId, chatId);
      if (selected.current.workspace !== scopeWorkspaceId || selected.current.chat !== chatId) return;
      queryClient.setQueryData<ChatSnapshot>(qk.chat(userId, scopeWorkspaceId, chatId), previous =>
        previous ? applyLatestMessages(previous, page.messages) : previous);
    });
  }, [queryClient, userId, scheduleRefresh]);

  const refreshQuestions = useCallback((chatId: string) => {
    scheduleRefresh(`questions:${chatId}`, async () => {
      const result = await api.clarifications(workspaceId, chatId);
      if (selected.current.workspace !== workspaceId || selected.current.chat !== chatId) return;
      queryClient.setQueryData<ChatSnapshot>(qk.chat(userId, workspaceId, chatId), previous =>
        previous ? applyQuestions(previous, result.clarifications) : previous);
    });
  }, [queryClient, userId, workspaceId, scheduleRefresh]);

  const resyncChat = useCallback(async (chatId: string) => {
    await queryClient.invalidateQueries({ queryKey: qk.chat(userId, workspaceId, chatId) });
    if (selected.current.workspace === workspaceId && selected.current.chat === chatId) {
      setStreamGeneration(value => value + 1);
    }
  }, [queryClient, userId, workspaceId]);

  // A lost workspace holds no live stream either: the teardown below already
  // closed it when the flag landed, and nothing resubscribes until a session
  // refresh clears the flag.
  const workspaceGone = workspaceLost.includes(workspaceId);
  // Live readiness follows the staged transcript, not the full snapshot:
  // the stream opens as soon as the conversation identity is known instead
  // of waiting on unrelated run/question metadata. The cursor still comes
  // from committed cache state (0 until the full snapshot lands), so opening
  // early replays from scratch and merges dedupe — never a gap.
  const readyChatId = snapshot && !accessLost && !workspaceGone ? snapshot.detail.chat.id : null;
  useEffect(() => {
    if (!readyChatId || accessLost || !isVisible) {
      // Hidden tabs keep no live stream: the teardown below already closed
      // it, and the status must not claim a live connection.
      if (!isVisible) setStreamStatus('closed');
      return;
    }
    const generation = epoch.current;
    const cursor = queryClient.getQueryData<ChatSnapshot>(qk.chat(userId, workspaceId, readyChatId))?.cursor ?? 0;
    const subscription = subscribeToActivity(api.activityStreamUrl(workspaceId, readyChatId, cursor), {
      onActivity: activity => {
        if (generation !== epoch.current || activity.workspace_id !== workspaceId || activity.chat_id !== readyChatId) return;
        lastLiveEventAt.current[readyChatId] = Date.now();
        // Transient preview frames bypass the snapshot: fold into the
        // memory-only buffer with no refetch and no cursor advance.
        if (activity.type === 'text_preview') {
          setTransients(previous => mergeTransientPreview(previous, activity));
          return;
        }
        const key = qk.chat(userId, workspaceId, readyChatId);
        queryClient.setQueryData<ChatSnapshot>(key, previous =>
          previous ? applyActivitySnapshot(previous, activity) : previous);
        const knownRun = queryClient.getQueryData<ChatSnapshot>(key)?.runs[activity.run_id];
        switch (activity.type) {
          case 'text_chunk': {
            // Durable coverage replaces preview rounds as they persist.
            const round = (activity.payload as { round_index?: unknown })?.round_index;
            if (typeof round === 'number') {
              setTransients(previous => dropCoveredTransientPreview(previous, activity.run_id, round));
            }
            if (activity.run_id && !knownRun) refreshRun(workspaceId, readyChatId, activity.run_id);
            break;
          }
          case 'reasoning_summary':
            if (activity.run_id && !knownRun) refreshRun(workspaceId, readyChatId, activity.run_id);
            break;
          case 'step_started':
          case 'step_finished':
          case 'action_applied':
          case 'action_reverted':
          case 'run_started':
            refreshRun(workspaceId, readyChatId, activity.run_id);
            break;
          case 'message_accepted': {
            // Own sends already filed locally from the acceptance receipt, so
            // a resubscribe replaying the acceptance row must not re-download
            // the transcript. Anything not yet filed (teammate, Telegram, or
            // other-tab messages) still refreshes; an event racing the local
            // patch also refreshes, and the patch merges by id afterwards.
            const acceptedClientId = (activity.payload as { client_message_id?: unknown } | null)?.client_message_id;
            const filed = typeof acceptedClientId === 'string' && acceptedClientId !== ''
              && (queryClient.getQueryData<ChatSnapshot>(key)?.messages.some(
                message => message.client_message_id === acceptedClientId,
              ) ?? false);
            if (!filed) refreshMessages(workspaceId, readyChatId);
            break;
          }
          case 'answer_saved': {
            // The committed reply files locally from the event: no transcript
            // refetch. Older shapes or truncated text fall back to refetch.
            const filed = queryClient.getQueryData<ChatSnapshot>(key);
            const reconciled = filed ? applyAnswerSaved(filed, activity) : null;
            if (reconciled) queryClient.setQueryData<ChatSnapshot>(key, reconciled);
            else refreshMessages(workspaceId, readyChatId);
            break;
          }
          case 'clarification_required':
            refreshQuestions(readyChatId);
            refreshRun(workspaceId, readyChatId, activity.run_id);
            break;
          case 'partial_failure':
          case 'run_finished': {
            refreshRun(workspaceId, readyChatId, activity.run_id);
            setTransients(previous => clearTransientPreview(previous, activity.run_id));
            // The reply message is already filed locally from its answer_saved
            // event; refetch messages only when it is still missing (e.g. an
            // older client shape or a reconnect that skipped the event).
            const view = queryClient.getQueryData<ChatSnapshot>(key);
            const hasReply = view?.messages.some(
              message => message.run_id === activity.run_id && message.author_kind !== 'member',
            ) ?? false;
            if (!hasReply) refreshMessages(workspaceId, readyChatId);
            break;
          }
        }
      },
      onStatus: status => { if (generation === epoch.current) setStreamStatus(status); },
      onResyncRequired: () => { void resyncChat(readyChatId); },
      // Membership revocation is workspace-scoped: drop this workspace's
      // snapshots and park it, but keep the session, sibling workspaces and
      // every unsent entry. It must never become a user-wide purge.
      onMembershipRevoked: () => { if (generation === epoch.current) loseWorkspace(workspaceId, 'revoked'); },
    });
    return () => subscription.close();
  }, [readyChatId, workspaceId, accessLost, workspaceLost, isVisible, streamGeneration, loseAccess, loseWorkspace, queryClient, userId, refreshRun, refreshMessages, refreshQuestions, resyncChat]);

  const workspaceName = workspaces.find(workspace => workspace.id === workspaceId)?.name ?? 'Workspace';
  const activeRuns = Object.values(snapshot?.runs ?? {}).filter(run => ['queued', 'running'].includes(run.status));
  const running = activeRuns.find(run => run.status === 'running') ?? activeRuns[0];
  // Answer intent lives in the explicit question panel; the ordinary
  // composer never inherits it. replyId opens a panel (explicit action or
  // a fresh arrival); no selection ever flows into main send.
  // When the question-list read failed, the list is an outage, not an
  // authoritative empty: a run-known pending question still resolves from
  // run details (same answerability rule the server applies) so the answer
  // path stays usable, with an explicit list retry beside it.
  const openQuestion = replyId
    ? snapshot?.questions.find(question => question.id === replyId)
      ?? (snapshot?.questionsFailed ? runKnownQuestion(snapshot, replyId, userId) : undefined)
    : undefined;
  const panelQuestion = openQuestion && openQuestion.status === 'pending' && openQuestion.answerable_by_caller
    ? openQuestion
    : undefined;
  // Explicit "Answer question" requests focus; arrival alone never steals it.
  const [panelFocusId, setPanelFocusId] = useState<string | null>(null);
  const [panelFocusSignal, setPanelFocusSignal] = useState(0);
  const openQuestionPanel = useCallback((questionId: string, focus: boolean) => {
    setReplyId(questionId);
    if (focus) {
      setPanelFocusId(questionId);
      setPanelFocusSignal(signal => signal + 1);
    }
  }, []);

  // Skip defers and close hides: neither resolves the question, cancels a
  // run, guesses a business field, or opens another question. No backend
  // Skip command is needed for deferral; the pending callout stays reachable.
  const dismissQuestion = useCallback((questionId: string) => {
    setDismissedClarificationIds(ids => (ids.includes(questionId) ? ids : [...ids, questionId]));
    setReplyId(current => (current === questionId ? null : current));
  }, []);

  // Fresh arrivals may open the panel once; closing or Skip never rotates
  // through older questions, and an open panel never switches underneath.
  const knownQuestionIds = useRef<{ chat: string | null; ids: Set<string> }>({ chat: null, ids: new Set() });
  useEffect(() => {
    const chatKey = activeChatId ?? 'new';
    if (knownQuestionIds.current.chat !== chatKey) knownQuestionIds.current = { chat: chatKey, ids: new Set() };
    const known = knownQuestionIds.current.ids;
    const fresh = (snapshot?.questions ?? []).filter(question =>
      question.status === 'pending' && question.answerable_by_caller
      && !dismissedClarificationIds.includes(question.id) && !known.has(question.id));
    for (const question of fresh) known.add(question.id);
    const latest = fresh.length > 0 ? fresh[fresh.length - 1] : undefined;
    if (replyId === null && latest) setReplyId(latest.id);
  }, [snapshot, replyId, dismissedClarificationIds, activeChatId]);

  // A resolved or superseded question closes its panel instead of accepting
  // a stale answer; the payload guard below is the backstop, not the router.
  // A failed list read never closes the panel: the empty list is an outage,
  // and the run-known fallback above keeps the answer path usable.
  useEffect(() => {
    if (replyId !== null && snapshot && !snapshot.questionsFailed && !snapshot.questions.some(question => question.id === replyId && question.status === 'pending' && question.answerable_by_caller)) {
      setReplyId(null);
    }
  }, [snapshot, replyId]);

  // Last live data event per chat: the fallback poll below only fires when
  // the stream has gone quiet, never while events are flowing.
  const lastLiveEventAt = useRef<Record<string, number>>({});

  useEffect(() => {
    // No backstop polling from a hidden tab: the foreground resubscribe
    // replays missed events from the snapshot cursor instead.
    if (!running || accessLost || !workspaceId || !activeChatId || !isVisible) return;
    const runId = running.run.id;
    const chatKey = activeChatId;
    const timer = setTimeout(() => {
      // Backstop only: live events already converge an active stream, so a
      // recent event means polling would just re-download the same state.
      if (Date.now() - (lastLiveEventAt.current[chatKey] ?? 0) < 2500) return;
      refreshRun(workspaceId, activeChatId, runId);
      refreshMessages(workspaceId, activeChatId);
    }, 2500);
    return () => clearTimeout(timer);
  }, [running, accessLost, workspaceId, activeChatId, isVisible, refreshRun, refreshMessages]);

  const switchWorkspace = useCallback((id: string) => { if (!workspaces.some(workspace => workspace.id === id)) return; let last: string | null = null; try { last = sessionStorage.getItem(`otis:view:${userId}:${id}`); } catch { /* start new */ } navigate(id, last === 'new' ? null : last); }, [workspaces, userId, navigate]);

  const deliverEntry = useCallback(async (entry: OutboxEntry): Promise<boolean> => {
    // One POST per UUID even across remounts; the server dedupe is the backstop.
    if (!claimDelivery(entry.clientId)) return false;
    // A concurrent pass may have saved, failed, rebound, or pruned this
    // entry after it was selected: re-read fresh and never POST for a
    // settled or missing entry. Payload fields are immutable; chat mapping
    // is taken fresh so two passes cannot fork a new chat either.
    const fresh = getOutboxEntry(entry.clientId);
    if (!fresh || fresh.state === 'saved') {
      releaseDelivery(entry.clientId);
      return true;
    }
    entry = fresh;
    let generation = epoch.current;
    // Transport scope is the entry's immutable scope: the flush owner may
    // deliver entries from workspaces other than the current view, and those
    // business writes must never be rerouted into the viewed workspace.
    // Membership stays live because the worker revalidates session,
    // membership and authorship on every acceptance attempt; no client-side
    // snapshot is consulted as authority for transport.
    const entryUserId = entry.userId;
    const entryWorkspaceId = entry.workspaceId;
    // A clarification answer for a question this client already knows is
    // closed must never POST: the server would reject it and each retry
    // would mint orphan answer rows. Fail open when the snapshot is absent.
    // A failed list read is an outage, not a verdict: run-known pending
    // questions stay sendable. Releases the delivery claim like every other
    // early return.
    if (entry.clarificationId && entry.chatId) {
      const known = queryClient.getQueryData<ChatSnapshot>(qk.chat(entryUserId, entryWorkspaceId, entry.chatId));
      const listedOpen = known?.questions.some(question => question.id === entry.clarificationId && question.status === 'pending') ?? false;
      const runOpen = !listedOpen && (known?.questionsFailed ?? false) && known
        ? runKnownQuestion(known, entry.clarificationId, entryUserId) !== undefined
        : false;
      if (known && !listedOpen && !runOpen) {
        markOutboxFailed(entry.clientId, {
          code: 'question_closed',
          message: 'That question is no longer open.',
        });
        if (replyId === entry.clarificationId) setReplyId(null);
        releaseDelivery(entry.clientId);
        return false;
      }
    }
    // Visible UI updates additionally require the current view.
    const sameView = (chatId: string) =>
      generation === epoch.current
      && selected.current.workspace === entryWorkspaceId
      && selected.current.chat === chatId;
    // The operation's own route target. External route moves (browser
    // Back/Forward) do not bump epoch, so the failure path below must fence
    // by target as well: a stale auth failure must never close or clear the
    // chat the reader is actually on. Kept in step with chatId resolution.
    let targetChat: string | null = entry.chatId;
    // Originating draft session, observed before any await: a logout racing
    // chat creation must not let the draft move resurrect purged input.
    const draftFlight = draftSession(`otis:draft:${entryUserId}:${entryWorkspaceId}:new`);
    try {
      let chatId = entry.chatId;
      if (!chatId) {
        const mapped = entry.newChatKey ? getNewChatMapping(entry.newChatKey, entryUserId) : undefined;
        if (mapped) {
          updateOutboxChatId(entry.clientId, mapped);
          chatId = mapped; targetChat = mapped;
        } else {
          const created = await api.createChat(entryWorkspaceId, `new-${entry.newChatKey}`, entryUserId);
          chatId = created.chat.id; targetChat = chatId;
          if (generation === epoch.current && selected.current.workspace === entryWorkspaceId && !selected.current.chat) {
            // Carry a newer pending draft onto the created chat; the sent
            // text itself is consumed either way.
            await moveDraft(`otis:draft:${entryUserId}:${entryWorkspaceId}:new`, `otis:draft:${entryUserId}:${entryWorkspaceId}:${chatId}`, entry.text, draftFlight ?? undefined);
            // Bind and navigate synchronously: no paint may observe the entry
            // as belonging to neither view. The sidebar refresh is kicked
            // independently and must never gate the submit.
            updateOutboxChatId(entry.clientId, chatId);
            if (entry.newChatKey) setNewChatMapping(entry.newChatKey, chatId, entryUserId);
            navigate(entryWorkspaceId, chatId);
            void queryClient.invalidateQueries({ queryKey: qk.chats(entryUserId, entryWorkspaceId, 'mine') });
            // Self-created navigation belongs to this operation: re-anchor so
            // the accept/reject below is not mistaken for a scope move.
            generation = epoch.current;
          } else {
            updateOutboxChatId(entry.clientId, chatId);
            if (entry.newChatKey) setNewChatMapping(entry.newChatKey, chatId, entryUserId);
            // Created away from its view: still refresh that workspace's
            // sidebar cache so returning shows the chat without a reload.
            void queryClient.invalidateQueries({ queryKey: qk.chats(entryUserId, entryWorkspaceId, 'mine') });
          }
        }
      }
      if (!chatId) throw new Error('Failed to resolve conversation');
      debugLog('send', 'starting', { operationId: entry.clientId, chatId, chars: entry.text.length, clarificationId: entry.clarificationId ?? null });
      const accepted = await api.sendMessage(entryWorkspaceId, chatId, entry.clientId, entry.text, entry.clarificationId, entry.mediaId, entryUserId, ...(entry.imageMediaIds?.length ? [entry.imageMediaIds] : []));
      debugLog('send', 'accepted; run queued server-side', { chatId, message_id: accepted.message_id, run_id: accepted.run_id, sequence: accepted.acceptance_sequence });
      markOutboxSaved(entry.clientId, { messageId: accepted.message_id, runId: accepted.run_id, sequence: accepted.acceptance_sequence });
      if (!sameView(chatId)) return true;
      setError(null);
      // Late acceptance reconciles only its own submission: an answered
      // question closes its panel, while ordinary chat never disturbs an
      // open panel, its dismissals, or another question's draft.
      if (entry.clarificationId) {
        if (entry.clarificationId === replyId) setReplyId(null);
      } else {
        setDraftValue(null);
      }
      // Late acceptance only reconciles: follow was already taken at the
      // local send moment, and a released reader must never be yanked back.
      // The accepted message files locally from the receipt (same client
      // UUID replaces the echo, no duplicate) instead of a full transcript
      // refetch; only the single run detail refreshes for Working state.
      // An older snapshot read still in flight (initial load, resync,
      // reconnect) is cancelled first: its stale payload must never land
      // over this newer acceptance. Cancellation is scoped to this chat, so
      // sibling snapshots keep loading.
      const acceptedAt = new Date().toISOString();
      const acceptedKey = qk.chat(entryUserId, entryWorkspaceId, chatId);
      await queryClient.cancelQueries({ queryKey: acceptedKey });
      queryClient.setQueryData<ChatSnapshot>(acceptedKey, previous =>
        previous
          ? applyAcceptedMessage(previous, {
            id: accepted.message_id,
            workspace_id: entryWorkspaceId,
            chat_id: chatId,
            author_user_id: entryUserId,
            client_message_id: entry.clientId,
            content_text: entry.text || (entry.mediaId ? 'Voice note' : entry.imageMediaIds?.length ? 'Photos' : ''),
            media_id: entry.mediaId ?? null,
            image_media_ids: entry.imageMediaIds ?? null,
            run_id: accepted.run_id,
            sequence: accepted.acceptance_sequence,
            created_at: acceptedAt,
          })
          : previous);
      if (!queryClient.getQueryData<ChatSnapshot>(acceptedKey)) {
        // The patch had no committed snapshot to land on and the fetch above
        // was cancelled: refetch so the transcript the server already holds
        // still arrives instead of hanging without data or fetch.
        void queryClient.invalidateQueries({ queryKey: acceptedKey });
      }
      refreshRun(entryWorkspaceId, chatId, accepted.run_id);
      void queryClient.invalidateQueries({ queryKey: qk.chats(entryUserId, entryWorkspaceId, 'mine') });
      if (accepted.selected_workspace_id && workspaces.some(workspace => workspace.id === accepted.selected_workspace_id)) { switchWorkspace(accepted.selected_workspace_id); return true; }
      return true;
    } catch (err) {
      debugLog('send', 'failed before acceptance', { operationId: entry.clientId, status: err instanceof ApiError ? err.status : null, code: err instanceof ApiError ? err.code : null });
      if (generation !== epoch.current) return false;
      // Programmatic navigations bump epoch above; external route moves do
      // not, so fence them by the operation's own target instead. Recording
      // the failure below is scope-safe (module state keyed by client UUID,
      // rendered only under its own chat), so it happens for every scope;
      // only closing the view is fenced, and therefore only ever closes the
      // view its failure belongs to.
      const scopeMatchesView = selected.current.workspace === entryWorkspaceId && selected.current.chat === targetChat;
      // Only a dead session closes the view. A 403/404 (removed member,
      // deleted workspace, not the chat author) files the server's verdict
      // as a failed bubble with Retry: the entry, the session and every
      // sibling workspace survive it.
      if (err instanceof ApiError && err.status === 401 && scopeMatchesView) {
        loseAccess();
        return false;
      }
      if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
        markOutboxFailed(entry.clientId, {
          code: err.code,
          message: err.message,
        });
        return false;
      }
      // Stored as a failed entry with attached Retry; no global or composer
      // error may duplicate it. Scope/auth/snapshot errors keep their paths.
      // Transient failures additionally schedule one bounded automatic retry
      // each (Retry-After honored); permanent failures stay failed until the
      // user retries or discards. Stale clarifications never reroute.
      const failureCode = err instanceof ApiError ? err.code : 'transport';
      const failureMessage = err instanceof ApiError ? err.message : 'Message not confirmed. It is kept in the conversation with Retry.';
      markOutboxFailed(entry.clientId, { code: failureCode, message: failureMessage });
      if ((failureCode === 'already_resolved' || failureCode === 'question_closed') && entry.clarificationId) {
        // The question is dead by server verdict: converge the view (the
        // answer text was still accepted server-side and reconciles by
        // client UUID, so no duplicate bubble) and leave the dead
        // "Replying to" mode instead of inviting another doomed retry.
        const deadChat = targetChat ?? entry.chatId ?? '';
        if (deadChat) {
          const view = queryClient.getQueryData<ChatSnapshot>(qk.chat(entryUserId, entryWorkspaceId, deadChat));
          const deadRun = view ? Object.values(view.runs).find(candidate => candidate.pending_clarification?.id === entry.clarificationId) : undefined;
          if (deadRun) refreshRun(entryWorkspaceId, deadChat, deadRun.run.id);
          refreshMessages(entryWorkspaceId, deadChat);
          refreshQuestions(deadChat);
        }
        if (replyId === entry.clarificationId) setReplyId(null);
      } else if (failureCode === 'resume_failed' && entry.clarificationId) {
        const failedChat = targetChat ?? entry.chatId ?? '';
        if (failedChat) refreshQuestions(failedChat);
      }
      if (classifySendError(err) === 'transient') {
        const attempts = getOutboxEntry(entry.clientId)?.attempts ?? entry.attempts + 1;
        deferOutboxRetry(entry.clientId, new Date(Date.now() + computeBackoffMs(attempts, err instanceof ApiError ? err.retryAfterMs : undefined)).toISOString());
      }
      return false;
    } finally {
      releaseDelivery(entry.clientId);
    }
  }, [epoch, queryClient, userId, workspaceId, workspaces, navigate, loseAccess, refreshRun, refreshMessages, refreshQuestions, replyId, switchWorkspace]);

  const send = useCallback(async (text: string, imageMediaIds?: string[]): Promise<boolean> => {
    if (readOnly || accessLost) return false;
    // Ordinary chat never carries a question identity, even with a panel
    // open: only the panel's explicit submit may attach clarificationId.
    createOutboxEntry({
      userId,
      workspaceId,
      chatId: activeChatId,
      text,
      ...(imageMediaIds && imageMediaIds.length > 0 ? { imageMediaIds } : {}),
    });
    // Explicit send-triggered return to the newly sent message, taken at the
    // local acceptance moment. Delayed HTTP acceptance, retries and
    // reconciled snapshots must never force follow on their own.
    setFollowSignal(value => value + 1);
    // Local acceptance is instant (the echo above renders before any network
    // work below), while network acceptance dispatch joins the single
    // per-chat/claim flush path: a follow-up submit never overtakes a still-
    // unacknowledged first POST, and the flush runs promptly when uncontended.
    requestFlush('send');
    return true;
  }, [readOnly, accessLost, userId, workspaceId, activeChatId]);

  /**
   * Explicit question answer (question plan step 1): the sole path that may
   * attach a clarificationId. Target, text and delivery UUID are captured
   * before any state clears; retry reuses the same outbox payload. Returns
   * false without sending when the question is no longer answerable.
   */
  const answerQuestion = useCallback((questionId: string, text: string): boolean => {
    if (readOnly || accessLost || !activeChatId) return false;
    const current = queryClient.getQueryData<ChatSnapshot>(qk.chat(userId, workspaceId, activeChatId));
    if (current) {
      const listed = current.questions.some(question => question.id === questionId && question.status === 'pending' && question.answerable_by_caller);
      // A failed list read is an outage, not a verdict: the run-known
      // fallback carries the same answerability rule as the panel.
      const fallback = !listed && current.questionsFailed
        ? runKnownQuestion(current, questionId, userId)
        : undefined;
      if (!listed && !(fallback && fallback.answerable_by_caller)) return false;
    }
    createOutboxEntry({
      userId,
      workspaceId,
      chatId: activeChatId,
      text,
      clarificationId: questionId,
    });
    setFollowSignal(value => value + 1);
    requestFlush('send');
    return true;
  }, [readOnly, accessLost, activeChatId, queryClient, userId, workspaceId]);

  /**
   * Voice send owner (010): the recorder hands over the finalized media with
   * one stable client UUID. The entry carries its own immutable scope, so a
   * view move during delivery cannot reroute it; the recorder only deletes
   * local bytes after this promise resolves on durable acceptance.
   */
  const voiceSend = useCallback(async (result: {
    clientMessageId: string;
    media: VoiceMediaSummary;
    chatId?: string;
  }): Promise<void> => {
    if (accessLost) throw new Error('Voice send is unavailable.');
    let targetChatId = result.chatId ?? activeChatId;
    if (!targetChatId) {
      const pendingKey = getOrCreatePendingNewChat(userId, workspaceId);
      const created = await api.createChat(workspaceId, `new-${pendingKey}`, userId);
      targetChatId = created.chat.id;
      setNewChatMapping(pendingKey, targetChatId, userId);
    }
    const existing = getOutboxEntry(result.clientMessageId);
    if (existing?.state === 'saved') return;
    if (existing?.state === 'failed') {
      // Same identity: retry the existing entry, never a second message.
      retryOutboxEntry(result.clientMessageId);
    } else if (!existing) {
      createOutboxEntry({
        clientId: result.clientMessageId,
        userId,
        workspaceId,
        chatId: targetChatId,
        text: '',
        mediaId: result.media.media_id,
      });
      // Explicit send-triggered return to the newly sent message, taken at
      // the local acceptance moment, exactly like the text path.
      setFollowSignal(value => value + 1);
    }
    if (!activeChatId && targetChatId) {
      navigate(workspaceId, targetChatId);
      void queryClient.invalidateQueries({ queryKey: qk.chats(userId, workspaceId, 'mine') });
    }
    requestFlush('voice');
    const outcome = await awaitOutboxSettlement(result.clientMessageId);
    if (outcome === 'failed') throw new Error('Voice message not accepted.');
  }, [accessLost, activeChatId, userId, workspaceId, navigate, queryClient]);

  const retryMessage = useCallback((clientId: string): void => {
    if (!retryOutboxEntry(clientId)) return;
    requestFlush('retry');
  }, []);

  // Terminal failed/partial run retry through the server owner: receipts
  // and steps survive server-side, so the fresh attempt resumes instead of
  // repeating. Authorship is enforced server-side; a teammate sees the
  // server's verdict instead of a dead button.
  const retryRun = useCallback(async (runId: string): Promise<void> => {
    try {
      const result = await api.retryRun(workspaceId, runId);
      if (!result.retried) {
        toast('That run is already finished or running again.');
        return;
      }
      toast('Run queued again. Previous progress is kept.');
      if (activeChatId) {
        refreshRun(workspaceId, activeChatId, runId);
        void resyncChat(activeChatId);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not retry this run. Try again.');
    }
  }, [workspaceId, activeChatId, refreshRun, resyncChat]);

  /**
   * Photo attachments (Slice 4): the composer hands over local files with
   * previews; uploads need a real chat first, so a first message ensures the
   * conversation exactly like the voice path, then finalizes each file and
   * submits their server identities with the text.
   */
  const imageTransport = useMemo(() => createWorkerImageTransport(), []);
  const ensureChatForImages = useCallback(async (): Promise<string | null> => {
    if (activeChatId) return activeChatId;
    if (readOnly || accessLost) return null;
    const pendingKey = getOrCreatePendingNewChat(userId, workspaceId);
    const created = await api.createChat(workspaceId, `new-${pendingKey}`, userId);
    const chatId = created.chat.id;
    setNewChatMapping(pendingKey, chatId, userId);
    navigate(workspaceId, chatId);
    return chatId;
  }, [accessLost, activeChatId, navigate, readOnly, userId, workspaceId]);

  const discardMessage = useCallback((clientId: string): void => {
    // Local-only: accepted rows reconcile through snapshots and are kept.
    discardUnsentEntry(clientId);
  }, []);

  // The single flush owner for this browser/account: retries what is still
  // unsent on mount, online, foreground and after sends, through this
  // screen's single-attempt transport. A stable wrapper avoids re-registering
  // (and dropping scheduled retries) on every render.
  const deliverRef = useRef(deliverEntry);
  deliverRef.current = deliverEntry;
  useEffect(() => {
    let current = true;
    registerFlushOwner({
      userId,
      deliver: entry => deliverRef.current(entry),
      isCurrent: () => current,
    });
    // User-scoped restore runs where the identity is known; the flush wake
    // after it delivers whatever came back, with original UUIDs.
    void rehydrateOutbox(userId).finally(() => {
      if (current) requestFlush('rehydrated');
    });
    return () => {
      current = false;
      unregisterFlushOwner(userId);
    };
  }, [userId]);

  const applyCommand = useCallback(async (text: string): Promise<boolean> => {
    if (readOnly || accessLost || controlLock.current) return false;

    modelRequest.current++;
    controlLock.current = true; setControlPending(true);
    let generation = epoch.current;
    const sameTarget = (chatId: string) =>
      generation === epoch.current
      && selected.current.workspace === workspaceId
      && selected.current.chat === chatId;
    try {
      const id = controlOperation.current?.text === text ? controlOperation.current.id : crypto.randomUUID();
      const knownChat = controlOperation.current?.text === text ? controlOperation.current.chatId : null;
      let chatId = knownChat ?? activeChatId;
      if (!chatId) {
        const pendingKey = getOrCreatePendingNewChat(userId, workspaceId);
        const created = await api.createChat(workspaceId, `new-${pendingKey}`, userId);
        chatId = created.chat.id;
        setNewChatMapping(pendingKey, chatId, userId);
        if (generation === epoch.current && !selected.current.chat) {
          navigate(workspaceId, chatId, true);
          void queryClient.invalidateQueries({ queryKey: qk.chats(userId, workspaceId, 'mine') });
          // Self-created navigation belongs to this operation: re-anchor.
          generation = epoch.current;
        }
      }

      controlOperation.current = { id, text, chatId };
      const applied = await api.executeCommand(workspaceId, chatId, id, text);
      if (!sameTarget(chatId)) return true;
      if (applied.selected_workspace_id && workspaces.some(workspace => workspace.id === applied.selected_workspace_id)) { switchWorkspace(applied.selected_workspace_id); return true; }
      const detail = await api.getChat(workspaceId, chatId);
      if (!sameTarget(chatId)) return true;
      queryClient.setQueryData<ChatSnapshot>(qk.chat(userId, workspaceId, chatId), previous =>
        previous ? applyDetail(previous, detail) : previous);
      setModelRevision(value => value + 1);
      controlOperation.current = null;
      if (!/^\/(model|thinking|workspace)\s+\S/i.test(text) && applied.reply) setControlResult(applied.reply);
      return true;
    } catch (err) {
      if (generation === epoch.current) toast.error(err instanceof ApiError && err.status === 422 ? err.message : 'Could not apply the command. Try again.');
      return false;
    } finally { controlLock.current = false; setControlPending(false); }
  }, [readOnly, accessLost, activeChatId, workspaceId, workspaces, userId, queryClient, navigate, loseAccess, switchWorkspace]);

  const loadingOlderRef = useRef(false);
  const loadOlder = useCallback(async () => {
    if (!fullSnapshot?.older || !activeChatId || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setOlderError(null);
    setLoadingOlder(true); const generation = epoch.current;
    try {
      const page = await api.listMessages(workspaceId, activeChatId, fullSnapshot.older);
      const ids = [...new Set(page.messages.flatMap(message => message.run_id ? [message.run_id] : []))];
      const runs = ids.length > 0 ? (await api.runs(workspaceId, ids)).runs : [];
      if (generation !== epoch.current || selected.current.chat !== activeChatId) return;
      queryClient.setQueryData<ChatSnapshot>(qk.chat(userId, workspaceId, activeChatId), previous => {
        if (!previous) return previous;
        const withOlder = applyOlderMessages(previous, page.messages, page.next_before_sequence);
        return runs.reduce(applyRunSnapshot, withOlder);
      });
    } catch {
      // In-place retry: the same cursor is kept, nothing is discarded.
      if (generation === epoch.current) setOlderError('Could not load earlier messages. Try again.');
    } finally { loadingOlderRef.current = false; setLoadingOlder(false); }
  }, [fullSnapshot, activeChatId, workspaceId, userId, queryClient]);
  const loadMoreChats = useCallback(async () => {
    const generation = epoch.current;
    try {
      await Promise.all([
        fetchMoreChats(queryClient, userId, workspaceId, 'mine'),
        fetchMoreChats(queryClient, userId, workspaceId, 'team'),
      ]);
      if (generation !== epoch.current) return;
    } catch { setError('Could not load more conversations.'); }
  }, [queryClient, userId, workspaceId]);

  const handleOpenRename = useCallback((chatId: string, currentTitle: string) => {
    setRenameTarget({ id: chatId, title: currentTitle });
    setRenameTitle(currentTitle);
  }, []);

  const handleConfirmRename = useCallback(async () => {
    if (!renameTarget || renamingChat) return;
    const trimmed = renameTitle.trim();
    if (!trimmed) return;
    setRenamingChat(true);
    try {
      await api.renameChat(workspaceId, renameTarget.id, trimmed);
      void queryClient.invalidateQueries({ queryKey: qk.chats(userId, workspaceId, 'mine') });
      void queryClient.invalidateQueries({ queryKey: qk.chat(userId, workspaceId, renameTarget.id) });
      toast.success('Conversation renamed');
      setRenameTarget(null);
    } catch {
      toast.error('Could not rename conversation');
    } finally {
      setRenamingChat(false);
    }
  }, [renameTarget, renamingChat, renameTitle, workspaceId, userId, queryClient]);

  const handleOpenDelete = useCallback((chatId: string, currentTitle: string) => {
    setDeleteTarget({ id: chatId, title: currentTitle });
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget || deletingChat) return;
    setDeletingChat(true);
    try {
      await api.deleteChat(workspaceId, deleteTarget.id);
      void queryClient.invalidateQueries({ queryKey: qk.chats(userId, workspaceId, 'mine') });
      void queryClient.invalidateQueries({ queryKey: qk.chats(userId, workspaceId, 'team') });
      if (activeChatId === deleteTarget.id) {
        navigate(workspaceId, null);
      }
      toast.success('Conversation deleted');
      setDeleteTarget(null);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || deleteTarget.id.startsWith('new-'))) {
        void queryClient.invalidateQueries({ queryKey: qk.chats(userId, workspaceId, 'mine') });
        void queryClient.invalidateQueries({ queryKey: qk.chats(userId, workspaceId, 'team') });
        if (activeChatId === deleteTarget.id) {
          navigate(workspaceId, null);
        }
        toast.success('Conversation deleted');
        setDeleteTarget(null);
      } else {
        toast.error('Could not delete conversation');
      }
    } finally {
      setDeletingChat(false);
    }
  }, [deleteTarget, deletingChat, workspaceId, userId, activeChatId, navigate, queryClient]);


  const handleConfirmCreateWorkspace = useCallback(async () => {
    const trimmed = newWorkspaceName.trim();
    if (!trimmed || creatingWs) return;
    setCreatingWs(true);
    try {
      const result = await api.createWorkspace(trimmed);
      await onRefreshSession?.();
      navigate(result.workspace.id, null);
      toast.success('Workspace created');
      setCreateWorkspaceOpen(false);
      setNewWorkspaceName('');
    } catch {
      toast.error('Could not create workspace');
    } finally {
      setCreatingWs(false);
    }
  }, [newWorkspaceName, creatingWs, onRefreshSession, navigate]);

  const handleWorkspaceRenamed = useCallback(async () => {
    await onRefreshSession?.();
  }, [onRefreshSession]);

  const handleWorkspaceDeleted = useCallback(async () => {
    await onRefreshSession?.();
    const remaining = workspaces.filter(w => w.id !== workspaceId);
    if (remaining.length > 0 && remaining[0]) {
      navigate(remaining[0].id, null);
    }
  }, [onRefreshSession, workspaces, workspaceId, navigate]);

  const handleWorkspaceCreated = useCallback(async (newId: string) => {
    await onRefreshSession?.();
    navigate(newId, null);
  }, [onRefreshSession, navigate]);

  const navProps = {
    workspaceId,
    workspaceName,
    workspaces,
    ownChats,
    teamChats,
    members,
    activeChatId,
    loading: navLoading,
    onSelectChat: (id: string) => navigate(workspaceId, id),
    onNewChat: () => navigate(workspaceId, null),
    onSwitchWorkspace: switchWorkspace,
    onOpenSettings: () => { setDrawerOpen(false); setSettingsOpen(true); },
    hasMore: Boolean(mineQuery.data?.nextCursor || teamQuery.data?.nextCursor),
    onLoadMore: () => void loadMoreChats(),
    onRenameChat: handleOpenRename,
    onDeleteChat: handleOpenDelete,
    onCreateWorkspace: () => { setNewWorkspaceName(''); setCreateWorkspaceOpen(true); },
  };

  // Loading reflects an actual in-flight persisted-chat snapshot fetch.
  // A fresh chat's disabled query is pending-but-idle, so it must show the
  // approved empty composition immediately; access loss or an error must
  // never leave an endless opening spinner.
  const loading = Boolean(activeChatId) && !accessLost && snapshotQuery.isLoading && !snapshot;
  const currentDetail = snapshot?.detail ?? null;
  const otherWorkspaces = workspaces.filter(workspace => workspace.id !== workspaceId);
  const switchAway = () => {
    if (otherWorkspaces.length > 0) switchWorkspace(otherWorkspaces[0]!.id);
  };

  return <div className="otis-shell h-dvh bg-background text-foreground flex">
    <Toaster theme="dark" position="top-center" visibleToasts={2} closeButton toastOptions={{ className: 'otis-toast', duration: 3000 }} offset={64}/>
    {!accessLost && <HistoryNav variant="sidebar" {...navProps}/>} {!accessLost && <HistoryNav variant="drawer" open={drawerOpen} {...navProps} onClose={() => setDrawerOpen(false)}/>}
    <main id="main-content" className="otis-main"><header className="otis-topbar flex h-12 items-center gap-2 border-b border-border px-4"><Button variant="ghost" size="icon" type="button" className="otis-iconbutton otis-topbar__menu" aria-label="Open history" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)} disabled={accessLost}><MenuIcon/></Button><div className="otis-topbar__identity"><h1 className="otis-topbar__title truncate text-sm font-medium" title={currentDetail?.chat.title ?? workspaceName}>{currentDetail?.chat.title ?? workspaceName}</h1><span className="otis-topbar__subtitle text-xs text-subtle">{readOnly ? `${currentDetail!.chat.author_display_name ?? members[currentDetail!.chat.author_user_id] ?? 'Teammate'} · read only` : activeChatId ? workspaceName : 'New conversation'}</span></div><div className="otis-topbar__actions"><ChatOverflow models={models} followsDefault={followsDefault} disabled={accessLost || readOnly} pending={controlPending} running={Boolean(running)} onCommand={applyCommand} onStop={running ? async () => { await api.stopRun(workspaceId, running.run.id); if (activeChatId) refreshRun(workspaceId, activeChatId, running.run.id); } : undefined} onRename={activeChatId && !readOnly ? () => handleOpenRename(activeChatId, currentDetail?.chat.title ?? '') : undefined} onDelete={activeChatId && !readOnly ? () => handleOpenDelete(activeChatId, currentDetail?.chat.title ?? '') : undefined}/><Button variant="ghost" size="icon" type="button" className="otis-iconbutton" aria-label="New chat" onClick={() => navigate(workspaceId, null)} disabled={accessLost}><ComposeIcon/></Button></div></header>
    {accessLost ? (
      <div className="otis-access"><h2 className="text-xl font-medium">Conversation unavailable</h2><p className="text-sm text-muted-foreground">Your session may have expired or your workspace access has changed. Private content has been closed.</p><Button variant="outline" type="button" onClick={() => location.reload()}>Reload access</Button><Button variant="secondary" type="button" onClick={onSignOut}>Sign out</Button></div>
    ) : workspaceGone ? (
      <div className="otis-access"><h2 className="text-xl font-medium">Workspace unavailable</h2><p className="text-sm text-muted-foreground">{workspaceName} is no longer available. You may have been removed, or it was deleted. Your other workspaces and unsent work are kept.</p><div className="flex gap-2">{otherWorkspaces.length > 0 && <Button variant="outline" type="button" onClick={switchAway}>Switch workspace</Button>}<Button variant="ghost" type="button" onClick={() => void refreshSession()}>Refresh session</Button></div></div>
    ) : chatNotFound ? (
      <div className="otis-access"><h2 className="text-xl font-medium">Conversation unavailable</h2><p className="text-sm text-muted-foreground">This conversation was not found or has been deleted.</p><Button variant="outline" type="button" onClick={() => navigate(workspaceId, null)}>Start new conversation</Button></div>
    ) : activeChatId && !snapshot && snapshotQuery.isError ? (
      <div className="otis-access"><h2 className="text-xl font-medium">Could not load conversation</h2><p className="text-sm text-muted-foreground">{error ?? 'A network or server error occurred.'}</p><div className="flex gap-2"><Button variant="outline" type="button" onClick={() => { setError(null); void snapshotQuery.refetch(); void resyncChat(activeChatId!); }}>Try again</Button><Button variant="ghost" type="button" onClick={() => navigate(workspaceId, null)}>Start new conversation</Button></div></div>
    ) : <div className="otis-chat">
      {streamStatus === 'resyncing' && <p className="otis-connection text-xs" role="status">Reconnecting to activity… Your conversation is retained.</p>}
      <Transcript key={`${workspaceId}:${activeChatId ?? 'new'}`} messages={derived.messages} members={members} currentUserId={userId} runs={snapshot?.runs ?? {}} activities={snapshot?.activities ?? []} steps={[]} transients={transients} delivery={derived.delivery} onRetryMessage={(clientId) => void retryMessage(clientId)} onRetryRun={readOnly ? undefined : (runId) => void retryRun(runId)} onRetryQuestions={activeChatId && snapshot?.questionsFailed ? () => refreshQuestions(activeChatId) : undefined} questionsFailed={snapshot?.questionsFailed ?? false} onDiscardMessage={discardMessage} onInspectSource={setSourceId} onInspectAction={setDetailActionId} onReply={readOnly ? undefined : (id) => openQuestionPanel(id, true)} onEditMessage={readOnly ? undefined : setDraftValue} loading={loading} hasOlder={Boolean(fullSnapshot?.older)} loadingOlder={loadingOlder} olderError={olderError} followSignal={followSignal} positionKey={`${userId}:${workspaceId}:${activeChatId ?? 'new'}`} onLoadOlder={() => void loadOlder()}/>
      {error && <div className="otis-chat-error text-sm" role="alert"><p>{error}</p>{activeChatId && !loading && <Button variant="ghost" size="sm" type="button" onClick={() => { setError(null); void resyncChat(activeChatId); }}>Reload conversation</Button>}</div>}
      {readOnly ? <div className="otis-readonly text-sm"><p>This is {currentDetail!.chat.author_display_name ?? members[currentDetail!.chat.author_user_id] ?? 'a teammate'}’s conversation.</p><Button variant="ghost" size="sm" type="button" onClick={() => navigate(workspaceId, ownChats[0]?.id ?? null)}>Continue in your own chat</Button></div> : <div ref={composerRef} className="otis-composer-slot"><div className="flex flex-col gap-2">{panelQuestion && activeChatId && <div className="mx-auto w-full max-w-[760px] px-4"><QuestionPanel key={panelQuestion.id} question={panelQuestion} draftKey={`otis:draft:${userId}:${workspaceId}:${activeChatId}:${panelQuestion.id}`} focusSignal={panelFocusId === panelQuestion.id ? panelFocusSignal : 0} onSubmit={(questionId, text) => answerQuestion(questionId, text)} onSkip={dismissQuestion} onClose={dismissQuestion}/></div>}<Composer key={`${workspaceId}:${userId}:${activeChatId ?? 'new'}`} draftKey={`otis:draft:${userId}:${workspaceId}:${activeChatId ?? 'new'}`} draftValue={draftValue} disabled={Boolean(activeChatId && !snapshot)} disabledReason={error ? 'Conversation unavailable' : 'Opening conversation…'} running={Boolean(running)} commands={commands} models={models} workspaces={workspaces} controlPending={controlPending} modelReady={models.some(model => model.is_current && model.available)} modelsLoading={modelsQuery.isLoading} modelsError={modelsQuery.isError ? (modelsQuery.error instanceof Error ? modelsQuery.error.message : 'Could not load models.') : undefined} onRetryModels={() => void modelsQuery.refetch()} voice={{ available: voiceAvailable, adapter: voiceAdapter, scope: { userId, workspaceId, chatId: activeChatId }, onSent: voiceSend }} images={{ available: !readOnly && !accessLost, workspaceId, chatId: activeChatId, onEnsureChat: ensureChatForImages, upload: request => uploadImageFile(imageTransport, request) }} onCommand={applyCommand} onStop={running ? async () => { await api.stopRun(workspaceId, running.run.id); if (activeChatId) refreshRun(workspaceId, activeChatId, running.run.id); } : undefined} onSend={send}/></div></div>}
    </div>}</main>
    {controlResult && <Overlay label="Command result" className="otis-overlay--settings" onClose={() => setControlResult(null)}><section className="otis-settings"><header className="otis-pane-header"><h2 className="text-base font-medium">Result</h2><Button variant="outline" size="sm" type="button" onClick={() => setControlResult(null)}>Close</Button></header><div className="otis-settings__content text-sm"><Markdown skipHtml disallowedElements={['img']}>{controlResult}</Markdown></div></section></Overlay>}
    {sourceId && <SourcePane workspaceId={workspaceId} memoryId={sourceId} onClose={() => setSourceId(null)} onAccessLost={loseAccess} onOpenChat={id => navigate(workspaceId, id)}/>} {detailActionId && <DetailPane onAccessLost={loseAccess} workspaceId={workspaceId} chatId={readOnly ? '' : activeChatId ?? ''} actionId={detailActionId} onClose={() => setDetailActionId(null)} onUndone={() => { if (activeChatId) void resyncChat(activeChatId); }}/>} {settingsOpen && <SettingsPane onAccessLost={loseAccess} workspaceId={workspaceId} workspaceName={workspaceName} members={members} models={models} currentUserId={userId} currentUserRole={workspaces.find(w => w.id === workspaceId)?.role as ('owner' | 'member') | undefined ?? 'member'} onUpdated={() => setModelRevision(value => value + 1)} onClose={() => setSettingsOpen(false)} onSignOut={onSignOut} onWorkspaceRenamed={handleWorkspaceRenamed} onWorkspaceDeleted={handleWorkspaceDeleted} onWorkspaceCreated={handleWorkspaceCreated}/>}
    {renameTarget && (
      <Overlay label="Rename conversation" className="otis-overlay--settings" onClose={() => setRenameTarget(null)}>
        <section className="otis-settings">
          <header className="otis-pane-header">
            <h2 className="text-base font-medium">Rename conversation</h2>
            <Button variant="ghost" size="icon" type="button" className="otis-iconbutton" aria-label="Close" onClick={() => setRenameTarget(null)}>
              <CloseIcon />
            </Button>
          </header>
          <form className="otis-settings__content text-sm" onSubmit={e => { e.preventDefault(); void handleConfirmRename(); }}>
            <label htmlFor="rename-chat-input" className="text-sm font-medium">Conversation title</label>
            <Input
              id="rename-chat-input"
              value={renameTitle}
              onChange={e => setRenameTitle(e.target.value)}
              className="mt-1"
            />
            <div className="flex items-center gap-2 mt-4 justify-end">
              <Button variant="ghost" size="sm" type="button" onClick={() => setRenameTarget(null)}>Cancel</Button>
              <Button size="sm" type="submit" disabled={renamingChat || !renameTitle.trim()}>{renamingChat ? 'Saving…' : 'Save'}</Button>
            </div>
          </form>
        </section>
      </Overlay>
    )}
    {deleteTarget && (
      <Overlay label="Delete conversation" className="otis-overlay--settings" onClose={() => setDeleteTarget(null)}>
        <section className="otis-settings">
          <header className="otis-pane-header">
            <h2 className="text-base font-medium">Delete conversation</h2>
            <Button variant="ghost" size="icon" type="button" className="otis-iconbutton" aria-label="Close" onClick={() => setDeleteTarget(null)}>
              <CloseIcon />
            </Button>
          </header>
          <div className="otis-settings__content text-sm">
            <p className="text-sm text-muted-foreground">Are you sure you want to delete &ldquo;{deleteTarget.title || 'Untitled conversation'}&rdquo;? This conversation cannot be restored.</p>
            <div className="flex items-center gap-2 mt-4 justify-end">
              <Button variant="ghost" size="sm" type="button" onClick={() => setDeleteTarget(null)}>Cancel</Button>
              <Button variant="destructive" size="sm" type="button" disabled={deletingChat} onClick={() => void handleConfirmDelete()}>{deletingChat ? 'Deleting…' : 'Delete'}</Button>
            </div>
          </div>
        </section>
      </Overlay>
    )}
    {createWorkspaceOpen && (
      <Overlay label="Create workspace" className="otis-overlay--settings" onClose={() => setCreateWorkspaceOpen(false)}>
        <section className="otis-settings">
          <header className="otis-pane-header">
            <h2 className="text-base font-medium">Create workspace</h2>
            <Button variant="ghost" size="icon" type="button" className="otis-iconbutton" aria-label="Close" onClick={() => setCreateWorkspaceOpen(false)}>
              <CloseIcon />
            </Button>
          </header>
          <form className="otis-settings__content text-sm" onSubmit={e => { e.preventDefault(); void handleConfirmCreateWorkspace(); }}>
            <label htmlFor="new-ws-input" className="text-sm font-medium">Workspace name</label>
            <Input
              id="new-ws-input"
              value={newWorkspaceName}
              onChange={e => setNewWorkspaceName(e.target.value)}
              placeholder="e.g. Acme Studio"
              className="mt-1"
            />
            <div className="flex items-center gap-2 mt-4 justify-end">
              <Button variant="ghost" size="sm" type="button" onClick={() => setCreateWorkspaceOpen(false)}>Cancel</Button>
              <Button size="sm" type="submit" disabled={creatingWs || !newWorkspaceName.trim()}>{creatingWs ? 'Creating…' : 'Create'}</Button>
            </div>
          </form>
        </section>
      </Overlay>
    )}
  </div>;
}
