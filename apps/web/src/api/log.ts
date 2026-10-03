/**
 * Dogfood diagnostics.
 *
 * Namespaced console logs at the client failure points: send/accept, chat
 * load, run fetch, and the activity stream. `debug` carries flow (IDs,
 * statuses, counts, durations — never message bodies) and only shows with
 * Verbose enabled; `failure` always surfaces. Open DevTools console to
 * pinpoint whether a stuck message failed acceptance, dispatch, or the run.
 */

export function debugLog(scope: string, message: string, data?: Record<string, unknown>): void {
  console.debug(`[otis:${scope}] ${message}`, data ?? {});
}

export function failureLog(scope: string, message: string, data?: Record<string, unknown>): void {
  console.error(`[otis:${scope}] ${message}`, data ?? {});
}