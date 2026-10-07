/** @vitest-environment happy-dom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MarkdownTable, tableToTsv } from '../src/components/MarkdownTable.js';
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
});
