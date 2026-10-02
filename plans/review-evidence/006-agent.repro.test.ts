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

  it('REPRO: negated status instruction is accepted as explicit intent', async () => {
    const {isExplicitStatusIntent}=await import('../../packages/agent/src/policy.js');
    expect(isExplicitStatusIntent('Do not mark Bistro as warm.', 'warm').isExplicit).toBe(true);
  });

  it('REPRO: documented explicit undo target is rejected as forged authority', async () => {
    const {validateUndoArgs}=await import('../../packages/agent/src/tools.js');
    const result=validateUndoArgs({action_id:'an-existing-action',mode:'from_here'});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('forbidden_key');
  });

  it('REPRO: a bounded continuation collides with the tool step index', async () => {
    const accepted = await acceptWebMessage(env.DB, {workspaceId: ws, chatId: chatAvi, userId: aviId, clientMessageId: 'review-checkpoint', text: 'Create Violet Harbor'});
    const adapter = new FakeProviderAdapter({scripts: [{kind:'tool_calls', calls:[{callId:'cp1',name:'upsert_entity',args:{name:'Violet Harbor'}}]}, {kind:'text',text:'Done'}]});
    const handler = new AgentHandler({providerAdapter: adapter, maxRoundsPerSlice: 1});
    await expect(dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, {handler})).rejects.toThrow('already planned with different arguments');
    const steps = (await env.DB.prepare('SELECT step_index, tool_name FROM run_steps WHERE run_id=? ORDER BY step_index').bind(accepted.run_id).all()).results;
    expect(steps.map(s => s['step_index'])).toEqual([0,2]);
  });

  it('REPRO: provider follow-up uses an action id and empty args instead of the original call', async () => {
    const accepted = await acceptWebMessage(env.DB, {workspaceId: ws, chatId: chatAvi, userId: aviId, clientMessageId: 'review-protocol', text: 'Create Indigo Landing'});
    const fake = new FakeProviderAdapter({scripts:[{kind:'tool_calls',calls:[{callId:'original1',name:'upsert_entity',args:{name:'Indigo Landing'}}]},{kind:'text',text:'Done'}]});
    const captured: any[] = [];
    const adapter = {provider: fake.provider, audioSupport: () => fake.audioSupport(), async *streamTurn(input: any){ captured.push(input); yield* fake.streamTurn(input); }};
    const res = await dispatchOutboxItem(env.DB, await outboxIdForRun(accepted.run_id), ws, {handler:new AgentHandler({providerAdapter:adapter})});
    expect(res.status).toBe('completed');
    const call = captured[1].messages.find((m:any) => m.role === 'assistant').toolCalls[0];
    expect(call.name).toBe(`${accepted.run_id}_r0_t0`);
    expect(call.arguments).toBe('{}');
    expect(captured[1].pendingToolResults).toEqual([]);
    expect(captured[1].previousContinuation).toBeNull();
  });

  it('REPRO: prior conversation is persisted but absent from the next provider input', async () => {
    const first = await acceptWebMessage(env.DB, {workspaceId:ws,chatId:chatAvi,userId:aviId,clientMessageId:'review-history-first',text:'The temporary reference is KERNING-482.'});
    await dispatchOutboxItem(env.DB, await outboxIdForRun(first.run_id), ws, {handler:new AgentHandler({providerAdapter:new FakeProviderAdapter({scripts:[{kind:'text',text:'Got it.'}]})})});
    const next = await acceptWebMessage(env.DB, {workspaceId:ws,chatId:chatAvi,userId:aviId,clientMessageId:'review-history-next',text:'What was the temporary reference?'});
    let inputSeen:any;
    const adapter = {provider:'gemini' as const,audioSupport:()=>({support:'unverified' as const,detail:''}),async *streamTurn(input:any){inputSeen=input;yield {type:'text_delta' as const,text:'No reference supplied'};yield {type:'finish' as const,reason:'success' as const,continuation:null};}};
    await dispatchOutboxItem(env.DB, await outboxIdForRun(next.run_id), ws, {handler:new AgentHandler({providerAdapter:adapter})});
    const persisted = await env.DB.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id=? AND content_text LIKE ?').bind(chatAvi,'%KERNING-482%').first<{n:number}>();
    expect(persisted?.n).toBe(1);
    expect(JSON.stringify(inputSeen.messages)).not.toContain('KERNING-482');
  });

  it('REPRO: four distinct entity writes occur without bulk confirmation or configured budgets', async () => {
    const accepted = await acceptWebMessage(env.DB,{workspaceId:ws,chatId:chatAvi,userId:aviId,clientMessageId:'review-bulk',text:'Record these four businesses'});
    const names=['Alpine Forge','Birch Studio','Cobalt Works','Dawn Harbor'];
    const fake=new FakeProviderAdapter({scripts:[{kind:'tool_calls',calls:names.map((name,i)=>({callId:`bulk${i}`,name:'upsert_entity',args:{name}}))},{kind:'text',text:'All saved'}]});
    const res=await dispatchOutboxItem(env.DB,await outboxIdForRun(accepted.run_id),ws,{handler:new AgentHandler({providerAdapter:fake})});
    expect(res.status).toBe('completed');
    const applied=await env.DB.prepare("SELECT COUNT(*) AS n FROM action_receipts WHERE run_id=? AND result_status='applied'").bind(accepted.run_id).first<{n:number}>();
    expect(applied?.n).toBe(4);
    const questions=await env.DB.prepare('SELECT COUNT(*) AS n FROM pending_clarifications WHERE run_id=?').bind(accepted.run_id).first<{n:number}>();
    expect(questions?.n).toBe(0);
    const quotas=await env.DB.prepare('SELECT COUNT(*) AS n FROM workspace_daily_actions WHERE workspace_id=?').bind(ws).first<{n:number}>();
    expect(quotas?.n).toBe(0);
  });

  it('REPRO: cancelled terminal stream still executes a tool', async () => {
    const accepted=await acceptWebMessage(env.DB,{workspaceId:ws,chatId:chatAvi,userId:aviId,clientMessageId:'review-cancelled-provider',text:'Create Copper Hollow'});
    const adapter={provider:'gemini' as const,audioSupport:()=>({support:'unverified' as const,detail:''}),async *streamTurn(){
      yield {type:'tool_call_start' as const,callId:'can1',name:'upsert_entity'};
      yield {type:'tool_call_arguments' as const,callId:'can1',argumentsChunk:JSON.stringify({name:'Copper Hollow'})};
      yield {type:'tool_call_end' as const,callId:'can1',name:'upsert_entity',args:{name:'Copper Hollow'}};
      yield {type:'finish' as const,reason:'cancelled' as const,continuation:null};
    }};
    await expect(dispatchOutboxItem(env.DB,await outboxIdForRun(accepted.run_id),ws,{handler:new AgentHandler({providerAdapter:adapter,maxRoundsPerSlice:1})})).rejects.toThrow('already planned with different arguments');
    const entity=await env.DB.prepare('SELECT id FROM entities WHERE workspace_id=? AND name=?').bind(ws,'Copper Hollow').first();
    expect(entity).not.toBeNull();
  });
  it('REPRO: real provider branch sends current default rather than saved pinned model',async()=>{
    const {setWorkspaceCredential}=await import('../../packages/identity/src/index.js');
    const wrappingKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
    await setWorkspaceCredential(env.DB,{workspaceId:ws,provider:'opencode_go',rawKey:'synthetic-review-credential',wrappingKey,keyVersion:1,actorUserId:aviId});
    await env.DB.prepare("UPDATE provider_credentials SET status='available' WHERE workspace_id=? AND provider='opencode_go'").bind(ws).run();
    await env.DB.prepare("INSERT INTO workspace_settings(workspace_id,default_model,created_at,updated_at) VALUES (?,'mimo-26-pro',?,?) ON CONFLICT(workspace_id) DO UPDATE SET default_model='mimo-26-pro'").bind(ws,nowIso,nowIso).run();
    const accepted=await acceptWebMessage(env.DB,{workspaceId:ws,chatId:chatAvi,userId:aviId,clientMessageId:'review-real-pin',text:'Hello'});
    const pinned={commandKey:'mimo-25',provider:'opencode_go',modelId:'mimo-v2.5',endpointFamily:'go-chat-completions',promptVersion:'2026-10-02-v1',schemaVersion:1,pinnedAt:nowIso};
    await env.DB.prepare("UPDATE agent_runs SET model_snapshot_json=?,model_key='mimo-25' WHERE id=?").bind(JSON.stringify(pinned),accepted.run_id).run();
    let bodySeen:any;
    const handler=new AgentHandler({wrappingKey,fetchFn:async (_url,init)=>{bodySeen=JSON.parse(String(init.body));return new Response(JSON.stringify({error:{message:'synthetic transport rejection'}}),{status:400,headers:{'Content-Type':'application/json'}});}});
    await dispatchOutboxItem(env.DB,await outboxIdForRun(accepted.run_id),ws,{handler});
    expect(bodySeen.model).toBe('mimo-v2.6-pro');
    const row=await env.DB.prepare('SELECT model_key FROM agent_runs WHERE id=?').bind(accepted.run_id).first<{model_key:string}>();
    expect(row?.model_key).toBe('mimo-25');
  });

  it('REPRO: typed clarification resumption creates the task and model then creates it again',async()=>{
    const accepted=await acceptWebMessage(env.DB,{workspaceId:ws,chatId:chatAvi,userId:aviId,clientMessageId:'review-task-first',text:'Create a task to call Riverstone'});
    const first=new FakeProviderAdapter({scripts:[{kind:'tool_calls',calls:[{callId:'qtask',name:'create_task',args:{title:'Call Riverstone'}}]}]});
    const waiting=await dispatchOutboxItem(env.DB,await outboxIdForRun(accepted.run_id),ws,{handler:new AgentHandler({providerAdapter:first})});
    expect(waiting.status).toBe('waiting_for_input');
    const clar=await env.DB.prepare("SELECT id FROM pending_clarifications WHERE run_id=? AND status='pending'").bind(accepted.run_id).first<{id:string}>();
    const answer=await acceptWebMessage(env.DB,{workspaceId:ws,chatId:chatAvi,userId:aviId,clientMessageId:'review-task-answer',text:'No deadline needed.'});
    const answerSource=await env.DB.prepare('SELECT source_message_id FROM agent_runs WHERE id=?').bind(answer.run_id).first<{source_message_id:string}>();
    const resumed=await resumeRun(env.DB,{workspaceId:ws,runId:accepted.run_id,answer:{text:'No deadline needed.',messageId:answerSource!.source_message_id,authorUserId:aviId,clarificationId:clar!.id,resolvedFields:{due:null}}});
    expect(resumed.resumed).toBe(true);
    const before=await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE workspace_id=? AND title=?').bind(ws,'Call Riverstone').first<{n:number}>();
    expect(before?.n).toBe(1);
    const next=new FakeProviderAdapter({scripts:[{kind:'tool_calls',calls:[{callId:'newtask',name:'create_task',args:{title:'Call Riverstone',due:null,explicit_no_deadline:true}}]},{kind:'text',text:'Task saved'}]});
    const res=await dispatchOutboxItem(env.DB,await outboxIdForRun(accepted.run_id),ws,{handler:new AgentHandler({providerAdapter:next})});
    expect(res.status).toBe('completed');
    const after=await env.DB.prepare('SELECT COUNT(*) AS n FROM tasks WHERE workspace_id=? AND title=?').bind(ws,'Call Riverstone').first<{n:number}>();
    expect(after?.n).toBe(2);
  });

  it('REPRO: final progress commits after lease expiry before the dispatcher rejects completion',async()=>{
    const accepted=await acceptWebMessage(env.DB,{workspaceId:ws,chatId:chatAvi,userId:aviId,clientMessageId:'review-expired-progress',text:'Hello'});
    const adapter={provider:'gemini' as const,audioSupport:()=>({support:'unverified' as const,detail:''}),async *streamTurn(){
      await env.DB.prepare('UPDATE workspaces SET lease_expires_at=? WHERE id=?').bind('2000-01-01T00:00:00.000Z',ws).run();
      yield {type:'text_delta' as const,text:'Generated final answer'};
      yield {type:'finish' as const,reason:'success' as const,continuation:null};
    }};
    const res=await dispatchOutboxItem(env.DB,await outboxIdForRun(accepted.run_id),ws,{handler:new AgentHandler({providerAdapter:adapter})});
    expect(res.status).toBe('deferred');
    const row=await env.DB.prepare('SELECT status,agent_progress_json FROM agent_runs WHERE id=?').bind(accepted.run_id).first<{status:string,agent_progress_json:string}>();
    expect(row?.status).toBe('queued');
    expect(JSON.parse(row!.agent_progress_json).phase).toBe('completed');

    // Bound the review probe, otherwise production spins indefinitely on this phase.
    let statusReads=0;
    let providerStarts=0;
    const boundedDb=new Proxy(env.DB, {get(target,property){
      if(property==='prepare') return (sql:string)=>{
        if(sql.includes('SELECT status FROM agent_runs WHERE id = ? AND workspace_id = ?') && ++statusReads>3) throw new Error('review_probe_completed_phase_spin');
        return target.prepare(sql);
      };
      const value=Reflect.get(target,property,target);
      return typeof value==='function' ? value.bind(target) : value;
    }});
    const retryAdapter={provider:'gemini' as const,audioSupport:()=>({support:'unverified' as const,detail:''}),async *streamTurn(){providerStarts++;yield {type:'finish' as const,reason:'success' as const,continuation:null};}};
    const retryHandler=new AgentHandler({providerAdapter:retryAdapter});
    await dispatchOutboxItem(env.DB,await outboxIdForRun(accepted.run_id),ws,{handler:{runTurn:ctx=>retryHandler.runTurn({...ctx,db:boundedDb})}});
    expect(statusReads).toBe(4);
    expect(providerStarts).toBe(0);
  });
});
