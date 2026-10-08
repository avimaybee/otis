import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@otis/contracts';
import type { OutboxEntry } from '../../apps/web/src/api/outbox.js';
import { deriveTranscript } from '../../apps/web/src/api/transcript.js';

const submitted: OutboxEntry = {
  clientId: 'ordering-client', userId: 'ordering-member', workspaceId: 'ordering-ws',
  chatId: 'ordering-chat', newChatKey: null, text: 'What do we know about this client?',
  createdAt: '2026-10-08T10:00:00.000Z', state: 'saved', attempts: 1,
  messageId: 'ordering-source', runId: 'ordering-run', sequence: 8,
};

function message(id: string, sequence: number, member = false): ChatMessage {
  return {
    id, workspace_id: submitted.workspaceId, chat_id: submitted.chatId!,
    author_user_id: member ? submitted.userId : null, author_display_name: null,
    author_kind: member ? 'member' : 'system', channel: 'web',
    inbound_message_id: null, client_message_id: member ? submitted.clientId : null,
    content_text: member ? submitted.text : 'Here is the client information.',
    media_id: null, run_id: submitted.runId!, sequence,
    created_at: submitted.createdAt, updated_at: submitted.createdAt,
  };
}

describe('reported user-bubble ordering', () => {
  it('keeps a saved but unseen source above its already received answer', () => {
    const derived = deriveTranscript([message('ordering-answer', 9)], [submitted], true);
    expect(derived.messages.map(row => row.author_kind)).toEqual(['member', 'system']);
    expect(derived.messages[0]?.sequence).toBe(8);
  });

  it('keeps canonical source and answer order once the source row arrives', () => {
    const derived = deriveTranscript(
      [message('ordering-answer', 9), message('ordering-source', 8, true)], [submitted], true,
    );
    expect(derived.messages.map(row => row.id)).toEqual(['ordering-source', 'ordering-answer']);
    expect(derived.messages.filter(row => row.client_message_id === submitted.clientId)).toHaveLength(1);
  });

  it('does not confuse equal text from a member and the model', () => {
    const answer = { ...message('ordering-answer', 9), content_text: submitted.text };
    const derived = deriveTranscript([answer, message('ordering-source', 8, true)], [submitted], true);
    expect(derived.messages.map(row => row.author_kind)).toEqual(['member', 'system']);
    expect(derived.messages).toHaveLength(2);
  });
});
