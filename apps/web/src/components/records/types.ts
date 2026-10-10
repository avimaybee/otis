/**
 * Types for the editable information / records feature in Otis (R16).
 * Follows plans/editable-records.md and design-tokens.md.
 */

import type {
  RecordColumn as ContractRecordColumn,
  RecordRow as ContractRecordRow,
  RecordList as ContractRecordList,
  RecordHistoryItem as ContractRecordHistoryItem,
  ColumnType,
  RecordCell,
  RecordRef,
  RecordValue,
  CellState,
  CellBinding,
  RecordEdit,
  RecordsSaveRequest,
  RecordsSaveResponse,
} from '@otis/contracts';

export type {
  ContractRecordColumn,
  ContractRecordRow,
  ContractRecordList,
  ContractRecordHistoryItem,
  ColumnType,
  RecordCell,
  RecordRef,
  RecordValue,
  CellState,
  CellBinding,
  RecordEdit,
  RecordsSaveRequest,
  RecordsSaveResponse,
};

export type RecordFieldType = ColumnType;
export type RecordColumn = ContractRecordColumn;
export type RecordRow = ContractRecordRow;
export type RecordList = ContractRecordList;
export type RecordHistoryItem = ContractRecordHistoryItem;

export interface ColumnCalculation {
  expression: string;
  description: string;
  targetType?: 'number' | 'currency';
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
