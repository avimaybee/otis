import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Offline fixture evaluation suite. Invoked via `pnpm eval:agent`.
export default defineConfig({
  resolve: {
    alias: {
      '@otis/agent': path.resolve(__dirname, './packages/agent/src/index.ts'),
      '@otis/ledger': path.resolve(__dirname, './packages/ledger/src/index.ts'),
      '@otis/contracts': path.resolve(__dirname, './packages/contracts/src/index.ts'),
      '@otis/identity': path.resolve(__dirname, './packages/identity/src/index.ts'),
    },
  },
  test: {
    include: ['eval/**/*.test.ts'],
    environment: 'node',
  },
});
