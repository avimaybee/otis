import type { ComponentProps } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { CheckIcon } from '../icons.js';

// Owned shadcn/Radix composition, styled with Otis's existing semantic tokens.
// https://ui.shadcn.com/docs/components/radix/dropdown-menu
export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuRadioGroup = Menu.RadioGroup;
export function DropdownMenuContent({ children, className = '', ...props }: ComponentProps<typeof Menu.Content>) {
  return <Menu.Portal><Menu.Content sideOffset={6} collisionPadding={12} className={`otis-menu ${className}`} {...props}>{children}</Menu.Content></Menu.Portal>;
}
export function DropdownMenuRadioItem({ children, className = '', ...props }: ComponentProps<typeof Menu.RadioItem>) {
  return <Menu.RadioItem className={`otis-menu__item ${className}`} {...props}><span className="otis-menu__label">{children}</span><Menu.ItemIndicator className="otis-menu__indicator"><CheckIcon/></Menu.ItemIndicator></Menu.RadioItem>;
}
