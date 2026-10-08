import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import { acceptWebMessage, createChat } from '../src/inbox/repository.js';
import { executeAgentTool } from '../src/agent/repository.js';

/**
 * R09 cost profiles (slice C) on workerd D1. Deterministic statement counts
 * are asserted; wall-time distributions print as one JSON line for the
 * dated record. D1 billed-row metadata is read when the harness exposes it
 * and reported as unknown otherwise — never inferred.
 */

interface Shop {
  ws: string;
  owner: string;
  chatId: string;
  srcInboundId: string;
}

async function makeShop(suffix: string): Promise<Shop> {
  const ws = `ws-fprofile-${suffix}`;
  const owner = `usr_fprofile_${suffix}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(owner, `fb_${suffix}`, `${suffix}@fb.test`, `Owner ${suffix}`, now, now).run();
  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, ?, ?)`,
  ).bind(ws, `Profile ${suffix}`, owner, now, now).run();
  await env.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?)`,
  ).bind(ws, owner, now, now, now).run();
  const chatId = (await createChat(env.DB, { workspaceId: ws, authorUserId: owner, title: `Profile ${suffix}` })).id;
  await acceptWebMessage(env.DB, {
    workspaceId: ws, chatId, userId: owner, clientMessageId: `cm-prof-src-${suffix}`, text: 'Profile update',
  });
  const inbound = await env.DB.prepare(
    `SELECT id FROM messages_in WHERE workspace_id = ? AND chat_id = ? AND external_id = ?`,
  ).bind(ws, chatId, `cm-prof-src-${suffix}`).first<{ id: string }>();
  return { ws, owner, chatId, srcInboundId: inbound!.id };
}

async function seedEntities(ws: string, count: number): Promise<string> {
  const now = new Date().toISOString();
  const firstId = `ent_prof_${ws}_0`;
  const chunks: D1PreparedStatement[][] = [];
  let current: D1PreparedStatement[] = [];
  for (let i = 0; i < count; i++) {
    current.push(
      env.DB.prepare(
        `INSERT INTO entities (id, workspace_id, name, kind, status, assigned_user_id, created_at, updated_at)
         VALUES (?, ?, ?, 'lead', 'new', NULL, ?, ?)`,
      ).bind(`ent_prof_${ws}_${i}`, ws, `Profile Lead ${i}`, now, now),
    );
    if (current.length >= 50) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length > 0) chunks.push(current);
  for (const chunk of chunks) await env.DB.batch(chunk);
  return firstId;
}

function countingDb(db: D1Database) {
  let prepares = 0;
  let batches = 0;
  const target = db as unknown as Record<string, unknown>;
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === 'prepare') {
        return (query: string) => {
          prepares += 1;
          return (t['prepare'] as (q: string) => D1PreparedStatement).call(t, query);
        };
      }
      if (prop === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          batches += 1;
          return (t['batch'] as (s: D1PreparedStatement[]) => Promise<D1Result[]>).call(t, statements);
        };
      }
      const value = Reflect.get(t, prop, receiver);
      return typeof value === 'function' ? (value as (...a: never[]) => unknown).bind(t) : value;
    },
  });
  return { db: proxy as unknown as D1Database, counts: () => ({ prepares, batches }) };
}

async function revision(ws: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT business_revision FROM workspaces WHERE id = ?`)
    .bind(ws).first<{ business_revision: number }>();
  return Number(row?.business_revision ?? -1);
}

function quantiles(samples: number[]): { p50: number; p95: number; n: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length / 2)] ?? -1,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? -1,
    n: sorted.length,
  };
}

beforeAll(async () => {
  await applyMigrations(env.DB);
});

describe('field-batch cost profiles', () => {
  it('records statement, revision and wall-time shapes at 100 and 1000 entities', async () => {
    const small = await makeShop('p100');
    const big = await makeShop('p1000');
    const smallTarget = await seedEntities(small.ws, 100);
    const bigTarget = await seedEntities(big.ws, 1000);
    const profile: Record<string, unknown> = {
      venue: 'workerd-miniflare-local-d1',
      date: new Date().toISOString().slice(0, 10),
      note: 'statement counts asserted; wall time is local smoke, not a speed claim; billed rows unavailable in this harness',
    };

    for (const [label, shop, target, entityCount] of [
      ['100', small, smallTarget, 100],
      ['1000', big, bigTarget, 1000],
    ] as const) {
      const rev = await revision(shop.ws);
      const counted = countingDb(env.DB);
      const samples: number[] = [];
      const actionRev = rev;
      for (let i = 0; i < 11; i++) {
        const start = Date.now();
        const res = await executeAgentTool({
          db: counted.db,
          workspaceId: shop.ws,
          actorUserId: shop.owner,
          actionId: `act-prof-${label}-${i}`,
          sourceMessageId: shop.srcInboundId,
          toolName: 'set_fields',
          toolArgs: { entity_id: target, fields: [{ field_name: 'phone', value: `+4000000${100 + i}` }] },
          expectedBusinessRevision: actionRev + i,
        });
        expect(res.status).toBe('applied');
        samples.push(Date.now() - start);
      }
      const counts = counted.counts();
      // 11 identical single-field batches: deterministic totals prove the
      // per-call shape independent of workspace size.
      expect(counts.batches).toBe(22);
      profile[label] = {
        entities: entityCount,
        batchesPerCall: counts.batches / 11,
        preparesPerCall: counts.prepares / 11,
        revisionsPerCall: ((await revision(shop.ws)) - actionRev) / 11,
        wallMs: quantiles(samples),
      };
    }

    // Full-load baseline on the same 1000-entity workspace: create_entity
    // still hydrates the whole workspace; its prepare count must exceed the
    // targeted path's, and row parsing grows with workspace size.
    const revBase = await revision(big.ws);
    const baseCounted = countingDb(env.DB);
    const baseRes = await executeAgentTool({
      db: baseCounted.db,
      workspaceId: big.ws,
      actorUserId: big.owner,
      actionId: 'act-prof-baseline-1',
      sourceMessageId: big.srcInboundId,
      toolName: 'upsert_entity',
      toolArgs: { name: 'Baseline Prospect' },
      expectedBusinessRevision: revBase,
    });
    expect(baseRes.status).toBe('applied');
    profile['baseline_create_entity_1000'] = {
      prepares: baseCounted.counts().prepares,
      batches: baseCounted.counts().batches,
    };
    expect(baseCounted.counts().prepares).toBeGreaterThan(
      (profile['1000'] as { preparesPerCall: number }).preparesPerCall,
    );

    console.log(`FBPROFILE ${JSON.stringify(profile)}`);
    // Pinned structural record: targeted path constant across sizes and
    // narrower than the full-load baseline on the same workspace.
    expect((profile['100'] as { preparesPerCall: number }).preparesPerCall).toBe(13);
    expect((profile['1000'] as { preparesPerCall: number }).preparesPerCall).toBe(13);
    expect((profile['100'] as { batchesPerCall: number }).batchesPerCall).toBe(2);
    expect((profile['1000'] as { batchesPerCall: number }).batchesPerCall).toBe(2);
    expect((profile['baseline_create_entity_1000'] as { prepares: number }).prepares).toBe(20);
  }, 300000);
});
