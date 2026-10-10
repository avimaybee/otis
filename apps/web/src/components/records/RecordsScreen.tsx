import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense, Component, type ReactNode } from 'react';
import { Toaster, toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { HistoryNav } from '../HistoryNav.js';
import { SettingsPane } from '../SettingsPane.js';
import { Overlay } from '../Overlay.js';
import { SparklesIcon, MenuIcon, CloseIcon } from '../icons.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';
import { api, ApiError } from '../../api/client.js';
import { useNavChats, fetchMoreChats, qk } from '../../api/queries.js';
import type {
  RecordColumn,
  RecordList,
  RecordRef,
  RecordRow,
  RecordValue,
} from './types.js';
import type { RecordsResponse } from '@otis/contracts';
import { RecordsControlBar, RecordsEditBar, type SortSpec } from './RecordsControlBar.js';
import { RecordsTable } from './RecordsTable.js';
import { canUseCanvasGrid, planPaste, type GridCellEdit } from './gridCore.js';
import { RecordRowList } from './RecordRowList.js';
import { RecordRowEditor } from './RecordRowEditor.js';
import { AddColumnDialog } from './AddColumnDialog.js';
import { AddListDialog } from './AddListDialog.js';
import { RecordsHistorySheet } from './RecordsHistorySheet.js';
import { AskOtisPane } from './AskOtisPane.js';
import { UnifiedSearchDialog } from '../UnifiedSearchDialog.js';
import { DuplicateMergeDialog } from '../DuplicateMergeDialog.js';
import { useRecordsDraft, buildRecordsContext, displayValue, mergeRecordsPatch, type RecordsBase, type SaveManifest } from './useRecordsDraft.js';
import type { RecordEdit, RecordFieldType } from './types.js';

const RecordsGridLazy = lazy(() => import('./RecordsGrid.js').then((m) => ({ default: m.RecordsGrid })));

/** A grid crash never takes the page down: the DOM table stays available. */
class GridErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export interface RecordsScreenProps {
  workspaceId: string;
  listId?: string | null;
  workspaces: { id: string; name: string; role?: string }[];
  userId: string;
  members: Record<string, string>;
  onSignOut: () => void;
  onNavigate: (workspace: string, chat: string | null, replace?: boolean) => void;
  onNavigateToList?: (workspace: string, listId: string, replace?: boolean) => void;
  onRefreshSession?: () => Promise<void>;
}

const PAGE_LIMIT = 50;

const SORT_OPTIONS: Record<string, Array<{ id: string; label: string }>> = {
  leads: [
    { id: 'created', label: 'Created' },
    { id: 'updated', label: 'Recently changed' },
    { id: 'name', label: 'Name' },
    { id: 'status', label: 'Status' },
  ],
  tasks: [
    { id: 'due', label: 'Due date' },
    { id: 'title', label: 'Title' },
    { id: 'created', label: 'Created' },
  ],
  notes: [{ id: 'occurred', label: 'Date' }],
  drafts: [
    { id: 'updated', label: 'Recently changed' },
    { id: 'title', label: 'Title' },
  ],
};

const DEFAULT_SORTS: Record<string, SortSpec> = {
  leads: { column: 'created', dir: 'asc' },
  tasks: { column: 'due', dir: 'asc' },
  notes: { column: 'occurred', dir: 'desc' },
  drafts: { column: 'updated', dir: 'desc' },
};

function listKindOf(sourceKind: string | undefined, fallback: RecordRef['kind']): RecordRef['kind'] {
  if (sourceKind === 'entity' || sourceKind === 'task' || sourceKind === 'interaction' || sourceKind === 'draft' || sourceKind === 'custom') {
    return sourceKind;
  }
  return fallback;
}

function parseTextInput(column: RecordColumn, text: string): RecordValue {
  if (column.type === 'number') {
    if (text.trim() === '') return text;
    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : text;
  }
  if (column.type === 'boolean') {
    const lowered = text.trim().toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
    return text;
  }
  return text;
}

/** One-line human summary of staged operations for review banners. */
function describePatchOps(ops: import('@otis/contracts').RecordEdit[]): string {
  const parts = ops.slice(0, 3).map((op) => {
    switch (op.op) {
      case 'cell.set': return `set ${op.column_id}`;
      case 'cell.clear': return `clear ${op.column_id}`;
      case 'row.create': return 'add a row';
      case 'row.remove': return 'remove a row';
      case 'row.restore': return 'restore a row';
      case 'item.edit': return 'edit an entry';
      case 'item.remove': return 'remove an entry';
      case 'field.create': return `add column ${op.label}`;
      case 'list.create': return `create list ${op.name}`;
      case 'calculation.define': return 'define a calculation';
      default: return 'change definitions';
    }
  });
  return parts.join(' · ') + (ops.length > 3 ? ` · +${ops.length - 3} more` : '');
}

export function RecordsScreen(props: RecordsScreenProps) {
  const queryClient = useQueryClient();
  const [activeListId, setActiveListId] = useState<string>(() => props.listId ?? 'leads');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sorts, setSorts] = useState<Record<string, SortSpec>>({});
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'cards'>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches ? 'cards' : 'grid',
  );
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [copying, setCopying] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [selectedRowForEditor, setSelectedRowForEditor] = useState<RecordRow | null>(null);
  const [isAddColumnOpen, setIsAddColumnOpen] = useState(false);
  const [isAddListOpen, setIsAddListOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isAskOtisOpen, setIsAskOtisOpen] = useState(false);
  const [suggestedQuestion, setSuggestedQuestion] = useState<string | null>(null);
  const [sidebarChatId, setSidebarChatId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isUnifiedSearchOpen, setIsUnifiedSearchOpen] = useState(false);
  const [isDuplicatesOpen, setIsDuplicatesOpen] = useState(false);
  const [isNavDrawerOpen, setIsNavDrawerOpen] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [extraRows, setExtraRows] = useState<RecordRow[]>([]);
  const [extraCursor, setExtraCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const gridRegionRef = useRef<HTMLDivElement>(null);

  const sort: SortSpec = sorts[activeListId] ?? DEFAULT_SORTS[activeListId] ?? { column: 'created', dir: 'asc' };

  // Debounced server search: the list query covers the whole list, and the
  // draft overlay pins changed rows the search excludes.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 400);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (props.listId && props.listId !== activeListId) {
      setActiveListId(props.listId);
    }
  }, [props.listId]);

  // A new scope resets paging, selection, and transient banners.
  useEffect(() => {
    setExtraRows([]);
    setExtraCursor(undefined);
    setSelectedIds([]);
    setSelectedRowForEditor(null);
  }, [props.workspaceId, activeListId, search, sort.column, sort.dir]);

  const recordsQuery = useQuery({
    queryKey: qk.records(props.userId, props.workspaceId, activeListId, { search, sort: `${sort.column}:${sort.dir}` }),
    queryFn: ({ signal }) => api.getRecords(props.workspaceId, {
      list_id: activeListId,
      search: search || undefined,
      sort: { column_id: sort.column, direction: sort.dir },
      limit: PAGE_LIMIT,
    }, signal),
    staleTime: 15_000,
  });

  const response: RecordsResponse | undefined = recordsQuery.data;
  const serverLists = useMemo(() => response?.lists ?? [], [response]);
  const activeServerList: RecordList | undefined = useMemo(
    () => serverLists.find((l) => l.id === activeListId) ?? serverLists[0],
    [serverLists, activeListId],
  );
  const history = useMemo(() => response?.history ?? {}, [response]);

  const base: RecordsBase = useMemo(() => ({
    revision: response?.revision ?? 0,
    rows: [...(activeServerList?.rows ?? []), ...extraRows],
    columns: activeServerList?.columns ?? [],
    lists: serverLists.map((l) => ({ id: l.id, name: l.name, source_kind: l.source_kind ?? 'custom' })),
  }), [response?.revision, activeServerList, extraRows, serverLists]);

  const draft = useRecordsDraft({ userId: props.userId, workspaceId: props.workspaceId, listId: activeListId, base });

  const allLists = useMemo(() => {
    const known = new Map(serverLists.map((l) => [l.id, { id: l.id, name: l.name, total: l.total_rows ?? null }] as const));
    for (const pending of draft.pendingLists) {
      if (!known.has(pending.id)) known.set(pending.id, { id: pending.id, name: pending.name, total: null });
    }
    return [...known.values()];
  }, [serverLists, draft.pendingLists]);

  // Personal view preferences: widths and order persist per scope, never as
  // business events. Hidden columns ride alongside in component state.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [columnOrder, setColumnOrder] = useState<string[] | null>(null);

  const visibleColumns = useMemo(() => {
    const ordered = columnOrder
      ? [...draft.columns].sort((a, b) => {
        const rank = new Map(columnOrder.map((id, index) => [id, index]));
        return (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999);
      })
      : draft.columns;
    return ordered.filter((c) => !hiddenColumns.has(c.id));
  }, [draft.columns, hiddenColumns, columnOrder]);

  const columnById = useMemo(() => new Map(draft.columns.map((c) => [c.id, c])), [draft.columns]);

  // Local view filter only; search itself runs on the server.
  const filteredRows = useMemo(() => {
    let rows = draft.rows.filter((r) => !draft.removedIds.has(r.id));
    if (statusFilter) {
      rows = rows.filter((r) => String(r.cells['status'] ?? '') === statusFilter);
    }
    return rows;
  }, [draft.rows, draft.removedIds, statusFilter]);

  // Changed rows the server search excludes stay pinned with an explanation.
  const pinnedRows = useMemo(() => {
    if (!search) return [];
    const dirtyIds = new Set<string>();
    for (const op of draft.ops) {
      if (op.op === 'cell.set' || op.op === 'cell.clear') dirtyIds.add(op.row_ref.id);
      else if (op.op === 'row.create') dirtyIds.add(op.row_ref.id);
    }
    return draft.rows.filter((r) => (dirtyIds.has(r.id) || r.provisional) && !filteredRows.some((f) => f.id === r.id));
  }, [search, draft.ops, draft.rows, filteredRows]);

  // Dirty markers for the grid and editor: overlay rows already carry edited
  // values, so markers only flag which cells differ from the saved base.
  const dirtyCells = useMemo(() => {
    const markers: Record<string, { rowId: string; columnId: string; baseValue: string; currentValue: string; timestamp: number }> = {};
    for (const op of draft.ops) {
      if (op.op === 'cell.set') {
        markers[`${op.row_ref.id}:${op.column_id}`] = {
          rowId: op.row_ref.id,
          columnId: op.column_id,
          baseValue: '',
          currentValue: typeof op.value === 'string' ? op.value : displayValue(op.value),
          timestamp: 0,
        };
      } else if (op.op === 'cell.clear') {
        markers[`${op.row_ref.id}:${op.column_id}`] = {
          rowId: op.row_ref.id, columnId: op.column_id, baseValue: '', currentValue: '', timestamp: 0,
        };
      }
    }
    return markers;
  }, [draft.ops]);

  const refOfRow = useCallback((rowId: string): RecordRef => {
    const overlay = draft.rows.find((r) => r.id === rowId);
    if (overlay?.ref) return overlay.ref;
    const kind = listKindOf(activeServerList?.source_kind, 'custom');
    return { kind, id: rowId };
  }, [draft.rows, activeServerList?.source_kind]);

  // Personal view preferences load for this scope (state declared above).
  useEffect(() => {
    setColumnWidths({});
    setColumnOrder(null);
    try {
      const raw = localStorage.getItem(`otis:records-view:${props.userId}:${props.workspaceId}:${activeListId}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { widths?: Record<string, number>; order?: string[] };
        if (parsed.widths) setColumnWidths(parsed.widths);
        if (Array.isArray(parsed.order)) setColumnOrder(parsed.order);
      }
    } catch {
      // Personal prefs are best effort; the grid works without them.
    }
  }, [props.userId, props.workspaceId, activeListId]);
  useEffect(() => {
    try {
      localStorage.setItem(
        `otis:records-view:${props.userId}:${props.workspaceId}:${activeListId}`,
        JSON.stringify({ widths: columnWidths, order: columnOrder }),
      );
    } catch {
      // Best effort.
    }
  }, [columnWidths, columnOrder, props.userId, props.workspaceId, activeListId]);

  // Saved base versions for conflict preconditions on grid gestures.
  const baseVersions = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of base.rows) {
      for (const [columnId, cell] of Object.entries(row.record_cells ?? {})) {
        map.set(`${row.id}:${columnId}`, cell.version);
      }
    }
    return map;
  }, [base]);

  const [pasteReview, setPasteReview] = useState<{ rows: Array<{ rowId: string; values: string[] }> } | null>(null);
  const [patchReviews, setPatchReviews] = useState<import('@otis/contracts').RecordsPatch[]>([]);

  // Durable assistant patches: apply once when the draft they target is the
  // open one; otherwise keep them reviewable without painting another scope.
  const handleRecordsPatch = useCallback((patch: import('@otis/contracts').RecordsPatch) => {
    const target = patch.draft;
    const matchesOpen = target.mode === 'draft' && target.draft_id === draft.draftId && target.generation === draft.generation;
    if (!matchesOpen) {
      setPatchReviews((prev) => (prev.some((p) => p.patch_id === patch.patch_id) ? prev : [...prev, patch]));
      return;
    }
    // Merge onto the authoritative base: attach saved preconditions so the
    // later manual save still conflicts honestly, and drop anything invalid.
    const staged = mergeRecordsPatch(draft.rows, patch.operations);
    if (staged.length > 0) {
      draft.stageOps(`Otis proposal (${staged.length})`, staged);
      toast.success(`Otis proposed ${staged.length} edit${staged.length === 1 ? '' : 's'} — review, then Save.`);
    }
    setPatchReviews((prev) => prev.filter((p) => p.patch_id !== patch.patch_id));
  }, [draft]);
  const [skippedNotice, setSkippedNotice] = useState<string | null>(null);
  const skippedTimer = useRef<number | null>(null);
  const flagSkipped = useCallback((count: number, what: string) => {
    setSkippedNotice(`${count} ${what} need${count === 1 ? 's' : ''} the row form and ${count === 1 ? 'was' : 'were'} kept unchanged.`);
    if (skippedTimer.current !== null) window.clearTimeout(skippedTimer.current);
    skippedTimer.current = window.setTimeout(() => setSkippedNotice(null), 5000);
  }, []);

  const stageGridEdits = useCallback((label: string, edits: GridCellEdit[]) => {
    const ops: RecordEdit[] = edits.map((edit) => ({
      op: 'cell.set',
      op_id: `op_cell_${edit.rowId}_${edit.columnId}`,
      row_ref: refOfRow(edit.rowId),
      column_id: edit.columnId,
      value: edit.text,
      base_token: baseVersions.get(`${edit.rowId}:${edit.columnId}`),
    }));
    draft.stageOps(label, ops);
  }, [draft, refOfRow, baseVersions]);

  const handleGridClear = useCallback((cells: GridCellEdit[]) => {
    const ops: RecordEdit[] = cells.map((edit) => ({
      op: 'cell.clear',
      op_id: `op_cell_${edit.rowId}_${edit.columnId}`,
      row_ref: refOfRow(edit.rowId),
      column_id: edit.columnId,
      base_token: baseVersions.get(`${edit.rowId}:${edit.columnId}`),
    }));
    draft.stageOps(`Clear ${cells.length} cells`, ops);
  }, [draft, refOfRow, baseVersions]);

  const listKind = listKindOf(activeServerList?.source_kind, 'custom');

  const handleGridPaste = useCallback((startRowIndex: number, startColumnId: string, values: string[][]) => {
    const plan = planPaste(
      visibleColumns,
      filteredRows.map((r) => r.id),
      startRowIndex,
      startColumnId,
      values,
      {
        makeRowId: () => `row_${crypto.randomUUID()}`,
        listKind,
        listId: activeListId,
        refOf: (rowId, isNew) => (isNew ? { kind: listKind, id: rowId } : refOfRow(rowId)),
        baseOf: (rowId, columnId) => baseVersions.get(`${rowId}:${columnId}`),
      },
    );
    if (plan.ops.length > 0) {
      draft.stageOps(`Paste ${values.length} rows`, plan.ops);
    }
    if (plan.reviewRows.length > 0) {
      setPasteReview({ rows: plan.reviewRows });
    }
    if (plan.skippedStructured > 0) flagSkipped(plan.skippedStructured, 'structured cells');
  }, [visibleColumns, filteredRows, listKind, activeListId, refOfRow, baseVersions, draft, flagSkipped]);

  const handleCellChange = useCallback((rowId: string, columnId: string, next: string) => {
    const column = columnById.get(columnId);
    if (next === '') {
      draft.clearCell(refOfRow(rowId), columnId);
      return;
    }
    draft.setCell(refOfRow(rowId), columnId, column ? parseTextInput(column, next) : next);
  }, [columnById, draft, refOfRow]);

  const handleCellValue = useCallback((rowId: string, columnId: string, next: RecordValue) => {
    draft.setCell(refOfRow(rowId), columnId, next);
  }, [draft, refOfRow]);

  const handleAddRow = useCallback(() => {
    const kind = listKindOf(activeServerList?.source_kind, 'custom');
    draft.createRow(kind);
  }, [activeServerList?.source_kind, draft]);

  const handleDeleteRow = useCallback((rowId: string) => {
    draft.removeRow(refOfRow(rowId));
    setSelectedRowForEditor((prev) => (prev?.id === rowId ? null : prev));
  }, [draft, refOfRow]);

  const handleAddColumn = useCallback((label: string, type: RecordFieldType) => {
    const fieldId = draft.createField(label, type);
    setIsAddColumnOpen(false);
    // A retained paste review lands its first kept value per row into the
    // new column as one more group, instead of vanishing with the dialog.
    if (pasteReview) {
      const fillOps: RecordEdit[] = [];
      for (const entry of pasteReview.rows) {
        const first = entry.values.find((text) => text.trim() !== '');
        if (first === undefined) continue;
        fillOps.push({
          op: 'cell.set',
          op_id: `op_cell_${entry.rowId}_${fieldId}`,
          row_ref: refOfRow(entry.rowId),
          column_id: fieldId,
          value: first,
        });
      }
      if (fillOps.length > 0) draft.stageOps(`Fill new column ${label}`, fillOps);
      setPasteReview(null);
    }
  }, [draft, refOfRow, pasteReview]);

  const handleCreateList = useCallback((name: string) => {
    const listId = draft.createList(name);
    setIsAddListOpen(false);
    setActiveListId(listId);
    props.onNavigateToList?.(props.workspaceId, listId);
  }, [draft, props]);

  const invalidateRecords = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['otis', props.userId, props.workspaceId, 'records'] });
    setExtraRows([]);
    setExtraCursor(undefined);
  }, [queryClient, props.userId, props.workspaceId]);

  const handleSave = useCallback(async (manifestOverride?: SaveManifest) => {
    const manifest = manifestOverride ?? draft.beginSave();
    if (!manifest) return;
    setSavedMessage(null);
    try {
      const res = await api.saveRecords(props.workspaceId, {
        schema_version: 1,
        save_id: manifest.saveId,
        action_id: manifest.actionId,
        chunk_index: 0,
        chunk_count: 1,
        list_id: activeListId,
        operations: manifest.operations,
      });
      if (res.status === 'applied' || res.status === 'already_applied') {
        draft.ackSave(manifest, res);
        invalidateRecords();
        const count = res.affected_count ?? manifest.operations.length;
        setSavedMessage(count === 0 ? 'Already saved. No changes to apply.' : `Saved ${count} change${count === 1 ? '' : 's'} to workspace memory.`);
        window.setTimeout(() => setSavedMessage(null), 4000);
      } else if (res.status === 'conflict') {
        const first = res.conflicts?.[0];
        draft.setConflict({
          opId: first?.op_id ?? null,
          message: first?.message ?? 'Another edit landed first. Review both values, then keep yours or take the saved one.',
          currentValue: first?.current_value,
        });
        invalidateRecords();
      } else {
        draft.failSave(manifest, 'The save was rejected and nothing changed. Your draft is intact.', false);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          const detail = err.details as { op_id?: string; current_token?: string; reason?: string } | string | undefined;
          draft.setConflict({
            opId: typeof detail === 'object' && detail?.op_id ? String(detail.op_id) : null,
            message: err.message,
          });
          invalidateRecords();
        } else {
          draft.failSave(manifest, err.message || 'The save failed and nothing changed. Your draft is intact.', false);
        }
      } else {
        // Network loss, timeout, or abort: the commit outcome is unknown, so
        // the exact manifest is retained for an identical retry.
        draft.failSave(
          manifest,
          'The save response was lost, so it may or may not have committed. Retry with the same save, or refresh to check first.',
          true,
        );
      }
    }
  }, [draft, props.workspaceId, activeListId, invalidateRecords]);

  const handleRetryUnknown = useCallback(() => {
    const status = draft.saveStatus;
    if (status.status === 'unknown') {
      void handleSave(status.manifest);
    }
  }, [draft.saveStatus, handleSave]);

  const handleLoadMore = useCallback(async () => {
    const cursor = extraCursor === undefined ? activeServerList?.next_cursor ?? null : extraCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.getRecords(props.workspaceId, {
        list_id: activeListId,
        search: search || undefined,
        sort: { column_id: sort.column, direction: sort.dir },
        cursor,
        limit: PAGE_LIMIT,
      }, undefined);
      const list = page.lists.find((l) => l.id === activeListId);
      if (list) {
        setExtraRows((prev) => {
          const known = new Set(prev.map((r) => r.id));
          return [...prev, ...list.rows.filter((r) => !known.has(r.id))];
        });
        setExtraCursor(list.next_cursor ?? null);
      } else {
        setExtraCursor(null);
      }
    } catch {
      toast.error('Could not load more rows');
    } finally {
      setLoadingMore(false);
    }
  }, [extraCursor, activeServerList?.next_cursor, loadingMore, props.workspaceId, activeListId, search, sort, activeListId]);

  const loadMoreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const sentinel = loadMoreRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) void handleLoadMore();
    }, { rootMargin: '400px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [handleLoadMore, filteredRows.length]);

  const handleCopySelection = useCallback(async () => {
    const selected = filteredRows.filter((r) => selectedIds.includes(r.id));
    if (selected.length === 0) return;
    const header = visibleColumns.map((c) => c.name).join('\t');
    const lines = selected.map((row) => visibleColumns.map((c) => String(row.cells[c.id] ?? '')).join('\t'));
    const tsv = [header, ...lines].join('\n');
    setCopying(true);
    try {
      await navigator.clipboard.writeText(tsv);
      setCopyFeedback('Copied');
    } catch {
      setCopyFeedback('Copy failed');
    } finally {
      setCopying(false);
      window.setTimeout(() => setCopyFeedback(null), 2500);
    }
  }, [filteredRows, selectedIds, visibleColumns]);

  const handleRemoveSelection = useCallback(() => {
    for (const id of selectedIds) {
      const row = filteredRows.find((r) => r.id === id);
      if (row) draft.removeRow(row.ref ?? { kind: listKindOf(activeServerList?.source_kind, 'custom'), id });
    }
    setSelectedIds([]);
  }, [selectedIds, filteredRows, draft, activeServerList?.source_kind]);

  const handleRestoreVersion = useCallback(async (historyId: string) => {
    if (undoingId) return;
    setUndoingId(historyId);
    try {
      const preview = await api.undoPreview(props.workspaceId, historyId, 'single');
      const changes = [
        ...preview.preview.affected_entities.flatMap((e) => e.changes),
        ...preview.preview.affected_tasks.flatMap((t) => t.changes),
        ...(preview.preview.affected_context ?? []).flatMap((c) => c.changes),
      ].slice(0, 4);
      const proceed = window.confirm(
        `Undo this saved change?${changes.length > 0 ? `\n\n${changes.join('\n')}` : ''}`,
      );
      if (!proceed) return;
      const committed = await api.undo(props.workspaceId, historyId, {
        mode: 'single',
        clientOperationId: `cop_rec_${crypto.randomUUID()}`,
        expectedRevision: preview.preview.expected_revision,
      });
      if (committed.status === 'applied' || committed.status === 'already_applied') {
        setIsHistoryOpen(false);
        invalidateRecords();
        toast.success('Saved change undone');
      } else {
        toast.error(committed.error?.message ?? 'Could not undo this change');
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not undo this change');
    } finally {
      setUndoingId(null);
    }
  }, [props.workspaceId, invalidateRecords, undoingId]);

  // Scoped shortcuts: Ctrl/Cmd+S saves, Ctrl/Cmd+Z/Y undo/redo the draft.
  // Native text undo keeps working inside inputs and textareas. The window
  // listener only acts when focus sits inside this screen's grid region, so
  // composer and dialog inputs elsewhere keep their own keys.
  const draftRef = useRef(draft);
  const saveRef = useRef(handleSave);
  useEffect(() => {
    draftRef.current = draft;
    saveRef.current = handleSave;
  });
  useEffect(() => {
    const region = gridRegionRef.current;
    if (!region) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || !region.contains(document.activeElement)) return;
      const target = event.target as HTMLElement | null;
      const inTextInput = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        if (draftRef.current.dirtyCount > 0) {
          (document.activeElement as HTMLElement | null)?.blur?.();
          window.setTimeout(() => void saveRef.current(), 0);
        }
      } else if ((key === 'z' || key === 'y') && !inTextInput) {
        event.preventDefault();
        if (key === 'z' && !event.shiftKey) draftRef.current.undo();
        else draftRef.current.redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Navigation & supporting panes (unchanged production behavior)
  const mineQuery = useNavChats(props.userId, props.workspaceId, 'mine', false);
  const teamQuery = useNavChats(props.userId, props.workspaceId, 'team', false);
  const ownChats = useMemo(() => mineQuery.data?.chats ?? [], [mineQuery.data]);
  const teamChats = useMemo(
    () => (teamQuery.data?.chats ?? []).filter((chat) => chat.author_user_id !== props.userId),
    [teamQuery.data, props.userId],
  );
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renamingChat, setRenamingChat] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [deletingChat, setDeletingChat] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [creatingWs, setCreatingWs] = useState(false);

  const handleSidebarNavigate = useCallback((ws: string, nextChat: string | null) => {
    if (ws !== props.workspaceId) props.onNavigate(ws, nextChat);
    else setSidebarChatId(nextChat);
  }, [props]);

  const handleConfirmRename = useCallback(async () => {
    if (!renameTarget || renamingChat) return;
    const trimmed = renameTitle.trim();
    if (!trimmed) return;
    setRenamingChat(true);
    try {
      await api.renameChat(props.workspaceId, renameTarget.id, trimmed);
      void queryClient.invalidateQueries({ queryKey: qk.chats(props.userId, props.workspaceId, 'mine') });
      void queryClient.invalidateQueries({ queryKey: qk.chat(props.userId, props.workspaceId, renameTarget.id) });
      toast.success('Conversation renamed');
      setRenameTarget(null);
    } catch {
      toast.error('Could not rename conversation');
    } finally {
      setRenamingChat(false);
    }
  }, [renameTarget, renamingChat, renameTitle, props.workspaceId, props.userId, queryClient]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget || deletingChat) return;
    setDeletingChat(true);
    try {
      await api.deleteChat(props.workspaceId, deleteTarget.id);
      void queryClient.invalidateQueries({ queryKey: qk.chats(props.userId, props.workspaceId, 'mine') });
      void queryClient.invalidateQueries({ queryKey: qk.chats(props.userId, props.workspaceId, 'team') });
      toast.success('Conversation deleted');
      setDeleteTarget(null);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || deleteTarget.id.startsWith('new-'))) {
        void queryClient.invalidateQueries({ queryKey: qk.chats(props.userId, props.workspaceId, 'mine') });
        void queryClient.invalidateQueries({ queryKey: qk.chats(props.userId, props.workspaceId, 'team') });
        toast.success('Conversation deleted');
        setDeleteTarget(null);
      } else {
        toast.error('Could not delete conversation');
      }
    } finally {
      setDeletingChat(false);
    }
  }, [deleteTarget, deletingChat, props.workspaceId, props.userId, queryClient]);

  const handleConfirmCreateWorkspace = useCallback(async () => {
    const trimmed = newWorkspaceName.trim();
    if (!trimmed || creatingWs) return;
    setCreatingWs(true);
    try {
      const result = await api.createWorkspace(trimmed);
      await props.onRefreshSession?.();
      props.onNavigate(result.workspace.id, null);
      toast.success('Workspace created');
      setCreateWorkspaceOpen(false);
    } catch {
      toast.error('Could not create workspace');
    } finally {
      setCreatingWs(false);
    }
  }, [newWorkspaceName, creatingWs, props]);

  const navProps = {
    userId: props.userId,
    workspaceName: props.workspaces.find((w) => w.id === props.workspaceId)?.name ?? 'Workspace',
    workspaces: props.workspaces,
    workspaceId: props.workspaceId,
    ownChats,
    teamChats,
    activeChatId: null,
    members: props.members,
    isRecordsActive: true,
    loading: mineQuery.isPending || teamQuery.isPending,
    hasMore: Boolean(mineQuery.data?.nextCursor || teamQuery.data?.nextCursor),
    onLoadMore: async () => {
      if (mineQuery.data?.nextCursor) await fetchMoreChats(queryClient, props.userId, props.workspaceId, 'mine');
      if (teamQuery.data?.nextCursor) await fetchMoreChats(queryClient, props.userId, props.workspaceId, 'team');
    },
    onSelectChat: (chatId: string) => {
      setIsNavDrawerOpen(false);
      props.onNavigate(props.workspaceId, chatId);
    },
    onNewChat: () => {
      setIsNavDrawerOpen(false);
      props.onNavigate(props.workspaceId, null);
    },
    onOpenRecords: () => {
      setIsNavDrawerOpen(false);
    },
    onSwitchWorkspace: (id: string) => {
      setIsNavDrawerOpen(false);
      props.onNavigate(id, null);
    },
    onOpenSettings: () => {
      setIsNavDrawerOpen(false);
      setSettingsOpen(true);
    },
    onOpenSearch: () => {
      setIsNavDrawerOpen(false);
      setIsUnifiedSearchOpen(true);
    },
    onRenameChat: (chatId: string, currentTitle: string) => {
      setRenameTarget({ id: chatId, title: currentTitle });
      setRenameTitle(currentTitle);
    },
    onDeleteChat: (chatId: string, currentTitle: string) => {
      setDeleteTarget({ id: chatId, title: currentTitle });
    },
    onCreateWorkspace: () => {
      setNewWorkspaceName('');
      setCreateWorkspaceOpen(true);
    },
  };

  const saveStatus = draft.saveStatus;
  const activeList = activeServerList;
  const listTotal = activeList?.total_rows ?? null;

  // Frozen records target for assistant turns composed beside the grid.
  // Called once per send: the target, selection, and delta travel with the
  // accepted input and never shift under navigation, retry, or later saves.
  const recordsContextProvider = useCallback((): import('@otis/contracts').RecordsContext | null => {
    const selectedRefs = selectedIds
      .map((id) => draft.rows.find((r) => r.id === id)?.ref)
      .filter((ref): ref is RecordRef => !!ref);
    return buildRecordsContext({
      listId: activeListId,
      draftId: draft.draftId,
      generation: draft.generation,
      dirty: draft.dirtyCount > 0,
      selectedRows: selectedRefs,
      visibleRows: filteredRows.map((row) => row.ref ?? { kind: listKindOf(activeServerList?.source_kind, 'custom'), id: row.id }),
      columnIds: visibleColumns.map((c) => c.id),
      search,
      sort: { column_id: sort.column, direction: sort.dir },
      operations: draft.ops,
    });
  }, [selectedIds, draft, filteredRows, visibleColumns, activeListId, activeServerList?.source_kind, search, sort]);

  return (
    <div className="otis-shell h-dvh bg-background text-foreground flex">
      <Toaster theme="dark" position="top-center" visibleToasts={2} closeButton toastOptions={{ className: 'otis-toast', duration: 3000 }} offset={64} />
      <HistoryNav variant="sidebar" {...navProps} />
      <HistoryNav variant="drawer" open={isNavDrawerOpen} {...navProps} onClose={() => setIsNavDrawerOpen(false)} />

      <main id="main-content" className="otis-main flex flex-1 flex-col min-w-0 h-full overflow-hidden">
        <header className="otis-topbar flex h-12 items-center justify-between border-b border-border px-4 bg-background shrink-0">
          <div className="otis-topbar__identity flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              type="button"
              className="otis-iconbutton otis-topbar__menu md:hidden"
              aria-label="Open navigation menu"
              aria-expanded={isNavDrawerOpen}
              onClick={() => setIsNavDrawerOpen(true)}
            >
              <MenuIcon />
            </Button>
            <span className="otis-wordmark text-base text-foreground tracking-tight">Your information</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" type="button" className="h-8 gap-2 font-medium text-sm">
                  <span className="truncate">{activeList?.name ?? 'Lists'}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="bottom">
                {allLists.map((list) => (
                  <DropdownMenuItem
                    key={list.id}
                    onSelect={() => {
                      setActiveListId(list.id);
                      props.onNavigateToList?.(props.workspaceId, list.id);
                    }}
                    className={list.id === activeListId ? 'bg-accent' : ''}
                  >
                    <span className="flex-1 font-medium">{list.name}</span>
                    {typeof list.total === 'number' && (
                      <span className="text-xs text-subtle">{list.total} rows</span>
                    )}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setIsAddListOpen(true)} className="gap-2">
                  <span>Create new list</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="otis-topbar__subtitle text-xs text-subtle hidden sm:inline">
              {typeof listTotal === 'number' ? `${filteredRows.length} of ${listTotal}` : `${filteredRows.length} rows`}
            </span>
          </div>

          <div className="otis-topbar__actions flex items-center gap-2">
            <Button
              variant={isAskOtisOpen ? 'secondary' : 'ghost'}
              size="sm"
              type="button"
              className="gap-2 text-xs font-medium"
              onClick={() => setIsAskOtisOpen((prev) => !prev)}
              aria-expanded={isAskOtisOpen}
            >
              <SparklesIcon />
              <span>Ask Otis</span>
            </Button>
          </div>
        </header>

        <RecordsControlBar
          lists={allLists}
          activeListId={activeListId}
          onSelectList={(id) => {
            setActiveListId(id);
            props.onNavigateToList?.(props.workspaceId, id);
          }}
          onOpenNewList={() => setIsAddListOpen(true)}
          searchQuery={searchInput}
          onSearchChange={setSearchInput}
          searching={searchInput.trim() !== search}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          sort={sort}
          sortOptions={SORT_OPTIONS[activeListId] ?? SORT_OPTIONS['leads']!}
          onSortChange={(column, dir) => setSorts((prev) => ({ ...prev, [activeListId]: { column, dir } }))}
          viewMode={viewMode}
          onToggleViewMode={() => setViewMode((prev) => (prev === 'grid' ? 'cards' : 'grid'))}
          columns={draft.columns}
          hiddenColumns={hiddenColumns}
          onToggleColumn={(id) => setHiddenColumns((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })}
          onOpenAddColumn={() => setIsAddColumnOpen(true)}
          onAddRow={handleAddRow}
          selectionCount={selectedIds.length}
          onCopySelection={() => void handleCopySelection()}
          onRemoveSelection={handleRemoveSelection}
          onClearSelection={() => setSelectedIds([])}
          copying={copying}
          copyFeedback={copyFeedback}
          onOpenHistory={() => setIsHistoryOpen(true)}
          onOpenDuplicates={() => setIsDuplicatesOpen(true)}
          onRefresh={() => invalidateRecords()}
          isRefreshing={recordsQuery.isFetching}
        />

        <RecordsEditBar
          dirtyCount={draft.dirtyCount}
          canUndo={draft.canUndo}
          canRedo={draft.canRedo}
          onUndo={draft.undo}
          onRedo={draft.redo}
          onDiscard={draft.discard}
          onSave={() => void handleSave()}
          saving={saveStatus.status === 'saving'}
          conflictMessage={saveStatus.status === 'conflict' ? saveStatus.info.message : null}
          onKeepMine={() => draft.clearConflict('keep-mine')}
          onUseSaved={() => draft.clearConflict('use-saved')}
          unknownOutcome={saveStatus.status === 'unknown' ? saveStatus.message : null}
          onRetrySave={handleRetryUnknown}
          errorMessage={saveStatus.status === 'error' ? saveStatus.message : null}
          savedMessage={savedMessage}
          onDismissSaved={() => setSavedMessage(null)}
        />
        {!draft.storageDurable && draft.dirtyCount > 0 && (
          <p role="note" className="px-4 py-1 text-xs text-subtle border-b border-border shrink-0">
            Draft recovery is limited to this tab on this device.
          </p>
        )}
        {skippedNotice && (
          <p role="status" className="px-4 py-1 text-xs text-subtle border-b border-border shrink-0">
            {skippedNotice}
          </p>
        )}
        {pasteReview && (
          <div role="alert" className="flex flex-wrap items-center gap-2 px-4 py-2 bg-warning/10 border-b border-border text-xs shrink-0">
            <span className="flex-1 min-w-40 font-medium">
              Pasted values extended beyond the last column and were kept for review, not clipped.
            </span>
            <Button variant="default" size="sm" onClick={() => setIsAddColumnOpen(true)} className="h-6 px-2 text-xs">
              Create column for them
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPasteReview(null)} className="h-6 px-2 text-xs">
              Discard
            </Button>
          </div>
        )}
        {patchReviews.map((patch) => (
          <div key={patch.patch_id} role="status" className="flex flex-wrap items-center gap-2 px-4 py-2 bg-card border-b border-border text-xs shrink-0">
            <span className="flex-1 min-w-40">
              <span className="font-medium">Otis proposed {patch.op_count} edit{patch.op_count === 1 ? '' : 's'}</span>
              <span className="text-subtle"> for another draft state — nothing was painted here. </span>
              <span className="text-subtle">{describePatchOps(patch.operations)}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => setPatchReviews((prev) => prev.filter((p) => p.patch_id !== patch.patch_id))} className="h-6 px-2 text-xs">
              Dismiss
            </Button>
          </div>
        ))}

        <div className="flex flex-1 min-h-0 overflow-hidden relative" ref={gridRegionRef}>
          <div className="flex-1 min-w-0 h-full overflow-hidden flex flex-col">
            {recordsQuery.isPending ? (
              <div role="status" className="p-4 text-xs text-subtle">Loading saved information…</div>
            ) : recordsQuery.isError ? (
              <div role="alert" className="flex flex-col items-start gap-2 p-4">
                <p className="text-xs font-medium">Could not load these records. Your saved data is unchanged.</p>
                <Button variant="outline" size="sm" type="button" onClick={() => void recordsQuery.refetch()}>
                  Retry
                </Button>
              </div>
            ) : !activeList ? (
              <div role="status" className="flex flex-col items-start gap-2 p-4">
                <p className="text-xs font-medium">No information lists yet.</p>
                <Button variant="outline" size="sm" type="button" onClick={() => setIsAddListOpen(true)}>
                  Create a list
                </Button>
              </div>
            ) : (
              <>
                {pinnedRows.length > 0 && (
                  <div className="px-4 pt-2 shrink-0">
                    <p className="text-xs text-subtle">
                      {pinnedRows.length} changed {pinnedRows.length === 1 ? 'row stays' : 'rows stay'} visible while searching.
                    </p>
                  </div>
                )}
                {viewMode === 'grid' && canUseCanvasGrid() ? (
                  <GridErrorBoundary
                    fallback={
                      <RecordsTable
                        columns={visibleColumns}
                        rows={[...pinnedRows, ...filteredRows]}
                        dirtyCells={dirtyCells}
                        onCellChange={handleCellChange}
                        onDeleteRow={handleDeleteRow}
                        onSortColumn={(columnId, direction) => setSorts((prev) => ({ ...prev, [activeListId]: { column: columnId, dir: direction } }))}
                        onHideColumn={(id) => setHiddenColumns((prev) => new Set(prev).add(id))}
                        onSelectRow={(rowId) => {
                          const row = draft.rows.find((r) => r.id === rowId);
                          if (row) setSelectedRowForEditor(row);
                        }}
                        onSelectionChange={setSelectedIds}
                      />
                    }
                  >
                    <Suspense fallback={<div role="status" className="p-4 text-xs text-subtle">Loading spreadsheet…</div>}>
                      <RecordsGridLazy
                        columns={visibleColumns}
                        rows={[...pinnedRows, ...filteredRows]}
                        onCellsEdited={(edits) => stageGridEdits(`Edit ${edits.length} cells`, edits)}
                        onCellsCleared={handleGridClear}
                        onSkippedReadonly={(count) => flagSkipped(count, 'structured cells')}
                        onPasteAt={handleGridPaste}
                        onFillRange={(edits) => stageGridEdits(`Fill ${edits.length} cells`, edits)}
                        onAppendRow={handleAddRow}
                        onOpenRow={(rowId) => {
                          const row = draft.rows.find((r) => r.id === rowId);
                          if (row) setSelectedRowForEditor(row);
                        }}
                        onSortColumn={(columnId, direction) => setSorts((prev) => ({ ...prev, [activeListId]: { column: columnId, dir: direction } }))}
                        onHideColumn={(id) => setHiddenColumns((prev) => new Set(prev).add(id))}
                        onRenameColumn={(columnId, label) => draft.updateField(columnId, label)}
                        onRemoveColumn={(columnId) => draft.archiveField(columnId)}
                        onSelectionChange={setSelectedIds}
                        onColumnWidth={(columnId, width) => setColumnWidths((prev) => ({ ...prev, [columnId]: width }))}
                        onColumnOrder={(order) => setColumnOrder(order)}
                        columnWidths={columnWidths}
                      />
                    </Suspense>
                  </GridErrorBoundary>
                ) : viewMode === 'grid' ? (
                  <RecordsTable
                    columns={visibleColumns}
                    rows={[...pinnedRows, ...filteredRows]}
                    dirtyCells={dirtyCells}
                    onCellChange={handleCellChange}
                    onDeleteRow={handleDeleteRow}
                    onSortColumn={(columnId, direction) => setSorts((prev) => ({ ...prev, [activeListId]: { column: columnId, dir: direction } }))}
                    onHideColumn={(id) => setHiddenColumns((prev) => new Set(prev).add(id))}
                    onSelectRow={(rowId) => {
                      const row = draft.rows.find((r) => r.id === rowId);
                      if (row) setSelectedRowForEditor(row);
                    }}
                    onSelectionChange={setSelectedIds}
                  />
                ) : (
                  <RecordRowList
                    rows={[...pinnedRows, ...filteredRows]}
                    columns={visibleColumns}
                    dirtyCells={dirtyCells}
                    onSelectRow={(rowId) => {
                      const row = draft.rows.find((r) => r.id === rowId);
                      if (row) setSelectedRowForEditor(row);
                    }}
                    onAddRow={handleAddRow}
                  />
                )}
                <div ref={loadMoreRef} aria-hidden="true" className="h-1 shrink-0" />
                {loadingMore && (
                  <p role="status" className="px-4 py-1 text-xs text-subtle shrink-0">Loading more rows…</p>
                )}
              </>
            )}
          </div>

          {isAskOtisOpen && activeList && (
            <div className="hidden lg:block w-96 h-full border-l border-border bg-card shrink-0">
              <AskOtisPane
                list={activeList}
                dirtyCount={draft.dirtyCount}
                focusedRow={selectedRowForEditor}
                onClose={() => setIsAskOtisOpen(false)}
                recordsContextProvider={recordsContextProvider}
                workspaceId={props.workspaceId}
                userId={props.userId}
                members={props.members}
                workspaces={props.workspaces}
                onSignOut={props.onSignOut}
                onNavigate={handleSidebarNavigate}
                onRefreshSession={props.onRefreshSession}
                chatId={sidebarChatId}
                onSelectChat={setSidebarChatId}
                suggestedDraft={suggestedQuestion}
                onRecordsPatch={handleRecordsPatch}
              />
            </div>
          )}
        </div>
      </main>

      <RecordRowEditor
        workspaceId={props.workspaceId}
        userId={props.userId}
        onOpenChat={(id) => props.onNavigate(props.workspaceId, id)}
        open={Boolean(selectedRowForEditor)}
        row={selectedRowForEditor}
        columns={visibleColumns}
        dirtyCells={dirtyCells}
        onClose={() => setSelectedRowForEditor(null)}
        onCellChange={handleCellChange}
        onCellValue={handleCellValue}
        onDeleteRow={handleDeleteRow}
        dirtyCount={draft.dirtyCount}
        onSave={() => void handleSave()}
        isSaving={saveStatus.status === 'saving'}
        onAskOtisAboutRow={(row, question) => {
          setSuggestedQuestion(question ?? `Show me everything on ${row.cells.name ?? row.id}. Read the saved client file and include sources. Client reference: ${row.id}`);
          setSelectedRowForEditor(null);
          setIsAskOtisOpen(true);
        }}
      />

      <AddColumnDialog
        open={isAddColumnOpen}
        onClose={() => setIsAddColumnOpen(false)}
        onAddColumn={handleAddColumn}
      />

      <AddListDialog
        open={isAddListOpen}
        onClose={() => setIsAddListOpen(false)}
        onCreateList={handleCreateList}
      />

      <RecordsHistorySheet
        open={isHistoryOpen}
        history={history[activeListId] ?? []}
        onClose={() => setIsHistoryOpen(false)}
        onRestore={(historyId) => void handleRestoreVersion(historyId)}
      />

      {isAskOtisOpen && activeList && (
        <div className="lg:hidden fixed inset-0 z-50 flex flex-col justify-end bg-background/80">
          <div className="bg-card border-t border-border h-3/4 flex flex-col rounded-t-xl overflow-hidden shadow-popover">
            <AskOtisPane
              list={activeList}
              dirtyCount={draft.dirtyCount}
              focusedRow={selectedRowForEditor}
              onClose={() => setIsAskOtisOpen(false)}
              recordsContextProvider={recordsContextProvider}
              workspaceId={props.workspaceId}
              userId={props.userId}
              members={props.members}
              workspaces={props.workspaces}
              onSignOut={props.onSignOut}
              onNavigate={handleSidebarNavigate}
              onRefreshSession={props.onRefreshSession}
              chatId={sidebarChatId}
              onSelectChat={setSidebarChatId}
              suggestedDraft={suggestedQuestion}
              onRecordsPatch={handleRecordsPatch}
            />
          </div>
        </div>
      )}

      {settingsOpen && (
        <SettingsPane
          workspaceId={props.workspaceId}
          workspaceName={props.workspaces.find((w) => w.id === props.workspaceId)?.name ?? 'Workspace'}
          members={props.members}
          currentUserId={props.userId}
          currentUserRole={(props.workspaces.find((w) => w.id === props.workspaceId)?.role as 'owner' | 'member') ?? 'owner'}
          onClose={() => setSettingsOpen(false)}
          onSignOut={props.onSignOut}
          onWorkspaceCreated={(id) => props.onNavigate(id, null)}
        />
      )}

      {renameTarget && (
        <Overlay label="Rename conversation" className="otis-overlay--dialog" onClose={() => setRenameTarget(null)}>
          <div className="otis-dialog-card">
            <header className="otis-dialog-card__header">
              <h2 className="text-base font-medium">Rename conversation</h2>
              <Button variant="ghost" size="icon" type="button" className="otis-iconbutton" aria-label="Close" onClick={() => setRenameTarget(null)}>
                <CloseIcon />
              </Button>
            </header>
            <form className="otis-dialog-card__body" onSubmit={(e) => { e.preventDefault(); void handleConfirmRename(); }}>
              <div>
                <label htmlFor="rename-chat-input" className="text-sm font-medium">Conversation title</label>
                <Input
                  id="rename-chat-input"
                  value={renameTitle}
                  onChange={(e) => setRenameTitle(e.target.value)}
                  className="mt-1"
                />
              </div>
              <footer className="otis-dialog-card__footer">
                <Button variant="ghost" size="sm" type="button" onClick={() => setRenameTarget(null)}>Cancel</Button>
                <Button size="sm" type="submit" disabled={renamingChat || !renameTitle.trim()}>{renamingChat ? 'Saving…' : 'Save'}</Button>
              </footer>
            </form>
          </div>
        </Overlay>
      )}

      {deleteTarget && (
        <Overlay label="Delete conversation" className="otis-overlay--dialog" onClose={() => setDeleteTarget(null)}>
          <div className="otis-dialog-card">
            <header className="otis-dialog-card__header">
              <h2 className="text-base font-medium">Delete conversation</h2>
              <Button variant="ghost" size="icon" type="button" className="otis-iconbutton" aria-label="Close" onClick={() => setDeleteTarget(null)}>
                <CloseIcon />
              </Button>
            </header>
            <div className="otis-dialog-card__body">
              <p className="text-sm text-muted-foreground">Are you sure you want to delete &ldquo;{deleteTarget.title || 'Untitled conversation'}&rdquo;? This conversation cannot be restored.</p>
              <footer className="otis-dialog-card__footer">
                <Button variant="ghost" size="sm" type="button" onClick={() => setDeleteTarget(null)}>Cancel</Button>
                <Button variant="destructive" size="sm" type="button" disabled={deletingChat} onClick={() => void handleConfirmDelete()}>{deletingChat ? 'Deleting…' : 'Delete'}</Button>
              </footer>
            </div>
          </div>
        </Overlay>
      )}

      {createWorkspaceOpen && (
        <Overlay label="Create workspace" className="otis-overlay--dialog" onClose={() => setCreateWorkspaceOpen(false)}>
          <div className="otis-dialog-card">
            <header className="otis-dialog-card__header">
              <h2 className="text-base font-medium">Create workspace</h2>
              <Button variant="ghost" size="icon" type="button" className="otis-iconbutton" aria-label="Close" onClick={() => setCreateWorkspaceOpen(false)}>
                <CloseIcon />
              </Button>
            </header>
            <form className="otis-dialog-card__body" onSubmit={(e) => { e.preventDefault(); void handleConfirmCreateWorkspace(); }}>
              <div>
                <label htmlFor="new-ws-input" className="text-sm font-medium">Workspace name</label>
                <Input
                  id="new-ws-input"
                  value={newWorkspaceName}
                  onChange={(e) => setNewWorkspaceName(e.target.value)}
                  placeholder="e.g. Acme Studio"
                  className="mt-1"
                />
              </div>
              <footer className="otis-dialog-card__footer">
                <Button variant="ghost" size="sm" type="button" onClick={() => setCreateWorkspaceOpen(false)}>Cancel</Button>
                <Button size="sm" type="submit" disabled={creatingWs || !newWorkspaceName.trim()}>{creatingWs ? 'Creating…' : 'Create'}</Button>
              </footer>
            </form>
          </div>
        </Overlay>
      )}

      <UnifiedSearchDialog
        open={isUnifiedSearchOpen}
        onClose={() => setIsUnifiedSearchOpen(false)}
        workspaceId={props.workspaceId}
        onSelectResult={(item) => {
          setIsUnifiedSearchOpen(false);
          if (item.category === 'chat') {
            props.onNavigate(props.workspaceId, item.chatId || item.id);
          } else if (item.category === 'entity') {
            const existingRow = draft.rows.find((r) => r.id === item.id);
            if (existingRow) {
              setSelectedRowForEditor(existingRow);
            } else {
              setSelectedRowForEditor({
                id: item.id,
                source: 'entity',
                cells: { name: item.title },
              });
            }
          } else if (item.category === 'task') {
            const existingRow = draft.rows.find((r) => r.id === item.id);
            if (existingRow) {
              setSelectedRowForEditor(existingRow);
            }
          }
        }}
      />

      <DuplicateMergeDialog
        open={isDuplicatesOpen}
        onClose={() => setIsDuplicatesOpen(false)}
        workspaceId={props.workspaceId}
        onMergeComplete={() => {
          invalidateRecords();
        }}
      />
    </div>
  );
}
