import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react';
import type { RecordColumn, RecordRow, DirtyCellState } from './types.js';
import { StatusPill } from '../StatusPill.js';
import { Button } from '../ui/button.js';
import {
  TypeIcon, PhoneIcon, DollarIcon, HashIcon,
  CalendarIcon, CalculatorIcon,
  MoreVerticalIcon, PlusIcon
} from '../icons.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator
} from '../ui/dropdown-menu.js';

export interface RecordsTableProps {
  columns: RecordColumn[];
  rows: RecordRow[];
  dirtyCells: Record<string, DirtyCellState>;
  onCellChange: (rowId: string, columnId: string, nextValue: string) => void;
  onAddRow: () => void;
  onDeleteRow?: (rowId: string) => void;
  onSortColumn?: (columnId: string, direction: 'asc' | 'desc') => void;
  onHideColumn?: (columnId: string) => void;
  onSelectRow?: (rowId: string) => void;
}

export function RecordsTable({
  columns,
  rows,
  dirtyCells,
  onCellChange,
  onAddRow,
  onDeleteRow,
  onSortColumn,
  onHideColumn,
  onSelectRow,
}: RecordsTableProps) {
  // Navigation & selection coordinates: [rowIndex, colIndex]
  const [selectedCell, setSelectedCell] = useState<[number, number] | null>([0, 0]);
  const [editingCell, setEditingCell] = useState<[number, number] | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());

  const inputRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  const columnIcon = (type: RecordColumn['type']) => {
    switch (type) {
      case 'phone': return <PhoneIcon />;
      case 'currency': return <DollarIcon />;
      case 'number': return <HashIcon />;
      case 'date': return <CalendarIcon />;
      case 'calculation': return <CalculatorIcon />;
      default: return <TypeIcon />;
    }
  };

  const getEffectiveValue = (row: RecordRow, columnId: string): string => {
    const dirtyKey = `${row.id}:${columnId}`;
    if (dirtyCells[dirtyKey]) {
      return dirtyCells[dirtyKey].currentValue;
    }
    return row.cells[columnId] ?? '';
  };

  const isCellDirty = (rowId: string, columnId: string): boolean => {
    return Boolean(dirtyCells[`${rowId}:${columnId}`]);
  };

  const startEditing = useCallback((rowIndex: number, colIndex: number) => {
    const row = rows[rowIndex];
    const col = columns[colIndex];
    if (!row || !col) return;
    if (col.type === 'calculation') return; // Calculations are read-only
    setEditingCell([rowIndex, colIndex]);
    setEditValue(getEffectiveValue(row, col.id));
  }, [rows, columns, dirtyCells]);

  const commitEditing = useCallback(() => {
    if (!editingCell) return;
    const [rowIndex, colIndex] = editingCell;
    const row = rows[rowIndex];
    const col = columns[colIndex];
    if (row && col) {
      onCellChange(row.id, col.id, editValue);
    }
    setEditingCell(null);
  }, [editingCell, editValue, rows, columns, onCellChange]);

  const cancelEditing = useCallback(() => {
    setEditingCell(null);
  }, []);

  // Focus input on edit mode
  useEffect(() => {
    if (editingCell) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingCell]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    if (editingCell) {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitEditing();
        // Move down on Enter
        if (selectedCell && selectedCell[0] < rows.length - 1) {
          setSelectedCell([selectedCell[0] + 1, selectedCell[1]]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEditing();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        commitEditing();
        if (selectedCell) {
          const nextCol = e.shiftKey ? Math.max(0, selectedCell[1] - 1) : Math.min(columns.length - 1, selectedCell[1] + 1);
          setSelectedCell([selectedCell[0], nextCol]);
        }
      }
      return;
    }

    if (!selectedCell) return;
    const [rowIdx, colIdx] = selectedCell;

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        setSelectedCell([Math.max(0, rowIdx - 1), colIdx]);
        break;
      case 'ArrowDown':
        e.preventDefault();
        setSelectedCell([Math.min(rows.length - 1, rowIdx + 1), colIdx]);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        setSelectedCell([rowIdx, Math.max(0, colIdx - 1)]);
        break;
      case 'ArrowRight':
        e.preventDefault();
        setSelectedCell([rowIdx, Math.min(columns.length - 1, colIdx + 1)]);
        break;
      case 'Enter':
        e.preventDefault();
        startEditing(rowIdx, colIdx);
        break;
      case 'Tab':
        e.preventDefault();
        if (e.shiftKey) {
          setSelectedCell([rowIdx, Math.max(0, colIdx - 1)]);
        } else {
          setSelectedCell([rowIdx, Math.min(columns.length - 1, colIdx + 1)]);
        }
        break;
      case 'Backspace':
      case 'Delete': {
        const row = rows[rowIdx];
        const col = columns[colIdx];
        if (row && col && col.type !== 'calculation') {
          e.preventDefault();
          onCellChange(row.id, col.id, '');
        }
        break;
      }
      default:
        // Any printable character starts editing
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const col = columns[colIdx];
          if (col && col.type !== 'calculation') {
            setEditingCell([rowIdx, colIdx]);
            setEditValue(e.key);
          }
        }
        break;
    }
  };

  const toggleSelectAll = () => {
    if (selectedRowIds.size === rows.length) {
      setSelectedRowIds(new Set());
    } else {
      setSelectedRowIds(new Set(rows.map(r => r.id)));
    }
  };

  const toggleSelectRow = (rowId: string) => {
    const next = new Set(selectedRowIds);
    if (next.has(rowId)) next.delete(rowId);
    else next.add(rowId);
    setSelectedRowIds(next);
  };

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="otis-records__table-wrap">
        <table
          ref={tableRef}
          role="grid"
          className="otis-records__table"
          aria-label="Records spreadsheet"
          tabIndex={0}
          onKeyDown={handleKeyDown}
        >
          <thead>
            <tr>
              {/* Row selection header */}
              <th scope="col" className="otis-records__th w-10 text-center">
                <input
                  type="checkbox"
                  aria-label="Select all rows"
                  checked={rows.length > 0 && selectedRowIds.size === rows.length}
                  onChange={toggleSelectAll}
                  className="rounded border-border"
                />
              </th>
              {/* Row number header */}
              <th scope="col" className="otis-records__th w-12 text-center text-xs text-subtle">
                #
              </th>
              {/* Column headers */}
              {columns.map(col => (
                <th
                  key={col.id}
                  scope="col"
                  className="otis-records__th group"
                  aria-label={col.name}
                >
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex items-center gap-1 truncate">
                      <span className="text-subtle">{columnIcon(col.type)}</span>
                      <span className="truncate text-xs font-medium text-foreground">{col.name}</span>
                    </div>
                    {/* Column options menu */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground"
                          aria-label={`Options for ${col.name}`}
                        >
                          <MoreVerticalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" side="bottom">
                        <DropdownMenuItem onSelect={() => onSortColumn?.(col.id, 'asc')}>
                          <span>Sort A to Z</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onSortColumn?.(col.id, 'desc')}>
                          <span>Sort Z to A</span>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => onHideColumn?.(col.id)}>
                          <span>Hide column</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 2} className="py-12 text-center text-xs text-muted-foreground">
                  <div className="flex flex-col items-center justify-center gap-1">
                    <span className="font-medium text-foreground">No records found</span>
                    <span className="text-subtle">No records in this collection. Click &quot;+ Add row&quot; or ask Otis in the sidebar.</span>
                  </div>
                </td>
              </tr>
            ) : (
              rows.map((row, rowIdx) => {
                const isRowSelected = selectedRowIds.has(row.id);
                return (
                  <tr
                    key={row.id}
                    className="otis-records__tr"
                    data-selected={isRowSelected}
                    onClick={() => onSelectRow?.(row.id)}
                  >
                  {/* Row checkbox */}
                  <td className="otis-records__td w-10 text-center" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select row ${rowIdx + 1}`}
                      checked={isRowSelected}
                      onChange={() => toggleSelectRow(row.id)}
                      className="rounded border-border"
                    />
                  </td>
                  {/* Row index */}
                  <td className="otis-records__td w-12 text-center text-xs text-subtle">
                    {onDeleteRow ? (
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="size-full text-xs text-subtle hover:text-foreground cursor-pointer"
                            title={`Row ${rowIdx + 1} options`}
                            onClick={e => e.stopPropagation()}
                          >
                            {rowIdx + 1}
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => onDeleteRow(row.id)}
                          >
                            Delete row
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      rowIdx + 1
                    )}
                  </td>
                  {/* Data cells */}
                  {columns.map((col, colIdx) => {
                    const isFocused = selectedCell?.[0] === rowIdx && selectedCell?.[1] === colIdx;
                    const isEditing = editingCell?.[0] === rowIdx && editingCell?.[1] === colIdx;
                    const val = getEffectiveValue(row, col.id);
                    const dirty = isCellDirty(row.id, col.id);
                    const isOverdue = Boolean(
                      (col.id === 'due_date' || col.type === 'date') &&
                      val &&
                      (() => {
                        const today = new Date().toISOString().slice(0, 10);
                        const rowStatus = String(row.cells['status'] || '').toLowerCase();
                        return val < today && rowStatus !== 'done' && rowStatus !== 'completed' && rowStatus !== 'won';
                      })()
                    );

                    return (
                      <td
                        key={col.id}
                        className={`otis-records__td ${col.type === 'currency' || col.type === 'number' ? 'otis-records__td--numeric' : ''} ${dirty ? 'otis-records__td--dirty' : ''}`}
                        data-focused={isFocused}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedCell([rowIdx, colIdx]);
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          startEditing(rowIdx, colIdx);
                        }}
                      >
                        {isEditing ? (
                          <input
                            ref={inputRef}
                            value={editValue}
                            onChange={e => setEditValue(e.target.value)}
                            onBlur={commitEditing}
                            className="otis-records__cell-input"
                            aria-label={`Edit ${col.name} for row ${rowIdx + 1}`}
                          />
                        ) : (
                          <div className="truncate text-xs">
                            {col.type === 'status' && val ? (
                              <StatusPill status={val} />
                            ) : isOverdue ? (
                              <span className="text-destructive font-medium inline-flex items-center gap-1">
                                <span>{val}</span>
                                <span className="text-xs bg-destructive/15 text-destructive px-1 rounded font-medium">Overdue</span>
                              </span>
                            ) : (
                              <span>{col.type === 'currency' && val && !isNaN(Number(val)) ? `€${Number(val).toLocaleString()}` : (val || <span className="text-subtle">—</span>)}</span>
                            )}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            }))}
          </tbody>
        </table>
      </div>

      {/* Table bottom controls: Add row + keyboard shortcut hint */}
      <div className="flex items-center justify-between border-t border-border bg-card px-4 py-2">
        <Button variant="ghost" size="sm" onClick={onAddRow} className="h-7 gap-1 text-xs">
          <PlusIcon />
          <span>Add row</span>
        </Button>
        <span className="text-xs text-subtle hidden md:inline">
          <kbd className="font-mono">Enter</kbd> edit · <kbd className="font-mono">Tab</kbd> navigate · <kbd className="font-mono">Ctrl+S</kbd> save · <kbd className="font-mono">Ctrl+Z</kbd> undo
        </span>
      </div>
    </div>
  );
}
