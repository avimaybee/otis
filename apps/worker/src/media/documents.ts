import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { requireWorkspaceScope } from '../routes/scope.js';

export interface MarkdownBinding {
  toMarkdown(input: {
    name: string;
    blob: Blob;
  }): Promise<
    | { format: string; data?: string; error?: string }
    | { format: string; data?: string; error?: string }[]
  >;
}
export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
type Extraction = {
  media_id: string;
  workspace_id: string;
  checksum: string;
  state: string;
  attempt_id: string | null;
  result_key: string | null;
  chunks_json: string | null;
  error: string | null;
};
const checksum = async (bytes: ArrayBuffer) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');

export async function handleRetryDocument(
  request: Request,
  env: Env,
  workspace: string,
  mediaId: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspace, requestId, { csrf: true });
  if (scope instanceof Response) return scope;
  const now = new Date().toISOString();
  const current = await env.DB.prepare(
    `SELECT d.state, d.result_key FROM document_extractions d JOIN media_objects m ON m.id = d.media_id AND m.workspace_id = d.workspace_id
    WHERE d.workspace_id = ? AND d.media_id = ? AND m.state = 'ready' AND m.deletion_claimed_at IS NULL AND (m.retained = 1 OR m.expires_at > ?)`,
  )
    .bind(workspace, mediaId, now)
    .first<{ state: string; result_key: string | null }>();
  if (!current) return jsonError(404, 'not_found', 'The original PDF is unavailable.', requestId);
  if (['failed', 'needs_visual'].includes(current.state)) {
    const reset = await env.DB.prepare(
      `UPDATE document_extractions SET state = 'pending', attempt_id = NULL, attempt_expires_at = NULL, attempt_count = 0, result_key = NULL, chunks_json = NULL, error = NULL, updated_at = ?
      WHERE workspace_id = ? AND media_id = ? AND state IN ('failed', 'needs_visual')
      AND EXISTS (SELECT 1 FROM media_objects m JOIN workspace_users member ON member.workspace_id = m.workspace_id AND member.user_id = ?
        WHERE m.id = document_extractions.media_id AND m.workspace_id = document_extractions.workspace_id AND m.state = 'ready' AND m.deletion_claimed_at IS NULL AND (m.retained = 1 OR m.expires_at > ?)) RETURNING media_id`,
    )
      .bind(now, workspace, mediaId, scope.user.id, now)
      .first();
    if (!reset)
      return jsonError(
        409,
        'extraction_changed',
        'The PDF changed. Refresh before retrying.',
        requestId,
      );
    if (current.result_key) await env.STORAGE?.delete(current.result_key).catch(() => undefined);
  }
  if (current.state !== 'ready' && env.DISPATCH_QUEUE)
    await env.DISPATCH_QUEUE.send({
      kind: 'document_extract',
      workspace_id: workspace,
      job_id: mediaId,
    }).catch(() => undefined);
  return jsonSuccess(
    { media_id: mediaId, state: current.state === 'ready' ? 'ready' : 'pending' },
    200,
    { 'cache-control': 'no-store' },
  );
}

export async function handleUploadDocument(
  request: Request,
  env: Env,
  workspace: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspace, requestId, { csrf: true });
  if (scope instanceof Response) return scope;
  if (!env.STORAGE)
    return jsonError(503, 'storage_unavailable', 'File storage is unavailable.', requestId);
  const size = Number(request.headers.get('content-length'));
  if (size > DOCUMENT_MAX_BYTES)
    return jsonError(413, 'file_too_large', 'Documents can be up to 20 MB.', requestId);
  const id = request.headers.get('x-upload-id');
  let filename: string;
  try {
    filename =
      [
        ...decodeURIComponent(request.headers.get('x-filename') ?? 'Document.pdf')
          .split(/[\\/]/)
          .at(-1)!,
      ]
        .filter((c) => c.charCodeAt(0) >= 32)
        .join('')
        .slice(0, 200) || 'Document.pdf';
  } catch {
    return jsonError(400, 'invalid_filename', 'Choose a valid filename.', requestId);
  }
  if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
    return jsonError(400, 'invalid_upload_id', 'Use the same upload ID when retrying.', requestId);

  const isPdfExt = /\.pdf$/i.test(filename);
  const isTxtExt = /\.(txt|text)$/i.test(filename);
  const isMdExt = /\.(md|markdown)$/i.test(filename);
  const contentTypeHdr = (request.headers.get('content-type') ?? '').toLowerCase();

  const isPdf = isPdfExt || contentTypeHdr === 'application/pdf';
  const isText = isTxtExt || isMdExt || contentTypeHdr.startsWith('text/');

  if (!isPdf && !isText) {
    return jsonError(
      400,
      'invalid_document_type',
      'Supported formats are PDF (.pdf), plain text (.txt), and Markdown (.md).',
      requestId,
    );
  }

  const maxAllowedBytes = isPdf ? DOCUMENT_MAX_BYTES : 2 * 1024 * 1024;
  if (size > maxAllowedBytes) {
    return jsonError(
      413,
      'file_too_large',
      isPdf ? 'PDFs can be up to 20 MB.' : 'Text files can be up to 2 MB.',
      requestId,
    );
  }

  const reader = request.body?.getReader();
  if (!reader) return jsonError(400, 'empty_document', 'Choose a document.', requestId);
  const parts: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > maxAllowedBytes) {
      await reader.cancel();
      return jsonError(
        413,
        'file_too_large',
        isPdf ? 'PDFs can be up to 20 MB.' : 'Text files can be up to 2 MB.',
        requestId,
      );
    }
    parts.push(part.value);
  }
  if (length === 0) {
    return jsonError(400, 'empty_document', 'The document is empty.', requestId);
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }

  let finalContentType = 'application/pdf';
  let storageExt = 'pdf';
  let extractedText: string | null = null;

  if (isPdf) {
    if (length < 8 || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
      return jsonError(
        400,
        'invalid_pdf',
        'This file is not a PDF. The extension alone is insufficient.',
        requestId,
      );
    }
  } else {
    // Text or Markdown validation
    try {
      extractedText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return jsonError(400, 'invalid_encoding', 'Text files must be valid UTF-8.', requestId);
    }
    if (extractedText.charCodeAt(0) === 0xfeff) {
      extractedText = extractedText.slice(1);
    }
    if (extractedText.includes('\0')) {
      return jsonError(
        400,
        'invalid_text_file',
        'Binary files with null bytes are not accepted as text documents.',
        requestId,
      );
    }
    if (isMdExt || contentTypeHdr === 'text/markdown') {
      finalContentType = 'text/markdown';
      storageExt = 'md';
    } else {
      finalContentType = 'text/plain';
      storageExt = 'txt';
    }
  }

  const hash = await checksum(bytes.buffer),
    now = new Date().toISOString(),
    key = `${workspace}/documents/${id}/original.${storageExt}`;

  const existing = await env.DB.prepare(
    `SELECT d.*, m.uploader_user_id, m.state AS media_state, m.retained, m.expires_at, m.deletion_claimed_at FROM document_extractions d JOIN media_objects m ON m.id = d.media_id AND m.workspace_id = d.workspace_id WHERE d.workspace_id = ? AND d.media_id = ?
    AND EXISTS (SELECT 1 FROM workspace_users member WHERE member.workspace_id = d.workspace_id AND member.user_id = ?)`,
  )
    .bind(workspace, id, scope.user.id)
    .first<
      Extraction & {
        uploader_user_id: string;
        media_state: string;
        retained: number;
        expires_at: string;
        deletion_claimed_at: string | null;
      }
    >();
  if (existing) {
    if (existing.checksum !== hash || existing.uploader_user_id !== scope.user.id)
      return jsonError(
        409,
        'upload_changed',
        'This upload ID belongs to different content. Choose the file again.',
        requestId,
      );
    if (
      !['ready', 'validated'].includes(existing.media_state) ||
      existing.deletion_claimed_at ||
      (existing.retained !== 1 && existing.expires_at <= now)
    )
      return jsonError(
        409,
        'upload_unavailable',
        'This upload is unavailable. Choose the file again.',
        requestId,
      );
    return jsonSuccess({ media_id: id, filename, extraction_state: existing.state }, 200);
  }

  const claim = await env.DB.prepare(
    `INSERT INTO media_objects(id, workspace_id, uploader_user_id, state, object_key, content_type, byte_size, filename, upload_token_hash, upload_token_expires_at, expires_at, created_at, updated_at)
    SELECT ?, ?, ?, 'quarantine', ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, upload_token_expires_at = excluded.upload_token_expires_at
      WHERE media_objects.workspace_id = excluded.workspace_id AND media_objects.uploader_user_id = excluded.uploader_user_id
        AND media_objects.upload_token_hash = excluded.upload_token_hash
        AND media_objects.state IN ('quarantine', 'ready') AND media_objects.deletion_claimed_at IS NULL RETURNING id`,
  )
    .bind(
      id,
      workspace,
      scope.user.id,
      key,
      finalContentType,
      length,
      filename,
      hash,
      new Date(Date.now() + 7200000).toISOString(),
      new Date(Date.now() + 14 * 86400000).toISOString(),
      now,
      now,
      workspace,
      scope.user.id,
    )
    .first();
  if (!claim)
    return jsonError(
      409,
      'upload_in_progress',
      'This upload is already being saved. Retry with the same ID.',
      requestId,
    );

  await env.STORAGE.put(key, bytes, { httpMetadata: { contentType: finalContentType } });

  let textResultKey: string | null = null;
  let textChunksJson: string | null = null;
  let initialExtractionState = 'pending';

  if (extractedText !== null) {
    // Direct chunking for text/markdown
    const chunks: string[] = [];
    for (let at = 0; at < extractedText.length; ) {
      let end = Math.min(at + 6000, extractedText.length);
      if (end < extractedText.length) {
        const paragraph = extractedText.lastIndexOf('\n', end);
        if (paragraph > at + 3000) end = paragraph + 1;
      }
      chunks.push(extractedText.slice(at, end));
      at = end;
    }
    textResultKey = `${workspace}/documents/${id}/text-direct.json`;
    await env.STORAGE.put(textResultKey, JSON.stringify(chunks), {
      httpMetadata: { contentType: 'application/json' },
    });
    textChunksJson = JSON.stringify(chunks.map((c, n) => ({ index: n, characters: c.length })));
    initialExtractionState = extractedText.length >= 20 ? 'ready' : 'needs_visual';
  }

  const committed = await env.DB.batch([
    env.DB.prepare(
      `UPDATE media_objects SET state = 'ready', validated_at = ?, upload_completed_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND state IN ('quarantine', 'ready') AND upload_token_hash = ? AND deletion_claimed_at IS NULL AND EXISTS (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?) RETURNING id`,
    ).bind(now, now, now, id, workspace, hash, workspace, scope.user.id),
    env.DB.prepare(
      `INSERT INTO document_extractions(media_id, workspace_id, checksum, state, result_key, chunks_json, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ? FROM media_objects WHERE id = ? AND workspace_id = ? AND state = 'ready' AND deletion_claimed_at IS NULL AND EXISTS (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?)
       ON CONFLICT(media_id) DO UPDATE SET state = excluded.state, result_key = excluded.result_key, chunks_json = excluded.chunks_json, updated_at = excluded.updated_at`,
    ).bind(
      id,
      workspace,
      hash,
      initialExtractionState,
      textResultKey,
      textChunksJson,
      now,
      id,
      workspace,
      workspace,
      scope.user.id,
    ),
  ]);

  if (!committed[0]!.results?.length) {
    const survivor = await env.DB.prepare(
      'SELECT id FROM media_objects WHERE workspace_id = ? AND id = ?',
    )
      .bind(workspace, id)
      .first();
    if (!survivor) await env.STORAGE.delete(key);
    return jsonError(403, 'access_lost', 'Workspace access changed during upload.', requestId);
  }

  if (isPdf && env.DISPATCH_QUEUE) {
    await env.DISPATCH_QUEUE.send({
      kind: 'document_extract',
      workspace_id: workspace,
      job_id: id,
    }).catch(() => undefined);
  }

  return jsonSuccess({ media_id: id, filename, extraction_state: initialExtractionState }, 201, {
    'cache-control': 'no-store',
  });
}

export async function processDocumentExtractions(
  env: Env,
  workspace?: string,
  mediaId?: string,
  limit = 2,
): Promise<number> {
  if (!env.STORAGE || !env.AI) return 0;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE document_extractions SET state = 'failed', error = 'Extraction stopped after repeated attempts. The original remains available.', updated_at = ? WHERE media_id IN (SELECT media_id FROM document_extractions WHERE state = 'running' AND attempt_expires_at <= ? AND attempt_count >= 3 LIMIT 2)",
  )
    .bind(now, now)
    .run();
  const jobs =
    (
      await env.DB.prepare(
        `SELECT d.media_id, d.workspace_id, m.object_key, m.filename FROM document_extractions d JOIN media_objects m ON m.id = d.media_id AND m.workspace_id = d.workspace_id
    WHERE (d.state = 'pending' OR (d.state = 'running' AND d.attempt_expires_at <= ?)) AND d.attempt_count < 3
    AND m.state = 'ready' AND m.deletion_claimed_at IS NULL AND (m.retained = 1 OR m.expires_at > ?)
    AND EXISTS (SELECT 1 FROM workspace_users member WHERE member.workspace_id = m.workspace_id AND (m.retained = 1 OR member.user_id = m.uploader_user_id))
    ${workspace ? 'AND d.workspace_id = ?' : ''} ${mediaId ? 'AND d.media_id = ?' : ''} LIMIT ?`,
      )
        .bind(now, now, ...(workspace ? [workspace] : []), ...(mediaId ? [mediaId] : []), limit)
        .all<{
          media_id: string;
          workspace_id: string;
          object_key: string;
          filename: string | null;
        }>()
    ).results ?? [];
  let completed = 0;
  for (const job of jobs) {
    const attempt = crypto.randomUUID(),
      expires = new Date(Date.now() + 120000).toISOString();
    const claimed = await env.DB.prepare(
      `UPDATE document_extractions SET state = 'running', attempt_id = ?, attempt_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE media_id = ? AND workspace_id = ? AND (state = 'pending' OR (state = 'running' AND attempt_expires_at <= ?)) AND attempt_count < 3
        AND EXISTS (SELECT 1 FROM media_objects m JOIN workspace_users member ON member.workspace_id = m.workspace_id AND (m.retained = 1 OR member.user_id = m.uploader_user_id)
          WHERE m.id = document_extractions.media_id AND m.workspace_id = document_extractions.workspace_id AND m.state = 'ready' AND m.deletion_claimed_at IS NULL AND (m.retained = 1 OR m.expires_at > ?)) RETURNING media_id`,
    )
      .bind(attempt, expires, now, job.media_id, job.workspace_id, now, now)
      .first();
    if (!claimed) continue;
    const resultKey = `${job.workspace_id}/documents/${job.media_id}/text-${attempt}.json`;
    try {
      const original = await env.STORAGE.get(job.object_key);
      if (!original) throw new Error('Original file is unavailable.');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const output = await Promise.race([
        env.AI.toMarkdown({
          name: job.filename ?? 'Document.pdf',
          blob: new Blob([await original.arrayBuffer()], { type: 'application/pdf' }),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Extraction timed out.')), 90_000);
        }),
      ]).finally(() => clearTimeout(timer));
      const converted = Array.isArray(output) ? output[0] : output;
      if (!converted || converted.format === 'error')
        throw new Error('This document could not be converted. Try an unlocked PDF.');
      const text = converted.data?.trim() ?? '';
      if (text.length > 2_000_000)
        throw new Error('The extracted text exceeds the supported document size. Split this PDF.');
      const chunks: string[] = [];
      for (let at = 0; at < text.length; ) {
        let end = Math.min(at + 6000, text.length);
        if (end < text.length) {
          const paragraph = text.lastIndexOf('\n', end);
          if (paragraph > at + 3000) end = paragraph + 1;
        }
        chunks.push(text.slice(at, end));
        at = end;
      }
      await env.STORAGE.put(resultKey, JSON.stringify(chunks), {
        httpMetadata: { contentType: 'application/json' },
      });
      const stored = await env.DB.prepare(
        `UPDATE document_extractions SET state = ?, result_key = ?, chunks_json = ?, error = ?, attempt_expires_at = NULL, updated_at = ?
        WHERE media_id = ? AND workspace_id = ? AND attempt_id = ? AND state = 'running'
        AND EXISTS (SELECT 1 FROM media_objects m JOIN workspace_users member ON member.workspace_id = m.workspace_id AND (m.retained = 1 OR member.user_id = m.uploader_user_id) WHERE m.id = document_extractions.media_id AND m.workspace_id = document_extractions.workspace_id AND m.state = 'ready' AND m.deletion_claimed_at IS NULL AND (m.retained = 1 OR m.expires_at > ?))
        RETURNING media_id`,
      )
        .bind(
          text.length >= 20 ? 'ready' : 'needs_visual',
          resultKey,
          JSON.stringify(chunks.map((c, n) => ({ index: n, characters: c.length }))),
          text.length >= 20
            ? null
            : 'Little readable text was found. This may need visual inspection or a clearer document.',
          new Date().toISOString(),
          job.media_id,
          job.workspace_id,
          attempt,
          new Date().toISOString(),
        )
        .first();
      if (!stored) await env.STORAGE.delete(resultKey);
      else completed++;
    } catch {
      await env.STORAGE.delete(resultKey).catch(() => undefined);
      await env.DB.prepare(
        "UPDATE document_extractions SET state = 'failed', error = 'Unable to extract this PDF. The original remains available; try an unlocked or clearer PDF.', attempt_expires_at = NULL, updated_at = ? WHERE media_id = ? AND workspace_id = ? AND attempt_id = ? AND state = 'running'",
      )
        .bind(new Date().toISOString(), job.media_id, job.workspace_id, attempt)
        .run();
    }
  }
  return completed;
}

export async function readDocument(
  env: Pick<Env, 'DB' | 'STORAGE'>,
  workspace: string,
  user: string,
  args: { media_id: string; cursor?: string; limit?: number },
) {
  const limit = args.limit ?? 2;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5)
    throw new Error('Choose 1–5 document sections.');
  const row = await env.DB.prepare(
    `SELECT d.*, m.filename, m.state AS media_state, m.retained, m.expires_at, m.deletion_claimed_at FROM document_extractions d JOIN media_objects m ON m.id = d.media_id AND m.workspace_id = d.workspace_id
    WHERE d.workspace_id = ? AND d.media_id = ? AND EXISTS (SELECT 1 FROM workspace_users WHERE workspace_id = d.workspace_id AND user_id = ?)`,
  )
    .bind(workspace, args.media_id, user)
    .first<
      Extraction & {
        filename: string;
        media_state: string;
        retained: number;
        expires_at: string;
        deletion_claimed_at: string | null;
      }
    >();
  if (!row) {
    const genDoc = await env.DB.prepare(
      `SELECT r.id, r.title, r.source_key, r.checksum, r.render_state, d.title as doc_title
       FROM document_revisions r
       JOIN generated_documents d ON d.id = r.document_id AND d.workspace_id = r.workspace_id
       WHERE (r.id = ? OR r.output_media_id = ? OR d.id = ?) AND r.workspace_id = ?
         AND EXISTS (SELECT 1 FROM workspace_users WHERE workspace_id = r.workspace_id AND user_id = ?)`
    )
      .bind(args.media_id, args.media_id, args.media_id, workspace, user)
      .first<{ id: string; title: string; source_key: string; checksum: string; render_state: string; doc_title: string }>();

    if (!genDoc) {
      throw new Error('Document not found in this workspace.');
    }
    if (!genDoc.source_key) {
      throw new Error('This document draft has not been published yet.');
    }
    const sourceObj = await env.STORAGE?.get(genDoc.source_key);
    if (!sourceObj) {
      throw new Error('Document source is unavailable.');
    }
    const markdown = await sourceObj.text();
    const chunks: string[] = [];
    for (let at = 0; at < markdown.length; ) {
      let end = Math.min(at + 6000, markdown.length);
      if (end < markdown.length) {
        const paragraph = markdown.lastIndexOf('\n', end);
        if (paragraph > at + 3000) end = paragraph + 1;
      }
      chunks.push(markdown.slice(at, end));
      at = end;
    }
    let start = 0;
    if (args.cursor) {
      try {
        const c = JSON.parse(atob(args.cursor)) as { workspace: string; media: string; start: number };
        if (c.workspace === workspace && c.media === args.media_id && Number.isInteger(c.start)) {
          start = c.start;
        }
      } catch {
        throw new Error('This document page is invalid.');
      }
    }
    const end = Math.min(start + limit, chunks.length);
    return {
      media_id: args.media_id,
      filename: `${genDoc.title || genDoc.doc_title}.md`,
      state: 'ready',
      error: null,
      sections: chunks.slice(start, end).map((text, n) => ({ section: start + n + 1, text })),
      next_cursor:
        end < chunks.length
          ? btoa(JSON.stringify({ workspace, media: args.media_id, start: end }))
          : null,
      coverage: {
        total_sections: chunks.length,
        from_section: start + 1,
        through_section: end,
        complete: start === 0 && end === chunks.length,
        page_numbers_available: false,
      },
      original_media_id: args.media_id,
    };
  }
  if (
    row.media_state !== 'ready' ||
    row.deletion_claimed_at ||
    (row.retained !== 1 && row.expires_at <= new Date().toISOString())
  )
    throw new Error('The original document is no longer available.');
  if (!['ready', 'needs_visual'].includes(row.state) || !row.result_key)
    return {
      media_id: args.media_id,
      filename: row.filename,
      state: row.state,
      error: row.error,
      sections: [],
      coverage: { complete: false, unavailable: true },
    };
  let start = 0;
  if (args.cursor) {
    try {
      const c = JSON.parse(atob(args.cursor)) as {
        workspace: string;
        media: string;
        hash: string;
        attempt: string;
        start: number;
      };
      if (
        args.cursor.length > 2000 ||
        c.workspace !== workspace ||
        c.media !== args.media_id ||
        c.hash !== row.checksum ||
        c.attempt !== row.attempt_id ||
        !Number.isInteger(c.start) ||
        c.start < 0
      )
        throw new Error();
      start = c.start;
    } catch {
      throw new Error('This document page is invalid or the extraction changed.');
    }
  }
  const object = await env.STORAGE?.get(row.result_key);
  if (!object) throw new Error('Extracted text is unavailable. The original can still be opened.');
  const chunks = await object.json<string[]>();
  if (start > chunks.length) throw new Error('This section is outside the document.');
  const end = Math.min(start + limit, chunks.length);
  return {
    media_id: args.media_id,
    filename: row.filename,
    state: row.state,
    error: row.error,
    sections: chunks.slice(start, end).map((text, n) => ({ section: start + n + 1, text })),
    next_cursor:
      end < chunks.length
        ? btoa(
            JSON.stringify({
              workspace,
              media: args.media_id,
              hash: row.checksum,
              attempt: row.attempt_id,
              start: end,
            }),
          )
        : null,
    coverage: {
      total_sections: chunks.length,
      from_section: start + 1,
      through_section: end,
      complete: start === 0 && end === chunks.length,
      page_numbers_available: false,
    },
    original_media_id: args.media_id,
  };
}
