import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['plans/qa/2026-10-08-message-order.probe.test.ts'] },
});
