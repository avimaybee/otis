import { useState } from 'react';
import type { RecordList } from './types.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import {
  SearchIcon, CloseIcon, PlusIcon, FilterIcon,
  TableIcon, LayoutListIcon, UndoIcon, RedoIcon,
  SaveIcon, HistoryIcon, SparklesIcon, ChevronDownIcon,
  AlertCircleIcon, RefreshIcon
} from '../icons.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator
} from '../ui/dropdown-menu.js';

export interface RecordsControlBarProps {
  lists: RecordList[];
  activeList: RecordList;
  onSelectList: (listId: string) => void;
  onOpenNewList: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  statusFilter: string | null;
  onStatusFilterChange: (status: string | null) => void;
  viewMode: 'grid' | 'cards';
  onToggleViewMode: () => void;
  onAddRow: () => void;
  onOpenAddColumn: () => void;
  dirtyCount: number;
  onSave: () => void;
  onDiscard: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  isSaving: boolean;
  onOpenHistory: () => void;
  onToggleAskOtis: () => void;
  isAskOtisOpen: boolean;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

export function RecordsControlBar({
  lists,
  activeList,
  onSelectList,
  onOpenNewList,
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  viewMode,
  onToggleViewMode,
  onAddRow,
  onOpenAddColumn,
  dirtyCount,
  onSave,
  onDiscard,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  isSaving,
  onOpenHistory,
  onToggleAskOtis,
  isAskOtisOpen,
  onRefresh,
  isRefreshing,
}: RecordsControlBarProps) {
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);

  // Derive unique statuses from list columns/rows if any
  const statusOptions = ['all', 'new', 'warm', 'hot', 'won', 'cold', 'lost', 'open', 'done'];

  return (
    <div className="otis-records__toolbar">
      {/* Left section: List selector + search + filters */}
      <div className="flex flex-wrap items-center gap-2">
        {/* List Picker Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-2 font-medium">
              <span>{activeList.name}</span>
              <span className="text-xs text-subtle">({activeList.rows.length})</span>
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            {lists.map(list => (
              <DropdownMenuItem
                key={list.id}
                onSelect={() => onSelectList(list.id)}
                className={list.id === activeList.id ? 'bg-accent' : ''}
              >
                <span className="flex-1 font-medium">{list.name}</span>
                <span className="text-xs text-subtle">{list.rows.length} rows</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onOpenNewList} className="gap-2">
              <PlusIcon />
              <span>Create new list</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Search Input */}
        <div className="relative flex items-center">
          <Input
            type="search"
            placeholder="Search records..."
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            className="h-8 w-44 pl-8 pr-6 text-xs md:w-56"
          />
          <span className="pointer-events-none absolute left-2.5 text-muted-foreground">
            <SearchIcon />
          </span>
          {searchQuery && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => onSearchChange('')}
              className="absolute right-1 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <CloseIcon />
            </Button>
          )}
        </div>

        {/* Status Filter */}
        <DropdownMenu open={filterMenuOpen} onOpenChange={setFilterMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant={statusFilter ? 'secondary' : 'ghost'}
              size="sm"
              className="h-8 gap-1 text-xs"
              aria-label="Filter status"
            >
              <FilterIcon />
              <span>{statusFilter ? `Status: ${statusFilter}` : 'Filter'}</span>
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            {statusOptions.map(st => (
              <DropdownMenuItem
                key={st}
                onSelect={() => onStatusFilterChange(st === 'all' ? null : st)}
                className={(statusFilter === st || (st === 'all' && !statusFilter)) ? 'bg-accent font-medium' : ''}
              >
                <span className="capitalize">{st}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Add row and Add column */}
        <Button variant="ghost" size="sm" onClick={onAddRow} className="h-8 gap-1 text-xs">
          <PlusIcon />
          <span>Add row</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpenAddColumn} className="h-8 gap-1 text-xs">
          <PlusIcon />
          <span>Add column</span>
        </Button>
      </div>

      {/* Right section: Draft controls, view switch, history & Ask Otis */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Dirty draft status bar */}
        {dirtyCount > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1">
            <span className="flex items-center gap-1 text-xs text-warning font-medium">
              <AlertCircleIcon />
              <span>{dirtyCount} unsaved {dirtyCount === 1 ? 'change' : 'changes'}</span>
            </span>
            <div className="mx-1 h-3 w-px bg-border" />
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onUndo}
              disabled={!canUndo}
              title="Undo edit (Ctrl+Z)"
              aria-label="Undo"
            >
              <UndoIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onRedo}
              disabled={!canRedo}
              title="Redo edit (Ctrl+Y)"
              aria-label="Redo"
            >
              <RedoIcon />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onDiscard}
              className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
              title="Discard all changes"
            >
              Discard
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={onSave}
              disabled={isSaving}
              className="h-6 gap-1 px-2 text-xs font-medium"
            >
              <SaveIcon />
              <span>{isSaving ? 'Saving…' : 'Save'}</span>
            </Button>
          </div>
        )}

        {/* Refresh records */}
        {onRefresh && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={isRefreshing}
            className="h-8 gap-1 text-xs text-muted-foreground hover:text-foreground"
            title="Refresh records from workspace memory"
            aria-label="Refresh records"
          >
            <RefreshIcon className={isRefreshing ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        )}

        {/* View toggle (Grid / Cards) */}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onToggleViewMode}
          title={viewMode === 'grid' ? 'Switch to cards view' : 'Switch to grid view'}
          aria-label={viewMode === 'grid' ? 'Switch to cards view' : 'Switch to grid view'}
        >
          {viewMode === 'grid' ? <LayoutListIcon /> : <TableIcon />}
        </Button>

        {/* History / Audit Log */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenHistory}
          className="h-8 gap-1 text-xs text-muted-foreground hover:text-foreground"
          title="View change history"
        >
          <HistoryIcon />
          <span className="hidden sm:inline">History</span>
        </Button>

        {/* Ask Otis AI Assistant Button */}
        <Button
          variant={isAskOtisOpen ? 'secondary' : 'outline'}
          size="sm"
          onClick={onToggleAskOtis}
          className="h-8 gap-1 text-xs"
        >
          <SparklesIcon />
          <span>Ask Otis</span>
          {dirtyCount > 0 && <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />}
        </Button>
      </div>
    </div>
  );
}
