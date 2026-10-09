import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_IDS } from '../src/stories/inventory.js';
import * as Entry from '../src/stories/Entry.stories.js';
import * as Chat from '../src/stories/Chat.stories.js';
import * as Message from '../src/stories/Message.stories.js';
import * as Stream from '../src/stories/Stream.stories.js';
import * as Work from '../src/stories/Work.stories.js';
import * as Question from '../src/stories/Question.stories.js';
import * as Undo from '../src/stories/Undo.stories.js';
import * as Scroll from '../src/stories/Scroll.stories.js';
import * as Composer from '../src/stories/Composer.stories.js';
import * as Command from '../src/stories/Command.stories.js';
import * as Nav from '../src/stories/Nav.stories.js';
import * as Settings from '../src/stories/Settings.stories.js';
import * as Brief from '../src/stories/Brief.stories.js';
import * as Offline from '../src/stories/Offline.stories.js';
import * as Voice from '../src/stories/Voice.stories.js';
import * as Table from '../src/stories/Table.stories.js';
import * as Telegram from '../src/stories/Telegram.stories.js';
import * as BusinessCapabilities from '../src/stories/BusinessCapabilities.stories.js';

function storyNames(module: Record<string, unknown>): string[] {
  return Object.values(module)
    .filter(value => value !== null && typeof value === 'object' && 'name' in (value as Record<string, unknown>))
    .map(value => String((value as { name: unknown }).name));
}

describe('008A story inventory', () => {
  it('pins the checked-in inventory to the design.md fixture table exactly', () => {
    // The design table is the single source of required IDs; a copied list
    // alone cannot catch a later spec addition. Parse section 13 directly.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const design = readFileSync(join(root, 'design.md'), 'utf8');
    const start = design.indexOf('## 13.');
    const end = design.indexOf('## 14.');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const expected = new Set<string>();
    for (const line of design.slice(start, end).split('\n')) {
      const cells = line.split('|').map(cell => cell.trim());
      if (cells.length < 3 || !/^[a-z][a-z0-9-]*\//.test(cells[1] ?? '')) continue;
      for (const token of cells[1].split(',').map(token => token.trim().replace(/^`|`$/g, ''))) {
        if (/^[a-z][a-z0-9-]*\/[a-z0-9-]+$/.test(token)) expected.add(token);
      }
    }
    expect(expected.size).toBeGreaterThan(0);
    expect([...FIXTURE_IDS].sort()).toEqual([...expected].sort());
  });

  it('maps every design.md fixture ID to a production-component story', () => {
    const modules = [Entry, Chat, Message, Stream, Work, Question, Undo, Scroll, Composer, Command, Nav, Settings, Brief, Offline, Voice, Telegram, Table, BusinessCapabilities];
    const actual = new Set(modules.flatMap(storyNames));
    const missing = FIXTURE_IDS.filter(id => !actual.has(id));
    expect(missing).toEqual([]);
  });
});
