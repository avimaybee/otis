/**
 * Application entry.
 *
 * Chooses the honest screen for the current state: sign-in, an access state,
 * or the conversation. It never renders a technical welcome panel after
 * authentication.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
import { purgeRecordsDraftsForUser } from './components/records/recordsDraftStore.js';
import { deleteVoiceSessionsForUser } from './api/voiceSessions.js';
import { unregisterFlushOwner } from './api/flush.js';
import { clearUserQueries, createAppQueryClient } from './api/queries.js';
import { api, ApiError } from './api/client.js';
import { Alert, AlertDescription } from './components/ui/alert.js';

function extractInviteToken(): string | null {
  try {
    if (typeof window === 'undefined') return null;
    const url = new URL(window.location.href);
    return url.searchParams.get('invite');
  } catch {
    return null;
  }
}

function removeInviteParam(): void {
  try {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (url.searchParams.has('invite')) {
      url.searchParams.delete('invite');
      window.history.replaceState({}, '', url.pathname + (url.search ? url.search : '') + url.hash);
    }
  } catch {
    // ignore
  }
}

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
          <label htmlFor="otis-create-ws-name" className="otis-visually-hidden">Workspace name</label>
          <Input
            id="otis-create-ws-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
            aria-label="Workspace name"
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

/**
 * Upper bound for the server session revoke during sign-out. Local cleanup
 * never waits on the network longer than this; the sign-in screen reports a
 * revoke that did not finish instead of passing silently.
 */
export const SIGN_OUT_SERVER_TIMEOUT_MS = 8_000;

export function App() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [signOutNotice, setSignOutNotice] = useState<string | null>(null);
  const [queryClient] = useState(() => createAppQueryClient());
  // One router for the session; route state owns workspace/chat selection.
  // Outbox rehydration is user-scoped, so it runs in ConversationScreen
  // once the session identity is known rather than here.
  const [router] = useState(() => createAppRouter());

  // Session generation: sign-out/account-switch retires in-flight /api/me
  // responses so a stale success can never restore the old session UI.
  // The single in-flight flight is shared by concurrent triggers.
  const sessionGeneration = useRef(0);
  const inflightSession = useRef<Promise<void> | null>(null);
  const inflightGeneration = useRef(0);

  const loadSession = useCallback(async () => {
    // Coalesce concurrent triggers (focus + visibility + storage + invite):
    // one /api/me flight serves every waiter instead of N parallel reads.
    // A flight from a previous session generation is never joined: after a
    // sign-out the next load always starts fresh instead of inheriting a
    // discarded response.
    if (inflightSession.current && inflightGeneration.current === sessionGeneration.current) {
      await inflightSession.current.catch(() => undefined);
      return;
    }
    const generation = sessionGeneration.current;
    inflightGeneration.current = generation;
    const work = (async () => {
      try {
        const response = await fetch('/api/me', { credentials: 'same-origin' });
        // A sign-out or account switch during flight invalidates this
        // response: a stale success must never restore the old session UI.
        if (sessionGeneration.current !== generation) return;
        if (!response.ok) {
          setState({ status: response.status === 401 ? 'signed_out' : 'unavailable' });
          return;
        }
        const body = (await response.json()) as { user: User; workspaces: WorkspaceSummary[] };
        if (sessionGeneration.current !== generation) return;
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
        if (sessionGeneration.current !== generation) return;
        setState({ status: 'unavailable' });
      }
    })();
    inflightSession.current = work;
    try {
      await work;
    } finally {
      if (inflightSession.current === work) inflightSession.current = null;
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'otis_auth_event') {
        void loadSession();
      }
    };
    const onVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible' && (state.status === 'ready' || state.status === 'no_workspace')) {
        void loadSession();
      }
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onVisibilityOrFocus);
    document.addEventListener('visibilitychange', onVisibilityOrFocus);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onVisibilityOrFocus);
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
    };
  }, [state.status, loadSession]);

  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    const inviteToken = extractInviteToken();
    if (!inviteToken || (state.status !== 'ready' && state.status !== 'no_workspace')) return;

    let cancelled = false;
    setInviteError(null);
    api.acceptInvite(inviteToken)
      .then(async (result) => {
        if (cancelled) return;
        removeInviteParam();
        await loadSession();
        router.navigate({ to: '/', search: { workspace: result.workspace_id, chat: 'new' } });
      })
      .catch((err) => {
        if (cancelled) return;
        removeInviteParam();
        const msg = err instanceof ApiError ? err.message : (err instanceof Error ? err.message : 'Could not accept invitation.');
        setInviteError(msg);
      });

    return () => { cancelled = true; };
  }, [state.status, loadSession, router]);

  if (state.status === 'loading') {
    return (
      <main className="otis-entry">
        <div className="otis-entry__inner">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </main>
    );
  }

  if (state.status === 'unavailable') return <UnavailableScreen offline={deviceOffline()} onRetry={() => void loadSession()} />;

  if (state.status === 'signed_out') {
    return (
      <SignInView
        notice={signOutNotice}
        onSignedIn={() => {
          try {
            localStorage.setItem('otis_auth_event', JSON.stringify({ type: 'sign_in', timestamp: Date.now() }));
          } catch {
            /* storage quota or private browsing */
          }
          void loadSession();
        }}
      />
    );
  }

  const performSignOut = async (userId?: string) => {
    // Invalidate private UI first: the session screen replaces everything
    // before any network or cleanup work, so no private content lingers
    // behind a slow sign-out. Stale session reads die on the generation.
    sessionGeneration.current += 1;
    inflightSession.current = null;
    setState({ status: 'signed_out' });
    // Bounded server revoke through the typed client (deadline + failure
    // log): a hung or failed revoke must neither block local cleanup nor
    // pass silently. The sign-in screen reports the outcome truthfully, so a
    // surviving server session on a shared device is visible, not assumed.
    const revoke = new AbortController();
    const revokeTimer = setTimeout(
      () => revoke.abort(new DOMException('Sign-out revoke timed out', 'TimeoutError')),
      SIGN_OUT_SERVER_TIMEOUT_MS,
    );
    let serverRevoked = false;
    try {
      await api.signOut(revoke.signal);
      serverRevoked = true;
    } catch {
      serverRevoked = false;
    } finally {
      clearTimeout(revokeTimer);
    }
    setSignOutNotice(
      serverRevoked
        ? null
        : 'Signed out on this device. The server session could not be revoked, so this browser may still hold it — sign in again if you need to switch accounts here.',
    );
    await clientSignOut();
    try {
      localStorage.setItem('otis_auth_event', JSON.stringify({ type: 'sign_out', userId, timestamp: Date.now() }));
    } catch {
      /* storage quota or private browsing */
    }
    if (userId) {
      unregisterFlushOwner(userId);
      clearUserQueries(queryClient, userId);
      clearUserOutbox(userId);
      purgeRecordsDraftsForUser(userId);
      await Promise.allSettled([
        deleteDraftsForUser(userId),
        deleteVoiceSessionsForUser(userId),
      ]);
    }
  };

  if (state.status === 'no_workspace') {
    return (
      <>
        {inviteError && (
          <Alert variant="destructive" className="fixed top-2 right-2 z-50 max-w-sm">
            <AlertDescription>{inviteError}</AlertDescription>
            <Button variant="ghost" size="sm" className="mt-1 h-6 px-2 text-xs" onClick={() => setInviteError(null)}>Dismiss</Button>
          </Alert>
        )}
        <NoWorkspaceView
          user={state.user}
          onCreated={() => void loadSession()}
          onSignOut={() => void performSignOut(state.user.id)}
        />
      </>
    );
  }

  const members: Record<string, string> = {};
  if (state.user.display_name) members[state.user.id] = state.user.display_name;

  const signOut = async () => {
    await performSignOut(state.user.id);
  };

  return (
    <QueryClientProvider client={queryClient}>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:p-2 focus:bg-background focus:text-foreground focus:ring-2 focus:ring-ring">
        Skip to main content
      </a>
      {inviteError && (
        <Alert variant="destructive" className="fixed top-2 right-2 z-50 max-w-sm">
          <AlertDescription>{inviteError}</AlertDescription>
          <Button variant="ghost" size="sm" className="mt-1 h-6 px-2 text-xs" onClick={() => setInviteError(null)}>Dismiss</Button>
        </Alert>
      )}
      <UpdatePrompt userId={state.user.id} />
      <SessionContext.Provider
        value={{
          userId: state.user.id,
          workspaces: state.workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name, role: workspace.role })),
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