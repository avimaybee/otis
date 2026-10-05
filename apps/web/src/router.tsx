/**
 * One typed navigation owner for workspace/chat deep links.
 *
 * The externally usable URL shape is unchanged: `/?workspace=<id>&chat=<id>`
 * with `chat=new` for a new own-chat entry, so shared links and refresh keep
 * working. Router state owns the selected workspace/chat; React Query owns
 * server data; the scoped outbox owns unsent content. No second
 * selected-chat state may disagree with the URL, and no manual
 * pushState/popstate navigation ownership remains beside this router.
 *
 * Route parameters are not authorization: every scoped API request still
 * enforces session/workspace/chat access, a guessed or stale chat ID
 * renders the honest unavailable state, and revocation clears scoped caches.
 */

import { createContext, useContext } from 'react';
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { ConversationScreen } from './ConversationScreen.js';

export interface SessionContextValue {
  userId: string;
  workspaces: { id: string; name: string }[];
  members: Record<string, string>;
  onSignOut: () => void;
  onRefreshSession?: () => Promise<void>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

function sessionOf(): SessionContextValue {
  const session = useContext(SessionContext);
  if (!session) throw new Error('Conversation route requires session context.');
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

const rootRoute = createRootRoute();

function ConversationRouteView() {
  const search = conversationRoute.useSearch();
  const navigate = conversationRoute.useNavigate();
  const session = sessionOf();
  const fallbackWorkspace = session.workspaces[0]?.id ?? '';
  const workspaceId = session.workspaces.some(item => item.id === search.workspace) ? search.workspace! : fallbackWorkspace;
  // Absent ?chat restores the last view; explicit chat=new stays a new chat.
  // Both render with chat=null until the authoritative chat exists.
  const chat: string | null = !search.chat || search.chat === 'new' || search.chat.startsWith('new-') ? null : search.chat;
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
    />
  );
}

export const conversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): ConversationSearch => parseConversationSearch(search),
  component: ConversationRouteView,
});

const routeTree = rootRoute.addChildren([conversationRoute]);

export function createAppRouter(options?: { history?: ReturnType<typeof createMemoryHistory> }) {
  return createRouter({ routeTree, history: options?.history });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
