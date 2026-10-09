/**
 * Lead overview read (workerd, real D1): full-set counts, deterministic
 * overdue-first order, keyset pagination, effective contacts honoring Undo,
 * and workspace/kind scoping. No model calls; the read is pure retrieval.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import { readLeadOverview } from '../src/agent/leadOverview.js';
import { executeAgentTool } from '../src/agent/repository.js';
import type { Env } from '../src/index.js';

const E = env as unknown as Env;
const WS = 'ws_lead_overview';
const AVI = 'usr_lead_avi';
const HUNOR = 'usr_lead_hunor';
const NOW = '2026-10-07T12:00:00.000Z';

let sequence = 1000;
const nextSeq = (): number => {
  sequence += 1;
  return sequence;
};

async function seedEvent(
  id: string,
  entityId: string | null,
  kind: string,
  occurredAt: string,
  payload: Record<string, unknown> = {},
  revertsEventId: string | null = null,
): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO events (id, workspace_id, sequence, entity_id, actor_kind, actor_user_id, kind,
      schema_version, payload_json, occurred_at, recorded_at, channel,
      source_message_id, source_job_id, action_id, supersedes_event_id, reverts_event_id,
      provenance, created_at)
     VALUES (?, ?, ?, ?, 'member', ?, ?, 1, ?, ?, ?, 'web', 'msg_seed_1', NULL, ?, NULL, ?, 'stated', ?)`,
  )
    .bind(
      id,
      WS,
      nextSeq(),
      entityId,
      AVI,
      kind,
      JSON.stringify(payload),
      occurredAt,
      occurredAt,
      `act_${id}`,
      revertsEventId,
      NOW,
    )
    .run();
}

async function seedTask(
  id: string,
  entityId: string | null,
  title: string,
  status: string,
  due: { kind: 'date' | 'instant'; localDate?: string; instant?: string } | null,
  snoozeUntil: string | null,
): Promise<void> {
  await seedEvent(`evt_${id}`, entityId, 'note', NOW);
  await E.DB.prepare(
    `INSERT INTO tasks (id, workspace_id, entity_id, title, assignee_user_id, status,
      due_kind, due_local_date, due_instant, due_timezone, snooze_until,
      source_event_id, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'Europe/Bucharest', ?, ?, 1, ?, ?)`,
  )
    .bind(
      id,
      WS,
      entityId,
      title,
      status,
      due?.kind ?? null,
      due?.localDate ?? null,
      due?.instant ?? null,
      snoozeUntil,
      `evt_${id}`,
      NOW,
      NOW,
    )
    .run();
}

beforeAll(async () => {
  await applyMigrations(E.DB);
  await E.DB.prepare(`INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(AVI, 'fb_lead_avi', 'avi.lead@test', 'Avi', NOW, NOW)
    .run();
  await E.DB.prepare(`INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(HUNOR, 'fb_lead_hunor', 'hunor.lead@test', 'Hunor', NOW, NOW)
    .run();
  await E.DB.prepare(`INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?)`)
    .bind(WS, 'Lead WS', AVI, NOW, NOW)
    .run();
  await E.DB.prepare(`INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(WS, AVI, 'owner', NOW, NOW, NOW)
    .run();
  await E.DB.prepare(`INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at) VALUES (?, ?, ?, 'web', ?, ?, 'processed', ?, ?)`)
    .bind('msg_seed_1', WS, AVI, 'ext_seed_1', 'fp_seed_1', NOW, NOW)
    .run();

  // 30 leads across statuses; three share undated no-task state for tie-breaks.
  const statuses = ['hot', 'warm', 'cold', 'new', 'won', 'lost'];
  for (let i = 1; i <= 30; i++) {
    const id = `ent_lead_${String(i).padStart(2, '0')}`;
    const name = i === 28 ? 'Zeta tie' : i === 29 ? 'Alpha tie' : i === 30 ? 'Mid tie' : `Lead ${String(i).padStart(2, '0')}`;
    const status = statuses[(i - 1) % statuses.length]!;
    await E.DB.prepare(`INSERT INTO entities (id, workspace_id, name, kind, status, assigned_user_id, created_at, updated_at) VALUES (?, ?, ?, 'lead', ?, ?, ?, ?)`)
      .bind(id, WS, name, status, i % 3 === 0 ? HUNOR : null, NOW, NOW)
      .run();
  }
  // Non-lead entities must never appear, even with open tasks.
  await E.DB.prepare(`INSERT INTO entities (id, workspace_id, name, kind, status, assigned_user_id, created_at, updated_at) VALUES (?, ?, ?, 'client', 'warm', NULL, ?, ?)`)
    .bind('ent_client_1', WS, 'Client One', NOW, NOW)
    .run();
  await E.DB.prepare(`INSERT INTO entities (id, workspace_id, name, kind, status, assigned_user_id, created_at, updated_at) VALUES (?, ?, ?, 'partner', 'hot', NULL, ?, ?)`)
    .bind('ent_partner_1', WS, 'Partner One', NOW, NOW)
    .run();
  await seedTask('task_client_1', 'ent_client_1', 'Client work', 'open', { kind: 'date', localDate: '2026-10-01' }, null);

  // Overdue date task, upcoming instant, undated, snoozed-future, done, second task.
  await seedTask('task_overdue_1', 'ent_lead_01', 'Send revised quote', 'open', { kind: 'date', localDate: '2026-10-06' }, null);
  await seedTask('task_soon_1', 'ent_lead_02', 'Follow up after demo', 'open', { kind: 'instant', instant: '2026-10-08T09:00:00.000Z' }, null);
  await seedTask('task_undated_1', 'ent_lead_03', 'Check in', 'open', null, null);
  await seedTask('task_snoozed_1', 'ent_lead_04', 'Snoozed follow-up', 'open', { kind: 'date', localDate: '2026-10-01' }, '2026-10-20T00:00:00.000Z');
  await seedTask('task_done_1', 'ent_lead_05', 'Finished work', 'done', { kind: 'date', localDate: '2026-10-01' }, null);
  await seedTask('task_late_1', 'ent_lead_06', 'Later task', 'open', { kind: 'date', localDate: '2026-10-20' }, null);
  await seedTask('task_early_1', 'ent_lead_06', 'Earlier task', 'open', { kind: 'date', localDate: '2026-10-09' }, null);

  // Effective contacts: plain contact, visit with contact, visit without, reverted, sent message.
  await seedEvent('evt_contact_1', 'ent_lead_01', 'contact', '2026-10-05T10:00:00.000Z');
  await seedEvent('evt_visit_1', 'ent_lead_02', 'visit', '2026-10-06T10:00:00.000Z', { contact_made: 1 });
  await seedEvent('evt_visit_2', 'ent_lead_03', 'visit', '2026-10-06T11:00:00.000Z', { contact_made: 0 });
  await seedEvent('evt_contact_2', 'ent_lead_04', 'contact', '2026-10-04T10:00:00.000Z');
  await seedEvent('evt_revert_1', 'ent_lead_04', 'revert', '2026-10-05T10:00:00.000Z', {}, 'evt_contact_2');
  await seedEvent('evt_sent_1', 'ent_lead_05', 'message_sent_by_member', '2026-10-03T10:00:00.000Z');

  // One disputed lead.
  await E.DB.prepare(`INSERT INTO entity_state (id, workspace_id, entity_id, field_name, state, value_text, provenance, revision, updated_at) VALUES (?, ?, ?, 'status', 'disputed', 'warm', 'stated', 1, ?)`)
    .bind('es_disputed_1', WS, 'ent_lead_07', NOW)
    .run();
});

describe('lead overview read (workerd)', () => {
  it('covers the full filtered set in counts while paging rows', async () => {
    const first = await readLeadOverview(E.DB, { workspaceId: WS, nowIso: NOW, limit: 10 });
    expect(first.counts.total).toBe(30);
    expect(Object.values(first.counts.by_status).reduce((a, b) => a + b, 0)).toBe(30);
    expect(first.counts.by_status['hot']).toBe(4);
    expect(first.counts.by_status['disputed']).toBe(1);
    expect(first.rows).toHaveLength(10);
    expect(first.page.has_more).toBe(true);
    expect(first.page.next_cursor).toBeTruthy();
    expect(first.as_of).toBe(NOW);

    const seen = new Map<string, string>();
    let cursor: string | undefined = first.page.next_cursor ?? undefined;
    for (const row of first.rows) seen.set(row.lead_id, row.name);
    let pages = 1;
    while (cursor) {
      pages += 1;
      const next = await readLeadOverview(E.DB, { workspaceId: WS, nowIso: NOW, limit: 10, cursor });
      for (const row of next.rows) {
        expect(seen.has(row.lead_id)).toBe(false);
        seen.set(row.lead_id, row.name);
      }
      cursor = next.page.next_cursor ?? undefined;
      expect(pages).toBeLessThan(6);
    }
    expect(seen.size).toBe(30);
    expect(pages).toBe(3);
  });

  it('orders overdue first, then dated work, then undated, with stable tie-breaks', async () => {
    const page = await readLeadOverview(E.DB, { workspaceId: WS, nowIso: NOW, limit: 50 });
    expect(page.counts.total).toBe(30);
    const ranks = page.rows.map((r) =>
      r.next_task && r.next_task.overdue ? 0 : r.next_task && (r.next_task.due_instant || r.next_task.due_local_date) ? 1 : 2,
    );
    const sorted = [...ranks].sort((a, b) => a - b);
    expect(ranks).toEqual(sorted);
    // Overdue lead first; snoozed future work is not overdue.
    expect(page.rows[0]!.lead_id).toBe('ent_lead_01');
    expect(page.rows[0]!.next_task!.overdue).toBe(true);
    const snoozed = page.rows.find((r) => r.lead_id === 'ent_lead_04')!;
    expect(snoozed.next_task!.overdue).toBe(false);
    // Earliest of two tasks wins on lead 06.
    expect(page.rows.find((r) => r.lead_id === 'ent_lead_06')!.next_task!.title).toBe('Earlier task');
    // Undated group tie-breaks by name: sorted, Alpha first, Zeta last.
    const undated = page.rows
      .filter((r) => !(r.next_task?.due_instant || r.next_task?.due_local_date))
      .map((r) => r.name);
    expect(undated).toEqual([...undated].sort());
    expect(undated[0]).toBe('Alpha tie');
    expect(undated[undated.length - 1]).toBe('Zeta tie');
  });

  it('filters by status, overdue-only and missing next steps over the full set', async () => {
    const warm = await readLeadOverview(E.DB, { workspaceId: WS, nowIso: NOW, limit: 50, filters: { status: 'warm' } });
    expect(warm.counts.total).toBe(5);
    expect(warm.rows.every((r) => r.status === 'warm')).toBe(true);

    const overdue = await readLeadOverview(E.DB, { workspaceId: WS, nowIso: NOW, limit: 50, filters: { overdue_only: true } });
    expect(overdue.counts.total).toBe(1);
    expect(overdue.rows[0]!.lead_id).toBe('ent_lead_01');

    const missing = await readLeadOverview(E.DB, { workspaceId: WS, nowIso: NOW, limit: 50, filters: { without_next_step: true } });
    expect(missing.counts.total).toBe(30 - 5);
    expect(missing.rows.every((r) => r.next_task === null)).toBe(true);
    expect(missing.counts.without_next_step).toBe(30 - 5);
  });

  it('reports effective last contact, honoring Undo and visit rules', async () => {
    const page = await readLeadOverview(E.DB, { workspaceId: WS, nowIso: NOW, limit: 50 });
    const byId = new Map(page.rows.map((r) => [r.lead_id, r]));
    expect(byId.get('ent_lead_01')!.last_contact_at).toBe('2026-10-05T10:00:00.000Z');
    expect(byId.get('ent_lead_02')!.last_contact_at).toBe('2026-10-06T10:00:00.000Z');
    expect(byId.get('ent_lead_03')!.last_contact_at).toBeNull();
    expect(byId.get('ent_lead_04')!.last_contact_at).toBeNull();
    expect(byId.get('ent_lead_05')!.last_contact_at).toBe('2026-10-03T10:00:00.000Z');
  });

  it('marks disputed leads and resolves readable owners', async () => {
    const page = await readLeadOverview(E.DB, { workspaceId: WS, nowIso: NOW, limit: 50 });
    const byId = new Map(page.rows.map((r) => [r.lead_id, r]));
    expect(byId.get('ent_lead_07')!.disputed).toBe(true);
    expect(byId.get('ent_lead_01')!.disputed).toBe(false);
    // Leads 3, 6, 9, ... are Hunor-owned (i % 3 === 0).
    expect(byId.get('ent_lead_03')!.owner).toEqual({ user_id: HUNOR, display_name: 'Hunor' });
    expect(byId.get('ent_lead_01')!.owner).toBeNull();
  });

  it('excludes non-lead entities and rejects bad cursors', async () => {
    const page = await readLeadOverview(E.DB, { workspaceId: WS, nowIso: NOW, limit: 50 });
    expect(page.rows.some((r) => r.name === 'Client One' || r.name === 'Partner One')).toBe(false);
    await expect(readLeadOverview(E.DB, { workspaceId: WS, nowIso: NOW, cursor: 'not-a-cursor' })).rejects.toThrow(/Invalid overview cursor/);
  });

  it('serves the report through the query tool with the same counts', async () => {
    const res = await executeAgentTool({
      db: E.DB,
      workspaceId: WS,
      actorUserId: AVI,
      actionId: 'act_lead_overview_1',
      toolName: 'query',
      toolArgs: { resource: 'lead_overview', limit: 5 },
    });
    expect(res.status).toBe('applied');
    const data = (res as { data: { counts: { total: number }; rows: unknown[]; page: { has_more: boolean; next_cursor: string | null } } }).data;
    expect(data.counts.total).toBe(30);
    expect(data.rows).toHaveLength(5);
    expect(data.page.has_more).toBe(true);
    expect(data.page.next_cursor).toBeTruthy();
  });
});
