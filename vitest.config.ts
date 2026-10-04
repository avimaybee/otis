import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'pure',
          include: ['packages/*/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
          }),
        ],
        test: {
          name: 'worker',
          include: ['apps/worker/test/**/*.test.ts'],
          // Real local D1/DO tests share CPU during the complete suite. Keep a
          // bounded timeout that also accommodates multi-turn recovery cases.
          testTimeout: 15_000,
        },
      },
      {
        // Maps the PWA plugin's virtual registration module to a static stub
        // in tests: the service worker itself is a build artifact, while the
        // prompt behavior is asserted through the stubbed hook per test.
        resolve: {
          alias: {
            'virtual:pwa-register/react': fileURLToPath(new URL('./apps/web/test/pwa-register-stub.tsx', import.meta.url)),
          },
        },
        test: {
          name: 'web',
          include: ['apps/web/test/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
        },
      },
    ],
  },
});
