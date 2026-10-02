import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import path from 'node:path';
export default defineConfig({
 resolve:{alias:{'@otis/agent':path.resolve('packages/agent/src/index.ts'),'@otis/ledger':path.resolve('packages/ledger/src/index.ts'),'@otis/contracts':path.resolve('packages/contracts/src/index.ts'),'@otis/identity':path.resolve('packages/identity/src/index.ts')}},
 test:{projects:[{plugins:[cloudflareTest({wrangler:{configPath:'./wrangler.jsonc'}})],test:{name:'review-worker',include:['plans/review-evidence/*.repro.test.ts']}}]}
});
