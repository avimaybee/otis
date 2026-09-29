import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';

describe('Worker Integration in workerd runtime', () => {
  it('returns status ok without leaking bindings through real workerd', async () => {
    const res = await SELF.fetch('http://localhost/api/health');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');

    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toHaveProperty('status', 'ok');
    expect(json).toHaveProperty('timestamp');
    expect(typeof json['timestamp']).toBe('string');

    // Asserts no internal secrets or bindings are leaked
    expect(json).not.toHaveProperty('DB');
    expect(json).not.toHaveProperty('STORAGE');
    expect(json).not.toHaveProperty('WORKSPACE_ACTOR');
  });

  it('proves D1, R2, and Durable Object bindings exist in workerd', () => {
    expect(env.DB).toBeDefined();
    expect(env.STORAGE).toBeDefined();
    expect(env.WORKSPACE_ACTOR).toBeDefined();
  });

  it('proves WorkspaceActor Durable Object executes in workerd', async () => {
    const id = env.WORKSPACE_ACTOR.idFromName('test-ws');
    const stub = env.WORKSPACE_ACTOR.get(id);
    const res = await stub.fetch('http://localhost/');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json['status']).toBe('active');
  });

  it('returns 404 for unknown API endpoints', async () => {
    const res = await SELF.fetch('http://localhost/api/unknown-endpoint');
    expect(res.status).toBe(404);
  });
});
