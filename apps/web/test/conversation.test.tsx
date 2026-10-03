/** @vitest-environment happy-dom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatMessage, PublicActivity, RunDetailResponse } from '@otis/contracts';
import { Composer } from '../src/components/Composer.js';
import { Transcript, activityToSteps, stepsFromRun } from '../src/components/Transcript.js';
import { HistoryNav } from '../src/components/HistoryNav.js';
import { mergeActivity } from '../src/hooks/useActivityStream.js';

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.restoreAllMocks());
async function mount(element: React.ReactElement) {
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  await React.act(async () => root.render(element));
  return { host, unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}
async function fill(input: HTMLTextAreaElement, value: string) {
  await React.act(async () => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const COMMANDS = [
  { name: 'model', summary: 'Show or set the model for this chat.', usage: '/model', available: true, deterministic: true },
  { name: 'help', summary: 'List the available commands.', usage: '/help', available: true, deterministic: true },
];
const message = (overrides: Partial<ChatMessage> & { id: string; content_text: string }): ChatMessage => ({ workspace_id: 'ws_1', chat_id: 'chat_1', author_user_id: 'usr_1', author_kind: 'member', channel: 'web', inbound_message_id: null, client_message_id: null, media_id: null, run_id: null, sequence: 1, created_at: '2026-10-02T10:00:00.000Z', updated_at: '2026-10-02T10:00:00.000Z', ...overrides });
const activity = (id: string, cursor: number, type: PublicActivity['type'], payload: unknown): PublicActivity => ({ schema_version: 1, id, cursor, workspace_id: 'ws_1', chat_id: 'chat_1', run_id: 'run_1', type, payload, created_at: '2026-10-02T10:00:00.000Z' });

describe('Composer', () => {
  it('opens slash suggestions and inserts editable text without submitting', async () => {
    const onSend = vi.fn(); const view = await mount(<Composer running={false} queuedCount={0} commands={COMMANDS} onSend={onSend}/>);
    await fill(view.host.querySelector('textarea')!, '/');
    expect(view.host.querySelector('[role="listbox"]')).toBeTruthy();
    await React.act(async () => (view.host.querySelector('[role="option"]') as HTMLButtonElement).click());
    expect(view.host.querySelector('textarea')!.value).toBe('/model '); expect(onSend).not.toHaveBeenCalled(); await view.unmount();
  });
  it('opens real tools through Plus, preserves the draft, and dismisses slash suggestions safely', async () => {
    const onSend = vi.fn(); const view = await mount(<Composer running={false} queuedCount={0} commands={COMMANDS} onSend={onSend}/>);
    await fill(view.host.querySelector('textarea')!, 'Keep this draft.');
    await React.act(async () => (view.host.querySelector('[aria-label="Chat tools"]') as HTMLButtonElement).click());
    expect(view.host.querySelector('[role="listbox"][aria-label="Chat tools"]')).toBeTruthy();
    await React.act(async () => (view.host.querySelector('[role="option"]') as HTMLButtonElement).click());
    expect(view.host.querySelector('[aria-label="Models"]')).toBeTruthy(); expect(view.host.querySelector('textarea')!.value).toBe('Keep this draft.');
    await React.act(async () => (view.host.querySelector('[role="option"]') as HTMLButtonElement).click());
    expect(onSend).toHaveBeenCalledWith('/model default'); expect(view.host.querySelector('textarea')!.value).toBe('Keep this draft.');
    await fill(view.host.querySelector('textarea')!, '/');
    await React.act(async () => view.host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(view.host.querySelector('[role="listbox"]')).toBeNull(); expect(view.host.querySelector('textarea')!.value).toBe('/'); await view.unmount();
  });
  it('sends non-empty text, ignores an empty draft, and clears only accepted input', async () => {
    const onSend = vi.fn().mockResolvedValue(true); const view = await mount(<Composer running={false} queuedCount={0} commands={COMMANDS} onSend={onSend}/>);
    expect((view.host.querySelector('.otis-composer__send') as HTMLButtonElement).disabled).toBe(true);
    await fill(view.host.querySelector('textarea')!, 'Restaurant 2 wants the website.');
    await React.act(async () => (view.host.querySelector('.otis-composer__send') as HTMLButtonElement).click());
    expect(onSend).toHaveBeenCalledWith('Restaurant 2 wants the website.'); expect(view.host.querySelector('textarea')!.value).toBe(''); await view.unmount();
  });
  it('retains a failed draft across remount and removes storage only after acceptance', async () => {
    const key = 'otis:draft:test-retry'; const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    let view = await mount(<Composer draftKey={key} running={false} queuedCount={0} commands={COMMANDS} onSend={onSend}/>);
    await fill(view.host.querySelector('textarea')!, 'Keep the price unchanged.');
    await React.act(async () => (view.host.querySelector('.otis-composer__send') as HTMLButtonElement).click());
    expect(view.host.querySelector('textarea')!.value).toBe('Keep the price unchanged.'); await view.unmount();
    view = await mount(<Composer draftKey={key} running={false} queuedCount={0} commands={COMMANDS} onSend={onSend}/>);
    expect(view.host.querySelector('textarea')!.value).toBe('Keep the price unchanged.');
    await React.act(async () => (view.host.querySelector('.otis-composer__send') as HTMLButtonElement).click());
    expect(view.host.querySelector('textarea')!.value).toBe(''); expect(sessionStorage.getItem(key)).toBeNull(); await view.unmount();
  });
  it('does not submit an IME composition or mobile Enter', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ media: query, matches: false, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }));
    const onSend = vi.fn(); const view = await mount(<Composer running={false} queuedCount={0} commands={COMMANDS} onSend={onSend}/>);
    const input = view.host.querySelector('textarea')!; await fill(input, 'ș și ț, ő és ű');
    await React.act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onSend).not.toHaveBeenCalled(); expect(input.value).toBe('ș și ț, ő és ű'); await view.unmount();
  });
  it('keeps the composer available to steer working runs without a separate Stop control', async () => {
    const view = await mount(<Composer running queuedCount={0} commands={COMMANDS} onSend={vi.fn()}/>);
    expect(view.host.querySelector('[aria-label="Steer Otis"]')).toBeTruthy(); expect(view.host.textContent).toContain('Steer the current work');
    expect(view.host.querySelector('.otis-composer__stop')).toBeNull(); await view.unmount();
  });
  it('renders Codex-style Question Card when replyTo is present, submits candidate on tap or keyboard', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onCancel = vi.fn();
    const view = await mount(
      <Composer
        running={false}
        queuedCount={0}
        commands={COMMANDS}
        replyTo={{
          question: 'When should the offer be ready?',
          missing_fields: ['due'],
          onCancel,
        }}
        onSend={onSend}
      />
    );
    expect(view.host.querySelector('.otis-question-card')).toBeTruthy();
    expect(view.host.textContent).toContain('When should the offer be ready?');
    const options = Array.from(view.host.querySelectorAll('.otis-question-card__option'));
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options[0]?.textContent).toContain('Friday');
    
    // Tap candidate 1
    await React.act(async () => (options[0] as HTMLButtonElement).click());
    expect(onSend).toHaveBeenCalledWith('Friday');

    // Test dismiss/cancel
    await React.act(async () => (view.host.querySelector('.otis-question-card__close') as HTMLButtonElement).click());
    expect(onCancel).toHaveBeenCalledOnce();
    await view.unmount();
  });
  it('allows custom write-in response and skip in Question Card', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onCancel = vi.fn();
    const view = await mount(
      <Composer
        running={false}
        queuedCount={0}
        commands={COMMANDS}
        replyTo={{
          question: 'Confirm deleting draft?',
          candidates: ['Yes, delete', 'No, keep'],
          onCancel,
        }}
        onSend={onSend}
      />
    );
    const input = view.host.querySelector('.otis-question-card__custom-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Maybe next week');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const sendBtn = view.host.querySelector('.otis-question-card__send') as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(false);
    await React.act(async () => sendBtn.click());
    expect(onSend).toHaveBeenCalledWith('Maybe next week');

    // Test skip
    const skipBtn = view.host.querySelector('.otis-question-card__skip') as HTMLButtonElement;
    await React.act(async () => skipBtn.click());
    expect(onCancel).toHaveBeenCalledOnce();
    await view.unmount();
  });
  it('synchronizes draftValue prop into composer input', async () => {
    const view = await mount(<Composer running={false} queuedCount={0} commands={COMMANDS} draftValue="Prior draft to edit" onSend={vi.fn()}/>);
    expect(view.host.querySelector('textarea')!.value).toBe('Prior draft to edit');
    await view.unmount();
  });
  it('renders modern ChatGPT-inspired composer capsule with Think toggle, Mic button, and disclaimer', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const view = await mount(
      <Composer
        running={false}
        queuedCount={0}
        commands={COMMANDS}
        models={[
          {
            command_key: 'gemini-3.1-flash-lite',
            display_name: 'Gemini 3.1 Flash-Lite',
            available: true,
            is_current: true,
            is_default: true,
            voice_available: false,
            native_audio_supported: false,
            provider: 'gemini',
            thinking: {
              current_choice_id: null,
              effective_choice_id: 'default',
              is_default: true,
              state: 'supported',
              choices: [
                { id: 'low', label: 'Low' },
                { id: 'high', label: 'High' },
              ],
            },
          },
        ]}
        onSend={onSend}
      />
    );
    expect(view.host.querySelector('.otis-composer__disclaimer')).toBeTruthy();
    expect(view.host.textContent).toContain('Otis can make mistakes');

    // Think button
    const thinkBtn = view.host.querySelector('.otis-composer__think-btn') as HTMLButtonElement;
    expect(thinkBtn).toBeTruthy();
    expect(thinkBtn.getAttribute('aria-expanded')).toBe('false');
    await React.act(async () => thinkBtn.click());
    expect(thinkBtn.getAttribute('aria-expanded')).toBe('true');

    // Menu should be open with choices
    const menu = view.host.querySelector('.otis-thinking-menu');
    expect(menu).toBeTruthy();
    expect(view.host.textContent).toContain('Provider default');
    expect(view.host.textContent).toContain('High');

    // Select High
    const highOption = Array.from(view.host.querySelectorAll('.otis-thinking-menu__item')).find(el => el.textContent?.includes('High')) as HTMLButtonElement;
    expect(highOption).toBeTruthy();
    await React.act(async () => highOption.click());
    expect(onSend).toHaveBeenCalledWith('/thinking high');

    // Mic button
    const micBtn = view.host.querySelector('.otis-composer__mic-btn') as HTMLButtonElement;
    expect(micBtn).toBeTruthy();

    // Plus button for tools
    const plusBtn = view.host.querySelector('.otis-composer__plus') as HTMLButtonElement;
    expect(plusBtn).toBeTruthy();

    await view.unmount();
  });
  it('opens tool drawer on clicking + button, allowing model and command selection', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const view = await mount(
      <Composer
        running={false}
        queuedCount={0}
        commands={COMMANDS}
        models={[
          { command_key: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', available: true, is_current: true, is_default: true, voice_available: true },
        ]}
        onSend={onSend}
      />
    );
    const plusBtn = view.host.querySelector('.otis-composer__plus') as HTMLButtonElement;
    await React.act(async () => plusBtn.click());

    // Tool menu is open
    const picker = view.host.querySelector('.otis-picker');
    expect(picker).toBeTruthy();
    expect(view.host.textContent).toContain('Model');
    expect(view.host.textContent).toContain('Today’s Brief');

    // Click Model to open models submenu
    const modelOption = Array.from(view.host.querySelectorAll('.otis-picker__option')).find(el => el.textContent?.includes('Model')) as HTMLButtonElement;
    expect(modelOption).toBeTruthy();
    await React.act(async () => modelOption.click());

    // In model submenu
    expect(view.host.querySelector('.otis-picker__back')).toBeTruthy();
    expect(view.host.textContent).toContain('Gemini 2.5 Pro');

    // Choose Gemini 2.5 Pro
    const geminiOption = Array.from(view.host.querySelectorAll('.otis-picker__option')).find(el => el.textContent?.includes('Gemini 2.5 Pro')) as HTMLButtonElement;
    await React.act(async () => geminiOption.click());
    expect(onSend).toHaveBeenCalledWith('/model gemini-2.5-pro');

    await view.unmount();
  });
  it('toggles multiline layout when draft contains multiple lines or newlines', async () => {
    const view = await mount(<Composer running={false} queuedCount={0} commands={COMMANDS} onSend={vi.fn()} />);
    const textarea = view.host.querySelector('textarea')!;
    expect(view.host.querySelector('.otis-composer__field--multiline')).toBeNull();

    await fill(textarea, 'Line one\nLine two');
    expect(view.host.querySelector('.otis-composer__field--multiline')).toBeTruthy();
    await view.unmount();
  });
});

describe('Transcript', () => {
  it('keeps assistant text unboxed and member turns in one restrained bubble', async () => {
    const view = await mount(<Transcript messages={[message({ id: 'm1', content_text: 'Restaurant 2 wants the website.' }), message({ id: 'm2', content_text: 'When should the offer be ready?', author_kind: 'system', author_user_id: null })]} members={{}} currentUserId="usr_1" steps={[]} onInspectAction={vi.fn()}/>);
    expect(view.host.querySelector('.otis-turn--member .otis-turn__bubble')?.textContent).toContain('Restaurant 2');
    expect(view.host.querySelector('.otis-turn--agent .otis-turn__body')?.closest('.otis-turn__bubble')).toBeNull(); await view.unmount();
  });
  it('offers an empty-chat invitation without a suggestion grid', async () => {
    const view = await mount(<Transcript messages={[]} members={{}} currentUserId="usr_1" steps={[]} onInspectAction={vi.fn()}/>);
    expect(view.host.textContent).toContain('What’s happening?'); expect(view.host.querySelectorAll('button')).toHaveLength(0); await view.unmount();
  });
  it('offers undo only on successful writes and opens their detail', async () => {
    const onInspect = vi.fn(); const view = await mount(<Transcript messages={[]} members={{}} currentUserId="usr_1" run={{ status: 'succeeded' } as never} steps={[{ id: 's1', label: 'Reading notes', state: 'running' }, { id: 's2', label: 'Saving follow-up', state: 'succeeded', actionId: 'act_1' }]} onInspectAction={onInspect}/>);
    expect(view.host.textContent).toContain('Worked · 2 steps');
    await React.act(async () => (view.host.querySelector('.otis-working__disclosure') as HTMLButtonElement).click());
    const undo = Array.from(view.host.querySelectorAll('button')).filter(button => button.textContent === 'Inspect / Undo'); expect(undo).toHaveLength(1);
    await React.act(async () => undo[0]!.click()); expect(onInspect).toHaveBeenCalledWith('act_1'); await view.unmount();
  });
  it('uses the persisted author name for teammate history', async () => {
    const view = await mount(<Transcript messages={[message({ id: 'teammate', content_text: 'Visited Bistro', author_user_id: 'usr_2', author_display_name: 'Hunor' })]} members={{}} currentUserId="usr_1" steps={[]} onInspectAction={vi.fn()}/>);
    expect(view.host.querySelector('.otis-turn__meta')?.textContent).toBe('Hunor'); await view.unmount();
  });
  it('renders structured prose while excluding HTML, dangerous links and external image loads', async () => {
    const view = await mount(<Transcript messages={[message({ id: 'markdown', content_text: '**Offer**\n\n- Romanian\n- Hungarian\n\n[Unsafe](javascript:alert(1))\n\n<img src="https://elsewhere.test/track">\n\n![remote](https://elsewhere.test/track)', author_kind: 'system', author_user_id: null })]} members={{}} currentUserId="usr_1" steps={[]} onInspectAction={vi.fn()}/>);
    expect(view.host.querySelector('strong')?.textContent).toBe('Offer'); expect(view.host.querySelectorAll('li')).toHaveLength(2);
    expect(view.host.querySelector('img')).toBeNull(); expect(view.host.querySelector('a')?.getAttribute('href')).not.toContain('javascript:'); await view.unmount();
  });
  it('renders awaiting input callout for pending clarifications with working reply action', async () => {
    const onReply = vi.fn();
    const view = await mount(
      <Transcript
        messages={[message({ id: 'm1', content_text: 'Create offer', run_id: 'r1' })]}
        members={{}}
        currentUserId="usr_1"
        run={{
          status: 'waiting_for_input',
          run: { id: 'r1' } as never,
          steps: [],
          actions: [],
          activities: [],
          pending_clarification: {
            id: 'c1',
            question: 'When should the offer be ready?',
          } as never,
        }}
        steps={[]}
        onInspectAction={vi.fn()}
        onReply={onReply}
      />
    );
    expect(view.host.textContent).toContain('Awaiting input');
    expect(view.host.textContent).toContain('When should the offer be ready?');
    const replyBtn = view.host.querySelector('.otis-question__reply-btn') as HTMLButtonElement;
    expect(replyBtn).toBeTruthy();
    await React.act(async () => replyBtn.click());
    expect(onReply).toHaveBeenCalledWith('c1');
    await view.unmount();
  });
  it('renders message micro-actions with working copy and edit triggers', async () => {
    const onEdit = vi.fn();
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    });
    const view = await mount(
      <Transcript
        messages={[
          message({ id: 'm1', content_text: 'My business note', author_user_id: 'usr_1' }),
          message({ id: 'm2', content_text: 'Answer from Otis', author_kind: 'system', author_user_id: null }),
        ]}
        members={{}}
        currentUserId="usr_1"
        steps={[]}
        onInspectAction={vi.fn()}
        onEditMessage={onEdit}
      />
    );
    const copyButtons = view.host.querySelectorAll('[aria-label="Copy message"], [aria-label="Copy response"]');
    expect(copyButtons.length).toBe(2);

    await React.act(async () => (copyButtons[0] as HTMLButtonElement).click());
    expect(writeTextMock).toHaveBeenCalledWith('My business note');

    const editBtn = view.host.querySelector('[aria-label="Edit message in composer"]') as HTMLButtonElement;
    expect(editBtn).toBeTruthy();
    await React.act(async () => editBtn.click());
    expect(onEdit).toHaveBeenCalledWith('My business note');
    await view.unmount();
  });
});

describe('Activity handling', () => {
  it('orders persisted rows and suppresses duplicate delivery', () => {
    const first = activity('a1', 1, 'text_chunk', { text: 'Hello' }); const second = activity('a2', 2, 'text_chunk', { text: ' world' });
    expect(mergeActivity([second], first)).toEqual([first, second]); expect(mergeActivity([first], first)).toEqual([first]);
  });
  it('does not infer saved state or offer undo without a receipt', () => {
    const row = activity('a', 1, 'action_applied', { action_id: 'unconfirmed', command_name: 'create_task' });
    expect(activityToSteps([row], [])[0]).toMatchObject({ state: 'running', actionId: undefined });
  });
  it('shows a planned tool as running only after persisted step_started', () => {
    const run = { steps: [{ step_index: 0, tool_name: 'create_task', status: 'planned', action_id: null }], actions: [] } as unknown as RunDetailResponse;
    expect(stepsFromRun(run, [])[0]?.state).toBe('queued'); expect(stepsFromRun(run, [activity('start', 1, 'step_started', { step_index: 0 })])[0]?.state).toBe('running');
  });
});

describe('History navigation', () => {
  it('uses a drawer on mobile with functional history and settings actions', async () => {
    const onSelect = vi.fn(); const onSettings = vi.fn();
    const view = await mount(<HistoryNav variant="drawer" workspaceId="ws_1" workspaceName="Kerning" workspaces={[{ id: 'ws_1', name: 'Kerning' }]} ownChats={[{ id: 'chat_1', title: 'Bistro', author_user_id: 'usr_1' } as never]} teamChats={[]} activeChatId="chat_1" onSelectChat={onSelect} onNewChat={vi.fn()} onSwitchWorkspace={vi.fn()} onOpenSettings={onSettings} onClose={vi.fn()}/>);
    expect(view.host.querySelector('dialog')).toBeTruthy();
    await React.act(async () => Array.from(view.host.querySelectorAll('button')).find(button => button.textContent === 'Bistro')!.click()); expect(onSelect).toHaveBeenCalledWith('chat_1');
    await React.act(async () => Array.from(view.host.querySelectorAll('button')).find(button => button.textContent === 'Settings')!.click()); expect(onSettings).toHaveBeenCalledOnce(); await view.unmount();
  });
});
