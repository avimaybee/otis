/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { reduceThinking } from '../src/api/thinking.js';
import type { PublicActivity } from '@otis/contracts';

let cursor = 0;
function thinking(runId: string, payload: Record<string, unknown>): PublicActivity {
  cursor += 1;
  return {
    schema_version: 1,
    id: `act-${runId}-${cursor}`,
    cursor,
    workspace_id: 'ws',
    chat_id: 'chat',
    run_id: runId,
    created_at: new Date().toISOString(),
    type: 'reasoning_summary',
    payload,
  };
}

describe('thinking reducer', () => {
  it('keeps 200 small deltas below the cap complete', () => {
    cursor = 0;
    const activities = Array.from({ length: 200 }, (_, index) =>
      thinking('run-1', { text: `w${index} `, provider: 'gemini', round_index: 0, block_id: 's0', content_kind: 'summary', mode: 'append', state: 'streaming' }),
    );
    const { blocks } = reduceThinking(activities, 'running');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe(Array.from({ length: 200 }, (_, index) => `w${index} `).join(''));
    expect(blocks[0]!.state).toBe('streaming');
  });

  it('replaces snapshots without repeating prefixes', () => {
    cursor = 0;
    const { blocks } = reduceThinking([
      thinking('run-1', { text: 'Checking the', block_id: 's0', mode: 'snapshot', state: 'streaming', round_index: 0 }),
      thinking('run-1', { text: 'Checking the bakery', block_id: 's0', mode: 'snapshot', state: 'complete', round_index: 0 }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe('Checking the bakery');
    expect(blocks[0]!.state).toBe('complete');
  });

  it('keeps repeated words from distinct records intact', () => {
    cursor = 0;
    const { blocks } = reduceThinking([
      thinking('run-1', { text: 'yes ', block_id: 's0', mode: 'append', state: 'streaming', round_index: 0 }),
      thinking('run-1', { text: 'yes ', block_id: 's0', mode: 'append', state: 'complete', round_index: 0 }),
    ]);
    expect(blocks[0]!.text).toBe('yes yes ');
  });

  it('preserves block identity and order across rounds', () => {
    cursor = 0;
    const { blocks } = reduceThinking([
      thinking('run-1', { text: 'a', block_id: 's0', mode: 'append', state: 'complete', round_index: 0 }),
      thinking('run-1', { text: 'b', block_id: 's0', mode: 'append', state: 'complete', round_index: 1 }),
    ]);
    expect(blocks.map(block => block.key)).toEqual(['run-1:0:s0', 'run-1:1:s0']);
  });

  it('marks unfinished blocks interrupted at terminal run status', () => {
    cursor = 0;
    const { blocks } = reduceThinking(
      [thinking('run-1', { text: 'half ', block_id: 's0', mode: 'append', state: 'streaming', round_index: 0 })],
      'failed',
    );
    expect(blocks[0]!.state).toBe('interrupted');
    expect(blocks[0]!.text).toBe('half ');
  });

  it('marks the display cap once without stopping the answer', () => {
    cursor = 0;
    const { blocks } = reduceThinking([
      thinking('run-1', { text: 'a', block_id: 's0', mode: 'append', state: 'streaming', round_index: 0 }),
      thinking('run-1', { text: '', block_id: 's0', mode: 'append', state: 'truncated', round_index: 0 }),
    ]);
    expect(blocks[0]!.truncated).toBe(true);
    expect(blocks[0]!.state).toBe('truncated');
    expect(blocks[0]!.text).toBe('a');
  });

  it('keeps legacy summaries separate without joining them', () => {
    cursor = 0;
    const state = reduceThinking([
      thinking('run-1', { text: 'old note', provider: 'gemini', round_index: 0 }),
      thinking('run-1', { text: 'new note', block_id: 's0', mode: 'append', state: 'complete', round_index: 0 }),
    ]);
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]!.text).toBe('new note');
    expect(state.legacy).toHaveLength(1);
    expect(state.legacy[0]!.text).toBe('old note');
  });

  it('ignores replayed record identities without losing distinct words', () => {
    cursor = 0;
    const first = thinking('run-1', { text: 'yes ', block_id: 's0', mode: 'append', state: 'streaming', round_index: 0 });
    const { blocks } = reduceThinking([first, { ...first }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe('yes ');
  });

  it('produces no blocks when nothing displayable arrived', () => {
    cursor = 0;
    expect(reduceThinking([], 'succeeded')).toEqual({ blocks: [], legacy: [] });
  });
});
