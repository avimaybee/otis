import type { RecordColumn, RecordRow, DirtyCellState } from './types.js';
import { lazy, Suspense, useState } from 'react';
const EntityFilePane = lazy(() => import('../EntityFile.js').then(m => ({ default: m.EntityFilePane })));
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter
} from '../ui/sheet.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Textarea } from '../ui/textarea.js';
import { ChoiceSelect } from '../ui/select.js';
import { StatusPill } from '../StatusPill.js';
import {
  SparklesIcon, TrashIcon, CalculatorIcon, SearchDocIcon
} from '../icons.js';

export interface RecordRowEditorProps {
  workspaceId?: string;
  userId?: string;
  onOpenChat?: (id: string) => void;
  open: boolean;
  onClose: () => void;
  row: RecordRow | null;
  columns: RecordColumn[];
  dirtyCells: Record<string, DirtyCellState>;
  onCellChange: (rowId: string, columnId: string, nextValue: string) => void;
  onDeleteRow?: (rowId: string) => void;
  onAskOtisAboutRow?: (row: RecordRow, question?: string) => void;
}

export function RecordRowEditor({
  workspaceId,
  userId,
  onOpenChat,
  open,
  onClose,
  row,
  columns,
  dirtyCells,
  onCellChange,
  onDeleteRow,
  onAskOtisAboutRow,
}: RecordRowEditorProps) {
  const [showFile, setShowFile] = useState(false);
  if (!row) return null;

  const primaryCol = columns[0] ?? { id: 'name', name: 'Name' };
  const title = (dirtyCells[`${row.id}:${primaryCol.id}`]?.currentValue ?? row.cells[primaryCol.id]) || 'Untitled record';

  const getEffectiveValue = (columnId: string): string => {
    const dirtyKey = `${row.id}:${columnId}`;
    if (dirtyCells[dirtyKey]) {
      return dirtyCells[dirtyKey].currentValue;
    }
    return row.cells[columnId] ?? '';
  };

  const isDirty = (columnId: string): boolean => {
    return Boolean(dirtyCells[`${row.id}:${columnId}`]);
  };

  return (
    <Sheet open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <SheetContent side="right" className="flex flex-col sm:max-w-md w-full bg-sidebar border-border p-0">
        <SheetHeader className="p-4 border-b border-border flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <SheetTitle className="text-base font-medium truncate">{title}</SheetTitle>
          </div>
          <span className="text-xs text-subtle">
            {row.source === 'entity' ? 'Lead entity' : row.source === 'task' ? 'Task record' : 'Custom list row'}
          </span>
        </SheetHeader>

        {/* Scrollable form fields */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          {row.source === 'entity' && workspaceId && userId && <section className="space-y-4"><Button variant="outline" onClick={() => setShowFile(v => !v)} aria-expanded={showFile}>{showFile ? 'Close client file' : 'View complete client file'}</Button>{showFile && <Suspense fallback={<p role="status">Opening client file…</p>}><EntityFilePane key={`${workspaceId}:${userId}:${row.id}`} workspaceId={workspaceId} userId={userId} entityId={row.id} onAsk={question => onAskOtisAboutRow?.(row, question)} onOpenChat={onOpenChat}/></Suspense>}</section>}
          {columns.map(col => {
            const val = getEffectiveValue(col.id);
            const dirty = isDirty(col.id);
            const provenance = row.provenance?.[col.id];

            return (
              <div key={col.id} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={`field-${col.id}`} className="text-xs font-medium text-muted-foreground">
                    {col.name}
                  </label>
                  {dirty && (
                    <span className="text-xs text-warning font-medium">Unsaved edit</span>
                  )}
                </div>

                {/* Field Input Variant */}
                {col.type === 'status' ? (
                  <div className="flex flex-col gap-2">
                    <ChoiceSelect
                      id={`field-${col.id}`}
                      label={col.name}
                      value={val || 'new'}
                      options={(col.options ?? ['new', 'warm', 'hot', 'won', 'cold', 'lost', 'open', 'done']).map(opt => ({
                        value: opt,
                        label: opt.charAt(0).toUpperCase() + opt.slice(1),
                      }))}
                      onChange={nextVal => onCellChange(row.id, col.id, nextVal)}
                    />
                    {val && (
                      <div className="pt-1">
                        <StatusPill status={val} />
                      </div>
                    )}
                  </div>
                ) : col.type === 'calculation' ? (
                  <div className="flex items-center gap-2 rounded-md border border-border bg-card p-2 text-sm">
                    <span className="text-subtle"><CalculatorIcon /></span>
                    <span className="font-medium text-foreground">{val || '—'}</span>
                    <span className="text-xs text-subtle ml-auto">
                      {col.calculation?.description || col.calculation?.expression}
                    </span>
                  </div>
                ) : col.id === 'notes' || col.id === 'access' ? (
                  <Textarea
                    id={`field-${col.id}`}
                    value={val}
                    onChange={e => onCellChange(row.id, col.id, e.target.value)}
                    placeholder={`Enter ${col.name.toLowerCase()}...`}
                    className="min-h-20 text-sm"
                  />
                ) : (
                  <Input
                    id={`field-${col.id}`}
                    type={col.type === 'number' ? 'number' : 'text'}
                    value={val}
                    onChange={e => onCellChange(row.id, col.id, e.target.value)}
                    placeholder={`Enter ${col.name.toLowerCase()}...`}
                    className="text-sm"
                  />
                )}

                {/* Provenance attribution if present */}
                {provenance && (
                  <div className="flex items-center gap-1 text-xs text-subtle pt-1">
                    <SearchDocIcon />
                    <span>{provenance}</span>
                  </div>
                )}
              </div>
            );
          })}

          {/* Quick Ask Otis action for this row */}
          <div className="mt-2 rounded-md border border-border bg-card p-3 flex flex-col gap-2">
            <div className="flex items-center gap-1 text-xs font-medium text-foreground">
              <SparklesIcon />
              <span>Ask Otis about this record</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Query recent mentions, draft a follow-up email, or check remembered details.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onAskOtisAboutRow?.(row);
                onClose();
              }}
              className="mt-1 gap-1 text-xs"
            >
              <SparklesIcon />
              <span>Ask Otis</span>
            </Button>
          </div>
        </div>

        {/* Footer actions */}
        <SheetFooter className="p-4 border-t border-border flex items-center justify-between gap-2">
          {onDeleteRow && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onDeleteRow(row.id);
                onClose();
              }}
              className="text-xs text-destructive hover:text-destructive gap-1"
            >
              <TrashIcon />
              <span>Delete row</span>
            </Button>
          )}
          <Button variant="default" size="sm" onClick={onClose} className="ml-auto text-xs font-medium">
            Done
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
