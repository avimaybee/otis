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
  let docId = args.document_id;
  let parentRevId: string | null = args.base_revision_id ?? null;
  let revNumber = 1;
  let baseSections: Array<{ id: string; title: string; content_markdown: string }> = [];

  if (docId) {
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
    revNumber = (existingDoc.revision_number ?? 0) + 1;

    // If there is a parent revision, load its base sections so revision can inherit unchanged sections
    if (parentRevId) {
      const parentRev = await env.DB.prepare(
        `SELECT source_key FROM document_revisions WHERE id = ? AND workspace_id = ?`
      )
        .bind(parentRevId, workspaceId)
        .first<{ source_key: string }>();

      if (parentRev?.source_key) {
        const parentObj = await env.STORAGE.get(parentRev.source_key);
        if (parentObj) {
          const parentMd = await parentObj.text();
          // Parse sections by ## Heading
          const parts = parentMd.split(/\n(?=## )/);
          baseSections = parts.map((part, idx) => {
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
    }
  } else {
    docId = `doc_${crypto.randomUUID()}`;
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(docId, workspaceId, userId, chatId, validRunId, title, now, now)
      .run();
  }

  const revisionId = `rev_${crypto.randomUUID()}`;
  const draftKey = `${workspaceId}/documents/${docId}/rev-${revisionId}-draft.json`;
  const draftPayload: DraftPayload = {
    title,
    intended_sections: args.intended_sections,
    sections: baseSections,
  };

  await env.STORAGE.put(draftKey, JSON.stringify(draftPayload), {
    httpMetadata: { contentType: 'application/json' },
  });

  await env.DB.prepare(
    `INSERT INTO document_revisions (
       id, document_id, workspace_id, revision_number, parent_revision_id,
       title, source_key, checksum, render_state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
  )
    .bind(revisionId, docId, workspaceId, revNumber, parentRevId, title, draftKey, '', now, now)
    .run();

  return {
    document_id: docId,
    revision_id: revisionId,
    revision_number: revNumber,
    title,
    parent_revision_id: parentRevId,
    intended_sections: args.intended_sections,
  };
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
    draftPayload = {
      title: rev.title,
      intended_sections: [],
      sections: [],
    };
  }

  for (const inputSec of args.sections) {
    const secId = (inputSec.id || '').trim();
    const secTitle = (inputSec.title || 'Untitled Section').trim();
    const secContent = (inputSec.content_markdown || '').trim();

    if (secContent.length > DOCUMENT_BOUNDS.MAX_SECTION_CHARS) {
      throw new Error(`Section '${secTitle}' exceeds the maximum allowed length of ${DOCUMENT_BOUNDS.MAX_SECTION_CHARS} characters.`);
    }

    const existingIndex = draftPayload.sections.findIndex((s) => s.id === secId || s.title === secTitle);
    if (existingIndex >= 0) {
      draftPayload.sections[existingIndex] = { id: secId, title: secTitle, content_markdown: secContent };
    } else {
      draftPayload.sections.push({ id: secId, title: secTitle, content_markdown: secContent });
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
  const id = `act_${runId}_doc_${rev.id}_${rev.render_state}`;
  const payload = { document: doc, revision: rev };

  // Live broadcast in-memory to connected clients immediately
  try {
    const { liveChatBus } = await import('../chat/liveBus.js');
    liveChatBus.broadcast(workspaceId, chatId, {
      name: 'activity',
      id: Date.now(),
      data: {
        schema_version: 1,
        id,
        cursor: 0,
        workspace_id: workspaceId,
        chat_id: chatId,
        run_id: runId,
        created_at: now,
        type: 'document_revision_updated',
        payload,
      },
    });
  } catch {
    // Best-effort live bus
  }

  // Durable run activity persistence (guarded on valid agent_run)
  try {
    const runRow = await env.DB.prepare(
      `SELECT id FROM agent_runs WHERE id = ? AND workspace_id = ?`
    ).bind(runId, workspaceId).first<{ id: string }>();
    if (!runRow) return;

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND NOT EXISTS (SELECT 1 FROM run_activity WHERE id = ? AND workspace_id = ?)`
      ).bind(now, now, chatId, workspaceId, id, workspaceId),
      env.DB.prepare(
        `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
         SELECT ?, ?, ?, ?, activity_cursor, 'step_finished', ?, ?
         FROM chats WHERE id = ? AND workspace_id = ? AND NOT EXISTS (SELECT 1 FROM run_activity WHERE id = ? AND workspace_id = ?)
         RETURNING cursor`
      ).bind(id, workspaceId, chatId, runId, JSON.stringify({ step: 'document_revision_updated', ...payload }), now, chatId, workspaceId, id, workspaceId),
    ]);
  } catch {
    // Best-effort activity publication
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

  // Assemble source Markdown
  const sectionMds = draftPayload.sections.map((s) => `## ${s.title}\n\n${s.content_markdown}`);
  const fullMarkdown = `# ${draftPayload.title}\n\n` + sectionMds.join('\n\n');
  const checksum = await sha256Hex(fullMarkdown);
  const now = new Date().toISOString();

  const sourceKey = `${workspaceId}/documents/${args.document_id}/rev-${args.revision_id}-source.md`;
  await env.STORAGE.put(sourceKey, fullMarkdown, {
    httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
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

export async function processDocumentRenderJobs(
  env: Env,
  workspaceId?: string,
  revisionId?: string,
  limit = 2
): Promise<number> {
  if (!env.STORAGE) return 0;
  const now = new Date().toISOString();

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

    const claimed = await env.DB.prepare(
      `UPDATE document_revisions
       SET render_state = 'rendering', render_attempt_id = ?, render_attempt_expires_at = ?, render_attempt_count = render_attempt_count + 1, updated_at = ?
       WHERE id = ? AND workspace_id = ?
         AND (render_state = 'source_ready' OR render_state = 'rendering' OR render_state = 'failed')
       RETURNING id`
    )
      .bind(attempt, expiresAt, now, job.id, job.workspace_id)
      .first();

    if (!claimed) continue;

    const pdfMediaId = `media_pdf_${crypto.randomUUID()}`;
    const outputKey = `${job.workspace_id}/documents/${job.document_id}/rev-${job.id}.pdf`;

    try {
      const sourceObj = await env.STORAGE.get(job.source_key);
      if (!sourceObj) throw new Error('Document source text is missing.');
      const markdown = await sourceObj.text();

      const pdfBytes = await renderDocumentToPdf(env, job.title, markdown, job.created_at);

      await env.STORAGE.put(outputKey, pdfBytes, {
        httpMetadata: { contentType: 'application/pdf' },
      });

      const pdfHash = await sha256Hex(pdfBytes);
      const safeFilename = `${job.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100)}.pdf`;

      // Insert media_objects row for the generated PDF
      await env.DB.prepare(
        `INSERT INTO media_objects (
           id, workspace_id, uploader_user_id, state, object_key, content_type,
           byte_size, filename, upload_token_hash, upload_token_expires_at,
           expires_at, retained, created_at, updated_at
         )
         SELECT ?, ?, d.author_user_id, 'ready', ?, 'application/pdf',
                ?, ?, ?, ?, ?, 1, ?, ?
         FROM generated_documents d
         WHERE d.id = ? AND d.workspace_id = ?`
      )
        .bind(
          pdfMediaId,
          job.workspace_id,
          outputKey,
          pdfBytes.byteLength,
          safeFilename,
          pdfHash,
          new Date(Date.now() + 7200000).toISOString(),
          new Date(Date.now() + 365 * 86400000).toISOString(),
          new Date().toISOString(),
          new Date().toISOString(),
          job.document_id,
          job.workspace_id
        )
        .run();

      await env.DB.prepare(
        `UPDATE document_revisions
         SET render_state = 'ready', output_media_id = ?, render_error = NULL, render_attempt_expires_at = NULL, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND render_attempt_id = ?`
      )
        .bind(pdfMediaId, new Date().toISOString(), job.id, job.workspace_id, attempt)
        .run();

      const updatedDoc = await env.DB.prepare(
        `SELECT id, workspace_id, author_user_id, source_chat_id, run_id, title, current_revision_id, created_at, updated_at
         FROM generated_documents WHERE id = ? AND workspace_id = ?`
      ).bind(job.document_id, job.workspace_id).first<GeneratedDocument>();

      const updatedRev = await env.DB.prepare(
        `SELECT id, document_id, workspace_id, revision_number, parent_revision_id, title, source_key, checksum, source_refs_json, render_state, output_media_id, render_error, render_attempt_id, render_attempt_expires_at, render_attempt_count, created_at, updated_at
         FROM document_revisions WHERE id = ? AND workspace_id = ?`
      ).bind(job.id, job.workspace_id).first<DocumentRevision>();

      if (updatedDoc && updatedRev) {
        await recordDocumentActivity(env, job.workspace_id, job.chat_id, job.run_id, updatedDoc, updatedRev);
      }

      completed++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'PDF generation failed.';
      await env.DB.prepare(
        `UPDATE document_revisions
         SET render_state = 'failed', render_error = ?, render_attempt_expires_at = NULL, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND render_attempt_id = ?`
      )
        .bind(errorMessage, new Date().toISOString(), job.id, job.workspace_id, attempt)
        .run();

      const failedDoc = await env.DB.prepare(
        `SELECT id, workspace_id, author_user_id, source_chat_id, run_id, title, current_revision_id, created_at, updated_at
         FROM generated_documents WHERE id = ? AND workspace_id = ?`
      ).bind(job.document_id, job.workspace_id).first<GeneratedDocument>();

      const failedRev = await env.DB.prepare(
        `SELECT id, document_id, workspace_id, revision_number, parent_revision_id, title, source_key, checksum, source_refs_json, render_state, output_media_id, render_error, render_attempt_id, render_attempt_expires_at, render_attempt_count, created_at, updated_at
         FROM document_revisions WHERE id = ? AND workspace_id = ?`
      ).bind(job.id, job.workspace_id).first<DocumentRevision>();

      if (failedDoc && failedRev) {
        await recordDocumentActivity(env, job.workspace_id, job.chat_id, job.run_id, failedDoc, failedRev);
      }
    }
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
  if (currentRevision?.source_key && env.STORAGE) {
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
  if (revision.source_key && env.STORAGE) {
    const obj = await env.STORAGE.get(revision.source_key);
    if (obj) sourceMarkdown = await obj.text();
  }

  return {
    revision,
    source_markdown: sourceMarkdown,
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

  const updated = await env.DB.prepare(
    `UPDATE document_revisions
     SET render_state = 'rendering', render_error = NULL, render_attempt_id = NULL, render_attempt_expires_at = NULL, render_attempt_count = 0, updated_at = ?
     WHERE id = ? AND document_id = ? AND workspace_id = ? AND source_key != ''
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
      `SELECT d.*, r.id as rev_id, r.revision_number, r.render_state, r.output_media_id, r.render_error
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
          render_attempt_count: 0,
          created_at: d.created_at,
          updated_at: d.updated_at,
        } as DocumentRevision)
      : null,
  }));

  return { documents: summaries };
}
