import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Workers AI is remote-only. Database/transport tests use an injected
// converter and must never connect to an account or spend model credits.
// Derive the local config from production so bindings cannot drift.
const localWorkerConfig = JSON.parse(readFileSync(new URL('./wrangler.jsonc', import.meta.url), 'utf8')) as Record<string, unknown>;
delete localWorkerConfig.ai;
localWorkerConfig.main = fileURLToPath(new URL('./apps/worker/src/index.ts', import.meta.url));
localWorkerConfig.assets = { ...(localWorkerConfig.assets as object), directory: fileURLToPath(new URL('./apps/web/dist', import.meta.url)) };
for (const db of localWorkerConfig.d1_databases as { migrations_dir: string }[]) db.migrations_dir = fileURLToPath(new URL('./migrations', import.meta.url));
mkdirSync(new URL('./.wrangler', import.meta.url), { recursive: true });
writeFileSync(new URL('./.wrangler/vitest.generated.json', import.meta.url), JSON.stringify(localWorkerConfig));

export default defineConfig({
  test: {
    maxWorkers: 2,
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
            wrangler: { configPath: './.wrangler/vitest.generated.json' },
            miniflare: {
              bindings: {
                GEMINI_API_KEY: '',
                OPENCODE_API_KEY: '',
                OPENCODE_GO_API_KEY: '',
                GROQ_API_KEY: '',
              },
            },
          }),
        ],
        test: {
          name: 'worker',
          include: ['apps/worker/test/**/*.test.ts'],
          // Real local D1/DO tests share CPU during the complete suite. Keep a
          // bounded timeout that also accommodates multi-turn recovery cases.
          testTimeout: 15_000,
          hookTimeout: 30_000,
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
