/** @vitest-environment happy-dom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownTable, tableToTsv, isShortNoWrapText } from '../src/components/MarkdownTable.js';
import { Transcript } from '../src/components/Transcript.js';
import type { ChatMessage } from '@otis/contracts';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.restoreAllMocks());
async function mount(element: React.ReactElement) {
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  await React.act(async () => root.render(element));
  return { host, unmount: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}
const message = (overrides: Partial<ChatMessage> & { id: string; content_text: string }): ChatMessage => ({ workspace_id: 'ws_1', chat_id: 'chat_1', author_user_id: null, author_kind: 'system', channel: 'web', inbound_message_id: null, client_message_id: null, media_id: null, run_id: null, sequence: 1, created_at: '2026-10-02T10:00:00.000Z', updated_at: '2026-10-02T10:00:00.000Z', ...overrides });

describe('MarkdownTable', () => {
  it('exports tab-separated values with quoting for multiline cells', () => {
    const host = document.createElement('div');
    host.innerHTML = '<table><tr><th>Lead</th><th>Note</th></tr><tr><td>Meridian</td><td>Line one\nLine two</td></tr><tr><td>Say "hi"</td><td>plain</td></tr></table>';
    expect(tableToTsv(host.querySelector('table')!)).toBe('Lead\tNote\nMeridian\t"Line one\nLine two"\n"Say ""hi"""\tplain');
  });

  it('renders a semantic table in a labeled scroll region with a working copy action', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
    const view = await mount(
      <MarkdownTable>
        <thead><tr><th>Lead</th><th>Status</th></tr></thead>
        <tbody><tr><td>Meridian</td><td>Hot</td></tr></tbody>
      </MarkdownTable>,
    );
    const region = view.host.querySelector('[role="region"]') as HTMLElement;
    expect(region?.getAttribute('aria-label')).toBe('Data table');
    expect(region?.querySelectorAll('th')).toHaveLength(2);
    const copy = Array.from(view.host.querySelectorAll('button')).find((b) => b.textContent === 'Copy table') as HTMLButtonElement;
    await React.act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith('Lead\tStatus\nMeridian\tHot');
    expect(view.host.textContent).toContain('Copied');
    await view.unmount();
  });

  it('keeps the affordance when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true });
    const view = await mount(
      <MarkdownTable>
        <tbody><tr><td>x</td></tr></tbody>
      </MarkdownTable>,
    );
    const copy = view.host.querySelector('button') as HTMLButtonElement;
    await React.act(async () => copy.click());
    expect(view.host.textContent).toContain('Copy table');
    await view.unmount();
  });

  it('confines wide tables to their region without page overflow', () => {
    const css = readFileSync(resolve(__dirname, '../src/index.css'), 'utf-8');
    expect(css).toContain('.otis-mdtable__scroller');
    expect(css).toMatch(/\.otis-mdtable__scroller\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toContain('.otis-mdtable__nowrap');
    expect(css).toContain('.otis-mdtable--breakout');
  });

  it('renders reply tables through the production transcript shell', async () => {
    const view = await mount(
      <Transcript
        messages={[message({ id: 'm1', content_text: 'Two options:\n\n| Option | Price |\n|---|---|\n| A | 100 |\n| B | 200 |\n\nPick one.' })]}
        members={{}}
        currentUserId="usr_1"
        steps={[]}
        onInspectAction={vi.fn()}
      />,
    );
    expect(view.host.querySelector('.otis-mdtable table')).toBeTruthy();
    expect(view.host.querySelectorAll('.otis-mdtable table')).toHaveLength(1);
    // Prose accompanies the table instead of being swallowed by it.
    expect(view.host.textContent).toContain('Pick one.');
    expect(view.host.textContent).toContain('Two options:');
    await view.unmount();
  });

  it('correctly classifies short dates, statuses, numbers, and currencies for nowrap', () => {
    // Dates & times
    expect(isShortNoWrapText('2026-10-09')).toBe(true);
    expect(isShortNoWrapText('10/09/2026')).toBe(true);
    expect(isShortNoWrapText('Oct 9, 2026')).toBe(true);
    expect(isShortNoWrapText('yesterday')).toBe(true);
    expect(isShortNoWrapText('3 days ago')).toBe(true);
    expect(isShortNoWrapText('10:30 AM')).toBe(true);

    // Statuses & short states
    expect(isShortNoWrapText('Won')).toBe(true);
    expect(isShortNoWrapText('In progress')).toBe(true);
    expect(isShortNoWrapText('Pending approval')).toBe(true);
    expect(isShortNoWrapText('Overdue')).toBe(true);
    expect(isShortNoWrapText('Warm')).toBe(true);
    expect(isShortNoWrapText('Needs reply')).toBe(true);
    expect(isShortNoWrapText('Yes')).toBe(true);
    expect(isShortNoWrapText('No')).toBe(true);

    // Numbers & currencies & phones
    expect(isShortNoWrapText('#1')).toBe(true);
    expect(isShortNoWrapText('42')).toBe(true);
    expect(isShortNoWrapText('100%')).toBe(true);
    expect(isShortNoWrapText('€500')).toBe(true);
    expect(isShortNoWrapText('$1,200')).toBe(true);
    expect(isShortNoWrapText('+40 721 000 000')).toBe(true);

    // Long freeform text should NOT be nowrap
    expect(
      isShortNoWrapText(
        'Pull everything on X — facts, contacts, work, quotes offered vs expected, notes, files.',
      ),
    ).toBe(false);
    expect(
      isShortNoWrapText(
        'Correct one logged note without touching the whole client file.',
      ),
    ).toBe(false);
  });

  it('applies otis-mdtable__nowrap to short status and date cells in the transcript', async () => {
    const tableMarkdown = `
| Client | Status | Due Date | Quote | Notes |
|---|---|---|---|---|
| Alpha | In progress | 2026-10-09 | €500 | Detailed consultation regarding custom carpentry specifications and timber selection |
`;
    const view = await mount(
      <Transcript
        messages={[message({ id: 'm1', content_text: tableMarkdown })]}
        members={{}}
        currentUserId="usr_1"
        steps={[]}
        onInspectAction={vi.fn()}
      />,
    );

    const cells = Array.from(view.host.querySelectorAll('.otis-mdtable td'));
    expect(cells).toHaveLength(5);

    // Short status, date, currency cells receive nowrap
    const [, statusCell, dateCell, quoteCell, notesCell] = cells;
    expect(statusCell?.classList.contains('otis-mdtable__nowrap')).toBe(true);
    expect(dateCell?.classList.contains('otis-mdtable__nowrap')).toBe(true);
    expect(quoteCell?.classList.contains('otis-mdtable__nowrap')).toBe(true);

    // Long freeform cell does NOT receive nowrap so it can wrap naturally
    expect(notesCell?.classList.contains('otis-mdtable__nowrap')).toBe(false);

    // Headers have otis-mdtable__th
    const headers = Array.from(view.host.querySelectorAll('.otis-mdtable th'));
    expect(headers).toHaveLength(5);
    expect(headers.every((h) => h.classList.contains('otis-mdtable__th'))).toBe(true);

    await view.unmount();
  });
});
