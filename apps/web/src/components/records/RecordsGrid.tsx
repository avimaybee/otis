import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DataEditor,
  GridCellKind,
  emptyGridSelection,
  type EditableGridCell,
  type EditListItem,
  type FillPatternEventArgs,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Theme,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import type { RecordColumn } from './types.js';
import type { OverlayRow } from './useRecordsDraft.js';
import type { GridCellEdit } from './gridCore.js';
import { needsRowForm } from './gridCore.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog.js';

export interface RecordsGridProps {
  columns: RecordColumn[];
  rows: OverlayRow[];
  onCellsEdited: (edits: GridCellEdit[]) => void;
  onCellsCleared: (cells: GridCellEdit[]) => void;
  onSkippedReadonly: (count: number) => void;
  onPasteAt: (startRowIndex: number, startColumnId: string, values: string[][]) => void;
  onFillRange: (edits: GridCellEdit[]) => void;
  onAppendRow: () => void;
  onOpenRow: (rowId: string) => void;
  onSortColumn: (columnId: string, direction: 'asc' | 'desc') => void;
  onHideColumn: (columnId: string) => void;
  onRenameColumn: (columnId: string, label: string) => void;
  onRemoveColumn: (columnId: string) => void;
  onSelectionChange: (rowIds: string[]) => void;
  onColumnWidth: (columnId: string, width: number) => void;
  onColumnOrder: (columnIds: string[]) => void;
  columnWidths: Record<string, number>;
}

function gridTheme(): Partial<Theme> {
  const fallback: Partial<Theme> = {
    fontFamily: 'inherit',
  };
  try {
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string): string | null => {
      const value = styles.getPropertyValue(name).trim();
      return value || null;
    };
    const bg = read('--background');
    const fg = read('--foreground');
    const border = read('--border');
    const accent = read('--accent');
    const muted = read('--muted-foreground');
    return {
      ...fallback,
      ...(bg ? { bgCell: bg } : {}),
      ...(fg ? { textDark: fg, textMedium: fg, textLight: muted ?? fg } : {}),
      ...(border ? { borderColor: border, horizontalBorderColor: border } : {}),
      ...(accent ? { accentColor: accent, accentLight: accent } : {}),
      ...(muted ? { textBubble: muted } : {}),
    };
  } catch {
    return fallback;
  }
}

export function RecordsGrid(props: RecordsGridProps) {
  const { columns, rows } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 480 });
  const [selection, setSelection] = useState<GridSelection>(emptyGridSelection);
  const [menuColumnIndex, setMenuColumnIndex] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState('');
  const theme = useMemo(() => gridTheme(), []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: Math.max(320, rect.width), height: Math.max(240, rect.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const gridColumns = useMemo<GridColumn[]>(() => columns.map((col) => ({
    title: col.name,
    id: col.id,
    width: props.columnWidths[col.id] ?? col.width ?? 160,
    hasMenu: true,
  })), [columns, props.columnWidths]);

  const cellKindOf = useCallback((column: RecordColumn, display: string): GridCell => {
    if (column.type === 'number' && display.trim() !== '' && Number.isFinite(Number(display))) {
      return {
        kind: GridCellKind.Number, data: Number(display), displayData: display,
        allowOverlay: true, readonly: false,
      };
    }
    if (column.type === 'boolean') {
      const lowered = display.trim().toLowerCase();
      if (lowered === 'true' || lowered === 'false') {
        return {
          kind: GridCellKind.Boolean, data: lowered === 'true', readonly: false, allowOverlay: false,
        };
      }
    }
    const structured = needsRowForm(column);
    return {
      kind: GridCellKind.Text, data: display, displayData: display,
      allowOverlay: !structured, readonly: structured,
    };
  }, []);

  const getCellContent = useCallback(([col, row]: Item): GridCell => {
    const column = columns[col];
    const entry = rows[row];
    if (!column || !entry) {
      return { kind: GridCellKind.Loading, allowOverlay: false };
    }
    const display = entry.cells[column.id] ?? '';
    return cellKindOf(column, display);
  }, [columns, rows, cellKindOf]);

  const handleCellsEdited = useCallback((edits: readonly EditListItem[]) => {
    const applicable: GridCellEdit[] = [];
    let skipped = 0;
    for (const edit of edits) {
      const [col, row] = edit.location;
      const column = columns[col];
      const entry = rows[row];
      if (!column || !entry) continue;
      if (needsRowForm(column)) {
        skipped += 1;
        continue;
      }
      const value = edit.value as EditableGridCell;
      let text = '';
      if (value.kind === GridCellKind.Text) text = String(value.data ?? '');
      else if (value.kind === GridCellKind.Number) text = String(value.data ?? '');
      else if (value.kind === GridCellKind.Boolean) text = value.data ? 'true' : 'false';
      else continue;
      applicable.push({ rowId: entry.id, columnId: column.id, text });
    }
    if (applicable.length > 0) props.onCellsEdited(applicable);
    if (skipped > 0) props.onSkippedReadonly(skipped);
  }, [columns, rows, props]);

  const handlePaste = useCallback((target: Item, values: readonly (readonly string[])[]) => {
    const [startCol, startRow] = target;
    const startColumn = columns[startCol];
    if (!startColumn) return false;
    props.onPasteAt(startRow, startColumn.id, values.map((line) => [...line]));
    return true;
  }, [columns, props]);

  const handleFill = useCallback((event: FillPatternEventArgs) => {
    event.preventDefault();
    const { patternSource, fillDestination } = event;
    const sourceValues: string[][] = [];
    for (let r = patternSource.y; r < patternSource.y + patternSource.height; r++) {
      const line: string[] = [];
      for (let c = patternSource.x; c < patternSource.x + patternSource.width; c++) {
        const column = columns[c];
        const entry = rows[r];
        line.push(column && entry ? (entry.cells[column.id] ?? '') : '');
      }
      sourceValues.push(line);
    }
    if (sourceValues.length === 0 || sourceValues[0]!.length === 0) return;
    const edits: GridCellEdit[] = [];
    for (let r = fillDestination.y; r < fillDestination.y + fillDestination.height; r++) {
      for (let c = fillDestination.x; c < fillDestination.x + fillDestination.width; c++) {
        const column = columns[c];
        const entry = rows[r];
        if (!column || !entry || needsRowForm(column)) continue;
        const text = sourceValues[(r - fillDestination.y) % sourceValues.length]![(c - fillDestination.x) % sourceValues[0]!.length]!;
        edits.push({ rowId: entry.id, columnId: column.id, text });
      }
    }
    if (edits.length > 0) props.onFillRange(edits);
  }, [columns, rows, props]);

  const handleDelete = useCallback((sel: GridSelection) => {
    const edits: GridCellEdit[] = [];
    const seen = new Set<string>();
    if (sel.current) {
      const ranges = sel.current.rangeStack ?? [sel.current.range];
      for (const range of ranges) {
        for (let c = range.x; c < range.x + range.width; c++) {
          for (let r = range.y; r < range.y + range.height; r++) {
            const column = columns[c];
            const entry = rows[r];
            if (!column || !entry || needsRowForm(column)) continue;
            const key = `${entry.id}:${column.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edits.push({ rowId: entry.id, columnId: column.id, text: '' });
          }
        }
      }
    }
    if (edits.length > 0) props.onCellsCleared(edits);
    return true;
  }, [columns, rows, props]);

  const handleSelectionChange = useCallback((next: GridSelection) => {
    setSelection(next);
    const rowIndexes = next.rows.toArray();
    props.onSelectionChange(rowIndexes.map((index) => rows[index]?.id).filter((id): id is string => !!id));
  }, [rows, props]);

  const handleCellClicked = useCallback((cell: Item) => {
    const [col, row] = cell;
    const column = columns[col];
    const entry = rows[row];
    if (!column || !entry) return;
    if (needsRowForm(column)) {
      props.onOpenRow(entry.id);
    }
  }, [columns, rows, props]);

  const handleHeaderMenu = useCallback((col: number) => {
    setMenuColumnIndex(col);
    setRenaming(false);
    setRenameText(columns[col]?.name ?? '');
  }, [columns]);

  const menuColumn = menuColumnIndex !== null ? columns[menuColumnIndex] : undefined;

  return (
    <div ref={wrapRef} className="flex flex-1 min-h-0 flex-col relative" data-testid="records-grid">
      <DataEditor
        width={size.width}
        height={size.height}
        columns={gridColumns}
        rows={rows.length}
        getCellContent={getCellContent}
        getCellsForSelection
        onCellsEdited={handleCellsEdited}
        onPaste={handlePaste}
        onDelete={handleDelete}
        onFillPattern={handleFill}
        onRowAppended={() => props.onAppendRow()}
        onCellClicked={(cell) => handleCellClicked(cell)}
        onHeaderMenuClick={handleHeaderMenu}
        onColumnResize={(_, width, colIndex) => {
          const column = columns[colIndex];
          if (column) props.onColumnWidth(column.id, width);
        }}
        onColumnMoved={(from, to) => {
          const order = columns.map((c) => c.id);
          const [moved] = order.splice(from, 1);
          if (moved !== undefined) {
            order.splice(to, 0, moved);
            props.onColumnOrder(order);
          }
        }}
        gridSelection={selection}
        onGridSelectionChange={handleSelectionChange}
        freezeColumns={1}
        rowMarkers="both"
        fillHandle
        theme={theme}
        trailingRowOptions={{
          hint: 'New',
          sticky: true,
          targetColumn: 0,
        }}
      />
      {menuColumn && menuColumnIndex !== null && (
        <Dialog
          open
          onOpenChange={(isOpen) => { if (!isOpen) { setMenuColumnIndex(null); setRenaming(false); } }}
        >
          <DialogContent className="sm:max-w-xs bg-popover border-border">
            <DialogHeader>
              <DialogTitle className="text-sm font-medium">{menuColumn.name}</DialogTitle>
            </DialogHeader>
            {renaming ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const label = renameText.trim();
                  if (label) props.onRenameColumn(menuColumn.id, label);
                  setMenuColumnIndex(null);
                  setRenaming(false);
                }}
              >
                <Input
                  value={renameText}
                  onChange={(e) => setRenameText(e.target.value)}
                  aria-label={`Rename ${menuColumn.name}`}
                  className="h-8 text-xs"
                />
                <Button type="submit" size="sm" className="h-8 text-xs">Save</Button>
              </form>
            ) : (
              <div className="flex flex-col gap-1">
                <Button variant="ghost" size="sm" className="justify-start text-xs" onClick={() => { props.onSortColumn(menuColumn.id, 'asc'); setMenuColumnIndex(null); }}>
                  Sort ascending
                </Button>
                <Button variant="ghost" size="sm" className="justify-start text-xs" onClick={() => { props.onSortColumn(menuColumn.id, 'desc'); setMenuColumnIndex(null); }}>
                  Sort descending
                </Button>
                <Button variant="ghost" size="sm" className="justify-start text-xs" onClick={() => { props.onHideColumn(menuColumn.id); setMenuColumnIndex(null); }}>
                  Hide column
                </Button>
                <Button variant="ghost" size="sm" className="justify-start text-xs" onClick={() => setRenaming(true)}>
                  Rename column
                </Button>
                <Button variant="ghost" size="sm" className="justify-start text-xs text-destructive hover:text-destructive" onClick={() => { props.onRemoveColumn(menuColumn.id); setMenuColumnIndex(null); }}>
                  Remove column
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
