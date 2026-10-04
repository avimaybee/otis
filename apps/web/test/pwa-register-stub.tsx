import { vi } from 'vitest';

/**
 * Static stand-in for the PWA plugin's `virtual:pwa-register/react` module
 * in tests. The service worker is a build artifact; prompt behavior is
 * asserted per test by overriding this hook with `vi.mock`.
 */
export function useRegisterSW() {
  return {
    needRefresh: [false, vi.fn()],
    offlineReady: [false, vi.fn()],
    updateServiceWorker: vi.fn(),
  };
}
