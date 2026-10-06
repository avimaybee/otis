import { defineConfig } from 'vitest/config';

// Explicitly invoked only. No production database or Telegram mutation.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['plans/qa/telegram-model-audit.live.test.ts'],
    testTimeout: 300_000,
  },
});
