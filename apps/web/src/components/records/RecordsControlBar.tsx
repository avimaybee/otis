import { useState } from 'react';
import type { RecordColumn } from './types.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import {
  SearchIcon, CloseIcon, PlusIcon, FilterIcon,
  TableIcon, LayoutListIcon, UndoIcon, RedoIcon,
  SaveIcon, HistoryIcon, AlertCircleIcon, RefreshIcon,
  CopyIcon, TrashIcon, CheckIcon,
} from '../icons.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuCheckboxItem,
} from '../ui/dropdown-menu.js';

export interface RecordsListRef {
  id: string;
  name: string;
  total?: number | null;
}

export interface SortSpec {
  column: string;
  dir: 'asc' | 'desc';
}

export interface RecordsControlBarProps {
  lists: RecordsListRef[];
  activeListId: string;
  onSelectList: (listId: string) => void;
  onOpenNewList: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searching: boolean;
  statusFilter: string | null;
  onStatusFilterChange: (status: string | null) => void;
  sort: SortSpec;
  sortOptions: Array<{ id: string; label: string }>;
  onSortChange: (column: string, dir: 'asc' | 'desc') => void;
  viewMode: 'grid' | 'cards';
  onToggleViewMode: () => void;
  columns: RecordColumn[];
  hiddenColumns: Set<string>;
  onToggleColumn: (columnId: string) => void;
  onOpenAddColumn: () => void;
  onAddRow: () => void;
  selectionCount: number;
  onCopySelection: () => void;
  onRemoveSelection: () => void;
  onClearSelection: () => void;
  copying: boolean;
  copyFeedback: string | null;
  onOpenHistory: () => void;
  onOpenDuplicates?: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
}

const STATUS_OPTIONS = ['all', 'new', 'warm', 'hot', 'won', 'cold', 'lost', 'open', 'done'];

export function RecordsControlBar(props: RecordsControlBarProps) {
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const activeList = props.lists.find((l) => l.id === props.activeListId);

  // A row selection replaces the toolbar with its own actions: the count
  // always means loaded visible rows, never the whole database.
  if (props.selectionCount > 0) {
    return (
      <div className="otis-records__toolbar" role="toolbar" aria-label="Selected rows">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">
            {props.selectionCount} selected
          </span>
          <span className="text-xs text-subtle hidden sm:inline">Loaded rows only</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={props.onCopySelection} disabled={props.copying} className="h-8 gap-1 text-xs">
            {props.copyFeedback ? <CheckIcon /> : <CopyIcon />}
            <span>{props.copyFeedback ?? (props.copying ? 'Copying…' : 'Copy')}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={props.onRemoveSelection} className="h-8 gap-1 text-xs text-destructive hover:text-destructive">
            <TrashIcon />
            <span>Remove</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={props.onClearSelection} className="h-8 gap-1 text-xs">
            <CloseIcon />
            <span>Clear selection</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="otis-records__toolbar" role="toolbar" aria-label="Records">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-2 font-medium md:hidden">
              <span>{activeList?.name ?? 'Lists'}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            {props.lists.map((list) => (
              <DropdownMenuItem
                key={list.id}
                onSelect={() => props.onSelectList(list.id)}
                className={list.id === props.activeListId ? 'bg-accent' : ''}
              >
                <span className="flex-1 font-medium">{list.name}</span>
                {typeof list.total === 'number' && (
                  <span className="text-xs text-subtle">{list.total} rows</span>
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={props.onOpenNewList} className="gap-2">
              <PlusIcon />
              <span>Create new list</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="relative flex items-center">
          <Input
            type="search"
            placeholder="Search this list…"
            aria-label="Search this list"
            value={props.searchQuery}
            onChange={(e) => props.onSearchChange(e.target.value)}
            className="h-8 w-44 pl-8 pr-6 text-xs md:w-56"
          />
          <span className="pointer-events-none absolute left-2.5 text-muted-foreground">
            <SearchIcon />
          </span>
          {props.searchQuery ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => props.onSearchChange('')}
              className="absolute right-1 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <CloseIcon />
            </Button>
          ) : null}
        </div>

        <DropdownMenu open={filterMenuOpen} onOpenChange={setFilterMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant={props.statusFilter ? 'secondary' : 'ghost'}
              size="sm"
              className="h-8 gap-1 text-xs"
              aria-label="Filter status"
            >
              <FilterIcon />
              <span>{props.statusFilter ? `Status: ${props.statusFilter}` : 'Filter'}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            {STATUS_OPTIONS.map((st) => (
              <DropdownMenuItem
                key={st}
                onSelect={() => props.onStatusFilterChange(st === 'all' ? null : st)}
                className={(props.statusFilter === st || (st === 'all' && !props.statusFilter)) ? 'bg-accent font-medium' : ''}
              >
                <span className="capitalize">{st}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs" aria-label="Sort rows">
              <TableIcon />
              <span>Sort</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            {props.sortOptions.map((opt) => (
              <DropdownMenuItem
                key={opt.id}
                onSelect={() => props.onSortChange(opt.id, props.sort.column === opt.id && props.sort.dir === 'asc' ? 'desc' : 'asc')}
                className={props.sort.column === opt.id ? 'bg-accent font-medium' : ''}
              >
                <span className="flex-1">{opt.label}</span>
                {props.sort.column === opt.id && (
                  <span className="text-xs text-subtle">{props.sort.dir === 'asc' ? '↑' : '↓'}</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="ghost" size="sm" onClick={props.onAddRow} className="h-8 gap-1 text-xs">
          <PlusIcon />
          <span>Add row</span>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs" aria-label="Columns">
              <LayoutListIcon />
              <span>Columns</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            {props.columns.map((col) => (
              <DropdownMenuCheckboxItem
                key={col.id}
                checked={!props.hiddenColumns.has(col.id)}
                onCheckedChange={() => props.onToggleColumn(col.id)}
              >
                <span>{col.name}</span>
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={props.onOpenAddColumn} className="gap-2">
              <PlusIcon />
              <span>Add column</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs text-muted-foreground" aria-label="More actions">
              <span>···</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuItem onSelect={props.onOpenHistory} className="gap-2">
              <HistoryIcon />
              <span>History</span>
            </DropdownMenuItem>
            {props.onOpenDuplicates && (
              <DropdownMenuItem onSelect={props.onOpenDuplicates} className="gap-2">
                <span>Find duplicates</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={props.onToggleViewMode} className="gap-2">
              {props.viewMode === 'grid' ? <LayoutListIcon /> : <TableIcon />}
              <span>{props.viewMode === 'grid' ? 'Card view' : 'Grid view'}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={props.onRefresh} disabled={props.isRefreshing} className="gap-2">
              <RefreshIcon className={props.isRefreshing ? 'animate-spin' : ''} />
              <span>Refresh</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export interface RecordsEditBarProps {
  dirtyCount: number;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDiscard: () => void;
  onSave: () => void;
  saving: boolean;
  conflictMessage: string | null;
  onKeepMine: () => void;
  onUseSaved: () => void;
  unknownOutcome: string | null;
  onRetrySave: () => void;
  errorMessage: string | null;
  savedMessage: string | null;
  onDismissSaved: () => void;
}

export function RecordsEditBar(props: RecordsEditBarProps) {
  if (props.conflictMessage) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 px-4 py-2 bg-warning/10 border-b border-border text-xs shrink-0">
        <AlertCircleIcon />
        <span className="flex-1 min-w-40 font-medium">This value changed while you edited. {props.conflictMessage}</span>
        <Button variant="default" size="sm" onClick={props.onKeepMine} className="h-6 px-2 text-xs">Keep mine</Button>
        <Button variant="ghost" size="sm" onClick={props.onUseSaved} className="h-6 px-2 text-xs">Use saved</Button>
      </div>
    );
  }
  if (props.unknownOutcome) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 px-4 py-2 bg-warning/10 border-b border-border text-xs shrink-0">
        <AlertCircleIcon />
        <span className="flex-1 min-w-40 font-medium">{props.unknownOutcome}</span>
        <Button variant="default" size="sm" onClick={props.onRetrySave} className="h-6 px-2 text-xs">Retry save</Button>
      </div>
    );
  }
  if (props.errorMessage) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 px-4 py-2 bg-destructive/10 border-b border-border text-xs shrink-0">
        <AlertCircleIcon />
        <span className="flex-1 min-w-40 font-medium">{props.errorMessage}</span>
      </div>
    );
  }
  if (props.savedMessage) {
    return (
      <div role="status" className="flex items-center justify-between px-4 py-2 text-xs border-b border-border shrink-0">
        <span>{props.savedMessage}</span>
        <Button variant="ghost" size="xs" type="button" className="h-6 px-2 text-xs" onClick={props.onDismissSaved}>
          Dismiss
        </Button>
      </div>
    );
  }
  if (props.dirtyCount === 0) return null;
  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-background shrink-0" role="toolbar" aria-label="Unsaved changes">
      <span className="flex items-center gap-1 text-xs text-warning font-medium">
        <AlertCircleIcon />
        <span>{props.dirtyCount} unsaved {props.dirtyCount === 1 ? 'change' : 'changes'}</span>
      </span>
      <div className="mx-1 h-3 w-px bg-border" />
      <Button variant="ghost" size="icon-xs" onClick={props.onUndo} disabled={!props.canUndo} title="Undo edit" aria-label="Undo">
        <UndoIcon />
      </Button>
      <Button variant="ghost" size="icon-xs" onClick={props.onRedo} disabled={!props.canRedo} title="Redo edit" aria-label="Redo">
        <RedoIcon />
      </Button>
      <Button variant="ghost" size="sm" onClick={props.onDiscard} className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive" title="Discard all changes">
        Discard
      </Button>
      <Button variant="default" size="sm" onClick={props.onSave} disabled={props.saving} className="h-6 gap-1 px-2 text-xs font-medium">
        <SaveIcon />
        <span>{props.saving ? 'Saving…' : 'Save'}</span>
      </Button>
    </div>
  );
}
