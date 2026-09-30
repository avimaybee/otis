import { useState, useEffect } from 'react';
import type { HealthResponse, MeResponse, AuthSessionResponse } from '@otis/contracts';
import { AUTH_BOUNDS } from '@otis/contracts';
import { TOKENS } from '@otis/design';
import { signInWithGoogle, clientSignOut, getClientAuth } from './firebase.js';

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);

  const { isConfigured: isFirebaseConfigured } = getClientAuth();

  // 1. Initial health and session checks
  useEffect(() => {
    fetch('/api/health')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: HealthResponse | null) => setHealth(data))
      .catch(() => setHealth(null));

    fetch('/api/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: MeResponse | null) => {
        setMe(data);
        setLoading(false);
      })
      .catch(() => {
        setMe(null);
        setLoading(false);
      });
  }, []);

  // 2. Google sign-in flow
  const handleGoogleSignIn = async () => {
    setError(null);
    setIsSigningIn(true);

    try {
      const idToken = await signInWithGoogle();
      const res = await fetch('/api/auth/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [AUTH_BOUNDS.CSRF_HEADER]: '1',
        },
        body: JSON.stringify({ id_token: idToken }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(data?.error?.message || `Authentication failed (HTTP ${res.status})`);
      }

      const sessionData = (await res.json()) as AuthSessionResponse;
      setMe({
        user: sessionData.user,
        workspaces: sessionData.workspaces,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSigningIn(false);
    }
  };

  // 3. Sign out handler
  const handleSignOut = async () => {
    try {
      await fetch('/api/auth/session', {
        method: 'DELETE',
        headers: {
          [AUTH_BOUNDS.CSRF_HEADER]: '1',
        },
      });
      await clientSignOut();
    } finally {
      setMe(null);
    }
  };

  const primaryWorkspace = me?.workspaces[0];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100dvh',
        backgroundColor: TOKENS.colors.dark.bg,
        color: TOKENS.colors.dark.textPrimary,
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
      }}
    >
      {/* App Header */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: '56px',
          padding: `0 ${TOKENS.spacing.lg}`,
          borderBottom: `1px solid ${TOKENS.colors.dark.border}`,
          backgroundColor: TOKENS.colors.dark.surface,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: TOKENS.spacing.sm }}>
          <h1
            style={{
              margin: 0,
              fontSize: TOKENS.typography.title,
              fontWeight: 600,
              letterSpacing: '-0.02em',
            }}
          >
            Otis
          </h1>
          {primaryWorkspace && (
            <span
              style={{
                fontSize: TOKENS.typography.caption,
                padding: '2px 8px',
                borderRadius: '4px',
                backgroundColor: TOKENS.colors.dark.surfaceRaised,
                color: TOKENS.colors.dark.textSecondary,
                border: `1px solid ${TOKENS.colors.dark.border}`,
              }}
            >
              {primaryWorkspace.name}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: TOKENS.spacing.md }}>
          {me ? (
            <button
              onClick={handleSignOut}
              style={{
                minHeight: TOKENS.touchTarget.min,
                padding: `0 ${TOKENS.spacing.md}`,
                backgroundColor: 'transparent',
                color: TOKENS.colors.dark.textSecondary,
                border: `1px solid ${TOKENS.colors.dark.border}`,
                borderRadius: '6px',
                fontSize: TOKENS.typography.caption,
                cursor: 'pointer',
              }}
            >
              Sign out
            </button>
          ) : health ? (
            <span
              style={{
                fontSize: TOKENS.typography.caption,
                color: TOKENS.colors.dark.textSecondary,
              }}
            >
              Connected
            </span>
          ) : null}
        </div>
      </header>

      {/* Main Content Area */}
      <main
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: TOKENS.spacing.lg,
          textAlign: 'center',
        }}
      >
        {loading ? (
          <p style={{ color: TOKENS.colors.dark.textSecondary, fontSize: TOKENS.typography.body }}>
            Loading...
          </p>
        ) : me ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: TOKENS.spacing.md,
              maxWidth: TOKENS.typography.measure,
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: '24px',
                fontWeight: 600,
                color: TOKENS.colors.dark.textPrimary,
              }}
            >
              Welcome, {me.user.display_name || me.user.email}
            </h2>
            <p
              style={{
                margin: 0,
                fontSize: TOKENS.typography.body,
                lineHeight: TOKENS.typography.lineHeight,
                color: TOKENS.colors.dark.textSecondary,
              }}
            >
              Authenticated with Firebase UID{' '}
              <code style={{ color: TOKENS.colors.dark.textPrimary }}>{me.user.firebase_uid}</code>.
            </p>
            <p
              style={{
                margin: 0,
                fontSize: TOKENS.typography.secondary,
                color: TOKENS.colors.dark.textSecondary,
              }}
            >
              Workspace: <strong>{primaryWorkspace?.name || 'None'}</strong> (Role:{' '}
              {primaryWorkspace?.role || 'None'})
            </p>
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: TOKENS.spacing.lg,
              maxWidth: '340px',
              width: '100%',
              padding: TOKENS.spacing.xl,
              backgroundColor: TOKENS.colors.dark.surface,
              borderRadius: '8px',
              border: `1px solid ${TOKENS.colors.dark.border}`,
              textAlign: 'left',
            }}
          >
            <div>
              <h2
                style={{
                  margin: 0,
                  fontSize: TOKENS.typography.title,
                  fontWeight: 600,
                  color: TOKENS.colors.dark.textPrimary,
                }}
              >
                Sign in to Otis
              </h2>
              <p
                style={{
                  margin: `${TOKENS.spacing.xs} 0 0 0`,
                  fontSize: TOKENS.typography.secondary,
                  color: TOKENS.colors.dark.textSecondary,
                }}
              >
                Conversational business memory for Kerning.
              </p>
            </div>

            {error && (
              <div
                style={{
                  padding: TOKENS.spacing.sm,
                  backgroundColor: 'rgba(239, 68, 68, 0.1)',
                  border: `1px solid ${TOKENS.colors.dark.danger}`,
                  borderRadius: '4px',
                  color: TOKENS.colors.dark.danger,
                  fontSize: TOKENS.typography.caption,
                }}
              >
                {error}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: TOKENS.spacing.md }}>
              <button
                onClick={handleGoogleSignIn}
                disabled={isSigningIn || !isFirebaseConfigured}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: TOKENS.spacing.sm,
                  minHeight: TOKENS.touchTarget.min,
                  padding: `0 ${TOKENS.spacing.lg}`,
                  backgroundColor: isFirebaseConfigured
                    ? TOKENS.colors.dark.textPrimary
                    : TOKENS.colors.dark.surfaceRaised,
                  color: isFirebaseConfigured
                    ? TOKENS.colors.dark.bg
                    : TOKENS.colors.dark.textSecondary,
                  border: `1px solid ${TOKENS.colors.dark.border}`,
                  borderRadius: '6px',
                  fontSize: TOKENS.typography.body,
                  fontWeight: 500,
                  cursor: isFirebaseConfigured ? 'pointer' : 'not-allowed',
                  opacity: isSigningIn ? 0.7 : 1,
                }}
              >
                {isSigningIn ? 'Connecting...' : 'Sign in with Google'}
              </button>

              {!isFirebaseConfigured && (
                <p
                  style={{
                    margin: 0,
                    fontSize: TOKENS.typography.caption,
                    color: TOKENS.colors.dark.textSecondary,
                    lineHeight: '1.4',
                  }}
                >
                  Configure <code>VITE_FIREBASE_API_KEY</code> and{' '}
                  <code>VITE_FIREBASE_PROJECT_ID</code> in <code>.env</code> to connect Google sign-in.
                </p>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
