import { useRef, useState } from 'react';
import * as Select from '@radix-ui/react-select';
import { CheckIcon, ChevronDownIcon } from '../icons.js';

// The shadcn/Radix Select composition. Keep portals inside native modal dialogs.
// https://ui.shadcn.com/docs/components/radix/select
export function ChoiceSelect({ id, label, value, options, onChange, disabled = false, className = '' }: {
  id?: string; label: string; value: string; options: { value: string; label: string; disabled?: boolean }[];
  onChange: (value: string) => void; disabled?: boolean; className?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <Select.Root value={value} onValueChange={onChange} disabled={disabled} open={open} onOpenChange={setOpen}>
    <Select.Trigger ref={trigger} id={id} aria-label={label} className={`otis-select ${className}`}><Select.Value placeholder="Choose…"/><Select.Icon><ChevronDownIcon/></Select.Icon></Select.Trigger>
    <Select.Portal container={trigger.current?.closest('dialog') ?? undefined}>
      <Select.Content position="popper" sideOffset={6} collisionPadding={12} className="otis-menu otis-select__menu"><Select.Viewport>
        {options.map(option => <Select.Item key={option.value} value={option.value} disabled={option.disabled} className="otis-menu__item"><Select.ItemText>{option.label}</Select.ItemText><Select.ItemIndicator className="otis-menu__indicator"><CheckIcon/></Select.ItemIndicator></Select.Item>)}
      </Select.Viewport></Select.Content>
    </Select.Portal>
  </Select.Root>;
}
