/**
 * Deterministic fetch stub for 008A stories that mount components with
 * server reads (App entry states, SettingsPane, DetailPane, SourcePane).
 * Synthetic payloads only. Installs during render so the component's own
 * effects observe it; restores the original fetch on unmount.
 */

import { useEffect } from 'react';

export interface MockRoute {
  match: (url: string, method: string) => boolean;
  status?: number;
  body?: unknown;
  blob?: Blob;
  response?: (url: string, method: string) => Response;
  hang?: boolean;
  networkError?: boolean;
}

let originalFetch: typeof fetch | null = null;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function installMockFetch(routes: MockRoute[]): void {
  if (!originalFetch) originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const route = routes.find(candidate => candidate.match(url, method));
    if (!route) return jsonResponse({ error: { code: 'not_found', message: 'No story mock for this request.' } }, 404);
    if (route.hang) return new Promise<Response>(() => {});
    if (route.networkError) throw new TypeError('Storybook synthetic network failure.');
    if (route.response) return route.response(url, method);
    return route.blob ? new Response(route.blob, { status: route.status ?? 200, headers: { 'Content-Type': route.blob.type } }) : jsonResponse(route.body ?? {}, route.status ?? 200);
  }) as typeof fetch;
}

export function restoreMockFetch(): void {
  if (originalFetch) {
    window.fetch = originalFetch;
    originalFetch = null;
  }
}

export function MockApi({ routes, children }: { routes: MockRoute[]; children: React.ReactNode }) {
  installMockFetch(routes);
  useEffect(() => () => restoreMockFetch(), []);
  return <>{children}</>;
}
