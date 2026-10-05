import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { bindings: { GEMINI_API_KEY: '', OPENCODE_API_KEY: '', OPENCODE_GO_API_KEY: '', GROQ_API_KEY: '' } },
  })],
  test: { include: ['plans/qa/sol-resolution-claim-worker.repro.test.ts'], testTimeout: 15000 },
});
