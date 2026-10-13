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
 * Split a Save manifest into bounded chunks while preserving operation
 * order. A row.create absorbs only the same-row cell edits that follow it
 * before any intervening definition operation, so a cell can never leap
 * over the field.create/list.create that types it (the backend executes in
 * order and would otherwise accept the value through the untyped fallback
 * first). The name/title cell of a new entity row always travels with its
 * creation, since creation rejects nameless rows and names need no
 * definition. Cells after a definition stay in place and reach the server
 * in later chunks, where earlier chunks' ID mappings resolve their rows.
 */
export const SAVE_CHUNK_OPS = 30;
export function buildSaveChunks(ops: RecordEdit[]): RecordEdit[][] {
  const isDefinition = (op: RecordEdit): boolean =>
    op.op === 'field.create' || op.op === 'field.update' || op.op === 'field.archive' ||
    op.op === 'list.create' || op.op === 'calculation.define';
  const isNameCell = (op: RecordEdit): boolean =>
    (op.op === 'cell.set' || op.op === 'cell.clear') &&
    (op.column_id === 'name' || op.column_id === 'title' || op.column_id === 'leads:name');
  type Unit = { ops: RecordEdit[] };
  const units: Unit[] = [];
  const openRowUnits = new Map<string, { unit: Unit; listId: string | null; blockedColumns: Set<string>; closed: boolean }>();
  for (const op of ops) {
    if (op.op === 'row.create') {
      const unit: Unit = { ops: [op] };
      units.push(unit);
      openRowUnits.set(`${op.row_ref.kind}:${op.row_ref.id}`, { unit, listId: op.list_id ?? null, blockedColumns: new Set<string>(), closed: false });
      continue;
    }
    if (op.op === 'cell.set' || op.op === 'cell.clear') {
      const key = `${op.row_ref.kind}:${op.row_ref.id}`;
      const open = openRowUnits.get(key);
      if (open && !open.closed && !open.blockedColumns.has(op.column_id)) {
        open.unit.ops.push(op);
        continue;
      }
    }
    if (isDefinition(op)) {
      // Later cells for open rows stay behind this definition, except the
      // creation-required name cell which depends on no definition. Move
      // already-grouped non-name cells for the blocked column back out; a
      // list creation closes its rows entirely.
      for (const open of openRowUnits.values()) {
        if (open.closed) continue;
        if (op.op === 'list.create') {
          if (op.list_id === open.listId) open.closed = true;
          continue;
        }
        const fieldId = (op as { field_id?: string }).field_id;
        if (typeof fieldId !== 'string') continue;
        const blocked: RecordEdit[] = [];
        const kept: RecordEdit[] = [];
        for (const grouped of open.unit.ops) {
          if (grouped.op !== 'row.create' && !isNameCell(grouped) &&
            (grouped.op === 'cell.set' || grouped.op === 'cell.clear') &&
            grouped.column_id === fieldId) {
            blocked.push(grouped);
          } else {
            kept.push(grouped);
          }
        }
        if (blocked.length > 0) {
          open.unit.ops = kept;
          open.blockedColumns.add(fieldId);
          for (const b of blocked) units.push({ ops: [b] });
        } else {
          // No grouped cell uses this field yet, but later ones must not
          // leap over its definition either.
          open.blockedColumns.add(fieldId);
        }
      }
    }
    units.push({ ops: [op] });
  }
  const chunks: RecordEdit[][] = [];
  let current: RecordEdit[] = [];
  const flush = () => {
    if (current.length > 0) {
      chunks.push(current);
      current = [];
    }
  };
  for (const unit of units) {
    if (unit.ops.length >= SAVE_CHUNK_OPS) {
      flush();
      for (let i = 0; i < unit.ops.length; i += SAVE_CHUNK_OPS) {
        chunks.push(unit.ops.slice(i, i + SAVE_CHUNK_OPS));
      }
      continue;
    }
    if (current.length + unit.ops.length > SAVE_CHUNK_OPS) flush();
    current.push(...unit.ops);
  }
  flush();
  return chunks;
}

/**
 * Carry an applied chunk's authoritative outputs into not-yet-submitted
 * chunks: rewrite temporary row IDs to their saved IDs and rebase cell
 * preconditions onto returned versions. Only preconditions that match the
 * chunk's own base are rebased; newer during-flight edits (different op
 * identities, absent here) are never touched because chunks are frozen.
 */
export function remapPendingChunks(
  chunks: RecordEdit[][],
  fromIndex: number,
  idMappings?: Record<string, string>,
  affectedValues?: Array<{ row_ref: { kind: string; id: string }; column_id: string; version: string }>,
): void {
  if (!idMappings && !affectedValues) return;
  const versions = new Map(
    (affectedValues ?? []).map((v) => [`${v.row_ref.kind}:${v.row_ref.id}:${v.column_id}`, v.version]),
  );
  const remapId = (id: string): string => idMappings?.[id] ?? id;
  for (let i = fromIndex; i < chunks.length; i++) {
    for (const op of chunks[i]!) {
      if (op.op === 'cell.set' || op.op === 'cell.clear') {
        op.row_ref = { ...op.row_ref, id: remapId(op.row_ref.id) };
        if ('base_token' in op) {
          const version = versions.get(`${op.row_ref.kind}:${op.row_ref.id}:${op.column_id}`);
          if (version !== undefined) {
            (op as { base_token?: string }).base_token = version;
          }
        }
      } else if (op.op === 'row.remove' || op.op === 'row.restore') {
        op.row_ref = { ...op.row_ref, id: remapId(op.row_ref.id) };
      } else if (op.op === 'item.edit' || op.op === 'item.remove') {
        op.source_ref = { ...op.source_ref, id: remapId(op.source_ref.id) };
      }
      // row.create keeps its temporary identity: the server maps it on
      // commit and reports the mapping for the references above.
    }
  }
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
        op_id: `op_row_${rowId}_${crypto.randomUUID().slice(0, 6)}`,
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
          op_id: `op_cell_${crypto.randomUUID().slice(0, 8)}`,
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
