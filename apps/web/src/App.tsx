/**
 * Application entry.
 *
 * Chooses the honest screen for the current state: sign-in, an access state,
 * or the conversation. It never renders a technical welcome panel after
 * authentication.
 */

import { useCallback, useEffect, useState } from 'react';
import type { User, WorkspaceSummary } from '@otis/contracts';
import { clientSignOut } from './firebase.js';
import { ConversationScreen } from './ConversationScreen.js';
import { SignInView } from './components/SignInView.js';
import { Button } from './components/ui/button.js';

type State =
  | { status: 'loading' }
  | { status: 'signed_out' }
  | { status: 'unavailable' }
  | { status: 'no_workspace'; user: User }
  | { status: 'ready'; user: User; workspaces: WorkspaceSummary[]; workspaceId: string };

export function App() {
  const [state, setState] = useState<State>({ status: 'loading' });

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
        workspaceId: body.workspaces[0]!.id,
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
          <p className="otis-entry__note">Loading…</p>
        </div>
      </div>
    );
  }

  if (state.status === 'unavailable') return <div className="otis-entry"><div className="otis-entry__inner"><h1 className="otis-entry__title">Otis is unavailable</h1><p className="otis-entry__note">We could not check your session. Try again shortly.</p><Button className="otis-entry__action" type="button" onClick={() => void loadSession()}>Try again</Button></div></div>;

  if (state.status === 'signed_out') {
    return <SignInView onSignedIn={() => void loadSession()} />;
  }

  if (state.status === 'no_workspace') {
    return (
      <div className="otis-entry">
        <div className="otis-entry__inner">
          <h1 className="otis-entry__title">No workspace yet</h1>
          <p className="otis-entry__note">
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

  return (
    <ConversationScreen
      workspaceId={state.workspaceId}
      workspaces={state.workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }))}
      userId={state.user.id}
      members={members}
      onSignOut={async () => {
        await fetch('/api/auth/session', {
          method: 'DELETE',
          headers: { 'x-otis-csrf': '1' },
          credentials: 'same-origin',
        });
        await clientSignOut();
        setState({ status: 'signed_out' });
      }}
    />
  );
}