/**
 * @daybook/worker
 * Cloudflare Worker API & Durable Object router for Daybook.
 */

import type { HealthResponse } from '@daybook/contracts';

export interface Env {
  DB?: D1Database;
  STORAGE?: R2Bucket;
  WORKSPACE_ACTOR?: DurableObjectNamespace;
  ASSETS?: Fetcher;
  ENVIRONMENT?: string;
}

/**
 * WorkspaceActor Durable Object
 * Manages serialized turns and queue leases per workspace.
 */
export class WorkspaceActor {
  public state: DurableObjectState;
  public env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response(JSON.stringify({ status: 'active' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health route: safe status check, no internal binding details leaked
    if (url.pathname === '/api/health') {
      const body: HealthResponse = {
        status: 'ok',
        timestamp: new Date().toISOString(),
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      });
    }

    // Static assets fallback
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
