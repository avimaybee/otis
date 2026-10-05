/**
 * Signed-out entry.
 *
 * Sign-in is a short threshold into the conversation, not a dashboard: one
 * title, one Google action, and any essential disclosure. Health is not
 * authentication, so no connection badge appears here.
 */

import { useState } from 'react';
import { AUTH_BOUNDS } from '@otis/contracts';
import { signInWithGoogle, getClientAuth } from '../firebase.js';
import { Button } from './ui/button.js';
import { Alert, AlertDescription } from './ui/alert.js';

export function SignInView({ onSignedIn, inviteToken: propInviteToken }: { onSignedIn: () => void; inviteToken?: string | null }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isConfigured } = getClientAuth();
  const inviteToken = propInviteToken ?? (() => {
    try {
      if (typeof window === 'undefined') return null;
      return new URL(window.location.href).searchParams.get('invite');
    } catch {
      return null;
    }
  })();

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const idToken = await signInWithGoogle();
      const payload: { id_token: string; invite_token?: string } = { id_token: idToken };
      if (inviteToken) payload.invite_token = inviteToken;
      const response = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [AUTH_BOUNDS.CSRF_HEADER]: '1' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? 'Otis sign-in is unavailable right now.');
      }
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Otis sign-in is unavailable right now.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="otis-entry">
      <div className="otis-entry__inner">
        <h1 className="otis-entry__title text-xl font-medium">Sign in to Otis</h1>
        <p className="otis-entry__proposition text-sm font-medium text-foreground mt-1">
          Keep track of visits, promises, and follow-ups.
        </p>
        <p className="otis-entry__note text-sm text-muted-foreground mt-1">
          Members of a workspace can read its shared conversations and retained voice notes.
        </p>

        {inviteToken && (
          <div className="rounded-xl border border-border bg-card p-3 text-left mb-2">
            <p className="text-sm font-medium text-foreground">Workspace invitation</p>
            <p className="text-xs text-muted-foreground mt-1">
              Sign in with Google to accept your invitation and join the workspace.
            </p>
          </div>
        )}

        {error && (
          <Alert variant="destructive" className="otis-entry__error mb-4 text-sm">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button
          type="button"
          className="otis-entry__action"
          disabled={pending || !isConfigured}
          onClick={submit}
        >
          {pending ? (
            <>
              <span className="otis-spinner" aria-hidden="true" />
              <span>Signing in…</span>
            </>
          ) : (
            'Continue with Google'
          )}
        </Button>

        {!isConfigured && (
          <p className="otis-entry__note text-sm text-muted-foreground">
            Sign-in is not configured on this deployment yet. Ask the workspace owner to finish setup.
          </p>
        )}
      </div>
    </div>
  );
}