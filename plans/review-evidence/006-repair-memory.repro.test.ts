/**
 * @otis/worker/test/memory.integration.test
 * Checkpoint 006C: Bounded context retrieval, sourced memory, deterministic summaries,
 * and reconciliation in workerd real D1.
 * In accordance with plans/006-implementation-handoff.md Section 11 (006C).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
// @ts-expect-error vite raw import
import migration0001Sql from '../../migrations/0001_identity.sql?raw';
// @ts-expect-error vite raw import
import migration0002Sql from '../../migrations/0002_conversations_sources.sql?raw';
// @ts-expect-error vite raw import
import migration0003Sql from '../../migrations/0003_ledger.sql?raw';
// @ts-expect-error vite raw import
import migration0004Sql from '../../migrations/0004_lifecycle_settings.sql?raw';
// @ts-expect-error vite raw import
import migration0005Sql from '../../migrations/0005_actor_dispatch.sql?raw';
// @ts-expect-error vite raw import
import migration0006Sql from '../../migrations/0006_actor_hardening.sql?raw';
// @ts-expect-error vite raw import
import migration0007Sql from '../../migrations/0007_outbox_claim_owner.sql?raw';
// @ts-expect-error vite raw import
import migration0008Sql from '../../migrations/0008_memory_and_agent_runs.sql?raw';

// Review-only assertions deliberately reproduce defects, not acceptance behavior.
import { getTurnContext } from '../../apps/worker/src/agent/context.js';
import {
  processMemoryRefreshJobs,
  replayWorkspaceMemory,
} from '../../apps/worker/src/agent/memory.js';
import { executeAgentTool } from '../../apps/worker/src/agent/repository.js';
import { createChat } from '../../apps/worker/src/inbox/repository.js';

describe('Durable Memory, Context Retrieval & Summaries Integration (006C workerd)', () => {
  const ws1 = 'ws-mem-test-1';
  const ws2 = 'ws-mem-test-2';
  const aviId = 'usr_avi_mem';
  const hunorId = 'usr_hunor_mem';
  let chat1Ws1: string;
  let _chat2Ws1: string;
  let chatWs2: string;
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
    for (const sql of [
      migration0001Sql,
      migration0002Sql,
      migration0003Sql,
      migration0004Sql,
      migration0005Sql,
      migration0006Sql,
      migration0007Sql,
      migration0008Sql,
    ]) {
      for (const stmt of splitSqlStatements(sql)) {
        await env.DB.prepare(stmt).run();
      }
    }

    // Seed test users
    for (const [id, email, name] of [
      [aviId, 'avi.mem@kerning.test', 'Avi Mem'],
      [hunorId, 'hunor.mem@kerning.test', 'Hunor Mem'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(id, `fb_${id}`, email, name, nowIso, nowIso)
        .run();
    }

    // Seed test workspaces (WS1 and WS2)
    for (const [wsId, name] of [
      [ws1, 'Workspace One'],
      [ws2, 'Workspace Two'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
         VALUES (?, ?, ?, 0, 1, ?, ?)`
      )
        .bind(wsId, name, aviId, nowIso, nowIso)
        .run();

      for (const [user, role] of [
        [aviId, 'owner'],
        [hunorId, 'member'],
      ] as const) {
        await env.DB.prepare(
          `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
          .bind(wsId, user, role, nowIso, nowIso, nowIso)
          .run();
      }
    }

    chat1Ws1 = (await createChat(env.DB, { workspaceId: ws1, authorUserId: aviId, title: 'WS1 Chat 1' })).id;
    _chat2Ws1 = (await createChat(env.DB, { workspaceId: ws1, authorUserId: aviId, title: 'WS1 Chat 2' })).id;
    chatWs2 = (await createChat(env.DB, { workspaceId: ws2, authorUserId: aviId, title: 'WS2 Chat' })).id;

    // Seed messages_in for actors
    await env.DB.prepare(
      `INSERT INTO messages_in (id, workspace_id, chat_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
       VALUES ('msg_mem_avi', ?, ?, ?, 'web', 'ext_mem_avi', 'fp_mem_avi', 'processing', ?, ?)`
    )
      .bind(ws1, chat1Ws1, aviId, nowIso, nowIso)
      .run();

    await env.DB.prepare(
      `INSERT INTO messages_in (id, workspace_id, chat_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
       VALUES ('msg_mem_hunor', ?, ?, ?, 'web', 'ext_mem_hunor', 'fp_mem_hunor', 'processing', ?, ?)`
    )
      .bind(ws1, chat1Ws1, hunorId, nowIso, nowIso)
      .run();

    await env.DB.prepare(
      `INSERT INTO messages_in (id, workspace_id, chat_id, user_id, channel, external_id, payload_fingerprint, status, created_at, updated_at)
       VALUES ('msg_mem_ws2', ?, ?, ?, 'web', 'ext_mem_ws2', 'fp_mem_ws2', 'processing', ?, ?)`
    )
      .bind(ws2, chatWs2, aviId, nowIso, nowIso)
      .run();
  });

  it('REPRO repair: undoing forget restores status but leaves FTS inconsistent',async()=>{
    const base={db:env.DB,workspaceId:ws1,actorUserId:aviId,chatId:chat1Ws1,sourceMessageId:'msg_mem_avi'};
    const saved=await executeAgentTool({...base,actionId:'repair-note',sourceText:'Remember Wednesday contact preference',toolName:'remember_context',toolArgs:{scope:'workspace',category:'workflow_context',content:'Contact our workshop on Wednesdays.'}});
    expect(saved.status).toBe('applied');
    const memoryId=saved.affected_resource_ids![0];
    const forgotten=await executeAgentTool({...base,actionId:'repair-forget',sourceText:'Forget that note',toolName:'forget_memory',toolArgs:{memory_id:memoryId}});
    expect(forgotten.status).toBe('applied');
    const undo=await executeAgentTool({...base,actionId:'repair-unforget',sourceText:'Undo the forget',toolName:'undo',toolArgs:{action_id:'repair-forget',mode:'single'}});
    expect(undo.status).toBe('applied');
    const note=await env.DB.prepare('SELECT status FROM memory_entries WHERE id=?').bind(memoryId).first<{status:string}>();
    const suppressed=await env.DB.prepare('SELECT COUNT(*) AS n FROM memory_suppressions WHERE workspace_id=? AND target_memory_id=?').bind(ws1,memoryId).first<{n:number}>();
    const fts=await env.DB.prepare('SELECT COUNT(*) AS n FROM memory_entries_fts WHERE entry_id=?').bind(memoryId).first<{n:number}>();
    expect(note?.status).toBe('active');
    expect(suppressed?.n).toBe(0);
    expect(fts?.n).toBe(0);
    const context=await getTurnContext(env.DB,{workspaceId:ws1,actorUserId:aviId,chatId:chat1Ws1,sourceText:'Workshop Wednesdays'});
    expect(context.activeNotes.some(n=>n.id===memoryId)).toBe(true);
    await replayWorkspaceMemory(env.DB,ws1);
    const rebuilt=await env.DB.prepare('SELECT COUNT(*) AS n FROM memory_suppressions WHERE workspace_id=? AND target_memory_id=?').bind(ws1,memoryId).first<{n:number}>();
    expect(rebuilt?.n).toBe(0);
    const rebuiltFts=await env.DB.prepare('SELECT COUNT(*) AS n FROM memory_entries_fts WHERE entry_id=?').bind(memoryId).first<{n:number}>();
    expect(rebuiltFts?.n).toBe(1);
  });

  it('REPRO repair: refresh reports success without publishing any summary',async()=>{
    await env.DB.prepare("INSERT INTO memory_refresh_jobs(id,workspace_id,scope,subject_key,target_revision,state,attempts,next_attempt_at,created_at,updated_at) VALUES ('repair-publication',?,'workspace','__workspace__',0,'pending',0,?,?,?)").bind(ws1,nowIso,nowIso,nowIso).run();
    const result=await processMemoryRefreshJobs(env.DB,{workspaceId:ws1,jobId:'repair-publication'});
    expect(result.completed).toBe(1);
    const job=await env.DB.prepare('SELECT state FROM memory_refresh_jobs WHERE id=?').bind('repair-publication').first<{state:string}>();
    const summary=await env.DB.prepare("SELECT id FROM memory_summaries WHERE workspace_id=? AND scope='workspace' AND subject_key='__workspace__'").bind(ws1).first();
    expect(job?.state).toBe('completed');
    expect(summary).toBeNull();
  });
});
