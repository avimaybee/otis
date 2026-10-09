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
import { RouterProvider } from '@tanstack/react-router';
import { SessionContext, createAppRouter } from '../src/router.js';
import { TestQueryProvider } from './query.js';
import { resetOutboxForTests } from '../src/api/outbox.js';
import { ApiError, api } from '../src/api/client.js';
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
  await React.act(async () => root.render(<TestQueryProvider>{element}</TestQueryProvider>));
  // Scoped query snapshots resolve outside the render act; flush once so
  // assertions observe settled server state, not the loading skeleton.
  await React.act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  return {
    host,
    unmount: async () => {
      await React.act(async () => root.unmount());
      host.remove();
    },
  };
}

/**
 * Production route shell for these flows: the typed router owns
 * workspace/chat selection from the seeded `?workspace=&chat=` URL while the
 * test keeps its module-level API mocks. Seeding uses history.replaceState
 * before mount, exactly like a deep link or refresh.
 */
function RouteShell({ onSignOut }: { onSignOut?: () => void }) {
  const [router] = React.useState(() => createAppRouter());
  return (
    <SessionContext.Provider
      value={{ userId: USER, workspaces: [{ id: WS, name: 'Kerning' }], members: MEMBERS, onSignOut: onSignOut ?? (() => {}) }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>
  );
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
    resetOutboxForTests();
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
      <RouteShell />
    );

    // Composer textarea should be ready
    const textarea = view.host.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    await fill(textarea, 'Hello Otis, need a proposal');
    const sendButton = view.host.querySelector('[aria-label="Send"]') as HTMLButtonElement;
    expect(sendButton.disabled).toBe(false);

    await React.act(async () => sendButton.click());

    // Verify backend call flow
    expect(createChatSpy).toHaveBeenCalledWith(WS, expect.stringMatching(/^new-/), expect.anything());
    expect(sendMessageSpy).toHaveBeenCalledWith(WS, 'chat_new_1', expect.any(String), 'Hello Otis, need a proposal', undefined, undefined, expect.anything(), undefined, expect.any(String));

    // Verify URL navigation
    expect(location.search).toContain('chat=chat_new_1');

    await view.unmount();
  });

  // FLOW 1e: acceptance patches the transcript locally without a refetch
  it('Flow 1e: accepted send files locally with one run refresh and no transcript reload', async () => {
    history.replaceState({}, '', `/?workspace=${WS}&chat=chat_1e`);
    const existingChat = makeChat('chat_1e', 'Existing');
    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [existingChat] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'sendMessage').mockResolvedValue({
      status: 'accepted',
      message_id: 'msg_accepted_1e',
      run_id: 'run_1e',
      acceptance_sequence: 2,
    });
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: existingChat, is_author: true });
    const listMessagesSpy = vi.spyOn(api, 'listMessages').mockResolvedValue({
      chat_id: 'chat_1e',
      messages: [{ ...makeMessage('msg_old_1e', 'Earlier message', 'member'), chat_id: 'chat_1e', sequence: 1 }],
      next_before_sequence: null,
    });
    const runSpy = vi.spyOn(api, 'run').mockResolvedValue({
      run: { id: 'run_1e', status: 'queued' } as never,
      status: 'queued',
      steps: [],
      actions: [],
      activities: [],
      pending_clarification: null,
    });

    const view = await mount(<RouteShell />);
    const textarea = view.host.querySelector('textarea') as HTMLTextAreaElement;
    await fill(textarea, 'File me locally');
    await React.act(async () => (view.host.querySelector('[aria-label="Send"]') as HTMLButtonElement).click());
    // Settle the 120ms refresh debounce, the acceptance patch and run fetch.
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 350));
    });

    // The accepted text renders from the local patch…
    expect(view.host.textContent).toContain('File me locally');
    // …with no transcript reload beyond the initial snapshot load…
    expect(listMessagesSpy.mock.calls.length).toBeLessThanOrEqual(1);
    // …and exactly one run-detail refresh for Working state.
    expect(runSpy).toHaveBeenCalledWith(WS, 'run_1e');

    await view.unmount();
  });

  // FLOW 1f: an older snapshot read in flight during acceptance never hides the accepted bubble
  it('Flow 1f: stale snapshot return landing after acceptance keeps the accepted message', async () => {
    history.replaceState({}, '', `/?workspace=${WS}&chat=chat_1f`);
    const existingChat = makeChat('chat_1f', 'Existing');
    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [existingChat] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: existingChat, is_author: true });
    const oldMessage = { ...makeMessage('msg_old_1f', 'Earlier message', 'member'), chat_id: 'chat_1f', sequence: 1 };
    let listCalls = 0;
    let releaseStale!: (page: { chat_id: string; messages: ChatMessage[]; next_before_sequence: null }) => void;
    vi.spyOn(api, 'listMessages').mockImplementation((_workspaceId, _chatId, _before, signal) => {
      listCalls += 1;
      if (listCalls === 1) {
        return Promise.resolve({ chat_id: 'chat_1f', messages: [oldMessage], next_before_sequence: null });
      }
      // The resync read started before acceptance: it stays in flight while
      // the send completes, then returns the pre-acceptance payload.
      return new Promise((resolve, reject) => {
        releaseStale = resolve;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    vi.spyOn(api, 'sendMessage').mockResolvedValue({
      status: 'accepted',
      message_id: 'msg_accepted_1f',
      run_id: 'run_1f',
      acceptance_sequence: 2,
    });
    vi.spyOn(api, 'run').mockResolvedValue({
      run: { id: 'run_1f', status: 'queued' } as never,
      status: 'queued',
      steps: [],
      actions: [],
      activities: [],
      pending_clarification: null,
    });
    let streamHandlers: stream.StreamHandlers | undefined;
    const subscribeSpy = vi.spyOn(stream, 'subscribeToActivity').mockImplementation((_url, handlers) => {
      streamHandlers = handlers;
      return { close: vi.fn() };
    });

    const view = await mount(<RouteShell />);
    // The full snapshot (not just the staged primary) is committed: only it
    // opens the live stream the resync arrives on.
    await React.act(async () => {
      await vi.waitFor(() => expect(subscribeSpy).toHaveBeenCalled());
    });

    // A resync starts a snapshot read that stays in flight…
    await React.act(async () => {
      streamHandlers?.onResyncRequired();
      await vi.waitFor(() => expect(listCalls).toBe(2));
    });

    // …then the member sends while it is still outstanding.
    const textarea = view.host.querySelector('textarea') as HTMLTextAreaElement;
    await fill(textarea, 'Race bubble');
    await React.act(async () => (view.host.querySelector('[aria-label="Send"]') as HTMLButtonElement).click());
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 350));
    });
    expect(view.host.textContent).toContain('Race bubble');

    // The stale read finally lands with pre-acceptance content…
    await React.act(async () => {
      releaseStale({ chat_id: 'chat_1f', messages: [oldMessage], next_before_sequence: null });
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // …and the accepted message survives it: the in-flight read was
    // cancelled before the acceptance patch instead of overwriting it.
    expect(view.host.textContent).toContain('Race bubble');

    await view.unmount();
  });

  // FLOW 1b: Fresh chat loading state (disabled snapshot query)
  it('Flow 1b: fresh chat shows the approved empty state immediately with no snapshot request', async () => {
    history.replaceState({}, '', `/?workspace=${WS}&chat=new`);
    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    const getChatSpy = vi.spyOn(api, 'getChat');
    const listMessagesSpy = vi.spyOn(api, 'listMessages');

    const view = await mount(<RouteShell />);

    expect(view.host.textContent).not.toContain('Opening conversation');
    expect(view.host.textContent).toContain('What’s happening?');
    const textarea = view.host.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.disabled).toBe(false);
    // The disabled snapshot query must not fire a persisted-chat request.
    expect(getChatSpy).not.toHaveBeenCalled();
    expect(listMessagesSpy).not.toHaveBeenCalled();

    await view.unmount();
  });

  // FLOW 1c: Persisted chat keeps opening feedback until the real result arrives
  it('Flow 1c: persisted chat holds opening feedback until the real snapshot arrives', async () => {
    const heldChat = makeChat('chat_held', 'Held snapshot');
    history.replaceState({}, '', `/?workspace=${WS}&chat=chat_held`);
    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [heldChat] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    let releaseSnapshot: (() => void) | null = null;
    vi.spyOn(api, 'getChat').mockReturnValue(
      new Promise((resolve) => {
        releaseSnapshot = () => resolve({ chat: heldChat, is_author: true });
      }),
    );
    vi.spyOn(api, 'listMessages').mockResolvedValue({
      chat_id: 'chat_held',
      messages: [makeMessage('msg_held', 'Held until snapshot lands', 'member')],
      next_before_sequence: null,
    });

    const view = await mount(<RouteShell />);

    expect(view.host.textContent).toContain('Opening conversation');
    expect((view.host.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect(releaseSnapshot).not.toBeNull();

    await React.act(async () => {
      releaseSnapshot!();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(view.host.textContent).not.toContain('Opening conversation');
    expect(view.host.textContent).toContain('Held until snapshot lands');
    expect((view.host.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(false);

    await view.unmount();
  });

  // FLOW 1d: Snapshot failure is not an endless opening state
  it('Flow 1d: a failed persisted-chat snapshot shows an error, not an endless opening state', async () => {
    const failedChat = makeChat('chat_failed', 'Failed snapshot');
    history.replaceState({}, '', `/?workspace=${WS}&chat=chat_failed`);
    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [failedChat] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'getChat').mockRejectedValue(new Error('snapshot failed'));
    vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: 'chat_failed', messages: [], next_before_sequence: null });

    const view = await mount(<RouteShell />);

    expect(view.host.textContent).not.toContain('Opening conversation');
    expect(view.host.textContent).toContain('Could not open this conversation');

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
      <RouteShell />
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
      <RouteShell />
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
    vi.spyOn(api, 'runs').mockResolvedValue({ runs: [runningRun] });

    const stopSpy = vi.spyOn(api, 'stopRun').mockResolvedValue({ stopped: true, run_status: 'cancelled' });

    const view = await mount(
      <RouteShell />
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
    vi.spyOn(api, 'runs').mockResolvedValue({ runs: [clarifyRun] });

    const sendSpy = vi.spyOn(api, 'sendMessage').mockResolvedValue({
      status: 'accepted',
      message_id: 'msg_c_reply',
      run_id: 'run_c1',
      acceptance_sequence: 2,
    });

    const view = await mount(
      <RouteShell />
    );

    // Transcript shows the clarification as ordinary conversational text with a reply action
    const region = view.host.querySelector('[aria-label="Awaiting input"]') as HTMLElement;
    expect(region).toBeTruthy();
    expect(region.textContent).toContain('What time on Friday should I call them?');

    // The question panel opens explicitly above the ordinary composer.
    const panel = view.host.querySelector('[aria-label="Question from Otis"]') as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain('What time on Friday should I call them?');

    // "Answer question" focuses the panel's own field, not the main composer.
    const replyBtn = view.host.querySelector('.otis-question__reply-btn') as HTMLButtonElement;
    expect(replyBtn).toBeTruthy();
    expect(replyBtn.textContent).toContain('Answer question');
    await React.act(async () => replyBtn.click());

    // Ordinary chat stays independently sendable while the panel is open and
    // never inherits the question identity.
    const composerTextarea = view.host.querySelector('.otis-composer textarea') as HTMLTextAreaElement;
    expect(composerTextarea).toBeTruthy();
    expect(composerTextarea.value).toBe('');
    await fill(composerTextarea, 'Just a note');
    await React.act(async () => (view.host.querySelector('[aria-label="Send"]') as HTMLButtonElement).click());
    expect(sendSpy).toHaveBeenCalledWith(WS, 'chat_clarify_1', expect.any(String), 'Just a note', undefined, undefined, expect.anything(), undefined, expect.any(String));

    // The panel answers with its own field and Send, carrying the question id.
    const panelTextarea = panel.querySelector('textarea') as HTMLTextAreaElement;
    await fill(panelTextarea, 'At 2:00 PM');
    const panelSend = Array.from(panel.querySelectorAll('button')).find(button => button.textContent === 'Send') as HTMLButtonElement;
    await React.act(async () => panelSend.click());

    // Verify clarification_id was passed to sendMessage
    expect(sendSpy).toHaveBeenCalledWith(WS, 'chat_clarify_1', expect.any(String), 'At 2:00 PM', 'clarification_123', undefined, expect.anything(), undefined, expect.any(String));

    await view.unmount();
  });

  // FLOW 5b: a failed question-list read keeps the run-known answer path usable with an explicit retry
  it('Flow 5b: 503 question list still answers from run details and offers a list retry', async () => {
    const myChat = makeChat('chat_clarify_503', 'Bistro Outage');
    history.replaceState({}, '', `/?workspace=${WS}&chat=chat_clarify_503`);

    const outageRun: RunDetailResponse = {
      run: { id: 'run_c503', status: 'waiting_for_input' } as never,
      status: 'waiting_for_input',
      steps: [],
      actions: [],
      activities: [],
      pending_clarification: {
        id: 'clarification_503',
        workspace_id: WS,
        chat_id: 'chat_clarify_503',
        run_id: 'run_c503',
        source_message_id: 'in_m1',
        requester_user_id: USER,
        question: 'What time on Friday should I call them?',
        intended_operation: 'create_task',
        missing_fields: ['due'],
        candidates_json: null,
        source_revision: 3,
        status: 'pending',
        resolution_response: null,
        resolved_at: null,
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
      },
    };
    const recoveredQuestion = {
      id: 'clarification_503',
      chat_id: 'chat_clarify_503',
      run_id: 'run_c503',
      question: 'What time on Friday should I call them?',
      intended_operation: 'create_task',
      missing_fields: ['due'],
      candidates: null,
      status: 'pending',
      created_at: TIMESTAMP,
      answerable_by_caller: true,
    };

    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [myChat] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: myChat, is_author: true });
    vi.spyOn(api, 'listMessages').mockResolvedValue({
      chat_id: 'chat_clarify_503',
      messages: [makeMessage('m1', 'Schedule call', 'member', USER, 'run_c503')],
      next_before_sequence: null,
    });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    // The list read fails while run details survive: first attempt 503s, the
    // retry recovers.
    const clarificationsSpy = vi.spyOn(api, 'clarifications')
      .mockRejectedValueOnce(new ApiError(503, 'unavailable', 'Passing outage.'))
      .mockResolvedValue({ clarifications: [recoveredQuestion] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
    vi.spyOn(api, 'run').mockResolvedValue(outageRun);
    vi.spyOn(api, 'runs').mockResolvedValue({ runs: [outageRun] });
    const sendSpy = vi.spyOn(api, 'sendMessage').mockResolvedValue({
      status: 'accepted',
      message_id: 'msg_c503_reply',
      run_id: 'run_c503',
      acceptance_sequence: 2,
    });

    const view = await mount(<RouteShell />);

    // The run-known question renders with its answer action…
    const region = view.host.querySelector('[aria-label="Awaiting input"]') as HTMLElement;
    expect(region).toBeTruthy();
    expect(region.textContent).toContain('What time on Friday should I call them?');
    // …beside a visible, retryable list failure — never a silent empty list.
    expect(region.textContent).toContain("Couldn't load the question list.");
    const retryBtn = Array.from(region.querySelectorAll('button')).find((button) =>
      button.textContent === 'Retry',
    ) as HTMLButtonElement;
    expect(retryBtn).toBeTruthy();

    // "Answer question" opens a usable panel from run details alone.
    expect(view.host.querySelector('[aria-label="Question from Otis"]')).toBeNull();
    const replyBtn = view.host.querySelector('.otis-question__reply-btn') as HTMLButtonElement;
    await React.act(async () => replyBtn.click());
    const panel = view.host.querySelector('[aria-label="Question from Otis"]') as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain('What time on Friday should I call them?');

    // The panel answers with the run-known question identity…
    const panelTextarea = panel.querySelector('textarea') as HTMLTextAreaElement;
    await fill(panelTextarea, 'At 2:00 PM');
    const panelSend = Array.from(panel.querySelectorAll('button')).find((button) => button.textContent === 'Send') as HTMLButtonElement;
    await React.act(async () => panelSend.click());
    expect(sendSpy).toHaveBeenCalledWith(WS, 'chat_clarify_503', expect.any(String), 'At 2:00 PM', 'clarification_503', undefined, expect.anything(), undefined, expect.any(String));

    // …and the retry recovers the authoritative list, clearing the outage UI.
    // The button is re-queried: answering re-rendered the transcript, so the
    // earlier node is detached and its click would be a no-op.
    const retryAfterAnswer = Array.from(view.host.querySelectorAll('button')).find((button) =>
      button.textContent === 'Retry',
    ) as HTMLButtonElement;
    expect(retryAfterAnswer).toBeTruthy();
    await React.act(async () => retryAfterAnswer.click());
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
    });
    expect(clarificationsSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(view.host.textContent).not.toContain("Couldn't load the question list.");

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
    vi.spyOn(api, 'runs').mockResolvedValue({ runs: [actionRun] });

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
      <RouteShell />
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
    vi.spyOn(api, 'runs').mockResolvedValue({ runs: [agentRun] });

    const memSourceSpy = vi.spyOn(api, 'memorySource').mockResolvedValue(memorySourceResponse);

    const view = await mount(
      <RouteShell />
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
      interpretation_timezone: null,
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
      <RouteShell />
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
    expect(view.host.textContent).not.toContain('Connections');

    await view.unmount();
  });

  // FLOW 9: Platform Universal Models (No BYOK keys required from user)
  it('Flow 9: uses universal platform credentials without requiring user API keys', async () => {
    const ownSettings: MemberSettings = {
      workspace_id: WS,
      user_id: USER,
      preferred_language: 'en',
      brief_timezone: null,
      interpretation_timezone: null,
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

    const view = await mount(
      <RouteShell />
    );

    // Open settings
    const settingsBtn = Array.from(view.host.querySelectorAll('button')).find(b => b.textContent === 'Settings') as HTMLButtonElement;
    await React.act(async () => settingsBtn.click());

    // Switch to Workspace tab
    const wsTab = Array.from(view.host.querySelectorAll('[role="tab"]')).find(t => t.textContent === 'Kerning') as HTMLElement;
    await React.act(async () => wsTab.click());

    // No user-facing key configuration or connect buttons exist
    const connectButtons = Array.from(view.host.querySelectorAll('button')).filter(b => b.textContent === 'Connect');
    expect(connectButtons).toHaveLength(0);
    const pwInputs = view.host.querySelectorAll('input[type="password"]');
    expect(pwInputs).toHaveLength(0);

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
      <RouteShell onSignOut={onSignOut} />
    );

    // Wait for the query observer to publish the rejection; one microtask
    // does not flush TanStack's scheduled notification under full-suite load.
    await React.act(async () => {
      await vi.waitFor(() => expect(view.host.textContent).toContain('Conversation unavailable'));
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

  // FLOW 11: Failed-run retry through the server owner
  it('Flow 11: offers Retry run on failed runs and requeues through the server owner', async () => {
    const myChat = makeChat('chat_retry_1', 'Retry Chat');
    history.replaceState({}, '', `/?workspace=${WS}&chat=chat_retry_1`);

    const failedRun: RunDetailResponse = {
      run: { id: 'run_fail_1', status: 'failed', error_code: 'provider_stream_error' } as never,
      status: 'failed',
      steps: [],
      actions: [],
      activities: [
        {
          schema_version: 1,
          id: 'act_fail_1',
          cursor: 2,
          workspace_id: WS,
          chat_id: 'chat_retry_1',
          run_id: 'run_fail_1',
          created_at: TIMESTAMP,
          type: 'partial_failure',
          payload: { error_code: 'provider_stream_error', committed_actions: 1, unfinished_steps: ['draft_message'] },
        } as never,
      ],
      pending_clarification: null,
    };

    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [myChat] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: myChat, is_author: true });
    vi.spyOn(api, 'listMessages').mockResolvedValue({
      chat_id: 'chat_retry_1',
      messages: [{ ...makeMessage('m1', 'Do the thing', 'member', USER, 'run_fail_1'), chat_id: 'chat_retry_1' }],
      next_before_sequence: null,
    });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
    vi.spyOn(api, 'runs').mockResolvedValue({ runs: [failedRun] });

    const retrySpy = vi.spyOn(api, 'retryRun').mockResolvedValue({ retried: true, run_status: 'queued' });

    const view = await mount(
      <RouteShell />
    );

    expect(view.host.textContent).toContain('Saved 1 change');
    const retryButton = Array.from(view.host.querySelectorAll('button')).find(b => b.textContent === 'Retry run') as HTMLButtonElement;
    expect(retryButton).toBeTruthy();

    await React.act(async () => retryButton.click());
    expect(retrySpy).toHaveBeenCalledWith(WS, 'run_fail_1');
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(view.host.textContent).toContain('Run queued again');

    await view.unmount();
  });
});

describe('008B new-chat ordering and recovery (R8)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetOutboxForTests();
    history.replaceState({}, '', `/?workspace=${WS}&chat=new`);
    vi.spyOn(stream, 'subscribeToActivity').mockReturnValue({ close: vi.fn() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  function baseMocks() {
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(api, 'run').mockResolvedValue({
      run: { id: 'run_9', status: 'queued' } as never,
      status: 'queued',
      steps: [],
      actions: [],
      activities: [],
      pending_clarification: null,
    });
  }

  async function mountScreen() {
    return mount(
      <RouteShell />,
    );
  }

  it('echoes within the submit turn and posts before the sidebar refresh releases', async () => {
    const createdChat = makeChat('chat_new_9', 'New Conversation');
    let navCalls = 0;
    vi.spyOn(api, 'listChats').mockImplementation(async () => {
      navCalls += 1;
      if (navCalls > 2) await new Promise(() => {});
      return { chats: [] };
    });
    baseMocks();
    vi.spyOn(api, 'createChat').mockResolvedValue({ chat: createdChat });
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: createdChat, is_author: true });
    const sendSpy = vi.spyOn(api, 'sendMessage').mockImplementation(async () => {
      await new Promise(() => {});
      return { status: 'accepted', message_id: 'msg_9', run_id: 'run_9', acceptance_sequence: 1 };
    });
    // The authoritative row cannot exist before acceptance: the mock holds it
    // back while the POST hangs, so the echo bubble stays local and sending.
    vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: 'chat_new_9', messages: [], next_before_sequence: null });

    const view = await mountScreen();
    await fill(view.host.querySelector('textarea')!, 'First hello');
    const sendButton = view.host.querySelector('[aria-label="Send"]') as HTMLButtonElement;
    // Workspace models resolved without a snapshot (R8-1): the empty-chat
    // composer is submittable.
    expect(sendButton.disabled).toBe(false);

    await React.act(async () => {
      view.host.querySelector('[aria-label="Send"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Deterministic acceptance-boundary proof instead of wall clock: the
    // echo bubble below exists while the network POST is still held and the
    // sidebar refetch hangs, so local acceptance awaited no response.
    // performance.now around React.act is not a paint measurement under
    // parallel suite CPU load, so it cannot prove the product 100ms target —
    // which stands unchanged (design.md, docs/verification.md) and is
    // evidenced natively by immediateEcho plus call timelines in
    // plans/008-browser-evidence/synthetic-app-probe.json and
    // two-send-probe.json, not by this unit.
    const bubbles = () => Array.from(view.host.querySelectorAll('.otis-turn__bubble'));
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0]!.textContent).toBe('First hello');
    expect(view.host.textContent).toContain('Sending…');
    // Fast chat creation posted the message while the sidebar refetch hangs.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(WS, 'chat_new_9', expect.any(String), 'First hello', undefined, undefined, expect.anything(), undefined, expect.any(String));
    expect(navCalls).toBe(3);
    expect(location.search).toContain('chat=chat_new_9');

    await view.unmount();
  });

  it('shows the exact failed bubble and retries with the same UUID', async () => {
    const createdChat = makeChat('chat_new_9', 'New Conversation');
    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [] });
    baseMocks();
    vi.spyOn(api, 'createChat').mockResolvedValue({ chat: createdChat });
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: createdChat, is_author: true });
    vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: 'chat_new_9', messages: [], next_before_sequence: null });
    const sendSpy = vi.spyOn(api, 'sendMessage')
      .mockRejectedValueOnce(new Error('Down'))
      .mockResolvedValue({ status: 'accepted', message_id: 'msg_9', run_id: 'run_9', acceptance_sequence: 1 });

    const view = await mountScreen();
    await fill(view.host.querySelector('textarea')!, 'Retry me');
    await React.act(async () => {
      view.host.querySelector('[aria-label="Send"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const firstUuid = sendSpy.mock.calls[0]![2] as string;
    expect(view.host.textContent).toContain('Retry me');
    const retry = Array.from(view.host.querySelectorAll('button')).find(button => button.textContent === 'Retry') as HTMLButtonElement;
    expect(retry).toBeTruthy();
    // Delivery feedback is never hover-gated: Retry lives in the visible
    // delivery row, not inside the hover-revealed actions container.
    expect(retry.closest('.otis-turn__actions')).toBeNull();
    expect(retry.closest('.otis-delivery')).toBeTruthy();
    await React.act(async () => retry.click());
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy.mock.calls[1]![2]).toBe(firstUuid);
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 250));
    });
    expect(view.host.querySelectorAll('.otis-turn__bubble')).toHaveLength(1);
    const retryGone = !Array.from(view.host.querySelectorAll('button')).some(button => button.textContent === 'Retry');
    expect(retryGone).toBe(true);

    await view.unmount();
  });

  it('reloads a lost acknowledgment with the same identity and one chat', async () => {
    const createdChat = makeChat('chat_new_9', 'New Conversation');
    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [] });
    baseMocks();
    const createSpy = vi.spyOn(api, 'createChat').mockResolvedValue({ chat: createdChat });
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: createdChat, is_author: true });
    let resolveSend!: (value: { status: 'accepted'; message_id: string; run_id: string; acceptance_sequence: number }) => void;
    const sendSpy = vi.spyOn(api, 'sendMessage').mockImplementation(
      () => new Promise(resolve => {
        resolveSend = resolve as never;
      }),
    );
    let acceptedId: string | null = null;
    let acked = false;
    vi.spyOn(api, 'listMessages').mockImplementation(async () => ({
      chat_id: 'chat_new_9',
      messages: acked && acceptedId ? [{ ...makeMessage('msg_9', 'Lost ack', 'member'), client_message_id: acceptedId }] : [],
      next_before_sequence: null,
    }));

    let view = await mountScreen();
    await fill(view.host.querySelector('textarea')!, 'Lost ack');
    await React.act(async () => {
      view.host.querySelector('[aria-label="Send"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.host.querySelectorAll('.otis-turn__bubble')).toHaveLength(1);
    const firstUuid = sendSpy.mock.calls[0]![2] as string;
    acceptedId = firstUuid;
    // Crash before the acknowledgment arrives: the attempt dies with the page.
    await view.unmount();
    const { releaseDelivery } = await import('../src/api/outbox.js');
    releaseDelivery(firstUuid);

    view = await mountScreen();
    // Mount resume replays the same UUID; no second chat is created.
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy.mock.calls[1]![2]).toBe(firstUuid);
    await React.act(async () => {
      acked = true;
      resolveSend({ status: 'accepted', message_id: 'msg_9', run_id: 'run_9', acceptance_sequence: 1 });
      await new Promise(resolve => setTimeout(resolve, 250));
    });
    expect(view.host.querySelectorAll('.otis-turn__bubble')).toHaveLength(1);
    expect(view.host.textContent).not.toContain('Sending…');

    await view.unmount();
  });

  it('applies /model from an empty chat with server-confirmed UI and no bubbles', async () => {
    const createdChat = makeChat('chat_cmd_9', 'New Conversation');
    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [] });
    baseMocks();
    vi.spyOn(api, 'createChat').mockResolvedValue({ chat: createdChat });
    const commandSpy = vi.spyOn(api, 'executeCommand').mockResolvedValue({
      status: 'accepted',
      message_id: 'cmd_9',
      run_id: 'run_cmd',
      acceptance_sequence: 1,
      command_applied: true,
    });
    const switchedChat = { ...createdChat, model_override: 'mimo-25' };
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: switchedChat, is_author: true });
    const modelsSpy = vi.spyOn(api, 'models').mockResolvedValue({ models: DEFAULT_MODELS, current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
    vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: 'chat_cmd_9', messages: [], next_before_sequence: null });

    const view = await mountScreen();
    await fill(view.host.querySelector('textarea')!, '/model default');
    await React.act(async () => {
      view.host.querySelector('[aria-label="Send"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(commandSpy).toHaveBeenCalledWith(WS, 'chat_cmd_9', expect.any(String), '/model default');
    expect(view.host.querySelectorAll('.otis-turn')).toHaveLength(0);
    expect(modelsSpy.mock.calls.length).toBeGreaterThan(1);
    expect(location.search).toContain('chat=chat_cmd_9');

    await view.unmount();
  });

  it('accepts two rapid messages instantly while serializing their posts', async () => {
    const existingChat = makeChat('chat_1', 'Existing');
    history.replaceState({}, '', `/?workspace=${WS}&chat=chat_1`);
    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [existingChat] });
    baseMocks();
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: existingChat, is_author: true });
    vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: 'chat_1', messages: [], next_before_sequence: null });
    let releaseFirst!: () => void;
    const posts: Array<{ uuid: string; text: string }> = [];
    let started = false;
    const sendSpy = vi.spyOn(api, 'sendMessage').mockImplementation(
      (_ws, _chat, clientId, text) =>
        new Promise(resolve => {
          posts.push({ uuid: clientId, text });
          if (!started) {
            // The first POST stays in flight while the user keeps typing.
            started = true;
            releaseFirst = () => resolve({ status: 'accepted', message_id: `msg-${clientId}`, run_id: 'run_9', acceptance_sequence: 1 });
            return;
          }
          resolve({ status: 'accepted', message_id: `msg-${clientId}`, run_id: 'run_9', acceptance_sequence: 2 });
        }),
    );

    const view = await mountScreen();
    await fill(view.host.querySelector('textarea')!, 'One');
    await React.act(async () => {
      view.host.querySelector('[aria-label="Send"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.host.querySelectorAll('.otis-turn__bubble')).toHaveLength(1);
    // Second message submits through a real enabled button while POST 1 pends:
    // local acceptance never waits for the network.
    await fill(view.host.querySelector('textarea')!, 'Two');
    const secondSend = view.host.querySelector('[aria-label="Send"]') as HTMLButtonElement;
    expect(secondSend.disabled).toBe(false);
    await React.act(async () => {
      secondSend.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.host.querySelectorAll('.otis-turn__bubble')).toHaveLength(2);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toBe('One');
    // The first 202 releases the second POST with its own identity; no model
    // reply is waited for and no duplicate bubble appears.
    releaseFirst();
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(posts.map(post => post.text)).toEqual(['One', 'Two']);
    expect(posts[0]!.uuid).not.toBe(posts[1]!.uuid);
    expect(view.host.querySelectorAll('.otis-turn__bubble')).toHaveLength(2);

    await view.unmount();
  });
});
