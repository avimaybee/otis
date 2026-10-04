import type { StorybookConfig } from '@storybook/react-vite';
import { mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  core: {
    disableTelemetry: true,
  },
  /**
   * Same CSS pipeline as the app: React plus the Tailwind v4 plugin so
   * utilities, @theme tokens and @apply directives compile identically.
   * The PWA plugin stays out of Storybook: its service worker, precache
   * manifest and update prompt belong to the installed production shell,
   * not to component review (and its precache budget rejects Storybook's
   * own multi-megabyte manager bundle).
   */
  async viteFinal(base) {
    // The production PWA plugin family (vite-plugin-pwa, :build, :info,
    // :dev-sw, :pwa-assets) must never enter Storybook's manager or preview
    // pipelines: its precache budget rejects Storybook's own multi-megabyte
    // manager bundle. Production builds own PWA through the root config.
    const incoming = Array.isArray(base.plugins) ? base.plugins.flat(Infinity) : [];
    const plugins = incoming.filter(
      plugin => plugin && !(typeof (plugin as { name?: string }).name === 'string' && (plugin as { name: string }).name.startsWith('vite-plugin-pwa')),
    );
    return mergeConfig(base, {
      plugins: [...plugins, react(), tailwindcss()],
      resolve: {
        alias: {
          // Storybook has no service worker: the update prompt's virtual
          // registration module resolves to a static fallback here.
          // Production builds use the real plugin module instead.
          'virtual:pwa-register/react': fileURLToPath(new URL('../src/pwa-register-fallback.ts', import.meta.url)),
        },
      },
    });
  },
};

export default config;
