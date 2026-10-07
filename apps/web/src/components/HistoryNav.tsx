import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Drawer } from 'vaul';
import type { Chat } from '@otis/contracts';
import { CloseIcon, ComposeIcon, MoreVerticalIcon, SearchIcon, SettingsIcon } from './icons.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu.js';
import { ChoiceSelect } from './ui/select.js';
import { Input } from './ui/input.js';
import { Button } from './ui/button.js';
import { useOverlayHistory } from './overlay-history.js';

export interface HistoryNavProps {
  workspaceName: string; workspaces: { id: string; name: string }[]; workspaceId: string;
  ownChats: Chat[]; teamChats: Chat[]; activeChatId: string | null; variant: 'sidebar' | 'drawer';
  /** Controlled drawer state; the Vaul drawer stays mounted so its graceful
      close lifecycle (focus return, exit) runs instead of an abrupt unmount. */
  open?: boolean;
  members?: Record<string, string>; loading?: boolean;
  onSelectChat: (chatId: string) => void; onNewChat: () => void; onSwitchWorkspace: (workspaceId: string) => void;
  onOpenSettings: () => void; onOpenSearch?: () => void; onClose?: () => void;
  onLoadMore?: () => void; hasMore?: boolean;
  onRenameChat?: (chatId: string, currentTitle: string) => void;
  onDeleteChat?: (chatId: string, currentTitle: string) => void;
  onCreateWorkspace?: () => void;
}
export function HistoryNav(props: HistoryNavProps) {
  const [searching, setSearching] = useState(false); const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null); const id = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const closeSearch = () => {
    setSearching(false);
    setQuery('');
    requestAnimationFrame(() => searchButton.current?.focus());
  };
  const rows = (chats: Chat[], team: boolean) => chats.filter(chat => chat.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(chat => (
    <div key={chat.id} className="relative flex items-center group w-full">
      <button type="button" className="otis-nav__row pr-8" aria-current={chat.id === props.activeChatId ? 'page' : undefined} title={chat.title} onClick={() => props.onSelectChat(chat.id)}>
        <span className="otis-nav__label text-base">{chat.title || 'Untitled conversation'}</span>
        {team && <span className="otis-nav__author text-xs">{chat.author_display_name ?? props.members?.[chat.author_user_id] ?? 'Teammate'}</span>}
      </button>
      {!team && (props.onRenameChat || props.onDeleteChat) && (
        <div className={`absolute right-2 ${props.variant === 'drawer' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'} transition-opacity`}>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" type="button" className="otis-nav__options-btn size-8 p-0 text-muted-foreground hover:text-foreground" aria-label={`Options for ${chat.title || 'conversation'}`}>
                <MoreVerticalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom">
              {props.onRenameChat && <DropdownMenuItem onSelect={() => props.onRenameChat!(chat.id, chat.title)}>Rename</DropdownMenuItem>}
              {props.onDeleteChat && <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => props.onDeleteChat!(chat.id, chat.title)}>Delete</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  ));
  const content = <nav className={props.variant === 'drawer' ? 'otis-drawer__nav' : 'otis-sidebar'} aria-label="History">
    <div className="otis-nav__brand"><span className="text-base">Otis</span>{props.variant === 'drawer' && <Button ref={closeButton} variant="ghost" size="icon" className="otis-iconbutton" type="button" aria-label="Close history" onClick={props.onClose}><CloseIcon /></Button>}</div>
    <label className="otis-visually-hidden" htmlFor={`${id}-workspace`}>Workspace</label>
    <div className="flex items-center justify-between px-4 pb-2">
      {props.workspaces.length > 1 ? <ChoiceSelect id={`${id}-workspace`} label="Workspace" className="otis-nav__workspace flex-1 mr-2" value={props.workspaceId} options={props.workspaces.map(workspace => ({ value: workspace.id, label: workspace.name }))} onChange={props.onSwitchWorkspace}/> : <p className="otis-nav__workspace-label text-base flex-1 m-0 p-0">{props.workspaceName}</p>}
      {props.onCreateWorkspace && <Button variant="ghost" size="sm" type="button" className="text-xs text-muted-foreground hover:text-foreground h-6 px-2 shrink-0" title="Create workspace" aria-label="Create workspace" onClick={props.onCreateWorkspace}>+ New</Button>}
    </div>
    <Button variant="ghost" className="otis-nav__action justify-start text-sm" type="button" onClick={props.onNewChat}><ComposeIcon /><span>New chat</span></Button>
    {!searching ? (
      <Button ref={searchButton} variant="ghost" className="otis-nav__action justify-start text-sm" type="button" aria-expanded={false} onClick={() => { setSearching(true); requestAnimationFrame(() => input.current?.focus()); }}><SearchIcon /><span>Filter loaded chats</span></Button>
    ) : (
      <div className="otis-nav__search flex items-center gap-2"><label className="otis-visually-hidden" htmlFor={`${id}-search`}>Filter loaded chats</label><Input ref={input} id={`${id}-search`} type="search" placeholder="Filter loaded chats" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearch(); } }} className="flex-1" /><Button variant="ghost" size="icon-xs" type="button" aria-label="Close search" onClick={closeSearch}><CloseIcon /></Button></div>
    )}
    <div className="otis-nav__history" aria-busy={props.loading}>
      <p className="otis-nav__heading text-xs">Your chats</p>{props.ownChats.length ? rows(props.ownChats, false) : <p className="otis-nav__empty text-sm">{props.loading ? 'Loading conversations…' : 'No conversations yet'}</p>}
      {props.teamChats.length > 0 && <><p className="otis-nav__heading text-xs">Team chats</p>{rows(props.teamChats, true)}</>}
      {query && ![...props.ownChats, ...props.teamChats].some(chat => chat.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (
        <p className="otis-nav__empty text-sm">
          {props.hasMore ? 'No matches in loaded conversations. Try loading older history below.' : 'No matching chat titles.'}
        </p>
      )}
      {props.hasMore && <Button variant="ghost" className="otis-nav__row w-full justify-start text-sm" type="button" onClick={props.onLoadMore}>Load more conversations</Button>}
    </div>
    <div className="otis-nav__footer"><Button variant="ghost" className="otis-nav__action justify-start text-sm" type="button" onClick={props.onOpenSettings}><SettingsIcon /><span>Settings</span></Button></div>
  </nav>;
  return props.variant === 'drawer'
    ? <HistoryDrawer open={props.open ?? false} onClose={() => props.onClose?.()} initialFocus={closeButton}>{content}</HistoryDrawer>
    : content;
}

/**
 * Mobile history drawer on the Vaul primitive with the approved drawer
 * recipe. Focus trap, Escape, backdrop/slide dismissal and return focus
 * come from the shared Vaul/Radix behavior; Back handling and marker
 * ownership come from the single shared overlay-history hook also used by
 * Overlay dialogs. No parallel native-dialog drawer beside it.
 */
function HistoryDrawer({ open, onClose, initialFocus, children }: { open: boolean; onClose: () => void; initialFocus?: RefObject<HTMLElement | null>; children: ReactNode }) {
  useOverlayHistory('History', open, onClose);
  // Deterministic return focus: Vaul/Radix restores the trigger on a
  // graceful close, and this covers the same target when exit completion
  // cannot run (or a test environment never finishes it).
  const previousRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open) {
      previousRef.current = document.activeElement as HTMLElement | null;
      wasOpenRef.current = true;
      return;
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      const previous = previousRef.current;
      previousRef.current = null;
      try { previous?.focus?.(); } catch { /* Focus return is best-effort. */ }
    }
  }, [open ]);
  return (
    <Drawer.Root open={open} onOpenChange={next => { if (!next) onClose(); }} modal direction="left">
      <Drawer.Portal>
        <Drawer.Overlay className="otis-drawer-scrim" />
        <Drawer.Content
          aria-label="History"
          className="otis-drawer"
          onOpenAutoFocus={event => {
            event.preventDefault();
            initialFocus?.current?.focus();
          }}
        >
          <Drawer.Title className="otis-visually-hidden">History</Drawer.Title>
          {children}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
