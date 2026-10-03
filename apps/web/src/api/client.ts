/**
 * Typed chat API client.
 *
 * Every response shape comes from `@otis/contracts`, so plan 008 renders real
 * server state instead of a second client-side store. Mutating requests carry
 * the CSRF header and the client-generated UUID used for retries.
 */

import type {
  AcceptMessageResponse,
  ActionDetailResponse,
  ActivityPageResponse,
  Chat,
  ChatDetailResponse,
  ClarificationReplyResponse,
  ClarificationSummary,
  CommandRegistryResponse,
  MessageListResponse,
  ModelListResponse,
  MemberSettings,
  MemorySourceResponse,
  WorkspaceSettings,
  RunDetailResponse,
  UndoCommitResponse,
  UndoPreviewResponse,
} from '@otis/contracts';
import { AUTH_BOUNDS, DOMAIN_BOUNDS } from '@otis/contracts';
import { debugLog, failureLog } from './log.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const started = Date.now();
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET') {
    headers.set(AUTH_BOUNDS.CSRF_HEADER, '1');
  }
  if (init.body) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  } catch (err) {
    failureLog('api', 'network failure before HTTP', { method, path, ms: Date.now() - started, error: String(err) });
    throw err;
  }
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text.length > 0 ? JSON.parse(text) : null; } catch {
    failureLog('api', 'non-JSON response', { method, path, status: response.status, ms: Date.now() - started, bytes: text.length });
    throw new ApiError(response.status, 'service_unavailable', 'Otis is unavailable. Try again shortly.');
  }

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; request_id?: string } })
      ?.error;
    failureLog('api', 'request rejected', {
      method, path, status: response.status, code: error?.code ?? 'unknown_error', request_id: error?.request_id ?? null, ms: Date.now() - started,
    });
    throw new ApiError(
      response.status,
      error?.code ?? 'unknown_error',
      error?.message ?? `Request failed with HTTP ${response.status}`,
      error?.request_id,
    );
  }

  debugLog('api', 'request ok', { method, path, status: response.status, ms: Date.now() - started });
  return payload as T;
}

export const api = {
  me: () => request<{ user: { id: string; display_name: string | null }; workspaces: { id: string; name: string; role: string }[] }>('/api/me'),

  listChats: (workspaceId: string, filter: 'mine' | 'team' = 'mine', cursor?: string) =>
    request<{ chats: Chat[]; next_cursor?: string }>(
      `/api/workspaces/${workspaceId}/chats?filter=${filter}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),

  createChat: (workspaceId: string, clientChatId: string) =>
    request<{ chat: Chat }>(`/api/workspaces/${workspaceId}/chats`, {
      method: 'POST',
      body: JSON.stringify({ client_chat_id: clientChatId }),
    }),

  getChat: (workspaceId: string, chatId: string) =>
    request<ChatDetailResponse>(`/api/workspaces/${workspaceId}/chats/${chatId}`),

  listMessages: (workspaceId: string, chatId: string, beforeSequence?: number | null) => {
    const params = new URLSearchParams({ limit: String(DOMAIN_BOUNDS.MAX_TRANSCRIPT_PAGE) });
    if (beforeSequence) params.set('before_sequence', String(beforeSequence));
    return request<MessageListResponse>(
      `/api/workspaces/${workspaceId}/chats/${chatId}/messages?${params.toString()}`,
    );
  },

  sendMessage: (workspaceId: string, chatId: string, clientMessageId: string, text: string, clarificationId?: string) =>
    request<AcceptMessageResponse>(`/api/workspaces/${workspaceId}/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ client_message_id: clientMessageId, text, clarification_id: clarificationId }),
    }),

  activity: (workspaceId: string, chatId: string, after: number) =>
    request<ActivityPageResponse>(
      `/api/workspaces/${workspaceId}/chats/${chatId}/activity?after=${after}`,
    ),

  run: (workspaceId: string, runId: string) =>
    request<RunDetailResponse>(`/api/workspaces/${workspaceId}/runs/${runId}`),

  stopRun: (workspaceId: string, runId: string) =>
    request<{ stopped: boolean; run_status: string }>(
      `/api/workspaces/${workspaceId}/runs/${runId}/stop`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  action: (workspaceId: string, actionId: string) =>
    request<ActionDetailResponse>(`/api/workspaces/${workspaceId}/actions/${encodeURIComponent(actionId)}`),
  memorySource: (workspaceId: string, memoryId: string) => request<MemorySourceResponse>(`/api/workspaces/${workspaceId}/memory/${encodeURIComponent(memoryId)}/source`),

  undoPreview: (workspaceId: string, actionId: string, mode: 'from_here' | 'single') =>
    request<UndoPreviewResponse>(
      `/api/workspaces/${workspaceId}/actions/${encodeURIComponent(actionId)}/undo-preview`,
      { method: 'POST', body: JSON.stringify({ mode }) },
    ),

  undo: (
    workspaceId: string,
    actionId: string,
    params: { mode: 'from_here' | 'single'; clientOperationId: string; expectedRevision: number; chatId?: string },
  ) => {
    const query = params.chatId ? `?chat_id=${encodeURIComponent(params.chatId)}` : '';
    return request<UndoCommitResponse>(
      `/api/workspaces/${workspaceId}/actions/${encodeURIComponent(actionId)}/undo${query}`,
      {
        method: 'POST',
        body: JSON.stringify({
          mode: params.mode,
          client_operation_id: params.clientOperationId,
          expected_revision: params.expectedRevision,
        }),
      },
    );
  },

  clarifications: (workspaceId: string, chatId: string) =>
    request<{ clarifications: ClarificationSummary[] }>(
      `/api/workspaces/${workspaceId}/chats/${chatId}/clarifications`,
    ),

  replyToClarification: (
    workspaceId: string,
    clarificationId: string,
    body: { text: string; client_message_id: string; resolved_fields?: Record<string, string> },
  ) =>
    request<ClarificationReplyResponse>(
      `/api/workspaces/${workspaceId}/clarifications/${encodeURIComponent(clarificationId)}/reply`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  commands: (surface: 'web' | 'telegram' = 'web') =>
    request<CommandRegistryResponse>(`/api/commands?surface=${surface}`),

  models: (workspaceId: string, chatId?: string) =>
    request<ModelListResponse>(
      `/api/workspaces/${workspaceId}/models${chatId ? `?chat_id=${encodeURIComponent(chatId)}` : ''}`,
    ),

  settings: (workspaceId: string) => request<{ settings: WorkspaceSettings }>(`/api/workspaces/${workspaceId}/settings`),
  memberSettings: (workspaceId: string) => request<{ settings: MemberSettings }>(`/api/workspaces/${workspaceId}/me/settings`),
  updateMemberSettings: (workspaceId: string, body: { preferred_language: string; brief_timezone: string }) => request<{ settings: MemberSettings }>(`/api/workspaces/${workspaceId}/me/settings`, { method: 'PUT', body: JSON.stringify(body) }),
  activityStreamUrl: (workspaceId: string, chatId: string, after: number) =>
    `/api/workspaces/${workspaceId}/chats/${encodeURIComponent(chatId)}/activity?stream=sse&after=${after}`,
};
