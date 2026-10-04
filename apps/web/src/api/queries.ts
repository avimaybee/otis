/**
 * One server-state owner for 008B (React Query).
 *
 * Worker/D1 own accepted messages, runs, activity, settings and receipts.
 * These queries own their browser snapshots, keyed by authenticated user,
 * workspace, chat and resource so a late result can never restore another
 * scope's content. The outbox module owns unsent local delivery state;
 * `transcript.ts` derives the visible transcript from both.
 *
 * Queries never retry automatically: every failure is explicit and the
 * owning retry path (send retry, reload, reconnect) decides what happens.
 * Logout, account change and revocation cancel in-flight work and remove
 * cached content via `clearUserQueries`.
 */

import { QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Chat,
  ChatDetailResponse,
  ChatMessage,
  ClarificationSummary,
  CommandRegistryResponse,
  ModelListResponse,
  PublicActivity,
  RunDetailResponse,
} from '@otis/contracts';
import { api } from './client.js';
import { debugLog } from './log.js';

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 10_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
}

export const qk = {
  chats: (userId: string, workspaceId: string, filter: 'mine' | 'team') =>
    ['otis', userId, workspaceId, 'chats', filter] as const,
  chat: (userId: string, workspaceId: string, chatId: string) =>
    ['otis', userId, workspaceId, 'chat', chatId] as const,
  models: (userId: string, workspaceId: string, chatId: string | null) =>
    ['otis', userId, workspaceId, 'models', chatId ?? 'none'] as const,
  commands: () => ['otis', 'commands'] as const,
};

export interface ChatListState {
  chats: Chat[];
  nextCursor?: string;
}

export function useNavChats(userId: string, workspaceId: string, filter: 'mine' | 'team', disabled: boolean) {
  return useQuery({
    queryKey: qk.chats(userId, workspaceId, filter),
    queryFn: async (): Promise<ChatListState> => {
      const page = await api.listChats(workspaceId, filter);
      return { chats: page.chats, nextCursor: page.next_cursor };
    },
    enabled: !disabled,
  });
}

export async function fetchMoreChats(
  client: QueryClient,
  userId: string,
  workspaceId: string,
  filter: 'mine' | 'team',
): Promise<void> {
  const key = qk.chats(userId, workspaceId, filter);
  const current = client.getQueryData<ChatListState>(key);
  if (!current?.nextCursor) return;
  const page = await api.listChats(workspaceId, filter, current.nextCursor);
  client.setQueryData<ChatListState>(key, {
    chats: [...new Map([...current.chats, ...page.chats].map(chat => [chat.id, chat])).values()],
    nextCursor: page.next_cursor,
  });
}

export function useModels(userId: string, workspaceId: string, chatId: string | null, revision: number, readOnly: boolean) {
  return useQuery({
    queryKey: [...qk.models(userId, workspaceId, chatId), revision] as const,
    queryFn: async () => api.models(workspaceId, chatId ?? undefined),
    enabled: !readOnly,
  });
}

export function useCommands(disabled: boolean) {
  return useQuery({
    queryKey: qk.commands(),
    queryFn: (): Promise<CommandRegistryResponse> => api.commands(),
    staleTime: 60_000,
    enabled: !disabled,
  });
}

/** Cancel in-flight work and remove a user's cached content. Never restores it. */
export function clearUserQueries(client: QueryClient, userId: string): void {
  void client.cancelQueries({ queryKey: ['otis', userId] });
  client.removeQueries({ queryKey: ['otis', userId] });
  debugLog('queries', 'cleared user scope', { userId });
}

export function useAppQueryClient(): QueryClient {
  return useQueryClient();
}

export type {
  ChatDetailResponse,
  ChatMessage,
  ClarificationSummary,
  ModelListResponse,
  PublicActivity,
  RunDetailResponse,
};
