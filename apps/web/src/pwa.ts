/**
 * PWA packaging contract for the 008D static offline shell (tested here, so
 * the service-worker cache can never silently broaden to private traffic).
 *
 * The worker caches versioned static shell/fonts/assets only: every bundle
 * asset ships with a content hash, and navigation falls back to the shell.
 * API, authentication, activity streams, private audio, provider traffic and
 * credentials are never cached and never persisted: no runtime caching
 * entries exist, and navigation to /api/* is explicitly denied the shell
 * fallback. Manifest carries no colors or icons and no secrets; visual
 * values stay in design-tokens.md and the token-owned stylesheet.
 */

export const PWA_STATIC_GLOBS = ['**/*.{js,css,html,woff,woff2}'] as const;

export const PWA_API_DENYLIST = [/^\/api/] as const;

/**
 * No installability manifest ships yet: vite-plugin-pwa injects default
 * colors (white splash, foreign green theme) and there are no approved
 * icon assets, so emitting it would misrepresent the approved charcoal
 * baseline. The offline static shell (precached below) does not need one.
 * Revisit only with approved icon/color assets; never invent them here.
 */
export const PWA_MANIFEST = false as const;

export interface PwaWorkboxConfig {
  globPatterns: string[];
  navigateFallback: string;
  navigateFallbackDenylist: RegExp[];
  cleanupOutdatedCaches: boolean;
}

export const PWA_WORKBOX: PwaWorkboxConfig = {
  globPatterns: [...PWA_STATIC_GLOBS],
  navigateFallback: 'index.html',
  navigateFallbackDenylist: [...PWA_API_DENYLIST],
  cleanupOutdatedCaches: true,
};
