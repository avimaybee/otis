import {defineConfig} from 'vitest/config';
import base from '../../vitest.config';
const worker = base.test.projects.find(p => p.test?.name === 'worker');
export default defineConfig({test:{projects:[{...worker,test:{...worker.test,include:['plans/qa/2026-10-07-image-context.probe.test.ts']}}]}});
