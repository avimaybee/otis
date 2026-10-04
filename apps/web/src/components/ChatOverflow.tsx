import type { ModelOption } from '@otis/contracts';
import { OverflowIcon } from './icons.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu.js';
import { Button } from './ui/button.js';

/**
 * Quiet chat overflow: model and thinking controls live here and behind
 * slash commands, never in the composer. Selections apply the same
 * deterministic command operations the composer picker uses.
 */
export function ChatOverflow({ models, onCommand, disabled, pending, followsDefault, running, onStop }: {
  models: ModelOption[]; onCommand?: (text: string) => Promise<boolean>; disabled?: boolean; pending?: boolean; followsDefault?: boolean; running?: boolean; onStop?: () => Promise<void>;
}) {
  const current = models.find(model => model.is_current);
  const thinking = current?.thinking;
  const selectable = models.filter(model => model.available);
  const busy = disabled || pending || !onCommand;
  // Capability labels describe this workspace's usable route for each model:
  // verified native audio, transcription through the configured STT provider,
  // or voice unavailable. Never a blanket claim about the underlying model.
  const voiceNote = (model: ModelOption): string =>
    model.native_audio_supported ? 'Native voice' : model.voice_available ? 'Voice via transcription' : 'Voice unavailable';
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
          <span className="otis-menu__label"><span>Workspace default</span><small className="text-xs">{models.find(model => model.is_default)?.display_name ?? 'No model configured'}</small></span>
        </DropdownMenuRadioItem>
        {selectable.map(model => <DropdownMenuRadioItem key={model.command_key} value={model.command_key} disabled={busy}><span className="otis-menu__label"><span>{model.display_name}</span><small className="text-xs">{voiceNote(model)}</small></span></DropdownMenuRadioItem>)}
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
        <DropdownMenuItem onSelect={() => { void onStop(); }}>Stop Otis</DropdownMenuItem>
      </>}
      {pending && <span className="otis-visually-hidden" role="status">Updating chat settings…</span>}
    </DropdownMenuContent>
  </DropdownMenu>;
}
