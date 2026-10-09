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
  UpdateMemberSettingsRequest,
  CredentialStatusResponse,
  ProviderName,
  LogoutResponse,
  RunDetailResponse,
  RunBatchResponse,
  TelegramConnectionResponse,
  TelegramDisconnectResponse,
  TelegramLinkResponse,
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
    /** Milliseconds from a `Retry-After` response header, when the server sent one. */
    readonly retryAfterMs?: number,
    /** Server-supplied structured detail (e.g. the media identity on a finalized-upload conflict). */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Parses a `Retry-After` value (delay seconds or HTTP date) into milliseconds. */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return undefined;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const started = Date.now();
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET') {
    headers.set(AUTH_BOUNDS.CSRF_HEADER, '1');
  }
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException('Request timed out', 'TimeoutError'));
  }, DEFAULT_REQUEST_TIMEOUT_MS);
  // Linked listener is removed on settle below: without cleanup every
  // request would pin a listener on its (possibly long-lived) signal.
  const onAbort = (): void => {
    controller.abort(init.signal?.reason);
  };
  if (init.signal) {
    if (init.signal.aborted) {
      controller.abort(init.signal.reason);
    } else {
      init.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: 'same-origin', signal: controller.signal });
  } catch (err) {
    // Intended navigation cancellation is not a network failure: the query
    // owner aborted a disposable read, so it stays out of the failure log.
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      failureLog('api', 'network failure before HTTP', { method, path, ms: Date.now() - started, error: String(err) });
    }
    clearTimeout(timeoutId);
    init.signal?.removeEventListener('abort', onAbort);
    throw err;
  }
  // The deadline stays armed through body consumption: headers arriving
  // says nothing about a body that then stalls forever.
  let text: string;
  try {
    text = await response.text();
  } finally {
    clearTimeout(timeoutId);
    init.signal?.removeEventListener('abort', onAbort);
  }
  let payload: unknown = null;
  try { payload = text.length > 0 ? JSON.parse(text) : null; } catch {
    failureLog('api', 'non-JSON response', { method, path, status: response.status, ms: Date.now() - started, bytes: text.length });
    throw new ApiError(response.status, 'service_unavailable', 'Otis is unavailable. Try again shortly.');
  }

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; request_id?: string; details?: unknown } })
      ?.error;
    failureLog('api', 'request rejected', {
      method, path, status: response.status, code: error?.code ?? 'unknown_error', request_id: error?.request_id ?? null, ms: Date.now() - started,
    });
    throw new ApiError(
      response.status,
      error?.code ?? 'unknown_error',
      error?.message ?? `Request failed with HTTP ${response.status}`,
      error?.request_id,
      parseRetryAfterMs(response.headers.get('Retry-After')),
      error?.details,
    );
  }

  debugLog('api', 'request ok', { method, path, status: response.status, ms: Date.now() - started });
  return payload as T;
}

export const api = {
  entityFile: (workspace: string, entity: string, options: { section?: import('@otis/contracts').EntityFileSection; cursor?: string; order?: string; limit?: number; author_user_id?: string; from?: string; to?: string; include_removed?: boolean; interaction_id?: string } = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams(); for (const [k, v] of Object.entries(options)) if (v !== undefined) query.set(k, String(v));
    return request<import('@otis/contracts').EntityFile | import('@otis/contracts').EntityFileSectionResponse>(`/api/workspaces/${encodeURIComponent(workspace)}/entities/${encodeURIComponent(entity)}/file?${query}`, { signal });
  },
  entityAction: (workspace: string, entity: string, payload: { command: string; args: unknown; operation_id: string; expected_revision: number }, userId: string) => request<import('@otis/contracts').CommandResult>(`/api/workspaces/${encodeURIComponent(workspace)}/entities/${encodeURIComponent(entity)}/actions`, { method: 'POST', headers: { 'x-expected-user-id': userId }, body: JSON.stringify(payload) }),
  workspaceSource: (workspace: string, source: string, signal?: AbortSignal) => request<import('@otis/contracts').WorkspaceMessageSource>(`/api/workspaces/${encodeURIComponent(workspace)}/sources/${encodeURIComponent(source)}`, { signal }),
  followUps: (workspace: string, cursor?: string, signal?: AbortSignal) => request<import('@otis/contracts').FollowUpPage>(`/api/workspaces/${encodeURIComponent(workspace)}/followups${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal }),
  followUpAction: (workspace: string, payload: { args: unknown; operation_id: string; expected_revision: number }, userId: string) => request<import('@otis/contracts').CommandResult>(`/api/workspaces/${encodeURIComponent(workspace)}/followups`, { method: 'POST', headers: { 'x-expected-user-id': userId }, body: JSON.stringify(payload) }),
  searchWorkspaceHistory: (workspace: string, options: import('@otis/contracts').SearchWorkspaceHistoryArgs, signal?: AbortSignal) => {
    const query = new URLSearchParams(); for (const [k, v] of Object.entries(options)) if (v !== undefined) query.set(k === 'query' ? 'q' : k, String(v));
    return request<import('@otis/contracts').HistorySearchResponse>(`/api/workspaces/${encodeURIComponent(workspace)}/history/search?${query}`, { signal });
  },
  uploadDocument: (workspace: string, file: File, uploadId: string, userId: string) => request<{ media_id: string; filename: string; extraction_state: string }>(`/api/workspaces/${encodeURIComponent(workspace)}/documents/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'x-filename': encodeURIComponent(file.name), 'x-upload-id': uploadId, 'x-expected-user-id': userId }, body: file }),
  retryDocument: (workspace: string, mediaId: string, userId: string) => request<{ media_id: string; state: string }>(`/api/workspaces/${encodeURIComponent(workspace)}/documents/${encodeURIComponent(mediaId)}/retry`, { method: 'POST', headers: { 'x-expected-user-id': userId } }),
  me: () => request<{ user: { id: string; display_name: string | null }; workspaces: { id: string; name: string; role: string }[] }>('/api/me'),

  listChats: (workspaceId: string, filter: 'mine' | 'team' = 'mine', cursor?: string, signal?: AbortSignal) =>
    request<{ chats: Chat[]; next_cursor?: string }>(
      `/api/workspaces/${workspaceId}/chats?filter=${filter}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      signal ? { signal } : undefined,
    ),

  createChat: (workspaceId: string, clientChatId: string, expectedUserId?: string) =>
    request<{ chat: Chat }>(`/api/workspaces/${workspaceId}/chats`, {
      method: 'POST',
      headers: expectedUserId ? { 'x-expected-user-id': expectedUserId } : undefined,
      body: JSON.stringify({ client_chat_id: clientChatId }),
    }),

  getChat: (workspaceId: string, chatId: string, signal?: AbortSignal) =>
    request<ChatDetailResponse>(
      `/api/workspaces/${workspaceId}/chats/${chatId}`,
      signal ? { signal } : undefined,
    ),

  listMessages: (workspaceId: string, chatId: string, beforeSequence?: number | null, signal?: AbortSignal) => {
    const params = new URLSearchParams({ limit: String(DOMAIN_BOUNDS.MAX_TRANSCRIPT_PAGE) });
    if (beforeSequence) params.set('before_sequence', String(beforeSequence));
    return request<MessageListResponse>(
      `/api/workspaces/${workspaceId}/chats/${chatId}/messages?${params.toString()}`,
      signal ? { signal } : undefined,
    );
  },

  sendMessage: (workspaceId: string, chatId: string, clientMessageId: string, text: string, clarificationId?: string, mediaId?: string, expectedUserId?: string, imageMediaIds?: string[], timezone?: string) =>
    request<AcceptMessageResponse>(`/api/workspaces/${workspaceId}/chats/${chatId}/messages`, {
      method: 'POST',
      headers: expectedUserId ? { 'x-expected-user-id': expectedUserId } : undefined,
      body: JSON.stringify({
        client_message_id: clientMessageId,
        text,
        clarification_id: clarificationId,
        ...(mediaId ? { media_id: mediaId } : {}),
        ...(imageMediaIds && imageMediaIds.length > 0 ? { image_media_ids: imageMediaIds } : {}),
        ...(timezone ? { timezone } : {}),
      }),
    }),

  executeCommand: (workspaceId: string, chatId: string, clientMessageId: string, text: string, expectedUserId?: string) =>
    request<AcceptMessageResponse>(`/api/workspaces/${workspaceId}/chats/${chatId}/commands`, {
      method: 'POST',
      headers: expectedUserId ? { 'x-expected-user-id': expectedUserId } : undefined,
      body: JSON.stringify({ client_message_id: clientMessageId, text, presentation: 'control' }),
    }),

  activity: (workspaceId: string, chatId: string, after: number, signal?: AbortSignal) =>
    request<ActivityPageResponse>(
      `/api/workspaces/${workspaceId}/chats/${chatId}/activity?after=${after}`,
      signal ? { signal } : undefined,
    ),

  run: (workspaceId: string, runId: string) =>
    request<RunDetailResponse>(`/api/workspaces/${workspaceId}/runs/${runId}`),

  runs: (workspaceId: string, runIds: string[], signal?: AbortSignal) =>
    request<RunBatchResponse>(
      `/api/workspaces/${workspaceId}/runs?ids=${encodeURIComponent(runIds.join(','))}`,
      signal ? { signal } : undefined,
    ),

  stopRun: (workspaceId: string, runId: string) =>
    request<{ stopped: boolean; run_status: string }>(
      `/api/workspaces/${workspaceId}/runs/${runId}/stop`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  retryRun: (workspaceId: string, runId: string) =>
    request<{ retried: boolean; run_status: string }>(
      `/api/workspaces/${workspaceId}/runs/${runId}/retry`,
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

  clarifications: (workspaceId: string, chatId: string, signal?: AbortSignal) =>
    request<{ clarifications: ClarificationSummary[] }>(
      `/api/workspaces/${workspaceId}/chats/${chatId}/clarifications`,
      signal ? { signal } : undefined,
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

  commands: (surface: 'web' | 'telegram' = 'web', signal?: AbortSignal) =>
    request<CommandRegistryResponse>(`/api/commands?surface=${surface}`, signal ? { signal } : undefined),

  models: (workspaceId: string, chatId?: string, signal?: AbortSignal) =>
    request<ModelListResponse>(
      `/api/workspaces/${workspaceId}/models${chatId ? `?chat_id=${encodeURIComponent(chatId)}` : ''}`,
      signal ? { signal } : undefined,
    ),

  settings: (workspaceId: string) => request<{ settings: WorkspaceSettings }>(`/api/workspaces/${workspaceId}/settings`),
  memberSettings: (workspaceId: string) => request<{ settings: MemberSettings }>(`/api/workspaces/${workspaceId}/me/settings`),
  updateMemberSettings: (workspaceId: string, body: UpdateMemberSettingsRequest) => request<{ settings: MemberSettings }>(`/api/workspaces/${workspaceId}/me/settings`, { method: 'PUT', body: JSON.stringify(body) }),
  updateWorkspaceSettings: (workspaceId: string, body: { default_model: string | null }) => request<{ settings: WorkspaceSettings }>(`/api/workspaces/${workspaceId}/settings`, { method: 'PUT', body: JSON.stringify(body) }),
  credentialStatus: (workspaceId: string, provider: ProviderName) => request<CredentialStatusResponse>(`/api/workspaces/${workspaceId}/credentials/${provider}`),
  putCredential: (workspaceId: string, provider: ProviderName, key: string) => request<CredentialStatusResponse>(`/api/workspaces/${workspaceId}/credentials/${provider}`, { method: 'PUT', body: JSON.stringify({ key }) }),
  deleteCredential: (workspaceId: string, provider: ProviderName) => request<{ status: string; deleted: boolean }>(`/api/workspaces/${workspaceId}/credentials/${provider}`, { method: 'DELETE' }),
  verifyCredential: (workspaceId: string, provider: ProviderName) => request<{ verified: boolean }>(`/api/workspaces/${workspaceId}/credentials/${provider}/verify`, { method: 'POST', body: JSON.stringify({}) }),

  issueTelegramLink: (workspaceId: string) =>
    request<TelegramLinkResponse>(`/api/workspaces/${workspaceId}/telegram/link`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  telegramConnection: (workspaceId: string) =>
    request<TelegramConnectionResponse>(`/api/workspaces/${workspaceId}/telegram/connection`),
  disconnectTelegram: (workspaceId: string) =>
    request<TelegramDisconnectResponse>(`/api/workspaces/${workspaceId}/telegram/connection`, {
      method: 'DELETE',
    }),
  renameChat: (workspaceId: string, chatId: string, title: string) =>
    request<{ chat: Chat }>(`/api/workspaces/${workspaceId}/chats/${encodeURIComponent(chatId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  deleteChat: (workspaceId: string, chatId: string) =>
    request<{ deleted: boolean; chatId: string }>(`/api/workspaces/${workspaceId}/chats/${encodeURIComponent(chatId)}`, {
      method: 'DELETE',
    }),

  createWorkspace: (name: string) =>
    request<{ workspace: { id: string; name: string; role: string } }>(`/api/workspaces`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  updateWorkspace: (workspaceId: string, name: string) =>
    request<{ workspace: { id: string; name: string } }>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  deleteWorkspace: (workspaceId: string) =>
    request<{ deleted: boolean }>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
    }),

  /**
   * Downloads the workspace export document. Returns the raw response so
   * the caller can save the attachment blob; the typed client only parses
   * JSON bodies. Membership is enforced server-side; secrets never ship.
   */
  downloadWorkspaceExport: (workspaceId: string, format: 'json' | 'xlsx' = 'json') =>
    fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/export${format === 'xlsx' ? '?format=xlsx' : ''}`, {
      credentials: 'same-origin',
    }),

  signOut: (signal?: AbortSignal) =>
    request<LogoutResponse>(`/api/auth/session`, {
      method: 'DELETE',
      ...(signal ? { signal } : {}),
    }),

  listMembers: (workspaceId: string) =>
    request<{ members: { user_id: string; role: string; display_name: string | null; email?: string }[] }>(
      `/api/workspaces/${workspaceId}/members`,
    ),

  createInvite: (workspaceId: string, email: string) =>
    request<{ status: string; invite_id: string; token: string; expires_at: string }>(
      `/api/workspaces/${workspaceId}/invites`,
      { method: 'POST', body: JSON.stringify({ email }) },
    ),

  removeMember: (workspaceId: string, userId: string) =>
    request<{ status: string }>(`/api/workspaces/${workspaceId}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    }),

  acceptInvite: (token: string) =>
    request<{ status: string; workspace_id: string }>(`/api/invites/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  activityStreamUrl: (workspaceId: string, chatId: string, after: number) =>
    `/api/workspaces/${workspaceId}/chats/${encodeURIComponent(chatId)}/activity?stream=sse&after=${after}`,

  getRecords: (workspaceId: string, signal?: AbortSignal) =>
    request<{
      lists: Array<{
        id: string;
        name: string;
        description?: string;
        columns: Array<{
          id: string;
          name: string;
          type: 'text' | 'status' | 'phone' | 'currency' | 'number' | 'date' | 'calculation';
          width?: number;
          isCore?: boolean;
          options?: string[];
        }>;
        rows: Array<{
          id: string;
          source: 'entity' | 'task' | 'memory' | 'interaction' | 'draft' | 'custom';
          cells: Record<string, string>;
          provenance?: Record<string, string>;
        }>;
      }>;
      history: Record<
        string,
        Array<{
          id: string;
          timestamp: string;
          actor: 'user' | 'otis';
          description: string;
          affectedCount: number;
          canRestore: boolean;
        }>
      >;
    }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/records`, signal ? { signal } : undefined),

  saveRecords: (
    workspaceId: string,
    payload: {
      listId: string;
      dirtyCells?: Record<string, { columnId: string; currentValue: string }>;
      addedRows?: Array<{ id: string; cells: Record<string, string> }>;
      deletedRowIds?: string[];
    },
  ) =>
    request<{ saved: boolean; affectedCount: number }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/records`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),
};
