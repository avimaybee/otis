import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
// @ts-expect-error vite raw import
import migration0001Sql from '../../../migrations/0001_identity.sql?raw';
// @ts-expect-error vite raw import
import migration0002Sql from '../../../migrations/0002_conversations_sources.sql?raw';
// @ts-expect-error vite raw import
import migration0004Sql from '../../../migrations/0004_lifecycle_settings.sql?raw';
import { AUTH_BOUNDS } from '@otis/contracts';
import type { HttpErrorResponse } from '@otis/contracts';
import {
  base64UrlEncode,
  getCredentialMetadata,
  importWrappingKey,
  removeMember,
  setWorkspaceCredential,
  sha256,
} from '@otis/identity';
import {
  createRegistry,
  receiverSafeFetch,
  type ModelEntry,
} from '@otis/agent';
import {
  resolveModelForChat,
  runProviderTurn,
  validateWorkspaceDefaultModel,
  verifyWorkspaceCredential,
} from '../src/providers/service.js';

const CSRF = {
  origin: 'http://localhost',
  [AUTH_BOUNDS.CSRF_HEADER]: '1',
  'Content-Type': 'application/json',
};

const CHAT_SSE = [
  'data: {"choices":[{"delta":{"content":"Hi Hunor."}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_w1","function":{"name":"echo_fixture","arguments":"{\\"fixture_id\\":\\"w1\\"}"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":6,"total_tokens":18}}\n\n',
  'data: [DONE]\n\n',
].join('');

function stubFetch(): (url: string, init: RequestInit) => Promise<Response> {
  return async (url: string, init: RequestInit) => {
    void url;
    void init;
    return new Response(CHAT_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
}

describe('Worker Providers Integration (workerd)', () => {
  const ws = 'ws-prov-test';
  const wsOther = 'ws-prov-other';
  const aviId = 'usr_prov_avi';
  const hunorId = 'usr_prov_hunor';
  const chatAvi = 'chat_prov_avi';
  let aviCookie: string;
  let wrappingKey: string;

  function verifiedTestEntry(): ModelEntry {
    return {
      commandKey: 'test-chat',
      displayName: 'Test Chat Model',
      provider: 'opencode_go',
      modelId: 'mimo-v2.5',
      endpointFamily: 'go-chat-completions',
      endpointUrl: 'https://opencode.ai/zen/go/v1/chat/completions',
      approved: true,
      lifecycle: 'active',
      capabilities: { text: 'supported', tools: 'supported', stream: 'supported', thoughtSummary: 'supported', audio: 'unverified' },
      trainingUse: 'test only',
      dataRetention: 'test only',
      evidenceRef: 'test',
      verifiedAt: new Date().toISOString(),
    };
  }

  async function seedSession(sessionId: string, rawToken: string, userId: string): Promise<string> {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
      .bind(sessionId, await sha256(rawToken), userId, now, expiresAt, now)
      .run();
    return `${AUTH_BOUNDS.COOKIE_NAME}=${rawToken}`;
  }

  beforeAll(async () => {
    for (const sql of [migration0001Sql, migration0002Sql, migration0004Sql]) {
      const statements = sql
        .split(';')
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);
      for (const stmt of statements) {
        await env.DB.prepare(stmt).run();
      }
    }
    env.ENVIRONMENT = 'test';
    const keyBytes = new Uint8Array(32);
    crypto.getRandomValues(keyBytes);
    wrappingKey = base64UrlEncode(keyBytes);
    env.CREDENTIALS_KEY = wrappingKey;

    const now = new Date().toISOString();
    for (const [id, fb, email, name] of [
      [aviId, 'fb_prov_avi', 'avi@kerning.test', 'Avi'],
      [hunorId, 'fb_prov_hunor', 'hunor@kerning.test', 'Hunor'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(id, fb, email, name, now, now)
        .run();
    }
    for (const [workspaceId, name] of [
      [ws, 'Provider WS'],
      [wsOther, 'Other WS'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
         VALUES (?, ?, ?, 0, 1, ?, ?)`,
      )
        .bind(workspaceId, name, aviId, now, now)
        .run();
      await env.DB.prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
         VALUES (?, ?, 'owner', ?, ?, ?)`,
      )
        .bind(workspaceId, aviId, now, now, now)
        .run();
    }
    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'member', ?, ?, ?)`,
    )
      .bind(ws, hunorId, now, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO chats (id, workspace_id, author_user_id, title, activity_cursor, created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, 'Avi provider chat', 0, ?, ?, ?)`,
    )
      .bind(chatAvi, ws, aviId, now, now, now)
      .run();
    aviCookie = await seedSession('sess_prov_avi', 'prov_token_avi', aviId);
  });

  it('runs a mocked turn with the decrypted D1 key without leaking it', async () => {
    await setWorkspaceCredential(env.DB, {
      workspaceId: ws,
      provider: 'opencode_go',
      rawKey: 'sk-test-go-workerd-key',
      wrappingKey: await importWrappingKey(wrappingKey),
      keyVersion: 1,
      actorUserId: aviId,
    });
    const entry = verifiedTestEntry();
    let sawAuthorization: string | null = null;
    const events = [];
    for await (const event of runProviderTurn(env.DB, {
      workspaceId: ws,
      actorUserId: aviId,
      entry,
      wrappingKey: await importWrappingKey(wrappingKey),
      input: {
        sessionId: 'sess_ws_chat',
        workspaceId: ws,
        chatId: chatAvi,
        runId: 'run-prov-1',
        requestId: 'req-prov-1',
        messages: [{ role: 'user', text: 'Hello' }],
        pendingToolResults: [],
        previousContinuation: null,
        tools: [],
        maxOutputTokens: 128,
        timeoutMs: 10_000,
      },
      fetchFn: (async (url: string, init: RequestInit) => {
        sawAuthorization = new Headers(init.headers).get('authorization');
        return new Response(CHAT_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }) as (url: string, init: RequestInit) => Promise<Response>,
    })) {
      events.push(event);
    }
    expect(sawAuthorization).toBe('Bearer sk-test-go-workerd-key');
    expect(events.filter((event) => event.type === 'tool_call_end')).toEqual([
      { type: 'tool_call_end', callId: 'call_w1', name: 'echo_fixture', args: { fixture_id: 'w1' } },
    ]);
    expect(events[events.length - 1]).toMatchObject({ type: 'finish', reason: 'tool_handoff' });
    expect(JSON.stringify(events)).not.toContain('sk-test-go-workerd-key');
  });

  it('rejects unknown, retired, and unverified models at the settings route', async () => {
    const unknown = await SELF.fetch(`http://localhost/api/workspaces/${ws}/settings`, {
      method: 'PUT',
      headers: { cookie: aviCookie, ...CSRF },
      body: JSON.stringify({ default_model: 'not-a-model' }),
    });
    expect(unknown.status).toBe(422);
    expect(((await unknown.json()) as HttpErrorResponse).error.code).toBe('invalid_model');

    // Unverified production entries fail closed.
    const unverified = await SELF.fetch(`http://localhost/api/workspaces/${ws}/settings`, {
      method: 'PUT',
      headers: { cookie: aviCookie, ...CSRF },
      body: JSON.stringify({ default_model: 'gemini-3.5-flash-lite' }),
    });
    expect(unverified.status).toBe(422);
    expect(((await unverified.json()) as HttpErrorResponse).error.code).toBe('invalid_model');

    // Clearing the default stays valid.
    const cleared = await SELF.fetch(`http://localhost/api/workspaces/${ws}/settings`, {
      method: 'PUT',
      headers: { cookie: aviCookie, ...CSRF },
      body: JSON.stringify({ default_model: null }),
    });
    expect(cleared.status).toBe(200);
  });

  it('accepts a verified injected entry with an available credential, rejects retired and removed members', async () => {
    const registry = createRegistry([verifiedTestEntry()]);
    // Mark the stored ws key available through the real verification path first.
    const key = await importWrappingKey(wrappingKey);
    const verified = await verifyWorkspaceCredential(env.DB, {
      workspaceId: ws,
      provider: 'opencode_go',
      wrappingKey: key,
      actorUserId: aviId,
      probe: async () => ({ ok: true, status: 200 }),
    });
    expect(verified).toEqual({ verified: true });
    const entry = await validateWorkspaceDefaultModel(env.DB, {
      workspaceId: ws,
      actorUserId: aviId,
      commandKey: 'test-chat',
      registry,
    });
    expect(entry.modelId).toBe('mimo-v2.5');

    // Exercises the default production registry: mimo-25 resolves because opencode_go is verified on ws
    const prodEntry = await validateWorkspaceDefaultModel(env.DB, {
      workspaceId: ws,
      actorUserId: aviId,
      commandKey: 'mimo-25',
    });
    expect(prodEntry.modelId).toBe('mimo-v2.5');
    expect(prodEntry.commandKey).toBe('mimo-25');

    // But gemini-3.5-flash-lite (unverified in default PRODUCTION_REGISTRY) rejects
    await expect(
      validateWorkspaceDefaultModel(env.DB, {
        workspaceId: ws,
        actorUserId: aviId,
        commandKey: 'gemini-3.5-flash-lite',
      }),
    ).rejects.toMatchObject({ code: 'invalid_model' });

    const retired = createRegistry([{ ...verifiedTestEntry(), lifecycle: 'retired' as const }]);
    await expect(
      validateWorkspaceDefaultModel(env.DB, { workspaceId: ws, actorUserId: aviId, commandKey: 'test-chat', registry: retired }),
    ).rejects.toMatchObject({ code: 'invalid_model' });

    await removeMember(env.DB, { workspaceId: ws, actorUserId: aviId, targetUserId: hunorId });
    await expect(
      validateWorkspaceDefaultModel(env.DB, { workspaceId: ws, actorUserId: hunorId, commandKey: 'test-chat', registry }),
    ).rejects.toMatchObject({ code: 'not_member' });
    // Restore Hunor for later tests.
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'member', ?, ?, ?)`,
    )
      .bind(ws, hunorId, now, now, now)
      .run();
  });

  it('proves verifying key A cannot mark replacement key B valid or invalid when both share key_version (finding 3 regression)', async () => {
    const key = await importWrappingKey(wrappingKey);

    for (const probeResult of [{ ok: true, status: 200 }, { ok: false, status: 401 }]) {
      // Starting state: version 1 exists
      await setWorkspaceCredential(env.DB, {
        workspaceId: wsOther,
        provider: 'opencode_go',
        rawKey: 'sk-test-key-v1',
        wrappingKey: key,
        keyVersion: 1,
        actorUserId: aviId,
      });

      // Production allocation path: two concurrent requests read existing version 1
      const metaBefore = await getCredentialMetadata(env.DB, { workspaceId: wsOther, provider: 'opencode_go' });
      const nextVersion = (metaBefore?.key_version ?? 0) + 1; // both compute version 2!

      // Replacement A commits with version 2
      await setWorkspaceCredential(env.DB, {
        workspaceId: wsOther,
        provider: 'opencode_go',
        rawKey: `sk-test-key-A-${probeResult.status}`,
        wrappingKey: key,
        keyVersion: nextVersion,
        actorUserId: aviId,
      });

      let releaseProbe: () => void = () => {};
      const probeGate = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      let enteredResolve: () => void = () => {};
      const enteredGate = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });

      const verifyingA = verifyWorkspaceCredential(env.DB, {
        workspaceId: wsOther,
        provider: 'opencode_go',
        wrappingKey: key,
        actorUserId: aviId,
        probe: async () => {
          await probeGate;
          return probeResult;
        },
        testHooks: {
          afterDecrypt: async () => {
            enteredResolve();
            await probeGate;
          },
        },
      });

      // Key A is decrypted; now replacement B (which read the same initial v1) also commits with version 2
      await enteredGate;
      await setWorkspaceCredential(env.DB, {
        workspaceId: wsOther,
        provider: 'opencode_go',
        rawKey: `sk-test-key-B-${probeResult.status}`,
        wrappingKey: key,
        keyVersion: nextVersion, // SAME version 2!
        actorUserId: aviId,
      });

      // Release A's probe
      releaseProbe();
      const result = await verifyingA;
      // Because A's probed ciphertext does not match B's ciphertext, A cannot mutate B's status
      expect(result).toEqual({ verified: false, reason: 'replaced' });

      // Replacement B remains unverified regardless of whether A's probe succeeded or failed
      const metaAfter = await env.DB.prepare(
        `SELECT status, key_version FROM provider_credentials WHERE workspace_id = ? AND provider = ?`,
      )
        .bind(wsOther, 'opencode_go')
        .first<{ status: string; key_version: number }>();
      expect(metaAfter?.status).toBe('unverified');
      expect(metaAfter?.key_version).toBe(2);
    }

    // A fresh verification of the current key succeeds.
    const second = await verifyWorkspaceCredential(env.DB, {
      workspaceId: wsOther,
      provider: 'opencode_go',
      wrappingKey: key,
      actorUserId: aviId,
      probe: async () => ({ ok: true, status: 200 }),
    });
    expect(second).toEqual({ verified: true });
  });

  it('prevents status write and returns not_member if actor membership is revoked after precheck (finding 4 regression)', async () => {
    const key = await importWrappingKey(wrappingKey);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'member', ?, ?, ?)`,
    )
      .bind(ws, hunorId, now, now, now)
      .run();

    await setWorkspaceCredential(env.DB, {
      workspaceId: ws,
      provider: 'opencode_go',
      rawKey: 'sk-test-hunor-key',
      wrappingKey: key,
      keyVersion: 1,
      actorUserId: hunorId,
    });

    const beforeMeta = await env.DB.prepare(
      `SELECT status, last_verified_at FROM provider_credentials WHERE workspace_id = ? AND provider = ?`,
    )
      .bind(ws, 'opencode_go')
      .first<{ status: string; last_verified_at: string | null }>();
    expect(beforeMeta?.status).toBe('unverified');
    expect(beforeMeta?.last_verified_at).toBeNull();

    const result = await verifyWorkspaceCredential(env.DB, {
      workspaceId: ws,
      provider: 'opencode_go',
      wrappingKey: key,
      actorUserId: hunorId,
      probe: async () => ({ ok: true, status: 200 }),
      testHooks: {
        afterPrecheck: async () => {
          await removeMember(env.DB, { workspaceId: ws, actorUserId: aviId, targetUserId: hunorId });
        },
      },
    });

    expect(result).toEqual({ verified: false, reason: 'not_member' });

    const afterMeta = await env.DB.prepare(
      `SELECT status, last_verified_at FROM provider_credentials WHERE workspace_id = ? AND provider = ?`,
    )
      .bind(ws, 'opencode_go')
      .first<{ status: string; last_verified_at: string | null }>();
    expect(afterMeta?.status).toBe('unverified');
    expect(afterMeta?.last_verified_at).toBeNull();

    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'member', ?, ?, ?)`,
    )
      .bind(ws, hunorId, now, now, now)
      .run();
  });

  it('marks invalid credentials on 401 and leaves status alone on timeouts', async () => {
    const key = await importWrappingKey(wrappingKey);
    const denied = await verifyWorkspaceCredential(env.DB, {
      workspaceId: wsOther,
      provider: 'gemini',
      wrappingKey: key,
      actorUserId: aviId,
      probe: async () => ({ ok: false, status: 401 }),
    }).catch(() => ({ verified: false, reason: 'missing' as const }));
    // No gemini credential stored in wsOther: decrypt fails first.
    expect(denied.verified).toBe(false);

    await setWorkspaceCredential(env.DB, {
      workspaceId: ws,
      provider: 'gemini',
      rawKey: 'sk-test-gemini-key',
      wrappingKey: key,
      keyVersion: 1,
      actorUserId: aviId,
    });
    const invalid = await verifyWorkspaceCredential(env.DB, {
      workspaceId: ws,
      provider: 'gemini',
      wrappingKey: key,
      actorUserId: aviId,
      probe: async () => ({ ok: false, status: 401 }),
    });
    expect(invalid).toEqual({ verified: false, reason: 'invalid_credential' });
    const meta = await env.DB.prepare(
      `SELECT status FROM provider_credentials WHERE workspace_id = ? AND provider = ?`,
    )
      .bind(ws, 'gemini')
      .first<{ status: string }>();
    expect(meta?.status).toBe('invalid_credential');

    const timedOut = await verifyWorkspaceCredential(env.DB, {
      workspaceId: ws,
      provider: 'gemini',
      wrappingKey: key,
      actorUserId: aviId,
      probe: async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    });
    expect(timedOut).toEqual({ verified: false, reason: 'timeout' });
    const still = await env.DB.prepare(
      `SELECT status FROM provider_credentials WHERE workspace_id = ? AND provider = ?`,
    )
      .bind(ws, 'gemini')
      .first<{ status: string }>();
    expect(still?.status).toBe('invalid_credential');
  });

  it('isolates credentials and model resolution across workspaces', async () => {
    const key = await importWrappingKey(wrappingKey);
    const geminiEntry = { ...verifiedTestEntry(), provider: 'gemini' as const, commandKey: 'test-gemini' };
    await expect(
      (async () => {
        for await (const event of runProviderTurn(env.DB, {
          workspaceId: wsOther,
          actorUserId: aviId,
          entry: geminiEntry,
          wrappingKey: key,
          input: {
            sessionId: 's',
            workspaceId: wsOther,
            chatId: chatAvi,
            runId: 'r',
            requestId: 'q',
            messages: [{ role: 'user', text: 'Hi' }],
            pendingToolResults: [],
            previousContinuation: null,
            tools: [],
            maxOutputTokens: 64,
            timeoutMs: 5000,
          },
          fetchFn: stubFetch(),
        })) {
          void event;
        }
      })(),
    ).rejects.toMatchObject({ code: 'credential_not_found' });

    // No default configured: unconfigured, not an error.
    expect(await resolveModelForChat(env.DB, { workspaceId: ws, actorUserId: aviId, chatId: chatAvi })).toEqual({
      available: false,
      reason: 'no_model_selected',
    });
  });

  it('keeps the verify route authenticated without leaking key material', async () => {
    const unknownProvider = await SELF.fetch(`http://localhost/api/workspaces/${ws}/credentials/nope/verify`, {
      method: 'POST',
      headers: { cookie: aviCookie, ...CSRF },
    });
    expect(unknownProvider.status).toBe(404);

    const missing = await SELF.fetch(`http://localhost/api/workspaces/${wsOther}/credentials/gemini/verify`, {
      method: 'POST',
      headers: { cookie: aviCookie, ...CSRF },
    });
    expect(missing.status).toBe(404);
    const body = await missing.text();
    expect(body).not.toContain('sk-test');
  });
});

describe('Provider transport receiver safety (workerd native fetch)', () => {
  // Discrimination is synchronous: a detached native fetch called as a member
  // throws Illegal invocation at call time, while the arrow wrapper always
  // returns a promise (its later transport failure is settled and ignored).
  // No real network is involved either way.
  const DEAD_URL = 'http://127.0.0.1:1/otus-receiver-probe';
  const freshOptions = (): RequestInit => ({ signal: AbortSignal.timeout(2000) });

  it('documents the platform constraint: detached native fetch throws Illegal invocation', () => {
    const holder = { fetchFn: fetch };
    let syncThrow: unknown = 'none';
    try {
      holder.fetchFn(DEAD_URL, freshOptions());
    } catch (err) {
      syncThrow = err;
    }
    expect(String(syncThrow)).toContain('Illegal invocation');
  });

  it('receiverSafeFetch gets native fetch past invocation to transport (never Illegal invocation)', async () => {
    let result: unknown = 'none';
    let syncThrow: unknown = 'none';
    try {
      result = receiverSafeFetch(fetch)(DEAD_URL, freshOptions());
    } catch (err) {
      syncThrow = err;
    }
    expect(syncThrow).toBe('none');
    expect(result).toBeInstanceOf(Promise);
    await (result as Promise<Response>).then(
      () => null,
      () => null,
    );
  });
});
