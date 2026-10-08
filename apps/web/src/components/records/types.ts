/**
 * Types for the editable information / records feature in Otis (R16).
 * Follows plans/editable-records.md and design-tokens.md.
 */

export type RecordFieldType =
  | 'text'
  | 'status'
  | 'phone'
  | 'currency'
  | 'number'
  | 'date'
  | 'calculation';

export interface ColumnCalculation {
  expression: string;
  description: string;
  targetType?: 'number' | 'currency';
}

export interface RecordColumn {
  id: string;
  name: string;
  type: RecordFieldType;
  width?: number;
  isCore?: boolean;
  options?: string[];
  calculation?: ColumnCalculation;
}

export interface RecordRow {
  id: string;
  source: 'entity' | 'task' | 'memory' | 'interaction' | 'draft' | 'custom';
  cells: Record<string, string>;
  updatedAt?: string;
  provenance?: Record<string, string>;
}

export interface RecordList {
  id: string;
  name: string;
  description?: string;
  columns: RecordColumn[];
  rows: RecordRow[];
}

export interface DirtyCellState {
  rowId: string;
  columnId: string;
  baseValue: string;
  currentValue: string;
  timestamp: number;
}

export interface RecordsDraft {
  dirtyCells: Record<string, DirtyCellState>; // key: `${rowId}:${columnId}`
  addedRows: RecordRow[];
  deletedRowIds: Set<string>;
  addedColumns: RecordColumn[];
  undoStack: DraftOperation[];
  redoStack: DraftOperation[];
}

export type DraftOperation =
  | { type: 'cell_edit'; rowId: string; columnId: string; prevValue: string; nextValue: string }
  | { type: 'add_row'; row: RecordRow }
  | { type: 'delete_row'; row: RecordRow }
  | { type: 'add_column'; column: RecordColumn };

export interface RecordHistoryItem {
  id: string;
  timestamp: string;
  actor: 'user' | 'otis';
  description: string;
  affectedCount: number;
  canRestore: boolean;
}
