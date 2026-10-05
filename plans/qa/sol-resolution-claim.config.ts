import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: { alias: { '@otis/contracts': resolve('packages/contracts/src/index.ts') } },
  test: { environment: 'happy-dom', include: ['plans/qa/sol-resolution-claim.repro.test.ts'] },
});
