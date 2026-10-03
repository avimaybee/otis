/** Consistent Lucide glyphs. Control wrappers own the hit area and accessible name. */
import { Plus, Menu, SquarePen, Mic, ArrowUp, Square, X, Search, Settings2, ChevronDown, Undo2, Maximize2, Box, Building2, CalendarDays, CircleHelp, AlertCircle, Terminal, FileText, Check, Pencil, Copy, ArrowDown, Brain, AudioLines, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
function icon(Component: LucideIcon, defaultSize = 18) {
  return function Icon({ size = defaultSize }: { size?: number }) { return <Component size={size} strokeWidth={1.75} aria-hidden="true" focusable="false"/>; };
}
export const PlusIcon = icon(Plus, 20);
export const MenuIcon = icon(Menu);
export const ComposeIcon = icon(SquarePen);
export const MicIcon = icon(Mic);
export const SendIcon = icon(ArrowUp, 18);
export const StopIcon = icon(Square, 16);
export const CloseIcon = icon(X);
export const SearchIcon = icon(Search);
export const SettingsIcon = icon(Settings2);
export const ChevronDownIcon = icon(ChevronDown, 16);
export const UndoIcon = icon(Undo2, 16);
export const ExpandIcon = icon(Maximize2, 16);
export const QuestionIcon = icon(CircleHelp, 15);
export const PencilIcon = icon(Pencil, 14);
export const CheckIcon = icon(Check, 13);
export const AlertCircleIcon = icon(AlertCircle, 13);
export const TerminalIcon = icon(Terminal, 13);
export const FileTextIcon = icon(FileText, 13);
export const SearchDocIcon = icon(Search, 13);
export const CopyIcon = icon(Copy, 14);
export const ArrowDownIcon = icon(ArrowDown, 16);
export const BrainIcon = icon(Brain, 15);
export const AudioLinesIcon = icon(AudioLines, 16);
export const ChevronRightIcon = icon(ChevronRight, 15);
export function CommandIcon({ name }: { name: string }) { const Component = ({ model: Box, workspace: Building2, today: CalendarDays, undo: Undo2, help: CircleHelp } as Record<string, LucideIcon>)[name.replace(/^\//, '')] ?? Box; return <Component size={18} strokeWidth={1.75} aria-hidden="true"/>; }
