/**
 * @otis/worker/agent/handler
 * Real agent turn executor implementing TurnHandler.
 * Bounded agent loop, model pinning, durable progress checkpointing,
 * multi-round tool execution, and crash recovery.
 * In accordance with plans/006-implementation-handoff.md Section 4, 7, 8.
 */

import type { CommandResult, ProviderName } from '@otis/contracts';
import type { TurnContext, TurnHandler, TurnOutcome } from '../actor/dispatch.js';
import { completeStep, hashStepArguments, listRunSteps, persistStep } from '../actor/steps.js';
import { resolveModelForChat, runProviderTurn } from '../providers/service.js';
import { executeAgentTool } from './repository.js';
import { getTurnContext } from './context.js';
import { publishAgentActivity } from './activity.js';
import { getWorkspaceRevision } from '@otis/ledger';
import {
  checkBulkOperationPolicy,
  collectAndValidateProviderStream,
  createInitialProgress,
  getOrderedToolDeclarations,
  PRODUCTION_REGISTRY,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  type AssistantCall,
  type DurableAgentProgress,
  type EndpointFamily,
  type FetchFn,
  type ModelEntry,
  type ModelRegistry,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderMessage,
  type ThinkingRequest,
  type TurnInput,
} from '@otis/agent';

export interface ModelSnapshot {
  commandKey: string;
  provider: string;
  modelId: string;
  endpointFamily: string;
  promptVersion: string;
  schemaVersion: number;
  pinnedAt: string;
}

export interface AgentLimitsConfig {
  maxDailyActions?: number;
  maxRoundsPerRun?: number;
}

export interface AgentHandlerOptions {
  wrappingKey?: CryptoKey;
  registry?: ModelRegistry;
  providerAdapter?: ProviderAdapter;
  fetchFn?: FetchFn;
  maxRoundsPerSlice?: number;
  limits?: AgentLimitsConfig;
  clock?: () => Date;
  testHooks?: {
    beforeToolExecution?: (call: AssistantCall, actionId: string) => Promise<void>;
    afterToolExecution?: (call: AssistantCall, actionId: string) => Promise<void>;
  };
}

export class AgentHandler implements TurnHandler {
  readonly name = 'agent';
  private readonly options?: AgentHandlerOptions;

  constructor(options?: AgentHandlerOptions) {
    this.options = options;
  }

  private now(): Date {
    return this.options?.clock ? this.options.clock() : new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  async runTurn(ctx: TurnContext): Promise<TurnOutcome> {
    // 0. Enforce required execution limits (must be explicitly provided; no numeric production defaults)
    if (
      !this.options?.limits ||
      typeof this.options.limits.maxDailyActions !== 'number' ||
      this.options.limits.maxDailyActions <= 0 ||
      typeof this.options.limits.maxRoundsPerRun !== 'number' ||
      this.options.limits.maxRoundsPerRun <= 0
    ) {
      return {
        kind: 'failed',
        errorCode: 'missing_budgets',
        errorMessage: 'Required execution limits (maxDailyActions, maxRoundsPerRun) are not configured or invalid.',
      };
    }

    const nowIso = this.nowIso();

    // 1. Load run metadata and verify active status
    const runRow = await ctx.db
      .prepare(
        `SELECT id, status, model_key, model_snapshot_json, thinking_snapshot_json, agent_progress_json, source_message_id, chat_id
         FROM agent_runs WHERE id = ? AND workspace_id = ?`
      )
      .bind(ctx.runId, ctx.workspaceId)
      .first<{
        id: string;
        status: string;
        model_key: string | null;
        model_snapshot_json: string | null;
        thinking_snapshot_json: string | null;
        agent_progress_json: string | null;
        source_message_id: string | null;
        chat_id: string | null;
      }>();

    if (!runRow) {
      return { kind: 'failed', errorCode: 'run_not_found', errorMessage: `Run '${ctx.runId}' not found.` };
    }

    if (runRow.status !== 'running') {
      return { kind: 'failed', errorCode: 'run_inactive', errorMessage: `Run '${ctx.runId}' is '${runRow.status}', not running.` };
    }

    // 2. Resolve acting member
    let actorUserId = '';
    if (ctx.sourceMessageId) {
      const msgRow = await ctx.db
        .prepare(`SELECT user_id FROM messages_in WHERE id = ? AND workspace_id = ?`)
        .bind(ctx.sourceMessageId, ctx.workspaceId)
        .first<{ user_id: string }>();
      if (msgRow) actorUserId = msgRow.user_id;
    }
    if (!actorUserId && ctx.chatId) {
      const chatRow = await ctx.db
        .prepare(`SELECT author_user_id FROM chats WHERE id = ? AND workspace_id = ?`)
        .bind(ctx.chatId, ctx.workspaceId)
        .first<{ author_user_id: string }>();
      if (chatRow) actorUserId = chatRow.author_user_id;
    }

    // Verify membership
    const member = await ctx.db
      .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .bind(ctx.workspaceId, actorUserId)
      .first();
    if (!member) {
      return { kind: 'failed', errorCode: 'not_member', errorMessage: 'Acting user is not an active workspace member.' };
    }

    // 3. Pin model descriptor (Section 7.1)
    let modelSnapshot: ModelSnapshot;
    let effectiveEntry: ModelEntry | null = null;

    if (runRow.model_snapshot_json) {
      modelSnapshot = JSON.parse(runRow.model_snapshot_json) as ModelSnapshot;
      if (!this.options?.providerAdapter) {
        const registry = this.options?.registry ?? PRODUCTION_REGISTRY;
        const pinnedEntry = registry.entries.find(
          (e: ModelEntry) => e.commandKey === modelSnapshot.commandKey,
        );
        if (!pinnedEntry) {
          return {
            kind: 'failed',
            errorCode: 'model_unavailable',
            errorMessage: `Pinned model '${modelSnapshot.commandKey}' is no longer supported in the registry.`,
          };
        }
        effectiveEntry = pinnedEntry;
      }
    } else {
      if (this.options?.providerAdapter) {
        modelSnapshot = {
          commandKey: 'fake-model',
          provider: this.options.providerAdapter.provider,
          modelId: 'fake-model-id',
          endpointFamily: 'openai-chat',
          promptVersion: PROMPT_VERSION,
          schemaVersion: SCHEMA_VERSION,
          pinnedAt: nowIso,
        };
      } else {
        const resolved = await resolveModelForChat(ctx.db, {
          workspaceId: ctx.workspaceId,
          actorUserId,
          selectedKey: runRow.model_key ?? undefined,
          chatId: ctx.chatId,
          registry: this.options?.registry,
        });

        if (!resolved.available) {
          return {
            kind: 'failed',
            errorCode: 'model_unavailable',
            errorMessage: `No available model configured: ${resolved.reason}`,
          };
        }
        effectiveEntry = resolved.entry;
        modelSnapshot = {
          commandKey: resolved.entry.commandKey,
          provider: resolved.entry.provider,
          modelId: resolved.entry.modelId,
          endpointFamily: resolved.entry.endpointFamily,
          promptVersion: PROMPT_VERSION,
          schemaVersion: SCHEMA_VERSION,
          pinnedAt: nowIso,
        };
      }

      // Persist model snapshot under attempt & fence & lease guard
      const snapRes = await ctx.db
        .prepare(
          `UPDATE agent_runs
           SET model_snapshot_json = ?, model_key = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND status = 'running' AND attempt_id = ? AND lease_fence = ?
             AND EXISTS (
               SELECT 1 FROM workspaces w
               WHERE w.id = agent_runs.workspace_id
                 AND w.lease_owner = ? AND w.lease_attempt_id = ? AND w.lease_expires_at > ?
             )`
        )
        .bind(
          JSON.stringify(modelSnapshot),
          modelSnapshot.commandKey,
          this.nowIso(),
          ctx.runId,
          ctx.workspaceId,
          ctx.attemptId,
          ctx.fence,
          ctx.attemptId,
          ctx.attemptId,
          this.nowIso(),
        )
        .run();
      if ((snapRes.meta.changes ?? 0) !== 1) {
        return { kind: 'failed', errorCode: 'lease_lost', errorMessage: 'Workspace lease lost or expired before model snapshot.' };
      }
    }

    // 4. Load or initialize durable progress (Section 7.2)
    let progress: DurableAgentProgress;
    if (runRow.agent_progress_json) {
      progress = JSON.parse(runRow.agent_progress_json) as DurableAgentProgress;
    } else {
      progress = createInitialProgress();
    }

    if (progress.phase === 'completed' && progress.finalAnswer !== undefined) {
      return { kind: 'completed', replyText: progress.finalAnswer ?? '' };
    }

    // If turn resumes a clarification answer, reconcile the committed action receipt
    if (ctx.answerText && progress.phase === 'clarification') {
      if (progress.pendingClarification?.intendedOperation === 'bulk_operation') {
        const text = ctx.answerText.trim().toLowerCase();
        const isRejection =
          text === 'no' ||
          text === 'cancel' ||
          text === 'stop' ||
          text.startsWith('no ') ||
          text.includes('cancel') ||
          text.includes('reject') ||
          text.includes('do not');
        if (isRejection) {
          progress.phase = 'completed';
          progress.finalAnswer = 'Cancelled bulk operation upon request.';
          progress.pendingClarification = undefined;
          if (!(await this.saveProgress(ctx, progress))) {
            return { kind: 'failed', errorCode: 'lease_lost', errorMessage: 'Workspace lease lost or expired before saving progress.' };
          }
          return { kind: 'completed', replyText: progress.finalAnswer };
        }
        progress.approvedBulkScope = (progress.pendingClarification.candidates as string[]) || [];
        progress.phase = 'tools_executing';
        progress.pendingClarification = undefined;
        if (!(await this.saveProgress(ctx, progress))) {
          return { kind: 'failed', errorCode: 'lease_lost', errorMessage: 'Workspace lease lost or expired before saving progress.' };
        }
      } else {
        const boundActionId = progress.pendingClarification?.actionId;
        const resumedReceipt = await ctx.db
          .prepare(
            `SELECT result_status, result_json, action_id FROM action_receipts
             WHERE workspace_id = ? AND run_id = ? AND (
               action_id = ? OR action_id = ? OR action_id LIKE 'act_resume_%'
             )
             ORDER BY created_at DESC LIMIT 1`
          )
          .bind(ctx.workspaceId, ctx.runId, boundActionId || '', boundActionId ? `${boundActionId}:resumed` : '')
          .first<{ result_status: string; result_json: string; action_id: string }>();

        if (resumedReceipt && progress.currentRound && progress.pendingClarification) {
          const pendingCall = progress.currentRound.assistantCalls[progress.nextToolIndex];
          if (pendingCall) {
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(resumedReceipt.result_json);
            } catch {
              parsed = null;
            }
            const resObj: CommandResult = (
              parsed && typeof parsed === 'object' && 'status' in parsed && typeof (parsed as Record<string, unknown>).status === 'string'
                ? parsed
                : {
                    status: (resumedReceipt.result_status as unknown) || 'applied',
                    affected_resource_ids: [],
                    data: parsed,
                  }
            ) as unknown as CommandResult;

            progress.completedToolResults.push({
              callId: pendingCall.callId,
              actionId: resumedReceipt.action_id || progress.pendingClarification.actionId || `${ctx.runId}_r${progress.roundIndex}_t${progress.nextToolIndex}`,
              name: pendingCall.name,
              args: pendingCall.args,
              result: resObj,
            });
            progress.nextToolIndex += 1;
          }
          progress.pendingClarification = undefined;

          if (progress.nextToolIndex >= progress.currentRound.assistantCalls.length) {
            const roundResults = progress.completedToolResults.filter((r) =>
              progress.currentRound!.assistantCalls.some((c) => c.callId === r.callId),
            );
            if (!progress.completedRounds) progress.completedRounds = [];
            progress.completedRounds.push({
              roundIndex: progress.roundIndex,
              assistantCalls: progress.currentRound.assistantCalls,
              toolResults: roundResults,
              continuation: progress.currentRound.continuation,
              usage: progress.currentRound.usage,
            });
            progress.phase = 'provider_pending';
            progress.roundIndex += 1;
            progress.currentRound = undefined;
          } else {
            progress.phase = 'tools_executing';
          }
        } else {
          progress.phase = 'provider_pending';
          progress.roundIndex += 1;
          progress.pendingClarification = undefined;
        }
        if (!(await this.saveProgress(ctx, progress))) {
          return { kind: 'failed', errorCode: 'lease_lost', errorMessage: 'Workspace lease lost or expired before saving progress.' };
        }
      }
    }

    const originalText = ctx.sourceText;
    const applySteeringContext = () => {
      const inputs = progress.steeringInputs ?? [];
      ctx.sourceText = originalText + inputs.map(input => `\n[Additional context from the same member]: ${input.text}`).join('');
      if (inputs.length) ctx.sourceMessageId = inputs.at(-1)!.sourceMessageId;
    };
    const consumeSteering = async () => {
      const inputs = (await ctx.db.prepare(`SELECT cm.id AS messageId, cm.inbound_message_id AS sourceMessageId, cm.content_text AS text, cm.sequence
        FROM chat_messages cm WHERE cm.workspace_id = ? AND cm.run_id = ? AND cm.author_user_id = ? AND cm.sequence > ?
        AND EXISTS (SELECT 1 FROM run_activity a WHERE a.workspace_id = cm.workspace_id AND a.run_id = cm.run_id AND a.type = 'message_accepted' AND json_extract(a.payload_json, '$.steering_message_id') = cm.id)
        ORDER BY cm.sequence`).bind(ctx.workspaceId, ctx.runId, actorUserId, progress.lastSteeringSequence ?? 0).all<{ messageId: string; sourceMessageId: string; text: string; sequence: number }>()).results;
      if (!inputs.length) { applySteeringContext(); return false; }
      progress.steeringInputs = [...(progress.steeringInputs ?? []), ...inputs];
      progress.lastSteeringSequence = inputs.at(-1)!.sequence;
      if (progress.phase === 'tools_executing' && progress.currentRound) {
        const round = progress.currentRound;
        const results = round.assistantCalls.map((call, index) => progress.completedToolResults.find(result => result.callId === call.callId) ?? { callId: call.callId, actionId: `${ctx.runId}_r${progress.roundIndex}_t${index}`, name: call.name, args: call.args, result: { status: 'rejected' as const, error: { code: 'superseded_by_steering', message: 'This proposal was not executed because the member added new context.' } } });
        progress.completedRounds = [...(progress.completedRounds ?? []), { roundIndex: progress.roundIndex, assistantCalls: round.assistantCalls, toolResults: results, continuation: round.continuation, usage: round.usage }];
        progress.currentRound = undefined; progress.nextToolIndex = 0; progress.roundIndex++;
      }
      progress.phase = 'provider_pending'; progress.finalAnswer = undefined;
      applySteeringContext();
      if (!(await this.saveProgress(ctx, progress))) throw new Error('Lease lost before steering checkpoint.');
      return true;
    };
    await consumeSteering();

    // 5. Bounded Slice Loop (Section 7.3)
    const maxRounds = this.options?.maxRoundsPerSlice ?? 2;
    let roundsExecutedThisTurn = 0;

    slice: while (roundsExecutedThisTurn < maxRounds) {
      if (progress.phase === 'completed') {
        return { kind: 'completed', replyText: progress.finalAnswer ?? '' };
      }

      // Re-verify run still active before each slice
      const statusCheck = await ctx.db
        .prepare(`SELECT status FROM agent_runs WHERE id = ? AND workspace_id = ?`)
        .bind(ctx.runId, ctx.workspaceId)
        .first<{ status: string }>();
      if (statusCheck?.status !== 'running') {
        return { kind: 'failed', errorCode: 'run_inactive', errorMessage: `Run is no longer running (${statusCheck?.status}).` };
      }

      // Phase A: Provider request needed
      if (progress.phase === 'init' || progress.phase === 'provider_pending') {
        if (progress.roundIndex >= this.options!.limits!.maxRoundsPerRun!) {
          return {
            kind: 'failed',
            errorCode: 'max_rounds_exceeded',
            errorMessage: `Maximum provider rounds per run (${this.options!.limits!.maxRoundsPerRun}) exceeded.`,
          };
        }

        const conversationMessages: ProviderMessage[] = [];

        // Authoritative assembled context (memory, summaries, preferences)
        const assembledContext = await getTurnContext(ctx.db, {
          workspaceId: ctx.workspaceId,
          actorUserId,
          chatId: ctx.chatId,
          sourceText: ctx.sourceText,
          sourceMessageId: ctx.sourceMessageId,
          runId: ctx.runId,
          nowIso: this.nowIso(),
        });

        conversationMessages.push({
          role: 'system',
          text: assembledContext.systemPrompt,
        });

        // Add historical chat messages from transcript (F05)
        if (assembledContext.recentMessages && assembledContext.recentMessages.length > 0) {
          for (const msg of assembledContext.recentMessages) {
            if (msg.authorKind === 'system') {
              conversationMessages.push({
                role: 'assistant',
                text: msg.text,
              });
            } else {
              conversationMessages.push({
                role: 'user',
                text: msg.text,
              });
            }
          }
        }

        // Current turn user input prompt
        let userContent = ctx.sourceText;
        if (ctx.answerText) {
          userContent += `\n[User Clarification Answer]: ${ctx.answerText}`;
        }
        conversationMessages.push({
          role: 'user',
          text: userContent,
        });

        // Add completed historical tool rounds with original names, arguments, and results (F04)
        if (progress.completedRounds && progress.completedRounds.length > 0) {
          const historicalRounds = progress.completedRounds.slice(0, -1);
          for (const round of historicalRounds) {
            conversationMessages.push({
              role: 'assistant',
              text: '',
              toolCalls: round.assistantCalls.map((c) => ({
                id: c.callId,
                name: c.name,
                arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}),
              })),
            });

            for (const res of round.toolResults) {
              conversationMessages.push({
                role: 'tool',
                toolCallId: res.callId,
                name: res.name,
                text: JSON.stringify(res.result),
              });
            }
          }

          const latestRound = progress.completedRounds[progress.completedRounds.length - 1]!;
          conversationMessages.push({
            role: 'assistant',
            text: '',
            toolCalls: latestRound.assistantCalls.map((c) => ({
              id: c.callId,
              name: c.name,
              arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}),
            })),
          });
        }

        const lastCompletedRound =
          progress.completedRounds && progress.completedRounds.length > 0
            ? progress.completedRounds[progress.completedRounds.length - 1]
            : null;

        let thinkingRequest: ThinkingRequest = { kind: 'provider_default' };
        if (runRow.thinking_snapshot_json) {
          try {
            const snap = JSON.parse(runRow.thinking_snapshot_json);
            if (snap && snap.request) {
              thinkingRequest = snap.request;
            }
          } catch {
            thinkingRequest = { kind: 'provider_default' };
          }
        }

        const turnInput: Omit<TurnInput, 'model'> = {
          workspaceId: ctx.workspaceId,
          chatId: ctx.chatId,
          runId: ctx.runId,
          requestId: `${ctx.runId}_r${progress.roundIndex}`,
          sessionId: ctx.chatId,
          messages: conversationMessages,
          tools: getOrderedToolDeclarations(),
          pendingToolResults: lastCompletedRound
            ? lastCompletedRound.toolResults.map((r) => ({
                callId: r.callId,
                name: r.name,
                arguments: typeof r.args === 'string' ? r.args : JSON.stringify(r.args ?? {}),
                resultText: JSON.stringify(r.result),
              }))
            : [],
          previousContinuation: lastCompletedRound?.continuation ?? null,
          maxOutputTokens: 4096,
          timeoutMs: 60000,
          thinking: thinkingRequest,
        };

        // Stream from provider
        let stream: AsyncIterable<ProviderEvent>;
        if (this.options?.providerAdapter) {
          stream = this.options.providerAdapter.streamTurn({
            ...turnInput,
            model: {
              commandKey: modelSnapshot.commandKey,
              provider: modelSnapshot.provider as ProviderName,
              modelId: modelSnapshot.modelId,
              endpointFamily: modelSnapshot.endpointFamily as EndpointFamily,
              endpointUrl: 'https://fake.provider/v1',
            },
          });
        } else {
          if (!effectiveEntry) {
            const resolved = await resolveModelForChat(ctx.db, {
              workspaceId: ctx.workspaceId,
              actorUserId,
              chatId: ctx.chatId,
              registry: this.options?.registry,
            });
            if (!resolved.available) {
              return { kind: 'failed', errorCode: 'model_unavailable', errorMessage: resolved.reason };
            }
            effectiveEntry = resolved.entry;
          }

          if (!this.options?.wrappingKey) {
            return { kind: 'failed', errorCode: 'misconfigured', errorMessage: 'Missing wrapping key for provider decryption.' };
          }

          stream = runProviderTurn(ctx.db, {
            workspaceId: ctx.workspaceId,
            actorUserId,
            entry: effectiveEntry,
            wrappingKey: this.options.wrappingKey,
            input: turnInput,
            fetchFn: this.options?.fetchFn,
          });
        }

        // Collect and validate round (throws AgentStreamError on incomplete/malformed stream)
        let collectedRound;
        try {
          const publicStream = async function* () {
            let buffer = ''; let chunk = 0; let summaries = 0;
            // Bound both payload size and D1 writes. The authoritative final
            // message remains complete even after the live preview reaches its cap.
            const flush = async () => {
              while (buffer && chunk < 32) {
                const text = buffer.slice(0, 2048); buffer = buffer.slice(2048);
                await publishAgentActivity(ctx, `r${progress.roundIndex}_text${chunk++}`, 'text_chunk', { text, round_index: progress.roundIndex });
              }
              buffer = '';
            };
            for await (const event of stream) {
              if (event.type === 'text_delta') {
                if (chunk < 32) buffer += event.text.slice(0, (32 - chunk) * 2048 - buffer.length);
                if (buffer.length >= 2048) await flush();
              } else if (event.type === 'provider_thought_summary' && summaries < 8) {
                await publishAgentActivity(ctx, `r${progress.roundIndex}_summary${summaries++}`, 'reasoning_summary', { provider: modelSnapshot.provider, text: event.text.slice(0, 8000), round_index: progress.roundIndex });
              }
              yield event;
            }
            await flush();
          };
          collectedRound = await collectAndValidateProviderStream(publicStream());
        } catch (streamErr) {
          const appliedCount = progress.completedToolResults.filter((r) => r.result.status === 'applied').length;
          return {
            kind: 'failed',
            errorCode: 'provider_stream_error',
            errorMessage: appliedCount > 0
              ? `Partial success: ${appliedCount} actions committed before stream error: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`
              : streamErr instanceof Error ? streamErr.message : String(streamErr),
          };
        }

        // An input accepted while the provider was streaming changes the next
        // interpretation before any of that response's proposed writes execute.
        if (await consumeSteering()) {
          progress.roundIndex++; roundsExecutedThisTurn++;
          if (!(await this.saveProgress(ctx, progress))) return { kind: 'failed', errorCode: 'lease_lost', errorMessage: 'Lease lost before steering continuation.' };
          continue slice;
        }

        // Bulk operations check across proposed calls (F08)
        if (collectedRound.toolCalls.length > 0) {
          const targetEntities = collectedRound.toolCalls.map((c) => {
            const a = c.args as Record<string, unknown> | null;
            return (a?.name as string) ?? (a?.entity_id as string) ?? null;
          }).filter(Boolean) as string[];

          const approvedScope = new Set(progress.approvedBulkScope || []);
          const unapprovedEntities = targetEntities.filter((e) => !approvedScope.has(e));

          const bulkCheck = checkBulkOperationPolicy(targetEntities);
          if (bulkCheck.requiresConfirmation && unapprovedEntities.length > 0) {
            const bulkPendingOp = {
              version: 1 as const,
              command_name: 'bulk_operation',
              action_id: `act_bulk_${ctx.runId}_${progress.roundIndex}`,
              args: {
                targets: targetEntities,
                calls: collectedRound.toolCalls,
              },
              missing_fields: ['confirm'],
              candidates: targetEntities,
              source_revision: 0,
            };

            progress.phase = 'clarification';
            progress.pendingClarification = {
              question: `You are proposing actions across ${bulkCheck.uniqueEntitiesCount} businesses (${targetEntities.join(', ')}). Please confirm to proceed.`,
              intendedOperation: 'bulk_operation',
              missingFields: ['confirm'],
              candidates: targetEntities,
              pendingOperation: bulkPendingOp,
            };
            progress.currentRound = {
              assistantCalls: collectedRound.toolCalls,
              continuation: collectedRound.continuation,
              usage: collectedRound.usage,
            };
            progress.nextToolIndex = 0;

            if (!(await this.saveProgress(ctx, progress))) {
              return { kind: 'failed', errorCode: 'lease_lost', errorMessage: 'Workspace lease lost or expired before saving progress.' };
            }
            return {
              kind: 'needs_input',
              question: progress.pendingClarification.question,
              intendedOperation: progress.pendingClarification.intendedOperation,
              missingFields: progress.pendingClarification.missingFields,
              candidates: progress.pendingClarification.candidates,
              pendingOperation: bulkPendingOp,
            };
          }
        }

        // Case 1: Final text answer with no tool calls
        if (collectedRound.toolCalls.length === 0) {
          progress.phase = 'completed';
          progress.finalAnswer = collectedRound.text;
          if (!(await this.saveProgress(ctx, progress))) {
            progress.phase = 'provider_pending'; progress.finalAnswer = undefined;
            if (!(await this.saveProgress(ctx, progress))) return { kind: 'failed', errorCode: 'lease_lost', errorMessage: 'Lease lost before finishing.' };
            return { kind: 'continuation', progressJson: JSON.stringify(progress) };
          }
          return { kind: 'completed', replyText: collectedRound.text };
        }

        // Case 2: Model proposed tool calls -> persist provider round BEFORE executing tools
        progress.phase = 'tools_executing';
        progress.currentRound = {
          assistantCalls: collectedRound.toolCalls,
          continuation: collectedRound.continuation,
          usage: collectedRound.usage,
        };
        progress.nextToolIndex = 0;
        if (!(await this.saveProgress(ctx, progress))) {
          return { kind: 'failed', errorCode: 'lease_lost', errorMessage: 'Workspace lease lost or expired before saving progress.' };
        }
      }

      // Phase B: Execute planned tools
      if (progress.phase === 'tools_executing' && progress.currentRound) {
        const calls = progress.currentRound.assistantCalls;

        while (progress.nextToolIndex < calls.length) {
          const call = calls[progress.nextToolIndex]!;
          const actionId = `${ctx.runId}_r${progress.roundIndex}_t${progress.nextToolIndex}`;

          if (this.options?.testHooks?.beforeToolExecution) {
            await this.options.testHooks.beforeToolExecution(call, actionId);
          }

          if (await consumeSteering()) { roundsExecutedThisTurn++; continue slice; }

          // Check if this action ID was already committed (crash recovery idempotency)
          const existingReceipt = await ctx.db
            .prepare(`SELECT result_status, result_json FROM action_receipts WHERE workspace_id = ? AND action_id = ?`)
            .bind(ctx.workspaceId, actionId)
            .first<{ result_status: string; result_json: string }>();

          let result: CommandResult;

          if (existingReceipt) {
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(existingReceipt.result_json);
            } catch {
              parsed = null;
            }
            if (parsed && typeof parsed === 'object' && 'status' in parsed && typeof (parsed as Record<string, unknown>).status === 'string') {
              result = parsed as unknown as CommandResult;
            } else {
              result = {
                status: (existingReceipt.result_status as unknown) || 'applied',
                affected_resource_ids: [],
                data: parsed,
              } as unknown as CommandResult;
            }
          } else {
            // Check daily actions limit if configured
            if (this.options?.limits?.maxDailyActions) {
              const todayUtc = this.nowIso().slice(0, 10);
              const dailyCountRow = await ctx.db
                .prepare(`SELECT action_count FROM workspace_daily_actions WHERE workspace_id = ? AND date_utc = ?`)
                .bind(ctx.workspaceId, todayUtc)
                .first<{ action_count: number }>();
              if ((dailyCountRow?.action_count ?? 0) >= this.options.limits.maxDailyActions) {
                return {
                  kind: 'failed',
                  errorCode: 'daily_action_limit_exceeded',
                  errorMessage: `Workspace daily action limit (${this.options.limits.maxDailyActions}) exceeded.`,
                };
              }
            }

            // Allocate next step in run_steps: reuse planned step if present, otherwise contiguous index (F02)
            const argsHash = await hashStepArguments(call.args);
            const plannedStep = await ctx.db
              .prepare(
                `SELECT id, step_index, status, result_json, action_id, attempt_id
                 FROM run_steps
                 WHERE run_id = ? AND tool_name = ? AND arguments_hash = ? AND status = 'planned'
                 ORDER BY step_index ASC LIMIT 1`
              )
              .bind(ctx.runId, call.name, argsHash)
              .first<Record<string, unknown>>();

            let stepIndex: number;
            if (plannedStep) {
              stepIndex = Number(plannedStep['step_index']);
            } else {
              const existingSteps = await listRunSteps(ctx.db, ctx.runId);
              stepIndex = existingSteps.length;
            }

            const persisted = await persistStep(ctx.db, {
              workspaceId: ctx.workspaceId,
              runId: ctx.runId,
              stepIndex,
              toolName: call.name,
              args: call.args,
              attemptId: ctx.attemptId,
              fence: ctx.fence,
              nowIso: this.nowIso(),
            });

            const currentRevision = (await getWorkspaceRevision(ctx.db, ctx.workspaceId))?.business_revision ?? 0;
            await publishAgentActivity(ctx, `step${stepIndex}_started`, 'step_started', { tool_name: call.name, step_index: stepIndex });

            // Execute through repository
            result = await executeAgentTool({
              db: ctx.db,
              workspaceId: ctx.workspaceId,
              actorUserId,
              runId: ctx.runId,
              stepId: persisted.step.id,
              fence: ctx.fence,
              expectedBusinessRevision: currentRevision,
              actionId,
              sourceMessageId: ctx.sourceMessageId ?? undefined,
              chatId: ctx.chatId,
              sourceTrust: ctx.sourceTrust ?? 'member',
              sourceText: ctx.sourceText,
              toolName: call.name,
              toolArgs: call.args,
              maxDailyActions: this.options?.limits?.maxDailyActions,
            });

            // Complete step
            await completeStep(ctx.db, persisted.step.id, ctx.attemptId, {
              resultJson: JSON.stringify(result),
              actionId,
              fence: ctx.fence,
              nowIso: this.nowIso(),
            });
            await publishAgentActivity(ctx, `step${stepIndex}_finished`, 'step_finished', { tool_name: call.name, step_index: stepIndex, status: ['applied', 'already_applied'].includes(result.status) ? 'succeeded' : result.status === 'needs_clarification' ? 'skipped' : 'failed' });

            if (result.status === 'rejected' && result.error?.code === 'daily_action_limit_exceeded') {
              return {
                kind: 'failed',
                errorCode: 'daily_action_limit_exceeded',
                errorMessage: result.error.message,
              };
            }
          }

          if (this.options?.testHooks?.afterToolExecution) {
            await this.options.testHooks.afterToolExecution(call, actionId);
          }

          // If tool requires clarification -> pause turn immediately and return needs_input
          if (result.status === 'needs_clarification') {
            const canonicalPendingOp = result.clarification?.pending_operation ?? (result as unknown as Record<string, unknown>)['pending_operation'] ?? {
              command: call.name,
              params: call.args,
            };

            progress.phase = 'clarification';
            progress.pendingClarification = {
              question: result.clarification?.prompt || 'Clarification required.',
              intendedOperation: call.name,
              missingFields: result.clarification?.missing_fields || [],
              candidates: result.clarification?.candidates,
              callId: call.callId,
              actionId,
              proposedArguments: call.args as Record<string, unknown>,
              pendingOperation: canonicalPendingOp,
            };
            if (!(await this.saveProgress(ctx, progress))) {
              return { kind: 'failed', errorCode: 'lease_lost', errorMessage: 'Workspace lease lost or expired before saving progress.' };
            }

            return {
              kind: 'needs_input',
              question: progress.pendingClarification.question,
              intendedOperation: progress.pendingClarification.intendedOperation,
              missingFields: progress.pendingClarification.missingFields,
              candidates: progress.pendingClarification.candidates,
              pendingOperation: canonicalPendingOp,
            };
          }

          progress.completedToolResults.push({
            callId: call.callId,
            actionId,
            name: call.name,
            args: call.args,
            result,
          });

          progress.nextToolIndex += 1;
          if (!(await this.saveProgress(ctx, progress))) {
            return { kind: 'failed', errorCode: 'lease_lost', errorMessage: 'Workspace lease lost or expired before saving progress.' };
          }
        }

        // All tools in current round completed: transition to provider_pending for next round
        const roundResults = progress.completedToolResults.filter((r) =>
          progress.currentRound!.assistantCalls.some((c) => c.callId === r.callId),
        );
        if (!progress.completedRounds) progress.completedRounds = [];
        progress.completedRounds.push({
          roundIndex: progress.roundIndex,
          assistantCalls: progress.currentRound.assistantCalls,
          toolResults: roundResults,
          continuation: progress.currentRound.continuation,
          usage: progress.currentRound.usage,
        });

        progress.phase = 'provider_pending';
        progress.roundIndex += 1;
        progress.currentRound = undefined;
        if (!(await this.saveProgress(ctx, progress))) {
          return { kind: 'failed', errorCode: 'lease_lost', errorMessage: 'Workspace lease lost or expired before saving progress.' };
        }

        roundsExecutedThisTurn += 1;

        // If slice limit reached, checkpoint and return continuation
        if (roundsExecutedThisTurn >= maxRounds) {
          return {
            kind: 'continuation',
            progressJson: JSON.stringify(progress),
          };
        }
      }
    }

    return {
      kind: 'continuation',
      progressJson: JSON.stringify(progress),
    };
  }

  private async saveProgress(ctx: TurnContext, progress: DurableAgentProgress): Promise<boolean> {
    const nowIso = this.nowIso();
    const res = await ctx.db
      .prepare(
        `UPDATE agent_runs
         SET agent_progress_json = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND attempt_id = ? AND lease_fence = ? AND status = 'running'
           AND EXISTS (
             SELECT 1 FROM workspaces w
             WHERE w.id = agent_runs.workspace_id
               AND w.lease_owner = ? AND w.lease_attempt_id = ? AND w.lease_expires_at > ?
           ) AND (? <> 'completed' OR NOT EXISTS (
             SELECT 1 FROM chat_messages cm JOIN run_activity a ON a.run_id = cm.run_id
             WHERE cm.run_id = agent_runs.id AND cm.sequence > ? AND a.type = 'message_accepted'
               AND json_extract(a.payload_json, '$.steering_message_id') = cm.id
           ))`
      )
      .bind(
        JSON.stringify(progress),
        nowIso,
        ctx.runId,
        ctx.workspaceId,
        ctx.attemptId,
        ctx.fence,
        ctx.attemptId,
        ctx.attemptId,
        nowIso,
        progress.phase,
        progress.lastSteeringSequence ?? 0,
      )
      .run();
    return (res.meta.changes ?? 0) === 1;
  }
}
