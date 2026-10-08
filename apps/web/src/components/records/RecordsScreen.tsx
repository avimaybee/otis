import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/button.js';
import { HistoryNav } from '../HistoryNav.js';
import { SparklesIcon, MenuIcon } from '../icons.js';
import { INITIAL_RECORD_LISTS } from './seedData.js';
import type {
  DirtyCellState,
  DraftOperation,
  RecordColumn,
  RecordList,
  RecordRow,
  RecordsDraft,
  RecordHistoryItem,
} from './types.js';
import { RecordsControlBar } from './RecordsControlBar.js';
import { RecordsTable } from './RecordsTable.js';
import { RecordRowList } from './RecordRowList.js';
import { RecordRowEditor } from './RecordRowEditor.js';
import { AddColumnDialog } from './AddColumnDialog.js';
import { AddListDialog } from './AddListDialog.js';
import { RecordsHistorySheet } from './RecordsHistorySheet.js';
import { AskOtisPane, type AskOtisMessage } from './AskOtisPane.js';

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
  initialLists?: RecordList[];
}

export function RecordsScreen(props: RecordsScreenProps) {
  const [lists, setLists] = useState<RecordList[]>(() => props.initialLists ?? INITIAL_RECORD_LISTS);
  const [activeListId, setActiveListId] = useState<string>(() => {
    if (props.listId && lists.some(item => item.id === props.listId)) {
      return props.listId;
    }
    return lists[0]?.id ?? 'leads';
  });

  // Keep active list in sync if props.listId updates externally
  useEffect(() => {
    if (props.listId && lists.some(item => item.id === props.listId)) {
      setActiveListId(props.listId);
    }
  }, [props.listId, lists]);

  const activeList = useMemo(() => {
    return lists.find(item => item.id === activeListId) ?? lists[0]!;
  }, [lists, activeListId]);

  // Draft state: changes not yet saved to D1 ledger
  const [draft, setDraft] = useState<RecordsDraft>({
    dirtyCells: {},
    addedRows: [],
    deletedRowIds: new Set<string>(),
    addedColumns: [],
    undoStack: [],
    redoStack: [],
  });

  // History entries per list
  const [historyItems, setHistoryItems] = useState<Record<string, RecordHistoryItem[]>>({
    leads: [
      {
        id: 'hist-1',
        timestamp: 'Today, 2:30 PM',
        actor: 'user',
        description: 'Updated phone and deal value for John Klakney',
        affectedCount: 2,
        canRestore: true,
      },
      {
        id: 'hist-2',
        timestamp: 'Yesterday',
        actor: 'otis',
        description: 'Extracted access gate code instructions from conversation',
        affectedCount: 3,
        canRestore: true,
      },
    ],
  });

  // Navigation & UI controls
  const [isNavDrawerOpen, setIsNavDrawerOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'cards'>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  // Sheets & dialogs
  const [selectedRowForEditor, setSelectedRowForEditor] = useState<RecordRow | null>(null);
  const [isAddColumnOpen, setIsAddColumnOpen] = useState(false);
  const [isAddListOpen, setIsAddListOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isAskOtisOpen, setIsAskOtisOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveBanner, setSaveBanner] = useState<string | null>(null);

  // Effective columns computation
  const effectiveColumns = useMemo(() => {
    return [...activeList.columns, ...draft.addedColumns];
  }, [activeList.columns, draft.addedColumns]);

  // Effective rows computation (active list + draft additions - draft deletions)
  const effectiveRows = useMemo(() => {
    const baseList = [
      ...activeList.rows.filter(row => !draft.deletedRowIds.has(row.id)),
      ...draft.addedRows,
    ];
    return baseList;
  }, [activeList.rows, draft.addedRows, draft.deletedRowIds]);

  // Filtered rows by search and status
  const filteredRows = useMemo(() => {
    let result = effectiveRows;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(row => {
        return Object.entries(row.cells).some(([, val]) => val.toLowerCase().includes(q));
      });
    }

    if (statusFilter) {
      result = result.filter(row => {
        const dirtyKey = `${row.id}:status`;
        const currentVal = draft.dirtyCells[dirtyKey]?.currentValue ?? row.cells['status'];
        return currentVal === statusFilter;
      });
    }

    return result;
  }, [effectiveRows, searchQuery, statusFilter, draft.dirtyCells]);

  // Total dirty count
  const dirtyCount = useMemo(() => {
    return (
      Object.keys(draft.dirtyCells).length +
      draft.addedRows.length +
      draft.deletedRowIds.size +
      draft.addedColumns.length
    );
  }, [draft.dirtyCells, draft.addedRows.length, draft.deletedRowIds.size, draft.addedColumns.length]);

  // Cell editing
  const handleCellChange = useCallback(
    (rowId: string, columnId: string, nextValue: string) => {
      setDraft(prev => {
        const cellKey = `${rowId}:${columnId}`;
        const targetRow = effectiveRows.find(r => r.id === rowId);
        const baseVal = targetRow?.cells[columnId] ?? '';

        const newDirty: DirtyCellState = {
          rowId,
          columnId,
          baseValue: baseVal,
          currentValue: nextValue,
          timestamp: Date.now(),
        };

        const op: DraftOperation = {
          type: 'cell_edit',
          rowId,
          columnId,
          prevValue: prev.dirtyCells[cellKey]?.currentValue ?? baseVal,
          nextValue,
        };

        return {
          ...prev,
          dirtyCells: {
            ...prev.dirtyCells,
            [cellKey]: newDirty,
          },
          undoStack: [...prev.undoStack, op],
          redoStack: [],
        };
      });
    },
    [effectiveRows],
  );

  // Add row
  const handleAddRow = useCallback(() => {
    const newId = `row-${Date.now()}`;
    const newRow: RecordRow = {
      id: newId,
      source: 'custom',
      cells: {
        name: 'New record',
      },
      provenance: { name: 'Created in draft' },
    };

    setDraft(prev => {
      const op: DraftOperation = { type: 'add_row', row: newRow };
      return {
        ...prev,
        addedRows: [newRow, ...prev.addedRows],
        undoStack: [...prev.undoStack, op],
        redoStack: [],
      };
    });
  }, []);

  // Delete row
  const handleDeleteRow = useCallback(
    (rowId: string) => {
      setDraft(prev => {
        const isAddedInDraft = prev.addedRows.find(r => r.id === rowId);
        const targetRow = effectiveRows.find(r => r.id === rowId);
        const nextDeleted = new Set(prev.deletedRowIds);
        nextDeleted.add(rowId);

        const op: DraftOperation = {
          type: 'delete_row',
          row: targetRow ?? { id: rowId, source: 'custom', cells: {} },
        };

        return {
          ...prev,
          addedRows: isAddedInDraft
            ? prev.addedRows.filter(r => r.id !== rowId)
            : prev.addedRows,
          deletedRowIds: isAddedInDraft ? prev.deletedRowIds : nextDeleted,
          undoStack: [...prev.undoStack, op],
          redoStack: [],
        };
      });

      if (selectedRowForEditor?.id === rowId) {
        setSelectedRowForEditor(null);
      }
    },
    [effectiveRows, selectedRowForEditor?.id],
  );

  // Add column
  const handleAddColumn = useCallback((col: RecordColumn) => {
    setDraft(prev => {
      const op: DraftOperation = { type: 'add_column', column: col };
      return {
        ...prev,
        addedColumns: [...prev.addedColumns, col],
        undoStack: [...prev.undoStack, op],
        redoStack: [],
      };
    });
  }, []);

  // Create list
  const handleCreateList = useCallback(
    (name: string, description?: string) => {
      const newListId = `list-${Date.now()}`;
      const newList: RecordList = {
        id: newListId,
        name,
        description,
        columns: [
          { id: 'name', name: 'Name', type: 'text', width: 220, isCore: true },
          { id: 'notes', name: 'Notes', type: 'text', width: 260 },
        ],
        rows: [
          {
            id: `row-${Date.now()}-1`,
            source: 'custom',
            cells: { name: 'First item', notes: '' },
          },
        ],
      };
      setLists(prev => [...prev, newList]);
      setActiveListId(newList.id);
      props.onNavigateToList?.(props.workspaceId, newList.id);
    },
    [props],
  );

  // Undo / Redo
  const handleUndo = useCallback(() => {
    setDraft(prev => {
      if (prev.undoStack.length === 0) return prev;
      const nextUndo = [...prev.undoStack];
      const op = nextUndo.pop()!;
      const nextRedo = [...prev.redoStack, op];

      if (op.type === 'cell_edit') {
        const cellKey = `${op.rowId}:${op.columnId}`;
        const nextDirty = { ...prev.dirtyCells };
        if (op.prevValue === '') {
          delete nextDirty[cellKey];
        } else {
          nextDirty[cellKey] = {
            rowId: op.rowId,
            columnId: op.columnId,
            baseValue: op.prevValue,
            currentValue: op.prevValue,
            timestamp: Date.now(),
          };
        }
        return {
          ...prev,
          dirtyCells: nextDirty,
          undoStack: nextUndo,
          redoStack: nextRedo,
        };
      }

      if (op.type === 'add_row') {
        return {
          ...prev,
          addedRows: prev.addedRows.filter(r => r.id !== op.row.id),
          undoStack: nextUndo,
          redoStack: nextRedo,
        };
      }

      if (op.type === 'delete_row') {
        const nextDel = new Set(prev.deletedRowIds);
        nextDel.delete(op.row.id);
        return {
          ...prev,
          deletedRowIds: nextDel,
          undoStack: nextUndo,
          redoStack: nextRedo,
        };
      }

      if (op.type === 'add_column') {
        return {
          ...prev,
          addedColumns: prev.addedColumns.filter(c => c.id !== op.column.id),
          undoStack: nextUndo,
          redoStack: nextRedo,
        };
      }

      return prev;
    });
  }, []);

  const handleRedo = useCallback(() => {
    setDraft(prev => {
      if (prev.redoStack.length === 0) return prev;
      const nextRedo = [...prev.redoStack];
      const op = nextRedo.pop()!;
      const nextUndo = [...prev.undoStack, op];

      if (op.type === 'cell_edit') {
        const cellKey = `${op.rowId}:${op.columnId}`;
        const nextDirty = { ...prev.dirtyCells };
        nextDirty[cellKey] = {
          rowId: op.rowId,
          columnId: op.columnId,
          baseValue: '',
          currentValue: op.nextValue,
          timestamp: Date.now(),
        };
        return {
          ...prev,
          dirtyCells: nextDirty,
          undoStack: nextUndo,
          redoStack: nextRedo,
        };
      }

      if (op.type === 'add_row') {
        return {
          ...prev,
          addedRows: [op.row, ...prev.addedRows],
          undoStack: nextUndo,
          redoStack: nextRedo,
        };
      }

      if (op.type === 'delete_row') {
        const nextDel = new Set(prev.deletedRowIds);
        nextDel.add(op.row.id);
        return {
          ...prev,
          deletedRowIds: nextDel,
          undoStack: nextUndo,
          redoStack: nextRedo,
        };
      }

      if (op.type === 'add_column') {
        return {
          ...prev,
          addedColumns: [...prev.addedColumns, op.column],
          undoStack: nextUndo,
          redoStack: nextRedo,
        };
      }

      return prev;
    });
  }, []);

  // Discard draft changes
  const handleDiscard = useCallback(() => {
    setDraft({
      dirtyCells: {},
      addedRows: [],
      deletedRowIds: new Set<string>(),
      addedColumns: [],
      undoStack: [],
      redoStack: [],
    });
  }, []);

  // Save changes batch to D1
  const handleSave = useCallback(async () => {
    setIsSaving(true);
    // Simulate transactional D1 ledger batch latency
    await new Promise(resolve => setTimeout(resolve, 320));

    // Commit effective changes to lists state
    setLists(prevLists => {
      return prevLists.map(list => {
        if (list.id !== activeListId) return list;
        return {
          ...list,
          columns: effectiveColumns,
          rows: effectiveRows.map(row => {
            const nextCells = { ...row.cells };
            for (const [, dirty] of Object.entries(draft.dirtyCells)) {
              if (dirty.rowId === row.id) {
                nextCells[dirty.columnId] = dirty.currentValue;
              }
            }
            return {
              ...row,
              cells: nextCells,
            };
          }),
        };
      });
    });

    // Record in history audit
    const savedCount = dirtyCount;
    setHistoryItems(prev => ({
      ...prev,
      [activeListId]: [
        {
          id: `hist-${Date.now()}`,
          timestamp: 'Just now',
          actor: 'user',
          description: `Saved batch of ${savedCount} changes to ledger`,
          affectedCount: savedCount,
          canRestore: true,
        },
        ...(prev[activeListId] ?? []),
      ],
    }));

    handleDiscard();
    setIsSaving(false);
    setSaveBanner('All changes saved to workspace ledger');
    setTimeout(() => {
      setSaveBanner(null);
    }, 3000);
  }, [activeListId, dirtyCount, draft.dirtyCells, effectiveColumns, effectiveRows, handleDiscard]);

  // Apply Otis proposal to draft without saving
  const handleApplyOtisProposal = useCallback(
    (proposal?: AskOtisMessage['proposal']) => {
      if (!proposal) return;

      setDraft(prev => {
        const nextDirty = { ...prev.dirtyCells };
        for (const changeStr of proposal.changes) {
          // If proposal contains a column change or row change, apply as draft edit
          if (changeStr.includes(':')) {
            const [rowId, colVal] = changeStr.split(':');
            if (rowId && colVal) {
              const cellKey = `${rowId.trim()}:notes`;
              nextDirty[cellKey] = {
                rowId: rowId.trim(),
                columnId: 'notes',
                baseValue: '',
                currentValue: colVal.trim(),
                timestamp: Date.now(),
              };
            }
          }
        }
        return {
          ...prev,
          dirtyCells: nextDirty,
        };
      });
      setIsAskOtisOpen(false);
    },
    [],
  );

  // Restore historical revision
  const handleRestoreVersion = useCallback((historyId: string) => {
    setIsHistoryOpen(false);
    setSaveBanner(`Restored version ${historyId}`);
    setTimeout(() => setSaveBanner(null), 3000);
  }, []);

  // Keyboard shortcut listener (Ctrl+S for save, Ctrl+Z for undo, Ctrl+Y for redo)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isCtrlOrCmd = event.ctrlKey || event.metaKey;
      if (isCtrlOrCmd && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (dirtyCount > 0) {
          void handleSave();
        }
      } else if (isCtrlOrCmd && event.key.toLowerCase() === 'z') {
        if (!event.shiftKey) {
          event.preventDefault();
          handleUndo();
        } else {
          event.preventDefault();
          handleRedo();
        }
      } else if (isCtrlOrCmd && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        handleRedo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dirtyCount, handleSave, handleUndo, handleRedo]);

  const currentWorkspaceName = useMemo(() => {
    return props.workspaces.find(w => w.id === props.workspaceId)?.name ?? 'Workspace';
  }, [props.workspaces, props.workspaceId]);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      {/* Desktop Navigation Sidebar */}
      <div className="hidden md:flex md:w-64 md:flex-col md:border-r md:border-sidebar-border bg-sidebar shrink-0">
        <HistoryNav
          workspaceName={currentWorkspaceName}
          workspaces={props.workspaces}
          workspaceId={props.workspaceId}
          ownChats={[]}
          teamChats={[]}
          activeChatId={null}
          variant="sidebar"
          members={props.members}
          isRecordsActive={true}
          onSelectChat={chatId => props.onNavigate(props.workspaceId, chatId)}
          onNewChat={() => props.onNavigate(props.workspaceId, null)}
          onOpenRecords={() => {}}
          onSwitchWorkspace={id => props.onNavigate(id, null)}
          onOpenSettings={() => {}}
        />
      </div>

      {/* Mobile Navigation Drawer */}
      <HistoryNav
        workspaceName={currentWorkspaceName}
        workspaces={props.workspaces}
        workspaceId={props.workspaceId}
        ownChats={[]}
        teamChats={[]}
        activeChatId={null}
        variant="drawer"
        open={isNavDrawerOpen}
        members={props.members}
        isRecordsActive={true}
        onSelectChat={chatId => {
          setIsNavDrawerOpen(false);
          props.onNavigate(props.workspaceId, chatId);
        }}
        onNewChat={() => {
          setIsNavDrawerOpen(false);
          props.onNavigate(props.workspaceId, null);
        }}
        onOpenRecords={() => setIsNavDrawerOpen(false)}
        onSwitchWorkspace={id => {
          setIsNavDrawerOpen(false);
          props.onNavigate(id, null);
        }}
        onOpenSettings={() => setIsNavDrawerOpen(false)}
        onClose={() => setIsNavDrawerOpen(false)}
      />

      {/* Main Records Area */}
      <div className="flex flex-1 flex-col min-w-0 h-full overflow-hidden">
        {/* Top Header */}
        <header className="flex h-12 items-center justify-between border-b border-border px-4 bg-background shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {/* Mobile menu hamburger button */}
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              className="md:hidden text-muted-foreground hover:text-foreground"
              aria-label="Open navigation menu"
              onClick={() => setIsNavDrawerOpen(true)}
            >
              <MenuIcon />
            </Button>

            <span className="otis-wordmark text-base text-foreground tracking-tight">
              Otis
            </span>
            <span className="text-border">/</span>
            <span className="text-sm font-medium text-foreground truncate">
              {activeList.name}
            </span>
            <span className="text-xs text-muted-foreground hidden sm:inline">
              ({effectiveRows.length} rows)
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant={isAskOtisOpen ? 'secondary' : 'ghost'}
              size="sm"
              type="button"
              className="gap-2 text-xs font-medium"
              onClick={() => setIsAskOtisOpen(prev => !prev)}
              aria-expanded={isAskOtisOpen}
            >
              <SparklesIcon />
              <span>Ask Otis</span>
            </Button>
          </div>
        </header>

        {/* Save confirmation banner */}
        {saveBanner && (
          <div
            role="status"
            className="flex items-center justify-between px-4 py-2 bg-secondary text-secondary-foreground text-xs border-b border-border shrink-0"
          >
            <span>{saveBanner}</span>
            <Button
              variant="ghost"
              size="xs"
              type="button"
              className="h-6 px-2 text-xs"
              onClick={() => setSaveBanner(null)}
            >
              Dismiss
            </Button>
          </div>
        )}

        {/* Records Control Toolbar */}
        <RecordsControlBar
          lists={lists}
          activeList={activeList}
          dirtyCount={dirtyCount}
          canUndo={draft.undoStack.length > 0}
          canRedo={draft.redoStack.length > 0}
          viewMode={viewMode}
          searchQuery={searchQuery}
          statusFilter={statusFilter}
          isSaving={isSaving}
          isAskOtisOpen={isAskOtisOpen}
          onSelectList={id => {
            setActiveListId(id);
            props.onNavigateToList?.(props.workspaceId, id);
          }}
          onOpenNewList={() => setIsAddListOpen(true)}
          onSearchChange={setSearchQuery}
          onStatusFilterChange={setStatusFilter}
          onToggleViewMode={() => setViewMode(prev => (prev === 'grid' ? 'cards' : 'grid'))}
          onAddRow={handleAddRow}
          onOpenAddColumn={() => setIsAddColumnOpen(true)}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onDiscard={handleDiscard}
          onSave={handleSave}
          onOpenHistory={() => setIsHistoryOpen(true)}
          onToggleAskOtis={() => setIsAskOtisOpen(prev => !prev)}
        />

        {/* Content body: Table or Card List + Ask Otis panel */}
        <div className="flex flex-1 min-h-0 overflow-hidden relative">
          <main className="flex-1 min-w-0 h-full overflow-hidden flex flex-col">
            {viewMode === 'grid' ? (
              <RecordsTable
                columns={effectiveColumns}
                rows={filteredRows}
                dirtyCells={draft.dirtyCells}
                onCellChange={handleCellChange}
                onAddRow={handleAddRow}
                onDeleteRow={handleDeleteRow}
                onSelectRow={rowId => {
                  const r = effectiveRows.find(x => x.id === rowId);
                  if (r) setSelectedRowForEditor(r);
                }}
              />
            ) : (
              <RecordRowList
                rows={filteredRows}
                columns={effectiveColumns}
                dirtyCells={draft.dirtyCells}
                onSelectRow={rowId => {
                  const r = effectiveRows.find(x => x.id === rowId);
                  if (r) setSelectedRowForEditor(r);
                }}
                onAddRow={handleAddRow}
              />
            )}
          </main>

          {/* Ask Otis Side Pane on desktop */}
          {isAskOtisOpen && (
            <div className="hidden lg:block w-96 h-full border-l border-border bg-card shrink-0">
              <AskOtisPane
                list={activeList}
                dirtyCount={dirtyCount}
                focusedRow={selectedRowForEditor}
                onClose={() => setIsAskOtisOpen(false)}
                onApplyProposal={handleApplyOtisProposal}
              />
            </div>
          )}
        </div>
      </div>

      {/* Row Editor Sheet */}
      <RecordRowEditor
        open={Boolean(selectedRowForEditor)}
        row={selectedRowForEditor}
        columns={effectiveColumns}
        dirtyCells={draft.dirtyCells}
        onClose={() => setSelectedRowForEditor(null)}
        onCellChange={handleCellChange}
        onDeleteRow={handleDeleteRow}
        onAskOtisAboutRow={() => setIsAskOtisOpen(true)}
      />

      {/* Add Column Dialog */}
      <AddColumnDialog
        open={isAddColumnOpen}
        onClose={() => setIsAddColumnOpen(false)}
        onAddColumn={handleAddColumn}
      />

      {/* Add List Dialog */}
      <AddListDialog
        open={isAddListOpen}
        onClose={() => setIsAddListOpen(false)}
        onCreateList={handleCreateList}
      />

      {/* History Sheet */}
      <RecordsHistorySheet
        open={isHistoryOpen}
        history={historyItems[activeListId] ?? []}
        onClose={() => setIsHistoryOpen(false)}
        onRestore={handleRestoreVersion}
      />

      {/* Mobile Ask Otis Drawer */}
      {isAskOtisOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex flex-col justify-end bg-background/80">
          <div className="bg-card border-t border-border h-3/4 flex flex-col rounded-t-xl overflow-hidden shadow-popover">
            <AskOtisPane
              list={activeList}
              dirtyCount={dirtyCount}
              focusedRow={selectedRowForEditor}
              onClose={() => setIsAskOtisOpen(false)}
              onApplyProposal={handleApplyOtisProposal}
            />
          </div>
        </div>
      )}
    </div>
  );
}
