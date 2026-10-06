/**
 * Bounded stream publication for one provider round (008B), with a per-run
 * thinking budget shared across rounds.
 *
 * Text deltas take the transient path: the first delta broadcasts immediately
 * and later buffers flush as live preview frames on a short cadence, with no
 * database write per frame. Each frame carries the round's full text so far,
 * so a dropped frame never corrupts the view. The durable remainder persists
 * exactly once on close as ordinary text_chunk rows (reconnect and terminal
 * partial replies read those, never the transient frames).
 *
 * Thinking deltas still persist per batch: they are semantic activity, not
 * preview. One serial chain owns every persisted flush: timer ticks and the
 * final drain enqueue ordered work, so a terminal record can never overtake a
 * delta and a rejected publish cannot escape as an unhandled rejection.
 * Persisted buffers are consumed only after a successful publish, so a failed
 * flush retries its remainder on the next tick or close. close() drains all
 * authorized remainder before any terminal metadata record.
 *
 * Budgets (named, under existing activity/storage limits):
 * - text records stay 2048 chars, at most 32 per round (unchanged shape/ids);
 * - live preview frames emit immediately for the first delta, then from any
 *   nonzero buffer every 100 ms (provisional cadence pending device/frame-gap
 *   measurement; thinking still coalesces on its own 400 ms cadence);
 * - thinking batches flush from 1000 chars (32-char floor) every 400 ms;
 * - at most 24,000 thinking chars per RUN (shared budget object across the
 *   round publishers of one turn); overflow input is dropped and the cap emits
 *   exactly one `truncated` record without stopping the answer/tool loop.
 * No D1 write per token: deltas accumulate in memory until a flush.
 */

import type { PublicActivityType } from '@otis/contracts';

export const TEXT_CHUNK_CHARS = 2048;
export const TEXT_PREVIEW_MS = 100;
export const TEXT_MAX_CHUNKS = 32;
export const THINKING_BATCH_CHARS = 1000;
export const THINKING_MIN_FLUSH_CHARS = 32;
export const THINKING_FLUSH_MS = 400;
export const THINKING_MAX_DISPLAY_CHARS = 24_000;

export type StreamPublishFn = (key: string, type: PublicActivityType, payload: unknown) => Promise<void>;

export interface ThinkingInput {
  text: string;
  blockId: string;
  contentKind: 'summary';
  mode: 'snapshot' | 'append';
}

/**
 * Per-run thinking budget shared by every round publisher of one turn, so
 * the display cap is genuinely per run and not reset by round boundaries.
 */
export interface SharedThinkingBudget {
  publishedChars: number;
  bufferedChars: number;
  overflowBlockId: string | null;
}

export function createThinkingBudget(): SharedThinkingBudget {
  return { publishedChars: 0, bufferedChars: 0, overflowBlockId: null };
}

interface ThinkingBlockState {
  buffer: string;
  bufferedAt: number | null;
  publishedRecords: number;
  /** True while the unpublished buffer is a pure snapshot base. */
  cleanSnapshot: boolean;
  lastState: 'streaming' | 'complete' | 'interrupted' | 'truncated';
}

/** Live preview frame: the round's full text so far, never persisted. */
export type TextPreviewFn = (text: string, seq: number) => void;

export class StreamPublisher {
  private textBuffer = '';
  private textBufferedAt: number | null = null;
  private textChunks = 0;
  /** Live preview sequence within this round; frames overwrite by sequence. */
  private textPreviewSeq = 0;
  /** Buffer length already covered by a preview frame. */
  private textPreviewCovered = 0;
  private readonly blocks = new Map<string, ThinkingBlockState>();
  private readonly budget: SharedThinkingBudget;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly publish: StreamPublishFn,
    private readonly roundIndex: number,
    private readonly provider: string,
    private readonly onFlushError: (err: unknown) => void = () => undefined,
    sharedBudget?: SharedThinkingBudget,
    private readonly publishPreview?: TextPreviewFn,
  ) {
    this.budget = sharedBudget ?? createThinkingBudget();
  }

  /** Serializes every persisted flush; a rejection is logged and the chain continues. */
  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch((err: unknown) => {
      this.onFlushError(err);
    });
  }

  /** Broadcasts the round's full text so far as a live preview frame (no D1). */
  private emitPreview(): void {
    if (!this.publishPreview || !this.textBuffer) return;
    this.textPreviewSeq += 1;
    this.textPreviewCovered = this.textBuffer.length;
    try {
      this.publishPreview(this.textBuffer, this.textPreviewSeq);
    } catch {
      // Preview is best-effort; the durable drain on close is authoritative.
    }
  }

  pushText(text: string): void {
    if (this.closed || !text) return;
    if (this.textChunks >= TEXT_MAX_CHUNKS && !this.textBuffer) return;
    this.textBuffer += text.slice(0, TEXT_MAX_CHUNKS * TEXT_CHUNK_CHARS - this.textBuffer.length);
    if (this.textBufferedAt === null) this.textBufferedAt = Date.now();
    if (this.publishPreview) {
      // Transient mode (production): immediate first frame, cadence after;
      // the durable remainder persists once on close.
      if (this.textPreviewSeq === 0) this.emitPreview();
    } else if (this.textBuffer.length >= TEXT_CHUNK_CHARS) {
      // Legacy persisted mode (tests/harness without a live bus).
      this.enqueue(() => this.flushTextWork());
    }
  }

  pushThinking(input: ThinkingInput): void {
    if (this.closed || !input.text) return;
    // The aggregate cap drops overflow input; close() emits the single
    // truncation record for the first block that overflowed.
    const remaining =
      THINKING_MAX_DISPLAY_CHARS - this.budget.publishedChars - this.budget.bufferedChars;
    if (remaining <= 0) {
      if (this.budget.overflowBlockId === null) this.budget.overflowBlockId = input.blockId;
      return;
    }
    const text = input.text.length > remaining ? input.text.slice(0, remaining) : input.text;
    if (input.text.length > remaining && this.budget.overflowBlockId === null) {
      this.budget.overflowBlockId = input.blockId;
    }
    let block = this.blocks.get(input.blockId);
    if (!block) {
      block = {
        buffer: '',
        bufferedAt: null,
        publishedRecords: 0,
        cleanSnapshot: false,
        lastState: 'streaming',
      };
      this.blocks.set(input.blockId, block);
    }
    if (input.mode === 'snapshot') {
      // A snapshot replaces the unpublished remainder. Published batches are
      // history the client already folded; per the verified Gemini channel the
      // snapshot (step.start) precedes that block's deltas.
      this.budget.bufferedChars -= block.buffer.length;
      block.buffer = text;
      block.cleanSnapshot = block.publishedRecords === 0;
    } else {
      block.buffer += text;
      block.cleanSnapshot = false;
    }
    this.budget.bufferedChars += text.length;
    if (block.bufferedAt === null) block.bufferedAt = Date.now();
    if (block.buffer.length >= THINKING_BATCH_CHARS) {
      const blockId = input.blockId;
      this.enqueue(() => this.flushBlockWork(blockId, 'streaming'));
    }
  }

  /**
   * Flushes whatever is due. The handler drives this on one interval; every
   * persisted flush joins the serial chain, so overlapping ticks cannot
   * interleave. Preview frames emit directly (no D1, no chain).
   */
  tick(now = Date.now()): Promise<void> {
    if (this.closed) return this.chain;
    if (this.publishPreview) {
      if (this.textBuffer.length > this.textPreviewCovered && this.textBufferedAt !== null && now - this.textBufferedAt >= TEXT_PREVIEW_MS) {
        this.emitPreview();
      }
    } else if (this.textBuffer && this.textBufferedAt !== null && now - this.textBufferedAt >= TEXT_PREVIEW_MS) {
      this.enqueue(() => this.flushTextWork());
    }
    for (const [blockId, block] of this.blocks) {
      if (
        block.buffer.length >= THINKING_MIN_FLUSH_CHARS
        && block.bufferedAt !== null
        && now - block.bufferedAt >= THINKING_FLUSH_MS
      ) {
        this.enqueue(() => this.flushBlockWork(blockId, 'streaming'));
      }
    }
    return this.chain;
  }

  /**
   * Drains all authorized remainder, then marks published blocks terminal.
   * Returns true when everything drained; false leaves the intact remainder
   * in memory and reports through onFlushError. The live preview is a
   * best-effort accelerator with the authoritative answer persisted
   * separately, so a false return never claims drained preview rows.
   */
  async close(outcome: 'complete' | 'interrupted'): Promise<boolean> {
    if (this.closed) return this.chain.then(() => this.drainOk);
    this.closed = true;
    // Final live frame first, so the preview is complete even when the
    // cadence timer had not fired; the durable drain below follows it.
    if (this.textBuffer.length > this.textPreviewCovered) this.emitPreview();
    await this.chain;
    try {
      await this.drainWork(outcome);
    } catch (err) {
      this.drainOk = false;
      this.onFlushError(err);
    }
    return this.drainOk;
  }

  private drainOk = true;

  private async drainWork(outcome: 'complete' | 'interrupted'): Promise<void> {
    await this.flushTextWork();
    for (const [blockId, block] of this.blocks) {
      // One terminal state per block: truncation takes precedence over the
      // turn outcome, so a single `_end` receipt carries the honest state and
      // no duplicate end receipt can collide on the idempotent record key.
      const terminal = this.budget.overflowBlockId === blockId ? 'truncated' : outcome;
      while (block.buffer) {
        await this.flushBlockWork(blockId, outcome);
      }
      if (terminal === 'truncated') {
        await this.publish(`r${this.roundIndex}_think_${blockId}_end`, 'reasoning_summary', {
          provider: this.provider,
          text: '',
          round_index: this.roundIndex,
          block_id: blockId,
          content_kind: 'summary',
          mode: 'append',
          state: 'truncated',
        });
        block.lastState = 'truncated';
      } else if (block.publishedRecords > 0 && block.lastState === 'streaming') {
        // Final metadata-only record: terminal state without repeating text.
        await this.publish(`r${this.roundIndex}_think_${blockId}_end`, 'reasoning_summary', {
          provider: this.provider,
          text: '',
          round_index: this.roundIndex,
          block_id: blockId,
          content_kind: 'summary',
          mode: 'append',
          state: terminal,
        });
        block.lastState = terminal;
      }
    }
  }

  private async flushTextWork(): Promise<void> {
    while (this.textBuffer && this.textChunks < TEXT_MAX_CHUNKS) {
      const text = this.textBuffer.slice(0, TEXT_CHUNK_CHARS);
      const chunk = this.textChunks;
      await this.publish(`r${this.roundIndex}_text${chunk}`, 'text_chunk', {
        text,
        round_index: this.roundIndex,
      });
      this.textBuffer = this.textBuffer.slice(TEXT_CHUNK_CHARS);
      this.textChunks += 1;
    }
    if (this.textChunks >= TEXT_MAX_CHUNKS) this.textBuffer = '';
    if (!this.textBuffer) this.textBufferedAt = null;
  }

  private async flushBlockWork(blockId: string, state: 'streaming' | 'complete' | 'interrupted'): Promise<void> {
    const block = this.blocks.get(blockId);
    if (!block || !block.buffer) return;
    const text = block.buffer.slice(0, THINKING_BATCH_CHARS);
    const mode = block.cleanSnapshot ? 'snapshot' : 'append';
    const record = block.publishedRecords;
    await this.publish(`r${this.roundIndex}_think_${blockId}_${record}`, 'reasoning_summary', {
      provider: this.provider,
      text,
      round_index: this.roundIndex,
      block_id: blockId,
      content_kind: 'summary',
      mode,
      state,
    });
    block.buffer = block.buffer.slice(THINKING_BATCH_CHARS);
    this.budget.bufferedChars -= text.length;
    this.budget.publishedChars += text.length;
    block.cleanSnapshot = false;
    block.bufferedAt = block.buffer ? Date.now() : null;
    block.publishedRecords += 1;
    block.lastState = state;
  }
}
