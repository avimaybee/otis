/**
 * @otis/channels/telegramSend
 * Pure Telegram outbound formatting: plain-text part splitting and
 * reply-markup selection. No network, no storage, no secrets.
 * In accordance with docs/contracts.md and plans/009A-text-loop-handoff.md.
 */

/** Conservative application limit: Telegram allows 4096 after entities; plain text has none. */
export const TELEGRAM_MAX_PART_CHARS = 4000;

export interface TelegramSendPart {
  text: string;
  partIndex: number;
  partCount: number;
}

/**
 * Splits plain text into ordered parts of at most 4000 UTF-16 code units,
 * preferably at a newline or space, never between a surrogate pair and
 * never dropping content. No parse_mode is used by callers, so <>& need no
 * escaping and content is never truncated.
 */
export function splitTelegramText(text: string, maxChars = TELEGRAM_MAX_PART_CHARS): string[] {
  if (text.length === 0) return [''];
  const units = Array.from(text);
  const parts: string[] = [];
  let current = '';
  let currentUnits = 0;
  let lastBreakAt = -1;
  const isBreak = (ch: string) => ch === '\n' || ch === ' ';
  for (const ch of units) {
    const size = ch.length;
    if (currentUnits + size > maxChars && current.length > 0) {
      if (lastBreakAt >= 0) {
        parts.push(current.slice(0, lastBreakAt + 1));
        const rest = current.slice(lastBreakAt + 1) + ch;
        current = rest;
        currentUnits = [...rest].reduce((n, c) => n + c.length, 0);
      } else {
        parts.push(current);
        current = ch;
        currentUnits = size;
      }
      lastBreakAt = -1;
      // Re-scan the carried remainder for a break opportunity.
      for (let i = 0; i < current.length; i += 1) {
        if (isBreak(current[i]!)) lastBreakAt = i;
      }
      continue;
    }
    if (isBreak(ch)) lastBreakAt = current.length;
    current += ch;
    currentUnits += size;
  }
  if (current.length > 0 || parts.length === 0) parts.push(current);
  return parts;
}

export interface TelegramReplyMarkup {
  force_reply?: true;
  selective?: true;
}

/**
 * Reply markup for one part: only the final part of a delivered question
 * carries ForceReply for native answer targeting. Normal final answers
 * carry no markup.
 */
export function replyMarkupForPart(isQuestion: boolean, isFinalPart: boolean): TelegramReplyMarkup | undefined {
  if (isQuestion && isFinalPart) return { force_reply: true, selective: true };
  return undefined;
}

export function withPartIndex(parts: string[]): TelegramSendPart[] {
  return parts.map((text, partIndex) => ({ text, partIndex, partCount: parts.length }));
}
