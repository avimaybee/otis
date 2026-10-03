/**
 * @otis/commands/help
 * Help text is generated from the registry so it can never drift from the
 * set of supported commands.
 */

import type { CommandSurface } from '@otis/contracts';
import { COMMAND_REGISTRY } from './registry.js';

export interface HelpEntry {
  usage: string;
  summary: string;
}

export function helpEntries(surface: CommandSurface): HelpEntry[] {
  return COMMAND_REGISTRY.filter((command) => command.surfaces.includes(surface)).map((command) => ({
    usage: command.usage,
    summary: command.available
      ? command.summary
      : `${command.summary} Not available yet.`,
  }));
}

export function renderHelp(surface: CommandSurface): string {
  const lines = helpEntries(surface).map((entry) => `${entry.usage} — ${entry.summary}`);
  return ['Commands you can use here:', ...lines].join('\n');
}

export function renderUnknownCommand(name: string, surface: CommandSurface): string {
  return `I don't know /${name}. ${renderHelp(surface)}`;
}