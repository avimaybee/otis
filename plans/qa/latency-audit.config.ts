import { defineConfig } from 'vitest/config';

// Isolated, synthetic audit checks: no Worker bootstrap, secrets, or network.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['plans/qa/latency-audit.repro.test.ts'],
  },
});
