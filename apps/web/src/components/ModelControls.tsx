import type { ModelOption } from '@otis/contracts';
import { ChevronDownIcon } from './icons.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './ui/dropdown-menu.js';
import { Button } from './ui/button.js';

export function ModelControls({ models, onCommand, disabled, pending, followsDefault }: {
  models: ModelOption[]; onCommand?: (text: string) => Promise<boolean>; disabled?: boolean; pending?: boolean; followsDefault?: boolean;
}) {
  const current = models.find(model => model.is_current);
  const thinking = current?.thinking;
  const selectable = models.filter(model => model.available);
  return <div className="otis-model-controls" aria-busy={pending}>
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild><Button variant="ghost" type="button" className="otis-model-control" aria-label="Choose model" disabled={disabled || pending || !onCommand || !selectable.length}><span>{current?.display_name ?? 'Choose model'}</span><ChevronDownIcon/></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" aria-label="Models">
        <DropdownMenuRadioGroup value={followsDefault ? 'default' : current?.command_key ?? ''} onValueChange={key => { void onCommand?.(`/model ${key}`); }}>
          <DropdownMenuRadioItem value="default"><span>Workspace default</span><small>{models.find(model => model.is_default)?.display_name ?? 'No model configured'}</small></DropdownMenuRadioItem>
          {selectable.map(model => <DropdownMenuRadioItem key={model.command_key} value={model.command_key}>{model.display_name}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    {thinking?.state === 'supported' && thinking.choices.length > 0 && <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild><Button variant="ghost" type="button" className="otis-model-control otis-model-control--thinking" aria-label="Thinking effort" disabled={disabled || pending || !onCommand}><span>{thinking.is_default ? 'Default thinking' : thinking.choices.find(choice => choice.id === thinking.current_choice_id)?.label ?? 'Default thinking'}</span><ChevronDownIcon/></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" aria-label="Thinking effort options">
        <DropdownMenuRadioGroup value={thinking.is_default ? 'default' : thinking.current_choice_id ?? 'default'} onValueChange={key => { void onCommand?.(`/thinking ${key}`); }}>
          <DropdownMenuRadioItem value="default">Provider default</DropdownMenuRadioItem>
          {thinking.choices.map(choice => <DropdownMenuRadioItem key={choice.id} value={choice.id}>{choice.label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>}
    {pending && <span className="otis-visually-hidden" role="status">Updating chat settings…</span>}
  </div>;
}
