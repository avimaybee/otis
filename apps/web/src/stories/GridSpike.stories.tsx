import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { GridSelection } from '@glideapps/glide-data-grid';
import { RecordsGridSpike, type SpikeRow } from '../components/RecordsGridSpike.js';
import { RecordsRdgSpike } from '../components/RecordsRdgSpike.js';

/**
 * R16 slice-A SPIKE (not adopted UI, not a design.md fixture): React-19
 * compatibility vehicle for the Glide Data Grid candidate
 * (@glideapps/glide-data-grid@6.0.4-alpha24). Proves render, rectangular
 * selection, grouped editing, paste overflow and the DOM row mode in a real
 * browser before any adoption decision.
 */

const COLUMNS = ['Name', 'Status', 'Phone', 'Language', 'Quote', 'Assignee', 'Updated', 'Source', 'Note', 'Flags'];

function seedRows(): SpikeRow[] {
  return Array.from({ length: 20 }, (_, row) => ({
    id: `spike-row-${row}`,
    cells: COLUMNS.map((_, col) => (col === 0 ? `Spike Lead ${row + 1}` : col === 1 ? 'new' : '')),
  }));
}

function SpikeHarness() {
  const [selectionJson, setSelectionJson] = useState('none');
  // ?spikewidth=NNN constrains the harness for narrow-width proof (the
  // desktop viewport itself is not resizable from automation).
  const harnessWidth = (() => {
    try {
      const raw = new URLSearchParams(window.location.search).get('spikewidth');
      const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
      return Number.isFinite(parsed) && parsed >= 280 && parsed <= 1600 ? parsed : 720;
    } catch {
      return 720;
    }
  })();
  return (
    <div className="flex flex-col gap-2 p-4" style={{ maxWidth: harnessWidth }}>
      <p className="text-sm text-muted-foreground">
        Spike only: select a rectangle, type to edit, paste TSV. Selection JSON reports below.
      </p>
      <div style={{ width: harnessWidth, maxWidth: '100%', overflowX: 'auto' }}>
      <RecordsGridSpike
        initialRows={seedRows()}
        columns={COLUMNS}
        gridWidth={Math.min(harnessWidth, 720)}
        onSelection={(selection: GridSelection) => {
          const current = selection.current;
          setSelectionJson(
            current ? `cell(${current.cell[0]},${current.cell[1]}) range(${current.range.x},${current.range.y},${current.range.width},${current.range.height})` : 'none',
          );
        }}
      />
      </div>
      <p data-testid="spike-selection" className="text-xs text-muted-foreground">selection: {selectionJson}</p>
    </div>
  );
}

const meta: Meta = {
  title: 'Spike/Grid',
  parameters: {
    docs: {
      description: {
        component: 'Compatibility spike only. Not production UI and not a design.md fixture.',
      },
    },
  },
};

export default meta;

export const GridSpike: StoryObj = {
  name: 'spike/grid-compat',
  render: () => <SpikeHarness />,
};

function RdgHarness() {
  const [selectionJson, setSelectionJson] = useState('none');
  const harnessWidth = (() => {
    try {
      const raw = new URLSearchParams(window.location.search).get('spikewidth');
      const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
      return Number.isFinite(parsed) && parsed >= 280 && parsed <= 1600 ? parsed : 720;
    } catch {
      return 720;
    }
  })();
  return (
    <div className="flex flex-col gap-2 p-4" style={{ maxWidth: harnessWidth }}>
      <p className="text-sm text-muted-foreground">
        Fallback spike only: click a cell, double-click/Enter to edit, drag the fill handle. Selection reports below.
      </p>
      <div style={{ width: harnessWidth, maxWidth: '100%', overflowX: 'auto' }}>
        <RecordsRdgSpike initialRows={seedRows()} columns={COLUMNS} onSelection={setSelectionJson} />
      </div>
      <p data-testid="spike-rdg-selection" className="text-xs text-muted-foreground">selection: {selectionJson}</p>
    </div>
  );
}

export const RdgSpike: StoryObj = {
  name: 'spike/rdg-compat',
  render: () => <RdgHarness />,
};
