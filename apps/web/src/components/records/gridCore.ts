import type { RecordColumn, RecordEdit, RecordRef } from './types.js';

/**
 * Glide-free grid coordination logic (R16 Slice D). The canvas grid and the
 * screen share these pure helpers without pulling the Glide bundle into the
 * main chunk: only the lazy grid component imports the grid package.
 */

export interface GridCellEdit {
  rowId: string;
  columnId: string;
  text: string;
}

export function canUseCanvasGrid(): boolean {
  try {
    if (typeof document === 'undefined') return false;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    return context !== null;
  } catch {
    return false;
  }
}

/** Columns whose values need the typed row form; grid edits would corrupt them. */
export function needsRowForm(column: Pick<RecordColumn, 'id' | 'type'>): boolean {
  if (column.type === 'calculation') return true;
  if (column.type === 'currency') return true;
  if (column.id === 'value' || column.id === 'quote') return true;
  if (column.id === 'due') return true;
  if (column.id === 'next_action' || column.id === 'kind' || column.id === 'entity') return true;
  return false;
}

export interface PastePlan {
  ops: RecordEdit[];
  reviewRows: Array<{ rowId: string; values: string[] }>;
  skippedStructured: number;
}

/**
 * Pure paste planner: maps a pasted rectangle onto stable row/column ids.
 * Cells beyond the last visible column are retained for review, never
 * clipped; structured cells stay out with a count; rows beyond the loaded
 * page become draft creates sharing one temp id per line. Base
 * preconditions ride along so pasted edits still conflict honestly.
 */
export function planPaste(
  visibleColumns: Array<Pick<RecordColumn, 'id' | 'type'>>,
  existingRowIds: string[],
  startRowIndex: number,
  startColumnId: string,
  values: string[][],
  scope: {
    makeRowId: () => string;
    listKind: RecordRef['kind'];
    listId: string;
    refOf: (rowId: string, isNew: boolean) => RecordRef;
    baseOf: (rowId: string, columnId: string) => string | undefined;
  },
): PastePlan {
  const startColIndex = visibleColumns.findIndex((c) => c.id === startColumnId);
  const ops: RecordEdit[] = [];
  const reviewRows: Array<{ rowId: string; values: string[] }> = [];
  let skippedStructured = 0;
  if (startColIndex < 0) return { ops, reviewRows, skippedStructured };
  values.forEach((line, rowOffset) => {
    // A fully blank line pastes nothing: no junk draft rows, no counts.
    if (line.every((text) => text.trim() === '')) return;
    const rowIndex = startRowIndex + rowOffset;
    const existingId = rowIndex < existingRowIds.length ? existingRowIds[rowIndex] : undefined;
    const isNewRow = existingId === undefined;
    const rowId = existingId ?? scope.makeRowId();
    const overflow: string[] = [];
    const lineCells: Array<{ columnId: string; text: string }> = [];
    line.forEach((text, colOffset) => {
      const targetCol = visibleColumns[startColIndex + colOffset];
      if (!targetCol) {
        overflow.push(text);
        return;
      }
      if (needsRowForm(targetCol)) {
        skippedStructured += 1;
        return;
      }
      lineCells.push({ columnId: targetCol.id, text });
    });
    if (isNewRow && (lineCells.length > 0 || overflow.some((text) => text.trim() !== ''))) {
      const nameCell = lineCells.find((c) => c.columnId === 'name' || c.columnId === 'title');
      ops.push({
        op: 'row.create',
        op_id: `op_row_${rowId}`,
        row_ref: { kind: scope.listKind, id: rowId },
        list_id: scope.listId,
        initial_values: nameCell && nameCell.text.trim() ? { [nameCell.columnId]: nameCell.text } : {},
      });
    }
    const createdHere = ops.some((op) => op.op === 'row.create' && op.row_ref.id === rowId);
    if (!isNewRow || createdHere) {
      for (const cell of lineCells) {
        ops.push({
          op: 'cell.set',
          op_id: `op_cell_${rowId}_${cell.columnId}`,
          row_ref: scope.refOf(rowId, isNewRow),
          column_id: cell.columnId,
          value: cell.text,
          base_token: isNewRow ? undefined : scope.baseOf(rowId, cell.columnId),
        });
      }
      if (overflow.some((text) => text.trim() !== '')) {
        reviewRows.push({ rowId, values: overflow });
      }
    }
  });
  return { ops, reviewRows, skippedStructured };
}
