import { useState } from 'react';
import type { ModelOption } from '@otis/contracts';
import { OverflowIcon } from './icons.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu.js';
import { Button } from './ui/button.js';

/**
 * Chat overflow: conversation actions (Stop, Rename, Delete).
 * Model controls live in the composer.
 */
export function ChatOverflow({ disabled, pending, running, onStop, onRename, onDelete }: {
  models?: ModelOption[]; onCommand?: (text: string) => Promise<boolean>; disabled?: boolean; pending?: boolean; followsDefault?: boolean; running?: boolean; onStop?: () => Promise<void>;
  onRename?: () => void; onDelete?: () => void;
}) {
  const [stopping, setStopping] = useState(false);

  const handleStop = async (event: Event) => {
    event.preventDefault();
    if (!onStop || stopping) return;
    setStopping(true);
    try {
      await onStop();
    } finally {
      setStopping(false);
    }
  };
  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="icon" type="button" className="otis-iconbutton" aria-label="Chat options" disabled={disabled} aria-busy={pending}>
        {pending ? <span className="otis-spinner" aria-hidden="true" /> : <OverflowIcon />}
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" side="bottom" aria-label="Chat options">
      {running && onStop && <>
        <DropdownMenuLabel>Run</DropdownMenuLabel>
        {/* An action, not a choice: a menu item, never a radio option. */}
        <DropdownMenuItem disabled={stopping} onSelect={e => void handleStop(e)}>{stopping ? 'Stopping Otis…' : 'Stop Otis'}</DropdownMenuItem>
      </>}
      {(onRename || onDelete) && <>
        {running && onStop && <DropdownMenuSeparator />}
        <DropdownMenuLabel>Conversation</DropdownMenuLabel>
        {onRename && <DropdownMenuItem onSelect={() => onRename()}>Rename conversation</DropdownMenuItem>}
        {onDelete && <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onDelete()}>Delete conversation</DropdownMenuItem>}
      </>}
      {pending && <span className="otis-visually-hidden" role="status">Updating chat settings…</span>}
    </DropdownMenuContent>
  </DropdownMenu>;
}
