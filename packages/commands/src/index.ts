/**
 * @otis/commands
 * Shared slash-command grammar. Parsing is deterministic and surface-aware;
 * execution of the resulting effects belongs to the owning Worker route.
 */

export * from './registry.js';
export * from './parse.js';
export * from './help.js';