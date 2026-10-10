/**
 * Scoped recoverable records draft (R16 Slice C).
 * Normalized authoritative base + RecordEdit overlay feeds the grid, list,
 * inspector, and save patches. One hook instance owns one
 * (user, workspace, list) scope; switching scopes switches instances so
 * drafts never leak across lists, workspaces, or accounts.
 *
 * Undo/redo are grouped operation sets over the op log (LIFO with
 * created-row cascading); overlay recomputes purely from base + ops.
 * Persistence is best-effort through recordsDraftStore; memory editing
 * always works and reports limited recovery when storage is unavailable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  RecordCell,
  RecordColumn,
  RecordEdit,
  RecordRef,
  RecordRow,
  RecordValue,
} from '@otis/contracts';
import { validateRecordEdit, validateRecordsContext } from '@otis/contracts';
import type { RecordsContext } from '@otis/contracts';
import {
  clearRecordsDraft,
  isRecordsDraftDurable,
  loadRecordsDraft,
  storeRecordsDraft,
} from './recordsDraftStore.js';

export interface RecordsBase {
  revision: number;
  rows: RecordRow[];
  columns: RecordColumn[];
  lists: Array<{ id: string; name: string; source_kind: string }>;
}

export interface DraftGroup {
  id: string;
  opIds: string[];
  label: string;
  ops: RecordEdit[];
}

export interface ConflictInfo {
  opId: string | null;
  message: string;
  currentValue?: RecordValue;
}

export interface SaveManifest {
  saveId: string;
  actionId: string;
  opIds: string[];
  operations: RecordEdit[];
}

export type SaveStatus =
  | { status: 'clean' }
  | { status: 'saving'; manifest: SaveManifest }
  | { status: 'unknown'; manifest: SaveManifest; message: string }
  | { status: 'conflict'; info: ConflictInfo }
  | { status: 'error'; message: string };

export interface OverlayRow extends RecordRow {
  provisional?: boolean;
  removed?: boolean;
}

function newOpId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

/** Best-effort display text for a semantic value (server owns canonical formatting). */
export function displayValue(value: RecordValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    if ('amount' in value && 'currency' in value) {
      const amount = (value as { amount: number }).amount;
      const currency = String((value as { currency: string }).currency);
      return `${currency} ${(amount / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    if ('local_date' in value) return String((value as { local_date: string }).local_date);
    if ('instant' in value) return String((value as { instant: string }).instant).slice(0, 16).replace('T', ' ');
    if ('kind' in value) {
      const due = value as Record<string, unknown>;
      if (due['kind'] === 'date') return String(due['local_date'] ?? '');
      if (due['kind'] === 'instant') return String(due['at'] ?? '').slice(0, 16).replace('T', ' ');
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function valuesEqual(a: RecordValue, b: RecordValue): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function baseCellOf(base: RecordsBase, rowId: string, columnId: string): RecordCell | null {
  const row = base.rows.find((r) => r.id === rowId);
  return row?.record_cells?.[columnId] ?? null;
}

function opTargetsRow(op: RecordEdit, rowId: string): boolean {
  switch (op.op) {
    case 'cell.set':
    case 'cell.clear':
    case 'row.remove':
    case 'row.restore':
      return op.row_ref.id === rowId;
    case 'item.edit':
    case 'item.remove':
      return op.source_ref.id === rowId;
    case 'row.create':
      return op.row_ref.id === rowId;
    default:
      return false;
  }
}

/**
 * Pure overlay: base rows/columns plus the op log. Unknown op targets are
 * ignored for display (the server rejects them honestly at save).
 */
export function applyOpsToBase(
  base: RecordsBase,
  ops: RecordEdit[],
): { rows: OverlayRow[]; columns: RecordColumn[]; removedIds: Set<string>; pendingLists: Array<{ id: string; name: string; source_kind: string }> } {
  const rows = new Map<string, OverlayRow>();
  for (const row of base.rows) rows.set(row.id, { ...row });
  let columns = [...base.columns];
  const removedIds = new Set<string>();
  const createdOrder: string[] = [];
  const pendingLists = [...(base.lists ?? [])];

  for (const op of ops) {
    switch (op.op) {
      case 'cell.set': {
        const row = rows.get(op.row_ref.id);
        if (!row || removedIds.has(row.id)) break;
        const display = displayValue(op.value);
        row.cells = { ...row.cells, [op.column_id]: display };
        const baseCell = baseCellOf(base, row.id, op.column_id);
        row.record_cells = {
          ...row.record_cells,
          [op.column_id]: {
            value: op.value,
            state: baseCell?.state ?? 'clear',
            version: baseCell?.version ?? 'draft',
            binding: baseCell?.binding ?? { kind: 'custom_row_value', column_id: op.column_id },
            editable: baseCell?.editable ?? true,
          },
        };
        break;
      }
      case 'cell.clear': {
        const row = rows.get(op.row_ref.id);
        if (!row || removedIds.has(row.id)) break;
        const nextCells = { ...row.cells };
        delete nextCells[op.column_id];
        row.cells = nextCells;
        const baseCell = baseCellOf(base, row.id, op.column_id);
        if (baseCell) {
          row.record_cells = { ...row.record_cells, [op.column_id]: { ...baseCell, value: null } };
        } else if (row.record_cells) {
          const nextRecordCells = { ...row.record_cells };
          delete nextRecordCells[op.column_id];
          row.record_cells = nextRecordCells;
        }
        break;
      }
      case 'row.create': {
        if (rows.has(op.row_ref.id)) break;
        const cells: Record<string, string> = {};
        const recordCells: Record<string, RecordCell> = {};
        for (const [key, value] of Object.entries(op.initial_values ?? {})) {
          cells[key] = displayValue(value as RecordValue);
          recordCells[key] = {
            value: value as RecordValue,
            state: 'clear',
            version: 'draft',
            binding: { kind: 'custom_row_value', column_id: key },
            editable: true,
          };
        }
        rows.set(op.row_ref.id, {
          id: op.row_ref.id,
          ref: op.row_ref,
          cells,
          record_cells: recordCells,
          provisional: true,
        });
        createdOrder.push(op.row_ref.id);
        break;
      }
      case 'row.remove': {
        if (rows.has(op.row_ref.id)) removedIds.add(op.row_ref.id);
        break;
      }
      case 'row.restore': {
        removedIds.delete(op.row_ref.id);
        break;
      }
      case 'item.edit': {
        const payload = op.payload as Record<string, RecordValue>;
        for (const [key, value] of Object.entries(payload)) {
          const row = rows.get(op.source_ref.id);
          if (!row || removedIds.has(row.id)) continue;
          row.cells = { ...row.cells, [key]: displayValue(value) };
        }
        break;
      }
      case 'item.remove': {
        if (rows.has(op.source_ref.id)) removedIds.add(op.source_ref.id);
        break;
      }
      case 'field.create': {
        if (!columns.some((c) => c.id === op.field_id)) {
          columns = [...columns, {
            id: op.field_id,
            name: op.label,
            type: op.type,
            binding: { kind: 'custom_row_value', column_id: op.field_id },
            capabilities: { sortable: true, filterable: true, editable: true },
          }];
        }
        break;
      }
      case 'field.update': {
        columns = columns.map((c) => (c.id === op.field_id
          ? { ...c, name: op.label ?? c.name, type: op.type ?? c.type }
          : c));
        break;
      }
      case 'field.archive': {
        columns = columns.filter((c) => c.id !== op.field_id);
        break;
      }
      case 'field.restore': {
        break;
      }
      case 'list.create': {
        if (!pendingLists.some((l) => l.id === op.list_id)) {
          pendingLists.push({ id: op.list_id, name: op.name, source_kind: op.source_kind });
        }
        break;
      }
      case 'list.update': {
        const existing = pendingLists.find((l) => l.id === op.list_id);
        if (existing && op.name) existing.name = op.name;
        break;
      }
      default:
        break;
    }
  }

  const ordered = [...rows.values()].sort((a, b) => {
    const aCreated = createdOrder.indexOf(a.id);
    const bCreated = createdOrder.indexOf(b.id);
    if (aCreated >= 0 || bCreated >= 0) return (aCreated < 0 ? 9999 : aCreated) - (bCreated < 0 ? 9999 : bCreated);
    return 0;
  });
  return { rows: ordered, columns, removedIds, pendingLists };
}

/**
 * Merge a durable assistant patch onto the authoritative base: drop invalid
 * ops, attach saved preconditions so the later manual save still conflicts
 * honestly, and leave provisional rows precondition-free. Pure and
 * single-application by patch id at the call site.
 */
export function mergeRecordsPatch(
  baseRows: RecordRow[],
  operations: RecordEdit[],
): RecordEdit[] {
  const staged: RecordEdit[] = [];
  for (const op of operations) {
    const check = validateRecordEdit(op);
    if (!check.valid) continue;
    if ((op.op === 'cell.set' || op.op === 'cell.clear') && op.base_token === undefined) {
      const row = baseRows.find((r) => r.id === op.row_ref.id);
      const version = row?.record_cells?.[op.column_id]?.version;
      staged.push(version && version !== 'draft' ? { ...op, base_token: version } : op);
    } else {
      staged.push(op);
    }
  }
  return staged;
}

export interface RecordsContextInput {
  listId: string;
  draftId: string;
  generation: number;
  dirty: boolean;
  selectedRows: RecordRef[];
  visibleRows: RecordRef[];
  columnIds: string[];
  search: string;
  sort: { column_id: string; direction: 'asc' | 'desc' };
  operations: RecordEdit[];
}

/**
 * Build the frozen assistant target for a turn composed beside the grid.
 * Called once per send; returns null instead of a malformed target so
 * ordinary chat never invents table scope.
 */
export function buildRecordsContext(input: RecordsContextInput): RecordsContext | null {
  try {
    const context: RecordsContext = {
      list_id: input.listId,
      target: input.dirty
        ? { mode: 'draft', draft_id: input.draftId, generation: input.generation }
        : { mode: 'saved' },
      selected_rows: input.selectedRows.slice(0, 200),
      selected_columns: input.columnIds.slice(0, 200),
      visible_row_order: input.visibleRows.slice(0, 200),
      query: {
        list_id: input.listId,
        ...(input.search ? { search: input.search } : {}),
        sort: { column_id: input.sort.column_id, direction: input.sort.direction },
      },
      ...(input.operations.length > 0 ? { draft_delta: input.operations } : {}),
    };
    const check = validateRecordsContext(context);
    return check.valid ? context : null;
  } catch {
    return null;
  }
}

export interface UseRecordsDraftOptions {
  userId: string;
  workspaceId: string;
  listId: string;
  base: RecordsBase;
}

export interface RecordsDraftApi {
  draftId: string;
  generation: number;
  ops: RecordEdit[];
  rows: OverlayRow[];
  columns: RecordColumn[];
  removedIds: Set<string>;
  pendingLists: Array<{ id: string; name: string; source_kind: string }>;
  dirtyCount: number;
  canUndo: boolean;
  canRedo: boolean;
  saveStatus: SaveStatus;
  storageDurable: boolean;
  setCell: (rowRef: RecordRef, columnId: string, value: RecordValue) => void;
  clearCell: (rowRef: RecordRef, columnId: string) => void;
  createRow: (kind: RecordRef['kind'], initialValues?: Record<string, RecordValue>) => string;
  removeRow: (rowRef: RecordRef) => void;
  restoreRow: (rowRef: RecordRef) => void;
  createField: (label: string, type: RecordColumn['type']) => string;
  updateField: (fieldId: string, label?: string) => void;
  archiveField: (fieldId: string) => void;
  createList: (name: string) => string;
  undo: () => void;
  redo: () => void;
  discard: () => void;
  beginSave: () => SaveManifest | null;
  stageOps: (label: string, ops: RecordEdit[]) => void;
  ackSave: (
    manifest: SaveManifest,
    response: { affected_values?: Array<{ row_ref: RecordRef; column_id: string; version: string }>; id_mappings?: Record<string, string> },
  ) => void;
  failSave: (manifest: SaveManifest, message: string, unknownOutcome: boolean) => void;
  setConflict: (info: ConflictInfo) => void;
  clearConflict: (strategy: 'keep-mine' | 'use-saved') => void;
}

export function useRecordsDraft(options: UseRecordsDraftOptions): RecordsDraftApi {
  const { userId, workspaceId, listId, base } = options;
  const [draftId] = useState(() => `drd_${crypto.randomUUID()}`);
  const [generation, setGeneration] = useState(0);
  const [ops, setOps] = useState<RecordEdit[]>([]);
  const [undoStack, setUndoStack] = useState<DraftGroup[]>([]);
  const [redoStack, setRedoStack] = useState<DraftGroup[]>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ status: 'clean' });
  const [resumed, setResumed] = useState(false);
  const persistTimer = useRef<number | null>(null);

  // Resume a persisted draft for this exact scope once its base arrives.
  useEffect(() => {
    if (resumed) return;
    setResumed(true);
    const stored = loadRecordsDraft(userId, workspaceId, listId);
    if (!stored || stored.operations.length === 0) return;
    const valid = (stored.operations as unknown[]).filter(
      (op): op is RecordEdit => !!op && typeof op === 'object' && typeof (op as RecordEdit).op === 'string' && typeof (op as RecordEdit).op_id === 'string',
    );
    if (valid.length === 0) return;
    setOps(valid);
    setGeneration(stored.generation + 1);
    setUndoStack([{ id: newOpId('grp'), opIds: valid.map((op) => op.op_id), label: 'Recovered draft', ops: valid }]);
  }, [resumed, userId, workspaceId, listId]);

  // Persist coalesced: at most one write per 400ms of editing, plus flush
  // on hide/unload. Storage failure keeps memory editing usable.
  useEffect(() => {
    if (!resumed) return;
    if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      if (ops.length === 0) {
        clearRecordsDraft(userId, workspaceId, listId);
      } else {
        storeRecordsDraft(userId, workspaceId, listId, {
          draftId, generation, baseRevision: base.revision, operations: ops,
        });
      }
    }, 400);
    return () => {
      if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
    };
  }, [ops, resumed, userId, workspaceId, listId, draftId, generation, base.revision]);

  useEffect(() => {
    const flush = () => {
      if (ops.length === 0) {
        clearRecordsDraft(userId, workspaceId, listId);
      } else {
        storeRecordsDraft(userId, workspaceId, listId, {
          draftId, generation, baseRevision: base.revision, operations: ops,
        });
      }
    };
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
    };
  }, [ops, userId, workspaceId, listId, draftId, generation, base.revision]);

  const overlay = useMemo(() => applyOpsToBase(base, ops), [base, ops]);

  const pushGroup = useCallback((label: string, nextOps: RecordEdit[], groupOpIds: string[]) => {
    const payloads = nextOps.filter((op) => groupOpIds.includes(op.op_id));
    setOps(nextOps);
    setUndoStack((prev) => [...prev, { id: newOpId('grp'), opIds: groupOpIds, label, ops: payloads }]);
    setRedoStack([]);
    setGeneration((g) => g + 1);
  }, []);

  const setCell = useCallback((rowRef: RecordRef, columnId: string, value: RecordValue) => {
    const baseCell = baseCellOf(base, rowRef.id, columnId);
    const baseValue = baseCell?.value ?? null;
    const others = ops.filter((op) => !(
      (op.op === 'cell.set' || op.op === 'cell.clear') &&
      op.row_ref.kind === rowRef.kind && op.row_ref.id === rowRef.id && op.column_id === columnId
    ));
    // Editing back to the saved value clears dirtiness instead of staging a no-op.
    if (baseCell && valuesEqual(baseValue, value)) {
      if (others.length !== ops.length) {
        setOps(others);
        setUndoStack((stack) => [...stack, { id: newOpId('grp'), opIds: [], label: `Revert ${columnId}`, ops: [] }]);
        setRedoStack([]);
        setGeneration((g) => g + 1);
      }
      return;
    }
    const opId = `op_cell_${rowRef.id}_${columnId}`;
    const op: RecordEdit = {
      op: 'cell.set', op_id: opId, row_ref: rowRef, column_id: columnId,
      value, base_token: baseCell?.version,
    };
    setOps([...others, op]);
    // Continuous typing on one cell coalesces into its existing group.
    setUndoStack((stack) => {
      const last = stack[stack.length - 1];
      if (last && last.opIds.length === 1 && last.opIds[0] === opId) {
        return [...stack.slice(0, -1), { ...last, ops: [op] }];
      }
      return [...stack, { id: newOpId('grp'), opIds: [opId], label: `Edit ${columnId}`, ops: [op] }];
    });
    setRedoStack([]);
    setGeneration((g) => g + 1);
  }, [base, ops]);

  const clearCell = useCallback((rowRef: RecordRef, columnId: string) => {
    const opId = `op_cell_${rowRef.id}_${columnId}`;
    const baseCell = baseCellOf(base, rowRef.id, columnId);
    const op: RecordEdit = {
      op: 'cell.clear', op_id: opId, row_ref: rowRef, column_id: columnId,
      base_token: baseCell?.version,
    };
    pushGroup(`Clear ${columnId}`, [...ops.filter((o) => o.op_id !== opId), op], [opId]);
  }, [base, ops, pushGroup]);

  const createRow = useCallback((kind: RecordRef['kind'], initialValues?: Record<string, RecordValue>) => {
    const tempId = `row_${crypto.randomUUID()}`;
    const opId = `op_row_${tempId}`;
    const op: RecordEdit = {
      op: 'row.create', op_id: opId,
      row_ref: { kind, id: tempId }, list_id: listId, initial_values: initialValues,
    };
    pushGroup('Add row', [...ops, op], [opId]);
    return tempId;
  }, [listId, ops, pushGroup]);

  const removeRow = useCallback((rowRef: RecordRef) => {
    const opId = newOpId('op_del');
    const op: RecordEdit = { op: 'row.remove', op_id: opId, row_ref: rowRef };
    pushGroup('Remove row', [...ops, op], [opId]);
  }, [ops, pushGroup]);

  const restoreRow = useCallback((rowRef: RecordRef) => {
    const opId = newOpId('op_restore');
    const op: RecordEdit = { op: 'row.restore', op_id: opId, row_ref: rowRef };
    pushGroup('Restore row', [...ops, op], [opId]);
  }, [ops, pushGroup]);

  const createField = useCallback((label: string, type: RecordColumn['type']) => {
    const fieldId = `fld_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const opId = `op_field_${fieldId}`;
    const op: RecordEdit = { op: 'field.create', op_id: opId, field_id: fieldId, list_id: listId, label, type };
    pushGroup(`Add column ${label}`, [...ops, op], [opId]);
    return fieldId;
  }, [listId, ops, pushGroup]);

  const updateField = useCallback((fieldId: string, label?: string) => {
    const opId = newOpId('op_field_upd');
    const op: RecordEdit = { op: 'field.update', op_id: opId, field_id: fieldId, label };
    pushGroup('Rename column', [...ops, op], [opId]);
  }, [ops, pushGroup]);

  const archiveField = useCallback((fieldId: string) => {
    const opId = newOpId('op_field_arch');
    const op: RecordEdit = { op: 'field.archive', op_id: opId, field_id: fieldId };
    pushGroup('Remove column', [...ops, op], [opId]);
  }, [ops, pushGroup]);

  const createList = useCallback((name: string) => {
    // A new list asks for a name only and starts with a Name column; rows
    // are added explicitly afterwards, never fabricated.
    const listId = `lst_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const fieldId = `fld_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const listOp: RecordEdit = { op: 'list.create', op_id: newOpId('op_list'), list_id: listId, name, source_kind: 'custom' };
    const fieldOp: RecordEdit = { op: 'field.create', op_id: newOpId('op_field'), field_id: fieldId, list_id: listId, label: 'Name', type: 'text' };
    pushGroup(`Create list ${name}`, [...ops, listOp, fieldOp], [listOp.op_id, fieldOp.op_id]);
    return listId;
  }, [ops, pushGroup]);

  const undo = useCallback(() => {
    const group = undoStack[undoStack.length - 1];
    if (!group) return;
    setUndoStack((stack) => stack.slice(0, -1));
    setRedoStack((redo) => [...redo, group]);
    setOps((prev) => {
      let next = prev.filter((op) => !group.opIds.includes(op.op_id));
      // Undoing a row creation also drops edits staged on that draft-only row.
      const createdIds = group.ops
        .filter((op): op is Extract<RecordEdit, { op: 'row.create' }> => op.op === 'row.create')
        .map((op) => op.row_ref.id);
      if (createdIds.length > 0) {
        next = next.filter((op) => !createdIds.some((id) => opTargetsRow(op, id)));
      }
      return next;
    });
    setGeneration((g) => g + 1);
  }, [undoStack]);

  const redo = useCallback(() => {
    const group = redoStack[redoStack.length - 1];
    if (!group) return;
    setRedoStack((stack) => stack.slice(0, -1));
    setUndoStack((stack) => [...stack, group]);
    setOps((prev) => {
      const present = new Set(prev.map((op) => op.op_id));
      return [...prev, ...group.ops.filter((op) => !present.has(op.op_id))];
    });
    setGeneration((g) => g + 1);
  }, [redoStack]);

  const discard = useCallback(() => {
    setOps([]);
    setUndoStack([]);
    setRedoStack([]);
    setSaveStatus({ status: 'clean' });
    setGeneration((g) => g + 1);
    clearRecordsDraft(userId, workspaceId, listId);
  }, [userId, workspaceId, listId]);

  /** Stage an externally built op group (paste, fill, assistant patch) as one undo unit. */
  const stageOps = useCallback((label: string, staged: RecordEdit[]) => {
    if (staged.length === 0) return;
    const ids = staged.map((op) => op.op_id);
    setOps((prev) => {
      const replaced = new Set(ids);
      return [...prev.filter((op) => !replaced.has(op.op_id)), ...staged];
    });
    setUndoStack((stack) => [...stack, { id: newOpId('grp'), opIds: ids, label, ops: staged }]);
    setRedoStack([]);
    setGeneration((g) => g + 1);
  }, []);

  const beginSave = useCallback((): SaveManifest | null => {
    if (ops.length === 0) return null;
    const manifest: SaveManifest = {
      saveId: `save_${crypto.randomUUID()}`,
      actionId: `act_rec_${crypto.randomUUID()}`,
      opIds: ops.map((op) => op.op_id),
      operations: ops,
    };
    setSaveStatus({ status: 'saving', manifest });
    return manifest;
  }, [ops]);

  const ackSave = useCallback((manifest: SaveManifest, response: {
    affected_values?: Array<{ row_ref: RecordRef; column_id: string; version: string }>;
    id_mappings?: Record<string, string>;
  }) => {
    const mappings = response.id_mappings ?? {};
    const versions = new Map(
      (response.affected_values ?? []).map((v) => [`${v.row_ref.kind}:${v.row_ref.id}:${v.column_id}`, v.version]),
    );
    const remapId = (id: string): string => mappings[id] ?? id;
    setOps((prev) => {
      const remaining = prev.filter((op) => !manifest.opIds.includes(op.op_id));
      // Remap draft-only row ids to their saved ids and rebase surviving
      // preconditions onto the authoritative returned versions, so edits
      // made during the save flight stay valid instead of false-conflicting.
      return remaining.map((op): RecordEdit => {
        if (op.op === 'cell.set' || op.op === 'cell.clear') {
          const newId = remapId(op.row_ref.id);
          const version = versions.get(`${op.row_ref.kind}:${newId}:${op.column_id}`)
            ?? versions.get(`${op.row_ref.kind}:${op.row_ref.id}:${op.column_id}`);
          return { ...op, row_ref: { ...op.row_ref, id: newId }, base_token: version ?? op.base_token };
        }
        if (op.op === 'row.remove' || op.op === 'row.restore') {
          return { ...op, row_ref: { ...op.row_ref, id: remapId(op.row_ref.id) } };
        }
        if (op.op === 'item.edit' || op.op === 'item.remove') {
          return { ...op, source_ref: { ...op.source_ref, id: remapId(op.source_ref.id) } };
        }
        return op;
      });
    });
    setSaveStatus({ status: 'clean' });
    setGeneration((g) => g + 1);
  }, []);

  const failSave = useCallback((manifest: SaveManifest, message: string, unknownOutcome: boolean) => {
    // The manifest (exact save/action ids plus payload) is retained: an
    // aborted fetch never rolls back an accepted commit, so retry reuses the
    // identical immutable payload instead of inventing a new one.
    setSaveStatus(unknownOutcome
      ? { status: 'unknown', manifest, message }
      : { status: 'error', message });
  }, []);

  const setConflict = useCallback((info: ConflictInfo) => {
    setSaveStatus({ status: 'conflict', info });
  }, []);

  const clearConflict = useCallback((strategy: 'keep-mine' | 'use-saved') => {
    if (saveStatus.status !== 'conflict') return;
    if (strategy === 'use-saved') {
      const opId = saveStatus.info.opId;
      if (opId) {
        setOps((prev) => prev.filter((op) => op.op_id !== opId));
        setUndoStack((stack) => [...stack, { id: newOpId('grp'), opIds: [], label: 'Accept saved value', ops: [] }]);
      } else {
        setOps([]);
        setUndoStack([]);
        setRedoStack([]);
      }
    }
    // Keep mine: the draft stays intact; the next save carries fresh base
    // preconditions and a new action id as a reviewed correction.
    setSaveStatus({ status: 'clean' });
    setGeneration((g) => g + 1);
  }, [saveStatus]);

  return {
    draftId,
    generation,
    ops,
    rows: overlay.rows,
    columns: overlay.columns,
    removedIds: overlay.removedIds,
    pendingLists: overlay.pendingLists,
    dirtyCount: ops.length,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    saveStatus,
    storageDurable: isRecordsDraftDurable(),
    setCell,
    clearCell,
    createRow,
    removeRow,
    restoreRow,
    createField,
    updateField,
    archiveField,
    createList,
    undo,
    redo,
    discard,
    beginSave,
    stageOps,
    ackSave,
    failSave,
    setConflict,
    clearConflict,
  };
}
