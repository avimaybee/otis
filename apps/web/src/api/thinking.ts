/**
 * Thinking reducer: groups `reasoning_summary` activity into one Thinking
 * disclosure per run. Records carrying the additive block fields
 * (block_id, content_kind, mode, state) fold by (run, round, block) in cursor
 * order: `snapshot` replaces that block's base, `append` concatenates.
 * Identity is always record ID/cursor, never text equality, so repeated words
 * from distinct deltas survive and replays add nothing.
 *
 * Records without block metadata are legacy summaries and render separately;
 * their unknown semantics are never blindly joined into new blocks.
 */

import type { PublicActivity, RunStatus } from '@otis/contracts';

export type ThinkingContentKind = 'summary' | 'provider_reasoning';
export type ThinkingBlockState = 'streaming' | 'complete' | 'interrupted' | 'truncated';

export interface ThinkingBlock {
  key: string;
  runId: string;
  roundIndex: number;
  blockId: string;
  provider?: string;
  contentKind: ThinkingContentKind;
  state: ThinkingBlockState;
  text: string;
  firstCursor: number;
  lastCursor: number;
  truncated: boolean;
}

export interface LegacySummary {
  id: string;
  provider?: string;
  text: string;
}

export interface ThinkingState {
  blocks: ThinkingBlock[];
  legacy: LegacySummary[];
}

interface ThinkingPayload {
  text?: unknown;
  provider?: unknown;
  round_index?: unknown;
  block_id?: unknown;
  content_kind?: unknown;
  mode?: unknown;
  state?: unknown;
}

const TERMINAL_RUN: RunStatus[] = ['succeeded', 'partial', 'failed', 'cancelled'];

export function reduceThinking(activities: PublicActivity[], runStatus?: RunStatus): ThinkingState {
  const blocks = new Map<string, ThinkingBlock>();
  const legacy: LegacySummary[] = [];
  const seen = new Set<string>();
  const ordered = [...activities].sort((left, right) => left.cursor - right.cursor);
  for (const activity of ordered) {
    if (activity.type !== 'reasoning_summary') continue;
    // Record identity (never text equality): replayed rows add nothing and
    // repeated words from distinct deltas survive.
    if (seen.has(activity.id)) continue;
    seen.add(activity.id);
    const payload = (activity.payload ?? {}) as ThinkingPayload;
    const text = typeof payload.text === 'string' ? payload.text : '';
    const provider = typeof payload.provider === 'string' ? payload.provider : undefined;
    const roundIndex = typeof payload.round_index === 'number' ? payload.round_index : 0;
    const blockId = typeof payload.block_id === 'string' && payload.block_id ? payload.block_id : null;
    if (!blockId) {
      if (text) legacy.push({ id: activity.id, provider, text });
      continue;
    }
    const contentKind: ThinkingContentKind = payload.content_kind === 'provider_reasoning' ? 'provider_reasoning' : 'summary';
    const mode = payload.mode === 'snapshot' ? 'snapshot' : 'append';
    const state: ThinkingBlockState =
      payload.state === 'complete' || payload.state === 'truncated' || payload.state === 'interrupted' ? payload.state : 'streaming';
    const key = `${activity.run_id}:${roundIndex}:${blockId}`;
    const existing = blocks.get(key);
    if (!existing) {
      blocks.set(key, {
        key,
        runId: activity.run_id,
        roundIndex,
        blockId,
        provider,
        contentKind,
        state,
        text,
        firstCursor: activity.cursor,
        lastCursor: activity.cursor,
        truncated: state === 'truncated',
      });
    } else {
      existing.text = mode === 'snapshot' && activity.cursor >= existing.lastCursor ? text : existing.text + text;
      existing.lastCursor = activity.cursor;
      existing.state = state;
      if (!existing.provider && provider) existing.provider = provider;
      if (state === 'truncated') existing.truncated = true;
    }
  }
  const terminal = runStatus !== undefined && (TERMINAL_RUN as string[]).includes(runStatus);
  const result = [...blocks.values()].sort((left, right) => left.firstCursor - right.firstCursor);
  if (terminal) {
    for (const block of result) {
      if (block.state === 'streaming') block.state = 'interrupted';
    }
  }
  return { blocks: result, legacy };
}
