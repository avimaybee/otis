/**
 * Dogfood diagnostics for the worker dispatch chain.
 *
 * Namespaced logs at each link: handler construction, dispatch entry/outcome,
 * run start, and terminal failures. Fields are IDs, statuses, error codes,
 * and booleans only — never keys, prompts, message bodies, or raw provider
 * payloads. Visible via `wrangler tail` / dashboard logs; the client shows
 * the persisted run error code separately.
 */

export function workerDebug(scope: string, message: string, data?: Record<string, unknown>): void {
  console.debug(`[otis:${scope}] ${message}`, data ?? {});
}

export function workerFailure(scope: string, message: string, data?: Record<string, unknown>): void {
  console.error(`[otis:${scope}] ${message}`, data ?? {});
}