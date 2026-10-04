/**
 * Static stand-in for the PWA plugin's `virtual:pwa-register/react` module
 * outside production builds (Storybook). No service worker exists there, so
 * registration reports no pending update and activation is a no-op. The
 * production bundle always uses the real plugin module instead.
 */
export function useRegisterSW() {
  return {
    needRefresh: [false, () => {}] as [boolean, (value: boolean) => void],
    offlineReady: [false, () => {}] as [boolean, (value: boolean) => void],
    updateServiceWorker: async () => {},
  };
}
