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
