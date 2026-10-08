import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Pin the reviewed implementation without reverting other sessions' edits.
const baseline = '99d587195c519226fa2efe78c1cd427a40085877';
const files = ['apps/web/src/api/client.ts', 'apps/web/src/api/snapshot.ts', 'apps/web/src/ConversationScreen.tsx',
  'apps/web/src/api/queries.ts', 'apps/web/src/hooks/useActivityStream.ts', 'apps/web/test/snapshot-fetch.test.tsx'];
const pinned = new Map(files.map(file => [
  fileURLToPath(new URL(`../../${file}`, import.meta.url)).replaceAll('\\', '/'),
  execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' }),
]));
export default defineConfig({
  plugins: [{ name: 'otis-r01-reviewed-commit', enforce: 'pre', load(id) { return pinned.get(id.split('?')[0].replaceAll('\\', '/')) ?? null; } }],
  resolve: { alias: {
    'react': fileURLToPath(new URL('../../apps/web/node_modules/react', import.meta.url)),
    'react-dom': fileURLToPath(new URL('../../apps/web/node_modules/react-dom', import.meta.url)),
    'idb-keyval': fileURLToPath(new URL('../../apps/web/node_modules/idb-keyval/dist/index.js', import.meta.url)),
    '@tanstack/react-query': fileURLToPath(new URL('../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js', import.meta.url)),
    'virtual:pwa-register/react': fileURLToPath(new URL('../../apps/web/test/pwa-register-stub.tsx', import.meta.url)),
  } },
  test: { environment: 'happy-dom', include: ['plans/qa/2026-10-07-r01-review.probe.test.tsx', 'plans/qa/2026-10-07-surgery1-review.probe.test.ts'] },
});
