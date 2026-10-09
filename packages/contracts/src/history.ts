export interface SearchWorkspaceHistoryArgs {
  query: string; chat_id?: string; entity_id?: string; author_user_id?: string;
  from?: string; to?: string; source_kind?: 'member' | 'otis' | 'system';
  mode?: 'relevance' | 'chronological'; limit?: number; cursor?: string;
}
export interface HistorySearchHit {
  message_id: string; inbound_message_id: string | null; chat_id: string; chat_title: string | null;
  author_user_id: string | null; author_name: string | null; source_kind: 'member' | 'otis' | 'system';
  recorded_at: string; sequence: number; excerpt: string; source_available: boolean;
}
export interface HistorySearchResponse {
  version: 1; items: HistorySearchHit[]; total: number; next_cursor: string | null;
  has_more: boolean; coverage: { mode: 'relevance' | 'chronological'; bounded: boolean; index_complete: boolean };
}
export interface WorkspaceMessageSource {
  id: string; chat_id: string | null; author_name: string | null; author_user_id: string | null;
  text: string; recorded_at: string; channel: string; sequence: number | null;
  context: { id: string; text: string; author_name: string | null; author_kind: string; sequence: number }[];
}
