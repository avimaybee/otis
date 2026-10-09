import { defineConfig } from 'vitest/config';

// Opt-in provider-only verification. No production database or messages.
export default defineConfig({
  test: { environment: 'node', include: ['plans/qa/capabilities.live.ts'], testTimeout: 60_000 },
});
