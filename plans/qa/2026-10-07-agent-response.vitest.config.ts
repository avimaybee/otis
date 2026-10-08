import { defineConfig } from 'vitest/config';
import base from '../../vitest.config';
const worker = base.test.projects.find(project => project.test?.name === 'worker');
export default defineConfig({ test: { projects: [{ ...worker, test: { ...worker.test, include: ['plans/qa/2026-10-07-agent-response.probe.test.ts'] } }] } });
