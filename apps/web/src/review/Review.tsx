/** Development-only composition reference. No session, provider, or production data. */
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import type { Chat, ChatMessage, PublicActivity, AgentRun, RunDetailResponse, ModelOption, ActionDetailResponse, MemberSettings } from '@otis/contracts';
import { listCommands } from '@otis/commands';
import { api } from '../api/client.js';
import { createAppQueryClient } from '../api/queries.js';
import { SessionContext, createAppRouter } from '../router.js';
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/geist-mono';
import '../globals.css';
import '../index.css';
import '../components/ui/controls.css';
if (!import.meta.env.DEV) throw new Error('UI review is available only in local development.');
Object.defineProperty(globalThis, 'EventSource', { value: undefined, configurable: true });
const workspace = 'ws_review'; const user = 'usr_review_avi';
const scenario = new URLSearchParams(location.search).get('scenario') ?? 'short';
const timestamp = '2026-10-03T05:00:00.000Z';
const chat = (id: string, title: string, author = user, ws = workspace): Chat => ({ id, workspace_id: ws, title, author_user_id: author, model_override: null, is_archived: false, activity_cursor: 3, created_at: timestamp, updated_at: timestamp, last_activity_at: timestamp });
const diacriticsNote = 'Restaurantul 2 e cald acum. Oferta până vineri, 3.500 RON. Șantier, țară, tűz, őr.\n\nFri 9 Oct · 3,500 RON · 07:41';
let chats = [chat('chat_review', 'Bistro · Friday’s offer'), chat('chat_diacritics', 'Restaurantul 2 · 3.500 RON · Diacritice'), chat('chat_visit', 'Visit notes · Târgu Mureș'), chat('chat_offer', 'A clearer offer for Thai Garden'), chat('chat_preferences', 'Language and follow-up preferences'), chat('chat_team', 'Hunor · today’s visits', 'usr_review_hunor'), chat('chat_team_long', 'Székelyudvarhelyi Kézműves Pékség és Kávézó — új arculat', 'usr_review_hunor'), chat('chat_other', 'A fresh workspace conversation', user, 'ws_other')];
const message = (id: string, text: string, kind: 'member' | 'system', sequence: number, chatId = 'chat_review', runId: string | null = 'run_review'): ChatMessage => ({ id, workspace_id: workspace, chat_id: chatId, author_user_id: kind === 'member' ? chatId.startsWith('chat_team') ? 'usr_review_hunor' : user : null, author_kind: kind, channel: kind === 'member' ? 'web' : 'system', inbound_message_id: kind === 'member' ? `in_${id}` : null, client_message_id: null, content_text: text, media_id: null, run_id: runId, sequence, created_at: timestamp, updated_at: timestamp });
const longNote = `Am trecut pe la Bistro. Proprietarul vrea un site în română și maghiară, cu meniul ușor de actualizat. Oferta discutată a fost de 3.500 RON; suma de 5.300 RON din notița veche trebuie corectată. Nu am promis o dată pentru demo.\n\n${diacriticsNote}\n\nSzékelyudvarhelyi Kézműves Pékség és Kávézó — ő és ű, ș și ț. A következő ajánlat legyen rövid és világos, és csak az egyeztetett árat használja.\n\nReferință: https://example.test/a-very-long-business-reference-without-any-natural-break-that-must-wrap-safely-on-a-small-phone`;
let messages = scenario === 'empty' ? [] : [message('msg_1', scenario === 'long' ? longNote : scenario === 'diacritics' ? diacriticsNote : 'Bistro wants the website. Send the offer Friday. The price is 3,500 RON.', 'member', 1), ...(scenario === 'working' ? [] : [message('msg_2', scenario === 'partial' ? 'The visit is saved. I couldn’t finish the draft. The saved change is available to inspect.' : scenario === 'question' ? 'When should the offer be ready?' : scenario === 'diacritics' ? 'Am notat oferta pentru Restaurantul 2: 3.500 RON până vineri.\n\nFri 9 Oct · 3,500 RON · 07:41' : 'The offer follow-up is saved for Friday, 9 October. I’ve kept the price at 3,500 RON.\n\nHunor’s Tuesday visit is the source for their preferred language. I can draft the offer when you’re ready.', 'system', 2)])];
const activity: PublicActivity[] = [{ schema_version: 1, id: 'activity_1', cursor: 1, workspace_id: workspace, chat_id: 'chat_review', run_id: 'run_review', created_at: timestamp, type: 'action_applied', payload: { action_id: 'action_review', command_name: 'create_task', summary: 'Offer follow-up · Friday, 9 October' } }];
const run = (): RunDetailResponse => ({ run: { id: 'run_review', workspace_id: workspace, chat_id: 'chat_review', source_message_id: 'in_msg_1', source_job_id: null, executor_kind: 'agent', status: scenario === 'working' ? 'running' : scenario === 'question' ? 'waiting_for_input' : scenario === 'partial' ? 'partial' : 'succeeded', model_key: 'review-model', attempt_id: null, lease_fence: 1, error_code: null, error_message: null, created_at: timestamp, updated_at: timestamp } as AgentRun, status: scenario === 'working' ? 'running' : scenario === 'question' ? 'waiting_for_input' : scenario === 'partial' ? 'partial' : 'succeeded', actions: [{ action_id: 'action_review', command_name: 'create_task', result_status: 'applied', committed_revision: 3, summary: 'Offer follow-up · Friday, 9 October', created_at: timestamp }], sources: [{ memory_id: 'memory_review', label: 'Hunor · Tuesday visit', provenance: 'stated' }], steps: [{ step_index: 0, tool_name: 'find_entities', status: 'succeeded', action_id: null, result: null, created_at: timestamp, updated_at: timestamp }, { step_index: 1, tool_name: 'create_task', status: 'succeeded', action_id: 'action_review', result: null, created_at: timestamp, updated_at: timestamp }, ...(scenario === 'working' ? [{ step_index: 2, tool_name: 'draft_message', status: 'running' as const, action_id: null, result: null, created_at: timestamp, updated_at: timestamp }] : [])], activities: activity, pending_clarification: scenario === 'question' ? { id: 'question_review', workspace_id: workspace, chat_id: 'chat_review', run_id: 'run_review', source_message_id: 'in_msg_1', requester_user_id: user, question: 'When should the offer be ready?', intended_operation: 'create_task', missing_fields: ['due'], candidates_json: null, source_revision: 3, status: 'pending', resolution_response: null, resolved_at: null, created_at: timestamp, updated_at: timestamp } : null });
let currentModel = 'review-model';
const modelList = (): ModelOption[] => [{ command_key: 'review-model', display_name: 'Configured model', provider: 'synthetic', available: true, is_current: currentModel === 'review-model', is_default: true, native_audio_supported: false, voice_available: false }, { command_key: 'second-model', display_name: 'Second configured model', provider: 'synthetic', available: true, is_current: currentModel === 'second-model', is_default: false, native_audio_supported: false, voice_available: false }];
api.listChats = async (ws, filter) => ({ chats: chats.filter(item => item.workspace_id === ws && (filter === 'mine' ? item.author_user_id === user : true)) });
api.getChat = async (_ws, id) => { const value = chats.find(item => item.id === id)!; return { chat: value, is_author: value.author_user_id === user }; };
api.listMessages = async (_ws, id) => ({ chat_id: id, messages: messages.some(item => item.chat_id === id) ? messages.filter(item => item.chat_id === id) : id === 'chat_diacritics' ? [message('diacr_1', diacriticsNote, 'member', 1, id, null), message('diacr_2', 'Am notat oferta pentru Restaurantul 2: 3.500 RON până vineri.\n\nFri 9 Oct · 3,500 RON · 07:41', 'system', 2, id, null)] : id.startsWith('chat_team') ? [message('team_msg_1', longNote, 'member', 1, id, null), message('team_msg_2', 'The visit is saved. There is no deadline yet; the follow-up remains a question.', 'system', 2, id, null)] : [], next_before_sequence: null });
api.activity = async (_ws, id) => ({ chat_id: id, activities: id === 'chat_review' ? activity : [], next_cursor: 1, latest_cursor: 1 });
api.commands = async () => ({ surface: 'web', commands: listCommands('web') });
api.models = async () => ({ models: modelList(), current_command_key: currentModel, default_command_key: 'review-model' });
api.run = async () => run();
api.clarifications = async () => ({ clarifications: scenario === 'question' ? [{ id: 'question_review', chat_id: 'chat_review', run_id: 'run_review', question: 'When should the offer be ready?', intended_operation: 'create_task', missing_fields: ['due'], candidates: null, status: 'pending', created_at: timestamp, answerable_by_caller: true }] : [] });
api.createChat = async (ws, id) => { const created = chat(id, 'New conversation', user, ws); chats = [created, ...chats]; return { chat: created }; };
api.sendMessage = async (_ws, id, uuid, text) => { const index = messages.length + 1; messages = [...messages, message(uuid, text, 'member', index, id)]; if (text.startsWith('/model ')) { currentModel = text.split(' ')[1]!; chats = chats.map(item => item.id === id ? { ...item, model_override: currentModel } : item); messages.push(message(`answer_${uuid}`, `This chat now uses ${currentModel}. Voice notes are not available yet.`, 'system', index + 1, id)); } else if (text === '/help') messages.push(message(`answer_${uuid}`, 'Use /model, /workspace, /today or /undo. Ordinary conversation works too.', 'system', index + 1, id)); return { status: 'accepted', message_id: uuid, run_id: 'run_review', acceptance_sequence: index, mode: scenario === 'working' ? 'steer' : 'new_run' }; };
api.action = async () => ({ action: { action_id: 'action_review', workspace_id: workspace, command_name: 'create_task', result_status: 'applied', summary: 'Created the Bistro offer follow-up for Friday, 9 October.', committed_revision: 3, actor_kind: 'member', actor_user_id: user, source_message_id: 'in_msg_1', run_id: 'run_review', step_id: null, created_at: timestamp, events: [], undo: { available: true, reverted_event_ids: [], reverted_by_event_ids: [] }, source: { id: 'in_msg_1', channel: 'web', created_at: timestamp, text_preview: messages[0]?.content_text ?? 'Send Bistro the offer Friday.' } } } satisfies ActionDetailResponse);
api.memorySource = async () => ({ memory: { id: 'memory_review', content: 'Bistro prefers the offer in Romanian and Hungarian.', provenance: 'stated', status: 'active', observed_at: timestamp }, source: { chat_id: 'chat_team', author_name: 'Hunor', text: 'Am discutat oferta. Proprietarul preferă română și maghiară. Prețul este 3.500 RON.', created_at: timestamp, channel: 'web' } });
api.undoPreview = async (_ws, _id, mode) => ({ preview: { target_action_id: 'action_review', mode, selected_action_ids: mode === 'from_here' ? ['action_review', 'action_second'] : ['action_review'], affected_event_ids: ['event_review'], affected_entities: [{ id: 'entity_review', name: 'Bistro', changes: ['Remove the follow-up record.'] }], affected_tasks: mode === 'from_here' ? [{ id: 'task_review', title: 'Offer follow-up', changes: ['Remove the task created after the visit.'] }] : [], dependencies: [], expected_revision: 3 } });
api.undo = async () => ({ status: 'applied', action_id: 'action_review', undo_action_id: 'undo_review', affected_action_ids: ['action_review'], revert_event_ids: ['revert_review'], committed_revision: 4, summary: 'The selected changes were undone.' });
api.settings = async () => ({ settings: { workspace_id: workspace, default_model: 'Configured model', created_at: timestamp, updated_at: timestamp } });
let preferences: MemberSettings = { workspace_id: workspace, user_id: user, brief_enabled: false, brief_local_time: null, brief_timezone: 'Europe/Bucharest', interpretation_timezone: null, brief_weekdays: null, brief_channel: 'web', preferred_language: 'en', created_at: timestamp, updated_at: timestamp };
api.memberSettings = async () => ({ settings: preferences });
api.updateMemberSettings = async (_ws, body) => { preferences = { ...preferences, ...body }; return { settings: preferences }; };
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={createAppQueryClient()}>
    <SessionContext.Provider
      value={{
        userId: user,
        workspaces: [{ id: workspace, name: 'Kerning' }, { id: 'ws_other', name: 'Studio archive' }],
        members: { [user]: 'Avi', usr_review_hunor: 'Hunor' },
        onSignOut: () => { location.href = '/'; },
      }}
    >
      <RouterProvider
        router={createAppRouter({ history: createMemoryHistory({ initialEntries: [`/${location.search}`] }) })}
      />
    </SessionContext.Provider>
  </QueryClientProvider>,
);
