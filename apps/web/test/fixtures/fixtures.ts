/**
 * Synthetic 008A Storybook fixtures. Invented workspace content only: no real
 * chats, members, credentials, provider calls or authentication. Every story
 * renders a production component with these props.
 */

import type {
  AgentRun,
  Chat,
  ChatMessage,
  ClarificationSummary,
  CommandDescriptor,
  MemorySourceResponse,
  ModelOption,
  PendingClarification,
  PublicActivity,
  RunDetailResponse,
  UndoPreview,
} from '@otis/contracts';

const WS = 'ws-storybook';
const CHAT = 'chat-storybook';
const HUNOR = 'user-hunor';
const AVI = 'user-avi';

let sequence = 100;

export function storyMessage(partial: Partial<ChatMessage> & { content_text: string }): ChatMessage {
  sequence += 1;
  return {
    id: `msg-${sequence}`,
    workspace_id: WS,
    chat_id: CHAT,
    author_kind: 'member',
    author_user_id: HUNOR,
    author_display_name: 'Hunor',
    channel: 'web',
    inbound_message_id: null,
    client_message_id: `client-${sequence}`,
    media_id: null,
    run_id: null,
    sequence,
    created_at: new Date(Date.UTC(2026, 9, 3, 9, 10 + sequence, 0)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 9, 3, 9, 10 + sequence, 0)).toISOString(),
    ...partial,
  };
}

export function storyActivity(partial: Partial<PublicActivity> & { type: string; run_id: string }): PublicActivity {
  sequence += 1;
  return {
    schema_version: 1,
    id: `act-${sequence}`,
    cursor: sequence,
    workspace_id: WS,
    chat_id: CHAT,
    created_at: new Date().toISOString(),
    payload: {},
    ...partial,
  } as PublicActivity;
}

export function storyRun(status: RunDetailResponse['status'], overrides?: Partial<RunDetailResponse>): RunDetailResponse {
  const run: AgentRun = {
    id: 'run-story-1',
    workspace_id: WS,
    chat_id: CHAT,
    source_message_id: 'msg-101',
    source_job_id: null,
    executor_kind: 'agent',
    status,
    model_key: 'mimo-25',
    attempt_id: 'attempt-1',
    lease_fence: 3,
    error_code: null,
    error_message: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return {
    run,
    steps: [],
    actions: [],
    activities: [],
    pending_clarification: null,
    status,
    ...overrides,
  };
}

export function storyClarification(question: string, candidates: string[] | null = null): PendingClarification {
  return {
    id: 'clar-story-1',
    workspace_id: WS,
    chat_id: CHAT,
    run_id: 'run-story-1',
    source_message_id: 'msg-101',
    requester_user_id: HUNOR,
    question,
    intended_operation: 'create_task',
    missing_fields: ['due'],
    candidates_json: candidates ? JSON.stringify(candidates) : null,
    source_revision: 12,
    status: 'pending',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export function storyClarificationSummary(question: string, candidates: string[] | null = null): ClarificationSummary {
  return {
    id: 'clar-story-1',
    chat_id: CHAT,
    run_id: 'run-story-1',
    question,
    intended_operation: 'create_task',
    missing_fields: ['due'],
    candidates,
    status: 'pending',
    created_at: new Date().toISOString(),
    answerable_by_caller: true,
  };
}

export const storyMembers = { [HUNOR]: 'Hunor', [AVI]: 'Avi' };

export const storyCommands: CommandDescriptor[] = [
  { name: 'model', summary: 'Show or switch the chat model', usage: '/model [key]', available: true, deterministic: true },
  { name: 'thinking', summary: 'Show or set thinking effort', usage: '/thinking [choice]', available: true, deterministic: true },
  { name: 'workspace', summary: 'Show or switch workspace', usage: '/workspace [name]', available: true, deterministic: true },
  { name: 'today', summary: 'Show current due work', usage: '/today', available: true, deterministic: true },
  { name: 'undo', summary: 'Revert a saved change', usage: '/undo [target]', available: true, deterministic: true },
  { name: 'help', summary: 'List shortcuts', usage: '/help', available: true, deterministic: true },
];

export const storyModels: ModelOption[] = [
  {
    command_key: 'mimo-25',
    display_name: 'MiMo V2.5',
    provider: 'opencode_go',
    native_audio_supported: false,
    voice_available: true,
    available: true,
    is_current: true,
    is_default: true,
    thinking: {
      current_choice_id: null,
      effective_choice_id: null,
      is_default: true,
      state: 'supported',
      choices: [
        { id: 'low', label: 'Low effort' },
        { id: 'high', label: 'High effort' },
      ],
    },
  },
  {
    command_key: 'gemini-3.1-flash-lite',
    display_name: 'Gemini 3.1 Flash Lite',
    provider: 'gemini',
    native_audio_supported: false,
    voice_available: false,
    available: true,
    is_current: false,
    is_default: false,
  },
  {
    command_key: 'gemini-3.5-flash-lite',
    display_name: 'Gemini 3.5 Flash-Lite',
    provider: 'gemini',
    native_audio_supported: false,
    voice_available: false,
    available: true,
    is_current: true,
    is_default: true,
    thinking: {
      current_choice_id: null,
      effective_choice_id: 'medium',
      is_default: true,
      state: 'supported',
      choices: [
        { id: 'minimal', label: 'Minimal' },
        { id: 'low', label: 'Low' },
        { id: 'medium', label: 'Medium' },
        { id: 'high', label: 'High' },
      ],
    },
  },
];

export function storyChat(id: string, title: string, author: string = HUNOR): Chat {
  return {
    id,
    workspace_id: WS,
    author_user_id: author,
    author_display_name: author === AVI ? 'Avi' : 'Hunor',
    title,
    model_override: null,
    thinking_override: null,
    is_archived: false,
    activity_cursor: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
  };
}

export function storyUndoPreview(mode: 'from_here' | 'single', withDependency: boolean): UndoPreview {
  return {
    target_action_id: 'action-7',
    mode,
    selected_action_ids: mode === 'from_here' ? ['action-7', 'action-8'] : ['action-7'],
    affected_event_ids: ['event-70', 'event-71'],
    affected_entities: [{ id: 'entity-1', name: 'Thai Shop', changes: ['status: new to warm'] }],
    affected_tasks: [{ id: 'task-2', title: 'Send Thai Shop the offer', changes: ['due: Friday'] }],
    dependencies: withDependency
      ? [{ action_id: 'action-9', reason: 'Hunor logged a visit on this record after your change.', requires_clarification: true }]
      : [],
    expected_revision: 42,
  };
}

export function storyMemorySource(): MemorySourceResponse {
  return {
    memory: {
      id: 'memory-1',
      content: 'Thai Shop asked for the offer by Friday.',
      provenance: 'stated',
      status: 'active',
      observed_at: new Date().toISOString(),
    },
    source: {
      chat_id: CHAT,
      author_name: 'Hunor',
      text: 'Thai Shop wants the offer by Friday',
      created_at: new Date().toISOString(),
      channel: 'web',
    },
  };
}
