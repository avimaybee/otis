/**
 * @otis/worker/media/generatedDocuments
 * Core domain service for document authoring, multi-revision management,
 * and asynchronous PDF generation lifecycle.
 */

import type { Env } from '../index.js';
import type {
  DocumentDetailResponse,
  DocumentListResponse,
  DocumentRevision,
  GeneratedDocument,
  GeneratedDocumentSummary,
} from '@otis/contracts';
import { DOCUMENT_BOUNDS } from '@otis/contracts';
import { renderDocumentToPdf } from './pdfRenderer.js';

interface DraftPayload {
  title: string;
  intended_sections: string[];
  sections: Array<{ id: string; title: string; content_markdown: string }>;
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadParentSections(
  env: Env,
  workspaceId: string,
  docId: string,
  parentRevId: string | null,
): Promise<Array<{ id: string; title: string; content_markdown: string }>> {
  if (!parentRevId || !env.STORAGE) return [];
  const parentRev = await env.DB.prepare(
    `SELECT id, document_id, source_key FROM document_revisions WHERE id = ? AND workspace_id = ?`
  )
    .bind(parentRevId, workspaceId)
    .first<{ id: string; document_id: string; source_key: string }>();
  if (!parentRev) throw new Error('Base revision not found in this workspace.');
  if (parentRev.document_id !== docId) throw new Error('Base revision belongs to another document.');

  // The structured manifest written at publish time is authoritative;
  // markdown parsing is only a legacy fallback for older revisions.
  const manifestKey = `${workspaceId}/documents/${docId}/rev-${parentRevId}-manifest.json`;
  try {
    const manifestObj = await env.STORAGE.get(manifestKey);
    if (manifestObj) {
      const manifest = await manifestObj.json<{ sections?: Array<{ id: string; title: string; content_markdown: string }> }>();
      if (Array.isArray(manifest.sections)) {
        const sections = manifest.sections
          .filter((s) => s && typeof s.id === 'string' && typeof s.title === 'string')
          .map((s) => ({ id: s.id, title: s.title, content_markdown: typeof s.content_markdown === 'string' ? s.content_markdown : '' }));
        if (sections.length > 0) return sections;
      }
    }
  } catch {
    // Fall through to the markdown fallback below.
  }
  if (parentRev.source_key) {
    const parentObj = await env.STORAGE.get(parentRev.source_key);
    if (parentObj) {
      const parentMd = await parentObj.text();
      const parts = parentMd.split(/\n(?=## )/);
      return parts.map((part, idx) => {
        const hMatch = /^## ([^\n]+)\n*([\s\S]*)$/.exec(part);
        if (hMatch && hMatch[1]) {
          const secTitle = hMatch[1].trim();
          const secId = 'sec-' + secTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          return { id: secId, title: secTitle, content_markdown: (hMatch[2] ?? '').trim() };
        }
        return { id: `sec-${idx}`, title: `Section ${idx + 1}`, content_markdown: part.trim() };
      });
    }
  }
  return [];
}

export async function startDocument(
  env: Env,
  workspaceId: string,
  userId: string,
  chatId: string,
  runId: string | null,
  args: {
    title: string;
    intended_sections: string[];
    document_id?: string;
    base_revision_id?: string;
    idempotency_key?: string;
  }
): Promise<{
  document_id: string;
  revision_id: string;
  revision_number: number;
  title: string;
  parent_revision_id: string | null;
  intended_sections: string[];
}> {
  if (!env.STORAGE) throw new Error('File storage is unavailable.');
  const title = (args.title || 'Untitled Document').trim().slice(0, DOCUMENT_BOUNDS.MAX_TITLE_CHARS);
  if (!title) throw new Error('Document title is required.');

  const now = new Date().toISOString();
  const safeIdem = args.idempotency_key
    ? args.idempotency_key.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
    : '';
  const revisionId = safeIdem ? `rev_${safeIdem}` : `rev_${crypto.randomUUID()}`;
  const docId = args.document_id ?? (safeIdem ? `doc_${safeIdem}` : `doc_${crypto.randomUUID()}`);
  let parentRevId: string | null = args.base_revision_id ?? null;
  let baseSections: Array<{ id: string; title: string; content_markdown: string }> = [];

  // The request fingerprint durably binds the immutable start intent
  // (document, explicit base argument, title, intended sections) to the
  // revision row, so replay can validate full intent without trusting R2
  // draft bytes. The explicit base argument travels instead of the derived
  // parent so a moved current pointer can never false-reject an identical
  // retry.
  const fingerprint = await sha256Hex(JSON.stringify({
    document_id: docId,
    base_revision_id: args.base_revision_id ?? null,
    title,
    intended_sections: args.intended_sections,
  }));

  // Immutable request replay resolves before any new state is derived: the
  // same trusted identity always returns the same revision, even when the
  // document's current pointer has since moved on. A fingerprint mismatch
  // means identity reuse with different content and is rejected.
  if (safeIdem) {
    const prior = await env.DB.prepare(
      `SELECT id, document_id, revision_number, parent_revision_id, title, request_fingerprint FROM document_revisions WHERE id = ? AND workspace_id = ?`
    ).bind(revisionId, workspaceId).first<{
      id: string; document_id: string; revision_number: number; parent_revision_id: string | null; title: string; request_fingerprint: string | null;
    }>();
    if (prior) {
      // Fail closed: a null fingerprint is a legacy row that predates
      // durable intent binding, so it can never match — replaying it must
      // mint a new action, never restore bytes from caller arguments.
      if (prior.document_id !== docId || prior.title !== title ||
        prior.request_fingerprint !== fingerprint) {
        throw new Error('Document request identity was reused with different content. Retry with a new action.');
      }
      parentRevId = prior.parent_revision_id;
      baseSections = await loadParentSections(env, workspaceId, docId, parentRevId);
      const draftKey = `${workspaceId}/documents/${docId}/rev-${revisionId}-draft.json`;
      const draftObj = await env.STORAGE.get(draftKey);
      if (draftObj) {
        const draft = await draftObj.json<DraftPayload>();
        const sameIntent = JSON.stringify(draft.intended_sections ?? []) === JSON.stringify(args.intended_sections);
        if (!sameIntent) {
          throw new Error('Document request identity was reused with different content. Retry with a new action.');
        }
      } else {
        // The winner reserved the identity but never wrote its draft
        // (crash between reservation and upload): restore deterministically
        // from these fingerprint-validated identical arguments loaded under
        // the winner's stored parent, never overwriting bytes.
        await env.STORAGE.put(draftKey, JSON.stringify({ title, intended_sections: args.intended_sections, sections: baseSections }), {
          httpMetadata: { contentType: 'application/json' },
        });
      }
      return {
        document_id: docId,
        revision_id: revisionId,
        revision_number: prior.revision_number,
        title: prior.title,
        parent_revision_id: prior.parent_revision_id,
        intended_sections: args.intended_sections,
      };
    }
  }

  if (args.document_id) {
    // Verifying existing document
    const existingDoc = await env.DB.prepare(
      `SELECT d.*, r.id as cur_rev_id, r.revision_number, r.source_key
       FROM generated_documents d
       LEFT JOIN document_revisions r ON r.id = d.current_revision_id
       WHERE d.id = ? AND d.workspace_id = ?`
    )
      .bind(docId, workspaceId)
      .first<{ id: string; current_revision_id: string | null; revision_number: number | null; source_key: string | null }>();

    if (!existingDoc) throw new Error('Document not found in this workspace.');

    parentRevId = parentRevId ?? existingDoc.current_revision_id;

    if (parentRevId) {
      // Validates the base revision and inherits its structured sections.
      baseSections = await loadParentSections(env, workspaceId, docId, parentRevId);
    }
  } else {
    let validRunId: string | null = null;
    if (runId) {
      const runRow = await env.DB.prepare(
        `SELECT id FROM agent_runs WHERE id = ? AND workspace_id = ?`
      ).bind(runId, workspaceId).first<{ id: string }>();
      if (runRow) {
        validRunId = runRow.id;
      }
    }
    await env.DB.prepare(
      `INSERT INTO generated_documents (id, workspace_id, author_user_id, source_chat_id, run_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
      .bind(docId, workspaceId, userId, chatId, validRunId, title, now, now)
      .run();
  }

  // The revision number allocates inside the INSERT from the committed
  // maximum, guarded by NOT EXISTS on the request identity: concurrent
  // callers serialize, so two drafts from one base receive distinct numbers
  // and a lost duplicate insert resolves through the replay check below.
  // The reservation commits before any draft bytes are written, so only the
  // reservation winner ever writes this revision's draft key.
  const inserted = await env.DB.prepare(
    `INSERT INTO document_revisions (
       id, document_id, workspace_id, revision_number, parent_revision_id,
       title, source_key, checksum, request_fingerprint, render_state, created_at, updated_at
     )
     SELECT ?, ?, ?, COALESCE((SELECT MAX(revision_number) FROM document_revisions WHERE document_id = ? AND workspace_id = ?), 0) + 1, ?, ?, ?, ?, ?, 'draft', ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM document_revisions WHERE id = ? AND workspace_id = ?)`
  )
    .bind(
      revisionId, docId, workspaceId, docId, workspaceId,
      parentRevId, title, `${workspaceId}/documents/${docId}/rev-${revisionId}-draft.json`, '', fingerprint, now, now,
      revisionId, workspaceId,
    )
    .run();

  const insertedCount = (inserted as unknown as { meta?: { changes?: number } })?.meta?.changes ?? 1;
  if (insertedCount === 0) {
    // A concurrent caller won the same identity: resolve as replay against
    // the winner's durable fingerprint. The loser never writes draft bytes,
    // so the winner's payload stays authoritative. Sections reload from the
    // winner's stored parent rather than this caller's own parent read.
    const winner = await env.DB.prepare(
      `SELECT id, document_id, revision_number, parent_revision_id, title, request_fingerprint FROM document_revisions WHERE id = ? AND workspace_id = ?`
    ).bind(revisionId, workspaceId).first<{
      id: string; document_id: string; revision_number: number; parent_revision_id: string | null; title: string; request_fingerprint: string | null;
    }>();
    if (!winner || winner.document_id !== docId || winner.title !== title ||
      winner.request_fingerprint !== fingerprint) {
      throw new Error('Document request identity was reused with different content. Retry with a new action.');
    }
    await ensureDraftObject(env, workspaceId, docId!, revisionId, title, args.intended_sections,
      await loadParentSections(env, workspaceId, docId!, winner.parent_revision_id));
    return {
      document_id: docId!,
      revision_id: revisionId,
      revision_number: winner.revision_number,
      title: winner.title,
      parent_revision_id: winner.parent_revision_id,
      intended_sections: args.intended_sections,
    };
  }

  // Reservation won: this caller alone owns the draft key.
  const draftKey = `${workspaceId}/documents/${docId}/rev-${revisionId}-draft.json`;
  const draftPayload: DraftPayload = {
    title,
    intended_sections: args.intended_sections,
    sections: baseSections,
  };
  await env.STORAGE.put(draftKey, JSON.stringify(draftPayload), {
    httpMetadata: { contentType: 'application/json' },
  });

  const allocated = await env.DB.prepare(
    `SELECT revision_number FROM document_revisions WHERE id = ? AND workspace_id = ?`
  ).bind(revisionId, workspaceId).first<{ revision_number: number }>();
  if (!allocated) {
    throw new Error('Document revision allocation failed. Retry the document request.');
  }

  return {
    document_id: docId!,
    revision_id: revisionId,
    revision_number: allocated.revision_number,
    title,
    parent_revision_id: parentRevId,
    intended_sections: args.intended_sections,
  };
}

async function ensureDraftObject(
  env: Env,
  workspaceId: string,
  docId: string,
  revisionId: string,
  title: string,
  intendedSections: string[],
  baseSections: Array<{ id: string; title: string; content_markdown: string }>,
): Promise<void> {
  const draftKey = `${workspaceId}/documents/${docId}/rev-${revisionId}-draft.json`;
  const existing = await env.STORAGE!.get(draftKey);
  if (existing) return;
  await env.STORAGE!.put(draftKey, JSON.stringify({ title, intended_sections: intendedSections, sections: baseSections }), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function writeDocumentSections(
  env: Env,
  workspaceId: string,
  args: {
    document_id: string;
    revision_id: string;
    sections: Array<{ id: string; title: string; content_markdown: string }>;
  }
): Promise<{
  document_id: string;
  revision_id: string;
  saved_sections: Array<{ id: string; title: string; characters: number }>;
  total_sections: number;
  total_characters: number;
}> {
  if (!env.STORAGE) throw new Error('File storage is unavailable.');

  const rev = await env.DB.prepare(
    `SELECT * FROM document_revisions WHERE id = ? AND document_id = ? AND workspace_id = ?`
  )
    .bind(args.revision_id, args.document_id, workspaceId)
    .first<DocumentRevision>();

  if (!rev) throw new Error('Document revision not found in this workspace.');
  if (rev.render_state !== 'draft') {
    throw new Error('This revision has already been published. Start a new revision to make changes.');
  }

  const draftKey = `${workspaceId}/documents/${args.document_id}/rev-${args.revision_id}-draft.json`;
  const draftObj = await env.STORAGE.get(draftKey);
  let draftPayload: DraftPayload;
  if (draftObj) {
    draftPayload = await draftObj.json<DraftPayload>();
  } else {
    // A missing draft means reservation without bytes (crash between the
    // two): rebuild from the revision's own parent instead of starting
    // empty, so inherited sections are not silently dropped.
    const inherited = await loadParentSections(env, workspaceId, args.document_id, rev.parent_revision_id);
    draftPayload = {
      title: rev.title,
      intended_sections: [],
      sections: inherited,
    };
  }

  if (args.sections.length > DOCUMENT_BOUNDS.MAX_SECTIONS_PER_ROUND) {
    throw new Error(`At most ${DOCUMENT_BOUNDS.MAX_SECTIONS_PER_ROUND} sections may be written per round.`);
  }

  for (const inputSec of args.sections) {
    const rawId = (inputSec.id || '').trim();
    const secTitle = (inputSec.title || 'Untitled Section').trim();
    const secContent = (inputSec.content_markdown || '').trim();

    if (secContent.length > DOCUMENT_BOUNDS.MAX_SECTION_CHARS) {
      throw new Error(`Section '${secTitle}' exceeds the maximum allowed length of ${DOCUMENT_BOUNDS.MAX_SECTION_CHARS} characters.`);
    }

    // Sections are durable by ID only: two distinct sections may share a
    // heading without overwriting each other. The derived identity for a
    // repeated heading is deterministic, so exact replays replace instead
    // of duplicating.
    const secId = rawId || `sec-${secTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48) || 'untitled'}`;
    const existingIndex = draftPayload.sections.findIndex((s) => s.id === secId);
    if (existingIndex >= 0) {
      draftPayload.sections[existingIndex] = { id: secId, title: secTitle, content_markdown: secContent };
    } else {
      const sameTitleCount = draftPayload.sections.filter((s) => s.title === secTitle).length;
      if (sameTitleCount === 0) {
        draftPayload.sections.push({ id: secId, title: secTitle, content_markdown: secContent });
      } else {
        const candidate = `${secId}-part-${sameTitleCount + 1}`;
        const candidateIndex = draftPayload.sections.findIndex((s) => s.id === candidate);
        if (candidateIndex >= 0) {
          draftPayload.sections[candidateIndex] = { id: candidate, title: secTitle, content_markdown: secContent };
        } else {
          draftPayload.sections.push({ id: candidate, title: secTitle, content_markdown: secContent });
        }
      }
    }
  }

  await env.STORAGE.put(draftKey, JSON.stringify(draftPayload), {
    httpMetadata: { contentType: 'application/json' },
  });

  const savedSections = draftPayload.sections.map((s) => ({
    id: s.id,
    title: s.title,
    characters: s.content_markdown.length,
  }));

  const totalCharacters = draftPayload.sections.reduce((sum, s) => sum + s.content_markdown.length, 0);

  return {
    document_id: args.document_id,
    revision_id: args.revision_id,
    saved_sections: savedSections,
    total_sections: draftPayload.sections.length,
    total_characters: totalCharacters,
  };
}

async function recordDocumentActivity(
  env: Env,
  workspaceId: string,
  chatId: string,
  runId: string | null,
  doc: GeneratedDocument,
  rev: DocumentRevision,
) {
  if (!chatId || !runId) return;
  const now = new Date().toISOString();
  // Identity per state transition, not per revision: returning to an
  // already-recorded state reuses the row (idempotent replay), while a new
  // state or attempt always publishes a fresh cursor and payload.
  const id = `act_${runId}_doc_${rev.id}_${rev.render_state}_${rev.render_attempt_count ?? 0}`;
  const payload = { document: doc, revision: rev };

  // Durable publication first: the persisted row owns the chat cursor.
  // Broadcast only after the commit succeeds, using the real cursor as the
  // SSE event id so stream catch-up cannot jump past persisted activity.
  const runRow = await env.DB.prepare(
    `SELECT id FROM agent_runs WHERE id = ? AND workspace_id = ?`
  ).bind(runId, workspaceId).first<{ id: string }>();
  if (!runRow) return;

  const batch = await env.DB.batch([
    env.DB.prepare(
      `UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND NOT EXISTS (SELECT 1 FROM run_activity WHERE id = ? AND workspace_id = ?)`
    ).bind(now, now, chatId, workspaceId, id, workspaceId),
    env.DB.prepare(
      `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
       SELECT ?, ?, ?, ?, activity_cursor, 'step_finished', ?, ?
       FROM chats WHERE id = ? AND workspace_id = ? AND NOT EXISTS (SELECT 1 FROM run_activity WHERE id = ? AND workspace_id = ?)
       RETURNING cursor`
    ).bind(id, workspaceId, chatId, runId, JSON.stringify({ step: 'document_revision_updated', document: payload.document, revision: payload.revision }), now, chatId, workspaceId, id, workspaceId),
  ]);
  const cursorRow = (batch[1] as unknown as { results?: Array<{ cursor?: number }> })?.results?.[0];
  const cursor = typeof cursorRow?.cursor === 'number' ? cursorRow.cursor : null;
  if (cursor === null) {
    const existing = await env.DB.prepare(
      `SELECT cursor FROM run_activity WHERE id = ? AND workspace_id = ?`
    ).bind(id, workspaceId).first<{ cursor: number }>();
    if (!existing) throw new Error('Document activity persistence failed.');
    try {
      const { liveChatBus } = await import('../chat/liveBus.js');
      liveChatBus.broadcast(workspaceId, chatId, {
        name: 'activity',
        id: existing.cursor,
        data: {
          schema_version: 1,
          id,
          cursor: existing.cursor,
          workspace_id: workspaceId,
          chat_id: chatId,
          run_id: runId,
          created_at: now,
          type: 'document_revision_updated',
          payload,
        },
      });
    } catch {
      // Live delivery is best effort once durable state exists.
    }
    return;
  }

  try {
    const { liveChatBus } = await import('../chat/liveBus.js');
    liveChatBus.broadcast(workspaceId, chatId, {
      name: 'activity',
      id: cursor,
      data: {
        schema_version: 1,
        id,
        cursor,
        workspace_id: workspaceId,
        chat_id: chatId,
        run_id: runId,
        created_at: now,
        type: 'document_revision_updated',
        payload,
      },
    });
  } catch {
    // Live delivery is best effort once durable state exists.
  }
}

export async function publishDocument(
  env: Env,
  workspaceId: string,
  args: {
    document_id: string;
    revision_id: string;
    render_pdf?: boolean;
  }
): Promise<{
  document_id: string;
  revision_id: string;
  revision_number: number;
  title: string;
  render_state: string;
  message: string;
}> {
  if (!env.STORAGE) throw new Error('File storage is unavailable.');

  const rev = await env.DB.prepare(
    `SELECT * FROM document_revisions WHERE id = ? AND document_id = ? AND workspace_id = ?`
  )
    .bind(args.revision_id, args.document_id, workspaceId)
    .first<DocumentRevision>();

  if (!rev) throw new Error('Document revision not found.');
  if (rev.render_state !== 'draft') {
    return {
      document_id: args.document_id,
      revision_id: args.revision_id,
      revision_number: rev.revision_number,
      title: rev.title,
      render_state: rev.render_state,
      message: 'Revision was already published.',
    };
  }

  const draftKey = `${workspaceId}/documents/${args.document_id}/rev-${args.revision_id}-draft.json`;
  const draftObj = await env.STORAGE.get(draftKey);
  if (!draftObj) throw new Error('Draft content is missing.');
  const draftPayload = await draftObj.json<DraftPayload>();

  if (!draftPayload.sections || draftPayload.sections.length === 0) {
    throw new Error('Cannot publish an empty document. Write at least one section before publishing.');
  }

  const intended = (draftPayload.intended_sections ?? []).map((s) => s.trim()).filter(Boolean);
  const writtenTitles = new Set(draftPayload.sections.map((s) => s.title.trim().toLowerCase()));
  const missing = intended.filter((title) => {
    const lower = title.toLowerCase();
    if (writtenTitles.has(lower)) return false;
    return !draftPayload.sections.some((s) =>
      s.title.toLowerCase().includes(lower) || lower.includes(s.title.toLowerCase())
    );
  });
  const emptySections = draftPayload.sections.filter((s) => !s.content_markdown.trim()).map((s) => s.title);
  if (missing.length > 0 || emptySections.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing sections: ${missing.join(', ')}`);
    if (emptySections.length > 0) parts.push(`empty sections: ${emptySections.join(', ')}`);
    throw new Error(
      `Document is incomplete (${parts.join('; ')}). Keep the draft, write the remaining sections, then publish again.`
    );
  }

  // Assemble source Markdown
  const sectionMds = draftPayload.sections.map((s) => `## ${s.title}\n\n${s.content_markdown}`);
  const fullMarkdown = `# ${draftPayload.title}\n\n` + sectionMds.join('\n\n');
  const checksum = await sha256Hex(fullMarkdown);
  const now = new Date().toISOString();

  const sourceKey = `${workspaceId}/documents/${args.document_id}/rev-${args.revision_id}-source.md`;
  await env.STORAGE.put(sourceKey, fullMarkdown, {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
  });

  const manifestKey = `${workspaceId}/documents/${args.document_id}/rev-${args.revision_id}-manifest.json`;
  await env.STORAGE.put(manifestKey, JSON.stringify({ sections: draftPayload.sections }), {
    httpMetadata: { contentType: 'application/json' },
  });

  const shouldRenderPdf = args.render_pdf !== false;
  const targetRenderState = shouldRenderPdf ? 'rendering' : 'ready';

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE document_revisions
       SET source_key = ?, checksum = ?, render_state = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`
    ).bind(sourceKey, checksum, targetRenderState, now, args.revision_id, workspaceId),
    env.DB.prepare(
      `UPDATE generated_documents
       SET current_revision_id = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`
    ).bind(args.revision_id, now, args.document_id, workspaceId),
  ]);

  if (shouldRenderPdf && env.DISPATCH_QUEUE) {
    await env.DISPATCH_QUEUE.send({
      kind: 'document_render_pdf',
      workspace_id: workspaceId,
      job_id: args.revision_id,
    }).catch(() => undefined);
  }

  const docRow = await env.DB.prepare(
    `SELECT id, workspace_id, author_user_id, source_chat_id, run_id, title, current_revision_id, created_at, updated_at
     FROM generated_documents WHERE id = ? AND workspace_id = ?`
  ).bind(args.document_id, workspaceId).first<GeneratedDocument>();

  const revRow = await env.DB.prepare(
    `SELECT id, document_id, workspace_id, revision_number, parent_revision_id, title, source_key, checksum, source_refs_json, render_state, output_media_id, render_error, render_attempt_id, render_attempt_expires_at, render_attempt_count, created_at, updated_at
     FROM document_revisions WHERE id = ? AND workspace_id = ?`
  ).bind(args.revision_id, workspaceId).first<DocumentRevision>();

  if (docRow && revRow) {
    await recordDocumentActivity(env, workspaceId, docRow.source_chat_id, docRow.run_id, docRow, revRow);
  }

  return {
    document_id: args.document_id,
    revision_id: args.revision_id,
    revision_number: rev.revision_number,
    title: rev.title,
    render_state: targetRenderState,
    message: shouldRenderPdf
      ? 'Document published. PDF rendering is queued.'
      : 'Document published in Markdown format.',
  };
}

interface RenderJob {
  id: string;
  document_id: string;
  workspace_id: string;
  title: string;
  source_key: string;
  created_at: string;
  run_id: string | null;
  chat_id: string;
}

/**
 * Register one render attempt's output key as `quarantine` inventory.
 * Returns true only when the row exists afterwards: erasure between the
 * caller's check and this write yields zero rows instead of a usable
 * registration, and a surviving registration (already inserted by this
 * attempt) refreshes its timestamp and also counts as registered. Never
 * throws — callers treat false as "upload nothing".
 */
async function registerAttemptRow(
  env: Env,
  job: RenderJob,
  pdfMediaId: string,
  outputKey: string,
  safeFilename: string,
): Promise<boolean> {
  try {
    const now = new Date().toISOString();
    const preRow = await env.DB.prepare(
      `INSERT INTO media_objects (
         id, workspace_id, uploader_user_id, state, object_key, content_type,
         byte_size, filename, expires_at, retained, created_at, updated_at
       )
       SELECT ?, ?, d.author_user_id, 'quarantine', ?, 'application/pdf',
              NULL, ?, ?, 1, ?, ?
       FROM generated_documents d
       WHERE d.id = ? AND d.workspace_id = ?
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
       RETURNING id`
    )
      .bind(
        pdfMediaId,
        job.workspace_id,
        outputKey,
        safeFilename,
        new Date(Date.now() + 365 * 86400000).toISOString(),
        now,
        now,
        job.document_id,
        job.workspace_id,
      )
      .first<{ id: string }>();
    return preRow?.id === pdfMediaId;
  } catch {
    return false;
  }
}

async function readJobDocument(
  env: Env,
  job: RenderJob,
): Promise<{ doc: GeneratedDocument; rev: DocumentRevision } | null> {
  const doc = await env.DB.prepare(
    `SELECT id, workspace_id, author_user_id, source_chat_id, run_id, title, current_revision_id, created_at, updated_at
     FROM generated_documents WHERE id = ? AND workspace_id = ?`
  ).bind(job.document_id, job.workspace_id).first<GeneratedDocument>();

  const rev = await env.DB.prepare(
    `SELECT id, document_id, workspace_id, revision_number, parent_revision_id, title, source_key, checksum, source_refs_json, render_state, output_media_id, render_error, render_attempt_id, render_attempt_expires_at, render_attempt_count, created_at, updated_at
     FROM document_revisions WHERE id = ? AND workspace_id = ?`
  ).bind(job.id, job.workspace_id).first<DocumentRevision>();

  if (!doc || !rev) return null;
  return { doc, rev };
}

async function publishReadyActivity(env: Env, job: RenderJob): Promise<void> {
  const read = await readJobDocument(env, job);
  if (!read) return;
  await recordDocumentActivity(env, job.workspace_id, job.chat_id, job.run_id, read.doc, read.rev);
}

async function publishFailureActivity(env: Env, job: RenderJob): Promise<void> {
  const read = await readJobDocument(env, job);
  if (!read) return;
  await recordDocumentActivity(env, job.workspace_id, job.chat_id, job.run_id, read.doc, read.rev);
}

export async function processDocumentRenderJobs(
  env: Env,
  workspaceId?: string,
  revisionId?: string,
  limit = 2
): Promise<number> {
  if (!env.STORAGE) return 0;
  const now = new Date().toISOString();

  // Bounded orphan reaper: output-media rows from superseded attempts that no
  // revision references, older than one hour. The inventory row is removed
  // only after its bytes are gone, so a failed deletion stays discoverable
  // for the next sweep instead of stranding untracked bytes.
  try {
    const orphans = (
      await env.DB.prepare(
        `SELECT id, object_key FROM media_objects
         WHERE workspace_id = ${workspaceId ? '?' : 'workspace_id'} AND id LIKE 'media_pdf\\_%' ESCAPE '\\'
           AND id NOT IN (SELECT output_media_id FROM document_revisions WHERE workspace_id = ${workspaceId ? '?' : 'workspace_id'} AND output_media_id IS NOT NULL)
           AND created_at <= ?
         LIMIT 5`
      )
        .bind(...(workspaceId ? [workspaceId, workspaceId] : []), new Date(Date.now() - 3_600_000).toISOString())
        .all<{ id: string; object_key: string | null }>()
    ).results ?? [];
    for (const orphan of orphans) {
      let bytesGone = !orphan.object_key;
      if (orphan.object_key) {
        try {
          await env.STORAGE.delete(orphan.object_key);
          bytesGone = true;
        } catch {
          bytesGone = false;
        }
      }
      if (bytesGone) {
        try {
          await env.DB.prepare(`DELETE FROM media_objects WHERE id = ?`).bind(orphan.id).run();
        } catch {
          // Retained: the next sweep retries the inventory delete.
        }
      }
    }
  } catch {
    // Best effort; render work below does not depend on it.
  }

  // Expire stuck attempts
  await env.DB.prepare(
    `UPDATE document_revisions
     SET render_state = 'failed', render_error = 'PDF rendering timed out after repeated attempts.', updated_at = ?
     WHERE id IN (
       SELECT id FROM document_revisions
       WHERE render_state = 'rendering' AND render_attempt_expires_at <= ? AND render_attempt_count >= 3
       LIMIT 2
     )`
  )
    .bind(now, now)
    .run();

  const query = `
    SELECT r.id, r.document_id, r.workspace_id, r.title, r.source_key, r.created_at, d.run_id, d.source_chat_id AS chat_id
    FROM document_revisions r
    JOIN generated_documents d ON d.id = r.document_id AND d.workspace_id = r.workspace_id
    WHERE (r.render_state = 'source_ready' OR r.render_state = 'rendering' OR (r.render_state = 'failed' AND r.render_attempt_count < 3))
      AND r.source_key != ''
      AND (r.render_attempt_expires_at IS NULL OR r.render_attempt_expires_at <= ?)
      ${workspaceId ? 'AND r.workspace_id = ?' : ''}
      ${revisionId ? 'AND r.id = ?' : ''}
    LIMIT ?
  `;

  const jobs = (
    await env.DB.prepare(query)
      .bind(now, ...(workspaceId ? [workspaceId] : []), ...(revisionId ? [revisionId] : []), limit)
      .all<{
        id: string;
        document_id: string;
        workspace_id: string;
        title: string;
        source_key: string;
        created_at: string;
        run_id: string | null;
        chat_id: string;
      }>()
  ).results ?? [];

  let completed = 0;
  for (const job of jobs) {
    const attempt = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 180_000).toISOString();
    const claimNow = new Date().toISOString();

    const claimed = await env.DB.prepare(
      `UPDATE document_revisions
       SET render_state = 'rendering', render_attempt_id = ?, render_attempt_expires_at = ?, render_attempt_count = render_attempt_count + 1, updated_at = ?
       WHERE id = ? AND workspace_id = ?
         AND (render_state = 'source_ready' OR render_state = 'rendering' OR (render_state = 'failed' AND render_attempt_count < 3))
         AND (render_attempt_expires_at IS NULL OR render_attempt_expires_at <= ?)
       RETURNING id`
    )
      .bind(attempt, expiresAt, claimNow, job.id, job.workspace_id, claimNow)
      .first();

    if (!claimed) continue;

    const pdfMediaId = `media_pdf_${crypto.randomUUID()}`;
    const outputKey = `${job.workspace_id}/documents/${job.document_id}/rev-${job.id}-${attempt}.pdf`;
    const safeFilename = `${job.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100)}.pdf`;

    // Pre-upload attempt inventory: register this attempt's output key
    // before any byte exists, so a crash between upload and publication (or
    // a rejected publication followed by a failed byte delete) still leaves
    // a row the orphan reaper above can discover. The row is `quarantine`,
    // never presented as a ready document: publication promotes it below.
    // The workspace/document must still exist — an erased workspace aborts
    // the attempt here instead of uploading new bytes after deletion. The
    // INSERT reports what it wrote: erasure between the check and the write
    // yields zero rows (not a usable registration), and rendering never
    // starts on it.
    const targetAlive = await env.DB.prepare(
      `SELECT 1 AS ok FROM generated_documents d
        WHERE d.id = ? AND d.workspace_id = ?
          AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ?)`
    ).bind(job.document_id, job.workspace_id, job.workspace_id).first<{ ok: number }>();
    if (!targetAlive) continue;
    if (!await registerAttemptRow(env, job, pdfMediaId, outputKey, safeFilename)) {
      // No durable inventory, no upload: retry later instead of risking
      // untracked bytes.
      continue;
    }

    // Render first, outside any failure-marking boundary: only a completed
    // render reaches publication, and only publication failure marks failed.
    // Render, upload, and checksum each gate publication independently: a
    // failed upload must never publish a ready row for missing bytes.
    let rendered: Uint8Array | null = null;
    let uploaded = false;
    let pdfHash = '';
    let lastRenderError: string | null = null;
    try {
      const sourceObj = await env.STORAGE.get(job.source_key);
      if (!sourceObj) throw new Error('Document source text is missing.');
      const markdown = await sourceObj.text();

      rendered = await renderDocumentToPdf(env, job.title, markdown, job.created_at);
      pdfHash = await sha256Hex(rendered);

      // Revalidate after the long render: erasure may have removed the
      // registered row and finished its sweep while rendering ran, and the
      // orphan reaper may have taken a registration older than its
      // recovery cutoff. Uploading on a dead registration would strand
      // bytes the sweep already passed; an erased workspace uploads nothing.
      const wsAlive = await env.DB.prepare(`SELECT 1 AS ok FROM workspaces WHERE id = ?`)
        .bind(job.workspace_id).first<{ ok: number }>();
      if (!wsAlive) throw new Error('The workspace was removed while rendering. Upload skipped.');
      if (!await registerAttemptRow(env, job, pdfMediaId, outputKey, safeFilename)) {
        throw new Error('Render attempt inventory was lost before upload. Upload skipped.');
      }

      await env.STORAGE.put(outputKey, rendered, {
        httpMetadata: { contentType: 'application/pdf' },
      });
      uploaded = true;
    } catch (err) {
      lastRenderError = err instanceof Error ? err.message : 'PDF generation failed.';
    }

    // Publication metadata commits in one aborting conditional batch. The
    // guard row asserts the live attempt, lease, state, and source first:
    // a stale guard violates its CHECK and rolls everything back with it,
    // so a rejected publication can never commit metadata. The media row
    // was pre-registered above, so its INSERT is idempotent and a final
    // UPDATE promotes it to ready; the revision UPDATE's zero-row return is
    // verified below as defense in depth.
    let published = false;
    if (rendered && uploaded) {
    try {
      const guardNow = new Date().toISOString();
      const publishedBatch = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO acceptance_guards (id, guard_ok)
           VALUES (?, (SELECT 1 FROM document_revisions
             WHERE id = ? AND workspace_id = ?
               AND render_attempt_id = ?
               AND render_state = 'rendering'
               AND (render_attempt_expires_at IS NULL OR render_attempt_expires_at > ?)
               AND source_key = ?))`
        ).bind(
          `guard_doc_${attempt}`,
          job.id, job.workspace_id, attempt, guardNow, job.source_key,
        ),
        env.DB.prepare(
          `INSERT INTO media_objects (
             id, workspace_id, uploader_user_id, state, object_key, content_type,
             byte_size, filename, upload_token_hash, upload_token_expires_at,
             expires_at, retained, created_at, updated_at
           )
           SELECT ?, ?, d.author_user_id, 'quarantine', ?, 'application/pdf',
                  ?, ?, ?, ?, ?, 1, ?, ?
           FROM generated_documents d
           WHERE d.id = ? AND d.workspace_id = ?
           ON CONFLICT(id) DO NOTHING`
        )
          .bind(
            pdfMediaId,
            job.workspace_id,
            outputKey,
            rendered.byteLength,
            safeFilename,
            pdfHash,
            new Date(Date.now() + 7200000).toISOString(),
            new Date(Date.now() + 365 * 86400000).toISOString(),
            new Date().toISOString(),
            new Date().toISOString(),
            job.document_id,
            job.workspace_id
          ),
        env.DB.prepare(
          `UPDATE media_objects
           SET state = 'ready', byte_size = ?, filename = ?, content_type = 'application/pdf',
               object_key = ?, expires_at = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ?`
        )
          .bind(
            rendered.byteLength,
            safeFilename,
            outputKey,
            new Date(Date.now() + 365 * 86400000).toISOString(),
            new Date().toISOString(),
            pdfMediaId,
            job.workspace_id,
          ),
        env.DB.prepare(
          `UPDATE document_revisions
           SET render_state = 'ready', output_media_id = ?, render_error = NULL, render_attempt_expires_at = NULL, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND render_attempt_id = ? AND render_state = 'rendering'
           RETURNING id`
        )
          .bind(pdfMediaId, new Date().toISOString(), job.id, job.workspace_id, attempt),
      ]);
      const publishedRows = (publishedBatch[3] as unknown as { results?: unknown[] })?.results ?? [];
      published = publishedRows.length > 0;
    } catch {
      // An aborted publication guard failed: fall through to per-attempt
      // cleanup and failure marking below. Nothing below touches the
      // published bytes of a successful attempt.
      published = false;
    }
    }

    if (!published) {
      // A batch error does not prove nothing committed: re-check the
      // revision before touching bytes. Only a ready revision carrying this
      // attempt's own output proves publication succeeded — a newer attempt
      // may since have published its own separate PDF key, which this
      // attempt must never treat as its own.
      const settled = await env.DB.prepare(
        `SELECT render_state, output_media_id FROM document_revisions WHERE id = ? AND workspace_id = ?`
      ).bind(job.id, job.workspace_id).first<{ render_state: string; output_media_id: string | null }>();
      if (settled?.render_state === 'ready' && settled.output_media_id === pdfMediaId) {
        try {
          await publishReadyActivity(env, job);
        } catch {
          // Best effort; the ready revision stands and catch-up still serves it.
        }
        completed++;
        continue;
      }
      // This attempt's bytes are orphans under exactly its own key: either
      // the publication batch rolled back, or a newer attempt has since won.
      // The pre-registered media row (inserted before upload) is removed only
      // after its bytes are gone; when byte deletion fails, that row stays
      // for the orphan reaper above — no best-effort insert is needed, and a
      // crash anywhere in this path still leaves discoverable inventory.
      let attemptBytesGone = false;
      try {
        await env.STORAGE.delete(outputKey);
        attemptBytesGone = true;
      } catch { /* orphan cleanup best effort */ }
      if (attemptBytesGone) {
        try {
          await env.DB.prepare(`DELETE FROM media_objects WHERE id = ? AND workspace_id = ?`)
            .bind(pdfMediaId, job.workspace_id).run();
        } catch { /* retained for the orphan reaper */ }
      } else {
        // The pre-registered row normally stays for the orphan reaper. Only
        // when the cascade removed it with the rest of the workspace (an
        // upload that outlived erasure) is the key retained in the erasure
        // cleanup record instead, so the bytes stay retryable. A refused
        // retention is not treated as inventoried: the bytes get one more
        // direct deletion attempt first.
        try {
          const preRow = await env.DB.prepare(`SELECT 1 AS ok FROM media_objects WHERE id = ?`)
            .bind(pdfMediaId).first<{ ok: number }>();
          if (!preRow) {
            const { retainRenderOrphanKey } = await import('../routes/erasureCleanup.js');
            const retained = await retainRenderOrphanKey(env.DB, job.workspace_id, outputKey);
            if (!retained) {
              try {
                await env.STORAGE.delete(outputKey);
              } catch { /* bytes remain without inventory; noted below */ }
            }
          }
        } catch { /* bytes remain; a later sweep may still find them */ }
      }
      if (settled?.render_state === 'ready') {
        // A newer attempt owns the revision now: this attempt's orphans are
        // handled above, but the revision must not be marked failed.
        completed++;
        continue;
      }
      // A failed render/publication attempt never touches a revision that
      // has since moved on: same attempt identity and still rendering.
      const marked = await env.DB.prepare(
        `UPDATE document_revisions
         SET render_state = 'failed', render_error = ?, render_attempt_expires_at = NULL, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND render_attempt_id = ? AND render_state = 'rendering'
         RETURNING id`
      )
        .bind(
          lastRenderError ?? 'PDF generation failed.',
          new Date().toISOString(), job.id, job.workspace_id, attempt,
        )
        .first();
      if (marked) {
        try {
          await publishFailureActivity(env, job);
        } catch {
          // Best effort; the failed state stands and catch-up still serves it.
        }
      }
      continue;
    }

    // Post-publication reads and notification run outside render-failure
    // cleanup: the bytes are committed and the revision is ready, so a read
    // or activity failure here must never delete the PDF or mark it failed.
    try {
      await publishReadyActivity(env, job);
    } catch {
      // Best effort; the ready revision stands and catch-up still serves it.
    }

    completed++;
  }

  return completed;
}

export async function getGeneratedDocument(
  env: Env,
  workspaceId: string,
  userId: string,
  documentId: string
): Promise<DocumentDetailResponse | null> {
  const member = await env.DB.prepare(
    `SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`
  )
    .bind(workspaceId, userId)
    .first();
  if (!member) throw new Error('Access denied.');

  const doc = await env.DB.prepare(
    `SELECT * FROM generated_documents WHERE id = ? AND workspace_id = ?`
  )
    .bind(documentId, workspaceId)
    .first<GeneratedDocument>();

  if (!doc) return null;

  const revisions = (
    await env.DB.prepare(
      `SELECT * FROM document_revisions WHERE document_id = ? AND workspace_id = ? ORDER BY revision_number DESC`
    )
      .bind(documentId, workspaceId)
      .all<DocumentRevision>()
  ).results ?? [];

  const currentRevision = revisions.find((r) => r.id === doc.current_revision_id) ?? revisions[0] ?? null;

  let sourceMarkdown: string | null = null;
  if (currentRevision?.source_key && env.STORAGE && currentRevision.render_state !== 'draft') {
    const obj = await env.STORAGE.get(currentRevision.source_key);
    if (obj) sourceMarkdown = await obj.text();
  }

  return {
    document: doc,
    current_revision: currentRevision,
    revisions,
    source_markdown: sourceMarkdown,
  };
}

export async function getDocumentRevision(
  env: Env,
  workspaceId: string,
  userId: string,
  documentId: string,
  revisionId: string
): Promise<{
  revision: DocumentRevision;
  source_markdown: string | null;
  document: GeneratedDocument | null;
} | null> {
  const member = await env.DB.prepare(
    `SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`
  )
    .bind(workspaceId, userId)
    .first();
  if (!member) throw new Error('Access denied.');

  const revision = await env.DB.prepare(
    `SELECT * FROM document_revisions WHERE id = ? AND document_id = ? AND workspace_id = ?`
  )
    .bind(revisionId, documentId, workspaceId)
    .first<DocumentRevision>();

  if (!revision) return null;

  let sourceMarkdown: string | null = null;
  if (revision.source_key && env.STORAGE && revision.render_state !== 'draft') {
    const obj = await env.STORAGE.get(revision.source_key);
    if (obj) sourceMarkdown = await obj.text();
  }

  const document = await env.DB.prepare(
    `SELECT id, workspace_id, author_user_id, source_chat_id, run_id, title, current_revision_id, created_at, updated_at
     FROM generated_documents WHERE id = ? AND workspace_id = ?`
  ).bind(documentId, workspaceId).first<GeneratedDocument>();

  return {
    revision,
    source_markdown: sourceMarkdown,
    document,
  };
}

export async function retryDocumentRender(
  env: Env,
  workspaceId: string,
  userId: string,
  documentId: string,
  revisionId: string
): Promise<boolean> {
  const member = await env.DB.prepare(
    `SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`
  )
    .bind(workspaceId, userId)
    .first();
  if (!member) throw new Error('Access denied.');

  // Retry preserves the attempt history: resetting the counter would reuse
  // activity identities from the first attempt. The claim below increments.
  const updated = await env.DB.prepare(
    `UPDATE document_revisions
     SET render_state = 'rendering', render_error = NULL, render_attempt_id = NULL, render_attempt_expires_at = NULL, updated_at = ?
     WHERE id = ? AND document_id = ? AND workspace_id = ? AND source_key != '' AND render_state = 'failed'
     RETURNING id`
  )
    .bind(new Date().toISOString(), revisionId, documentId, workspaceId)
    .first();

  if (!updated) return false;

  if (env.DISPATCH_QUEUE) {
    await env.DISPATCH_QUEUE.send({
      kind: 'document_render_pdf',
      workspace_id: workspaceId,
      job_id: revisionId,
    }).catch(() => undefined);
  }

  // Retry publishes its own rendering transition so the card recovers even
  // when the original publication activity is missing or stale. Best effort:
  // the reset above stands regardless.
  try {
    const docRow = await env.DB.prepare(
      `SELECT id, workspace_id, author_user_id, source_chat_id, run_id, title, current_revision_id, created_at, updated_at
       FROM generated_documents WHERE id = ? AND workspace_id = ?`
    ).bind(documentId, workspaceId).first<GeneratedDocument>();
    const revRow = await env.DB.prepare(
      `SELECT id, document_id, workspace_id, revision_number, parent_revision_id, title, source_key, checksum, source_refs_json, render_state, output_media_id, render_error, render_attempt_id, render_attempt_expires_at, render_attempt_count, created_at, updated_at
       FROM document_revisions WHERE id = ? AND workspace_id = ?`
    ).bind(revisionId, workspaceId).first<DocumentRevision>();
    if (docRow && revRow) {
      await recordDocumentActivity(env, workspaceId, docRow.source_chat_id, docRow.run_id, docRow, revRow);
    }
  } catch {
    // Best effort; the retry itself succeeded.
  }

  return true;
}

export async function listChatDocuments(
  env: Env,
  workspaceId: string,
  userId: string,
  chatId: string
): Promise<DocumentListResponse> {
  const member = await env.DB.prepare(
    `SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`
  )
    .bind(workspaceId, userId)
    .first();
  if (!member) throw new Error('Access denied.');

  const docs = (
    await env.DB.prepare(
      `SELECT d.*, r.id as rev_id, r.revision_number, r.render_state, r.output_media_id, r.render_error,
              r.created_at as rev_created_at, r.updated_at as rev_updated_at, r.render_attempt_count as rev_attempt_count
       FROM generated_documents d
       LEFT JOIN document_revisions r ON r.id = d.current_revision_id
       WHERE d.workspace_id = ? AND d.source_chat_id = ?
       ORDER BY d.updated_at DESC`
    )
      .bind(workspaceId, chatId)
      .all<GeneratedDocument & {
        rev_id: string | null;
        revision_number: number | null;
        render_state: DocumentRevision['render_state'] | null;
        output_media_id: string | null;
        render_error: string | null;
        rev_created_at: string | null;
        rev_updated_at: string | null;
        rev_attempt_count: number | null;
      }>()
  ).results ?? [];

  const summaries: GeneratedDocumentSummary[] = docs.map((d) => ({
    document: {
      id: d.id,
      workspace_id: d.workspace_id,
      author_user_id: d.author_user_id,
      source_chat_id: d.source_chat_id,
      run_id: d.run_id,
      title: d.title,
      current_revision_id: d.current_revision_id,
      created_at: d.created_at,
      updated_at: d.updated_at,
    },
    current_revision: d.rev_id
      ? ({
          id: d.rev_id,
          document_id: d.id,
          workspace_id: d.workspace_id,
          revision_number: d.revision_number ?? 1,
          parent_revision_id: null,
          title: d.title,
          source_key: '',
          checksum: '',
          source_refs_json: null,
          render_state: d.render_state ?? 'draft',
          output_media_id: d.output_media_id,
          render_error: d.render_error,
          render_attempt_count: d.rev_attempt_count ?? 0,
          created_at: d.rev_created_at ?? d.created_at,
          updated_at: d.rev_updated_at ?? d.updated_at,
        } as DocumentRevision)
      : null,
  }));

  return { documents: summaries };
}
