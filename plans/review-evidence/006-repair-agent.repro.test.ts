/* eslint-disable @typescript-eslint/no-explicit-any -- Review-only capture probes, not production contracts. */
// These assertions reproduce current defects. Passing means the defect exists;
// turn them into desired-behavior regression tests in the owning app/package suites.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
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
// @ts-expect-error vite raw import
import migration0009Sql from '../../migrations/0009_thinking_controls.sql?raw';

import { AgentHandler } from '../../apps/worker/src/agent/handler.js';
import {
  dispatchOutboxItem,
  resumeRun,
  type LoadedRun,
} from '../../apps/worker/src/actor/dispatch.js';
import { acceptWebMessage, createChat } from '../../apps/worker/src/inbox/repository.js';
import { FakeProviderAdapter } from '../../packages/agent/src/index.js';

describe('Worker Agent Loop, Recovery & Clarification Integration (006B workerd)', () => {
  const ws = 'ws-agent-loop-test';
  const aviId = 'usr_avi_loop';
  const hunorId = 'usr_hunor_loop';
  let chatAvi: string;
  let _chatHunor: string;
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

  async function _loadRunById(runId: string): Promise<LoadedRun> {
    const row = await env.DB.prepare(
      `SELECT id, workspace_id, chat_id, source_message_id, source_job_id, status, attempt_id, lease_fence
       FROM agent_runs WHERE id = ?`,
    )
      .bind(runId)
      .first<Record<string, unknown>>();
    if (!row) throw new Error(`run ${runId} missing`);
    return {
      id: String(row['id']),
      workspace_id: String(row['workspace_id']),
      chat_id: String(row['chat_id']),
      source_message_id: row['source_message_id'] ? String(row['source_message_id']) : null,
      source_job_id: row['source_job_id'] ? String(row['source_job_id']) : null,
      status: String(row['status']),
      attempt_id: row['attempt_id'] ? String(row['attempt_id']) : null,
      lease_fence: Number(row['lease_fence'] ?? 0),
    };
  }

  async function outboxIdForRun(runId: string): Promise<string> {
    const row = await env.DB.prepare(
      `SELECT id FROM outbox WHERE json_extract(payload_json, '$.run_id') = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(runId)
      .first<{ id: string }>();
    if (!row) throw new Error(`outbox for run ${runId} missing`);
    return row.id;
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
      migration0009Sql,
    ]) {
      for (const stmt of splitSqlStatements(sql)) {
        await env.DB.prepare(stmt).run();
      }
    }

    // Seed test users
    for (const [id, email, name] of [
      [aviId, 'avi.loop@kerning.test', 'Avi Loop'],
      [hunorId, 'hunor.loop@kerning.test', 'Hunor Loop'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(id, `fb_${id}`, email, name, nowIso, nowIso)
        .run();
    }

    // Seed test workspace
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
       VALUES (?, 'Kerning Agent WS', ?, 0, 1, ?, ?)`
    )
      .bind(ws, aviId, nowIso, nowIso)
      .run();

    for (const [user, role] of [
      [aviId, 'owner'],
      [hunorId, 'member'],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(ws, user, role, nowIso, nowIso, nowIso)
        .run();
    }

    chatAvi = (await createChat(env.DB, { workspaceId: ws, authorUserId: aviId, title: 'Avi Loop Chat' })).id;
    _chatHunor = (await createChat(env.DB, { workspaceId: ws, authorUserId: hunorId, title: 'Hunor Loop Chat' })).id;
  });

  beforeEach(async () => { await env.DB.prepare('UPDATE workspaces SET lease_owner=NULL, lease_attempt_id=NULL, lease_expires_at=NULL WHERE id=?').bind(ws).run(); });

  it('REPRO repair: actual Gemini request duplicates the same completed tool result',async()=>{
    const {GeminiInteractionsAdapter}=await import('../../packages/agent/src/providers/gemini.js');
    const {PRODUCTION_REGISTRY}=await import('../../packages/agent/src/index.js');
    const accepted=await acceptWebMessage(env.DB,{workspaceId:ws,chatId:chatAvi,userId:aviId,clientMessageId:'repair-wire-history',text:'Save Alder Florist'});
    const fake=new FakeProviderAdapter({scripts:[{kind:'tool_calls',calls:[{callId:'wire1',name:'upsert_entity',args:{name:'Alder Florist'}}]},{kind:'text',text:'Saved'}]});
    const captured:any[]=[];
    const capture={provider:fake.provider,audioSupport:()=>fake.audioSupport(),async *streamTurn(input:any){captured.push(input);yield* fake.streamTurn(input);}};
    const result=await dispatchOutboxItem(env.DB,await outboxIdForRun(accepted.run_id),ws,{handler:new AgentHandler({providerAdapter:capture})});
    expect(result.status).toBe('completed');
    let wireBody:any;
    const adapter=new GeminiInteractionsAdapter({apiKey:'synthetic-review-key',fetchFn:async(_url,init)=>{wireBody=JSON.parse(String(init.body));return new Response('{}',{status:400});}});
    const model=PRODUCTION_REGISTRY.entries.find(e=>e.provider==='gemini')!;
    for await (const _event of adapter.streamTurn({...captured[1],model,previousContinuation:null})) { /* capture only; no external request */ }
    expect(wireBody.input.filter((b:any)=>b.type==='function_result' && b.call_id==='wire1')).toHaveLength(2);
  });

  it('REPRO repair: configured one-action and one-round bounds do not prevent two commits',async()=>{
    const accepted=await acceptWebMessage(env.DB,{workspaceId:ws,chatId:chatAvi,userId:aviId,clientMessageId:'repair-quotas',text:'Save Magnolia Printers and Raven Accounting'});
    const adapter=new FakeProviderAdapter({scripts:[{kind:'tool_calls',calls:[{callId:'q1',name:'upsert_entity',args:{name:'Magnolia Printers'}},{callId:'q2',name:'upsert_entity',args:{name:'Raven Accounting'}}]},{kind:'text',text:'Saved'}]});
    const result=await dispatchOutboxItem(env.DB,await outboxIdForRun(accepted.run_id),ws,{handler:new AgentHandler({providerAdapter:adapter,limits:{maxDailyActions:1,maxRoundsPerRun:1}})});
    expect(result.status).toBe('completed');
    const receipts=await env.DB.prepare("SELECT COUNT(*) AS n FROM action_receipts WHERE run_id=? AND result_status='applied'").bind(accepted.run_id).first<{n:number}>();
    expect(receipts?.n).toBe(2);
    const quotas=await env.DB.prepare('SELECT COUNT(*) AS n FROM workspace_daily_actions WHERE workspace_id=?').bind(ws).first<{n:number}>();
    expect(quotas?.n).toBe(0);
  });

  it('REPRO repair: missing required budgets still starts inference',async()=>{
    const accepted=await acceptWebMessage(env.DB,{workspaceId:ws,chatId:chatAvi,userId:aviId,clientMessageId:'repair-no-config',text:'Hello'});
    const result=await dispatchOutboxItem(env.DB,await outboxIdForRun(accepted.run_id),ws,{handler:new AgentHandler({providerAdapter:new FakeProviderAdapter({scripts:[{kind:'text',text:'Hello back'}]})})});
    expect(result.status).toBe('completed');
  });

  it('REPRO repair: control clarification persists an unversioned payload that cannot resume',async()=>{
    const accepted=await acceptWebMessage(env.DB,{workspaceId:ws,chatId:chatAvi,userId:aviId,clientMessageId:'repair-control-question',text:'Please plan a call'});
    const adapter=new FakeProviderAdapter({scripts:[{kind:'tool_calls',calls:[{callId:'control1',name:'request_clarification',args:{question:'What is the deadline?',intended_operation:'create_task',missing_fields:['due'],proposed_arguments:{title:'Call orchard'}}}]}]});
    const waiting=await dispatchOutboxItem(env.DB,await outboxIdForRun(accepted.run_id),ws,{handler:new AgentHandler({providerAdapter:adapter})});
    expect(waiting.status).toBe('waiting_for_input');
    const clar=await env.DB.prepare("SELECT id,operation_payload_json FROM pending_clarifications WHERE run_id=? AND status='pending'").bind(accepted.run_id).first<{id:string,operation_payload_json:string}>();
    const operation=JSON.parse(clar!.operation_payload_json);
    expect(operation.version).toBeUndefined();
    expect(operation.command).toBe('request_clarification');
    const answer=await acceptWebMessage(env.DB,{workspaceId:ws,chatId:chatAvi,userId:aviId,clientMessageId:'repair-control-answer',text:'No deadline needed.'});
    const source=await env.DB.prepare('SELECT source_message_id FROM agent_runs WHERE id=?').bind(answer.run_id).first<{source_message_id:string}>();
    const resumed=await resumeRun(env.DB,{workspaceId:ws,runId:accepted.run_id,answer:{messageId:source!.source_message_id,authorUserId:aviId,text:'No deadline needed.',clarificationId:clar!.id,resolvedFields:{due:null}}});
    expect(resumed.resumed).toBe(false);
  });

  it('REPRO repair: confirmed bulk proposal is discarded and asks the same question again',async()=>{
    const names=['Quartz Bakery','Violet Printing','Raven Locksmith','Maple Tailoring'];
    const script={kind:'tool_calls' as const,calls:names.map((name,i)=>({callId:`b${i}`,name:'upsert_entity',args:{name}}))};
    const accepted=await acceptWebMessage(env.DB,{workspaceId:ws,chatId:chatAvi,userId:aviId,clientMessageId:'repair-bulk-source',text:'Save these four businesses'});
    const waiting=await dispatchOutboxItem(env.DB,await outboxIdForRun(accepted.run_id),ws,{handler:new AgentHandler({providerAdapter:new FakeProviderAdapter({scripts:[script]})})});
    expect(waiting.status).toBe('waiting_for_input');
    const clar=await env.DB.prepare("SELECT id,operation_payload_json FROM pending_clarifications WHERE run_id=? AND status='pending'").bind(accepted.run_id).first<{id:string,operation_payload_json:string|null}>();
    expect(clar?.operation_payload_json).toBeNull();
    const answer=await acceptWebMessage(env.DB,{workspaceId:ws,chatId:chatAvi,userId:aviId,clientMessageId:'repair-bulk-answer',text:'Yes, save those exact four.'});
    const source=await env.DB.prepare('SELECT source_message_id FROM agent_runs WHERE id=?').bind(answer.run_id).first<{source_message_id:string}>();
    const resumed=await resumeRun(env.DB,{workspaceId:ws,runId:accepted.run_id,answer:{messageId:source!.source_message_id,authorUserId:aviId,text:'Yes, save those exact four.',clarificationId:clar!.id}});
    expect(resumed.resumed).toBe(true);
    const result=await dispatchOutboxItem(env.DB,await outboxIdForRun(accepted.run_id),ws,{handler:new AgentHandler({providerAdapter:new FakeProviderAdapter({scripts:[script]})})});
    expect(result.status).toBe('waiting_for_input');
    const receipts=await env.DB.prepare("SELECT COUNT(*) AS n FROM action_receipts WHERE run_id=? AND result_status='applied'").bind(accepted.run_id).first<{n:number}>();
    expect(receipts?.n).toBe(0);
  });
});
