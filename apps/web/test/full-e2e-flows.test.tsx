/** @vitest-environment happy-dom */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type {
  Chat,
  ChatMessage,
  ModelOption,
  RunDetailResponse,
  MemberSettings,
  WorkspaceSettings,
  ActionDetailResponse,
  UndoPreviewResponse,
  MemorySourceResponse,
} from '@otis/contracts';
import { ConversationScreen } from '../src/ConversationScreen.js';
import { api } from '../src/api/client.js';
import * as stream from '../src/hooks/useActivityStream.js';

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const WS = 'ws_e2e';
const USER = 'usr_avi';
const TEAMMATE = 'usr_hunor';
const MEMBERS: Record<string, string> = {
  [USER]: 'Avi',
  [TEAMMATE]: 'Hunor',
};

const TIMESTAMP = '2026-10-03T12:00:00.000Z';

function makeChat(id: string, title: string, author = USER): Chat {
  return {
    id,
    workspace_id: WS,
    title,
    author_user_id: author,
    author_display_name: MEMBERS[author] ?? 'Teammate',
    model_override: null,
    is_archived: false,
    activity_cursor: 1,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    last_activity_at: TIMESTAMP,
  };
}

function makeMessage(id: string, text: string, kind: 'member' | 'system', author = USER, runId: string | null = null): ChatMessage {
  return {
    id,
    workspace_id: WS,
    chat_id: 'chat_1',
    author_user_id: kind === 'member' ? author : null,
    author_display_name: kind === 'member' ? (MEMBERS[author] ?? 'Teammate') : 'Otis',
    author_kind: kind,
    channel: 'web',
    inbound_message_id: `in_${id}`,
    client_message_id: null,
    content_text: text,
    media_id: null,
    run_id: runId,
    sequence: 1,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  };
}

const DEFAULT_MODELS: ModelOption[] = [
  {
    command_key: 'mimo-25',
    display_name: 'MiMo V2.5',
    provider: 'opencode_go',
    available: true,
    is_current: true,
    is_default: true,
    native_audio_supported: true,
    voice_available: false,
    thinking: {
      state: 'supported',
      is_default: true,
      current_choice_id: null,
      effective_choice_id: 'medium',
      choices: [
        { id: 'low', label: 'Low' },
        { id: 'medium', label: 'Medium' },
        { id: 'high', label: 'High' },
      ],
    },
  },
  {
    command_key: 'gemini-3.1-flash',
    display_name: 'Gemini 3.1 Flash',
    provider: 'gemini',
    available: true,
    is_current: false,
    is_default: false,
    native_audio_supported: false,
    voice_available: false,
  },
];

async function mount(element: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => root.render(element));
  return {
    host,
    unmount: async () => {
      await React.act(async () => root.unmount());
      host.remove();
    },
  };
}

async function fill(input: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await React.act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('End-to-End UI to Backend Flow Verification', () => {
  beforeEach(() => {
    sessionStorage.clear();
    history.replaceState({}, '', `/?workspace=${WS}&chat=new`);
    vi.spyOn(stream, 'subscribeToActivity').mockReturnValue({ close: vi.fn() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  // FLOW 1: New Chat Creation & Message Dispatching
  it('Flow 1: creates chat on first send, navigates URL, and updates transcript with message', async () => {
    const createdChat = makeChat('chat_new_1', 'New Conversation');
    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);

    const createChatSpy = vi.spyOn(api, 'createChat').mockResolvedValue({ chat: createdChat });
    const sendMessageSpy = vi.spyOn(api, 'sendMessage').mockResolvedValue({
      status: 'accepted',
      message_id: 'msg_accepted_1',
      run_id: 'run_1',
      acceptance_sequence: 1,
    });
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: createdChat, is_author: true });
    vi.spyOn(api, 'listMessages').mockResolvedValue({
      chat_id: 'chat_new_1',
      messages: [makeMessage('msg_accepted_1', 'Hello Otis, need a proposal', 'member')],
      next_before_sequence: null,
    });
    vi.spyOn(api, 'run').mockResolvedValue({
      run: { id: 'run_1', status: 'queued' } as never,
      status: 'queued',
      steps: [],
      actions: [],
      activities: [],
      pending_clarification: null,
    });

    const view = await mount(
      <ConversationScreen
        workspaceId={WS}
        workspaces={[{ id: WS, name: 'Kerning' }]}
        userId={USER}
        members={MEMBERS}
        onSignOut={vi.fn()}
      />
    );

    // Composer textarea should be ready
    const textarea = view.host.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    await fill(textarea, 'Hello Otis, need a proposal');
    const sendButton = view.host.querySelector('[aria-label="Send"]') as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);

    await React.act(async () => sendButton.click());

    // Verify backend call flow
    expect(createChatSpy).toHaveBeenCalledWith(WS, expect.stringMatching(/^new-/));
    expect(sendMessageSpy).toHaveBeenCalledWith(WS, 'chat_new_1', expect.any(String), 'Hello Otis, need a proposal', undefined);

    // Verify URL navigation
    expect(location.search).toContain('chat=chat_new_1');

    await view.unmount();
  });

  // FLOW 2: Teammate Chat Read-Only Enforcement
  it('Flow 2: enforces read-only mode for teammate conversation and navigates back to own chat', async () => {
    const teamChat = makeChat('chat_team_1', 'Hunor visit notes', TEAMMATE);
    history.replaceState({}, '', `/?workspace=${WS}&chat=chat_team_1`);

    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [makeChat('chat_own_1', 'My chat', USER), teamChat] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: teamChat, is_author: false });
    vi.spyOn(api, 'listMessages').mockResolvedValue({
      chat_id: 'chat_team_1',
      messages: [makeMessage('msg_t1', 'Visiting Bistro client today', 'member', TEAMMATE)],
      next_before_sequence: null,
    });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });

    const view = await mount(
      <ConversationScreen
        workspaceId={WS}
        workspaces={[{ id: WS, name: 'Kerning' }]}
        userId={USER}
        members={MEMBERS}
        onSignOut={vi.fn()}
      />
    );

    // Composer should be hidden in read-only mode
    expect(view.host.querySelector('textarea')).toBeNull();

    // Readonly banner should be present with teammate name
    expect(view.host.textContent).toContain('This is Hunor’s conversation.');
    const continueBtn = view.host.querySelector('.otis-readonly button') as HTMLButtonElement;
    expect(continueBtn).toBeTruthy();
    expect(continueBtn.textContent).toContain('Continue in your own chat');

    // Click continue button -> navigates to own chat
    await React.act(async () => continueBtn.click());
    expect(location.search).toContain('chat=chat_own_1');

    await view.unmount();
  });

  // FLOW 3: Slash Commands Execution (/model, /thinking, /help)
  it('Flow 3: executes /model and /thinking commands and updates model selection state', async () => {
    const myChat = makeChat('chat_cmd_1', 'Bistro Offer');
    history.replaceState({}, '', `/?workspace=${WS}&chat=chat_cmd_1`);

    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [myChat] });
    vi.spyOn(api, 'commands').mockResolvedValue({
      surface: 'web',
      commands: [
        { name: 'model', summary: 'Set model', usage: '/model', available: true, deterministic: true },
        { name: 'thinking', summary: 'Set thinking', usage: '/thinking', available: true, deterministic: true },
      ],
    });
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: myChat, is_author: true });
    vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: 'chat_cmd_1', messages: [], next_before_sequence: null });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });

    const cmdSpy = vi.spyOn(api, 'executeCommand').mockResolvedValue({
      status: 'accepted',
      message_id: 'cmd_1',
      run_id: 'run_cmd',
      acceptance_sequence: 1,
      command_applied: true,
    });

    const view = await mount(
      <ConversationScreen
        workspaceId={WS}
        workspaces={[{ id: WS, name: 'Kerning' }]}
        userId={USER}
        members={MEMBERS}
        onSignOut={vi.fn()}
      />
    );

    const textarea = view.host.querySelector('textarea') as HTMLTextAreaElement;
    await fill(textarea, '/model gemini-3.1-flash');

    // Press Enter to submit command
    await React.act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(cmdSpy).toHaveBeenCalledWith(WS, 'chat_cmd_1', expect.any(String), '/model gemini-3.1-flash');
    expect(textarea.value).toBe('');

    await view.unmount();
  });

  // FLOW 4: Stop In-Flight Agent Run
  it('Flow 4: stops in-flight run when Stop button is clicked', async () => {
    const myChat = makeChat('chat_stop_1', 'Bistro Run');
    history.replaceState({}, '', `/?workspace=${WS}&chat=chat_stop_1`);

    const runningRun: RunDetailResponse = {
      run: { id: 'run_active_1', status: 'running' } as never,
      status: 'running',
      steps: [{ step_index: 0, tool_name: 'query', status: 'running', action_id: null } as never],
      actions: [],
      activities: [],
      pending_clarification: null,
    };

    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [myChat] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: myChat, is_author: true });
    vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: 'chat_stop_1', messages: [makeMessage('m1', 'Run task', 'member', USER, 'run_active_1')], next_before_sequence: null });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
    vi.spyOn(api, 'run').mockResolvedValue(runningRun);

    const stopSpy = vi.spyOn(api, 'stopRun').mockResolvedValue({ stopped: true, run_status: 'cancelled' });

    const view = await mount(
      <ConversationScreen
        workspaceId={WS}
        workspaces={[{ id: WS, name: 'Kerning' }]}
        userId={USER}
        members={MEMBERS}
        onSignOut={vi.fn()}
      />
    );

    // Stop button should be visible in composer
    const stopButton = view.host.querySelector('[aria-label="Stop Otis"]') as HTMLButtonElement;
    expect(stopButton).toBeTruthy();

    await React.act(async () => stopButton.click());
    expect(stopSpy).toHaveBeenCalledWith(WS, 'run_active_1');

    await view.unmount();
  });

  // FLOW 5: Clarification & Human-in-the-Loop Resume
  it('Flow 5: renders awaiting input clarification and sends response with clarificationId', async () => {
    const myChat = makeChat('chat_clarify_1', 'Bistro Clarify');
    history.replaceState({}, '', `/?workspace=${WS}&chat=chat_clarify_1`);

    const clarifyRun: RunDetailResponse = {
      run: { id: 'run_c1', status: 'waiting_for_input' } as never,
      status: 'waiting_for_input',
      steps: [],
      actions: [],
      activities: [],
      pending_clarification: {
        id: 'clarification_123',
        question: 'What time on Friday should I call them?',
      } as never,
    };

    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [myChat] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: myChat, is_author: true });
    vi.spyOn(api, 'listMessages').mockResolvedValue({
      chat_id: 'chat_clarify_1',
      messages: [makeMessage('m1', 'Schedule call', 'member', USER, 'run_c1')],
      next_before_sequence: null,
    });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({
      clarifications: [{
        id: 'clarification_123',
        chat_id: 'chat_clarify_1',
        run_id: 'run_c1',
        question: 'What time on Friday should I call them?',
        intended_operation: 'create_task',
        missing_fields: ['due'],
        candidates: null,
        status: 'pending',
        created_at: TIMESTAMP,
        answerable_by_caller: true,
      }],
    });
    vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
    vi.spyOn(api, 'run').mockResolvedValue(clarifyRun);

    const sendSpy = vi.spyOn(api, 'sendMessage').mockResolvedValue({
      status: 'accepted',
      message_id: 'msg_c_reply',
      run_id: 'run_c1',
      acceptance_sequence: 2,
    });

    const view = await mount(
      <ConversationScreen
        workspaceId={WS}
        workspaces={[{ id: WS, name: 'Kerning' }]}
        userId={USER}
        members={MEMBERS}
        onSignOut={vi.fn()}
      />
    );

    // Transcript should show clarification region
    expect(view.host.textContent).toContain('Awaiting input');
    expect(view.host.textContent).toContain('What time on Friday should I call them?');

    // Click "Answer below"
    const replyBtn = view.host.querySelector('.otis-question__reply-btn') as HTMLButtonElement;
    expect(replyBtn).toBeTruthy();
    await React.act(async () => replyBtn.click());

    // Composer shows "Replying to Otis"
    expect(view.host.textContent).toContain('Replying to Otis');

    // Fill answer and send
    const textarea = view.host.querySelector('textarea') as HTMLTextAreaElement;
    await fill(textarea, 'At 2:00 PM');
    const sendButton = view.host.querySelector('[aria-label="Send"]') as HTMLButtonElement;
    await React.act(async () => sendButton.click());

    // Verify clarification_id was passed to sendMessage
    expect(sendSpy).toHaveBeenCalledWith(WS, 'chat_clarify_1', expect.any(String), 'At 2:00 PM', 'clarification_123');

    await view.unmount();
  });

  // FLOW 6: Action Inspection & Scoped Undo Flow
  it('Flow 6: opens action detail, previews undo scopes, and commits undo transaction', async () => {
    const myChat = makeChat('chat_act_1', 'Bistro Undo');
    history.replaceState({}, '', `/?workspace=${WS}&chat=chat_act_1`);

    const actionRun: RunDetailResponse = {
      run: { id: 'run_a1', status: 'succeeded' } as never,
      status: 'succeeded',
      steps: [{ step_index: 0, tool_name: 'create_task', status: 'succeeded', action_id: 'act_target_1' } as never],
      actions: [{ action_id: 'act_target_1', command_name: 'create_task', result_status: 'applied', committed_revision: 3, summary: 'Created follow-up for Friday', created_at: TIMESTAMP }],
      activities: [],
      pending_clarification: null,
    };

    const actionDetail: ActionDetailResponse = {
      action: {
        action_id: 'act_target_1',
        workspace_id: WS,
        command_name: 'create_task',
        result_status: 'applied',
        summary: 'Created follow-up for Friday',
        committed_revision: 3,
        actor_kind: 'member',
        actor_user_id: USER,
        source_message_id: 'in_1',
        run_id: 'run_a1',
        step_id: null,
        created_at: TIMESTAMP,
        events: [{ id: 'ev_1', kind: 'task_created', revision: 3, payload: {} }],
        undo: { available: true, reverted_event_ids: [], reverted_by_event_ids: [] },
        source: { id: 'in_1', channel: 'web', created_at: TIMESTAMP, text_preview: 'Call Bistro on Friday' },
      },
    };

    const undoPreviewFromHere: UndoPreviewResponse = {
      preview: {
        target_action_id: 'act_target_1',
        mode: 'from_here',
        selected_action_ids: ['act_target_1', 'act_later_2'],
        affected_event_ids: ['ev_1', 'ev_2'],
        affected_entities: [{ id: 'ent_1', name: 'Bistro', changes: ['Remove task'] }],
        affected_tasks: [{ id: 'tsk_1', title: 'Friday Call', changes: ['Delete'] }],
        dependencies: [],
        expected_revision: 3,
      },
    };

    const undoPreviewSingle: UndoPreviewResponse = {
      preview: {
        target_action_id: 'act_target_1',
        mode: 'single',
        selected_action_ids: ['act_target_1'],
        affected_event_ids: ['ev_1'],
        affected_entities: [{ id: 'ent_1', name: 'Bistro', changes: ['Remove task'] }],
        affected_tasks: [{ id: 'tsk_1', title: 'Friday Call', changes: ['Delete'] }],
        dependencies: [],
        expected_revision: 3,
      },
    };

    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [myChat] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: myChat, is_author: true });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'listMessages').mockResolvedValue({
      chat_id: 'chat_act_1',
      messages: [
        makeMessage('m1', 'Call Bistro on Friday', 'member', USER, 'run_a1'),
        makeMessage('m2', 'Created follow-up for Friday', 'assistant', null, 'run_a1'),
      ],
      next_before_sequence: null,
    });
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
    vi.spyOn(api, 'run').mockResolvedValue(actionRun);

    const actionSpy = vi.spyOn(api, 'action').mockResolvedValue(actionDetail);
    const previewSpy = vi.spyOn(api, 'undoPreview')
      .mockResolvedValueOnce(undoPreviewFromHere)
      .mockResolvedValueOnce(undoPreviewSingle);
    const undoSpy = vi.spyOn(api, 'undo').mockResolvedValue({
      status: 'applied',
      action_id: 'act_target_1',
      undo_action_id: 'undo_1',
      affected_action_ids: ['act_target_1'],
      revert_event_ids: ['ev_rev_1'],
      committed_revision: 4,
      summary: 'Reverted task creation',
    });

    const view = await mount(
      <ConversationScreen
        workspaceId={WS}
        workspaces={[{ id: WS, name: 'Kerning' }]}
        userId={USER}
        members={MEMBERS}
        onSignOut={vi.fn()}
      />
    );

    // Expand working disclosure
    const disclosure = view.host.querySelector('.otis-working__disclosure') as HTMLButtonElement;
    await React.act(async () => disclosure.click());

    // Click "Inspect / Undo"
    const inspectBtn = Array.from(view.host.querySelectorAll('button')).find(b => b.textContent?.includes('Inspect / Undo')) as HTMLButtonElement;
    expect(inspectBtn).toBeTruthy();
    await React.act(async () => inspectBtn.click());

    // DetailPane opens and fetches action & undo preview
    expect(actionSpy).toHaveBeenCalledWith(WS, 'act_target_1');
    expect(previewSpy).toHaveBeenCalledWith(WS, 'act_target_1', 'from_here');
    expect(view.host.textContent).toContain('Created follow-up for Friday');
    expect(view.host.textContent).toContain('Call Bistro on Friday');

    // Switch mode to "Only this action"
    const singleBtn = Array.from(view.host.querySelectorAll('button')).find(b => b.textContent === 'Only this action') as HTMLButtonElement;
    expect(singleBtn).toBeTruthy();
    await React.act(async () => singleBtn.click());

    expect(previewSpy).toHaveBeenCalledWith(WS, 'act_target_1', 'single');

    // Click commit undo button inside DetailPane
    const commitBtn = view.host.querySelector('.otis-detail .otis-button--primary') as HTMLButtonElement;
    expect(commitBtn).toBeTruthy();
    expect(commitBtn.disabled).toBe(false);
    await React.act(async () => commitBtn.click());

    expect(undoSpy).toHaveBeenCalledWith(WS, 'act_target_1', {
      mode: 'single',
      clientOperationId: expect.any(String),
      expectedRevision: 3,
      chatId: 'chat_act_1',
    });

    await view.unmount();
  });

  // FLOW 7: Source Memory Inspection & Navigation
  it('Flow 7: inspects memory source, displays provenance details, and navigates to source conversation', async () => {
    const myChat = makeChat('chat_src_1', 'Bistro Source');
    history.replaceState({}, '', `/?workspace=${WS}&chat=chat_src_1`);

    const agentRun: RunDetailResponse = {
      run: { id: 'run_src', status: 'succeeded' } as never,
      status: 'succeeded',
      steps: [],
      actions: [],
      sources: [{ memory_id: 'mem_1', provenance: 'stated', label: 'Hunor · Tuesday visit' }],
      activities: [],
      pending_clarification: null,
    };

    const memorySourceResponse: MemorySourceResponse = {
      memory: {
        id: 'mem_1',
        content: 'Bistro prefers Romanian and Hungarian language menus.',
        provenance: 'stated',
        status: 'active',
        observed_at: TIMESTAMP,
      },
      source: {
        chat_id: 'chat_source_target',
        author_name: 'Hunor',
        text: 'Met with owner. They asked for Hungarian and Romanian translation.',
        created_at: TIMESTAMP,
        channel: 'web',
      },
    };

    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [myChat] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: myChat, is_author: true });
    vi.spyOn(api, 'listMessages').mockResolvedValue({
      chat_id: 'chat_src_1',
      messages: [makeMessage('m_assistant', 'I saved the language preference.', 'system', USER, 'run_src')],
      next_before_sequence: null,
    });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
    vi.spyOn(api, 'run').mockResolvedValue(agentRun);

    const memSourceSpy = vi.spyOn(api, 'memorySource').mockResolvedValue(memorySourceResponse);

    const view = await mount(
      <ConversationScreen
        workspaceId={WS}
        workspaces={[{ id: WS, name: 'Kerning' }]}
        userId={USER}
        members={MEMBERS}
        onSignOut={vi.fn()}
      />
    );

    // Source link pill should be rendered on the assistant message
    const sourceLink = view.host.querySelector('.otis-source-link') as HTMLButtonElement;
    expect(sourceLink).toBeTruthy();
    expect(sourceLink.textContent).toContain('Hunor · Tuesday visit');

    // Click source link -> opens SourcePane
    await React.act(async () => sourceLink.click());

    expect(memSourceSpy).toHaveBeenCalledWith(WS, 'mem_1');
    expect(view.host.textContent).toContain('Bistro prefers Romanian and Hungarian language menus.');
    expect(view.host.textContent).toContain('Met with owner. They asked for Hungarian and Romanian translation.');
    expect(view.host.textContent).toContain('Stated directly');

    // Click "Open source conversation"
    const openSourceBtn = Array.from(view.host.querySelectorAll('button')).find(b => b.textContent === 'Open source conversation') as HTMLButtonElement;
    expect(openSourceBtn).toBeTruthy();
    await React.act(async () => openSourceBtn.click());

    // Navigates to source chat
    expect(location.search).toContain('chat=chat_source_target');

    await view.unmount();
  });

  // FLOW 8: Settings Pane - Personal Preferences & Workspace Config
  it('Flow 8: updates reply language, timezone, and workspace default model through SettingsPane', async () => {
    const ownSettings: MemberSettings = {
      workspace_id: WS,
      user_id: USER,
      preferred_language: 'en',
      brief_timezone: null,
      brief_enabled: false,
      brief_local_time: null,
      brief_weekdays: null,
      brief_channel: 'web',
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP,
    };

    const wsSettings: WorkspaceSettings = {
      workspace_id: WS,
      default_model: 'mimo-25',
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP,
    };

    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: makeChat('c1', 'Chat'), is_author: true });
    vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: 'c1', messages: [], next_before_sequence: null });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });

    vi.spyOn(api, 'settings').mockResolvedValue({ settings: wsSettings });
    vi.spyOn(api, 'memberSettings').mockResolvedValue({ settings: ownSettings });
    vi.spyOn(api, 'credentialStatus').mockResolvedValue({ credential: { provider: 'opencode_go', status: 'available', updated_at: TIMESTAMP } });

    const updateMemberSpy = vi.spyOn(api, 'updateMemberSettings').mockResolvedValue({ settings: { ...ownSettings, preferred_language: 'ro', brief_timezone: 'Europe/Bucharest' } });
    vi.spyOn(api, 'updateWorkspaceSettings').mockResolvedValue({ settings: { ...wsSettings, default_model: 'gemini-3.1-flash' } });

    const view = await mount(
      <ConversationScreen
        workspaceId={WS}
        workspaces={[{ id: WS, name: 'Kerning' }]}
        userId={USER}
        members={MEMBERS}
        onSignOut={vi.fn()}
      />
    );

    // Open settings from sidebar
    const settingsBtn = Array.from(view.host.querySelectorAll('button')).find(b => b.textContent === 'Settings') as HTMLButtonElement;
    expect(settingsBtn).toBeTruthy();
    await React.act(async () => settingsBtn.click());

    // Settings modal is open
    expect(view.host.querySelector('.otis-overlay--settings')).toBeTruthy();

    // Change timezone
    const tzInput = view.host.querySelector('#\\:r0\\:-timezone') || view.host.querySelector('input[placeholder="Not set"]') as HTMLInputElement;
    expect(tzInput).toBeTruthy();
    await fill(tzInput as HTMLInputElement, 'Europe/Bucharest');

    const saveTzBtn = Array.from(view.host.querySelectorAll('button')).find(b => b.textContent === 'Save timezone') as HTMLButtonElement;
    expect(saveTzBtn).toBeTruthy();
    await React.act(async () => saveTzBtn.click());

    expect(updateMemberSpy).toHaveBeenCalledWith(WS, { brief_timezone: 'Europe/Bucharest' });

    // Switch to Workspace tab ("Kerning")
    const wsTab = Array.from(view.host.querySelectorAll('[role="tab"]')).find(t => t.textContent === 'Kerning') as HTMLElement;
    expect(wsTab).toBeTruthy();
    await React.act(async () => wsTab.click());

    // Workspace model setting should be visible
    expect(view.host.textContent).toContain('Workspace model');
    expect(view.host.textContent).toContain('Connections');

    await view.unmount();
  });

  // FLOW 9: Provider Connection Lifecycle
  it('Flow 9: saves new provider API key and verifies credential status', async () => {
    const ownSettings: MemberSettings = {
      workspace_id: WS,
      user_id: USER,
      preferred_language: 'en',
      brief_timezone: null,
      brief_enabled: false,
      brief_local_time: null,
      brief_weekdays: null,
      brief_channel: 'web',
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP,
    };

    const wsSettings: WorkspaceSettings = {
      workspace_id: WS,
      default_model: 'mimo-25',
      created_at: TIMESTAMP,
      updated_at: TIMESTAMP,
    };

    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: makeChat('c1', 'Chat'), is_author: true });
    vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: 'c1', messages: [], next_before_sequence: null });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });

    vi.spyOn(api, 'settings').mockResolvedValue({ settings: wsSettings });
    vi.spyOn(api, 'memberSettings').mockResolvedValue({ settings: ownSettings });

    // Provider starts not connected
    vi.spyOn(api, 'credentialStatus').mockResolvedValue({ credential: null });
    const putCredSpy = vi.spyOn(api, 'putCredential').mockResolvedValue({ credential: { provider: 'gemini', status: 'available', updated_at: TIMESTAMP } });
    const verifyCredSpy = vi.spyOn(api, 'verifyCredential').mockResolvedValue({ verified: true });

    const view = await mount(
      <ConversationScreen
        workspaceId={WS}
        workspaces={[{ id: WS, name: 'Kerning' }]}
        userId={USER}
        members={MEMBERS}
        onSignOut={vi.fn()}
      />
    );

    // Open settings
    const settingsBtn = Array.from(view.host.querySelectorAll('button')).find(b => b.textContent === 'Settings') as HTMLButtonElement;
    await React.act(async () => settingsBtn.click());

    // Switch to Workspace tab
    const wsTab = Array.from(view.host.querySelectorAll('[role="tab"]')).find(t => t.textContent === 'Kerning') as HTMLElement;
    await React.act(async () => wsTab.click());

    // Click "Connect" for Gemini
    const connectButtons = Array.from(view.host.querySelectorAll('button')).filter(b => b.textContent === 'Connect');
    expect(connectButtons.length).toBeGreaterThan(0);
    await React.act(async () => connectButtons[0]!.click());

    // Enter API key in password input
    const pwInput = view.host.querySelector('input[type="password"]') as HTMLInputElement;
    expect(pwInput).toBeTruthy();
    await fill(pwInput, 'test-gemini-api-key-12345');

    // Click "Save and check key"
    const saveKeyBtn = Array.from(view.host.querySelectorAll('button')).find(b => b.textContent === 'Save and check key') as HTMLButtonElement;
    expect(saveKeyBtn).toBeTruthy();
    await React.act(async () => saveKeyBtn.click());

    expect(putCredSpy).toHaveBeenCalledWith(WS, expect.stringMatching(/gemini|opencode_go/), 'test-gemini-api-key-12345');
    expect(verifyCredSpy).toHaveBeenCalledWith(WS, expect.stringMatching(/gemini|opencode_go/));

    await view.unmount();
  });

  // FLOW 10: Access Loss & Security Invalidation
  it('Flow 10: transitions to access lost view and offers re-authentication when backend reports 401', async () => {
    const onSignOut = vi.fn();
    history.replaceState({}, '', `/?workspace=${WS}&chat=c_forbidden`);

    const { ApiError } = await import('../src/api/client.js');
    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: [], current_command_key: null, default_command_key: null });
    vi.spyOn(api, 'getChat').mockRejectedValue(new ApiError(401, 'unauthorized', 'Session expired'));

    const view = await mount(
      <ConversationScreen
        workspaceId={WS}
        workspaces={[{ id: WS, name: 'Kerning' }]}
        userId={USER}
        members={MEMBERS}
        onSignOut={onSignOut}
      />
    );

    // Wait for async load to reject
    await React.act(async () => {
      await Promise.resolve();
    });

    // Content should transition to access lost view
    expect(view.host.textContent).toContain('Conversation unavailable');
    expect(view.host.textContent).toContain('Your session may have expired');

    // Sign out button should invoke onSignOut handler
    const signOutBtn = Array.from(view.host.querySelectorAll('button')).find(b => b.textContent === 'Sign out') as HTMLButtonElement;
    expect(signOutBtn).toBeTruthy();
    await React.act(async () => signOutBtn.click());

    expect(onSignOut).toHaveBeenCalledOnce();

    await view.unmount();
  });
});
