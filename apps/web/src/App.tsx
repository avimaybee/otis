/**
 * Application entry.
 *
 * Chooses the honest screen for the current state: sign-in, an access state,
 * or the conversation. It never renders a technical welcome panel after
 * authentication.
 */

import { useCallback, useEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import type { User, WorkspaceSummary } from '@otis/contracts';
import { clientSignOut } from './firebase.js';
import { SessionContext, createAppRouter } from './router.js';
import { SignInView } from './components/SignInView.js';
import { UnavailableScreen } from './components/UnavailableScreen.js';
import { UpdatePrompt } from './components/UpdatePrompt.js';
import { Button } from './components/ui/button.js';
import { clearUserOutbox } from './api/outbox.js';
import { deleteDraftsForUser } from './api/drafts.js';
import { unregisterFlushOwner } from './api/flush.js';
import { clearUserQueries, createAppQueryClient } from './api/queries.js';

/** Device connectivity hint only; reachability is proven per request. */
function deviceOffline(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  } catch {
    return false;
  }
}

type State =
  | { status: 'loading' }
  | { status: 'signed_out' }
  | { status: 'unavailable' }
  | { status: 'no_workspace'; user: User }
  | { status: 'ready'; user: User; workspaces: WorkspaceSummary[] };

export function App() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [queryClient] = useState(() => createAppQueryClient());
  // One router for the session; route state owns workspace/chat selection.
  // Outbox rehydration is user-scoped, so it runs in ConversationScreen
  // once the session identity is known rather than here.
  const [router] = useState(() => createAppRouter());

  const loadSession = useCallback(async () => {
    try {
      const response = await fetch('/api/me', { credentials: 'same-origin' });
      if (!response.ok) {
        setState({ status: response.status === 401 ? 'signed_out' : 'unavailable' });
        return;
      }
      const body = (await response.json()) as { user: User; workspaces: WorkspaceSummary[] };
      if (body.workspaces.length === 0) {
        setState({ status: 'no_workspace', user: body.user });
        return;
      }
      setState({
        status: 'ready',
        user: body.user,
        workspaces: body.workspaces,
      });
    } catch {
      setState({ status: 'unavailable' });
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  if (state.status === 'loading') {
    return (
      <div className="otis-entry">
        <div className="otis-entry__inner">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </div>
    );
  }

  if (state.status === 'unavailable') return <UnavailableScreen offline={deviceOffline()} onRetry={() => void loadSession()} />;

  if (state.status === 'signed_out') {
    return <SignInView onSignedIn={() => void loadSession()} />;
  }

  if (state.status === 'no_workspace') {
    return (
      <div className="otis-entry">
        <div className="otis-entry__inner">
          <h1 className="otis-entry__title text-xl font-medium">No workspace yet</h1>
          <p className="text-sm text-muted-foreground">
            Ask a workspace owner for an invite, then sign in again. Members of a workspace share its
            conversations and retained voice notes.
          </p>
          <Button
            type="button"
            className="otis-entry__action"
            onClick={async () => {
              await clientSignOut();
              setState({ status: 'signed_out' });
            }}
          >
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  const members: Record<string, string> = {};
  if (state.user.display_name) members[state.user.id] = state.user.display_name;

  const signOut = async () => {
    const userId = state.user.id;
    await fetch('/api/auth/session', {
      method: 'DELETE',
      headers: { 'x-otis-csrf': '1' },
      credentials: 'same-origin',
    });
    await clientSignOut();
    unregisterFlushOwner(userId);
    clearUserQueries(queryClient, userId);
    clearUserOutbox(userId);
    void deleteDraftsForUser(userId);
    setState({ status: 'signed_out' });
  };

  return (
    <QueryClientProvider client={queryClient}>
      <UpdatePrompt userId={state.user.id} />
      <SessionContext.Provider
        value={{
          userId: state.user.id,
          workspaces: state.workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name })),
          members,
          onSignOut: signOut,
        }}
      >
        <RouterProvider router={router} />
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}