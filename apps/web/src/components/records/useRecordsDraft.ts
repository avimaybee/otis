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
  replaced?: RecordEdit[];
}

export interface ConflictInfo {
  opId: string | null;
  message: string;
  currentValue?: RecordValue;
  currentToken?: string;
}

export interface SaveManifest {
  saveId: string;
  actionId: string;
  opIds: string[];
  operations: RecordEdit[];
  listId: string;
  chunkIndex: number;
  chunkCount: number;
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

/**
 * Predecessor for a coalesced cell edit group: always the value from before
 * the group started, never intermediates and never the just-displaced edit.
 * Undo of `one → two → three` therefore restores the pre-`one` baseline
 * instead of staging a competing `one`. An empty and an unset predecessor
 * both mean "nothing unsaved before this group".
 */
export function mergeEditPredecessors(
  lastReplaced: RecordEdit[] | undefined,
): RecordEdit[] {
  return lastReplaced ?? [];
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
 * ordinary chat never invents table scope. An oversized delta retains its
 * draft target without the inline delta and asks for a narrower scope,
 * instead of silently dropping draft write protection.
 */
export function buildRecordsContext(input: RecordsContextInput): RecordsContext | null {
  try {
    const ops = input.operations;
    const omitted = ops.length > 100;
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
      ...(ops.length > 0 ? { draft_delta: ops.slice(0, 100) } : {}),
      ...(omitted ? { draft_delta_omitted: true as const } : {}),
    };
    const check = validateRecordsContext(context);
    if (check.valid) return context;
    const tooLarge = !check.valid && check.message.includes('over the') && check.message.includes('inline limit');
    if (tooLarge) {
      const narrowed: RecordsContext = {
        ...context,
        selected_rows: context.selected_rows.slice(0, 20),
        selected_columns: context.selected_columns.slice(0, 20),
        visible_row_order: context.visible_row_order.slice(0, 20),
      };
      delete (narrowed as { draft_delta?: unknown }).draft_delta;
      if (ops.length > 0) narrowed.draft_delta_omitted = true;
      const recheck = validateRecordsContext(narrowed);
      return recheck.valid ? narrowed : null;
    }
    return null;
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
  beginSave: (chunk?: { operations: RecordEdit[]; chunkIndex: number; chunkCount: number; saveId?: string }) => SaveManifest | null;
  stageOps: (label: string, ops: RecordEdit[]) => void;
  ackSave: (
    manifest: SaveManifest,
    response: { affected_values?: Array<{ row_ref: RecordRef; column_id: string; version: string }>; id_mappings?: Record<string, string> },
  ) => RecordEdit[];
  failSave: (manifest: SaveManifest, message: string, unknownOutcome: boolean) => void;
  setConflict: (info: ConflictInfo) => void;
  clearConflict: (strategy: 'keep-mine' | 'use-saved') => void;
}

export function useRecordsDraft(options: UseRecordsDraftOptions): RecordsDraftApi {
  const { userId, workspaceId, listId, base } = options;
  const scopeKey = `${userId}:${workspaceId}:${listId}`;
  const scopeRef = useRef(scopeKey);
  const [draftId, setDraftId] = useState(() => `drd_${crypto.randomUUID()}`);
  const [generation, setGeneration] = useState(0);
  const [ops, setOps] = useState<RecordEdit[]>([]);
  const [undoStack, setUndoStack] = useState<DraftGroup[]>([]);
  const [redoStack, setRedoStack] = useState<DraftGroup[]>([]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ status: 'clean' });
  const [resumed, setResumed] = useState(false);
  const persistTimer = useRef<number | null>(null);
  const opsRef = useRef(ops);
  opsRef.current = ops;
  const saveStatusRef = useRef(saveStatus);
  saveStatusRef.current = saveStatus;
  // Synchronous mirrors: acknowledged/persisted state must never depend on
  // whether React has flushed a render yet (RR16). Mutators that run back
  // to back in one tick (ackSave → beginSave) observe exact values.
  const generationRef = useRef(generation);

  // Explicit scope ownership: switching list/workspace/account flushes the
  // previous scope synchronously and resets hook state, so edits never leak
  // across scopes and the recovery flag cannot retain a prior scope.
  useEffect(() => {
    if (scopeRef.current === scopeKey) return;
    const [prevUser, prevWs, prevList] = scopeRef.current.split(':');
    const prevOps = opsRef.current;
    const prevStatus = saveStatusRef.current;
    try {
      if (prevOps.length > 0 && prevUser && prevWs && prevList) {
        const pending = prevStatus.status === 'unknown' || prevStatus.status === 'saving'
          ? (prevStatus as { manifest?: SaveManifest }).manifest ?? null
          : null;
        storeRecordsDraft(prevUser, prevWs, prevList, {
          draftId: `drd_flushed_${Date.now()}`,
          generation: 0,
          baseRevision: -1,
          operations: prevOps,
          ...(pending ? { pendingSave: { saveId: pending.saveId, actionId: pending.actionId, opIds: pending.opIds, operations: pending.operations, listId: pending.listId, chunkIndex: pending.chunkIndex, chunkCount: pending.chunkCount } } : {}),
        });
      }
    } catch {
      // Best effort flush; new scope still resets.
    }
    scopeRef.current = scopeKey;
    setDraftId(`drd_${crypto.randomUUID()}`);
    setOps([]);
    setUndoStack([]);
    setRedoStack([]);
    setSaveStatus({ status: 'clean' });
    generationRef.current = 0;
    setGeneration(0);
    setResumed(false);
  }, [scopeKey]);

  // Resume a persisted draft for this exact scope once its base arrives.
  useEffect(() => {
    if (resumed) return;
    setResumed(true);
    const stored = loadRecordsDraft(userId, workspaceId, listId);
    if (!stored) return;
    if (stored.pendingSave && Array.isArray(stored.pendingSave.operations) && stored.pendingSave.operations.length > 0) {
      const manifest: SaveManifest = {
        saveId: stored.pendingSave.saveId,
        actionId: stored.pendingSave.actionId,
        opIds: stored.pendingSave.opIds,
        operations: stored.pendingSave.operations as RecordEdit[],
        listId: stored.pendingSave.listId,
        chunkIndex: stored.pendingSave.chunkIndex,
        chunkCount: stored.pendingSave.chunkCount,
      };
      const valid = (stored.operations as unknown[]).filter(
        (op): op is RecordEdit => !!op && typeof op === 'object' && typeof (op as RecordEdit).op === 'string' && typeof (op as RecordEdit).op_id === 'string',
      );
      setOps(valid);
      generationRef.current = stored.generation + 1;
      setGeneration(stored.generation + 1);
      setUndoStack([{ id: newOpId('grp'), opIds: valid.map((op) => op.op_id), label: 'Recovered draft', ops: valid }]);
      setSaveStatus({ status: 'unknown', manifest, message: 'A previous save response was lost. Retry with the same save before editing further.' });
      return;
    }
    if (!stored || stored.operations.length === 0) return;
    const valid = (stored.operations as unknown[]).filter(
      (op): op is RecordEdit => !!op && typeof op === 'object' && typeof (op as RecordEdit).op === 'string' && typeof (op as RecordEdit).op_id === 'string',
    );
    if (valid.length === 0) return;
    setOps(valid);
    generationRef.current = stored.generation + 1;
    setGeneration(stored.generation + 1);
    setUndoStack([{ id: newOpId('grp'), opIds: valid.map((op) => op.op_id), label: 'Recovered draft', ops: valid }]);
  }, [resumed, userId, workspaceId, listId]);

  // Persist coalesced: at most one write per 400ms of editing, plus flush
  // on hide/unload. The in-flight/unknown manifest travels with the ops so a
  // reload recovers the exact immutable retry payload. Storage failure keeps
  // memory editing usable.
  useEffect(() => {
    if (!resumed) return;
    if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      const pending = saveStatus.status === 'unknown' || saveStatus.status === 'saving' ? saveStatus.manifest : null;
      generationRef.current = generation;
      if (ops.length === 0 && !pending) {
        clearRecordsDraft(userId, workspaceId, listId);
      } else {
        storeRecordsDraft(userId, workspaceId, listId, {
          draftId, generation, baseRevision: base.revision, operations: ops,
          ...(pending ? { pendingSave: { saveId: pending.saveId, actionId: pending.actionId, opIds: pending.opIds, operations: pending.operations, listId: pending.listId, chunkIndex: pending.chunkIndex, chunkCount: pending.chunkCount } } : {}),
        });
      }
    }, 400);
    return () => {
      if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
    };
  }, [ops, resumed, userId, workspaceId, listId, draftId, generation, base.revision, saveStatus]);

  useEffect(() => {
    const flush = () => {
      const pending = saveStatusRef.current.status === 'unknown' || saveStatusRef.current.status === 'saving'
        ? (saveStatusRef.current as { manifest: SaveManifest }).manifest
        : null;
      const currentOps = opsRef.current;
      if (currentOps.length === 0 && !pending) {
        clearRecordsDraft(userId, workspaceId, listId);
      } else {
        storeRecordsDraft(userId, workspaceId, listId, {
          draftId, generation, baseRevision: base.revision, operations: currentOps,
          ...(pending ? { pendingSave: { saveId: pending.saveId, actionId: pending.actionId, opIds: pending.opIds, operations: pending.operations, listId: pending.listId, chunkIndex: pending.chunkIndex, chunkCount: pending.chunkCount } } : {}),
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
  }, [userId, workspaceId, listId, draftId, generation, base.revision]);

  const overlay = useMemo(() => applyOpsToBase(base, ops), [base, ops]);

  const pushGroup = useCallback((label: string, nextOps: RecordEdit[], groupOpIds: string[], replaced?: RecordEdit[]) => {
    const payloads = nextOps.filter((op) => groupOpIds.includes(op.op_id));
    setOps(nextOps);
    setUndoStack((prev) => [...prev, { id: newOpId('grp'), opIds: groupOpIds, label, ops: payloads, ...(replaced && replaced.length > 0 ? { replaced } : {}) }]);
    setRedoStack([]);
    setGeneration((g) => g + 1);
  }, []);

  const setCell = useCallback((rowRef: RecordRef, columnId: string, value: RecordValue) => {
    const baseCell = baseCellOf(base, rowRef.id, columnId);
    const baseValue = baseCell?.value ?? null;
    const replaced = ops.filter((op) =>
      (op.op === 'cell.set' || op.op === 'cell.clear') &&
      op.row_ref.kind === rowRef.kind && op.row_ref.id === rowRef.id && op.column_id === columnId
    );
    const others = ops.filter((op) => !replaced.includes(op));
    // Editing back to the saved value clears dirtiness instead of staging a no-op.
    if (baseCell && valuesEqual(baseValue, value)) {
      if (replaced.length > 0) {
        setOps(others);
        setUndoStack((stack) => [...stack, { id: newOpId('grp'), opIds: [], label: `Revert ${columnId}`, ops: [], replaced }]);
        setRedoStack([]);
        setGeneration((g) => g + 1);
      }
      return;
    }
    // Unique operation identity per edit: acknowledgement removes only the
    // exact submitted generation, so an edit made while Save is in flight is
    // retained and rebased instead of discarded with the older value.
    const opId = `op_cell_${crypto.randomUUID().slice(0, 8)}`;
    const op: RecordEdit = {
      op: 'cell.set', op_id: opId, row_ref: rowRef, column_id: columnId,
      value, base_token: baseCell?.version,
    };
    setOps([...others, op]);
    // Continuous typing on one cell coalesces into its existing group by cell
    // coordinates. Undo must restore the value from before the group, so the
    // group keeps only its original predecessor, never intermediates.
    setUndoStack((stack) => {
      const last = stack[stack.length - 1];
      const lastOp = last?.ops[0];
      if (last && last.ops.length === 1 && lastOp &&
        (lastOp.op === 'cell.set' || lastOp.op === 'cell.clear') &&
        lastOp.row_ref.id === rowRef.id && lastOp.column_id === columnId) {
        const original = mergeEditPredecessors(last.replaced);
        return [...stack.slice(0, -1), { ...last, opIds: [opId], ops: [op], ...(original.length > 0 ? { replaced: original } : {}) }];
      }
      return [...stack, { id: newOpId('grp'), opIds: [opId], label: `Edit ${columnId}`, ops: [op], ...(replaced.length > 0 ? { replaced } : {}) }];
    });
    setRedoStack([]);
    setGeneration((g) => g + 1);
  }, [base, ops]);

  const clearCell = useCallback((rowRef: RecordRef, columnId: string) => {
    const opId = `op_cell_${crypto.randomUUID().slice(0, 8)}`;
    const baseCell = baseCellOf(base, rowRef.id, columnId);
    const op: RecordEdit = {
      op: 'cell.clear', op_id: opId, row_ref: rowRef, column_id: columnId,
      base_token: baseCell?.version,
    };
    const replaced = ops.filter((o) =>
      (o.op === 'cell.set' || o.op === 'cell.clear') &&
      o.row_ref.kind === rowRef.kind && o.row_ref.id === rowRef.id && o.column_id === columnId
    );
    const others = ops.filter((o) => !replaced.includes(o));
    pushGroup(`Clear ${columnId}`, [...others, op], [opId], replaced);
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
      // Restore the predecessor unsaved value when an edit replaced one:
      // editing A, then B, then A again undoes to the prior unsaved A.
      if (group.replaced && group.replaced.length > 0) {
        const present = new Set(next.map((op) => op.op_id));
        for (const rep of group.replaced) {
          if (!present.has(rep.op_id)) next.push(rep);
        }
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
      let next = [...prev];
      if (group.replaced && group.replaced.length > 0) {
        const replacedIds = new Set(group.replaced.map((op) => op.op_id));
        next = next.filter((op) => !replacedIds.has(op.op_id));
      }
      const present = new Set(next.map((op) => op.op_id));
      return [...next, ...group.ops.filter((op) => !present.has(op.op_id))];
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
    const cellKey = (op: RecordEdit): string | null => {
      if (op.op === 'cell.set' || op.op === 'cell.clear') {
        return `cell:${op.row_ref.kind}:${op.row_ref.id}:${op.column_id}`;
      }
      return null;
    };
    const stagedCellKeys = new Set(staged.map(cellKey).filter((k): k is string => !!k));
    const stagedIds = new Set(staged.map((op) => op.op_id));
    const current = opsRef.current;
    const replaced = current.filter((op) => {
      const key = cellKey(op);
      if (key && stagedCellKeys.has(key)) return true;
      return stagedIds.has(op.op_id);
    });
    const kept = current.filter((op) => !replaced.includes(op));
    setOps([...kept, ...staged]);
    const ids = staged.map((op) => op.op_id);
    setUndoStack((stack) => [...stack, { id: newOpId('grp'), opIds: ids, label, ops: staged, ...(replaced.length > 0 ? { replaced } : {}) }]);
    setRedoStack([]);
    setGeneration((g) => g + 1);
  }, []);

  const beginSave = useCallback((chunk?: { operations: RecordEdit[]; chunkIndex: number; chunkCount: number; saveId?: string }): SaveManifest | null => {
    const chunkOps = chunk?.operations ?? ops;
    if (chunkOps.length === 0) return null;
    const manifest: SaveManifest = {
      saveId: chunk?.saveId ?? `save_${crypto.randomUUID()}`,
      actionId: `act_rec_${crypto.randomUUID()}`,
      opIds: chunkOps.map((op) => op.op_id),
      operations: chunkOps,
      listId,
      chunkIndex: chunk?.chunkIndex ?? 0,
      chunkCount: chunk?.chunkCount ?? 1,
    };
    setSaveStatus({ status: 'saving', manifest });
    try {
      // Persist the live draft, not the captured render snapshot: chunk 2
      // begins after chunk 1 was acknowledged, so the closure ops would
      // resurrect already-saved operations on a hard termination.
      const liveOps = opsRef.current;
      storeRecordsDraft(userId, workspaceId, listId, {
        draftId, generation: generationRef.current, baseRevision: base.revision, operations: liveOps,
        pendingSave: {
          saveId: manifest.saveId, actionId: manifest.actionId, opIds: manifest.opIds,
          operations: manifest.operations, listId, chunkIndex: manifest.chunkIndex, chunkCount: manifest.chunkCount,
        },
      });
    } catch {
      // Memory editing stays usable.
    }
    return manifest;
  }, [ops, listId, userId, workspaceId, draftId, generation, base.revision]);

  const ackSave = useCallback((manifest: SaveManifest, response: {
    affected_values?: Array<{ row_ref: RecordRef; column_id: string; version: string }>;
    id_mappings?: Record<string, string>;
  }): RecordEdit[] => {
    const mappings = response.id_mappings ?? {};
    const versions = new Map(
      (response.affected_values ?? []).map((v) => [`${v.row_ref.kind}:${v.row_ref.id}:${v.column_id}`, v.version]),
    );
    const remapId = (id: string): string => mappings[id] ?? id;
    // Compute from the ref synchronously: a render may not have flushed
    // yet, and the next chunk begins in this same tick. The ref assignment
    // below keeps every later synchronous read exact.
    const rebase = (op: RecordEdit): RecordEdit => {
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
    };
    // Acknowledge only the exact submitted operation identities: newer edits
    // made during the flight carry different IDs and survive, rebased onto
    // the authoritative returned versions and remapped IDs.
    const remaining = opsRef.current
      .filter((op) => !manifest.opIds.includes(op.op_id))
      .map(rebase);
    opsRef.current = remaining;
    generationRef.current += 1;
    setOps(remaining);
    setSaveStatus({ status: 'clean' });
    setGeneration(generationRef.current);
    // Acknowledged operations leave local Undo history: surviving during-flight
    // edits keep their groups, pruned to live operations only. Cleared
    // predecessors are set explicitly: spreading the old group would
    // otherwise resurrect an acknowledged `replaced` array.
    const ackedIds = new Set(manifest.opIds);
    const pruneGroup = (group: DraftGroup): DraftGroup | null => {
      const liveOps = group.ops.filter((op) => !ackedIds.has(op.op_id));
      const liveReplaced = (group.replaced ?? []).filter((op) => !ackedIds.has(op.op_id));
      if (liveOps.length === 0 && liveReplaced.length === 0) return null;
      const pruned: DraftGroup = {
        id: group.id,
        opIds: liveOps.map((op) => op.op_id),
        label: group.label,
        ops: liveOps,
      };
      if (liveReplaced.length > 0) pruned.replaced = liveReplaced;
      return pruned;
    };
    setUndoStack((prev) => prev.map(pruneGroup).filter((g): g is DraftGroup => g !== null));
    setRedoStack((prev) => prev.map(pruneGroup).filter((g): g is DraftGroup => g !== null));
    try {
      if (remaining.length === 0) {
        clearRecordsDraft(userId, workspaceId, listId);
      } else {
        storeRecordsDraft(userId, workspaceId, listId, {
          draftId, generation: generationRef.current, baseRevision: base.revision, operations: remaining,
        });
      }
    } catch {
      // Best effort.
    }
    return remaining;
  }, [userId, workspaceId, listId, draftId, base.revision]);

  const failSave = useCallback((manifest: SaveManifest, message: string, unknownOutcome: boolean) => {
    // The manifest (exact save/action ids plus payload) is retained: an
    // aborted fetch never rolls back an accepted commit, so retry reuses the
    // identical immutable payload instead of inventing a new one. Unknown
    // outcomes persist the manifest for reload recovery; deterministic
    // rejections do not.
    if (unknownOutcome) {
      try {
        storeRecordsDraft(userId, workspaceId, listId, {
          draftId, generation: generationRef.current, baseRevision: base.revision, operations: opsRef.current,
          pendingSave: {
            saveId: manifest.saveId, actionId: manifest.actionId, opIds: manifest.opIds,
            operations: manifest.operations, listId: manifest.listId,
            chunkIndex: manifest.chunkIndex, chunkCount: manifest.chunkCount,
          },
        });
      } catch {
        // Memory editing stays usable.
      }
    }
    setSaveStatus(unknownOutcome
      ? { status: 'unknown', manifest, message }
      : { status: 'error', message });
  }, [userId, workspaceId, listId, draftId, generation, base.revision]);

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
      }
      // Without an operation identity the conflict cannot name its target:
      // keep the entire draft for narrow review instead of discarding it.
    } else {
      // Keep mine is a reviewed correction: refresh the conflicted operation's
      // base precondition to the current server version so the retry does not
      // false-conflict against its own prior Save.
      const opId = saveStatus.info.opId;
      const currentToken = saveStatus.info.currentToken;
      if (opId && currentToken) {
        setOps((prev) => prev.map((op) =>
          op.op_id === opId && ('base_token' in op) ? { ...op, base_token: currentToken } : op
        ));
      }
    }
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
