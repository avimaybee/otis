import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: {
      bindings: { ENVIRONMENT: 'test', GEMINI_API_KEY: '', OPENCODE_API_KEY: '', OPENCODE_GO_API_KEY: '', GROQ_API_KEY: '' },
      // Keep the actual workerd fetch receiver while intercepting every outbound
      // request at Miniflare's service boundary. No real provider is contacted.
      outboundService: async (request) => {
        const url = new URL(request.url);
        if (url.origin === 'https://api.groq.com' && url.pathname === '/openai/v1/audio/transcriptions' && request.method === 'POST') {
          return Response.json({ text: 'Synthetic transport fixture.', language: 'en', duration: 1 });
        }
        return new Response('Unexpected audit network request', { status: 503 });
      },
    },
  })],
  test: { include: ['plans/qa/telegram-provider-audit.worker.test.ts'], testTimeout: 15_000 },
});
