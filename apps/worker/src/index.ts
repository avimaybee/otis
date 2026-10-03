/**
 * @otis/worker
 * Cloudflare Worker API & Durable Object router for Otis.
 */

import type { HealthResponse } from '@otis/contracts';
import { handleAuthSession, handleLogout } from './routes/auth.js';
import { handleGetMe } from './routes/me.js';
import { handleGetWorkspace } from './routes/workspaces.js';
import {
  handleListChats,
  handleCreateChat,
  handleCreateMessage,
} from './routes/chats.js';
import { handleGetChatDetail, handleGetMessages } from './routes/chat.js';
import { handleGetActivity } from './routes/activity.js';
import { handleGetMemorySource } from './routes/sources.js';
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
  dispatchWorkspace,
  EchoHandler,
  listWorkspacesNeedingRecovery,
  recoverWorkspace,
  type TurnHandler,
} from './actor/dispatch.js';
import { AgentHandler } from './agent/handler.js';
import { PRODUCTION_REGISTRY } from '@otis/agent';
import { importWrappingKey } from '@otis/identity';
import { processMemoryRefreshJobs } from './agent/memory.js';
import {
  handleCreateInvite,
  handleLeaveWorkspace,
  handleListMembers,
  handleRemoveMember,
  handleTransferOwnership,
} from './routes/members.js';
import {
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
import { handleStopRun, handleGetRun } from './routes/runs.js';
import { jsonError, jsonSuccess } from './middleware/errors.js';
import { workerDebug } from './observability.js';

export interface Env {
  DB: D1Database;
  STORAGE?: R2Bucket;
  WORKSPACE_ACTOR?: DurableObjectNamespace;
  ASSETS?: Fetcher;
  ENVIRONMENT?: string;
  USE_ECHO_HANDLER?: string;
  FIREBASE_PROJECT_ID?: string;
  CREDENTIALS_KEY?: string;
  BOOTSTRAP_WORKSPACE_ID?: string;
  BOOTSTRAP_WORKSPACE_NAME?: string;
  BOOTSTRAP_OWNER_UID?: string;
  ENABLE_TEST_AUTH?: string;
  TEST_JWKS?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_INSTALLATION_ID?: string;
  DISPATCH_QUEUE?: Queue;
  AGENT_MAX_DAILY_ACTIONS?: string;
  AGENT_MAX_ROUNDS_PER_RUN?: string;
}

export async function createWorkerAgentHandler(env: Env): Promise<TurnHandler> {
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
    registry: PRODUCTION_REGISTRY,
    limits,
  });
}

/**
 * WorkspaceActor Durable Object
 * One instance per workspace (constructed with idFromName(workspaceId)).
 * Serializes dispatch/recovery turns for its workspace; D1 leases remain the
 * authority so a restarted or duplicated instance cannot double-commit.
 */
export class WorkspaceActor {
  public state: DurableObjectState;
  public env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'active' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    let body: { action?: string; workspace_id?: string; budget?: number };
    try {
      body = (await request.json()) as { action?: string; workspace_id?: string; budget?: number };
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
    const handler = await createWorkerAgentHandler(this.env);
    try {
      if (body.action === 'dispatch') {
        const result = await dispatchWorkspace(this.env.DB, workspaceId, { budget, handler });
        return jsonSuccess({ status: 'ok', ...result }, 200);
      }
      if (body.action === 'recover') {
        const recovery = await recoverWorkspace(this.env.DB, workspaceId);
        const result = await dispatchWorkspace(this.env.DB, workspaceId, { budget, handler });
        return jsonSuccess({ status: 'ok', recovery, ...result }, 200);
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
      const workspaceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/);
      if (workspaceMatch) {
        const workspaceId = workspaceMatch[1];
        if (request.method === 'GET' && workspaceId) {
          return await handleGetWorkspace(request, env, workspaceId, requestId);
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
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 11. Run routes: /api/workspaces/:workspaceId/runs/:runId and /stop
      const stopMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)\/stop$/);
      if (stopMatch) {
        const workspaceId = stopMatch[1];
        const runId = stopMatch[2];
        if (request.method === 'POST' && workspaceId && runId) {
          return await handleStopRun(request, env, workspaceId, runId, requestId);
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

      // 12. Telegram Inbound Webhook route: /api/inbound/telegram
      if (url.pathname === '/api/inbound/telegram') {
        if (request.method === 'POST') {
          return await handleTelegramWebhook(request, env, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

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
    workerDebug('cron', 'scheduled sweep starting', {});
    const handler = await createWorkerAgentHandler(env);
    const workspaces = await listWorkspacesNeedingRecovery(env.DB);
    workerDebug('cron', 'recovery scan complete', { workspaces: workspaces.length });
    for (const workspaceId of workspaces) {
      try {
        await recoverWorkspace(env.DB, workspaceId);
        await dispatchWorkspace(env.DB, workspaceId, { budget: 5, handler });
      } catch (err) {
        console.error(`scheduled recovery failed for workspace '${workspaceId}':`, err);
      }
    }

    try {
      await processMemoryRefreshJobs(env.DB);
    } catch (err) {
      console.error('scheduled memory refresh failed:', err);
    }
  },

  /**
   * Queue wake-ups are hints, not business order: each message names one
   * workspace to dispatch. Malformed messages are acknowledged with a log,
   * never retried blindly.
   */
  async queue(batch: MessageBatch<{ workspace_id?: unknown; kind?: unknown; job_id?: unknown }>, env: Env): Promise<void> {
    workerDebug('queue', 'batch received', { messages: batch.messages.length });
    const handler = await createWorkerAgentHandler(env);
    for (const message of batch.messages) {
      const workspaceId = message.body?.workspace_id;
      if (typeof workspaceId !== 'string' || !workspaceId) {
        console.error('Ignoring malformed dispatch wake-up without workspace_id.');
        continue;
      }

      if (message.body?.kind === 'memory_refresh') {
        try {
          await processMemoryRefreshJobs(env.DB, {
            workspaceId,
            jobId: typeof message.body.job_id === 'string' ? message.body.job_id : undefined,
          });
        } catch (err) {
          console.error(`queue memory refresh failed for workspace '${workspaceId}':`, err);
        }
        continue;
      }

      try {
        await dispatchWorkspace(env.DB, workspaceId, { budget: 3, handler });
      } catch (err) {
        console.error(`queue dispatch failed for workspace '${workspaceId}':`, err);
      }
    }
  },
};
