import { useId, useRef, useState } from 'react';
import type { Chat } from '@otis/contracts';
import { CloseIcon, ComposeIcon, SearchIcon, SettingsIcon } from './icons.js';
import { Overlay } from './Overlay.js';
import { ChoiceSelect } from './ui/select.js';
import { Input } from './ui/input.js';
import { Button } from './ui/button.js';

export interface HistoryNavProps {
  workspaceName: string; workspaces: { id: string; name: string }[]; workspaceId: string;
  ownChats: Chat[]; teamChats: Chat[]; activeChatId: string | null; variant: 'sidebar' | 'drawer';
  members?: Record<string, string>; loading?: boolean;
  onSelectChat: (chatId: string) => void; onNewChat: () => void; onSwitchWorkspace: (workspaceId: string) => void;
  onOpenSettings: () => void; onOpenSearch?: () => void; onClose?: () => void;
  onLoadMore?: () => void; hasMore?: boolean;
}
export function HistoryNav(props: HistoryNavProps) {
  const [searching, setSearching] = useState(false); const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null); const id = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const rows = (chats: Chat[], team: boolean) => chats.filter(chat => chat.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(chat => <button key={chat.id} type="button" className="otis-nav__row" aria-current={chat.id === props.activeChatId ? 'page' : undefined} title={chat.title} onClick={() => props.onSelectChat(chat.id)}><span className="otis-nav__label">{chat.title || 'Untitled conversation'}</span>{team && <span className="otis-nav__author">{chat.author_display_name ?? props.members?.[chat.author_user_id] ?? 'Teammate'}</span>}</button>);
  const content = <nav className={props.variant === 'drawer' ? 'otis-drawer' : 'otis-sidebar'} aria-label="History">
    <div className="otis-nav__brand"><span>Otis</span>{props.variant === 'drawer' && <Button ref={closeButton} variant="ghost" size="icon" className="otis-iconbutton" type="button" aria-label="Close history" onClick={props.onClose}><CloseIcon /></Button>}</div>
    <label className="otis-visually-hidden" htmlFor={`${id}-workspace`}>Workspace</label>
    {props.workspaces.length > 1 ? <ChoiceSelect id={`${id}-workspace`} label="Workspace" className="otis-nav__workspace" value={props.workspaceId} options={props.workspaces.map(workspace => ({ value: workspace.id, label: workspace.name }))} onChange={props.onSwitchWorkspace}/> : <p className="otis-nav__workspace-label">{props.workspaceName}</p>}
    <Button variant="ghost" className="otis-nav__action justify-start" type="button" onClick={props.onNewChat}><ComposeIcon /><span>New chat</span></Button>
    {!searching ? (
      <Button variant="ghost" className="otis-nav__action justify-start" type="button" aria-expanded={false} onClick={() => { setSearching(true); requestAnimationFrame(() => input.current?.focus()); }}><SearchIcon /><span>Search chats</span></Button>
    ) : (
      <div className="otis-nav__search flex items-center gap-1.5"><label className="otis-visually-hidden" htmlFor={`${id}-search`}>Filter chat titles</label><Input ref={input} id={`${id}-search`} type="search" placeholder="Search chat titles" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setSearching(false); setQuery(''); } }} className="flex-1" /><Button variant="ghost" size="icon-xs" type="button" aria-label="Close search" onClick={() => { setSearching(false); setQuery(''); }}><CloseIcon /></Button></div>
    )}
    <div className="otis-nav__history" aria-busy={props.loading}>
      <p className="otis-nav__heading">Your chats</p>{props.ownChats.length ? rows(props.ownChats, false) : <p className="otis-nav__empty">{props.loading ? 'Loading conversations…' : 'No conversations yet'}</p>}
      {props.teamChats.length > 0 && <><p className="otis-nav__heading">Team chats</p>{rows(props.teamChats, true)}</>}
      {query && ![...props.ownChats, ...props.teamChats].some(chat => chat.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <p className="otis-nav__empty">No matching chat titles.</p>}
      {props.hasMore && <Button variant="ghost" className="otis-nav__row w-full justify-start" type="button" onClick={props.onLoadMore}>Load more conversations</Button>}
    </div>
    <div className="otis-nav__footer"><Button variant="ghost" className="otis-nav__action justify-start" type="button" onClick={props.onOpenSettings}><SettingsIcon /><span>Settings</span></Button></div>
  </nav>;
  return props.variant === 'drawer' ? <Overlay initialFocus={closeButton} label="History" className="otis-overlay--drawer" onClose={() => props.onClose?.()}><button type="button" className="otis-drawer__scrim" aria-label="Close history backdrop" onClick={props.onClose} tabIndex={-1}/>{content}</Overlay> : content;
}
