import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['plans/qa/telegram-voice-and-continuation.live.test.ts'], environment: 'node', testTimeout: 180_000 } });
