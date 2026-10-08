import type { RecordHistoryItem } from './types.js';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter
} from '../ui/sheet.js';
import { Button } from '../ui/button.js';
import { UndoIcon, SparklesIcon } from '../icons.js';

export interface RecordsHistorySheetProps {
  open: boolean;
  onClose: () => void;
  history: RecordHistoryItem[];
  onRestore: (historyId: string) => void;
}

export function RecordsHistorySheet({
  open,
  onClose,
  history,
  onRestore,
}: RecordsHistorySheetProps) {
  return (
    <Sheet open={open} onOpenChange={isOpen => { if (!isOpen) onClose(); }}>
      <SheetContent side="right" className="flex flex-col sm:max-w-md w-full bg-sidebar border-border p-0">
        <SheetHeader className="p-4 border-b border-border flex flex-col gap-1">
          <SheetTitle className="text-base font-medium">Change history</SheetTitle>
          <p className="text-xs text-muted-foreground">
            Audit log of manual saves and Otis cleanup runs.
          </p>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          {history.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-xs text-muted-foreground">
              No previous changes recorded for this list yet.
            </div>
          ) : (
            history.map(item => (
              <div
                key={item.id}
                className="rounded-lg border border-border bg-card p-3 flex flex-col gap-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    {item.actor === 'otis' ? (
                      <span className="flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-xs text-foreground font-medium">
                        <SparklesIcon />
                        <span>Otis</span>
                      </span>
                    ) : (
                      <span className="rounded bg-card border border-border px-2 py-1 text-xs text-foreground font-medium">
                        You
                      </span>
                    )}
                    <span className="text-xs text-subtle">{item.timestamp}</span>
                  </div>
                  <span className="text-xs text-subtle">
                    {item.affectedCount} {item.affectedCount === 1 ? 'cell' : 'cells'}
                  </span>
                </div>

                <p className="text-xs text-foreground font-medium">
                  {item.description}
                </p>

                {item.canRestore && (
                  <div className="pt-1 flex items-center justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRestore(item.id)}
                      className="h-7 gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <UndoIcon />
                      <span>Restore this version</span>
                    </Button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <SheetFooter className="p-4 border-t border-border flex items-center justify-between">
          <span className="text-xs text-subtle">
            All committed changes are durably preserved.
          </span>
          <Button variant="default" size="sm" onClick={onClose} className="text-xs font-medium">
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
