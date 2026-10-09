import { useEffect, useId, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { Drawer } from 'vaul';
import type { Chat } from '@otis/contracts';
import { CloseIcon, ComposeIcon, MoreVerticalIcon, SearchIcon, SettingsIcon, TableIcon } from './icons.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu.js';
import { ChoiceSelect } from './ui/select.js';
import { Button } from './ui/button.js';
import { useOverlayHistory } from './overlay-history.js';

export interface HistoryNavProps {
  userId?: string;
  workspaceName: string; workspaces: { id: string; name: string }[]; workspaceId: string;
  ownChats: Chat[]; teamChats: Chat[]; activeChatId: string | null; variant: 'sidebar' | 'drawer';
  /** Controlled drawer state; the Vaul drawer stays mounted so its graceful
      close lifecycle (focus return, exit) runs instead of an abrupt unmount. */
  open?: boolean;
  members?: Record<string, string>; loading?: boolean;
  isRecordsActive?: boolean;
  onSelectChat: (chatId: string) => void; onNewChat: () => void; onOpenRecords?: () => void; onSwitchWorkspace: (workspaceId: string) => void;
  onOpenSettings: () => void; onOpenSearch?: () => void; onClose?: () => void;
  onLoadMore?: () => void; hasMore?: boolean;
  onRenameChat?: (chatId: string, currentTitle: string) => void;
  onDeleteChat?: (chatId: string, currentTitle: string) => void;
  onCreateWorkspace?: () => void;
}

export function HistoryNav(props: HistoryNavProps) {
  const id = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const isDrawer = props.variant === 'drawer';

  // Defensively filter team chats so the acting user's own chats never leak into the team list
  const filteredTeamChats = useMemo(() => {
    return props.teamChats.filter(chat => !props.userId || chat.author_user_id !== props.userId);
  }, [props.teamChats, props.userId]);

  const primaryName = (props.userId && props.members?.[props.userId]) ? props.members[props.userId] : undefined;
  const displayName = primaryName || 'Account';
  const avatarInitial = (primaryName || 'O').charAt(0).toUpperCase();

  const rows = (chats: Chat[], team: boolean) => chats.map(chat => (
    <div key={chat.id} className="relative flex items-center group w-full">
      <button
        type="button"
        className="otis-nav__row pr-8"
        aria-current={chat.id === props.activeChatId ? 'page' : undefined}
        title={chat.title}
        onClick={() => {
          if (isDrawer) props.onClose?.();
          props.onSelectChat(chat.id);
        }}
      >
        <span className="otis-nav__label text-nav">{chat.title || 'Untitled conversation'}</span>
        {team && <span className="otis-nav__author text-xs">{chat.author_display_name ?? props.members?.[chat.author_user_id] ?? 'Teammate'}</span>}
      </button>
      {!team && (props.onRenameChat || props.onDeleteChat) && (
        <div className={`absolute right-2 ${isDrawer ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'} transition-opacity`}>
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

  const content = (
    <nav className={isDrawer ? 'otis-drawer__nav' : 'otis-sidebar'} aria-label="History">
      <div className="otis-nav__brand">
        <span className="text-base">Otis</span>
        <div className="flex items-center gap-1">
          {props.onOpenSearch && (
            <Button
              variant="ghost"
              size="icon"
              className="otis-iconbutton"
              type="button"
              aria-label="Search"
              onClick={() => {
                if (isDrawer) props.onClose?.();
                props.onOpenSearch?.();
              }}
            >
              <SearchIcon />
            </Button>
          )}
          {isDrawer && (
            <Button
              ref={closeButton}
              variant="ghost"
              size="icon"
              className="otis-iconbutton"
              type="button"
              aria-label="Close history"
              onClick={props.onClose}
            >
              <CloseIcon />
            </Button>
          )}
        </div>
      </div>

      <Button
        variant="ghost"
        className="otis-nav__action justify-start text-sm"
        type="button"
        onClick={() => {
          if (isDrawer) props.onClose?.();
          props.onNewChat();
        }}
      >
        <ComposeIcon />
        <span>New chat</span>
      </Button>

      {props.onOpenRecords && (
        <Button
          variant="ghost"
          className="otis-nav__action justify-start text-sm"
          type="button"
          aria-current={props.isRecordsActive ? 'page' : undefined}
          onClick={() => {
            if (isDrawer) props.onClose?.();
            props.onOpenRecords?.();
          }}
        >
          <TableIcon />
          <span>Your information</span>
        </Button>
      )}

      <label className="otis-visually-hidden" htmlFor={`${id}-workspace`}>Workspace</label>
      <div className="flex items-center justify-between px-4 pb-1">
        {props.workspaces.length > 1 ? (
          <ChoiceSelect
            id={`${id}-workspace`}
            label="Workspace"
            className="otis-nav__workspace flex-1 mr-2"
            value={props.workspaceId}
            options={props.workspaces.map(workspace => ({ value: workspace.id, label: workspace.name }))}
            onChange={props.onSwitchWorkspace}
          />
        ) : (
          <p className="otis-nav__workspace-label text-sm flex-1 m-0 p-0 text-muted-foreground">{props.workspaceName}</p>
        )}
        {props.onCreateWorkspace && (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground h-6 px-2 shrink-0"
            title="Create workspace"
            aria-label="Create workspace"
            onClick={props.onCreateWorkspace}
          >
            + New
          </Button>
        )}
      </div>

      <div className="otis-nav__history" aria-busy={props.loading}>
        <p className="otis-nav__heading text-xs">Your chats</p>
        {props.ownChats.length ? rows(props.ownChats, false) : (
          <p className="otis-nav__empty text-sm">{props.loading ? 'Loading conversations…' : 'No conversations yet'}</p>
        )}
        {filteredTeamChats.length > 0 && (
          <>
            <p className="otis-nav__heading text-xs">Team chats</p>
            {rows(filteredTeamChats, true)}
          </>
        )}
        {props.hasMore && (
          <Button variant="ghost" className="otis-nav__row w-full justify-start text-sm" type="button" onClick={props.onLoadMore}>
            Load more conversations
          </Button>
        )}
      </div>

      <div className="otis-nav__footer">
        <div className="flex items-center justify-between px-4 pb-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="size-8 rounded-full bg-accent text-foreground flex items-center justify-center font-medium text-xs shrink-0" aria-hidden="true">
              {avatarInitial}
            </span>
            <div className="flex flex-col min-w-0 leading-tight">
              <span className="text-sm font-medium text-foreground truncate">{displayName}</span>
              <span className="text-xs text-muted-foreground truncate">{props.workspaceName}</span>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground h-8 px-2 shrink-0 flex items-center gap-1"
            onClick={() => {
              if (isDrawer) props.onClose?.();
              props.onOpenSettings();
            }}
          >
            <SettingsIcon />
            <span>Settings</span>
          </Button>
        </div>
      </div>
    </nav>
  );

  return isDrawer
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
  }, [open]);
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
