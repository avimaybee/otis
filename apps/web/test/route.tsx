/** @vitest-environment happy-dom */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { SessionContext, createAppRouter } from '../src/router.js';
import { TestQueryProvider } from './query.js';

export interface RouteSession {
  userId: string;
  workspaces: { id: string; name: string }[];
  members: Record<string, string>;
  onSignOut?: () => void;
}

/**
 * Mounts the production route (typed router + session + query scope) with
 * browser history seeded from the given entry, preserving the shared
 * `?workspace=&chat=` URL shape. Navigation updates window.location, so
 * deep-link, refresh-seed and Back/Forward behavior is exercised, not mocked.
 */
export async function mountRoute(initialEntry: string, session: RouteSession) {
  history.replaceState({}, '', initialEntry);
  const router = createAppRouter();
  await router.load();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => {
    root.render(
      <TestQueryProvider>
        <SessionContext.Provider
          value={{
            userId: session.userId,
            workspaces: session.workspaces,
            members: session.members,
            onSignOut: session.onSignOut ?? (() => {}),
          }}
        >
          <RouterProvider router={router} />
        </SessionContext.Provider>
      </TestQueryProvider>,
    );
  });
  // Scoped query snapshots resolve outside the render act; flush once so
  // assertions observe settled server state, not the loading skeleton.
  await React.act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  return {
    host,
    router,
    unmount: async () => {
      await React.act(async () => root.unmount());
      host.remove();
    },
  };
}
