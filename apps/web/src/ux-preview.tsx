/** Development-only, synthetic UI fixture. Not imported by the production entry. */
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppQueryClient } from './api/queries.js';
import { SessionContext, createAppRouter } from './router.js';
import './index.css';

const now = '2026-10-03T12:30:00Z';
let model = 'mimo-25';
let thinking = 'medium';
let override: string | null = 'mimo-25';
let personal = { workspace_id: 'fixture', user_id: 'avi', preferred_language: 'en', brief_timezone: null as string | null, brief_enabled: false, brief_local_time: null, brief_weekdays: null, brief_channel: 'web', created_at: now, updated_at: now };
const chat = () => ({ id: 'bistro', workspace_id: 'fixture', author_user_id: 'avi', title: 'Bistro follow-up', model_override: override, thinking_override: thinking === 'default' ? null : { model_key: model, choice_id: thinking }, is_archived: false, created_at: now, last_activity_at: now });
const messages = [
  { id: 'note', workspace_id: 'fixture', chat_id: 'bistro', author_user_id: 'avi', author_kind: 'member', channel: 'web', inbound_message_id: null, client_message_id: null, content_text: 'Bistro liked the offer. Hunor will call them on Friday.', media_id: null, run_id: null, sequence: 1, created_at: now, updated_at: now },
  { id: 'answer', workspace_id: 'fixture', chat_id: 'bistro', author_user_id: null, author_kind: 'agent', channel: 'system', inbound_message_id: null, client_message_id: null, content_text: 'Got it. What time on Friday should I remind Hunor?', media_id: null, run_id: null, sequence: 2, created_at: now, updated_at: now },
];
history.replaceState({}, '', '/ux-preview.html?workspace=fixture&chat=bistro');
class FixtureEventSource { addEventListener() {} close() {} }
Object.defineProperty(window, 'EventSource', { value: FixtureEventSource });
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  let payload: unknown = {};
  if (url.pathname === '/api/commands') payload = { surface: 'web', commands: ['model', 'thinking', 'workspace', 'today', 'undo', 'help'].map(name => ({ name, summary: ({ model: 'Choose a model for this chat', thinking: 'Change thinking effort', workspace: 'Switch workspace', today: 'See due work', undo: 'Revert the latest change', help: 'Show commands' } as Record<string, string>)[name], available: true, deterministic: true, usage: `/${name}` })) };
  else if (url.pathname.endsWith('/models')) payload = { models: [['mimo-25', 'MiMo V2.5', 'opencode_go'], ['gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', 'gemini']].map(([key, name, provider]) => ({ command_key: key, display_name: name, provider, available: true, is_default: key === 'mimo-25', is_current: key === model, native_audio_supported: false, voice_available: false, thinking: { state: 'supported', is_default: thinking === 'default', current_choice_id: thinking === 'default' ? null : thinking, effective_choice_id: thinking, choices: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Extra high' }] } })), current_command_key: model, default_command_key: 'mimo-25' };
  else if (url.pathname.endsWith('/commands')) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const [name, key] = body.text.split(' ');
    if (name === '/thinking') thinking = key;
    if (name === '/model') { model = key === 'default' ? 'mimo-25' : key; override = key === 'default' ? null : key; thinking = 'default'; }
    payload = { status: 'accepted', message_id: 'control', run_id: 'control', acceptance_sequence: 3, command_applied: true, reply: 'Updated.' };
  } else if (url.pathname.endsWith('/messages')) {
    if (init?.method === 'POST') { await new Promise(resolve => setTimeout(resolve, 1500)); messages.push({ ...messages[0]!, id: 'sent', content_text: body.text, sequence: 3 }); payload = { status: 'accepted', message_id: 'sent', run_id: 'run', acceptance_sequence: 3 }; }
    else payload = { chat_id: 'bistro', messages, next_before_sequence: null };
  } else if (url.pathname.endsWith('/activity')) payload = { activities: [], latest_cursor: 0 };
  else if (url.pathname.endsWith('/clarifications')) payload = { clarifications: [] };
  else if (url.pathname.endsWith('/chats')) payload = { chats: url.searchParams.get('filter') === 'team' ? [] : [chat()] };
  else if (url.pathname.includes('/chats/')) payload = { chat: chat(), is_author: true };
  else if (url.pathname.includes('/me/settings')) { if (init?.method === 'PUT') personal = { ...personal, ...body }; payload = { settings: personal }; }
  else if (url.pathname.endsWith('/settings')) payload = { settings: { workspace_id: 'fixture', default_model: 'mimo-25', created_at: now, updated_at: now } };
  else if (url.pathname.includes('/credentials/')) payload = { credential: { status: 'available' }, verified: true };
  return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
};
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={createAppQueryClient()}>
    <SessionContext.Provider
      value={{
        userId: 'avi',
        workspaces: [{ id: 'fixture', name: 'Kerning' }, { id: 'studio', name: 'Studio' }],
        members: { avi: 'Avi', hunor: 'Hunor' },
        onSignOut: () => {},
      }}
    >
      <RouterProvider
        router={createAppRouter({ history: createMemoryHistory({ initialEntries: [`${location.pathname}${location.search}`] }) })}
      />
    </SessionContext.Provider>
  </QueryClientProvider>,
);
