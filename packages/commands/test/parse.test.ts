import { describe, it, expect } from 'vitest';
import { helpEntries, parseCommandText, renderHelp, shouldSuggestCommands } from '../src/index.js';

describe('command parsing', () => {
  it('parses an exact supported first token as a command', () => {
    expect(parseCommandText('/model')).toEqual({
      kind: 'command',
      name: 'model',
      args: [],
      addressed: false,
    });
    expect(parseCommandText('  /model gemini-flash')).toEqual({
      kind: 'command',
      name: 'model',
      args: ['gemini-flash'],
      addressed: false,
    });
  });

  it('treats a mid-sentence slash as ordinary prose', () => {
    const text = 'we agreed on 3/4 and I will visit Bistro';
    expect(parseCommandText(text)).toEqual({ kind: 'text', text });
  });

  it('treats // as an escaped literal slash', () => {
    expect(parseCommandText('//model')).toEqual({ kind: 'text', text: '/model' });
    expect(parseCommandText('//not a command')).toEqual({ kind: 'text', text: '/not a command' });
  });

  it('reports unknown command names for help handling', () => {
    expect(parseCommandText('/nope now')).toEqual({
      kind: 'unknown_command',
      name: 'nope',
      args: ['now'],
      addressed: false,
    });
  });

  it('accepts the Telegram bot suffix only on telegram', () => {
    expect(parseCommandText('/model@thisbot', 'telegram')).toEqual({
      kind: 'command',
      name: 'model',
      args: [],
      addressed: true,
    });
    expect(parseCommandText('/model@otherbot', 'telegram')).toEqual({
      kind: 'text',
      text: '/model@otherbot',
    });
    expect(parseCommandText('/model@thisbot', 'web')).toEqual({
      kind: 'text',
      text: '/model@thisbot',
    });
  });

  it('hides telegram-only commands from web', () => {
    expect(parseCommandText('/start abc123', 'web')).toEqual({
      kind: 'unknown_command',
      name: 'start',
      args: ['abc123'],
      addressed: false,
    });
    expect(parseCommandText('/start abc123', 'telegram').kind).toBe('command');
  });

  it('suggests only for a leading unescaped slash without arguments yet', () => {
    expect(shouldSuggestCommands('/', 1)).toBe(true);
    expect(shouldSuggestCommands('/mo', 3)).toBe(true);
    expect(shouldSuggestCommands('/model ', 7)).toBe(false);
    expect(shouldSuggestCommands('//mo', 4)).toBe(false);
    expect(shouldSuggestCommands('hello /mo', 9)).toBe(false);
    expect(shouldSuggestCommands('/mo', 1)).toBe(false);
  });

  it('generates help from the registry', () => {
    expect(helpEntries('web').map((entry) => entry.usage)).toContain('/model [key|default]');
    expect(helpEntries('web').map((entry) => entry.usage)).not.toContain('/start <code>');
    expect(helpEntries('telegram').map((entry) => entry.usage)).toContain('/start <code>');
    expect(renderHelp('web')).toContain('/today');
  });
});