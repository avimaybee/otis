import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['plans/qa/telegram-capabilities.live.test.ts'], environment: 'node', testTimeout: 600_000 },
});
