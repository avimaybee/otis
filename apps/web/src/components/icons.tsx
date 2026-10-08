import {
  Menu, SquarePen, ArrowUp, X, Search, Settings2, ChevronDown, Undo2,
  Terminal, FileText, Check, Pencil, Copy, ArrowDown, AlertCircle,
  SlidersHorizontal, Mic, Play, Pause, MoreVertical, Trash2, Plus,
  Table, Filter, Sparkles, History, Save, Redo2, LayoutList,
  Calculator, Calendar, DollarSign, Phone, Hash, Type, Download
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
function icon(Component: LucideIcon, defaultSize = 18) {
  return function Icon({ size = defaultSize, className }: { size?: number; className?: string }) { return <Component size={size} strokeWidth={2} aria-hidden="true" focusable="false" className={className}/> };
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
export const TableIcon = icon(Table, 16);
export const FilterIcon = icon(Filter, 16);
export const SparklesIcon = icon(Sparkles, 16);
export const HistoryIcon = icon(History, 16);
export const SaveIcon = icon(Save, 16);
export const RedoIcon = icon(Redo2, 16);
export const LayoutListIcon = icon(LayoutList, 16);
export const CalculatorIcon = icon(Calculator, 14);
export const CalendarIcon = icon(Calendar, 14);
export const DollarIcon = icon(DollarSign, 14);
export const PhoneIcon = icon(Phone, 14);
export const HashIcon = icon(Hash, 14);
export const TypeIcon = icon(Type, 14);
export const DownloadIcon = icon(Download, 16);


