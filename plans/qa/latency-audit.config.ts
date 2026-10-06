import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Isolated, synthetic audit checks: no Worker bootstrap, secrets, or network.
export default defineConfig({
  resolve: { alias: { 'idb-keyval': fileURLToPath(new URL('../../apps/web/node_modules/idb-keyval/dist/index.js', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['plans/qa/latency-audit.repro.test.ts', 'plans/qa/efficiency-audit.repro.test.ts'],
  },
});
