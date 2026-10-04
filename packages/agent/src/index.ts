/**
 * @otis/agent
 * Bounded agent, tool definitions, and autonomy policy for Otis.
 *
 * Plan 005 owns the provider boundary below: a provider-neutral turn
 * contract, the operator model registry, Gemini/Go transports, and a
 * deterministic fake. Nothing here executes business tools or touches the
 * ledger; the agent loop itself belongs to Plan 006.
 */

export interface ToolDefinition<TParams = unknown, TResult = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(params: TParams, context: AgentContext): Promise<TResult>;
}

export interface AgentContext {
  workspaceId: string;
  userId: string;
  chatId: string;
  messageId: string;
}

export * from './providers/types.js';
export * from './providers/sse.js';
export * from './providers/registry.js';
export * from './providers/fake.js';
export * from './providers/gemini.js';
export * from './providers/opencode-go.js';
export * from './providers/voice.js';
export * from './providers/groqStt.js';
export * from './tools.js';
export * from './policy.js';
export * from './prompt.js';
export * from './run.js';
