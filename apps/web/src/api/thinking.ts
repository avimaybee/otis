/**
 * Thinking reducer: groups `reasoning_summary` activity into one Thinking
 * disclosure per run. Records carrying the additive block fields
 * (block_id, content_kind, mode, state) fold by (run, round, block,
 * generation) in cursor order: `snapshot` replaces that block's base,
 * `append` concatenates. Rows without a generation are legacy records and
 * fold exactly as before. Identity is always record ID/cursor, never text
 * equality, so repeated words from distinct deltas survive and replays add
 * nothing.
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
  /**
   * Publication generation (execution + provider request attempt). Retried
   * requests reuse provider block IDs; the generation keeps a failed
   * request's summaries apart from its replacement. Null for legacy rows.
   */
  generation: string | null;
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
  generation?: unknown;
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
    const generation = typeof payload.generation === 'string' && payload.generation ? payload.generation : null;
    // Retry generations reuse provider block IDs: the generation joins the
    // fold key so a replacement attempt's summaries never concatenate into
    // the failed request's blocks. Legacy rows (no generation) keep the
    // historical key shape.
    const key = generation
      ? `${activity.run_id}:${roundIndex}:${blockId}:g${generation}`
      : `${activity.run_id}:${roundIndex}:${blockId}`;
    const existing = blocks.get(key);
    if (!existing) {
      blocks.set(key, {
        key,
        runId: activity.run_id,
        roundIndex,
        blockId,
        generation,
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
  // A superseded request generation never resumes: generations start strictly
  // in order, so the last-started generation per run and round is newest.
  // Older generations' still-streaming blocks show as interrupted (kept what
  // arrived) instead of concatenating into the replacement. Terminal
  // complete/truncated states are preserved; legacy rows count as oldest.
  const newestGenerationByScope = new Map<string, string | null>();
  for (const block of result) {
    newestGenerationByScope.set(`${block.runId}:${block.roundIndex}`, block.generation);
  }
  for (const block of result) {
    if (block.state !== 'streaming') continue;
    if (newestGenerationByScope.get(`${block.runId}:${block.roundIndex}`) !== block.generation) {
      block.state = 'interrupted';
    }
  }
  if (terminal) {
    for (const block of result) {
      if (block.state === 'streaming') block.state = 'interrupted';
    }
  }
  return { blocks: result, legacy };
}
