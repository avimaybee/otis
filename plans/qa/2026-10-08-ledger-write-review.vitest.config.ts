import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)) },
    miniflare: { bindings: {
      GEMINI_API_KEY: '', OPENCODE_API_KEY: '', OPENCODE_GO_API_KEY: '', GROQ_API_KEY: '',
    } },
  })],
  test: {
    include: ['plans/qa/2026-10-08-ledger-write-review.probe.test.ts'],
    testTimeout: 15_000,
  },
});
