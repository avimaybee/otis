/**
 * @otis/contracts/search
 * Unified workspace search DTOs for finding entities, notes, quotes, tasks, files, and chats.
 */

export interface UnifiedSearchResultItem {
  id: string;
  category: 'entity' | 'note' | 'quote' | 'task' | 'file' | 'chat';
  title: string;
  snippet?: string;
  detail?: string;
  date?: string;
  entityId?: string;
  entityName?: string;
  chatId?: string;
  messageId?: string;
}

export interface UnifiedSearchResponse {
  query: string;
  categories: {
    entities: UnifiedSearchResultItem[];
    notes: UnifiedSearchResultItem[];
    quotes: UnifiedSearchResultItem[];
    tasks: UnifiedSearchResultItem[];
    files: UnifiedSearchResultItem[];
    chats: UnifiedSearchResultItem[];
  };
  total_matches: number;
}
