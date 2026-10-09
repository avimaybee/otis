import { useState, useEffect, useRef } from 'react';
import type { UnifiedSearchResponse, UnifiedSearchResultItem } from '@otis/contracts';
import { api } from '../api/client.js';
import { Overlay } from './Overlay.js';
import { Input } from './ui/input.js';
import { Button } from './ui/button.js';
import {
  SearchIcon,
  CloseIcon,
  FileTextIcon,
  SearchDocIcon,
} from './icons.js';

export interface UnifiedSearchDialogProps {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  onOpenChat?: (chatId: string) => void;
  onOpenClientFile?: (entityId: string) => void;
  onOpenRecords?: () => void;
  onSelectResult?: (item: UnifiedSearchResultItem) => void;
}

export function UnifiedSearchDialog({
  workspaceId,
  open,
  onClose,
  onOpenChat,
  onOpenClientFile,
  onOpenRecords,
  onSelectResult,
}: UnifiedSearchDialogProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UnifiedSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        // Toggle search
        if (open) {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      setLoading(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    const timer = setTimeout(() => {
      api
        .unifiedSearch(workspaceId, query.trim(), 5, controller.signal)
        .then((res) => {
          setResults(res);
          setLoading(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setLoading(false);
        });
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [workspaceId, query]);

  if (!open) return null;

  const handleItemClick = (item: UnifiedSearchResultItem) => {
    onClose();
    if (onSelectResult) {
      onSelectResult(item);
      return;
    }
    if (item.category === 'chat' && item.chatId) {
      onOpenChat?.(item.chatId);
    } else if (item.entityId && onOpenClientFile) {
      onOpenClientFile(item.entityId);
    } else if (item.category === 'entity' && onOpenRecords) {
      onOpenRecords();
    }
  };

  const hasAnyResults = results && results.total_matches > 0;

  return (
    <Overlay label="Unified Workspace Search" className="otis-overlay--dialog" onClose={onClose}>
      <div className="otis-dialog-card max-w-2xl w-full flex flex-col overflow-hidden">
        <header className="otis-dialog-card__header flex items-center justify-between border-b border-border p-3 shrink-0">
          <div className="flex items-center gap-2 flex-1 mr-2">
            <SearchIcon />
            <Input
              ref={inputRef}
              type="search"
              placeholder="Search clients, notes, quotes, tasks, files, and chats…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="border-0 focus-visible:ring-0 shadow-none text-base h-9 px-2"
              aria-label="Search across workspace"
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            className="otis-iconbutton shrink-0"
            aria-label="Close search"
            onClick={onClose}
          >
            <CloseIcon />
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {loading && (
            <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
              <SearchDocIcon />
              <span className="ml-2">Searching workspace…</span>
            </div>
          )}

          {!loading && !query.trim() && (
            <div className="py-8 text-center text-muted-foreground text-sm space-y-1">
              <p className="font-medium text-foreground">One search for everything</p>
              <p>Type a client name, contact detail, quote amount, task, or note topic.</p>
              <p className="text-xs text-subtle pt-2">Shortcut: Ctrl+K / ⌘K</p>
            </div>
          )}

          {!loading && query.trim() && !hasAnyResults && (
            <div className="py-8 text-center text-muted-foreground text-sm">
              No results found for &ldquo;{query}&rdquo; across clients, notes, quotes, tasks, files, or chats.
            </div>
          )}

          {!loading && results && hasAnyResults && (
            <div className="space-y-4">
              {/* Clients & Entities */}
              {results.categories.entities.length > 0 && (
                <section>
                  <h3 className="text-xs font-medium text-muted-foreground mb-2">
                    Clients &amp; Businesses ({results.categories.entities.length})
                  </h3>
                  <div className="space-y-1">
                    {results.categories.entities.map((item) => (
                      <button
                        key={`ent-${item.id}`}
                        type="button"
                        onClick={() => handleItemClick(item)}
                        className="w-full text-left p-2 rounded-md hover:bg-muted/50 border border-transparent hover:border-border transition-colors flex items-center justify-between"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
                          {item.detail && <p className="text-xs text-muted-foreground truncate">{item.detail}</p>}
                        </div>
                        <span className="text-xs text-subtle shrink-0 ml-2">View details →</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {/* Quotes & Financials */}
              {results.categories.quotes.length > 0 && (
                <section>
                  <h3 className="text-xs font-medium text-muted-foreground mb-2">
                    Quotes &amp; Budgets ({results.categories.quotes.length})
                  </h3>
                  <div className="space-y-1">
                    {results.categories.quotes.map((item) => (
                      <button
                        key={`quote-${item.id}`}
                        type="button"
                        onClick={() => handleItemClick(item)}
                        className="w-full text-left p-2 rounded-md hover:bg-muted/50 border border-transparent hover:border-border transition-colors flex items-center justify-between"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
                          {item.detail && <p className="text-xs text-muted-foreground truncate">{item.detail}</p>}
                        </div>
                        {item.date && <span className="text-xs text-subtle shrink-0 ml-2">{item.date}</span>}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {/* Notes & Logs */}
              {results.categories.notes.length > 0 && (
                <section>
                  <h3 className="text-xs font-medium text-muted-foreground mb-2">
                    Notes &amp; Logs ({results.categories.notes.length})
                  </h3>
                  <div className="space-y-1">
                    {results.categories.notes.map((item) => (
                      <button
                        key={`note-${item.id}`}
                        type="button"
                        onClick={() => handleItemClick(item)}
                        className="w-full text-left p-2 rounded-md hover:bg-muted/50 border border-transparent hover:border-border transition-colors flex items-center justify-between"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
                          {item.detail && <p className="text-xs text-muted-foreground truncate">{item.detail}</p>}
                        </div>
                        {item.date && <span className="text-xs text-subtle shrink-0 ml-2">{item.date}</span>}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {/* Tasks & Follow-ups */}
              {results.categories.tasks.length > 0 && (
                <section>
                  <h3 className="text-xs font-medium text-muted-foreground mb-2">
                    Next Actions &amp; Tasks ({results.categories.tasks.length})
                  </h3>
                  <div className="space-y-1">
                    {results.categories.tasks.map((item) => (
                      <button
                        key={`task-${item.id}`}
                        type="button"
                        onClick={() => handleItemClick(item)}
                        className="w-full text-left p-2 rounded-md hover:bg-muted/50 border border-transparent hover:border-border transition-colors flex items-center justify-between"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
                          {item.detail && <p className="text-xs text-muted-foreground truncate">{item.detail}</p>}
                        </div>
                        <span className="text-xs text-subtle shrink-0 ml-2">Inspect →</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {/* Files */}
              {results.categories.files.length > 0 && (
                <section>
                  <h3 className="text-xs font-medium text-muted-foreground mb-2">
                    Files &amp; Attachments ({results.categories.files.length})
                  </h3>
                  <div className="space-y-1">
                    {results.categories.files.map((item) => (
                      <button
                        key={`file-${item.id}`}
                        type="button"
                        onClick={() => handleItemClick(item)}
                        className="w-full text-left p-2 rounded-md hover:bg-muted/50 border border-transparent hover:border-border transition-colors flex items-center justify-between"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <FileTextIcon />
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
                            {item.detail && <p className="text-xs text-muted-foreground truncate">{item.detail}</p>}
                          </div>
                        </div>
                        <span className="text-xs text-subtle shrink-0 ml-2">Open →</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {/* Conversations */}
              {results.categories.chats.length > 0 && (
                <section>
                  <h3 className="text-xs font-medium text-muted-foreground mb-2">
                    Conversations ({results.categories.chats.length})
                  </h3>
                  <div className="space-y-1">
                    {results.categories.chats.map((item) => (
                      <button
                        key={`chat-${item.id}`}
                        type="button"
                        onClick={() => handleItemClick(item)}
                        className="w-full text-left p-2 rounded-md hover:bg-muted/50 border border-transparent hover:border-border transition-colors flex items-center justify-between"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
                          {item.snippet && <p className="text-xs text-muted-foreground truncate">{item.snippet}</p>}
                        </div>
                        {item.date && <span className="text-xs text-subtle shrink-0 ml-2">{item.date}</span>}
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </Overlay>
  );
}
