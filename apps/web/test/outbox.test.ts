/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearUserOutbox,
  createOutboxEntry,
  entriesForChat,
  getNewChatMapping,
  markOutboxFailed,
  markOutboxSaved,
  pruneReconciledEntries,
  rehydrateOutbox,
  resetOutboxForTests,
  retryOutboxEntry,
  setNewChatMapping,
} from '../src/api/outbox.js';
import { deriveTranscript, reconciledClientIds } from '../src/api/transcript.js';
import type { ChatMessage } from '@otis/contracts';

function serverMessage(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    workspace_id: 'ws',
    chat_id: 'chat',
    author_user_id: 'avi',
    author_display_name: 'Avi',
    author_kind: 'member',
    channel: 'web',
    inbound_message_id: 'in-1',
    client_message_id: null,
    content_text: 'hello',
    media_id: null,
    run_id: 'run-1',
    sequence: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...partial,
  };
}

describe('outbox identities', () => {
  beforeEach(() => resetOutboxForTests());

  it('creates one UUID per send with immutable payload and clarification linkage', () => {
    const first = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'hi', clarificationId: 'clar-1' });
    const second = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'hi', clarificationId: 'clar-1' });
    expect(first.clientId).not.toBe(second.clientId);
    expect(first.text).toBe('hi');
    expect(first.clarificationId).toBe('clar-1');
    expect(first.state).toBe('sending');
  });

  it('retry reuses the original UUID, payload and clarification linkage', () => {
    const entry = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'hi', clarificationId: 'clar-1' });
    markOutboxFailed(entry.clientId, { code: 'transport', message: 'Network failed.' });
    const retried = retryOutboxEntry(entry.clientId)!;
    expect(retried.clientId).toBe(entry.clientId);
    expect(retried.text).toBe('hi');
    expect(retried.clarificationId).toBe('clar-1');
    expect(retried.state).toBe('sending');
    expect(retried.attempts).toBe(0);
  });

  it('marks saved mapping without creating another identity', () => {
    const entry = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'hi' });
    const saved = markOutboxSaved(entry.clientId, { messageId: 'msg-1', runId: 'run-1', sequence: 4 })!;
    expect(saved.state).toBe('saved');
    expect(saved.messageId).toBe('msg-1');
    expect(entriesForChat('avi', 'ws', 'chat')).toHaveLength(1);
  });

  it('prunes reconciled entries but keeps failed ones for retry', () => {
    const saved = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'a' });
    markOutboxSaved(saved.clientId, { messageId: 'msg-1', runId: 'run-1', sequence: 1 });
    const failed = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'b' });
    markOutboxFailed(failed.clientId, { code: 'transport', message: 'Down.' });
    pruneReconciledEntries(new Set([saved.clientId, failed.clientId]));
    expect(entriesForChat('avi', 'ws', 'chat').map(entry => entry.clientId)).toEqual([failed.clientId]);
  });

  it('persists the new-chat mapping so a crash cannot create another chat', () => {
    const entry = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: null, text: 'hi' });
    expect(entry.newChatKey).toBeTruthy();
    setNewChatMapping(entry.newChatKey!, 'chat-created', 'avi');
    expect(getNewChatMapping(entry.newChatKey!, 'avi')).toBe('chat-created');
    expect(getNewChatMapping(entry.newChatKey!, 'hunor')).toBeUndefined();
  });

  it('clears one user scope without touching another account', () => {
    createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'a' });
    createOutboxEntry({ userId: 'hunor', workspaceId: 'ws', chatId: 'chat', text: 'b' });
    clearUserOutbox('avi');
    expect(entriesForChat('avi', 'ws', 'chat')).toHaveLength(0);
    expect(entriesForChat('hunor', 'ws', 'chat')).toHaveLength(1);
  });

  it('falls back to memory-only persistence when storage is unavailable', async () => {
    await rehydrateOutbox('avi');
    const entry = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'hi' });
    expect(entry.clientId).toBeTruthy();
    expect(entriesForChat('avi', 'ws', 'chat')).toHaveLength(1);
  });
});

describe('transcript reconciliation', () => {
  beforeEach(() => resetOutboxForTests());

  it('echoes the bubble before acceptance with a stable client key', () => {
    const entry = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'hi' });
    const derived = deriveTranscript([], [entry], true);
    expect(derived.messages).toHaveLength(1);
    expect(derived.messages[0]!.client_message_id).toBe(entry.clientId);
    expect(derived.delivery[entry.clientId]?.state).toBe('sending');
  });

  it('reconciles the server row under the same key without a duplicate bubble', () => {
    const entry = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'hi' });
    markOutboxSaved(entry.clientId, { messageId: 'msg-1', runId: 'run-1', sequence: 7 });
    const server = [serverMessage({ id: 'msg-1', client_message_id: entry.clientId, sequence: 7 })];
    const derived = deriveTranscript(server, [entry], true);
    expect(derived.messages).toHaveLength(1);
    expect(derived.messages[0]!.id).toBe('msg-1');
    expect(derived.messages[0]!.client_message_id).toBe(entry.clientId);
    expect(reconciledClientIds(server).has(entry.clientId)).toBe(true);
  });

  it('keeps a saved-but-unseen message visible until the row arrives', () => {
    const created = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'hi' });
    const entry = markOutboxSaved(created.clientId, { messageId: 'msg-1', runId: 'run-1', sequence: 7 })!;
    const derived = deriveTranscript([], [entry], true);
    expect(derived.messages).toHaveLength(1);
    expect(derived.delivery[entry.clientId]?.state).toBe('saved');
  });

  it('keeps failed content with its reason for same-UUID retry', () => {
    const created = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'hi' });
    const entry = markOutboxFailed(created.clientId, { code: 'transport', message: 'Network failed.' })!;
    const derived = deriveTranscript([], [entry], true);
    expect(derived.delivery[entry.clientId]).toMatchObject({ state: 'failed', error: 'Network failed.' });
  });

  it('orders local sends after accepted sequence without reordering it', () => {
    const first = serverMessage({ id: 'msg-1', sequence: 1 });
    const second = serverMessage({ id: 'msg-2', sequence: 2 });
    const entry = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'new' });
    const derived = deriveTranscript([second, first], [entry], true);
    expect(derived.messages.map(message => message.id)).toEqual(['msg-1', 'msg-2', `local:${entry.clientId}`]);
  });

  it('preserves acknowledged sequence when assistant reply arrives before message in snapshot (M0 race)', () => {
    const first = serverMessage({ id: 'msg-1', sequence: 1 });
    // Assistant message sequence 3 arrives via streaming or partial sync before msg-2 is reflected in server array
    const assistantReply = serverMessage({ id: 'msg-3', sequence: 3, author_kind: 'assistant', content_text: 'Answer' });
    const created = createOutboxEntry({ userId: 'avi', workspaceId: 'ws', chatId: 'chat', text: 'Question' });
    // User message acknowledged by server with sequence 2
    const saved = markOutboxSaved(created.clientId, { messageId: 'msg-2', runId: 'run-1', sequence: 2 })!;

    const derived = deriveTranscript([first, assistantReply], [saved], true);
    // User message (sequence 2) MUST come before assistant reply (sequence 3)
    expect(derived.messages.map(m => m.id)).toEqual(['msg-1', `local:${saved.clientId}`, 'msg-3']);
    expect(derived.messages[1]!.sequence).toBe(2);
  });
});
