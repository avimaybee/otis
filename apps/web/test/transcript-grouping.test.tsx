/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import {
  describeRunAnswers,
  formatOutcomeSummary,
  groupActivitiesByRun,
  joinRunTextChunks,
} from '../src/components/Transcript.js';
import type { ChatMessage, PublicActivity } from '@otis/contracts';

function message(id: string, runId: string | null, kind: 'member' | 'system'): ChatMessage {
  return {
    id,
    workspace_id: 'ws',
    chat_id: 'chat',
    author_user_id: kind === 'member' ? 'user_1' : null,
    author_display_name: kind === 'member' ? 'Avi' : 'Otis',
    author_kind: kind,
    channel: 'web',
    inbound_message_id: `in_${id}`,
    client_message_id: null,
    content_text: `text ${id}`,
    media_id: null,
    run_id: runId,
    sequence: 1,
    created_at: '2026-10-06T10:00:00.000Z',
    updated_at: '2026-10-06T10:00:00.000Z',
  } as ChatMessage;
}

function activity(id: string, runId: string, type: PublicActivity['type'], text?: unknown): PublicActivity {
  return {
    id,
    workspace_id: 'ws',
    chat_id: 'chat',
    run_id: runId,
    cursor: 1,
    type,
    payload: text === undefined ? {} : { text },
    created_at: '2026-10-06T10:00:00.000Z',
  } as PublicActivity;
}

describe('Outcome receipts', () => {
  it('hides raw entity IDs from the normal confirmation', () => {
    expect(formatOutcomeSummary(`Logged quote event for entity 'ent_01JABC123'.`, 1)).toBe('Logged quote event');
  });
  it('keeps human summaries and the empty fallback intact', () => {
    expect(formatOutcomeSummary('Thai Shop offer updated.', 1)).toBe('Thai Shop offer updated saved');
    expect(formatOutcomeSummary('Offer saved.', 1)).toBe('Offer saved');
    expect(formatOutcomeSummary(null, 2)).toBe('2 changes saved');
    expect(formatOutcomeSummary(`Saved visit (mem_01JXYZ).`, 1)).toBe('Saved visit');
  });
});

describe('F12 transcript grouping', () => {
  it('groups activities by run while preserving order', () => {
    const grouped = groupActivitiesByRun([
      activity('a1', 'run_1', 'step_started'),
      activity('a2', 'run_2', 'step_started'),
      activity('a3', 'run_1', 'text_chunk', 'hi'),
    ]);
    expect([...grouped.keys()]).toEqual(['run_1', 'run_2']);
    expect(grouped.get('run_1')!.map(item => item.id)).toEqual(['a1', 'a3']);
    expect(grouped.get('run_2')!.map(item => item.id)).toEqual(['a2']);
  });

  it('joins only text chunks and ignores non-string payloads', () => {
    const text = joinRunTextChunks([
      activity('a1', 'run_1', 'text_chunk', 'Hello '),
      activity('a2', 'run_1', 'step_started'),
      activity('a3', 'run_1', 'text_chunk', 'there'),
      activity('a4', 'run_1', 'text_chunk', 42),
    ]);
    expect(text).toBe('Hello there');
  });

  it('formats multi-round text chunks into paragraphs separated by newlines', () => {
    const text = joinRunTextChunks([
      activity('a1', 'run_1', 'text_chunk', { text: 'Proving it end-to-end on fakes — starting with the test clients.', round_index: 0 }),
      activity('a2', 'run_1', 'text_chunk', { text: 'Proving it out — I will spin up a couple fakes.', round_index: 1 }),
    ]);
    expect(text).toBe(
      'Proving it end-to-end on fakes — starting with the test clients.\n\nProving it out — I will spin up a couple fakes.',
    );
  });

  it('concatenates chunks within the same round and separates distinct rounds', () => {
    const text = joinRunTextChunks([
      activity('a1', 'run_1', 'text_chunk', { text: 'Round zero part A. ', round_index: 0 }),
      activity('a2', 'run_1', 'text_chunk', { text: 'Round zero part B.', round_index: 0 }),
      activity('a3', 'run_1', 'text_chunk', { text: 'Round one only.', round_index: 1 }),
    ]);
    expect(text).toBe('Round zero part A. Round zero part B.\n\nRound one only.');
  });

  it('describes member-only runs as unanswered with the latest member message', () => {
    const state = describeRunAnswers([
      message('m1', 'run_1', 'member'),
      message('m2', 'run_1', 'member'),
    ]).get('run_1')!;
    expect(state.hasAgentAnswer).toBe(false);
    expect(state.lastMemberMessageId).toBe('m2');
    expect(state.firstAgentMessageId).toBeNull();
  });

  it('marks the first agent message and answered runs independently per run', () => {
    const states = describeRunAnswers([
      message('m1', 'run_1', 'member'),
      message('a1', 'run_1', 'system'),
      message('a2', 'run_1', 'system'),
      message('m2', 'run_2', 'member'),
    ]);
    expect(states.get('run_1')).toMatchObject({
      hasAgentAnswer: true,
      lastMemberMessageId: 'm1',
      firstAgentMessageId: 'a1',
    });
    expect(states.get('run_2')).toMatchObject({
      hasAgentAnswer: false,
      lastMemberMessageId: 'm2',
      firstAgentMessageId: null,
    });
  });

  it('ignores messages without a run', () => {
    expect(describeRunAnswers([message('m1', null, 'member')]).size).toBe(0);
  });
});
