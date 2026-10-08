import { Component, useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  DataEditor,
  GridCellKind,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';

/**
 * R16 slice-A compatibility spike (NOT adopted UI): proves the React-19
 * candidate renders real records, applies grouped edits through the single
 * `onCellsEdited` hook, clamps paste overflow, and reports rectangular
 * selection — with a DOM table over the same state as the accessible row
 * mode. Adoption waits on the spike gate (compat, keyboard, a11y, bundle,
 * five-width native proof).
 */

export interface SpikeRow {
  id: string;
  cells: string[];
}

/** Spike-only diagnostic: surfaces a grid render/commit crash as text. */
class SpikeErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  componentDidCatch() {
    /* Diagnostic only; the DOM row mode below keeps the spike usable. */
  }
  render() {
    if (this.state.error) return <p data-testid="spike-grid-error">{this.state.error}</p>;
    return this.props.children;
  }
}

export function clampPaste(
  target: readonly [number, number],
  values: readonly (readonly string[])[],
  columnCount: number,
  rowCount: number,
): { row: number; col: number; values: string[] }[] {
  const [startCol, startRow] = target;
  const applied: { row: number; col: number; values: string[] }[] = [];
  for (let r = 0; r < values.length; r++) {
    const row = startRow + r;
    if (row >= rowCount) break;
    const line = values[r] ?? [];
    const clipped = line.slice(0, Math.max(0, columnCount - startCol));
    if (clipped.length === 0) continue;
    applied.push({ row, col: startCol, values: [...clipped] });
  }
  return applied;
}

export function RecordsGridSpike({
  initialRows,
  columns,
  gridWidth = 720,
  onSelection,
}: {
  initialRows: SpikeRow[];
  columns: string[];
  gridWidth?: number;
  onSelection?: (selection: GridSelection) => void;
}) {
  const [rows, setRows] = useState<SpikeRow[]>(initialRows);
  const [selection, setSelection] = useState<GridSelection | undefined>(undefined);

  const gridColumns = useMemo<GridColumn[]>(
    () => columns.map((title) => ({ title, width: 140 })),
    [columns],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const value = rows[row]?.cells[col] ?? '';
      return { kind: GridCellKind.Text, data: value, displayData: value, allowOverlay: true, readonly: false };
    },
    [rows],
  );

  const applyGroup = useCallback((updates: { row: number; col: number; values: string[] }[]) => {
    setRows((previous) =>
      previous.map((entry, rowIndex) => {
        const forRow = updates.filter((u) => u.row === rowIndex);
        if (forRow.length === 0) return entry;
        const cells = [...entry.cells];
        for (const update of forRow) {
          update.values.forEach((value, offset) => {
            cells[update.col + offset] = value;
          });
        }
        return { ...entry, cells };
      }),
    );
  }, []);

  const handleCellsEdited = useCallback(
    (edits: readonly { location: Item; value: EditableGridCell }[]) => {
      // Single grouped hook: one pass over the group, never per-cell state writes.
      const grouped = new Map<number, { row: number; col: number; values: string[] }>();
      for (const edit of edits) {
        const [col, row] = edit.location;
        const text = edit.value.kind === GridCellKind.Text ? String(edit.value.data ?? '') : '';
        const existing = grouped.get(row);
        if (existing && col >= existing.col) {
          while (existing.values.length < col - existing.col) existing.values.push('');
          existing.values[col - existing.col] = text;
        } else {
          grouped.set(row, { row, col, values: [text] });
        }
      }
      applyGroup([...grouped.values()]);
    },
    [applyGroup],
  );

  return (
    <div className="flex flex-col gap-4">
      <div data-testid="spike-grid">
        <SpikeErrorBoundary>
        <DataEditor
          width={gridWidth}
          height={400}
          columns={gridColumns}
          rows={rows.length}
          getCellContent={getCellContent}
          onCellsEdited={handleCellsEdited}
          gridSelection={selection}
          onGridSelectionChange={(next) => {
            setSelection(next);
            onSelection?.(next);
          }}
          onPaste={(target, values) => {
            applyGroup(clampPaste([target[0], target[1]], values, columns.length, rows.length));
            return true;
          }}
          rowMarkers="both"
        />
        </SpikeErrorBoundary>
      </div>
      {/* Accessible DOM row mode over the same state: its own scroll
          region so narrow widths never clip trailing columns (the grid page
          will own the same confinement). */}
      <SpikeDomTable rows={rows} columns={columns} onEdit={applyGroup} />
    </div>
  );
}

export function SpikeDomTable({
  rows,
  columns,
  onEdit,
}: {
  rows: SpikeRow[];
  columns: string[];
  onEdit: (updates: { row: number; col: number; values: string[] }[]) => void;
}) {
  return (
    <div className="w-full max-w-full overflow-x-auto">
      <table data-testid="spike-dom-table" aria-label="Records, accessible row mode" className="w-fit border-collapse text-sm">
        <thead>
          <tr>
            <th scope="col" className="border px-2 py-1 text-left">Row</th>
            {columns.map((name) => (
              <th key={name} scope="col" className="border px-2 py-1 text-left">{name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((entry, rowIndex) => (
            <tr key={entry.id}>
              <th scope="row" className="border px-2 py-1 text-left">{rowIndex + 1}</th>
              {columns.map((_, colIndex) => (
                <td key={colIndex} className="border px-1 py-1">
                  <input
                    aria-label={`Row ${rowIndex + 1}, ${columns[colIndex]}`}
                    className="w-full bg-transparent focus-visible:ring-1 focus-visible:ring-ring"
                    value={entry.cells[colIndex] ?? ''}
                    onChange={(event) => {
                      onEdit([{ row: rowIndex, col: colIndex, values: [event.target.value] }]);
                    }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
