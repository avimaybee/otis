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

export function SignInView({ onSignedIn }: { onSignedIn: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isConfigured } = getClientAuth();

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const idToken = await signInWithGoogle();
      const response = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [AUTH_BOUNDS.CSRF_HEADER]: '1' },
        body: JSON.stringify({ id_token: idToken }),
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
        <p className="otis-entry__note text-sm text-muted-foreground">
          Members of a workspace can read its shared conversations and retained voice notes.
        </p>

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
          {pending ? 'Signing in…' : 'Continue with Google'}
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