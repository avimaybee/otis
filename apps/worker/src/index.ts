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
  handleGetChat,
  handleListMessages,
  handleCreateMessage,
} from './routes/chats.js';
import { handleTelegramWebhook } from './routes/inbound.js';
import { jsonError } from './middleware/errors.js';

export interface Env {
  DB: D1Database;
  STORAGE?: R2Bucket;
  WORKSPACE_ACTOR?: DurableObjectNamespace;
  ASSETS?: Fetcher;
  ENVIRONMENT?: string;
  FIREBASE_PROJECT_ID?: string;
  BOOTSTRAP_WORKSPACE_ID?: string;
  BOOTSTRAP_WORKSPACE_NAME?: string;
  BOOTSTRAP_OWNER_UID?: string;
  ENABLE_TEST_AUTH?: string;
  TEST_JWKS?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_BOT_INSTALLATION_ID?: string;
}

/**
 * WorkspaceActor Durable Object
 * Manages serialized turns and queue leases per workspace.
 */
export class WorkspaceActor {
  public state: DurableObjectState;
  public env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response(JSON.stringify({ status: 'active' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
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
          return await handleGetChat(request, env, workspaceId, chatId, requestId);
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
          return await handleListMessages(request, env, workspaceId, chatId, requestId);
        }
        if (request.method === 'POST' && workspaceId && chatId) {
          return await handleCreateMessage(request, env, workspaceId, chatId, requestId);
        }
        return jsonError(405, 'method_not_allowed', 'Method not allowed.', requestId);
      }

      // 8. Telegram Inbound Webhook route: /api/inbound/telegram
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
};
