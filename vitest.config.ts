import { defineConfig } from 'vitest/config';
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
        test: {
          name: 'web',
          include: ['apps/web/test/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
        },
      },
    ],
  },
});
