import { useState } from 'react';
import type { RecordFieldType } from './types.js';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '../ui/dialog.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { ChoiceSelect } from '../ui/select.js';

export interface AddColumnDialogProps {
  open: boolean;
  onClose: () => void;
  onAddColumn: (label: string, type: RecordFieldType) => void;
}

export function AddColumnDialog({
  open,
  onClose,
  onAddColumn,
}: AddColumnDialogProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<RecordFieldType>('text');

  const typeOptions: { value: RecordFieldType; label: string }[] = [
    { value: 'text', label: 'Text' },
    { value: 'status', label: 'Status / Choice' },
    { value: 'phone', label: 'Phone' },
    { value: 'currency', label: 'Currency' },
    { value: 'number', label: 'Number' },
    { value: 'date', label: 'Date' },
  ];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    onAddColumn(trimmed, type);
    setName('');
    setType('text');
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={isOpen => { if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-md bg-popover border-border">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader className="flex flex-col gap-1">
            <DialogTitle className="text-base font-medium">Add column</DialogTitle>
            <p className="text-xs text-muted-foreground">
              Add a core or sparse custom field to this list.
            </p>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="column-name" className="text-xs font-medium text-muted-foreground">
                Column name
              </label>
              <Input
                id="column-name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Access instructions, Margin, Total"
                className="text-sm"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="column-type" className="text-xs font-medium text-muted-foreground">
                Field type
              </label>
              <ChoiceSelect
                id="column-type"
                label="Select type"
                value={type}
                options={typeOptions}
                onChange={val => setType(val as RecordFieldType)}
              />
              <span className="text-xs text-subtle pt-1">
                Totals and rules are described to Otis, which proposes a validated calculation.
              </span>
            </div>
          </div>

          <DialogFooter className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} className="text-xs">
              Cancel
            </Button>
            <Button type="submit" variant="default" size="sm" disabled={!name.trim()} className="text-xs font-medium">
              Add column
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
