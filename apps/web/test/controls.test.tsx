/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { ChatDetailResponse, MemberSettings, ModelOption } from '@otis/contracts';
import { mountRoute } from './route.js';
import { SettingsPane } from '../src/components/SettingsPane.js';
import { TestQueryProvider } from './query.js';
import { resetOutboxForTests } from '../src/api/outbox.js';
import { api } from '../src/api/client.js';
import * as stream from '../src/hooks/useActivityStream.js';

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); resetOutboxForTests(); sessionStorage.clear(); history.replaceState({}, '', '/'); });
async function mount(element: React.ReactElement) {
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  await React.act(async () => root.render(<TestQueryProvider>{element}</TestQueryProvider>));
  await React.act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  return { host, unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}
async function openMenu(button: HTMLElement) { await React.act(async () => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))); }
const own = { workspace_id: 'ws', user_id: 'avi', preferred_language: 'en', brief_timezone: null, brief_enabled: false, brief_local_time: null, brief_weekdays: null, brief_channel: 'web', created_at: '', updated_at: '' } satisfies MemberSettings;

describe('Authoritative conversation controls', () => {
  it('updates the thinking badge from saved state and never sends a conversational message', async () => {
    let choice = 'medium';
    const detail = (): ChatDetailResponse => ({ is_author: true, chat: { id: 'chat', workspace_id: 'ws', author_user_id: 'avi', title: 'Bistro', model_override: 'mimo-25', thinking_override: { model_key: 'mimo-25', choice_id: choice }, is_archived: false, created_at: '', last_activity_at: '' } });
    const model = (): ModelOption => ({ command_key: 'mimo-25', display_name: 'MiMo V2.5', provider: 'opencode_go', available: true, is_current: true, is_default: true, native_audio_supported: true, voice_available: false, thinking: { state: 'supported', is_default: false, current_choice_id: choice, effective_choice_id: choice, choices: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }] } });
    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'getChat').mockImplementation(async () => detail());
    vi.spyOn(api, 'models').mockImplementation(async () => ({ models: [model()], current_command_key: 'mimo-25', default_command_key: 'mimo-25' }));
    vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: 'chat', messages: [], next_before_sequence: null });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(stream, 'subscribeToActivity').mockReturnValue({ close: vi.fn() });
    const send = vi.spyOn(api, 'sendMessage');
    const command = vi.spyOn(api, 'executeCommand').mockImplementation(async (_ws, _chat, _id, text) => { choice = text.split(' ')[1]!; return { status: 'accepted', message_id: 'control', run_id: 'command', acceptance_sequence: 1, command_applied: true }; });
    const view = await mountRoute('/?workspace=ws&chat=chat', { userId: 'avi', workspaces: [{ id: 'ws', name: 'Kerning' }], members: { avi: 'Avi' }, onSignOut: vi.fn() });
    const trigger = view.host.querySelector('[aria-label="Chat options"]') as HTMLElement;
    expect(trigger).toBeTruthy();
    await openMenu(trigger);
    const current = Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(item => item.getAttribute('aria-checked') === 'true' && item.textContent === 'Medium') as HTMLElement;
    expect(current).toBeTruthy();
    const high = Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(item => item.textContent === 'High') as HTMLElement;
    expect(high).toBeTruthy();
    await React.act(async () => high.click());
    expect(command).toHaveBeenCalledWith('ws', 'chat', expect.any(String), '/thinking high');
    expect(send).not.toHaveBeenCalled();
    expect(view.host.querySelectorAll('.otis-turn')).toHaveLength(0); await view.unmount();
  });

  it('serializes overlapping effort selections so a stale read never wins', async () => {
    let choice = 'medium';
    const detail = (): ChatDetailResponse => ({ is_author: true, chat: { id: 'chat', workspace_id: 'ws', author_user_id: 'avi', title: 'Bistro', model_override: 'mimo-25', thinking_override: { model_key: 'mimo-25', choice_id: choice }, is_archived: false, created_at: '', last_activity_at: '' } });
    const model = (): ModelOption => ({ command_key: 'mimo-25', display_name: 'MiMo V2.5', provider: 'opencode_go', available: true, is_current: true, is_default: true, native_audio_supported: true, voice_available: false, thinking: { state: 'supported', is_default: false, current_choice_id: choice, effective_choice_id: choice, choices: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'low', label: 'Low' }] } });
    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'getChat').mockImplementation(async () => detail());
    vi.spyOn(api, 'models').mockImplementation(async () => ({ models: [model()], current_command_key: 'mimo-25', default_command_key: 'mimo-25' }));
    vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: 'chat', messages: [], next_before_sequence: null });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(stream, 'subscribeToActivity').mockReturnValue({ close: vi.fn() });
    let resolveCommand!: (value: { status: 'accepted'; message_id: string; run_id: string; acceptance_sequence: number; command_applied: boolean }) => void;
    const command = vi.spyOn(api, 'executeCommand').mockImplementation(async (_ws, _chat, _id, text) => {
      choice = text.split(' ')[1]!;
      await new Promise(resolve => {
        resolveCommand = resolve as never;
      });
      return { status: 'accepted', message_id: 'control', run_id: 'command', acceptance_sequence: 1, command_applied: true };
    });
    const view = await mountRoute('/?workspace=ws&chat=chat', { userId: 'avi', workspaces: [{ id: 'ws', name: 'Kerning' }], members: { avi: 'Avi' }, onSignOut: vi.fn() });
    const trigger = view.host.querySelector('[aria-label="Chat options"]') as HTMLElement;
    await openMenu(trigger);
    const high = Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(item => item.textContent === 'High') as HTMLElement;
    expect(high).toBeTruthy();
    await React.act(async () => high.click());
    // A second selection while the first applies reopens the menu and is
    // rejected locally, never queued behind the in-flight mutation.
    await openMenu(trigger);
    const low = Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(item => item.textContent === 'Low') as HTMLElement;
    expect(low).toBeTruthy();
    await React.act(async () => low.click());
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith('ws', 'chat', expect.any(String), '/thinking high');
    resolveCommand({ status: 'accepted', message_id: 'control', run_id: 'command', acceptance_sequence: 1, command_applied: true });
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(command).toHaveBeenCalledTimes(1);
    expect(view.host.querySelectorAll('.otis-turn')).toHaveLength(0);
    await view.unmount();
  });
});

describe('Independent personal settings', () => {
  it('saves a reply language without requiring or inventing a timezone', async () => {
    vi.spyOn(api, 'settings').mockResolvedValue({ settings: { workspace_id: 'ws', default_model: null, created_at: '', updated_at: '' } });
    vi.spyOn(api, 'memberSettings').mockResolvedValue({ settings: own });
    vi.spyOn(api, 'models').mockResolvedValue({ models: [], current_command_key: null, default_command_key: null });
    const update = vi.spyOn(api, 'updateMemberSettings').mockResolvedValue({ settings: { ...own, preferred_language: 'ro' } });
    const view = await mount(<SettingsPane workspaceId="ws" workspaceName="Kerning" onClose={vi.fn()} onSignOut={vi.fn()}/>);
    const trigger = view.host.querySelector('[aria-label="Reply language"]') as HTMLElement;
    await openMenu(trigger);
    const option = Array.from(document.querySelectorAll('[role="option"]')).find(item => item.textContent?.includes('Română')) as HTMLElement;
    expect(option).toBeTruthy(); await React.act(async () => option.click());
    expect(update).toHaveBeenCalledWith('ws', { preferred_language: 'ro' });
    expect(view.host.querySelector('input')!.value).toBe(''); await view.unmount();
  });
});
