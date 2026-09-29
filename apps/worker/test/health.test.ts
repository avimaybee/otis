import { describe, it, expect } from 'vitest';
import worker, { type Env } from '../src/index.js';

describe('Worker /api/health Endpoint', () => {
  it('returns status ok without leaking bindings or environment secrets', async () => {
    const fakeEnv: Env = {
      ENVIRONMENT: 'production-secret-env',
    };

    const req = new Request('http://localhost/api/health');
    const res = await worker.fetch(req, fakeEnv, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');

    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toHaveProperty('status', 'ok');
    expect(json).toHaveProperty('timestamp');
    expect(typeof json['timestamp']).toBe('string');

    // Asserts no internal secrets or bindings are present
    expect(json).not.toHaveProperty('ENVIRONMENT');
    expect(json).not.toHaveProperty('DB');
    expect(json).not.toHaveProperty('STORAGE');
    expect(json).not.toHaveProperty('WORKSPACE_ACTOR');
  });

  it('returns 404 for unknown endpoints when no assets binding is provided', async () => {
    const req = new Request('http://localhost/unknown-path');
    const res = await worker.fetch(req, {}, {} as ExecutionContext);
    expect(res.status).toBe(404);
  });
});
