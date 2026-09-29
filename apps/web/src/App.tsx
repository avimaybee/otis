import { useState, useEffect } from 'react';
import type { HealthResponse } from '@daybook/contracts';
import { TOKENS } from '@daybook/design';

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: HealthResponse | null) => setHealth(data))
      .catch(() => setHealth(null));
  }, []);

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
        <h1
          style={{
            margin: 0,
            fontSize: TOKENS.typography.title,
            fontWeight: 600,
            letterSpacing: '-0.02em',
          }}
        >
          Daybook
        </h1>
        {health && (
          <span
            style={{
              fontSize: TOKENS.typography.caption,
              color: TOKENS.colors.dark.textSecondary,
            }}
          >
            Connected
          </span>
        )}
      </header>

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
        <p
          style={{
            maxWidth: TOKENS.typography.measure,
            fontSize: TOKENS.typography.body,
            lineHeight: TOKENS.typography.lineHeight,
            color: TOKENS.colors.dark.textSecondary,
            margin: 0,
          }}
        >
          A business memory you talk to.
        </p>
      </main>
    </div>
  );
}
