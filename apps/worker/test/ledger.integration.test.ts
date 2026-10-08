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
import migration0017Sql from '../../../migrations/0017_task_markers.sql?raw';
// @ts-expect-error vite raw import
import migration0023Sql from '../../../migrations/0023_interaction_state.sql?raw';

import {
  executeLedgerCommand,
  resumePendingClarification,
  handleCreateEntity,
  handleSetField,
  handleCreateTask,
  handleUpdateTask,
  handleLogEvent,
  handleResolveConflict,
  handleUndoCommit,
  rebuildProjections,
  getWorkspaceEvents,
  getWorkspaceActions,
  getWorkspaceRevision,
  type LedgerCommandContext,
} from '@otis/ledger';

describe('Worker Ledger D1 Integration (workerd runtime)', () => {
  const workspaceId = 'ws-ledger-d1-test';
  const aviUserId = 'usr_avi_ledger';
  const hunorUserId = 'usr_hunor_ledger';
  const now = new Date().toISOString();

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

    return statements.map((s) => s.replace(/;$/, '').trim()).filter((s) => s.length > 0);
  }

  beforeAll(async () => {
    // Apply migrations 0001 through 0009 plus 0017 (task marker columns the
    // current projection reads) and 0023 (interaction lifecycle table for
    // log_event projections; dependency-free by design) directly to D1
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
      migration0017Sql,
      migration0023Sql,
    ]) {
      const statements = splitSqlStatements(sql);

      for (const stmt of statements) {
        await env.DB.prepare(stmt).run();
      }
    }

    // Seed test users
    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
       VALUES (?, 'fb_avi_l', 'avi@kerning.test', 'Avi Ledger', ?, ?)`
    ).bind(aviUserId, now, now).run();

    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
       VALUES (?, 'fb_hunor_l', 'hunor@kerning.test', 'Hunor Ledger', ?, ?)`
    ).bind(hunorUserId, now, now).run();

    // Seed test workspace with a live dispatch lease: fenced run-scoped
    // writes require a present, unexpired lease held by the run's attempt.
    // Both seeded runs share the seed attempt; fencing is orthogonal to the
    // dispute/lifecycle scenarios exercised here.
    const leaseExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, last_acceptance_sequence, last_event_sequence, lease_fence, lease_owner, lease_attempt_id, lease_expires_at, created_at, updated_at)
       VALUES (?, 'Kerning Ledger Test', ?, 0, 1, 0, 0, 1, 'att_ledger_seed', 'att_ledger_seed', ?, ?, ?)`
    ).bind(workspaceId, aviUserId, leaseExpiresAt, now, now).run();

    // Seed memberships
    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'owner', ?, ?, ?)`
    ).bind(workspaceId, aviUserId, now, now, now).run();

    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
       VALUES (?, ?, 'member', ?, ?, ?)`
    ).bind(workspaceId, hunorUserId, now, now, now).run();

    // Seed a valid source message in messages_in for avi
    await env.DB.prepare(
      `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
       VALUES ('msg_valid_1', ?, ?, 'web', 'web_msg_1', 'fp_1', 'processed', ?, ?)`
    ).bind(workspaceId, aviUserId, now, now).run();

    // Seed chat for avi
    await env.DB.prepare(
      `INSERT INTO chats (id, workspace_id, author_user_id, title, activity_cursor, created_at, updated_at, last_activity_at)
       VALUES ('chat_ledger_1', ?, ?, 'Ledger Chat', 0, ?, ?, ?)`
    ).bind(workspaceId, aviUserId, now, now, now).run();

    // Seed agent run for avi (pinned to the seed lease holder)
    await env.DB.prepare(
      `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, executor_kind, status, attempt_id, lease_fence, created_at, updated_at)
       VALUES ('run-ledger-test-1', ?, 'chat_ledger_1', 'msg_valid_1', 'agent', 'running', 'att_ledger_seed', 1, ?, ?)`
    ).bind(workspaceId, now, now).run();

    // Seed message, chat, and run for hunor
    await env.DB.prepare(
      `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
       VALUES ('msg_hunor_1', ?, ?, 'web', 'web_hunor_msg_1', 'fp_h1', 'processed', ?, ?)`
    ).bind(workspaceId, hunorUserId, now, now).run();

    await env.DB.prepare(
      `INSERT INTO chats (id, workspace_id, author_user_id, title, activity_cursor, created_at, updated_at, last_activity_at)
       VALUES ('chat_ledger_hunor', ?, ?, 'Hunor Ledger Chat', 0, ?, ?, ?)`
    ).bind(workspaceId, hunorUserId, now, now, now).run();

    await env.DB.prepare(
      `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, executor_kind, status, attempt_id, lease_fence, created_at, updated_at)
       VALUES ('run-ledger-hunor-1', ?, 'chat_ledger_hunor', 'msg_hunor_1', 'agent', 'running', 'att_ledger_seed', 1, ?, ?)`
    ).bind(workspaceId, now, now).run();
  });

  function makeContext(actionId: string, revision = 0): LedgerCommandContext {
    return {
      workspace_id: workspaceId,
      actor: { kind: 'member', user_id: aviUserId },
      membership_revision: 1,
      source_message_id: 'msg_valid_1',
      request_id: `req_${actionId}`,
      action_id: actionId,
      expected_business_revision: revision,
      fence: 1,
      run_id: 'run-ledger-test-1',
    };
  }

  describe('Atomic D1 Write Protocol & Transaction Guards (TX-01, TX-02, TX-04)', () => {
    it('rolls back all mutations if a statement fails late in the D1 batch (TX-01)', async () => {
      const initialWs = await getWorkspaceRevision(env.DB, workspaceId);
      const initialRevision = initialWs!.business_revision;

      // Create a batch that attempts an insert into entities, but also fails ledger_guards at the end
      const guardId = `guard_${crypto.randomUUID()}`;
      const doomedBatch = [
        env.DB.prepare(
          `INSERT INTO entities (id, workspace_id, name, kind, status, created_at, updated_at)
           VALUES ('ent_doomed', ?, 'Doomed Restaurant', 'lead', 'new', ?, ?)`
        ).bind(workspaceId, now, now),
        // Intentionally violating CHECK (guard_ok = 1)
        env.DB.prepare(
          `INSERT INTO ledger_guards (id, guard_ok) VALUES (?, 0)`
        ).bind(guardId),
      ];

      await expect(env.DB.batch(doomedBatch)).rejects.toThrow();

      // Assert rollback: ent_doomed does NOT exist
      const doomedEntity = await env.DB
        .prepare(`SELECT * FROM entities WHERE id = 'ent_doomed'`)
        .first();
      expect(doomedEntity).toBeNull();

      // Business revision was NOT modified
      const currentWs = await getWorkspaceRevision(env.DB, workspaceId);
      expect(currentWs!.business_revision).toBe(initialRevision);
    });

    it('rejects concurrent write with stale expected business revision (TX-02)', async () => {
      // 1. First command commits at revision 0
      const ctx1 = makeContext('act_tx02_1', 0);
      const res1 = await executeLedgerCommand(
        env.DB,
        ctx1,
        'create_entity',
        { name: 'Concurrent Entity A' },
        handleCreateEntity,
      );
      expect(res1.status).toBe('applied');
      expect(res1.committed_revision).toBe(1);

      // 2. Second command concurrently submitted also expecting revision 0
      const ctx2 = makeContext('act_tx02_2', 0);
      const res2 = await executeLedgerCommand(
        env.DB,
        ctx2,
        'create_entity',
        { name: 'Concurrent Entity B' },
        handleCreateEntity,
      );

      expect(res2.status).toBe('conflict');
      expect(res2.error?.code).toBe('revision_conflict');

      // Entity B was not created
      const entB = await env.DB
        .prepare(`SELECT * FROM entities WHERE name = 'Concurrent Entity B'`)
        .first();
      expect(entB).toBeNull();

      // Business revision remains 1
      const currentWs = await getWorkspaceRevision(env.DB, workspaceId);
      expect(currentWs!.business_revision).toBe(1);
    });

    it('replays identical action receipt on retry without repeating business effect (TX-04)', async () => {
      const currentWs = await getWorkspaceRevision(env.DB, workspaceId);
      const startRev = currentWs!.business_revision;

      const ctx = makeContext('act_retry_test', startRev);
      const args = { name: 'Retryable Bistro' };

      // 1. First attempt commits
      const res1 = await executeLedgerCommand(
        env.DB,
        ctx,
        'create_entity',
        args,
        handleCreateEntity,
      );
      expect(res1.status).toBe('applied');
      const entityId = (res1.data as { entity_id: string }).entity_id;

      // 2. Lost network response / retry with SAME action_id and SAME payload
      const res2 = await executeLedgerCommand(
        env.DB,
        ctx,
        'create_entity',
        args,
        handleCreateEntity,
      );
      expect(res2.status).toBe('already_applied');
      expect((res2.data as { entity_id: string }).entity_id).toBe(entityId);

      // Events table has exactly ONE entity_created event for this action
      const events = await env.DB
        .prepare(`SELECT COUNT(*) as count FROM events WHERE action_id = 'act_retry_test'`)
        .first<{ count: number }>();
      expect(events?.count).toBe(1);

      // Revision incremented exactly once
      const afterWs = await getWorkspaceRevision(env.DB, workspaceId);
      expect(afterWs!.business_revision).toBe(startRev + 1);
    });

    it('returns conflict if an action_id is reused with different arguments', async () => {
      const currentWs = await getWorkspaceRevision(env.DB, workspaceId);
      const startRev = currentWs!.business_revision;

      const ctx = makeContext('act_conflict_test', startRev);
      // First commit
      await executeLedgerCommand(
        env.DB,
        ctx,
        'create_entity',
        { name: 'Original Name' },
        handleCreateEntity,
      );

      // Reused action ID with altered name
      const resConflict = await executeLedgerCommand(
        env.DB,
        ctx,
        'create_entity',
        { name: 'Altered Name' },
        handleCreateEntity,
      );

      expect(resConflict.status).toBe('conflict');
      expect(resConflict.error?.code).toBe('action_conflict');
    });

    it('rejects command via transaction guard if member was removed from workspace', async () => {
      // Create user to be removed
      const removedUserId = 'usr_removed_ledger';
      await env.DB.prepare(
        `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
         VALUES (?, 'fb_rm_l', 'rm_l@kerning.test', 'Removed Member', ?, ?)`
      ).bind(removedUserId, now, now).run();

      const currentWs = await getWorkspaceRevision(env.DB, workspaceId);
      const rev = currentWs!.business_revision;

      const ctxRemoved: LedgerCommandContext = {
        ...makeContext('act_removed_user_test', rev),
        actor: { kind: 'member', user_id: removedUserId },
      };

      // User has no workspace_users record -> guard fails!
      const res = await executeLedgerCommand(
        env.DB,
        ctxRemoved,
        'create_entity',
        { name: 'Unauthorized Entity' },
        handleCreateEntity,
      );

      expect(res.status).toBe('rejected');
      expect(res.error?.code).toBe('forbidden');

      const ent = await env.DB
        .prepare(`SELECT * FROM entities WHERE name = 'Unauthorized Entity'`)
        .first();
      expect(ent).toBeNull();
    });

    it('rejects command via transaction guard if source_message_id belongs to another workspace', async () => {
      // Create another workspace and message
      const otherWsId = 'ws-other-isolation';
      await env.DB.prepare(
        `INSERT INTO workspaces (id, name, business_revision, membership_revision, created_at, updated_at)
         VALUES (?, 'Other WS', 0, 1, ?, ?)`
      ).bind(otherWsId, now, now).run();

      await env.DB.prepare(
        `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
         VALUES ('msg_other_ws', ?, ?, 'web', 'other_msg_1', 'fp_other', 'processed', ?, ?)`
      ).bind(otherWsId, aviUserId, now, now).run();

      const currentWs = await getWorkspaceRevision(env.DB, workspaceId);
      const rev = currentWs!.business_revision;

      const ctxWrongSource: LedgerCommandContext = {
        ...makeContext('act_wrong_source_test', rev),
        source_message_id: 'msg_other_ws', // belongs to otherWsId!
      };

      // In D1 batch, guard verifies messages_in.workspace_id = context.workspace_id
      const res = await executeLedgerCommand(
        env.DB,
        ctxWrongSource,
        'create_entity',
        { name: 'Wrong Source Entity' },
        handleCreateEntity,
      );
      expect(res.status).toBe('rejected');
      expect(res.error?.code).toBe('source_conflict');

      const ent = await env.DB
        .prepare(`SELECT * FROM entities WHERE name = 'Wrong Source Entity'`)
        .first();
      expect(ent).toBeNull();
    });

    it('rejects command via transaction guard if a member cites another member message in the same workspace', async () => {
      const currentWs = await getWorkspaceRevision(env.DB, workspaceId);
      const rev = currentWs!.business_revision;

      // Avi tries to cite Hunor's source message msg_hunor_1
      const ctxCrossMember: LedgerCommandContext = {
        ...makeContext('act_cross_member_source', rev),
        actor: { kind: 'member', user_id: aviUserId },
        source_message_id: 'msg_hunor_1', // belongs to Hunor in same workspace!
      };

      const res = await executeLedgerCommand(
        env.DB,
        ctxCrossMember,
        'create_entity',
        { name: 'Rogue Cross Member Entity' },
        handleCreateEntity,
      );

      expect(res.status).toBe('conflict');
      expect(res.error?.code).toBe('guard_conflict');

      const ent = await env.DB
        .prepare(`SELECT * FROM entities WHERE name = 'Rogue Cross Member Entity'`)
        .first();
      expect(ent).toBeNull();
    });

    it('rejects command via transaction guard if execution fence is stale', async () => {
      const currentWs = await getWorkspaceRevision(env.DB, workspaceId);
      const rev = currentWs!.business_revision;

      const ctxStaleFence: LedgerCommandContext = {
        ...makeContext('act_stale_fence_test', rev),
        fence: 999, // Workspace lease_fence is 1
      };

      const res = await executeLedgerCommand(
        env.DB,
        ctxStaleFence,
        'create_entity',
        { name: 'Stale Fence Entity' },
        handleCreateEntity,
      );

      expect(res.status).toBe('conflict');
      expect(res.error?.code).toBe('fence_conflict');
    });

    it('rejects run-scoped ordinary writes without a dispatch fence (missing_fence)', async () => {
      const currentWs = await getWorkspaceRevision(env.DB, workspaceId);
      const rev = currentWs!.business_revision;

      // A dispatched handler must present its claimed fence; omitting it
      // fails closed before any mutation, even with a live lease and a
      // current business revision.
      const ctxNoFence: LedgerCommandContext = {
        ...makeContext('act_missing_fence_test', rev),
        fence: undefined,
      };

      const res = await executeLedgerCommand(
        env.DB,
        ctxNoFence,
        'create_entity',
        { name: 'Unfenced Entity' },
        handleCreateEntity,
      );

      expect(res.status).toBe('rejected');
      expect(res.error?.code).toBe('missing_fence');

      // Nothing committed: no receipt, no entity, no revision move.
      const receipt = await env.DB.prepare(
        `SELECT id FROM action_receipts WHERE workspace_id = ? AND action_id = ?`,
      ).bind(workspaceId, 'act_missing_fence_test').first();
      expect(receipt).toBeNull();
      const ent = await env.DB.prepare(
        `SELECT id FROM entities WHERE workspace_id = ? AND name = ?`,
      ).bind(workspaceId, 'Unfenced Entity').first();
      expect(ent).toBeNull();
      const afterWs = await getWorkspaceRevision(env.DB, workspaceId);
      expect(afterWs!.business_revision).toBe(rev);
    });
  });

  describe('Full Ledger Lifecycle & Rebuild Verification (CF-01, CF-02, UN-01, UN-02)', () => {
    it('executes entity creation, field updates, quotes, tasks, and conflicts in real D1', async () => {
      const currentWs = await getWorkspaceRevision(env.DB, workspaceId);
      let rev = currentWs!.business_revision;

      // 1. Create entity
      const resCreate = await executeLedgerCommand(
        env.DB,
        makeContext('act_lifecycle_1', rev),
        'create_entity',
        { name: 'Bistro Danube' },
        handleCreateEntity,
      );
      expect(resCreate.status).toBe('applied');
      const entityId = (resCreate.data as { entity_id: string }).entity_id;
      rev++;

      // Verify in D1 entities & entity_aliases
      const entRow = await env.DB
        .prepare(`SELECT * FROM entities WHERE id = ?`)
        .bind(entityId)
        .first<Record<string, unknown>>();
      expect(entRow!['name']).toBe('Bistro Danube');
      expect(entRow!['status']).toBe('new');

      const aliasRow = await env.DB
        .prepare(`SELECT * FROM entity_aliases WHERE entity_id = ?`)
        .bind(entityId)
        .first<Record<string, unknown>>();
      expect(aliasRow!['alias']).toBe('Bistro Danube');

      // 2. Set field (explicit status warm)
      const resStatus = await executeLedgerCommand(
        env.DB,
        makeContext('act_lifecycle_2', rev),
        'set_field',
        { entity_id: entityId, field_name: 'status', value: 'warm', provenance: 'stated' },
        handleSetField,
      );
      expect(resStatus.status).toBe('applied');
      rev++;

      // Verify updated status in D1
      const entRow2 = await env.DB
        .prepare(`SELECT status FROM entities WHERE id = ?`)
        .bind(entityId)
        .first<{ status: string }>();
      expect(entRow2?.status).toBe('warm');

      // 3. Create task with date
      const resTask = await executeLedgerCommand(
        env.DB,
        makeContext('act_lifecycle_3', rev),
        'create_task',
        {
          entity_id: entityId,
          title: 'Send formal contract',
          due: { kind: 'date', local_date: '2026-10-15', timezone: 'Europe/Bucharest' },
        },
        handleCreateTask,
      );
      expect(resTask.status).toBe('applied');
      const taskId = (resTask.data as { task_id: string }).task_id;
      rev++;

      // Verify task in D1 tasks table
      const taskRow = await env.DB
        .prepare(`SELECT * FROM tasks WHERE id = ?`)
        .bind(taskId)
        .first<Record<string, unknown>>();
      expect(taskRow!['title']).toBe('Send formal contract');
      expect(taskRow!['due_local_date']).toBe('2026-10-15');
      expect(taskRow!['status']).toBe('open');

      // 4. Mark task done
      const resTaskDone = await executeLedgerCommand(
        env.DB,
        makeContext('act_lifecycle_4', rev),
        'update_task',
        { task_id: taskId, status: 'done' },
        handleUpdateTask,
      );
      expect(resTaskDone.status).toBe('applied');
      rev++;

      const taskRow2 = await env.DB
        .prepare(`SELECT status FROM tasks WHERE id = ?`)
        .bind(taskId)
        .first<{ status: string }>();
      expect(taskRow2?.status).toBe('done');

      // 5. Quote report 1 (Avi reports 3500 EUR)
      const resQ1 = await executeLedgerCommand(
        env.DB,
        makeContext('act_lifecycle_5', rev),
        'log_event',
        {
          entity_id: entityId,
          kind: 'quote',
          payload: { amount: 350000, currency: 'EUR', role: 'offered' },
        },
        handleLogEvent,
      );
      expect(resQ1.status).toBe('applied');
      rev++;

      const fieldQuote1 = await env.DB
        .prepare(`SELECT * FROM entity_state WHERE entity_id = ? AND field_name = 'quote'`)
        .bind(entityId)
        .first<Record<string, unknown>>();
      expect(fieldQuote1!['state']).toBe('clear');
      expect(fieldQuote1!['value_text']).toContain('3500 EUR (offered)');

      // 6. Competing quote report 2 (Hunor reports 4500 EUR without superseding) -> DISPUTE (CF-01)
      const ctxHunor: LedgerCommandContext = {
        ...makeContext('act_lifecycle_6', rev),
        actor: { kind: 'member', user_id: hunorUserId },
        source_message_id: 'msg_hunor_1',
        run_id: 'run-ledger-hunor-1',
      };
      const resQ2 = await executeLedgerCommand(
        env.DB,
        ctxHunor,
        'log_event',
        {
          entity_id: entityId,
          kind: 'quote',
          payload: { amount: 450000, currency: 'EUR', role: 'offered' },
        },
        handleLogEvent,
      );
      expect(resQ2.status).toBe('applied');
      rev++;

      // Verify in D1 entity_state: field is DISPUTED, value IS NULL!
      const fieldQuoteDisputed = await env.DB
        .prepare(`SELECT * FROM entity_state WHERE entity_id = ? AND field_name = 'quote'`)
        .bind(entityId)
        .first<Record<string, unknown>>();
      expect(fieldQuoteDisputed!['state']).toBe('disputed');
      expect(fieldQuoteDisputed!['value_text']).toBeNull();
      expect(fieldQuoteDisputed!['value_json']).toBeNull();
      const candIds = JSON.parse(String(fieldQuoteDisputed!['candidate_event_ids_json'])) as string[];
      expect(candIds).toHaveLength(2);

      // 7. Resolve dispute (CF-02)
      const resResolve = await executeLedgerCommand(
        env.DB,
        makeContext('act_lifecycle_7', rev),
        'resolve_conflict',
        {
          entity_id: entityId,
          field_name: 'quote',
          resolved_value: { amount: 450000, currency: 'EUR', role: 'offered' },
          candidate_event_ids: candIds,
          rationale: 'Confirmed in writing',
        },
        handleResolveConflict,
      );
      expect(resResolve.status).toBe('applied');
      rev++;

      // Verify in D1 entity_state: field is CLEAR with resolved value
      const fieldResolved = await env.DB
        .prepare(`SELECT * FROM entity_state WHERE entity_id = ? AND field_name = 'quote'`)
        .bind(entityId)
        .first<Record<string, unknown>>();
      expect(fieldResolved!['state']).toBe('clear');
      expect(fieldResolved!['value_json']).toContain('450000');

      // 8. Rebuild verification: Pure projection rebuild from events matches D1 tables exactly!
      const allEvents = await getWorkspaceEvents(env.DB, workspaceId);
      const rebuilt = rebuildProjections(allEvents);

      // Check entity
      const d1Entity = await env.DB
        .prepare(`SELECT * FROM entities WHERE id = ?`)
        .bind(entityId)
        .first<Record<string, unknown>>();
      expect(rebuilt.entities.get(entityId)!.name).toBe(d1Entity!['name']);
      expect(rebuilt.entities.get(entityId)!.status).toBe(d1Entity!['status']);

      // Check task
      const d1Task = await env.DB
        .prepare(`SELECT * FROM tasks WHERE id = ?`)
        .bind(taskId)
        .first<Record<string, unknown>>();
      expect(rebuilt.tasks.get(taskId)!.status).toBe(d1Task!['status']);

      // Check quote field
      expect(rebuilt.fields.get(`${entityId}:quote`)!.state).toBe('clear');
      expect(rebuilt.fields.get(`${entityId}:quote`)!.value_json).toBe(
        fieldResolved!['value_json'],
      );
    });

    it('proves undo removes projection rows from D1, matches rebuild, and repeated undo commits no extra events (UN-01, UN-02)', async () => {
      const currentWs = await getWorkspaceRevision(env.DB, workspaceId);
      let rev = currentWs!.business_revision;

      // 1. Create an entity to be undone
      const actCreateId = 'act_undo_create_target';
      const resCreate = await executeLedgerCommand(
        env.DB,
        makeContext(actCreateId, rev),
        'create_entity',
        { name: 'Entity To Be Undone' },
        handleCreateEntity,
      );
      expect(resCreate.status).toBe('applied');
      const targetEntityId = (resCreate.data as { entity_id: string }).entity_id;
      rev++;

      // 2. Create a task for that entity
      const actTaskId = 'act_undo_task_target';
      const resTask = await executeLedgerCommand(
        env.DB,
        makeContext(actTaskId, rev),
        'create_task',
        {
          title: 'Task To Be Undone',
          entity_id: targetEntityId,
          due: { kind: 'instant', at: '2026-10-15T10:00:00Z', timezone: 'UTC' },
        },
        handleCreateTask,
      );
      expect(resTask.status).toBe('applied');
      const targetTaskId = (resTask.data as { task_id: string }).task_id;
      rev++;

      // 3. Set a field on that entity
      const actFieldId = 'act_undo_field_target';
      const resField = await executeLedgerCommand(
        env.DB,
        makeContext(actFieldId, rev),
        'set_field',
        { entity_id: targetEntityId, field_name: 'preferred_language', value: 'en' },
        handleSetField,
      );
      expect(resField.status).toBe('applied');
      rev++;

      // Verify rows exist in D1
      const entBefore = await env.DB
        .prepare(`SELECT * FROM entities WHERE id = ?`)
        .bind(targetEntityId)
        .first();
      expect(entBefore).not.toBeNull();

      const taskBefore = await env.DB
        .prepare(`SELECT * FROM tasks WHERE id = ?`)
        .bind(targetTaskId)
        .first();
      expect(taskBefore).not.toBeNull();

      const fieldBefore = await env.DB
        .prepare(`SELECT * FROM entity_state WHERE entity_id = ? AND field_name = 'preferred_language'`)
        .bind(targetEntityId)
        .first();
      expect(fieldBefore).not.toBeNull();

      // 4. Execute Undo from_here targeting actCreateId
      const allActions = await getWorkspaceActions(env.DB, workspaceId);
      const allEvents = await getWorkspaceEvents(env.DB, workspaceId);

      const resUndo = await executeLedgerCommand(
        env.DB,
        makeContext('act_commit_undo_1', rev),
        'undo_commit',
        {
          action_id: actCreateId,
          mode: 'from_here',
          client_operation_id: 'op_undo_test_1',
          expected_revision: rev,
        },
        (ctx, state, seq, args) => handleUndoCommit(ctx, allEvents, allActions, state, seq, args),
      );
      expect(resUndo.status).toBe('applied');
      rev++;

      // 5. CRITICAL VERIFICATION: Prove rows are DELETED from D1 tables!
      const entAfter = await env.DB
        .prepare(`SELECT * FROM entities WHERE id = ?`)
        .bind(targetEntityId)
        .first();
      expect(entAfter).toBeNull();

      const taskAfter = await env.DB
        .prepare(`SELECT * FROM tasks WHERE id = ?`)
        .bind(targetTaskId)
        .first();
      expect(taskAfter).toBeNull();

      const fieldAfter = await env.DB
        .prepare(`SELECT * FROM entity_state WHERE entity_id = ? AND field_name = 'preferred_language'`)
        .bind(targetEntityId)
        .first();
      expect(fieldAfter).toBeNull();

      // 6. Prove D1 matches pure replay exactly!
      const eventsAfterUndo = await getWorkspaceEvents(env.DB, workspaceId);
      const replayAfterUndo = rebuildProjections(eventsAfterUndo);
      expect(replayAfterUndo.entities.has(targetEntityId)).toBe(false);
      expect(replayAfterUndo.tasks.has(targetTaskId)).toBe(false);
      expect(replayAfterUndo.fields.has(`${targetEntityId}:preferred_language`)).toBe(false);

      // 7. FINDING 5 VERIFICATION: Repeated undo targeting the same action returns already_applied
      const eventsCountBeforeSecondUndo = eventsAfterUndo.length;
      const wsRevBeforeSecondUndo = rev;

      const actionsAfterUndo = await getWorkspaceActions(env.DB, workspaceId);
      const resRepeatUndo = await executeLedgerCommand(
        env.DB,
        makeContext('act_commit_undo_repeated_new_id', rev),
        'undo_commit',
        {
          action_id: actCreateId,
          mode: 'from_here',
          client_operation_id: 'op_undo_repeat_test',
          expected_revision: rev,
        },
        (ctx, state, seq, args) => handleUndoCommit(ctx, eventsAfterUndo, actionsAfterUndo, state, seq, args),
      );

      expect(resRepeatUndo.status).toBe('already_applied');

      // Verify NO new events committed and NO revision increment
      const eventsAfterRepeat = await getWorkspaceEvents(env.DB, workspaceId);
      expect(eventsAfterRepeat.length).toBe(eventsCountBeforeSecondUndo);

      const wsAfterRepeat = await getWorkspaceRevision(env.DB, workspaceId);
      expect(wsAfterRepeat!.business_revision).toBe(wsRevBeforeSecondUndo);
    });

    it('enforces execution lease, active run status, and trigger source matching in guard', async () => {
      const currentWs = await getWorkspaceRevision(env.DB, workspaceId);
      let rev = currentWs!.business_revision;

      // 1. Non-existent run_id
      const ctxBogusRun: LedgerCommandContext = {
        ...makeContext('act_bogus_run', rev),
        run_id: 'run-does-not-exist',
      };
      const resBogusRun = await executeLedgerCommand(
        env.DB,
        ctxBogusRun,
        'create_entity',
        { name: 'Bogus Run Entity' },
        handleCreateEntity,
      );
      expect(resBogusRun.status).toBe('conflict');
      expect(resBogusRun.error?.code).toBe('run_conflict');

      // 2. Inactive / cancelled run
      await env.DB.prepare(
        `INSERT INTO agent_runs (id, workspace_id, chat_id, source_message_id, executor_kind, status, lease_fence, created_at, updated_at)
         VALUES ('run-cancelled-1', ?, 'chat_ledger_1', 'msg_valid_1', 'agent', 'cancelled', 1, ?, ?)`
      ).bind(workspaceId, now, now).run();

      const ctxCancelledRun: LedgerCommandContext = {
        ...makeContext('act_cancelled_run', rev),
        run_id: 'run-cancelled-1',
      };
      const resCancelledRun = await executeLedgerCommand(
        env.DB,
        ctxCancelledRun,
        'create_entity',
        { name: 'Cancelled Run Entity' },
        handleCreateEntity,
      );
      expect(resCancelledRun.status).toBe('conflict');
      expect(resCancelledRun.error?.code).toBe('run_inactive');

      // 3. Trigger source mismatch (run-ledger-test-1 has source_message_id = msg_valid_1)
      const ctxSourceMismatch: LedgerCommandContext = {
        ...makeContext('act_source_mismatch', rev),
        actor: { kind: 'member', user_id: hunorUserId },
        source_message_id: 'msg_hunor_1', // doesn't match run-ledger-test-1's trigger!
        run_id: 'run-ledger-test-1',
      };
      const resSourceMismatch = await executeLedgerCommand(
        env.DB,
        ctxSourceMismatch,
        'create_entity',
        { name: 'Source Mismatch Entity' },
        handleCreateEntity,
      );
      expect(resSourceMismatch.status).toBe('conflict');
      expect(resSourceMismatch.error?.code).toBe('run_source_mismatch');

      // 4. Expired lease fence: earlier today (same date, earlier minutes)
      try {
        const earlierToday = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        await env.DB.prepare(
          `UPDATE workspaces SET lease_expires_at = ? WHERE id = ?`
        ).bind(earlierToday, workspaceId).run();

        const ctxExpiredLease: LedgerCommandContext = {
          ...makeContext('act_expired_lease_today', rev),
          fence: 1,
        };
        const resExpired = await executeLedgerCommand(
          env.DB,
          ctxExpiredLease,
          'create_entity',
          { name: 'Expired Lease Entity' },
          handleCreateEntity,
        );
        expect(resExpired.status).toBe('conflict');
        expect(resExpired.error?.code).toBe('fence_conflict');

        // 5. Valid lease fence: later today (same date, future minutes)
        const laterToday = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        await env.DB.prepare(
          `UPDATE workspaces SET lease_expires_at = ? WHERE id = ?`
        ).bind(laterToday, workspaceId).run();

        const ctxValidLease: LedgerCommandContext = {
          ...makeContext('act_valid_lease_today', rev),
          fence: 1,
        };
        const resValid = await executeLedgerCommand(
          env.DB,
          ctxValidLease,
          'create_entity',
          { name: 'Valid Lease Entity Today' },
          handleCreateEntity,
        );
        expect(resValid.status).toBe('applied');
        rev++;
      } finally {
        // Restore a live seed lease for subsequent tests (fenced run-scoped
        // writes require a present, unexpired lease).
        await env.DB.prepare(
          `UPDATE workspaces SET lease_owner = 'att_ledger_seed', lease_attempt_id = 'att_ledger_seed', lease_fence = 1, lease_expires_at = ? WHERE id = ?`
        ).bind(new Date(Date.now() + 60 * 60 * 1000).toISOString(), workspaceId).run();
      }
    });

    it('durably persists needs_clarification receipt, pending clarification with operation payload, and resumes after actor restart', async () => {
      const currentWs = await getWorkspaceRevision(env.DB, workspaceId);
      const rev = currentWs!.business_revision;

      const actClarId = 'act_clar_durable_test';
      const resClar = await executeLedgerCommand(
        env.DB,
        makeContext(actClarId, rev),
        'create_task',
        { title: 'Send Bistro the contract' }, // missing deadline!
        handleCreateTask,
      );

      // Verify response
      expect(resClar.status).toBe('needs_clarification');
      expect(resClar.clarification?.prompt).toContain('due');
      expect(resClar.clarification?.pending_operation).toBeDefined();
      expect(resClar.clarification?.pending_operation?.command_name).toBe('create_task');
      expect(resClar.clarification?.pending_operation?.args.title).toBe('Send Bistro the contract');

      // Verify action_receipts in D1
      const receipt = await env.DB
        .prepare(`SELECT * FROM action_receipts WHERE action_id = ?`)
        .bind(actClarId)
        .first<Record<string, unknown>>();
      expect(receipt).not.toBeNull();
      expect(receipt!['result_status']).toBe('needs_clarification');
      expect(String(receipt!['result_json'])).toContain('needs_clarification');
      expect(String(receipt!['result_json'])).toContain('Send Bistro the contract');

      // Verify pending_clarifications in D1 retains typed, versioned operation payload
      const pending = await env.DB
        .prepare(`SELECT * FROM pending_clarifications WHERE run_id = 'run-ledger-test-1' AND status = 'pending'`)
        .first<Record<string, unknown>>();
      expect(pending).not.toBeNull();
      expect(pending!['intended_operation']).toBe('create_task');
      expect(pending!['source_revision']).toBe(rev);
      expect(String(pending!['missing_fields'])).toContain('due');
      expect(pending!['operation_payload_json']).toBeDefined();

      const pendingOp = JSON.parse(String(pending!['operation_payload_json']));
      expect(pendingOp.version).toBe(1);
      expect(pendingOp.command_name).toBe('create_task');
      expect(pendingOp.args.title).toBe('Send Bistro the contract');

      // Verify agent_runs is now waiting_for_input
      const run = await env.DB
        .prepare(`SELECT status FROM agent_runs WHERE id = 'run-ledger-test-1'`)
        .first<Record<string, unknown>>();
      expect(run!['status']).toBe('waiting_for_input');

      // Verify run_activity recorded clarification_required with pending_operation
      const activity = await env.DB
        .prepare(`SELECT * FROM run_activity WHERE run_id = 'run-ledger-test-1' AND type = 'clarification_required'`)
        .first<Record<string, unknown>>();
      expect(activity).not.toBeNull();
      expect(String(activity!['payload_json'])).toContain('Send Bistro the contract');

      // Verify retry returns cached receipt
      const resRetry = await executeLedgerCommand(
        env.DB,
        makeContext(actClarId, rev),
        'create_task',
        { title: 'Send Bistro the contract' },
        handleCreateTask,
      );
      expect(resRetry.status).toBe('needs_clarification');
      expect(resRetry.action_id).toBe(actClarId);

      // --- WAITING RUNS RESTRICTED FROM ORDINARY WRITES ---
      // An ordinary command attempting to execute in run-ledger-test-1 while it is waiting_for_input MUST be rejected
      const ordinaryWhileWaiting = await executeLedgerCommand(
        env.DB,
        makeContext('act_ordinary_while_waiting', rev),
        'create_entity',
        { name: 'Late Tool Call Entity' },
        handleCreateEntity,
      );
      expect(ordinaryWhileWaiting.status).toBe('conflict');
      expect(ordinaryWhileWaiting.error?.code).toBe('run_inactive');

      // --- RESUMPTION AFTER ACTOR RESTART ---
      // Simulate actor restart: fresh execution context, no in-memory state, current workspace revision
      const clarId = String(pending!['id']);
      const wsAfterClar = await getWorkspaceRevision(env.DB, workspaceId);
      const resumeRev = wsAfterClar!.business_revision;

      // Seed a distinct answer message in messages_in from Avi
      const answerMsgId = 'msg_bistro_answer_1';
      await env.DB.prepare(
        `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
         VALUES (?, ?, ?, 'web', 'web_answer_1', 'fp_ans1', 'processed', ?, ?)`
      ).bind(answerMsgId, workspaceId, aviUserId, now, now).run();

      const resumeCtx: LedgerCommandContext = {
        ...makeContext('act_resume_bistro_task', resumeRev),
        source_message_id: answerMsgId,
      };

      // 1. Resuming with an unsolicited field (e.g. attempting to override title) MUST be rejected
      const rejectUnsolicited = await resumePendingClarification(
        env.DB,
        resumeCtx,
        {
          clarification_id: clarId,
          resolved_fields: {
            due: { kind: 'date', local_date: '2026-10-15' },
            title: 'Hacked Title Overwrite',
          },
        },
      );
      expect(rejectUnsolicited.status).toBe('rejected');
      expect(rejectUnsolicited.error?.code).toBe('unsolicited_field');

      // 2. Resuming without the required 'due' field MUST be rejected
      const rejectMissingField = await resumePendingClarification(
        env.DB,
        resumeCtx,
        {
          clarification_id: clarId,
          resolved_fields: {},
        },
      );
      expect(rejectMissingField.status).toBe('rejected');
      expect(rejectMissingField.error?.code).toBe('missing_required_field');

      // 3. Resuming without a source_message_id attributing the answer MUST be rejected
      const rejectNoSourceMsg = await resumePendingClarification(
        env.DB,
        { ...resumeCtx, source_message_id: undefined },
        {
          clarification_id: clarId,
          resolved_fields: { due: { kind: 'date', local_date: '2026-10-15' } },
        },
      );
      expect(rejectNoSourceMsg.status).toBe('rejected');
      expect(rejectNoSourceMsg.error?.code).toBe('missing_source_message');

      // 4. Valid resumption: strictly bounded missing field provided, attributed to answer message
      const resumeRes = await resumePendingClarification(
        env.DB,
        resumeCtx,
        {
          clarification_id: clarId,
          resolved_fields: { due: { kind: 'date', local_date: '2026-10-15' } },
          resolution_response: 'Due October 15, 2026',
        },
      );

      expect(resumeRes.status).toBe('applied');
      const taskId = (resumeRes.data as { task_id: string }).task_id;
      expect(taskId).toBeDefined();

      // Verify task in D1 has BOTH original title AND resolved due date
      const dbTask = await env.DB
        .prepare(`SELECT * FROM tasks WHERE id = ?`)
        .bind(taskId)
        .first<Record<string, unknown>>();
      expect(dbTask).not.toBeNull();
      expect(dbTask!['title']).toBe('Send Bistro the contract');
      expect(dbTask!['due_local_date']).toBe('2026-10-15');
      expect(dbTask!['due_kind']).toBe('date');

      // Verify the committed event is attributed to the answer message
      const events = await getWorkspaceEvents(env.DB, workspaceId);
      const taskEvent = events.find((e) => e.action_id === 'act_resume_bistro_task');
      expect(taskEvent).toBeDefined();
      expect(taskEvent!.source_message_id).toBe(answerMsgId);

      // Verify pending_clarifications is marked 'resolved' with resolution details
      const resolvedClar = await env.DB
        .prepare(`SELECT status, resolution_response, resolved_at FROM pending_clarifications WHERE id = ?`)
        .bind(clarId)
        .first<Record<string, unknown>>();
      expect(resolvedClar!['status']).toBe('resolved');
      expect(resolvedClar!['resolution_response']).toBe('Due October 15, 2026');
      expect(resolvedClar!['resolved_at']).not.toBeNull();

      // Verify agent_runs was transitioned out of waiting_for_input to queued
      const resumedRun = await env.DB
        .prepare(`SELECT status FROM agent_runs WHERE id = 'run-ledger-test-1'`)
        .first<Record<string, unknown>>();
      expect(resumedRun!['status']).toBe('queued');

      // Reset run status back to running for other tests
      await env.DB.prepare(
        `UPDATE agent_runs SET status = 'running' WHERE id = 'run-ledger-test-1'`
      ).run();
    });

    it('rejects duplicate clarification resolution when two competing answers race concurrently', async () => {
      const currentWs = await getWorkspaceRevision(env.DB, workspaceId);
      const rev = currentWs!.business_revision;

      // 1. Create a task missing deadline to produce a pending clarification
      const actClarId = 'act_clar_competing_test';
      const resClar = await executeLedgerCommand(
        env.DB,
        makeContext(actClarId, rev),
        'create_task',
        { title: 'Sign insurance policy' },
        handleCreateTask,
      );
      expect(resClar.status).toBe('needs_clarification');

      const clarRow = await env.DB
        .prepare(`SELECT id FROM pending_clarifications WHERE run_id = 'run-ledger-test-1' AND status = 'pending' ORDER BY created_at DESC LIMIT 1`)
        .first<Record<string, unknown>>();
      expect(clarRow).not.toBeNull();
      const clarId = String(clarRow!['id']);

      // 2. Seed two distinct answer messages in messages_in from Avi and Hunor
      const ansMsgAvi = 'msg_ans_avi_competing';
      const ansMsgHunor = 'msg_ans_hunor_competing';
      await env.DB.prepare(
        `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
         VALUES (?, ?, ?, 'web', 'ext_avi_comp', 'fp_ac', 'processed', ?, ?)`
      ).bind(ansMsgAvi, workspaceId, aviUserId, now, now).run();

      await env.DB.prepare(
        `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
         VALUES (?, ?, ?, 'web', 'ext_hunor_comp', 'fp_hc', 'processed', ?, ?)`
      ).bind(ansMsgHunor, workspaceId, hunorUserId, now, now).run();

      // 3. Prepare two competing resumption contexts sharing the exact same business revision snapshot
      const wsSnapshot = await getWorkspaceRevision(env.DB, workspaceId);
      const snapshotRev = wsSnapshot!.business_revision;

      const ctxAvi: LedgerCommandContext = {
        ...makeContext('act_resume_comp_avi', snapshotRev),
        actor: { kind: 'member', user_id: aviUserId },
        source_message_id: ansMsgAvi,
      };

      const ctxHunor: LedgerCommandContext = {
        ...makeContext('act_resume_comp_hunor', snapshotRev),
        actor: { kind: 'member', user_id: hunorUserId },
        source_message_id: ansMsgHunor,
      };

      // 4. Dispatch two competing answers concurrently
      const [resAvi, resHunor] = await Promise.all([
        resumePendingClarification(
          env.DB,
          ctxAvi,
          {
            clarification_id: clarId,
            resolved_fields: { due: { kind: 'date', local_date: '2026-10-20' } },
            resolution_response: 'Due October 20',
          },
        ),
        resumePendingClarification(
          env.DB,
          ctxHunor,
          {
            clarification_id: clarId,
            resolved_fields: { due: { kind: 'date', local_date: '2026-10-25' } },
            resolution_response: 'Due October 25',
          },
        ),
      ]);

      // Exactly ONE must succeed (applied), and the other must be rejected/conflict (already_resolved)
      const statuses = [resAvi.status, resHunor.status];
      expect(statuses).toContain('applied');
      expect(statuses).toContain('conflict');

      const failedRes = resAvi.status === 'conflict' ? resAvi : resHunor;
      expect(['already_resolved', 'revision_conflict', 'run_not_waiting', 'guard_conflict']).toContain(failedRes.error?.code);

      // Verify the clarification is resolved in D1
      const clarDb = await env.DB
        .prepare(`SELECT status FROM pending_clarifications WHERE id = ?`)
        .bind(clarId)
        .first<Record<string, unknown>>();
      expect(clarDb!['status']).toBe('resolved');

      // Verify only ONE task was created for "Sign insurance policy"
      const taskRows = await env.DB
        .prepare(`SELECT id, title FROM tasks WHERE title = 'Sign insurance policy'`)
        .all<Record<string, unknown>>();
      expect(taskRows.results.length).toBe(1);

      // 5. Subsequent attempt to resume the now-resolved clarification with latest revision returns already_resolved
      const wsAfterComp = await getWorkspaceRevision(env.DB, workspaceId);
      const resSubsequent = await resumePendingClarification(
        env.DB,
        {
          ...makeContext('act_resume_subsequent', wsAfterComp!.business_revision),
          actor: { kind: 'member', user_id: hunorUserId },
          source_message_id: ansMsgHunor,
        },
        {
          clarification_id: clarId,
          resolved_fields: { due: { kind: 'date', local_date: '2026-10-30' } },
        },
      );
      expect(resSubsequent.status).toBe('conflict');
      expect(resSubsequent.error?.code).toBe('already_resolved');

      // Reset run status back to running for subsequent tests
      await env.DB.prepare(
        `UPDATE agent_runs SET status = 'running' WHERE id = 'run-ledger-test-1'`
      ).run();
    });

    it('validates system jobs and assigns correct channel attribution for Telegram messages', async () => {
      const currentWs = await getWorkspaceRevision(env.DB, workspaceId);
      let rev = currentWs!.business_revision;

      // 1. Seed an active system job
      await env.DB.prepare(
        `INSERT INTO system_jobs (id, workspace_id, job_kind, status, scheduled_at, created_at, updated_at)
         VALUES ('job_brief_active_1', ?, 'scheduled_daily_brief', 'running', ?, ?, ?)`
      ).bind(workspaceId, now, now, now).run();

      const ctxSystem: LedgerCommandContext = {
        workspace_id: workspaceId,
        actor: { kind: 'system', system_job: 'scheduled_daily_brief' },
        membership_revision: 1,
        source_job_id: 'job_brief_active_1',
        request_id: 'req_system_brief_1',
        action_id: 'act_system_brief_1',
        expected_business_revision: rev,
      };

      const resSystem = await executeLedgerCommand(
        env.DB,
        ctxSystem,
        'create_entity',
        { name: 'System Generated Entity' },
        handleCreateEntity,
      );
      expect(resSystem.status).toBe('applied');
      rev++;

      // Verify event in D1 has channel = 'system' and actor_job_id set
      const systemEvent = await env.DB
        .prepare(`SELECT * FROM events WHERE action_id = 'act_system_brief_1'`)
        .first<Record<string, unknown>>();
      expect(systemEvent!['actor_kind']).toBe('system');
      expect(systemEvent!['actor_job_id']).toBe('scheduled_daily_brief');
      expect(systemEvent!['channel']).toBe('system');
      expect(systemEvent!['source_job_id']).toBe('job_brief_active_1');

      // Negative check: System write with inactive job fails guard
      await env.DB.prepare(
        `INSERT INTO system_jobs (id, workspace_id, job_kind, status, scheduled_at, created_at, updated_at)
         VALUES ('job_brief_done_1', ?, 'scheduled_daily_brief', 'succeeded', ?, ?, ?)`
      ).bind(workspaceId, now, now, now).run();

      const ctxInactiveJob: LedgerCommandContext = {
        ...ctxSystem,
        action_id: 'act_system_inactive_job',
        source_job_id: 'job_brief_done_1',
        expected_business_revision: rev,
      };

      const resInactiveJob = await executeLedgerCommand(
        env.DB,
        ctxInactiveJob,
        'create_entity',
        { name: 'Rogue System Entity' },
        handleCreateEntity,
      );
      expect(resInactiveJob.status).toBe('conflict');
      expect(resInactiveJob.error?.code).toBe('job_inactive');

      // 2. Telegram message channel attribution
      await env.DB.prepare(
        `INSERT INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
         VALUES ('msg_tg_source_1', ?, ?, 'telegram', 'tg_msg_external_1', 'fp_tg_1', 'processed', ?, ?)`
      ).bind(workspaceId, aviUserId, now, now).run();

      const ctxTelegram: LedgerCommandContext = {
        ...makeContext('act_tg_channel_test', rev),
        source_message_id: 'msg_tg_source_1',
        source_channel: 'telegram',
        run_id: undefined,
      };

      const resTelegram = await executeLedgerCommand(
        env.DB,
        ctxTelegram,
        'create_entity',
        { name: 'Telegram Lead Entity' },
        handleCreateEntity,
      );
      expect(resTelegram.status).toBe('applied');
      rev++;

      // Verify event in D1 has channel = 'telegram'
      const tgEvent = await env.DB
        .prepare(`SELECT * FROM events WHERE action_id = 'act_tg_channel_test'`)
        .first<Record<string, unknown>>();
      expect(tgEvent!['channel']).toBe('telegram');
      expect(tgEvent!['source_message_id']).toBe('msg_tg_source_1');
    });

    it('enforces append-only immutability triggers on events and action receipts', async () => {
      // 1. Attempt to delete an event -> trigger must abort
      const anyEvent = await env.DB.prepare(`SELECT id FROM events LIMIT 1`).first<Record<string, unknown>>();
      expect(anyEvent).not.toBeNull();

      await expect(
        env.DB.prepare(`DELETE FROM events WHERE id = ?`).bind(anyEvent!['id']).run(),
      ).rejects.toThrow(/events are append-only/);

      // 2. Attempt to update an event -> trigger must abort
      await expect(
        env.DB.prepare(`UPDATE events SET kind = 'note' WHERE id = ?`).bind(anyEvent!['id']).run(),
      ).rejects.toThrow(/events are immutable/);

      // 3. Attempt to delete an action receipt -> trigger must abort
      const anyReceipt = await env.DB.prepare(`SELECT id FROM action_receipts LIMIT 1`).first<Record<string, unknown>>();
      expect(anyReceipt).not.toBeNull();

      await expect(
        env.DB.prepare(`DELETE FROM action_receipts WHERE id = ?`).bind(anyReceipt!['id']).run(),
      ).rejects.toThrow(/action_receipts are append-only/);
    });

    it('rejects concurrent write when two writers race from the exact same revision snapshot', async () => {
      const currentWs = await getWorkspaceRevision(env.DB, workspaceId);
      const rev = currentWs!.business_revision;

      // Both writers start with the exact same expected business revision
      const promiseA = executeLedgerCommand(
        env.DB,
        makeContext('act_racing_writer_A', rev),
        'create_task',
        { title: 'Concurrent Task A', due: { kind: 'instant', at: '2026-10-20T10:00:00Z', timezone: 'UTC' } },
        handleCreateTask,
      );

      const promiseB = executeLedgerCommand(
        env.DB,
        makeContext('act_racing_writer_B', rev),
        'create_task',
        { title: 'Concurrent Task B', due: { kind: 'instant', at: '2026-10-20T11:00:00Z', timezone: 'UTC' } },
        handleCreateTask,
      );

      const [resA, resB] = await Promise.all([promiseA, promiseB]);

      // Exactly one must succeed, and the other must fail with revision conflict
      const statuses = [resA.status, resB.status];
      expect(statuses).toContain('applied');
      expect(statuses).toContain('conflict');

      const failedRes = resA.status === 'conflict' ? resA : resB;
      expect(failedRes.error?.code).toBe('revision_conflict');
    });

    it('executes conflict resolution in real D1: validates disputed state & candidates, restores clear state', async () => {
      const currentWs = await getWorkspaceRevision(env.DB, workspaceId);
      let rev = currentWs!.business_revision;

      // 1. Create an entity
      const resEnt = await executeLedgerCommand(
        env.DB,
        makeContext('act_dispute_ent_1', rev),
        'create_entity',
        { name: 'Disputed Bistro' },
        handleCreateEntity,
      );
      expect(resEnt.status).toBe('applied');
      const entityId = (resEnt.data as { entity_id: string }).entity_id;
      rev++;

      // 2. Teammate A reports quote
      const resQ1 = await executeLedgerCommand(
        env.DB,
        makeContext('act_dispute_q1', rev),
        'log_event',
        { entity_id: entityId, kind: 'quote', payload: { amount: 500000, currency: 'EUR', role: 'offered' } },
        handleLogEvent,
      );
      expect(resQ1.status).toBe('applied');
      const q1EventId = resQ1.event_ids![0]!;
      rev++;

      // 3. Teammate B reports competing quote -> creates dispute
      const resQ2 = await executeLedgerCommand(
        env.DB,
        makeContext('act_dispute_q2', rev),
        'log_event',
        { entity_id: entityId, kind: 'quote', payload: { amount: 600000, currency: 'EUR', role: 'offered' } },
        handleLogEvent,
      );
      expect(resQ2.status).toBe('applied');
      const q2EventId = resQ2.event_ids![0]!;
      rev++;

      // Verify D1 entity_state has quote in disputed state
      const dbDisputed = await env.DB
        .prepare(`SELECT state, value_text, candidate_event_ids_json FROM entity_state WHERE entity_id = ? AND field_name = 'quote'`)
        .bind(entityId)
        .first<Record<string, unknown>>();
      expect(dbDisputed!['state']).toBe('disputed');
      expect(dbDisputed!['value_text']).toBeNull();
      const candIds = JSON.parse(String(dbDisputed!['candidate_event_ids_json']));
      expect(candIds).toContain(q1EventId);
      expect(candIds).toContain(q2EventId);

      // 4. Set a clear field ('phone') and attempt resolution on it -> rejected (field_not_disputed)
      const resPhone = await executeLedgerCommand(
        env.DB,
        makeContext('act_dispute_phone', rev),
        'set_field',
        { entity_id: entityId, field_name: 'phone', value: '+33123456789' },
        handleSetField,
      );
      expect(resPhone.status).toBe('applied');
      rev++;

      const resNotDisputed = await executeLedgerCommand(
        env.DB,
        makeContext('act_resolve_bad_field', rev),
        'resolve_conflict',
        {
          entity_id: entityId,
          field_name: 'phone',
          resolved_value: '+33987654321',
          candidate_event_ids: [q1EventId, q2EventId],
        },
        handleResolveConflict,
      );
      expect(resNotDisputed.status).toBe('rejected');
      expect(resNotDisputed.error?.code).toBe('field_not_disputed');

      // 5. Attempt resolution with wrong candidate IDs -> rejected (candidate_mismatch)
      const resWrongCand = await executeLedgerCommand(
        env.DB,
        makeContext('act_resolve_bad_cand', rev),
        'resolve_conflict',
        {
          entity_id: entityId,
          field_name: 'quote',
          resolved_value: { amount: 600000, currency: 'EUR', role: 'offered' },
          candidate_event_ids: [q1EventId, 'ev_nonexistent'],
        },
        handleResolveConflict,
      );
      expect(resWrongCand.status).toBe('rejected');
      expect(resWrongCand.error?.code).toBe('candidate_mismatch');

      // 6. Valid resolution with exact matching candidate IDs -> applied
      const resResolved = await executeLedgerCommand(
        env.DB,
        makeContext('act_resolve_valid', rev),
        'resolve_conflict',
        {
          entity_id: entityId,
          field_name: 'quote',
          resolved_value: { amount: 600000, currency: 'EUR', role: 'offered' },
          candidate_event_ids: [q1EventId, q2EventId],
          rationale: 'Manager agreed on 6000 EUR',
        },
        handleResolveConflict,
      );
      expect(resResolved.status).toBe('applied');

      // Verify D1 entity_state has quote back in clear state with resolved value
      const dbResolved = await env.DB
        .prepare(`SELECT state, value_json, candidate_event_ids_json FROM entity_state WHERE entity_id = ? AND field_name = 'quote'`)
        .bind(entityId)
        .first<Record<string, unknown>>();
      expect(dbResolved!['state']).toBe('clear');
      expect(dbResolved!['candidate_event_ids_json']).toBeNull();
      expect(String(dbResolved!['value_json'])).toContain('600000');
    });
  });
});

