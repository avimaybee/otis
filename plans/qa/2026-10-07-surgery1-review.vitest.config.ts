import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Read the reported commit without reverting concurrent workspace changes.
const baseline = 'f73c0a6360c6487b06e534ac98afe8446e10a8cc';
const pinnedFiles = [
  'apps/web/src/api/client.ts',
  'apps/web/src/api/snapshot.ts',
  'apps/web/src/ConversationScreen.tsx',
  'apps/web/test/snapshot-fetch.test.tsx',
];
const pinned = new Map(pinnedFiles.map(file => [
  fileURLToPath(new URL(`../../${file}`, import.meta.url)).replaceAll('\\', '/'),
  execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' }),
]));

export default defineConfig({
  plugins: [{
    name: 'otis-surgery1-committed-source',
    enforce: 'pre',
    load(id) { return pinned.get(id.split('?')[0].replaceAll('\\', '/')) ?? null; },
  }],
  resolve: {
    alias: {
      '@tanstack/react-query': fileURLToPath(new URL('../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js', import.meta.url)),
      'virtual:pwa-register/react': fileURLToPath(new URL('../../apps/web/test/pwa-register-stub.tsx', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    include: [
      'plans/qa/2026-10-07-surgery1-review.probe.test.ts',
      'apps/web/test/snapshot-fetch.test.tsx',
      'apps/web/test/offline-flush.test.tsx',
    ],
  },
});
