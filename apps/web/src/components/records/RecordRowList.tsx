import type { RecordColumn, RecordRow, DirtyCellState } from './types.js';
import { StatusPill } from '../StatusPill.js';
import { Button } from '../ui/button.js';
import { ChevronDownIcon, PlusIcon, AlertCircleIcon } from '../icons.js';

export interface RecordRowListProps {
  columns: RecordColumn[];
  rows: RecordRow[];
  dirtyCells: Record<string, DirtyCellState>;
  onSelectRow: (rowId: string) => void;
  onAddRow: () => void;
}

export function RecordRowList({
  columns,
  rows,
  dirtyCells,
  onSelectRow,
  onAddRow,
}: RecordRowListProps) {
  const primaryCol = columns[0] ?? { id: 'name', name: 'Name' };
  const statusCol = columns.find(c => c.type === 'status');
  const secondaryCols = columns.filter(c => c.id !== primaryCol.id && c.id !== statusCol?.id).slice(0, 3);

  const getEffectiveValue = (row: RecordRow, columnId: string): string => {
    const dirtyKey = `${row.id}:${columnId}`;
    if (dirtyCells[dirtyKey]) {
      return dirtyCells[dirtyKey].currentValue;
    }
    return row.cells[columnId] ?? '';
  };

  const isRowDirty = (rowId: string): boolean => {
    return Object.keys(dirtyCells).some(key => key.startsWith(`${rowId}:`));
  };

  if (rows.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
        <p className="text-sm font-medium text-foreground">No records found</p>
        <p className="mt-1 text-xs text-muted-foreground">No records in this collection. Click below or ask Otis in the sidebar.</p>
        <Button variant="outline" size="sm" onClick={onAddRow} className="mt-4 gap-1 text-xs">
          <PlusIcon />
          <span>Add first row</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-4 gap-3">
      {rows.map(row => {
        const title = getEffectiveValue(row, primaryCol.id) || 'Untitled';
        const statusVal = statusCol ? getEffectiveValue(row, statusCol.id) : null;
        const dirty = isRowDirty(row.id);

        return (
          <div
            key={row.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelectRow(row.id)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelectRow(row.id);
              }
            }}
            className={`otis-records__card ${dirty ? 'otis-records__card--dirty' : ''}`}
            aria-label={`Open details for ${title}`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 truncate">
                <span className="truncate text-base font-medium text-foreground">{title}</span>
                {dirty && (
                  <span className="flex items-center gap-1 rounded bg-accent px-2 py-1 text-xs text-warning">
                    <AlertCircleIcon />
                    <span>Edited</span>
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {statusVal && <StatusPill status={statusVal} />}
                <span className="rotate-270 text-subtle">
                  <ChevronDownIcon />
                </span>
              </div>
            </div>

            {/* Secondary fields snippet */}
            {secondaryCols.length > 0 && (
              <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground pt-1 border-t border-border">
                {secondaryCols.map(col => {
                  const val = getEffectiveValue(row, col.id);
                  if (!val) return null;
                  return (
                    <div key={col.id} className="truncate">
                      <span className="text-subtle mr-1">{col.name}:</span>
                      <span className="text-foreground font-medium">{val}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <div className="pt-2">
        <Button variant="outline" size="sm" onClick={onAddRow} className="w-full gap-1 text-xs">
          <PlusIcon />
          <span>Add row</span>
        </Button>
      </div>
    </div>
  );
}
