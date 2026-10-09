/**
 * @otis/worker
 * Cloudflare Worker API & Durable Object router for Otis.
 */

import type { HealthResponse } from '@otis/contracts';
import { handleAuthSession, handleLogout } from './routes/auth.js';
import { handleGetMe } from './routes/me.js';
import {
  handleGetWorkspace,
  handleCreateWorkspace,
  handleUpdateWorkspace,
  handleDeleteWorkspace,
} from './routes/workspaces.js';
import {
  handleListChats,
  handleCreateChat,
  handleCreateMessage,
  handleUpdateChat,
  handleDeleteChat,
} from './routes/chats.js';
import { handleGetChatDetail, handleGetMessages } from './routes/chat.js';
import { handleExportWorkspace } from './routes/exports.js';
import { handleGetRecords, handleSaveRecords } from './routes/records.js';
import { handleEntityFileAction, handleGetEntityFile } from './routes/entities.js';
import { handleFollowUps } from './routes/followups.js';
import { handleGetActivity } from './routes/activity.js';
import { handleGetMemorySource, handleGetWorkspaceSource, handleSearchWorkspaceHistory } from './routes/sources.js';
import { backfillConversationSearch } from './conversationSearch.js';
import {
  handleGetAction,
  handleUndoPreview,
  handleCommitUndo,
} from './routes/actions.js';
import {
  handleListClarifications,
  handleGetClarification,
  handleReplyToClarification,
} from './routes/clarifications.js';
import { handleListCommands, handleListModels, handleExecuteCommand } from './routes/commands.js';
import { handleTelegramWebhook } from './routes/inbound.js';
import {
  handleDeleteTelegramConnection,
  handleGetTelegramConnection,
  handleIssueTelegramLink,
} from './routes/telegram.js';
import { deliverTelegramOutbox, scanTelegramDue, type TelegramSendFetch } from './inbox/telegramDelivery.js';
import {
  abortInflightTurn,
  dispatchWorkspace,
  EchoHandler,
  listWorkspacesNeedingRecovery,
  recoverWorkspace,
  type DispatchResult,
  type TurnHandler,
} from './actor/dispatch.js';
import { AgentHandler } from './agent/handler.js';
import { PRODUCTION_REGISTRY, type FetchFn } from '@otis/agent';
import { extractSessionToken, importWrappingKey } from '@otis/identity';
import { requireWorkspaceScope } from './routes/scope.js';
import { createActivityStream } from './chat/stream.js';
import { processMemoryRefreshJobs } from './agent/memory.js';
import { processScheduledDailyBriefs } from './brief/cron.js';
import { processDueReminders } from './reminders/service.js';
import { processReminderRules } from './reminders/rules.js';
import { handleVoiceMediaRoute } from './media/routes.js';
import { processTranscriptionJobs, scheduleNextTranscriptionWake, type TranscriptionProcessResult } from './media/transcription.js';
import { cleanupExpiredMedia } from './media/cleanup.js';
import { handleUploadDocument, handleRetryDocument, processDocumentExtractions, type MarkdownBinding } from './media/documents.js';
import {
  handleAcceptInvite,
  handleCreateInvite,
  handleLeaveWorkspace,
  handleListMembers,
  handleRemoveMember,
  handleTransferOwnership,
} from './routes/members.js';
import {
  handleDeleteCredential,
  handleGetCredentialStatus,
  handlePutCredential,
  handleVerifyCredential,
} from './routes/credentials.js';
import {
  handleGetMemberSettings,
  handleGetWorkspaceSettings,
  handleUpdateMemberSettings,
  handleUpdateWorkspaceSettings,
} from './routes/settings.js';
import { handleRetryRun, handleStopRun, handleGetRun, handleListRuns } from './routes/runs.js';
import { extractPlatformKeys } from './providers/service.js';
import { jsonError, jsonSuccess } from './middleware/errors.js';
import { workerDebug } from './observability.js';

export interface Env {
  AI?: MarkdownBinding;
  DB: D1Database;
  STORAGE?: R2Bucket;
  /** Cloudflare Images binding for standard inference renditions; code-only until the account enables it. */
  IMAGES?: ImagesBinding;
  WORKSPACE_ACTOR?: DurableObjectNamespace;
  ASSETS?: Fetcher;
  ENVIRONMENT?: string;
  USE_ECHO_HANDLER?: string;
  FIREBASE_PROJECT_ID?: string;
  CREDENTIALS_KEY?: string;
  /** Cloudflare Dashboard secrets / platform fallback keys */
  GEMINI_API_KEY?: string;
  OPENCODE_API_KEY?: string;
  OPENCODE_GO_API_KEY?: string;
  GROQ_API_KEY?: string;
  BOOTSTRAP_WORKSPACE_ID?: string;
  BOOTSTRAP_WORKSPACE_NAME?: string;
  BOOTSTRAP_OWNER_UID?: string;
  ENABLE_TEST_AUTH?: string;
  TEST_JWKS?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_INSTALLATION_ID?: string;
  /** Server bot token for Telegram Bot API calls. Secret: never in vars files, logs, or output. */
  TELEGRAM_BOT_TOKEN?: string;
  /** Public bot username without @, used for command addressing and deep links. */
  TELEGRAM_BOT_USERNAME?: string;
  DISPATCH_QUEUE?: Queue;
  AGENT_MAX_DAILY_ACTIONS?: string;
  AGENT_MAX_ROUNDS_PER_RUN?: string;
  /**
   * Synthetic Telegram transport for tests only. Production leaves this
   * unset so the bounded adapter uses the global fetch; tests inject a fake
   * to exercise entrypoint wiring without any real network call.
   */
  TELEGRAM_SEND_TRANSPORT?: TelegramSendFetch;
  /**
   * Scripted turn handler for tests only. Production leaves this unset and
   * the agent/echo selection below decides; tests use it to drive
   * checkpoint/contention slices through the real queue entrypoint.
   */
  DISPATCH_TEST_HANDLER?: TurnHandler;
  /**
   * Synthetic STT transport for tests only. Production leaves this unset and
   * the bounded transcription processor uses the global fetch; tests inject a
   * fake so the queue/cron entrypoints exercise the voice path without any
   * real network call.
   */
  TRANSCRIPTION_TEST_FETCH?: FetchFn;
}

/**
 * Bounded dispatch continuation on the existing queue: a checkpoint slice or
 * a full budget means more durable agent work is queued, so the next slice is
 * woken without waiting for the five-minute cron. Genuine contention or lease
 * loss backs off with a longer bounded delay instead of spinning; terminal
 * slices and waiting_for_input schedule nothing.
 */
async function scheduleDispatchContinuation(
  env: Env,
  workspaceId: string,
  results: DispatchResult[],
  budget: number,
): Promise<void> {
  if (!env.DISPATCH_QUEUE) return;
  const deferred = results.filter((result) => result.status === 'deferred' || result.status === 'contended');
  const checkpointOrBudget =
    deferred.some((result) => result.detail === 'checkpoint' || result.detail === 'retry') || results.length >= budget;
  // Any other deferred shape is contention or a lost/stale lease: back off
  // with a longer bounded delay instead of spinning an immediate hint.
  const contention = deferred.some(
    (result) =>
      result.status === 'contended' ||
      result.detail === undefined ||
      result.detail === 'lease_lost' ||
      result.detail === 'stale_attempt',
  );
  const delaySeconds = checkpointOrBudget ? 1 : contention ? 5 : null;
  if (delaySeconds === null) return;
  try {
    // Awaited so the invocation cannot end before the hint is published.
    await env.DISPATCH_QUEUE.send({ workspace_id: workspaceId }, { delaySeconds });
  } catch {
    // Best-effort hint: the durable work remains and cron is the backstop.
  }
}

/**
 * One bounded delivery pass plus a delayed continuation hint on the existing
 * dispatch queue: later multipart parts, retry deadlines, per-chat pacing and
 * batch-limit remainders must not wait for the five-minute cron. Hints are
 * best-effort; the cron sweep stays the backstop.
 *
 * Test runtimes must never dial Telegram: without an injected synthetic
 * transport the pass is skipped entirely (rows stay durable and pending).
 */
async function deliverAndScheduleContinuation(env: Env, workspaceId?: string): Promise<void> {
  const transport = env.TELEGRAM_SEND_TRANSPORT;
  if (env.ENVIRONMENT === 'test' && !transport) return;
  try {
    const summary = await deliverTelegramOutbox(env.DB, env, {
      ...(workspaceId ? { workspaceId } : {}),
      ...(transport ? { fetchFn: transport } : {}),
    });
    const delay = summary.continuation_delay_seconds;
    if (delay !== null && env.DISPATCH_QUEUE) {
      await env.DISPATCH_QUEUE.send(
        { kind: 'telegram_delivery', workspace_id: workspaceId ?? '' },
        { delaySeconds: delay },
      );
    }
  } catch (err) {
    console.error('Telegram delivery pass failed:', err);
  }
}

/**
 * Advances due voice transcription work for one workspace inside a queue or
 * cron wake-up. Bounded and due-only: the processor claims at most its limit
 * and returns immediately when nothing is due. Test runtimes without an
 * injected synthetic transport are skipped entirely so no provider is dialed.
 * A lost or failed pass is never load-bearing: the durable retry instant and
 * the five-minute cron sweep are backstops.
 */
async function advanceVoiceTranscriptions(
  env: Env,
  workspaceId: string,
  jobId?: string,
): Promise<TranscriptionProcessResult | null> {
  if (!env.STORAGE) return null;
  const transport = env.TRANSCRIPTION_TEST_FETCH;
  if (env.ENVIRONMENT === 'test' && !transport) return null;
  try {
    return await processTranscriptionJobs(env.DB, env.STORAGE, {
      workspaceId,
      ...(jobId ? { jobId } : {}),
      ...(transport ? { fetchFn: transport } : {}),
      ...(env.CREDENTIALS_KEY ? { wrappingKeyMaterial: env.CREDENTIALS_KEY } : {}),
      ...(env.GROQ_API_KEY ? { platformApiKey: env.GROQ_API_KEY } : {}),
      limit: 2,
    });
  } catch (err) {
    console.error(`voice transcription pass failed for workspace '${workspaceId}':`, err);
    return null;
  }
}

export async function createWorkerAgentHandler(env: Env): Promise<TurnHandler> {
  if (env.DISPATCH_TEST_HANDLER) {
    workerDebug('handler', 'scripted test handler selected', {});
    return env.DISPATCH_TEST_HANDLER;
  }
  if (env.USE_ECHO_HANDLER === 'true') {
    workerDebug('handler', 'echo handler selected; no agent inference will run', {});
    return EchoHandler;
  }

  let wrappingKey: CryptoKey | undefined;
  if (env.CREDENTIALS_KEY) {
    try {
      wrappingKey = await importWrappingKey(env.CREDENTIALS_KEY);
    } catch {
      // Ignored; AgentHandler will report 'misconfigured' if key is needed
    }
  }

  const parsedDaily = env.AGENT_MAX_DAILY_ACTIONS ? parseInt(env.AGENT_MAX_DAILY_ACTIONS, 10) : undefined;
  const parsedRounds = env.AGENT_MAX_ROUNDS_PER_RUN ? parseInt(env.AGENT_MAX_ROUNDS_PER_RUN, 10) : undefined;
  const limits = (parsedDaily !== undefined && !Number.isNaN(parsedDaily) && parsedDaily > 0 &&
                  parsedRounds !== undefined && !Number.isNaN(parsedRounds) && parsedRounds > 0)
    ? { maxDailyActions: parsedDaily, maxRoundsPerRun: parsedRounds }
    : undefined;

  // Presence only — values stay out of logs.
  workerDebug('handler', 'agent handler constructed', {
    echo: false,
    limitsConfigured: limits !== undefined,
    dailyVarPresent: env.AGENT_MAX_DAILY_ACTIONS !== undefined && env.AGENT_MAX_DAILY_ACTIONS !== '',
    roundsVarPresent: env.AGENT_MAX_ROUNDS_PER_RUN !== undefined && env.AGENT_MAX_ROUNDS_PER_RUN !== '',
    wrappingKeyPresent: wrappingKey !== undefined,
  });

  return new AgentHandler({
    wrappingKey,
    platformKeys: extractPlatformKeys(env),
    registry: PRODUCTION_REGISTRY,
    limits,
    storage: env.STORAGE,
    images: env.IMAGES,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  });
}

/**
 * Runs async items with bounded concurrency. Workspaces are independent, so
 * recovery/queue fans out across them; work inside one workspace stays
 * serial via its D1 lease and the actor's single execution slot.
 */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  const workers = Math.min(Math.max(limit, 1), items.length);
  let next = 0;
  const runners = Array.from({ length: workers }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await fn(items[index]!);
    }
  });
  await Promise.all(runners);
}

/**
 * WorkspaceActor Durable Object
 * One instance per workspace (constructed with idFromName(workspaceId)).
 * Serializes dispatch/recovery turns for its workspace; D1 leases remain the
 * authority so a restarted or duplicated instance cannot double-commit.
 *
 * Execution and live SSE subscribers share this isolate, so provider preview
 * streams directly to connected browsers. Async wakes ack fast and continue
 * via state.waitUntil (actor-owned liveness, independent of the Worker's
 * 30-second post-response window); sync wakes await full completion for
 * tests and for Queue/cron forwarding that needs the result.
 */
export class WorkspaceActor {
  public state: DurableObjectState;
  public env: Env;
  private inflight: Promise<void> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async runDispatchAction(
    workspaceId: string,
    budget: number,
  ): Promise<{ processed: number; results: DispatchResult[] }> {
    const handler = await createWorkerAgentHandler(this.env);
    let dispatchResult = await dispatchWorkspace(this.env.DB, workspaceId, { budget, handler });
    // A voice run parked on its durable transcription receipt: advance due
    // work once, re-dispatch the moment the receipt commits, and wake again
    // only at the job's own durable retry instant, never a poll.
    if (dispatchResult.results.some((result) => result.detail === 'transcript_pending')) {
      const pass = await advanceVoiceTranscriptions(this.env, workspaceId);
      if (pass && pass.processed > 0) {
        if (pass.ready.length > 0) {
          dispatchResult = await dispatchWorkspace(this.env.DB, workspaceId, { budget, handler });
        }
        // Exactly-once retry wake: only a pass that actually claimed work
        // schedules its follow-up. Early or duplicate wakes find nothing due
        // and must stay silent, or every one would mint another delayed
        // hint and the queue would poll. Acceptance routes anchor the first
        // wake when their immediate pass defers.
        await scheduleNextTranscriptionWake({ db: this.env.DB, queue: this.env.DISPATCH_QUEUE }, workspaceId);
      }
    }
    await deliverAndScheduleContinuation(this.env, workspaceId);
    await scheduleDispatchContinuation(this.env, workspaceId, dispatchResult.results, budget);
    return dispatchResult;
  }

  private async runRecoverAction(
    workspaceId: string,
    budget: number,
  ): Promise<{ processed: number; results: DispatchResult[]; recovery: unknown }> {
    const recovery = await recoverWorkspace(this.env.DB, workspaceId);
    const dispatchResult = await this.runDispatchAction(workspaceId, budget);
    return { ...dispatchResult, recovery };
  }

  private startBackground(work: () => Promise<void>): void {
    const execution = (async () => {
      try {
        await work();
      } catch (err) {
        console.error('workspace actor background execution failed:', err);
      }
    })();
    this.inflight = execution;
    void execution.finally(() => {
      if (this.inflight === execution) this.inflight = null;
    });
    try {
      this.state.waitUntil(execution.catch(() => undefined));
    } catch {
      // waitUntil unavailable (e.g. unit harness): tracked still runs and
      // clears inflight via its finally.
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const streamMatch = url.pathname.match(
      /^\/api\/workspaces\/([^/]+)\/chats\/([^/]+)\/activity$/,
    );
    if (streamMatch && url.searchParams.get('stream') === 'sse') {
      const workspaceId = streamMatch[1]!;
      const chatId = streamMatch[2]!;
      const token = extractSessionToken(request);
      if (!token) {
        return jsonError(401, 'unauthorized', 'Session token missing or expired.', 'actor');
      }
      const scope = await requireWorkspaceScope(request, this.env.DB, workspaceId, 'actor');
      if (scope instanceof Response) return scope;

      const afterRaw = url.searchParams.get('after');
      const after = afterRaw === null ? 0 : Number(afterRaw);
      return createActivityStream(this.env.DB, {
        workspaceId,
        chatId,
        afterCursor: Number.isSafeInteger(after) && after >= 0 ? after : 0,
        sessionToken: token,
        userId: scope.user.id,
        requestId: request.headers.get('x-request-id') ?? 'actor',
      });
    }

    if (request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'active' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    let body: { action?: string; workspace_id?: string; budget?: number; sync?: boolean };
    try {
      body = (await request.json()) as { action?: string; workspace_id?: string; budget?: number; sync?: boolean };
    } catch {
      return jsonError(400, 'invalid_json', 'Request body must be valid JSON.', 'actor');
    }
    // The stub id is opaque; callers pass the workspace explicitly so any
    // instance (including idFromName mismatches) operates on D1 truth.
    const workspaceId = body.workspace_id ?? '';
    if (!workspaceId) {
      return jsonError(422, 'invalid_payload', 'workspace_id is required.', 'actor');
    }
    const budget = Math.min(body.budget ?? 5, 25);
    const sync = body.sync === true;
    try {
      if (body.action === 'dispatch') {
        if (sync) {
          const result = await this.runDispatchAction(workspaceId, budget);
          return jsonSuccess({ status: 'ok', ...result }, 200);
        }
        if (this.inflight) {
          return jsonSuccess({ status: 'accepted', deduped: true }, 202);
        }
        this.startBackground(() => this.runDispatchAction(workspaceId, budget).then(() => undefined));
        return jsonSuccess({ status: 'accepted', deduped: false }, 202);
      }
      if (body.action === 'recover') {
        if (sync) {
          const result = await this.runRecoverAction(workspaceId, budget);
          return jsonSuccess({ status: 'ok', ...result }, 200);
        }
        if (this.inflight) {
          return jsonSuccess({ status: 'accepted', deduped: true }, 202);
        }
        this.startBackground(() => this.runRecoverAction(workspaceId, budget).then(() => undefined));
        return jsonSuccess({ status: 'accepted', deduped: false }, 202);
      }
      if (body.action === 'stop') {
        // Best-effort in-isolate abort (F08): stops provider spend for turns
        // executing in THIS isolate. The D1 cancelled marking in stopRun
        // stays the cross-isolate authority; an unknown run aborts nothing.
        const runId = (body as { run_id?: unknown }).run_id;
        const aborted = typeof runId === 'string' && runId.length > 0 ? abortInflightTurn(runId) : false;
        return jsonSuccess({ status: 'ok', aborted }, 200);
      }
    } catch (err) {
      return jsonError(500, 'actor_error', err instanceof Error ? err.message : String(err), 'actor');
    }
    return jsonError(404, 'not_found', 'Unknown actor action.', 'actor');
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get('x-request-id') || crypto.randomUUID();

    try {
      // 1. Health route: safe status check, no internal binding details leaked
      if (url.pathname === '/api/health') {
        const body: HealthResponse = {
          status: 'ok',
          timestamp: new Date().toISOString(),
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'x-request-id': requestId,
          },
        });
      }

      // 2. Auth routes
      if (url.pathname === '/api/auth/session') {
        if (request.method === 'POST') {
          return await handleAuthSession(request, env, requestId);
        }
        if (request.method === 'DELETE') {
          return await handleLogout(request, env, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 3. User identity route
      if (url.pathname === '/api/me') {
        if (request.method === 'GET') {
          return await handleGetMe(request, env, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 4. Workspace routes
      if (url.pathname === '/api/workspaces') {
        if (request.method === 'POST') {
          return await handleCreateWorkspace(request, env, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      const workspaceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/);
      if (workspaceMatch) {
        const workspaceId = workspaceMatch[1];
        if (request.method === 'GET' && workspaceId) {
          return await handleGetWorkspace(request, env, workspaceId, requestId);
        }
        if (request.method === 'PATCH' && workspaceId) {
          return await handleUpdateWorkspace(request, env, workspaceId, requestId);
        }
        if (request.method === 'DELETE' && workspaceId) {
          return await handleDeleteWorkspace(request, env, workspaceId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 4a. Workspace export route: /api/workspaces/:workspaceId/export
      const exportMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/export$/);
      if (exportMatch) {
        const workspaceId = exportMatch[1];
        if (request.method === 'GET' && workspaceId) {
          return await handleExportWorkspace(request, env, workspaceId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 4b. Workspace records route: /api/workspaces/:workspaceId/records
      const historySearchMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/history\/search$/);
      const followUpsMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/followups$/);
      if (followUpsMatch && ['GET', 'POST'].includes(request.method)) return await handleFollowUps(request, env, decodeURIComponent(followUpsMatch[1]!), requestId);
      if (historySearchMatch && request.method === 'GET') return await handleSearchWorkspaceHistory(request, env, decodeURIComponent(historySearchMatch[1]!), requestId);
      const workspaceSourceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/sources\/([^/]+)$/);
      if (workspaceSourceMatch && request.method === 'GET') return await handleGetWorkspaceSource(request, env, decodeURIComponent(workspaceSourceMatch[1]!), decodeURIComponent(workspaceSourceMatch[2]!), requestId);
      const entityFileMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/entities\/([^/]+)\/file$/);
      if (entityFileMatch && request.method === 'GET') return await handleGetEntityFile(request, env, decodeURIComponent(entityFileMatch[1]!), decodeURIComponent(entityFileMatch[2]!), requestId);
      const recordsMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/records$/);
      if (recordsMatch) {
        const workspaceId = recordsMatch[1];
        if (request.method === 'GET' && workspaceId) {
          return await handleGetRecords(request, env, workspaceId, requestId);
        }
        if (request.method === 'POST' && workspaceId) {
          return await handleSaveRecords(request, env, workspaceId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 5. Chat collection routes: /api/workspaces/:workspaceId/chats
      const chatsMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/chats$/);
      if (chatsMatch) {
        const workspaceId = chatsMatch[1];
        if (request.method === 'GET' && workspaceId) {
          return await handleListChats(request, env, workspaceId, requestId);
        }
        if (request.method === 'POST' && workspaceId) {
          return await handleCreateChat(request, env, workspaceId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 6. Single chat route: /api/workspaces/:workspaceId/chats/:chatId
      const singleChatMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/chats\/([^/]+)$/);
      if (singleChatMatch) {
        const workspaceId = singleChatMatch[1];
        const chatId = singleChatMatch[2];
        if (request.method === 'GET' && workspaceId && chatId) {
          return await handleGetChatDetail(request, env, workspaceId, chatId, requestId);
        }
        if (request.method === 'PATCH' && workspaceId && chatId) {
          return await handleUpdateChat(request, env, workspaceId, chatId, requestId);
        }
        if (request.method === 'DELETE' && workspaceId && chatId) {
          return await handleDeleteChat(request, env, workspaceId, chatId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 7. Chat messages route: /api/workspaces/:workspaceId/chats/:chatId/messages
      const chatMessagesMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/chats\/([^/]+)\/messages$/,
      );
      if (chatMessagesMatch) {
        const workspaceId = chatMessagesMatch[1];
        const chatId = chatMessagesMatch[2];
        if (request.method === 'GET' && workspaceId && chatId) {
          return await handleGetMessages(request, env, workspaceId, chatId, requestId);
        }
        if (request.method === 'POST' && workspaceId && chatId) {
          return await handleCreateMessage(request, env, workspaceId, chatId, requestId, ctx);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 7a. Chat activity route: /api/workspaces/:workspaceId/chats/:chatId/activity
      const chatActivityMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/chats\/([^/]+)\/activity$/,
      );
      if (chatActivityMatch) {
        const workspaceId = chatActivityMatch[1];
        const chatId = chatActivityMatch[2];
        if (request.method === 'GET' && workspaceId && chatId) {
          return await handleGetActivity(request, env, workspaceId, chatId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 7b. Chat clarifications route: /api/workspaces/:workspaceId/chats/:chatId/clarifications
      const chatClarificationsMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/chats\/([^/]+)\/clarifications$/,
      );
      if (chatClarificationsMatch) {
        const workspaceId = chatClarificationsMatch[1];
        const chatId = chatClarificationsMatch[2];
        if (request.method === 'GET' && workspaceId && chatId) {
          return await handleListClarifications(request, env, workspaceId, chatId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 7c. Command execution shortcut: /api/workspaces/:workspaceId/chats/:chatId/commands
      const chatCommandsMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/chats\/([^/]+)\/commands$/,
      );
      if (chatCommandsMatch) {
        const workspaceId = chatCommandsMatch[1];
        const chatId = chatCommandsMatch[2];
        if (request.method === 'POST' && workspaceId && chatId) {
          return await handleExecuteCommand(request, env, workspaceId, chatId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 8. Workspace lifecycle routes
      const membersMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/members$/);
      if (membersMatch) {
        const workspaceId = membersMatch[1];
        if (request.method === 'GET' && workspaceId) {
          return await handleListMembers(request, env, workspaceId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      const invitesMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/invites$/);
      if (invitesMatch) {
        const workspaceId = invitesMatch[1];
        if (request.method === 'POST' && workspaceId) {
          return await handleCreateInvite(request, env, workspaceId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      const removeMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/members\/([^/]+)\/remove$/);
      if (removeMatch) {
        const workspaceId = removeMatch[1];
        const targetUserId = removeMatch[2];
        if (request.method === 'POST' && workspaceId && targetUserId) {
          return await handleRemoveMember(request, env, workspaceId, targetUserId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      const memberItemMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/members\/([^/]+)$/);
      if (memberItemMatch) {
        const workspaceId = memberItemMatch[1];
        const targetUserId = memberItemMatch[2];
        if (request.method === 'DELETE' && workspaceId && targetUserId) {
          return await handleRemoveMember(request, env, workspaceId, targetUserId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      const acceptInviteMatch = url.pathname.match(/^\/api\/invites\/([^/]+)\/accept$/);
      if (acceptInviteMatch) {
        const token = acceptInviteMatch[1];
        if (request.method === 'POST' && token) {
          return await handleAcceptInvite(request, env, token, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      const leaveMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/leave$/);
      if (leaveMatch) {
        const workspaceId = leaveMatch[1];
        if (request.method === 'POST' && workspaceId) {
          return await handleLeaveWorkspace(request, env, workspaceId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      const transferMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/transfer$/);
      if (transferMatch) {
        const workspaceId = transferMatch[1];
        if (request.method === 'POST' && workspaceId) {
          return await handleTransferOwnership(request, env, workspaceId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 9. Settings routes
      const sharedSettingsMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/settings$/);
      if (sharedSettingsMatch) {
        const workspaceId = sharedSettingsMatch[1];
        if (request.method === 'GET' && workspaceId) {
          return await handleGetWorkspaceSettings(request, env, workspaceId, requestId);
        }
        if (request.method === 'PUT' && workspaceId) {
          return await handleUpdateWorkspaceSettings(request, env, workspaceId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      const memberSettingsMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/me\/settings$/);
      if (memberSettingsMatch) {
        const workspaceId = memberSettingsMatch[1];
        if (request.method === 'GET' && workspaceId) {
          return await handleGetMemberSettings(request, env, workspaceId, requestId);
        }
        if (request.method === 'PUT' && workspaceId) {
          return await handleUpdateMemberSettings(request, env, workspaceId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 10. Provider credential routes
      const verifyMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/credentials\/([^/]+)\/verify$/,
      );
      if (verifyMatch) {
        const workspaceId = verifyMatch[1];
        const provider = verifyMatch[2];
        if (request.method === 'POST' && workspaceId && provider) {
          return await handleVerifyCredential(request, env, workspaceId, provider, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }
      const credentialMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/credentials\/([^/]+)$/,
      );
      if (credentialMatch) {
        const workspaceId = credentialMatch[1];
        const provider = credentialMatch[2];
        if (request.method === 'GET' && workspaceId && provider) {
          return await handleGetCredentialStatus(request, env, workspaceId, provider, requestId);
        }
        if (request.method === 'PUT' && workspaceId && provider) {
          return await handlePutCredential(request, env, workspaceId, provider, requestId);
        }
        if (request.method === 'DELETE' && workspaceId && provider) {
          return await handleDeleteCredential(request, env, workspaceId, provider, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 11. Run routes: /api/workspaces/:workspaceId/runs/:runId and /stop
      // Batch run details: one roundtrip for snapshot/older-page loads.
      const runsMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/runs$/);
      if (runsMatch) {
        const workspaceId = runsMatch[1];
        if (request.method === 'GET' && workspaceId) {
          return await handleListRuns(request, env, workspaceId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }
      const stopMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)\/stop$/);
      if (stopMatch) {
        const workspaceId = stopMatch[1];
        const runId = stopMatch[2];
        if (request.method === 'POST' && workspaceId && runId) {
          return await handleStopRun(request, env, workspaceId, runId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }
      const retryMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)\/retry$/);
      if (retryMatch) {
        const workspaceId = retryMatch[1];
        const runId = retryMatch[2];
        if (request.method === 'POST' && workspaceId && runId) {
          return await handleRetryRun(request, env, workspaceId, runId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      const runMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)$/);
      if (runMatch) {
        const workspaceId = runMatch[1];
        const runId = runMatch[2];
        if (request.method === 'GET' && workspaceId && runId) {
          return await handleGetRun(request, env, workspaceId, runId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 11a. Action detail route: /api/workspaces/:workspaceId/actions/:actionId
      const actionMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/actions\/([^/]+)$/);
      if (actionMatch) {
        const workspaceId = actionMatch[1];
        const actionId = actionMatch[2];
        if (request.method === 'GET' && workspaceId && actionId) {
          return await handleGetAction(request, env, workspaceId, actionId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 11b. Undo preview/commit routes
      const undoPreviewMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/actions\/([^/]+)\/undo-preview$/,
      );
      if (undoPreviewMatch) {
        const workspaceId = undoPreviewMatch[1];
        const actionId = undoPreviewMatch[2];
        if (request.method === 'POST' && workspaceId && actionId) {
          return await handleUndoPreview(request, env, workspaceId, actionId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      const undoMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/actions\/([^/]+)\/undo$/);
      if (undoMatch) {
        const workspaceId = undoMatch[1];
        const actionId = undoMatch[2];
        if (request.method === 'POST' && workspaceId && actionId) {
          return await handleCommitUndo(request, env, workspaceId, actionId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 11c. Clarification reply route: /api/workspaces/:workspaceId/clarifications/:id/reply
      const clarificationReplyMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/clarifications\/([^/]+)\/reply$/,
      );
      if (clarificationReplyMatch) {
        const workspaceId = clarificationReplyMatch[1];
        const clarificationId = clarificationReplyMatch[2];
        if (request.method === 'POST' && workspaceId && clarificationId) {
          return await handleReplyToClarification(request, env, workspaceId, clarificationId, requestId, undefined, ctx);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      const clarificationMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/clarifications\/([^/]+)$/,
      );
      if (clarificationMatch) {
        const workspaceId = clarificationMatch[1];
        const clarificationId = clarificationMatch[2];
        if (request.method === 'GET' && workspaceId && clarificationId) {
          return await handleGetClarification(request, env, workspaceId, clarificationId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 11d. Approved model choices: /api/workspaces/:workspaceId/models
      const modelsMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/models$/);
      if (modelsMatch) {
        const workspaceId = modelsMatch[1];
        if (request.method === 'GET' && workspaceId) {
          return await handleListModels(request, env, workspaceId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 11e. Command registry: /api/commands
      const memorySourceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/memory\/([^/]+)\/source$/);
      if (memorySourceMatch) {
        if (request.method === 'GET') return await handleGetMemorySource(request, env, memorySourceMatch[1]!, memorySourceMatch[2]!, requestId);
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }
      if (url.pathname === '/api/commands') {
        if (request.method === 'GET') {
          return await handleListCommands(request, env, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 12. Telegram connection routes (guided linking UX)
      const telegramLinkMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/telegram\/link$/);
      if (telegramLinkMatch) {
        if (request.method === 'POST' && telegramLinkMatch[1]) {
          return await handleIssueTelegramLink(request, env, telegramLinkMatch[1], requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      const telegramConnectionMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/telegram\/connection$/,
      );
      if (telegramConnectionMatch) {
        if (request.method === 'GET' && telegramConnectionMatch[1]) {
          return await handleGetTelegramConnection(request, env, telegramConnectionMatch[1], requestId);
        }
        if (request.method === 'DELETE' && telegramConnectionMatch[1]) {
          return await handleDeleteTelegramConnection(request, env, telegramConnectionMatch[1], requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 12b. Telegram Inbound Webhook route: /api/inbound/telegram
      if (url.pathname === '/api/inbound/telegram') {
        if (request.method === 'POST') {
          return await handleTelegramWebhook(request, env, requestId, ctx);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      const documentUpload = /^\/api\/workspaces\/([^/]+)\/documents\/uploads$/.exec(url.pathname);
      const documentRetry = /^\/api\/workspaces\/([^/]+)\/documents\/([^/]+)\/retry$/.exec(url.pathname);
      if (documentRetry && request.method === 'POST') return await handleRetryDocument(request, env, decodeURIComponent(documentRetry[1]!), decodeURIComponent(documentRetry[2]!), requestId);
      const fileAction = /^\/api\/workspaces\/([^/]+)\/entities\/([^/]+)\/actions$/.exec(url.pathname);
      if (fileAction && request.method === 'POST') return await handleEntityFileAction(request, env, decodeURIComponent(fileAction[1]!), decodeURIComponent(fileAction[2]!), requestId);
      if (documentUpload && request.method === 'POST') return await handleUploadDocument(request, env, decodeURIComponent(documentUpload[1]!), requestId);
      // 12c. Voice media surface: private upload claims, byte transport,
      // finalize/status, streaming reads and shared voice settings. Mounted
      // once; every route re-checks current membership itself and the outer
      // try/catch remains the entrypoint error boundary.
      const voiceMedia = await handleVoiceMediaRoute(request, env, requestId);
      if (voiceMedia) return voiceMedia;

      // 9. Unknown API route
      if (url.pathname.startsWith('/api/')) {
        return jsonError(404, 'not_found', 'API endpoint not found.', requestId);
      }

      // 6. Static assets fallback
      if (env.ASSETS) {
        return await env.ASSETS.fetch(request);
      }

      return jsonError(404, 'not_found', 'Not Found.', requestId);
    } catch {
      return jsonError(
        500,
        'internal_server_error',
        'An unexpected internal error occurred.',
        requestId,
      );
    }
  },

  /**
   * Cron recovery: discovers workspaces from durable runs as well as outbox
   * rows (an accepted input whose dispatch intent was never published still
   * needs recovery), then requeues stale work and dispatches a bounded slice.
   */
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    if (_event.cron === '* * * * *') {
      const now = new Date().toISOString();
      // Keep quote discovery plus two deliveries within D1's 50-query
      // Free invocation bound, including first-chat provisioning/Telegram.
      await processReminderRules(env.DB, now, 1);
      await processDueReminders(env.DB, now, { limit: 2 });
      return;
    }
    await processDocumentExtractions(env).catch(() => console.error('Document extraction recovery failed.'));
    workerDebug('cron', 'scheduled sweep starting', {});
    try { await backfillConversationSearch(env.DB); } catch (error) { console.error('History index recovery failed:', error instanceof Error ? error.message : 'unknown error'); }

    // Voice transcription recovery: queue wake-ups advance due jobs promptly;
    // this bounded pass is the backstop for a workspace whose wake-up was
    // lost or whose retry window elapsed. Ready runs are dispatched by the
    // recovery sweep below in this same tick.
    if (env.STORAGE) {
      const transport = env.TRANSCRIPTION_TEST_FETCH;
      if (env.ENVIRONMENT !== 'test' || transport) {
        try {
          const pass = await processTranscriptionJobs(env.DB, env.STORAGE, {
            ...(transport ? { fetchFn: transport } : {}),
            ...(env.CREDENTIALS_KEY ? { wrappingKeyMaterial: env.CREDENTIALS_KEY } : {}),
            ...(env.GROQ_API_KEY ? { platformApiKey: env.GROQ_API_KEY } : {}),
            limit: 3,
          });
          workerDebug('cron', 'voice transcription sweep complete', {
            processed: pass.processed,
            ready: pass.ready.length,
            failed: pass.failed.length,
            deferred: pass.deferred,
          });
        } catch (err) {
          console.error('scheduled voice transcription recovery failed:', err);
        }
      }
    }

    const workspaces = await listWorkspacesNeedingRecovery(env.DB);
    workerDebug('cron', 'recovery scan complete', { workspaces: workspaces.length });
    if (env.WORKSPACE_ACTOR) {
      // Recovery executes inside each workspace's actor, alongside its live
      // SSE subscribers — never as a full model turn in this cron isolate.
      await mapWithConcurrency(workspaces, 3, async (workspaceId) => {
        try {
          const stub = env.WORKSPACE_ACTOR!.get(env.WORKSPACE_ACTOR!.idFromName(workspaceId));
          const res = await stub.fetch(new Request('http://actor/recover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'recover', workspace_id: workspaceId, budget: 5, sync: true }),
          }));
          try { await res.text(); } catch { /* consume body; status logged below */ }
          if (!res.ok) {
            console.error(`scheduled recovery failed for workspace '${workspaceId}': actor HTTP ${res.status}`);
          }
        } catch (err) {
          console.error(`scheduled recovery failed for workspace '${workspaceId}':`, err);
        }
      });
    } else {
      const handler = await createWorkerAgentHandler(env);
      for (const workspaceId of workspaces) {
        try {
          await recoverWorkspace(env.DB, workspaceId);
          await dispatchWorkspace(env.DB, workspaceId, { budget: 5, handler });
          await deliverAndScheduleContinuation(env, workspaceId);
        } catch (err) {
          console.error(`scheduled recovery failed for workspace '${workspaceId}':`, err);
        }
      }
    }

    // Telegram fallback: pending retries and stale sending rows a terminal
    // run left behind (the run that created them will never deliver again).
    try {
      const deliveryWorkspaces = await scanTelegramDue(env.DB);
      for (const workspaceId of deliveryWorkspaces) {
        try {
          await deliverAndScheduleContinuation(env, workspaceId || undefined);
        } catch (err) {
          console.error(`scheduled Telegram delivery failed for workspace '${workspaceId}':`, err);
        }
      }
    } catch (err) {
      console.error('scheduled Telegram delivery scan failed:', err);
    }

    try {
      await processMemoryRefreshJobs(env.DB);
    } catch (err) {
      console.error('scheduled memory refresh failed:', err);
    }

    try {
      await processScheduledDailyBriefs(env.DB);
    } catch (err) {
      console.error('scheduled daily brief sweep failed:', err);
    }

    // The dedicated minute pass owns reminders; don't repeat their reads
    // and deliveries inside the already busy maintenance invocation.

    // Housekeeping: bounded prune of legacy guard rows left by earlier migrations
    try {
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM acceptance_guards WHERE id IN (SELECT id FROM acceptance_guards WHERE length(id) > 40 LIMIT 500)`),
        env.DB.prepare(`DELETE FROM ledger_guards WHERE id IN (SELECT id FROM ledger_guards WHERE length(id) > 40 LIMIT 500)`),
        env.DB.prepare(`DELETE FROM lifecycle_guards WHERE id IN (SELECT id FROM lifecycle_guards WHERE length(id) > 40 LIMIT 500)`),
      ]);
    } catch {
      // Best-effort legacy cleanup
    }

    // Retention: accepted audio expires after 14 days; abandoned quarantine
    // uploads and orphaned validated media are removed. Idempotent; failures
    // are reported instead of pretending success.
    if (env.STORAGE) {
      try {
        const cleanup = await cleanupExpiredMedia(env.DB, env.STORAGE, { limit: 25 });
        workerDebug('cron', 'media retention sweep complete', {
          expired: cleanup.expired,
          abandoned: cleanup.abandoned,
          failed: cleanup.failed,
        });
      } catch (err) {
        console.error('scheduled media retention failed:', err);
      }
    }
  },

  /**
   * Queue wake-ups are hints, not business order. Model work always executes
   * inside the workspace actor (same isolate as live SSE); this consumer only
   * coalesces duplicate hints and forwards each workspace once with bounded
   * concurrency. Lightweight Telegram/memory jobs run here directly. The no-
   * actor fallback preserves the old direct path for harnesses without a DO
   * binding. Malformed messages are acknowledged with a log, never retried
   * blindly.
   */
  async queue(batch: MessageBatch<{ workspace_id?: unknown; kind?: unknown; job_id?: unknown }>, env: Env): Promise<void> {
    workerDebug('queue', 'batch received', { messages: batch.messages.length });
    const telegramScopes: Array<string | undefined> = [];
    const telegramSeen = new Set<string>();
    const memoryJobs: Array<{ workspaceId: string; jobId?: string }> = [];
    const memorySeen = new Set<string>();
    const workspaceQueue: string[] = [];
    const workspaceSeen = new Set<string>();

    for (const message of batch.messages) {
      const kind = message.body?.kind;
      const workspaceId = message.body?.workspace_id;

      if (kind === 'document_extract' && typeof workspaceId === 'string') {
        await processDocumentExtractions(env, workspaceId, typeof message.body.job_id === 'string' ? message.body.job_id : undefined);
        continue;
      }

      if (kind === 'telegram_delivery') {
        const scopeId = typeof workspaceId === 'string' && workspaceId ? workspaceId : undefined;
        const key = scopeId ?? '';
        if (!telegramSeen.has(key)) {
          telegramSeen.add(key);
          telegramScopes.push(scopeId);
        }
        continue;
      }

      if (typeof workspaceId !== 'string' || !workspaceId) {
        console.error('Ignoring malformed dispatch wake-up without workspace_id.');
        continue;
      }

      if (kind === 'memory_refresh') {
        const jobId = typeof message.body?.job_id === 'string' ? message.body.job_id : undefined;
        const key = `${workspaceId}|${jobId ?? ''}`;
        if (!memorySeen.has(key)) {
          memorySeen.add(key);
          memoryJobs.push(jobId ? { workspaceId, jobId } : { workspaceId });
        }
        continue;
      }

      if (!workspaceSeen.has(workspaceId)) {
        workspaceSeen.add(workspaceId);
        workspaceQueue.push(workspaceId);
      }
    }

    for (const scopeId of telegramScopes) {
      await deliverAndScheduleContinuation(env, scopeId);
    }

    for (const job of memoryJobs) {
      try {
        await processMemoryRefreshJobs(env.DB, job.jobId
          ? { workspaceId: job.workspaceId, jobId: job.jobId }
          : { workspaceId: job.workspaceId });
      } catch (err) {
        console.error(`queue memory refresh failed for workspace '${job.workspaceId}':`, err);
      }
    }

    if (workspaceQueue.length === 0) return;

    if (env.WORKSPACE_ACTOR) {
      await mapWithConcurrency(workspaceQueue, 3, async (workspaceId) => {
        try {
          const stub = env.WORKSPACE_ACTOR!.get(env.WORKSPACE_ACTOR!.idFromName(workspaceId));
          const res = await stub.fetch(new Request('http://actor/dispatch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'dispatch', workspace_id: workspaceId, budget: 3, sync: true }),
          }));
          try { await res.text(); } catch { /* consume body; status logged below */ }
          if (!res.ok) {
            console.error(`queue dispatch failed for workspace '${workspaceId}': actor HTTP ${res.status}`);
          }
        } catch (err) {
          console.error(`queue dispatch failed for workspace '${workspaceId}':`, err);
        }
      });
      return;
    }

    const handler = await createWorkerAgentHandler(env);
    for (const workspaceId of workspaceQueue) {
      try {
        let dispatchResult = await dispatchWorkspace(env.DB, workspaceId, { budget: 3, handler });
        // A voice run parked on its durable transcription receipt: advance due
        // work once, re-dispatch the moment the receipt commits, and wake
        // again only at the job's own durable retry instant, never a poll.
        if (dispatchResult.results.some((result) => result.detail === 'transcript_pending')) {
          const pass = await advanceVoiceTranscriptions(env, workspaceId);
          if (pass && pass.processed > 0) {
            if (pass.ready.length > 0) {
              dispatchResult = await dispatchWorkspace(env.DB, workspaceId, { budget: 3, handler });
            }
            // Exactly-once retry wake (see the actor path above): silent
            // unless this pass claimed work.
            await scheduleNextTranscriptionWake({ db: env.DB, queue: env.DISPATCH_QUEUE }, workspaceId);
          }
        }
        await deliverAndScheduleContinuation(env, workspaceId);
        await scheduleDispatchContinuation(env, workspaceId, dispatchResult.results, 3);
      } catch (err) {
        console.error(`queue dispatch failed for workspace '${workspaceId}':`, err);
      }
    }
  },
};
