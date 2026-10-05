import { Menu, SquarePen, ArrowUp, X, Search, Settings2, ChevronDown, Undo2, Terminal, FileText, Check, Pencil, Copy, ArrowDown, AlertCircle, SlidersHorizontal, Mic, Play, Pause, MoreVertical, Trash2, Plus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
function icon(Component: LucideIcon, defaultSize = 18) {
  return function Icon({ size = defaultSize }: { size?: number }) { return <Component size={size} strokeWidth={2} aria-hidden="true" focusable="false"/>; };
}
export const MenuIcon = icon(Menu);
export const ComposeIcon = icon(SquarePen);
export const SendIcon = icon(ArrowUp, 18);
/** Stop is a 12px filled square in the same 36px slot as Send. */
export function StopIcon() { return <span aria-hidden="true" className="otis-stop-square" />; }
export const CloseIcon = icon(X);
export const SearchIcon = icon(Search);
export const SettingsIcon = icon(Settings2);
export const OverflowIcon = icon(SlidersHorizontal);
export const ChevronDownIcon = icon(ChevronDown, 16);
export const UndoIcon = icon(Undo2, 16);
export const CheckIcon = icon(Check, 16);
export const AlertCircleIcon = icon(AlertCircle, 16);
export const TerminalIcon = icon(Terminal, 16);
export const FileTextIcon = icon(FileText, 16);
export const SearchDocIcon = icon(Search, 16);
export const CopyIcon = icon(Copy, 16);
export const PencilIcon = icon(Pencil, 16);
export const ArrowDownIcon = icon(ArrowDown, 16);
export const MicIcon = icon(Mic, 18);
export const PlayIcon = icon(Play, 18);
export const PauseIcon = icon(Pause, 18);
export const MoreVerticalIcon = icon(MoreVertical, 16);
export const TrashIcon = icon(Trash2, 16);
export const PlusIcon = icon(Plus, 16);

