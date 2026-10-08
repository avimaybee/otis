/**
 * One typed navigation owner for workspace/chat and records deep links.
 *
 * The externally usable URL shape: `/?workspace=<id>&chat=<id>`
 * and `/records?workspace=<id>&list=<id>`. Router state owns the selected
 * workspace/chat/records view; React Query owns server data; the scoped outbox
 * owns unsent content. No second selected-workspace/chat/list store disagrees
 * with the URL, and no manual pushState/popstate navigation ownership remains.
 */

import { createContext, useContext } from 'react';
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { ConversationScreen } from './ConversationScreen.js';
import { RecordsScreen } from './components/records/RecordsScreen.js';

export interface SessionContextValue {
  userId: string;
  workspaces: { id: string; name: string; role?: string }[];
  members: Record<string, string>;
  onSignOut: () => void;
  onRefreshSession?: () => Promise<void>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

function sessionOf(): SessionContextValue {
  const session = useContext(SessionContext);
  if (!session) throw new Error('Route requires session context.');
  return session;
}

/** Search shape for the single conversation route. Unknown params are dropped. */
export interface ConversationSearch {
  workspace?: string;
  chat?: string;
}

/**
 * Pure search normalizer and the single place the URL shape is defined.
 * Unknown parameters never become selection state.
 */
export function parseConversationSearch(raw: Record<string, unknown>): ConversationSearch {
  const search: ConversationSearch = {};
  if (typeof raw['workspace'] === 'string' && raw['workspace']) search.workspace = raw['workspace'];
  if (typeof raw['chat'] === 'string' && raw['chat']) search.chat = raw['chat'];
  return search;
}

/** Search shape for records route. */
export interface RecordsSearch {
  workspace?: string;
  list?: string;
}

export function parseRecordsSearch(raw: Record<string, unknown>): RecordsSearch {
  const search: RecordsSearch = {};
  if (typeof raw['workspace'] === 'string' && raw['workspace']) search.workspace = raw['workspace'];
  if (typeof raw['list'] === 'string' && raw['list']) search.list = raw['list'];
  return search;
}

const rootRoute = createRootRoute();

function ConversationRouteView() {
  const search = conversationRoute.useSearch();
  const navigate = conversationRoute.useNavigate();
  const session = sessionOf();
  const fallbackWorkspace = session.workspaces[0]?.id ?? '';
  const workspaceId = session.workspaces.some(item => item.id === search.workspace) ? search.workspace! : fallbackWorkspace;
  // Absent ?chat restores the last view; explicit chat=new stays a new chat.
  // Both render with chat=null until the authoritative chat exists.
  const chat: string | null = !search.chat || search.chat === 'new' ? null : search.chat;
  return (
    <ConversationScreen
      workspaceId={workspaceId}
      chat={chat}
      chatParamPresent={search.chat !== undefined}
      workspaces={session.workspaces}
      userId={session.userId}
      members={session.members}
      onSignOut={session.onSignOut}
      onRefreshSession={session.onRefreshSession}
      onNavigate={(workspace, nextChat, replace) =>
        navigate({ to: '/', search: { workspace, chat: nextChat ?? 'new' }, replace: replace ?? false })
      }
      onNavigateToRecords={workspace =>
        navigate({ to: '/records', search: { workspace }, replace: false })
      }
    />
  );
}

function RecordsRouteView() {
  const search = recordsRoute.useSearch();
  const navigate = recordsRoute.useNavigate();
  const session = sessionOf();
  const fallbackWorkspace = session.workspaces[0]?.id ?? '';
  const workspaceId = session.workspaces.some(item => item.id === search.workspace) ? search.workspace! : fallbackWorkspace;
  return (
    <RecordsScreen
      workspaceId={workspaceId}
      listId={search.list ?? null}
      workspaces={session.workspaces}
      userId={session.userId}
      members={session.members}
      onSignOut={session.onSignOut}
      onRefreshSession={session.onRefreshSession}
      onNavigate={(workspace, nextChat, replace) =>
        navigate({ to: '/', search: { workspace, chat: nextChat ?? 'new' }, replace: replace ?? false })
      }
      onNavigateToList={(workspace, listId, replace) =>
        navigate({ to: '/records', search: { workspace, list: listId }, replace: replace ?? false })
      }
    />
  );
}

export const conversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): ConversationSearch => parseConversationSearch(search),
  component: ConversationRouteView,
});

export const recordsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/records',
  validateSearch: (search: Record<string, unknown>): RecordsSearch => parseRecordsSearch(search),
  component: RecordsRouteView,
});

const routeTree = rootRoute.addChildren([conversationRoute, recordsRoute]);

export function createAppRouter(options?: { history?: ReturnType<typeof createMemoryHistory> }) {
  return createRouter({ routeTree, history: options?.history });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
