import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
// @ts-expect-error vite raw import
import migration0001Sql from '../../../migrations/0001_identity.sql?raw';
// @ts-expect-error vite raw import
import migration0002Sql from '../../../migrations/0002_conversations_sources.sql?raw';
// @ts-expect-error vite raw import
import migration0003Sql from '../../../migrations/0003_ledger.sql?raw';
// @ts-expect-error vite raw import
import migration0004Sql from '../../../migrations/0004_lifecycle_settings.sql?raw';
// @ts-expect-error vite raw import
import migration0005Sql from '../../../migrations/0005_actor_dispatch.sql?raw';
// @ts-expect-error vite raw import
import migration0006Sql from '../../../migrations/0006_actor_hardening.sql?raw';
// @ts-expect-error vite raw import
import migration0007Sql from '../../../migrations/0007_outbox_claim_owner.sql?raw';
// @ts-expect-error vite raw import
import migration0008Sql from '../../../migrations/0008_memory_and_agent_runs.sql?raw';
// @ts-expect-error vite raw import
import migration0009Sql from '../../../migrations/0009_thinking_controls.sql?raw';
// @ts-expect-error vite raw import
import migration0016Sql from '../../../migrations/0016_brief_next_due.sql?raw';
// @ts-expect-error vite raw import
import migration0017Sql from '../../../migrations/0017_task_markers.sql?raw';
// @ts-expect-error vite raw import
import migration0022Sql from '../../../migrations/0022_member_interpretation_timezone.sql?raw';
// @ts-expect-error vite raw import
import migration0023Sql from '../../../migrations/0023_interaction_state.sql?raw';

import { executeAgentTool } from '../src/agent/repository.js';
import {
  executeLedgerCommand,
  getWorkspaceEvents,
  getWorkspaceRevision,
  DEFAULT_COMMAND_HANDLERS,
  type LedgerCommandContext,
} from '@otis/ledger';
import { createChat } from '../src/inbox/repository.js';
import { claimWorkspaceLease } from '../src/actor/leases.js';
import { persistStep } from '../src/actor/steps.js';
import { runAppliedBusinessMutation } from '@otis/agent';

describe('Worker Agent Tools & Guarded Repositories D1 Integration (006A workerd)', () => {
  const ws1 = 'ws-agent-tools-1';
  const ws2 = 'ws-agent-tools-2';
  const aviId = 'usr_avi_tools';
  const hunorId = 'usr_hunor_tools';
  const outsiderId = 'usr_outsider_tools';

  let chat1: string;
  let chat2: string;
  const run1Id = 'run_tools_1';
  const attempt1Id = 'att_tools_1';
  let fence1 = 1;
  let step1Id: string;
  const nowIso = new Date().toISOString();

  function splitSqlStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let inTrigger = false;

    for (const rawLine of sql.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('--') || line.length === 0) continue;

      current += rawLine + '\n';
      if (/\bBEGIN\b/i.test(line)) {
        inTrigger = true;
      }
      if (inTrigger) {
        if (/\bEND;\s*$/i.test(line)) {
          inTrigger = false;
          statements.push(current.trim());
          current = '';
        }
      } else if (line.endsWith(';')) {
        statements.push(current.trim());
        current = '';
      }
    }

    if (current.trim().length > 0) {
      statements.push(current.trim());
    }
    return statements;
  }

  beforeAll(async () => {
    // 1. Apply migrations 0001 through 0009 plus 0016 (member-settings sweep stamp),
    // 0017 (task selection markers), 0022 (member interpretation timezone)
    // and 0023 (interaction lifecycle table for log_event projections).
    for (const sql of [
      migration0001Sql,
      migration0002Sql,
      migration0003Sql,
      migration0004Sql,
      migration0005Sql,
      migration0006Sql,
      migration0007Sql,
      migration0008Sql,
      migration0009Sql,
      migration0016Sql,
      migration0017Sql,
      migration0022Sql,
      migration0023Sql,
    ]) {
      for (const stmt of splitSqlStatements(sql)) {
        await env.DB.prepare(stmt).run();
      }
    }

    // 2. Seed users
    for (const [id, email, name] of [
      [aviId, 'avi.tools@kerning.test', 'Avi Tools'],
      [hunorId, 'hunor.tools@kerning.test', 'Hunor Tools'],
      [outsiderId, 'outsider@other.test', 'Outsider'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(id, `fb_${id}`, email, name, nowIso, nowIso)
        .run();
    }

    // 3. Seed workspaces
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
       VALUES (?, 'Kerning Tools WS 1', ?, 0, 1, ?, ?)`
    )
      .bind(ws1, aviId, nowIso, nowIso)
      .run();

    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
       VALUES (?, 'Isolated WS 2', ?, 0, 1, ?, ?)`
    )
      .bind(ws2, outsiderId, nowIso, nowIso)
      .run();

    // 4. Seed memberships
    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'owner', ?, ?, ?)`
    )
      .bind(ws1, aviId, nowIso, nowIso, nowIso)
      .run();

    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'member', ?, ?, ?)`
    )
      .bind(ws1, hunorId, nowIso, nowIso, nowIso)
      .run();

    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'owner', ?, ?, ?)`
    )
      .bind(ws2, outsiderId, nowIso, nowIso, nowIso)
      .run();

    // 5. Create chats
    chat1 = (await createChat(env.DB, { workspaceId: ws1, authorUserId: aviId, title: 'Chat 1' })).id;
    chat2 = (await createChat(env.DB, { workspaceId: ws2, authorUserId: outsiderId, title: 'Chat 2' })).id;

    // 6. Seed messages_in
    await env.DB.prepare(
      `INSERT INTO messages_in (id, workspace_id, chat_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
       VALUES ('msg_tools_1', ?, ?, ?, 'web', 'ext_1', 'fp_1', 'processing', ?, ?)`
    )
      .bind(ws1, chat1, aviId, nowIso, nowIso)
      .run();

    await env.DB.prepare(
      `INSERT INTO messages_in (id, workspace_id, chat_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
       VALUES ('msg_ws2_isolated', ?, ?, ?, 'web', 'ext_ws2', 'fp_ws2', 'processing', ?, ?)`
    )
      .bind(ws2, chat2, outsiderId, nowIso, nowIso)
      .run();

    // 7. Claim lease and pin run1 for ws1
    const lease = await claimWorkspaceLease(env.DB, {
      workspaceId: ws1,
      attemptId: attempt1Id,
      nowIso,
    });
    if (!lease) throw new Error('Failed to claim lease for ws1');
    fence1 = lease.fence;

    await env.DB.prepare(
      `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, status, attempt_id, lease_fence, model_key, created_at, updated_at)
       VALUES (?, ?, ?, 'msg_tools_1', 'running', ?, ?, 'mimo-25', ?, ?)`
    )
      .bind(run1Id, ws1, chat1, attempt1Id, fence1, nowIso, nowIso)
      .run();

    // Seed step-1 in run_steps
    const stepRes = await persistStep(env.DB, {
      workspaceId: ws1,
      runId: run1Id,
      stepIndex: 1,
      toolName: 'test_step',
      actionId: 'act_seed_1',
      attemptId: attempt1Id,
      fence: fence1,
      args: { test: true },
      nowIso,
    });
    step1Id = stepRes.step.id;
  });

  it('rejects unknown tools, unknown keys, and forged authority keys with zero mutations', async () => {
    const revBefore = (await getWorkspaceRevision(env.DB, ws1))?.business_revision;

    // 1. Unknown tool
    const unknownRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: revBefore ?? 0,
      actionId: 'act_unknown_tool',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'exploit_admin_privileges',
      toolArgs: {},
    });
    expect(unknownRes.status).toBe('rejected');
    expect(unknownRes.error?.code).toBe('unknown_tool');

    // 2. Forged authority keys
    const forgedRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: revBefore ?? 0,
      actionId: 'act_forged_key',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'find_entities',
      toolArgs: { query: 'test', workspace_id: 'ws_other', fence: 999 },
    });
    expect(forgedRes.status).toBe('rejected');
    expect(forgedRes.error?.code).toBe('forbidden_key');

    // 3. SQL injection attempt in query tool
    const sqlRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: revBefore ?? 0,
      actionId: 'act_sql_inject',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'query',
      toolArgs: {
        resource: 'entities',
        filters: {
          entity_status: "won' OR 1=1 --",
        },
      },
    });
    expect(sqlRes.status).toBe('rejected');

    // Business revision and events must remain completely unchanged
    const revAfter = (await getWorkspaceRevision(env.DB, ws1))?.business_revision;
    expect(revAfter).toBe(revBefore);
  });

  it('filters entity queries by kind without leaking other kinds', async () => {
    await env.DB.prepare(
      `INSERT INTO entities (id, workspace_id, name, kind, status, created_at, updated_at)
       VALUES ('ent_kind_lead', ?, 'Kind Lead', 'lead', 'warm', ?, ?),
              ('ent_kind_client', ?, 'Kind Client', 'client', 'warm', ?, ?)`
    )
      .bind(ws1, nowIso, nowIso, ws1, nowIso, nowIso)
      .run();

    const clients = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: (await getWorkspaceRevision(env.DB, ws1))?.business_revision ?? 0,
      actionId: 'act_kind_clients',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'query',
      toolArgs: { resource: 'entities', filters: { kind: 'client' } },
    });
    expect(clients.status).toBe('applied');
    if (clients.status === 'applied') {
      const rows = clients.data as Array<{ id: string; kind: string }>;
      expect(rows.some((r) => r.id === 'ent_kind_client')).toBe(true);
      expect(rows.some((r) => r.kind !== 'client')).toBe(false);
    }

    const leads = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      actionId: 'act_kind_leads',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'query',
      toolArgs: { resource: 'entities', filters: { kind: 'lead' } },
    });
    expect(leads.status).toBe('applied');
    if (leads.status === 'applied') {
      const rows = leads.data as Array<{ id: string; kind: string }>;
      expect(rows.some((r) => r.id === 'ent_kind_lead')).toBe(true);
      expect(rows.some((r) => r.id === 'ent_kind_client')).toBe(false);
    }
  });
  it('enforces workspace isolation: wrong-workspace entities, tasks, sources, and memory denied without leaking contents', async () => {
    // 1. Seed an entity in ws2
    await env.DB.prepare(
      `INSERT INTO entities (id, workspace_id, name, kind, status, created_at, updated_at)
       VALUES ('ent_ws2_secret', ?, 'Secret WS2 Restaurant', 'lead', 'new', ?, ?)`
    )
      .bind(ws2, nowIso, nowIso)
      .run();

    // 2. Seed a memory entry in ws2
    await env.DB.prepare(
      `INSERT INTO memory_entries (id, workspace_id, scope, subject_id, category, content, status, provenance, observed_at, created_at, business_revision)
       VALUES ('mem_ws2_secret', ?, 'workspace', NULL, 'workflow_context', 'Confidential WS2 strategy', 'active', 'stated', ?, ?, 1)`
    )
      .bind(ws2, nowIso, nowIso)
      .run();

    const revBefore = (await getWorkspaceRevision(env.DB, ws1))?.business_revision ?? 0;

    // A. Model in ws1 attempts to get_memory on ws2 memory ID
    const getMemRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: revBefore,
      actionId: 'act_leak_mem',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'get_memory',
      toolArgs: { memory_id: 'mem_ws2_secret' },
    });
    expect(getMemRes.status).toBe('rejected');
    expect(getMemRes.error?.code).toBe('not_found');
    expect(JSON.stringify(getMemRes)).not.toContain('Confidential WS2 strategy');

    // B. Model in ws1 attempts remember_context with entity subject from ws2
    const remRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: revBefore,
      actionId: 'act_cross_entity_mem',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'remember_context',
      toolArgs: {
        scope: 'entity',
        subject_id: 'ent_ws2_secret',
        category: 'relationship_context',
        content: 'Cross workspace link attempt',
      },
    });
    expect(remRes.status).toBe('rejected');
    expect(remRes.error?.code).toBe('entity_not_found');

    // C. Model in ws1 attempts to use ws2 source message ID
    const sourceRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: revBefore,
      actionId: 'act_wrong_source',
      sourceMessageId: 'msg_ws2_isolated',
      chatId: chat1,
      toolName: 'log_event',
      toolArgs: {
        kind: 'note',
        payload: { text: 'Note with forged source' },
      },
    });
    expect(sourceRes.status).toBe('rejected');
    expect(sourceRes.error?.code).toBe('source_conflict');

    // Ensure zero mutations committed
    const revAfter = (await getWorkspaceRevision(env.DB, ws1))?.business_revision;
    expect(revAfter).toBe(revBefore);
  });

  it('guarantees atomic rollback on late batch failure: event, projection, FTS, receipt, and refresh job all roll back', async () => {
    const revBefore = (await getWorkspaceRevision(env.DB, ws1))?.business_revision ?? 0;
    const actionId = 'act_late_failure_test';

    const ledgerContext: LedgerCommandContext = {
      workspace_id: ws1,
      actor: { kind: 'member', user_id: aviId },
      membership_revision: 1,
      source_message_id: 'msg_tools_1',
      chat_id: chat1,
      request_id: actionId,
      run_id: run1Id,
      fence: fence1,
      action_id: actionId,
      expected_business_revision: revBefore,
    };

    // Construct an extra statement that deliberately fails the batch at the end
    const failingExtraStatement = env.DB.prepare(
      `INSERT INTO ledger_guards (id, guard_ok) VALUES ('forced_fail', 0)`
    );

    const result = await executeLedgerCommand(
      env.DB,
      ledgerContext,
      'remember_context',
      {
        scope: 'workspace',
        category: 'workflow_context',
        content: 'Rollback test content note',
      },
      DEFAULT_COMMAND_HANDLERS['remember_context']!,
      [failingExtraStatement],
      { deferRunTransition: true },
    );

    // Command should fail / conflict
    expect(result.status).not.toBe('applied');

    // Verify atomic rollback across all tables:
    // 1. Revision unchanged
    const revAfter = (await getWorkspaceRevision(env.DB, ws1))?.business_revision ?? 0;
    expect(revAfter).toBe(revBefore);

    // 2. No event inserted
    const eventRow = await env.DB.prepare(
      `SELECT id FROM events WHERE workspace_id = ? AND action_id = ?`
    ).bind(ws1, actionId).first();
    expect(eventRow).toBeNull();

    // 3. No memory_entries row
    const memRow = await env.DB.prepare(
      `SELECT id FROM memory_entries WHERE workspace_id = ? AND content LIKE '%Rollback test content note%'`
    ).bind(ws1).first();
    expect(memRow).toBeNull();

    // 4. No FTS row
    const ftsRow = await env.DB.prepare(
      `SELECT entry_id FROM memory_entries_fts WHERE content MATCH 'Rollback'`
    ).first();
    expect(ftsRow).toBeNull();

    // 5. No action receipt
    const rcptRow = await env.DB.prepare(
      `SELECT id FROM action_receipts WHERE workspace_id = ? AND action_id = ?`
    ).bind(ws1, actionId).first();
    expect(rcptRow).toBeNull();

    // 6. No refresh job
    const jobRow = await env.DB.prepare(
      `SELECT id FROM memory_refresh_jobs WHERE workspace_id = ? AND target_revision = ?`
    ).bind(ws1, revBefore + 1).first();
    expect(jobRow).toBeNull();
  });

  it('manages durable memory lifecycle (remember, search, get, forget) with FTS and refresh jobs', async () => {
    let rev = (await getWorkspaceRevision(env.DB, ws1))?.business_revision ?? 0;
    const memActionId = 'act_mem_lifecycle_1';

    // 1. Remember workspace context
    const remRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: memActionId,
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'remember_context',
      toolArgs: {
        scope: 'workspace',
        category: 'workflow_context',
        content: 'Quotes are strictly in RON minor units with 2 business day follow-ups.',
      },
    });

    expect(remRes.status).toBe('applied');
    rev = remRes.committed_revision!;
    const memoryId = remRes.affected_resource_ids?.[0];
    expect(memoryId).toBeDefined();

    // Verify memory_entries table
    const memEntry = await env.DB.prepare(
      `SELECT id, scope, category, content, status, business_revision FROM memory_entries WHERE id = ?`
    ).bind(memoryId).first<{ id: string; scope: string; category: string; content: string; status: string; business_revision: number }>();
    expect(memEntry?.status).toBe('active');
    expect(memEntry?.scope).toBe('workspace');
    expect(memEntry?.content).toContain('Quotes are strictly in RON minor units');
    expect(memEntry?.business_revision).toBe(rev);

    // Verify FTS row
    const ftsRow = await env.DB.prepare(
      `SELECT entry_id FROM memory_entries_fts WHERE entry_id = ?`
    ).bind(memoryId).first<{ entry_id: string }>();
    expect(ftsRow?.entry_id).toBe(memoryId);

    // Verify memory_refresh_jobs pending job
    const jobRow = await env.DB.prepare(
      `SELECT id, state, target_revision FROM memory_refresh_jobs WHERE workspace_id = ? AND target_revision = ?`
    ).bind(ws1, rev).first<{ id: string; state: string; target_revision: number }>();
    expect(jobRow?.state).toBe('pending');
    expect(jobRow?.target_revision).toBe(rev);

    // 2. Search memory via search_memory tool
    const searchRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_search_mem',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'search_memory',
      toolArgs: {
        query: 'Quotes',
        scope: 'workspace',
      },
    });
    expect(searchRes.status).toBe('applied');
    const searchRows = searchRes.data as Array<{ id: string; content: string }>;
    expect(searchRows.some((r) => r.id === memoryId)).toBe(true);

    // 3. Get memory entry details via get_memory tool
    const getRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_get_mem',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'get_memory',
      toolArgs: {
        memory_id: memoryId,
      },
    });
    expect(getRes.status).toBe('applied');
    expect((getRes.data as { id: string }).id).toBe(memoryId);

    // 4. Forget memory via forget_memory tool
    const forgetRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_forget_mem_1',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'forget_memory',
      toolArgs: {
        memory_id: memoryId,
      },
    });
    expect(forgetRes.status).toBe('applied');
    rev = forgetRes.committed_revision!;

    // Verify memory_entries status is now forgotten
    const updatedMem = await env.DB.prepare(
      `SELECT status FROM memory_entries WHERE id = ?`
    ).bind(memoryId).first<{ status: string }>();
    expect(updatedMem?.status).toBe('forgotten');

    // Verify FTS row was deleted
    const ftsDeleted = await env.DB.prepare(
      `SELECT entry_id FROM memory_entries_fts WHERE entry_id = ?`
    ).bind(memoryId).first();
    expect(ftsDeleted).toBeNull();

    // Verify memory_suppressions tombstone row created
    const suppressionRow = await env.DB.prepare(
      `SELECT target_memory_id, revision FROM memory_suppressions WHERE workspace_id = ? AND target_memory_id = ?`
    ).bind(ws1, memoryId).first<{ target_memory_id: string; revision: number }>();
    expect(suppressionRow?.target_memory_id).toBe(memoryId);
    expect(suppressionRow?.revision).toBe(rev);

    // 5. Active search must no longer return forgotten memory
    const searchAfterForget = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_search_after_forget',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'search_memory',
      toolArgs: {
        query: 'Quotes',
        scope: 'workspace',
      },
    });
    const rowsAfter = searchAfterForget.data as Array<{ id: string }>;
    expect(rowsAfter.some((r) => r.id === memoryId)).toBe(false);

    // 6. Direct read of forgotten memory reports inactivity, never content.
    const getAfterForget = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_get_after_forget',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'get_memory',
      toolArgs: {
        memory_id: memoryId,
      },
    });
    expect(getAfterForget.status).toBe('rejected');
    if (getAfterForget.status === 'rejected') {
      expect(getAfterForget.error?.code).toBe('memory_inactive');
    }
  });

  it('handles duplicate action idempotency: identical retry returns already_applied; changed payload conflicts', async () => {
    let rev = (await getWorkspaceRevision(env.DB, ws1))?.business_revision ?? 0;
    const fixedActionId = 'act_idempotency_note_test';

    // 1. First execution
    const firstCall = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: fixedActionId,
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'remember_context',
      toolArgs: {
        scope: 'workspace',
        category: 'workflow_context',
        content: 'Original idempotency test note.',
      },
    });
    expect(firstCall.status).toBe('applied');
    rev = firstCall.committed_revision!;

    // 2. Identical retry: returns already_applied, does NOT increment revision or emit event
    const secondCall = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: fixedActionId,
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'remember_context',
      toolArgs: {
        scope: 'workspace',
        category: 'workflow_context',
        content: 'Original idempotency test note.',
      },
    });
    expect(secondCall.status).toBe('already_applied');
    const revAfterRetry = (await getWorkspaceRevision(env.DB, ws1))?.business_revision;
    expect(revAfterRetry).toBe(rev);

    // 3. Changed payload with SAME action_id: returns conflict
    const conflictCall = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: fixedActionId,
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'remember_context',
      toolArgs: {
        scope: 'workspace',
        category: 'workflow_context',
        content: 'CHANGED content using same action ID.',
      },
    });
    expect(conflictCall.status).toBe('conflict');
  });

  it('manages draft lifecycle: draft_message, update_draft, and mark_message_sent', async () => {
    let rev = (await getWorkspaceRevision(env.DB, ws1))?.business_revision ?? 0;

    // First create an entity to attach drafts to
    const createEntRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_create_draft_entity',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'upsert_entity',
      toolArgs: { name: 'Restaurant 2' },
    });
    expect(createEntRes.status).toBe('applied');
    rev = createEntRes.committed_revision!;
    const entityId = createEntRes.affected_resource_ids?.[0];
    expect(entityId).toBeDefined();

    // 1. Draft message
    const draftRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_draft_1',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'draft_message',
      toolArgs: {
        entity_id: entityId,
        channel: 'whatsapp',
        recipient: '+40712345678',
        content: 'Hello, here is our 3,500 RON offer.',
      },
    });
    expect(draftRes.status).toBe('applied');
    rev = draftRes.committed_revision!;
    const draftId = draftRes.affected_resource_ids?.[0];
    expect(draftId).toBeDefined();

    // Check draft table in D1
    const draftRow1 = await env.DB.prepare(
      `SELECT status, content_text FROM draft_projections WHERE id = ?`
    ).bind(draftId).first<{ status: string; content_text: string }>();
    expect(draftRow1?.status).toBe('draft');
    expect(draftRow1?.content_text).toContain('3,500 RON offer');

    // 2. Update draft
    const updateDraftRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_update_draft_1',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'update_draft',
      toolArgs: {
        draft_id: draftId,
        content: 'Updated offer: 3,500 RON with 3 months free support.',
      },
    });
    expect(updateDraftRes.status).toBe('applied');
    rev = updateDraftRes.committed_revision!;

    const draftRow2 = await env.DB.prepare(
      `SELECT content_text FROM draft_projections WHERE id = ?`
    ).bind(draftId).first<{ content_text: string }>();
    expect(draftRow2?.content_text).toContain('3 months free support');

    // 3. Mark message sent
    const markSentRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_mark_sent_1',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      sourceText: 'I sent the offer to +40712345678.',
      toolName: 'mark_message_sent',
      toolArgs: {
        draft_id: draftId,
      },
    });
    expect(markSentRes.status).toBe('applied');
    rev = markSentRes.committed_revision!;

    const draftRow3 = await env.DB.prepare(
      `SELECT status FROM draft_projections WHERE id = ?`
    ).bind(draftId).first<{ status: string }>();
    expect(draftRow3?.status).toBe('member_confirmed_sent');

    // 4. Repeated mark message sent returns already_applied
    const markSentRepeat = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_mark_sent_repeat',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      sourceText: 'I already sent it.',
      toolName: 'mark_message_sent',
      toolArgs: { draft_id: draftId },
    });
    expect(markSentRepeat.status).toBe('already_applied');
  });

  it('requires explicit source-backed send confirmation bound to the draft target and actor', async () => {
    let rev = (await getWorkspaceRevision(env.DB, ws1))?.business_revision ?? 0;
    const entRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      actionId: 'act_auth_entity',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'upsert_entity',
      toolArgs: { name: 'Authority Bakery' },
    });
    expect(entRes.status).toBe('applied');
    rev = entRes.committed_revision!;
    const entityId = entRes.affected_resource_ids?.[0];
    expect(entityId).toBeDefined();

    const draftRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_auth_draft',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'draft_message',
      toolArgs: {
        entity_id: entityId,
        channel: 'whatsapp',
        recipient: '+40711111111',
        content: 'Authority check offer.',
      },
    });
    expect(draftRes.status).toBe('applied');
    rev = draftRes.committed_revision!;
    const draftId = draftRes.affected_resource_ids?.[0];
    expect(draftId).toBeDefined();

    const mark = (actionId: string, toolArgs: unknown, sourceText?: string) =>
      executeAgentTool({
        db: env.DB,
        workspaceId: ws1,
        actorUserId: aviId,
        runId: run1Id,
        stepId: step1Id,
        fence: fence1,
        expectedBusinessRevision: rev,
        actionId,
        sourceMessageId: 'msg_tools_1',
        chatId: chat1,
        ...(sourceText !== undefined ? { sourceText } : {}),
        toolName: 'mark_message_sent',
        toolArgs,
      });

    // No member words: an absent source confirms nothing.
    const empty = await mark('act_auth_empty', { draft_id: draftId });
    expect(empty.status).toBe('needs_clarification');
    if (empty.status === 'needs_clarification') {
      expect(empty.clarification?.missing_fields).toEqual(['sent_confirmation']);
    }

    // Negated confirmation clarifies instead of marking.
    const negated = await mark('act_auth_neg', { draft_id: draftId }, 'I have not sent it yet.');
    expect(negated.status).toBe('needs_clarification');

    // A confirmation naming another number is about a different send.
    const otherTarget = await mark('act_auth_other', { draft_id: draftId }, 'I sent it to +40722222222.');
    expect(otherTarget.status).toBe('needs_clarification');
    if (otherTarget.status === 'needs_clarification') {
      expect(otherTarget.clarification?.prompt).toContain('+40722222222');
    }

    // Attribution cannot be smuggled in: the tool schema takes draft_id
    // only, so a model-supplied confirmer is rejected, not recorded.
    const spoofed = await mark(
      'act_auth_spoof',
      { draft_id: draftId, confirmed_by_user_id: 'usr_outsider_tools' },
      'I sent it.',
    );
    expect(spoofed.status).toBe('rejected');

    // Matching target confirms: the event attributes the acting member.
    const confirmed = await mark('act_auth_ok', { draft_id: draftId }, 'Am trimis oferta la +40711111111.');
    expect(confirmed.status).toBe('applied');
    const events = await getWorkspaceEvents(env.DB, ws1);
    const sent = events.find(
      (event) => event.kind === 'message_sent_by_member' && (event.payload as { draft_id?: string }).draft_id === draftId,
    );
    expect(sent).toBeDefined();
    expect((sent!.payload as { confirmed_by_user_id?: string }).confirmed_by_user_id).toBe(aviId);
  });

  it('revalidates task mutation by revision and treats redundant terminal states as applied', async () => {
    let rev = (await getWorkspaceRevision(env.DB, ws1))?.business_revision ?? 0;
    const created = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_rev_task',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      sourceText: 'Finish the quarterly report with no deadline.',
      toolName: 'create_task',
      toolArgs: { title: 'Quarterly report', explicit_no_deadline: true },
    });
    expect(created.status).toBe('applied');
    const taskId = created.affected_resource_ids?.[0];
    expect(taskId).toBeDefined();
    rev = created.committed_revision!;

    const done = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_rev_done',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'update_task',
      toolArgs: { task_id: taskId, expected_revision: 1, status: 'done' },
    });
    expect(done.status).toBe('applied');
    rev = done.committed_revision!;

    // Stale revision conflicts instead of overwriting.
    const stale = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_rev_stale',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'update_task',
      toolArgs: { task_id: taskId, expected_revision: 1, status: 'cancelled' },
    });
    expect(stale.status).toBe('conflict');

    // Redundant terminal transition is already applied, not a new event.
    const eventsBefore = await countEvents();
    const redundant = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_rev_redundant',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'update_task',
      toolArgs: { task_id: taskId, expected_revision: 2, status: 'done' },
    });
    expect(redundant.status).toBe('already_applied');
    expect(await countEvents()).toBe(eventsBefore);

    async function countEvents(): Promise<number> {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE workspace_id = ?`)
        .bind(ws1).first<{ n: number }>();
      return Number(row?.n ?? 0);
    }
  });

  it('scopes memory search to visible notes: own member notes, never teammates, never forgotten', async () => {
    let rev = (await getWorkspaceRevision(env.DB, ws1))?.business_revision ?? 0;
    const remember = (actionId: string, actor: string, toolArgs: unknown) =>
      executeAgentTool({
        db: env.DB,
        workspaceId: ws1,
        actorUserId: actor,
        runId: run1Id,
        stepId: step1Id,
        fence: fence1,
        actionId,
        sourceMessageId: 'msg_tools_1',
        chatId: chat1,
        toolName: 'remember_context',
        toolArgs,
      });

    const aviNote = await remember('act_scope_avi', aviId, {
      scope: 'member_in_workspace',
      subject_id: aviId,
      category: 'relationship_context',
      content: 'Avi private riverside pickup preference',
    });
    expect(aviNote.status).toBe('applied');
    const hunorNote = await remember('act_scope_hunor', aviId, {
      scope: 'member_in_workspace',
      subject_id: hunorId,
      category: 'relationship_context',
      content: 'Hunor private riverside pickup preference',
    });
    expect(hunorNote.status).toBe('applied');
    const teamNote = await remember('act_scope_team', aviId, {
      scope: 'workspace',
      category: 'workflow_context',
      content: 'Team riverside delivery workflow',
    });
    expect(teamNote.status).toBe('applied');
    rev = teamNote.committed_revision!;
    const teamId = teamNote.affected_resource_ids?.[0];
    expect(teamId).toBeDefined();

    const searchAs = (actionId: string, actor: string) =>
      executeAgentTool({
        db: env.DB,
        workspaceId: ws1,
        actorUserId: actor,
        runId: run1Id,
        stepId: step1Id,
        fence: fence1,
        expectedBusinessRevision: rev,
        actionId,
        sourceMessageId: 'msg_tools_1',
        chatId: chat1,
        toolName: 'search_memory',
        toolArgs: { query: 'riverside pickup' },
      });

    // Avi sees their own member note and the workspace note, never Hunor's.
    const aviSearch = await searchAs('act_scope_search_avi', aviId);
    expect(aviSearch.status).toBe('applied');
    const aviIds = (aviSearch.data as Array<{ id: string }>).map((r) => r.id);
    expect(aviIds).toContain(aviNote.affected_resource_ids?.[0]);
    expect(aviIds).toContain(teamId);
    expect(aviIds).not.toContain(hunorNote.affected_resource_ids?.[0]);

    // Forgetting the workspace note removes it from search for everyone.
    const forgetRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_scope_forget',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'forget_memory',
      toolArgs: { memory_id: teamId },
    });
    expect(forgetRes.status).toBe('applied');
    rev = forgetRes.committed_revision!;

    const hunorSearch = await searchAs('act_scope_search_hunor', hunorId);
    expect(hunorSearch.status).toBe('applied');
    const hunorIds = (hunorSearch.data as Array<{ id: string }>).map((r) => r.id);
    expect(hunorIds).toContain(hunorNote.affected_resource_ids?.[0]);
    expect(hunorIds).not.toContain(teamId);
    expect(hunorIds).not.toContain(aviNote.affected_resource_ids?.[0]);
  });

  it('snoozes a task on a valid instant and clears it on explicit null', async () => {
    const rev0 = (await getWorkspaceRevision(env.DB, ws1))?.business_revision ?? 0;
    const created = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev0,
      actionId: 'act_snooze_create',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      sourceText: 'Remind me about this with no deadline.',
      toolName: 'create_task',
      toolArgs: { title: 'Snooze probe', explicit_no_deadline: true },
    });
    expect(created.status).toBe('applied');
    const taskId = created.affected_resource_ids?.[0];
    expect(taskId).toBeDefined();
    let rev = created.committed_revision!;

    const snoozed = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_snooze_set',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'update_task',
      toolArgs: { task_id: taskId, snooze_until: '2026-10-20T09:00:00.000Z' },
    });
    expect(snoozed.status).toBe('applied');
    rev = snoozed.committed_revision!;
    const held = await env.DB.prepare(`SELECT snooze_until FROM tasks WHERE id = ?`)
      .bind(taskId).first<{ snooze_until: string | null }>();
    expect(held?.snooze_until).toBe('2026-10-20T09:00:00.000Z');

    // Explicit null unsnoozes; the projection clears instead of lingering.
    const cleared = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_snooze_clear',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'update_task',
      toolArgs: { task_id: taskId, snooze_until: null },
    });
    expect(cleared.status).toBe('applied');
    const released = await env.DB.prepare(`SELECT snooze_until FROM tasks WHERE id = ?`)
      .bind(taskId).first<{ snooze_until: string | null }>();
    expect(released?.snooze_until).toBeNull();
  });

  it('pages older chat history within the workspace, never across it', async () => {
    const now = new Date().toISOString();
    // High sequences avoid colliding with messages other cases stored.
    for (let seq = 1001; seq <= 1025; seq++) {
      await env.DB.prepare(
        `INSERT INTO chat_messages (id, workspace_id, chat_id, author_user_id, author_kind, channel, client_message_id, content_text, run_id, sequence, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'member', 'web', NULL, ?, NULL, ?, ?, ?)`
      ).bind(`msg_hist_${seq}`, ws1, chat1, aviId, `history note ${seq}`, seq, now, now).run();
    }

    const read = (actionId: string, toolArgs: unknown, chatId?: string) =>
      executeAgentTool({
        db: env.DB,
        workspaceId: ws1,
        actorUserId: aviId,
        runId: run1Id,
        stepId: step1Id,
        fence: fence1,
        actionId,
        sourceMessageId: 'msg_tools_1',
        ...(chatId !== undefined ? { chatId } : {}),
        toolName: 'read_chat_history',
        toolArgs,
      });

    // Default window: latest 20, ascending, with an older cursor.
    const latest = await read('act_hist_latest', {}, chat1);
    expect(latest.status).toBe('applied');
    const latestData = latest.data as { chat_id: string; messages: { sequence: number; content_text: string }[]; older: number | null };
    expect(latestData.chat_id).toBe(chat1);
    expect(latestData.messages).toHaveLength(20);
    expect(latestData.messages[0]!.sequence).toBe(1006);
    expect(latestData.messages[19]!.sequence).toBe(1025);
    expect(latestData.messages[19]!.content_text).toBe('history note 1025');
    expect(latestData.older).toBe(1006);

    // Explicit chat defaults the same; paging backwards reaches the start.
    const first = await read('act_hist_first', { chat_id: chat1, before_sequence: 1006, limit: 20 });
    expect(first.status).toBe('applied');
    const firstData = first.data as { messages: { sequence: number }[]; older: number | null };
    expect(firstData.messages.map((m) => m.sequence)).toEqual([1001, 1002, 1003, 1004, 1005]);
    expect(firstData.older).toBe(1001);
    const empty = await read('act_hist_empty', { chat_id: chat1, before_sequence: 1001 });
    expect(empty.status).toBe('applied');
    expect((empty.data as { messages: unknown[] }).messages).toHaveLength(0);
    expect((empty.data as { older: number | null }).older).toBeNull();

    // Unknown chats and other workspaces resolve to not_found, never rows.
    const missing = await read('act_hist_missing', { chat_id: 'chat_nope' });
    expect(missing.status).toBe('rejected');
    const foreign = await read('act_hist_foreign', { chat_id: 'chat_ws2_foreign' });
    expect(foreign.status).toBe('rejected');

    // Invalid paging never reaches the database.
    const badLimit = await read('act_hist_bad', { limit: 500 });
    expect(badLimit.status).toBe('rejected');
  });

  it('updates member preferences with live run/fence guard and action receipt; rolls back on stale fence', async () => {
    const rev = (await getWorkspaceRevision(env.DB, ws1))?.business_revision ?? 0;

    // 1. Valid update_preference call via executeAgentTool
    const prefRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_pref_1',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'update_preference',
      toolArgs: {
        preferred_language: 'ro',
        brief_enabled: true,
        brief_local_time: '09:00',
        brief_timezone: 'Europe/Bucharest',
        brief_weekdays: [1, 2, 3, 4, 5],
        brief_channel: 'telegram',
      },
    });
    expect(prefRes.status).toBe('applied');

    // Verify member_settings in D1
    const prefRow = await env.DB.prepare(
      `SELECT preferred_language, brief_enabled, brief_timezone FROM member_settings WHERE workspace_id = ? AND user_id = ?`
    ).bind(ws1, aviId).first<{ preferred_language: string; brief_enabled: number; brief_timezone: string }>();
    expect(prefRow?.preferred_language).toBe('ro');
    expect(prefRow?.brief_enabled).toBe(1);
    expect(prefRow?.brief_timezone).toBe('Europe/Bucharest');

    // Verify action receipt was inserted in D1
    const rcpt = await env.DB.prepare(
      `SELECT result_status FROM action_receipts WHERE workspace_id = ? AND action_id = ?`
    ).bind(ws1, 'act_pref_1').first<{ result_status: string }>();
    expect(rcpt?.result_status).toBe('applied');

    // 2. Retry with identical payload returns replayed result
    const prefRetry = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_pref_1',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'update_preference',
      toolArgs: {
        preferred_language: 'ro',
        brief_enabled: true,
        brief_local_time: '09:00',
        brief_timezone: 'Europe/Bucharest',
        brief_weekdays: [1, 2, 3, 4, 5],
        brief_channel: 'telegram',
      },
    });
    expect(prefRetry.status).toBe('applied');

    // 3. Retry with changed payload on same action ID returns conflict
    const prefConflict = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_pref_1',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'update_preference',
      toolArgs: {
        preferred_language: 'en',
      },
    });
    expect(prefConflict.status).toBe('conflict');

    // 4. Stale fence call must fail and roll back
    const staleFenceRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1 + 999, // Stale/wrong fence
      expectedBusinessRevision: rev,
      actionId: 'act_pref_stale_fence',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'update_preference',
      toolArgs: {
        preferred_language: 'en',
      },
    });
    expect(staleFenceRes.status).toBe('conflict');

    // Verify setting was NOT changed to 'en'
    const prefRowAfter = await env.DB.prepare(
      `SELECT preferred_language FROM member_settings WHERE workspace_id = ? AND user_id = ?`
    ).bind(ws1, aviId).first<{ preferred_language: string }>();
    expect(prefRowAfter?.preferred_language).toBe('ro');
  });

  it('enforces explicit lead status intent vs inferred interest at the tool boundary', async () => {
    let rev = (await getWorkspaceRevision(env.DB, ws1))?.business_revision ?? 0;

    // Create an entity to test status on
    const entRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_status_lead_ent',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'upsert_entity',
      toolArgs: { name: 'Bakery Bella' },
    });
    expect(entRes.status).toBe('applied');
    rev = entRes.committed_revision!;
    const entityId = entRes.affected_resource_ids?.[0] as string;

    // 1. Inferred intent: "Avi: Bakery Bella wants the website. We offered 3,500 RON; they expected 10,000."
    const inferredRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_inferred_status',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      sourceText: 'Bakery Bella wants the website. We offered 3,500 RON; they expected 10,000.',
      toolName: 'set_fields',
      toolArgs: {
        entity_id: entityId,
        fields: [{ field_name: 'status', value: 'warm' }],
      },
    });
    // Must return needs_clarification and NOT commit status change
    expect(inferredRes.status).toBe('needs_clarification');

    // 2. Explicit intent: "Mark Bakery Bella as warm"
    const explicitRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_explicit_status',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      sourceText: 'Mark Bakery Bella as warm.',
      toolName: 'set_fields',
      toolArgs: {
        entity_id: entityId,
        fields: [{ field_name: 'status', value: 'warm' }],
      },
    });
    expect(explicitRes.status).toBe('applied');

    // Verify entity_state has warm in D1
    const fieldRow = await env.DB.prepare(
      `SELECT value_text FROM entity_state WHERE workspace_id = ? AND entity_id = ? AND field_name = 'status'`
    ).bind(ws1, entityId).first<{ value_text: string }>();
    expect(fieldRow?.value_text).toBe('warm');
  });

  it('stores quotes in integer minor units and distinguishes offered vs expected roles', async () => {
    let rev = (await getWorkspaceRevision(env.DB, ws1))?.business_revision ?? 0;

    const entRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_quote_ent',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'upsert_entity',
      toolArgs: { name: 'Pizzeria Roma' },
    });
    rev = entRes.committed_revision!;
    const entityId = entRes.affected_resource_ids?.[0] as string;

    // 3,500 RON offered = 350,000 minor units
    const offeredRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_offered_quote',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'log_event',
      toolArgs: {
        entity_id: entityId,
        kind: 'quote',
        payload: {
          amount: 350000,
          currency: 'RON',
          role: 'offered',
        },
      },
    });
    expect(offeredRes.status).toBe('applied');
    rev = offeredRes.committed_revision!;

    // 10,000 RON expected = 1,000,000 minor units
    const expectedRes = await executeAgentTool({
      db: env.DB,
      workspaceId: ws1,
      actorUserId: aviId,
      runId: run1Id,
      stepId: step1Id,
      fence: fence1,
      expectedBusinessRevision: rev,
      actionId: 'act_expected_quote',
      sourceMessageId: 'msg_tools_1',
      chatId: chat1,
      toolName: 'log_event',
      toolArgs: {
        entity_id: entityId,
        kind: 'quote',
        payload: {
          amount: 1000000,
          currency: 'RON',
          role: 'expected',
        },
      },
    });
    expect(expectedRes.status).toBe('applied');

    // Verify both events stored in D1 events table with distinct roles and minor units
    const events = (
      await env.DB.prepare(
        `SELECT payload_json FROM events WHERE workspace_id = ? AND entity_id = ? AND kind = 'quote' ORDER BY sequence ASC`
      )
        .bind(ws1, entityId)
        .all<{ payload_json: string }>()
    ).results;

    expect(events.length).toBe(2);
    const p1 = JSON.parse(events[0]!.payload_json);
    const p2 = JSON.parse(events[1]!.payload_json);

    expect(p1.amount).toBe(350000);
    expect(p1.currency).toBe('RON');
    expect(p1.role).toBe('offered');

    expect(p2.amount).toBe(1000000);
    expect(p2.currency).toBe('RON');
    expect(p2.role).toBe('expected');
  });

  it('revises and removes one interaction through agent tools with head and policy guards', async () => {
    let rev = (await getWorkspaceRevision(env.DB, ws1))?.business_revision ?? 0;
    const tool = (actionId: string, toolName: string, toolArgs: unknown, extra?: Record<string, unknown>) =>
      executeAgentTool({
        db: env.DB,
        workspaceId: ws1,
        actorUserId: aviId,
        runId: run1Id,
        stepId: step1Id,
        fence: fence1,
        expectedBusinessRevision: rev,
        actionId,
        sourceMessageId: 'msg_tools_1',
        chatId: chat1,
        toolName,
        toolArgs,
        ...extra,
      });

    // A smuggled root marker in a new log is rejected at the tool boundary.
    const smuggled = await tool('act_tools_smuggle', 'log_event', {
      kind: 'note',
      payload: { text: 'hi', interaction_id: 'evt_other' },
    });
    expect(smuggled.status).toBe('rejected');

    const logged = await tool('act_tools_c1_log', 'log_event', {
      kind: 'note',
      payload: { text: 'Original entry' },
    });
    expect(logged.status).toBe('applied');
    rev = logged.committed_revision!;
    const root = (logged.data as { event_id: string }).event_id;

    // Forwarded text can never revise: the untrusted-content block holds.
    const forwarded = await tool(
      'act_tools_c1_fwd',
      'revise_interaction',
      {
        interaction_id: root,
        expected_head_event_id: root,
        kind: 'note',
        payload: { text: 'Forwarded edit' },
      },
      { sourceTrust: 'forwarded_client', sourceText: 'please change the note' },
    );
    expect(forwarded.status).toBe('rejected');
    expect(forwarded.error?.code).toBe('policy_violation');

    const revised = await tool('act_tools_c1_rev', 'revise_interaction', {
      interaction_id: root,
      expected_head_event_id: root,
      kind: 'note',
      payload: { text: 'Corrected entry' },
    });
    expect(revised.status).toBe('applied');
    expect((revised.data as { head_event_id: string }).head_event_id).not.toBe(root);
    rev = revised.committed_revision!;
    const head = (revised.data as { head_event_id: string }).head_event_id;

    // A stale head conflicts instead of overwriting the correction.
    const stale = await tool('act_tools_c1_stale', 'remove_interaction', {
      interaction_id: root,
      expected_head_event_id: root,
    });
    expect(stale.status).toBe('conflict');
    expect(stale.error?.code).toBe('head_conflict');

    const removed = await tool('act_tools_c1_rem', 'remove_interaction', {
      interaction_id: root,
      expected_head_event_id: head,
      reason: 'duplicate entry',
    });
    expect(removed.status).toBe('applied');
    expect(removed.summary).toContain('Removed note');

    // The run acted: the correction guard sees applied business mutations.
    expect(
      runAppliedBusinessMutation([
        { name: 'revise_interaction', result: { status: revised.status } },
        { name: 'remove_interaction', result: { status: removed.status } },
      ]),
    ).toBe(true);
  });
});
