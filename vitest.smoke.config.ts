import { defineConfig } from 'vitest/config';

// Opt-in live provider smoke only. Never included in `pnpm test`.
export default defineConfig({
  test: {
    include: ['packages/agent/test/smoke.live.ts'],
    environment: 'node',
  },
});
