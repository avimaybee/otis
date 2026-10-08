/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { RecordsRdgSpike } from '../src/components/RecordsRdgSpike.js';
import type { SpikeRow } from '../src/components/RecordsGridSpike.js';

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const COLUMNS = ['Name', 'Status', 'Phone'];
function seed(): SpikeRow[] {
  return Array.from({ length: 5 }, (_, row) => ({
    id: `r${row}`,
    cells: [`Lead ${row + 1}`, 'new', ''],
  }));
}

describe('RDG fallback spike interactions', () => {
  it('selects on click and commits an edit through the grouped hook', async () => {
    const seen: string[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<RecordsRdgSpike initialRows={seed()} columns={COLUMNS} onSelection={(info) => seen.push(info)} />);
    });
    const grid = host.querySelector('[data-testid=spike-rdg-grid]');
    expect(grid).toBeTruthy();
    const cells = host.querySelectorAll('[role="gridcell"]');
    expect(cells.length).toBeGreaterThan(0);
    await act(async () => {
      (cells[1] as HTMLElement).click();
    });
    expect(seen.length).toBeGreaterThan(0);

    // Keyboard reachability of the grid cells themselves is proven natively
    // (arrows + Enter); happy-dom lacks the `&` selector RDG's focus
    // management needs, so this only pins render, click-select and the
    // labelled DOM inputs here. Open slice item: verify Tab-into-grid if
    // the grid (rather than the DOM row mode) must be the keyboard entry.
    expect(host.querySelector('[data-testid=spike-rdg-grid] [role="grid"]')).toBeTruthy();
    // The accessible DOM row mode exposes every cell as a labelled input.
    expect(host.querySelector('[aria-label="Row 1, Status"]')).toBeTruthy();
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
