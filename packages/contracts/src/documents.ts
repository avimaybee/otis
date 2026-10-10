/**
 * @otis/contracts/documents
 * Runtime DTOs and bounds for file ingestion (PDF, text, markdown)
 * and generated documents (authoring, revisions, and PDF rendering).
 */

export const DOCUMENT_BOUNDS = {
  /** Maximum number of document files attached to a single chat message. */
  MAX_PER_MESSAGE: 4,
  /** Maximum byte size for UTF-8 text / Markdown ingestion (2 MiB). */
  MAX_TEXT_BYTES: 2 * 1024 * 1024,
  /** Maximum byte size for PDF ingestion (20 MiB). */
  MAX_DOCUMENT_BYTES: 20 * 1024 * 1024,
  /** Maximum title character length for generated documents. */
  MAX_TITLE_CHARS: 200,
  /** Maximum sections per authoring round. */
  MAX_SECTIONS_PER_ROUND: 16,
  /** Maximum characters per markdown section. */
  MAX_SECTION_CHARS: 64_000,
} as const;

export type DocumentRenderState = 'draft' | 'source_ready' | 'rendering' | 'ready' | 'failed';

export interface GeneratedDocument {
  id: string;
  workspace_id: string;
  author_user_id: string;
  source_chat_id: string;
  run_id: string | null;
  title: string;
  current_revision_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentRevision {
  id: string;
  document_id: string;
  workspace_id: string;
  revision_number: number;
  parent_revision_id: string | null;
  title: string;
  source_key: string;
  checksum: string;
  source_refs_json: string | null;
  render_state: DocumentRenderState;
  output_media_id: string | null;
  render_error: string | null;
  render_attempt_id?: string | null;
  render_attempt_expires_at?: string | null;
  render_attempt_count: number;
  created_at: string;
  updated_at: string;
}

export interface GeneratedDocumentSummary {
  document: GeneratedDocument;
  current_revision: DocumentRevision | null;
}

export interface DocumentDetailResponse {
  document: GeneratedDocument;
  current_revision: DocumentRevision | null;
  revisions: DocumentRevision[];
  source_markdown?: string | null;
}

export interface DocumentListResponse {
  documents: GeneratedDocumentSummary[];
}

export interface DocumentStartArgs {
  title: string;
  intended_sections: string[];
  document_id?: string;
  base_revision_id?: string;
}

export interface DocumentSectionInput {
  id: string;
  title: string;
  content_markdown: string;
}

export interface DocumentWriteSectionArgs {
  document_id: string;
  revision_id: string;
  sections: DocumentSectionInput[];
}

export interface DocumentPublishArgs {
  document_id: string;
  revision_id: string;
  render_pdf?: boolean;
}
