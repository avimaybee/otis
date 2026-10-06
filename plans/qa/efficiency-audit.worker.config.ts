import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { bindings: { ENVIRONMENT: 'test', GEMINI_API_KEY: '', OPENCODE_API_KEY: '', OPENCODE_GO_API_KEY: '', GROQ_API_KEY: '' } },
  })],
  test: { include: ['plans/qa/efficiency-audit.worker.test.ts'], testTimeout: 15_000 },
});
