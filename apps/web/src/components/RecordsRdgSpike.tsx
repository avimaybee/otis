import { useMemo, useState } from 'react';
import { DataGrid, renderTextEditor, type Column, type RowsChangeData } from 'react-data-grid';
import 'react-data-grid/lib/styles.css';
import { SpikeDomTable, type SpikeRow } from './RecordsGridSpike.js';

/**
 * R16 slice-A fallback spike (NOT adopted UI): React Data Grid 7 beta under
 * the app's React 19 setup, same 20x10 shape as the Glide spike. RDG is DOM
 * virtualization (no canvas): cells are natively focusable, editing goes
 * through per-column editors applied in one `onRowsChange`, fill via
 * `onFill`, single-cell copy/paste callbacks. Rectangular multi-cell paste
 * needs custom container work — recorded as adoption cost, not proven here.
 */

interface RdgRow {
  id: string;
  [key: string]: string;
}

export function RecordsRdgSpike({
  initialRows,
  columns,
  onSelection,
}: {
  initialRows: SpikeRow[];
  columns: string[];
  onSelection?: (info: string) => void;
}) {
  const [rows, setRows] = useState<RdgRow[]>(() =>
    initialRows.map((entry) => ({
      id: entry.id,
      ...Object.fromEntries(entry.cells.map((cell, index) => [`c${index}`, cell ?? ''])),
    })),
  );

  const gridColumns = useMemo<Column<RdgRow>[]>(
    () =>
      columns.map((name, index) => ({
        key: `c${index}`,
        name,
        editable: true,
        renderEditCell: renderTextEditor,
        width: 140,
      })),
    [columns],
  );

  const applyRows = (next: RdgRow[]) => setRows(next);

  const handleRowsChange = (next: RdgRow[], data: RowsChangeData<RdgRow, unknown>) => {
    // One grouped application per change set (indexes + column provided).
    applyRows(next);
    void data;
  };

  const toSpikeRows = (current: RdgRow[]): SpikeRow[] =>
    current.map((entry) => ({
      id: entry.id,
      cells: columns.map((_, index) => entry[`c${index}`] ?? ''),
    }));

  return (
    <div className="flex flex-col gap-4">
      <div data-testid="spike-rdg-grid" style={{ maxWidth: '100%', overflowX: 'auto' }}>
        <DataGrid
          columns={gridColumns}
          rows={rows}
          onRowsChange={handleRowsChange}
          onCellClick={(args) => {
            onSelection?.(`cell(${args.column.idx},${args.rowIdx})`);
          }}
          onFill={({ columnKey, sourceRow, targetRow }: { columnKey: string; sourceRow: RdgRow; targetRow: RdgRow }) => {
            return { ...targetRow, [columnKey]: sourceRow[columnKey] ?? '' };
          }}
          rowKeyGetter={(row) => row.id}
          style={{ blockSize: 400, inlineSize: 720 }}
        />
      </div>
      <SpikeDomTable
        rows={toSpikeRows(rows)}
        columns={columns}
        onEdit={(updates) => {
          setRows((previous) => {
            const next = previous.map((entry) => ({ ...entry }));
            for (const update of updates) {
              const target = next[update.row];
              if (!target) continue;
              update.values.forEach((value, offset) => {
                target[`c${update.col + offset}`] = value;
              });
            }
            return next;
          });
        }}
      />
    </div>
  );
}
