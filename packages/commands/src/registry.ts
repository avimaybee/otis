/**
 * @otis/commands/registry
 * The single supported slash-command registry. Both web and Telegram read
 * this list, so a command cannot exist on one channel without the other.
 * In accordance with docs/contracts.md (shared commands).
 */

import type { CommandDescriptor, CommandSurface } from '@otis/contracts';

export interface CommandDefinition extends CommandDescriptor {
  /** Channels this command may run on. `/start` is Telegram-only. */
  surfaces: readonly CommandSurface[];
}

/**
 * Order is the display order for the picker and for `/help`.
 */
export const COMMAND_REGISTRY: readonly CommandDefinition[] = [
  {
    name: 'model',
    summary: 'Show or set the model for this chat.',
    usage: '/model [key|default]',
    available: true,
    deterministic: true,
    surfaces: ['web', 'telegram'],
  },
  {
    name: 'thinking',
    summary: 'Show or set the thinking effort for this chat.',
    usage: '/thinking [level|default]',
    available: true,
    deterministic: true,
    surfaces: ['web', 'telegram'],
  },
  {
    name: 'workspace',
    summary: 'Show or switch the workspace for this surface.',
    usage: '/workspace [name]',
    available: true,
    deterministic: true,
    surfaces: ['web', 'telegram'],
  },
  {
    name: 'today',
    summary: 'Show your due work.',
    usage: '/today',
    available: true,
    deterministic: true,
    surfaces: ['web', 'telegram'],
  },
  {
    name: 'undo',
    summary: 'Undo the latest reversible action from your own chat.',
    usage: '/undo [target]',
    available: true,
    deterministic: true,
    surfaces: ['web', 'telegram'],
  },
  {
    name: 'help',
    summary: 'List the available commands.',
    usage: '/help',
    available: true,
    deterministic: true,
    surfaces: ['web', 'telegram'],
  },
  {
    name: 'sheet',
    summary: 'Create a private spreadsheet snapshot of current workspace data.',
    usage: '/sheet',
    available: true,
    deterministic: true,
    surfaces: ['web', 'telegram'],
  },
  {
    name: 'start',
    summary: 'Link your Telegram account to Otis.',
    usage: '/start <code>',
    available: true,
    deterministic: true,
    surfaces: ['telegram'],
  },
] as const;

export function findCommand(name: string): CommandDefinition | undefined {
  const lowered = name.toLowerCase();
  return COMMAND_REGISTRY.find((command) => command.name === lowered);
}

export function listCommands(surface: CommandSurface): CommandDescriptor[] {
  return COMMAND_REGISTRY.filter((command) => command.surfaces.includes(surface)).map((command) => ({
    name: command.name,
    summary: command.summary,
    usage: command.usage,
    available: command.available,
    deterministic: command.deterministic,
  }));
}