/**
 * @otis/commands/parse
 * Deterministic first-token command parsing shared by web and Telegram.
 * No model call, no storage, no surface-specific behavior.
 */

import type { CommandSurface } from '@otis/contracts';
import { findCommand } from './registry.js';

export interface ParsedCommand {
  kind: 'command';
  name: string;
  args: string[];
  /** True when the token carried a Telegram `@thisbot` suffix. */
  addressed: boolean;
}

export interface ParsedUnknownCommand {
  kind: 'unknown_command';
  name: string;
  args: string[];
  addressed: boolean;
}

export interface ParsedPlainText {
  kind: 'text';
  text: string;
}

export type ParseResult = ParsedCommand | ParsedUnknownCommand | ParsedPlainText;

/**
 * Parses one outbound text message.
 *
 * - `/name` at the first non-space position is a command.
 * - `/name@bot` is accepted on Telegram when the suffix names this bot
 *   (case-insensitive, without the configured name it must match the
 *   literal `@thisbot` escape exactly as before); any other suffix is
 *   cross-bot traffic and stays literal text.
 * - `//anything` is literal text with the leading slash removed.
 * - A slash anywhere else is ordinary prose.
 */
export function parseCommandText(
  text: string,
  surface: CommandSurface = 'web',
  botUsername?: string,
): ParseResult {
  const trimmedStart = text.replace(/^\s+/, '');
  if (!trimmedStart.startsWith('/')) {
    return { kind: 'text', text };
  }

  // `//` escapes the leading slash and always sends literal text.
  if (trimmedStart.startsWith('//')) {
    return { kind: 'text', text: trimmedStart.slice(1) };
  }

  const match = /^\/([^\s@]+)(@[^\s]+)?(\s+([\s\S]*))?$/.exec(trimmedStart);
  if (!match) {
    return { kind: 'text', text };
  }

  const name = match[1]!.toLowerCase();
  const addressedSuffix = match[2];
  const argText = (match[4] ?? '').trim();
  const args = argText.length > 0 ? argText.split(/\s+/) : [];

  if (addressedSuffix) {
    // Only Telegram mentions carry a bot suffix; elsewhere it is literal text.
    if (surface !== 'telegram') {
      return { kind: 'text', text };
    }
    const configured = (botUsername ?? '').trim().replace(/^@/, '').toLowerCase();
    const accepted = configured.length > 0 ? `@${configured}` : '@thisbot';
    if (addressedSuffix.toLowerCase() !== accepted) {
      return { kind: 'text', text };
    }
  }

  const definition = findCommand(name);
  if (!definition || !definition.surfaces.includes(surface)) {
    return { kind: 'unknown_command', name, args, addressed: Boolean(addressedSuffix) };
  }

  return { kind: 'command', name, args, addressed: Boolean(addressedSuffix) };
}

/**
 * True when a draft should open the command picker: a leading slash that is
 * not the `//` escape.
 */
export function shouldSuggestCommands(text: string, selectionStart: number): boolean {
  if (selectionStart !== text.length) return false;
  const trimmedStart = text.replace(/^\s+/, '');
  if (!trimmedStart.startsWith('/') || trimmedStart.startsWith('//')) return false;
  return !/\s/.test(trimmedStart.slice(1));
}