/** @vitest-environment happy-dom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatMessage, PublicActivity, RunDetailResponse } from '@otis/contracts';
import { Composer } from '../src/components/Composer.js';
import { Transcript, activityToSteps, stepsFromRun } from '../src/components/Transcript.js';
import { HistoryNav } from '../src/components/HistoryNav.js';
import { mergeActivity } from '../src/hooks/useActivityStream.js';
import {
  clearTransientPreview,
  dropCoveredTransientPreview,
  mergeTransientPreview,
  transientTextForRun,
} from '../src/hooks/useActivityStream.js';
import { applyAcceptedMessage, applyAnswerSaved, type ChatSnapshot } from '../src/api/snapshot.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

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
  it('applies a model picked with a slash command without sending a chat message', async () => {
    const onSend = vi.fn(); const onCommand = vi.fn().mockResolvedValue(true);
    const models = [{ command_key: 'mimo-25', display_name: 'MiMo V2.5', provider: 'opencode_go', native_audio_supported: true, voice_available: false, available: true, is_current: true, is_default: true }];
    const view = await mount(<Composer running={false} queuedCount={0} commands={COMMANDS} models={models} onCommand={onCommand} onSend={onSend}/>);
    await fill(view.host.querySelector('textarea')!, '/model ');
    expect(view.host.textContent).not.toContain('Text only');
    const option = Array.from(view.host.querySelectorAll('[role="option"]')).find(item => item.textContent === 'MiMo V2.5') as HTMLElement;
    await React.act(async () => option.click());
    expect(onCommand).toHaveBeenCalledWith('/model mimo-25'); expect(onSend).not.toHaveBeenCalled();
    expect(view.host.querySelector('textarea')!.value).toBe(''); await view.unmount();
  });
  it('submits a // literal as ordinary text, never as a command', async () => {
    const onSend = vi.fn().mockResolvedValue(true); const onCommand = vi.fn().mockResolvedValue(true);
    const view = await mount(<Composer running={false} queuedCount={0} commands={COMMANDS} onCommand={onCommand} onSend={onSend}/>);
    await fill(view.host.querySelector('textarea')!, '// hello');
    // The picker stays closed for the literal escape.
    expect(view.host.querySelector('[role="listbox"]')).toBeNull();
    await React.act(async () => (view.host.querySelector('[aria-label="Send"]') as HTMLElement).click());
    expect(onSend).toHaveBeenCalledWith('// hello');
    expect(onCommand).not.toHaveBeenCalled();
    await view.unmount();
  });
  it('opens command arguments and dismisses suggestions without losing the draft', async () => {
    const onCommand = vi.fn(); const view = await mount(<Composer running={false} queuedCount={0} commands={COMMANDS} onCommand={onCommand} onSend={vi.fn()}/>);
    await fill(view.host.querySelector('textarea')!, '/');
    await React.act(async () => (view.host.querySelector('[role="option"]') as HTMLElement).click());
    expect(view.host.querySelector('textarea')!.value).toBe('/model '); expect(onCommand).not.toHaveBeenCalled();
    await React.act(async () => view.host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(view.host.querySelector('[role="listbox"]')).toBeNull(); expect(view.host.querySelector('textarea')!.value).toBe('/model '); await view.unmount();
  });
  it('keeps typing available while sending and preserves a newer draft', async () => {
    let accept!: (ok: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>(resolve => { accept = resolve; }));
    const view = await mount(<Composer running={false} queuedCount={0} commands={COMMANDS} onSend={onSend}/>);
    const input = view.host.querySelector('textarea')!;
    await fill(input, 'First note');
    await React.act(async () => (view.host.querySelector('[aria-label="Send"]') as HTMLElement).click());
    expect(input.disabled).toBe(false); expect(view.host.textContent).not.toContain('Sending…');
    expect(view.host.querySelector('[aria-label="Send"]')!.getAttribute('aria-busy')).toBe('true');
    await fill(input, 'Second note'); await React.act(async () => accept(true));
    expect(input.value).toBe('Second note'); expect(onSend).toHaveBeenCalledTimes(1); await view.unmount();
  });
  it('clears the submitted snapshot at once and reports failure locally', async () => {
    const key = 'otis:draft:test-retry'; const onSend = vi.fn().mockResolvedValueOnce(false);
    const view = await mount(<Composer draftKey={key} running={false} queuedCount={0} commands={COMMANDS} onSend={onSend}/>);
    await fill(view.host.querySelector('textarea')!, 'Keep the price unchanged.');
    await React.act(async () => (view.host.querySelector('[aria-label="Send"]') as HTMLElement).click());
    // The outbox entry owns retry/redraft; the composer neither holds the
    // text hostage nor duplicates the failure the bubble will carry.
    expect(view.host.querySelector('textarea')!.value).toBe('');
    expect(onSend).toHaveBeenCalledWith('Keep the price unchanged.');
    expect(view.host.textContent).not.toContain('not confirmed');
    await view.unmount();
  });
  it('does not submit an IME composition or mobile Enter', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ media: query, matches: false, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }));
    const onSend = vi.fn(); const view = await mount(<Composer running={false} queuedCount={0} commands={COMMANDS} onSend={onSend}/>);
    const input = view.host.querySelector('textarea')!; await fill(input, 'ș și ț, ő és ű');
    await React.act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onSend).not.toHaveBeenCalled(); expect(input.value).toBe('ș și ț, ő és ű'); await view.unmount();
  });
  it('offers actual Stop without replacing the normal reply input', async () => {
    const onStop = vi.fn().mockResolvedValue(undefined);
    const view = await mount(<Composer running queuedCount={1} commands={COMMANDS} onStop={onStop} onSend={vi.fn()}/>);
    await React.act(async () => (view.host.querySelector('[aria-label="Stop Otis"]') as HTMLElement).click());
    expect(onStop).toHaveBeenCalledOnce(); expect(view.host.querySelector('textarea')).toBeTruthy();
    expect(view.host.textContent).not.toContain('queued'); expect(view.host.textContent).not.toContain('Steer'); await view.unmount();
  });
  it('answers clarification conversationally without guessing dates or confirmation choices', async () => {
    const onSend = vi.fn().mockResolvedValue(true); const onCancel = vi.fn();
    const view = await mount(<Composer running={false} queuedCount={0} commands={COMMANDS} replyTo={{ question: 'When should the offer be ready?', onCancel }} onSend={onSend}/>);
    expect(view.host.textContent).not.toContain('Tomorrow'); expect(view.host.textContent).not.toContain('No deadline needed');
    expect(view.host.querySelector('.otis-question-card')).toBeNull();
    await fill(view.host.querySelector('textarea')!, 'Friday at 4pm');
    await React.act(async () => (view.host.querySelector('[aria-label="Send"]') as HTMLElement).click());
    expect(onSend).toHaveBeenCalledWith('Friday at 4pm');
    await React.act(async () => (view.host.querySelector('[aria-label="Dismiss question"]') as HTMLElement).click());
    expect(onCancel).toHaveBeenCalledOnce(); await view.unmount();
  });
  it('hides unimplemented voice and attachment actions', async () => {
    const view = await mount(<Composer running={false} queuedCount={0} commands={COMMANDS} onSend={vi.fn()}/>);
    expect(view.host.querySelector('[aria-label="Record voice note"]')).toBeNull();
    expect(view.host.querySelector('[aria-label="Chat tools"]')).toBeNull(); expect(view.host.querySelector('[aria-label="Send"]')).toBeTruthy(); await view.unmount();
  });
  it('exposes a single attach action, hiding the file transport', async () => {
    const view = await mount(<Composer running={false} commands={COMMANDS} onSend={vi.fn()} images={{
      available: true, workspaceId: 'ws_1', chatId: 'chat_1',
      onEnsureChat: async () => 'chat_1',
      upload: async () => ({ mediaId: 'med_1', format: 'image/png' as const }),
    }} />);
    expect(Array.from(view.host.querySelectorAll('[aria-label="Attach photos"]'))).toHaveLength(1);
    expect(view.host.querySelector('input[type="file"]')?.getAttribute('aria-hidden')).toBe('true');
    await view.unmount();
  });
  it('photo remove keeps the expanded touch target hook', async () => {    const view = await mount(<Composer running={false} commands={COMMANDS} onSend={vi.fn()} images={{
      available: true, workspaceId: 'ws_1', chatId: 'chat_1',
      onEnsureChat: async () => 'chat_1',
      upload: async () => ({ mediaId: 'med_1', format: 'image/png' as const }),
      controller: {
        attachments: [{ id: 'a1', file: new File(['x'], 'photo.png', { type: 'image/png' }), previewUrl: 'blob:preview-1', status: 'ready' }],
        addFiles: () => {}, remove: () => {}, clear: () => {},
      },
    }} />);
    const remove = view.host.querySelector('[aria-label="Remove photo"]');
    expect(remove?.className).toContain('otis-attach-remove');
    const css = readFileSync(resolve(__dirname, '../src/index.css'), 'utf-8');
    expect(css).toContain('.otis-attach-remove::after');
    expect(css).toContain('inset: -10px');
    await view.unmount();
  });
  it('synchronizes an explicitly selected prior message into the draft', async () => {
    const view = await mount(<Composer running={false} queuedCount={0} commands={COMMANDS} draftValue="Prior note" onSend={vi.fn()}/>);
    expect(view.host.querySelector('textarea')!.value).toBe('Prior note'); await view.unmount();
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
    expect(view.host.textContent).toContain('When should the offer be ready?');
    const region = view.host.querySelector('[aria-label="Awaiting input"]') as HTMLElement;
    expect(region).toBeTruthy();
    expect(region.textContent).toContain('When should the offer be ready?');
    expect(view.host.querySelector('.otis-question__badge')).toBeNull();
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

    const editBtn = view.host.querySelector('[aria-label="Use message as draft"]') as HTMLButtonElement;
    expect(editBtn).toBeTruthy();
    await React.act(async () => editBtn.click());
    expect(onEdit).toHaveBeenCalledWith('My business note');
    await view.unmount();
  });
  it('keeps a running preview unlabeled, then labels it unfinished when the run is cancelled', async () => {
    const base = {
      messages: [message({ id: 'm1', content_text: 'Draft me a reply', run_id: 'run_1' })],
      members: {}, currentUserId: 'usr_1', steps: [],
      activities: [activity('a1', 1, 'text_chunk', { text: 'Half-written draft' })],
      onInspectAction: vi.fn(),
    };
    const running = { run: { id: 'run_1' }, status: 'running', steps: [], actions: [], activities: [] } as never;
    const cancelled = { run: { id: 'run_1' }, status: 'cancelled', steps: [], actions: [], activities: [] } as never;
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    await React.act(async () => root.render(<Transcript {...base} run={running} />));
    expect(host.textContent).toContain('Half-written draft');
    expect(host.textContent).not.toContain('not sent as a saved reply');
    await React.act(async () => root.render(<Transcript {...base} run={cancelled} />));
    expect(host.textContent).toContain('Half-written draft');
    expect(host.textContent).toContain('Partial response — stopped.');
    expect(host.textContent).toContain('Stopped. Saved changes remain available to inspect or undo.');
    const failed = { run: { id: 'run_1' }, status: 'failed', steps: [], actions: [], activities: [] } as never;
    await React.act(async () => root.render(<Transcript {...base} run={failed} />));
    expect(host.textContent).toContain('Half-written draft');
    expect(host.textContent).toContain('Partial response — Otis could not finish.');
    await React.act(async () => root.unmount()); host.remove();
  });
  it('keeps a reloaded cancelled historical preview labeled as unfinished', async () => {
    const view = await mount(<Transcript
      messages={[message({ id: 'm1', content_text: 'Draft me a reply', run_id: 'run_1' })]}
      members={{}}
      currentUserId="usr_1"
      steps={[]}
      activities={[activity('a1', 1, 'text_chunk', { text: 'Reloaded partial preview' })]}
      run={{ run: { id: 'run_1' }, status: 'cancelled', steps: [], actions: [], activities: [] } as never}
      onInspectAction={vi.fn()}
    />);
    expect(view.host.textContent).toContain('Reloaded partial preview');
    expect(view.host.textContent).toContain('Partial response — stopped.');
    await view.unmount();
  });
  it('renders the persisted final answer once and never the preview when the run succeeded', async () => {
    const view = await mount(<Transcript
      messages={[
        message({ id: 'm1', content_text: 'Draft me a reply', run_id: 'run_1' }),
        message({ id: 'm2', content_text: 'Final saved reply.', author_kind: 'system', author_user_id: null, run_id: 'run_1' }),
      ]}
      members={{}}
      currentUserId="usr_1"
      steps={[]}
      activities={[activity('a1', 1, 'text_chunk', { text: 'Half-written draft' })]}
      run={{ run: { id: 'run_1' }, status: 'succeeded', steps: [], actions: [], activities: [] } as never}
      onInspectAction={vi.fn()}
    />);
    expect(view.host.textContent).toContain('Final saved reply.');
    expect(view.host.textContent).not.toContain('Half-written draft');
    expect(view.host.textContent).not.toContain('Partial response');
    expect((view.host.textContent ?? '').split('Final saved reply.').length - 1).toBe(1);
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
  it('folds transient preview frames by sequence and drops covered rounds', () => {
    const first = activity('p1', 0, 'text_preview', { text: 'Hello', round_index: 0, seq: 1 });
    const stale = activity('p0', 0, 'text_preview', { text: 'Hell', round_index: 0, seq: 1 });
    const second = activity('p2', 0, 'text_preview', { text: 'Hello world', round_index: 0, seq: 2 });
    const malformed = activity('px', 0, 'text_preview', { text: 42 });
    let state = mergeTransientPreview({}, first);
    expect(transientTextForRun(state, 'run_1')).toBe('Hello');
    state = mergeTransientPreview(state, stale);
    expect(transientTextForRun(state, 'run_1')).toBe('Hello');
    state = mergeTransientPreview(state, second);
    expect(transientTextForRun(state, 'run_1')).toBe('Hello world');
    state = mergeTransientPreview(state, malformed);
    expect(transientTextForRun(state, 'run_1')).toBe('Hello world');
    state = dropCoveredTransientPreview(state, 'run_1', 0);
    expect(transientTextForRun(state, 'run_1')).toBe('');
    expect(clearTransientPreview({ run_1: { 0: { seq: 1, text: 'x' } } }, 'run_1')).toEqual({});
  });
});

describe('History navigation', () => {  it('uses a drawer on mobile with functional history and settings actions', async () => {
    const onSelect = vi.fn(); const onSettings = vi.fn();
    const view = await mount(<HistoryNav variant="drawer" open workspaceId="ws_1" workspaceName="Kerning" workspaces={[{ id: 'ws_1', name: 'Kerning' }]} ownChats={[{ id: 'chat_1', title: 'Bistro', author_user_id: 'usr_1' } as never]} teamChats={[]} activeChatId="chat_1" onSelectChat={onSelect} onNewChat={vi.fn()} onSwitchWorkspace={vi.fn()} onOpenSettings={onSettings} onClose={vi.fn()}/>);
    // The Vaul drawer portals its dialog to the document body.
    expect(document.querySelector('div[role="dialog"][data-state="open"]')).toBeTruthy();
    await React.act(async () => Array.from(document.querySelectorAll('div[role="dialog"] button')).find(button => button.textContent === 'Bistro')!.click()); expect(onSelect).toHaveBeenCalledWith('chat_1');
    await React.act(async () => Array.from(document.querySelectorAll('div[role="dialog"] button')).find(button => button.textContent === 'Settings')!.click()); expect(onSettings).toHaveBeenCalledOnce(); await view.unmount();
  });
  it('names the workspace creation action for assistive tech', async () => {
    const onCreateWorkspace = vi.fn();
    const view = await mount(<HistoryNav variant="sidebar" workspaceId="ws_1" workspaceName="Kerning" workspaces={[{ id: 'ws_1', name: 'Kerning' }]} ownChats={[]} teamChats={[]} activeChatId={null} onSelectChat={vi.fn()} onNewChat={vi.fn()} onSwitchWorkspace={vi.fn()} onOpenSettings={vi.fn()} onCreateWorkspace={onCreateWorkspace}/>);
    const create = view.host.querySelector('[aria-label="Create workspace"]') as HTMLButtonElement;
    expect(create?.textContent).toBe('+ New');
    await React.act(async () => create.click()); expect(onCreateWorkspace).toHaveBeenCalledOnce(); await view.unmount();
  });
});

describe('Completion reconcile', () => {
  const snapshot = (): ChatSnapshot => ({
    detail: {
      chat: { id: 'chat_1', workspace_id: 'ws_1', author_user_id: 'usr_1', title: 'Bistro', model_override: null, is_archived: false, last_activity_at: '2026-10-02T10:00:00.000Z', created_at: '2026-10-02T10:00:00.000Z' },
      is_author: true,
    },
    messages: [message({ id: 'msg_1', content_text: 'Hi', sequence: 1 })],
    older: null,
    runs: {},
    activities: [],
    questions: [],
    cursor: 1,
  });
  it('files the committed reply locally from answer_saved without a refetch', () => {
    const event = activity('act_run_1_answer', 2, 'answer_saved', { message_id: 'reply_run_1', sequence: 2, text: 'Saved reply.', channel: 'web' });
    const next = applyAnswerSaved(snapshot(), event);
    expect(next?.messages.map(item => item.content_text)).toEqual(['Hi', 'Saved reply.']);
    expect(next?.messages[1]).toMatchObject({ id: 'reply_run_1', author_kind: 'system', run_id: 'run_1', sequence: 2 });
  });
  it('falls back to refetch for older shapes and truncated text', () => {
    expect(applyAnswerSaved(snapshot(), activity('a', 2, 'answer_saved', { reply: 'Pick one.' }))).toBeNull();
    expect(applyAnswerSaved(snapshot(), activity('a', 2, 'answer_saved', { message_id: 'm', sequence: 2, text: 'x', text_truncated: true }))).toBeNull();
  });
  it('replaces nothing when the reply is already present', () => {
    const event = activity('act_run_1_answer', 2, 'answer_saved', { message_id: 'reply_run_1', sequence: 2, text: 'Saved reply.', channel: 'web' });
    const once = applyAnswerSaved(snapshot(), event)!;
    expect(applyAnswerSaved(once, event)?.messages).toHaveLength(2);
  });
  it('files an accepted outgoing message locally with the same client UUID', () => {
    const base = snapshot();
    const next = applyAcceptedMessage(base, {
      id: 'msg_server_9',
      workspace_id: 'ws_1',
      chat_id: 'chat_1',
      author_user_id: 'usr_1',
      client_message_id: 'client_9',
      content_text: 'Hello Otis',
      media_id: null,
      run_id: 'run_9',
      sequence: 2,
      created_at: '2026-10-02T10:01:00.000Z',
    });
    expect(next.messages.map(item => item.content_text)).toEqual(['Hi', 'Hello Otis']);
    const filed = next.messages[1]!;
    expect(filed).toMatchObject({ id: 'msg_server_9', author_kind: 'member', run_id: 'run_9', sequence: 2 });
    expect(filed.client_message_id).toBe('client_9');
  });
});
