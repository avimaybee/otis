/**
 * @daybook/agent
 * Bounded agent, tool definitions, and autonomy policy for Daybook.
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

export const SUPPORTED_MODELS = ['gemini-2.0-flash', 'opencode-go'] as const;
export type SupportedModel = (typeof SUPPORTED_MODELS)[number];
