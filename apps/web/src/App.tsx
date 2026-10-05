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
import { Input } from './components/ui/input.js';
import { clearUserOutbox } from './api/outbox.js';
import { deleteDraftsForUser } from './api/drafts.js';
import { unregisterFlushOwner } from './api/flush.js';
import { clearUserQueries, createAppQueryClient } from './api/queries.js';
import { api } from './api/client.js';

function NoWorkspaceView({ user, onCreated, onSignOut }: { user: User; onCreated: () => void; onSignOut: () => void }) {
  const [name, setName] = useState(user.display_name ? `${user.display_name}’s Workspace` : 'My Workspace');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    setError('');
    try {
      await api.createWorkspace(trimmed);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create workspace. Try again.');
      setCreating(false);
    }
  };

  return (
    <div className="otis-entry">
      <div className="otis-entry__inner">
        <h1 className="otis-entry__title text-xl font-medium">Create your workspace</h1>
        <p className="text-sm text-muted-foreground">
          You don’t have a workspace yet. Create one now to begin remembering, organizing, and chatting with Otis.
        </p>
        <form onSubmit={handleCreate} className="flex flex-col gap-2 w-full max-w-sm mt-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
            disabled={creating}
            required
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="submit" disabled={creating || !name.trim()} className="w-full">
            {creating ? 'Creating…' : 'Create workspace'}
          </Button>
        </form>
        <Button
          type="button"
          variant="ghost"
          className="otis-entry__action mt-4"
          onClick={onSignOut}
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}

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
      <NoWorkspaceView
        user={state.user}
        onCreated={() => void loadSession()}
        onSignOut={async () => {
          await clientSignOut();
          setState({ status: 'signed_out' });
        }}
      />
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
          onRefreshSession: loadSession,
        }}
      >
        <RouterProvider router={router} />
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}