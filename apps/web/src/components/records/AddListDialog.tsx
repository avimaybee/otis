import { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '../ui/dialog.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';

export interface AddListDialogProps {
  open: boolean;
  onClose: () => void;
  onCreateList: (name: string, description?: string) => void;
}

export function AddListDialog({
  open,
  onClose,
  onCreateList,
}: AddListDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    onCreateList(trimmed, description.trim() || undefined);
    setName('');
    setDescription('');
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={isOpen => { if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-md bg-popover border-border">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader className="flex flex-col gap-1">
            <DialogTitle className="text-base font-medium">Create new list</DialogTitle>
            <p className="text-xs text-muted-foreground">
              Add a named information list to your workspace (e.g. Products, Vendors, Inventory).
            </p>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="list-name" className="text-xs font-medium text-muted-foreground">
                List name
              </label>
              <Input
                id="list-name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Equipment, Suppliers, Contractors"
                className="text-sm"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="list-desc" className="text-xs font-medium text-muted-foreground">
                Description (optional)
              </label>
              <Input
                id="list-desc"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Brief purpose of this information list"
                className="text-sm"
              />
            </div>
          </div>

          <DialogFooter className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} className="text-xs">
              Cancel
            </Button>
            <Button type="submit" variant="default" size="sm" disabled={!name.trim()} className="text-xs font-medium">
              Create list
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
