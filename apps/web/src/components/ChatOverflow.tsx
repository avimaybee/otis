import { useState } from 'react';
import type { ModelOption } from '@otis/contracts';
import { OverflowIcon } from './icons.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu.js';
import { Button } from './ui/button.js';

/**
 * Quiet chat overflow: model and thinking controls live here and behind
 * slash commands, never in the composer. Selections apply the same
 * deterministic command operations the composer picker uses.
 */
export function ChatOverflow({ models, onCommand, disabled, pending, followsDefault, running, onStop, onRename, onDelete }: {
  models: ModelOption[]; onCommand?: (text: string) => Promise<boolean>; disabled?: boolean; pending?: boolean; followsDefault?: boolean; running?: boolean; onStop?: () => Promise<void>;
  onRename?: () => void; onDelete?: () => void;
}) {
  const [stopping, setStopping] = useState(false);
  const current = models.find(model => model.is_current);
  const thinking = current?.thinking;
  const selectable = models.filter(model => model.available);
  const busy = disabled || pending || !onCommand;
  // Capability labels describe this workspace's usable route for each model:
  // verified native audio, transcription through the configured STT provider,
  // or voice unavailable. Never a blanket claim about the underlying model.
  const voiceNote = (model: ModelOption): string | null =>
    model.native_audio_supported ? 'Native voice' : model.voice_available ? 'Voice via transcription' : null;

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
      <DropdownMenuLabel>Model</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={followsDefault ? 'default' : current?.command_key ?? ''} onValueChange={key => { void onCommand?.(`/model ${key}`); }}>
        <DropdownMenuRadioItem value="default" disabled={busy}>
          <span>Workspace default</span>
          <span className="text-xs text-muted-foreground">{models.find(model => model.is_default)?.display_name ?? 'No model configured'}</span>
        </DropdownMenuRadioItem>
        {selectable.map(model => {
          const note = voiceNote(model);
          return (
            <DropdownMenuRadioItem key={model.command_key} value={model.command_key} disabled={busy}>
              <span>{model.display_name}</span>
              {note && <span className="text-xs text-muted-foreground">{note}</span>}
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>

      {thinking?.state === 'supported' && thinking.choices.length > 0 && <>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Thinking effort</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={thinking.is_default ? 'default' : thinking.current_choice_id ?? 'default'} onValueChange={key => { void onCommand?.(`/thinking ${key}`); }}>
          <DropdownMenuRadioItem value="default" disabled={busy}>Provider default</DropdownMenuRadioItem>
          {thinking.choices.map(choice => <DropdownMenuRadioItem key={choice.id} value={choice.id} disabled={busy}>{choice.label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </>}
      {running && onStop && <>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Run</DropdownMenuLabel>
        {/* An action, not a choice: a menu item, never a radio option. */}
        <DropdownMenuItem disabled={stopping} onSelect={e => void handleStop(e)}>{stopping ? 'Stopping Otis…' : 'Stop Otis'}</DropdownMenuItem>
      </>}
      {(onRename || onDelete) && <>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Conversation</DropdownMenuLabel>
        {onRename && <DropdownMenuItem onSelect={() => onRename()}>Rename conversation</DropdownMenuItem>}
        {onDelete && <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onDelete()}>Delete conversation</DropdownMenuItem>}
      </>}
      {pending && <span className="otis-visually-hidden" role="status">Updating chat settings…</span>}
    </DropdownMenuContent>
  </DropdownMenu>;
}
