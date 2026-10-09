/**
 * @otis/worker/media/cleanup
 * Idempotent private audio retention cleanup for Gate 010.
 *
 * Accepted audio expires after 14 days; transcript/source rows are preserved.
 * Abandoned quarantine uploads whose ticket expired are removed promptly.
 * Deletion is idempotent and reports failures instead of pretending success.
 */

import { listExpiredMedia } from './repository.js';
import { deleteRendition } from './renditions.js';

export interface MediaCleanupResult {
  expired: number;
  abandoned: number;
  failed: number;
}

export async function cleanupExpiredMedia(
  db: D1Database,
  storage: R2Bucket,
  options: { nowIso?: string; limit?: number } = {},
): Promise<MediaCleanupResult> {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const limit = Math.min(options.limit ?? 25, 100);
  const result: MediaCleanupResult = { expired: 0, abandoned: 0, failed: 0 };
  const remove = async (row: { id: string; workspace_id: string; object_key: string }, state: 'expired' | 'deleted') => {
    // Claim in D1 before external deletion. Linking uses the same row's
    // unclaimed predicate in its ledger guard, so a later link cannot save
    // metadata for bytes already selected for deletion.
    const claim = await db.prepare(`UPDATE media_objects SET state = ?, deletion_claimed_at = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND retained = 0
      AND NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.workspace_id = media_objects.workspace_id AND l.media_id = media_objects.id AND l.state = 'active')
      AND ((? = 'expired' AND (expires_at <= ? OR (state = 'expired' AND deletion_claimed_at IS NOT NULL)))
        OR (? = 'deleted' AND ((state = 'quarantine' AND upload_token_expires_at <= ?)
          OR (state = 'deleted' AND deletion_claimed_at IS NOT NULL)
          OR (state = 'validated' AND created_at <= ?
            AND NOT EXISTS (SELECT 1 FROM media_transcriptions t WHERE t.media_id = media_objects.id)
            AND NOT EXISTS (SELECT 1 FROM message_image_attachments a WHERE a.media_id = media_objects.id)
            AND NOT EXISTS (SELECT 1 FROM document_extractions d WHERE d.media_id = media_objects.id)))))
      RETURNING id`).bind(state, nowIso, nowIso, row.workspace_id, row.id, state, nowIso, state, nowIso, new Date(Date.parse(nowIso) - 3600000).toISOString()).first();
    if (!claim) return false;
    await storage.delete(row.object_key);
    await deleteRendition(storage, row.id);
    const document = await db.prepare('SELECT result_key FROM document_extractions WHERE workspace_id = ? AND media_id = ?').bind(row.workspace_id, row.id).first<{ result_key: string | null }>();
    if (document?.result_key) await storage.delete(document.result_key);
    await db.prepare('UPDATE media_objects SET deletion_claimed_at = NULL WHERE workspace_id = ? AND id = ? AND state = ?').bind(row.workspace_id, row.id, state).run();
    return true;
  };

  for (const row of await listExpiredMedia(db, nowIso, limit)) {
    try {
      if (await remove(row, 'expired')) result.expired += 1;
    } catch {
      result.failed += 1;
    }
  }

  const { results } = await db
    .prepare(
      `SELECT id, workspace_id, object_key FROM media_objects
       WHERE retained = 0 AND ((state = 'quarantine' AND upload_token_expires_at IS NOT NULL AND upload_token_expires_at <= ?) OR (state = 'deleted' AND deletion_claimed_at IS NOT NULL))
       ORDER BY upload_token_expires_at ASC LIMIT ?`,
    )
    .bind(nowIso, limit)
    .all<{ id: string; workspace_id: string; object_key: string }>();
  for (const row of results ?? []) {
    try {
      if (await remove(row, 'deleted')) result.abandoned += 1;
    } catch {
      result.failed += 1;
    }
  }

  // Orphaned validated media (for example a channel ingest whose acceptance
  // batch lost a membership race) has no transcription receipt: delete it
  // promptly instead of retaining bytes forever.
  const orphanCutoff = new Date(new Date(nowIso).getTime() - 60 * 60 * 1000).toISOString();
  const { results: orphans } = await db
    .prepare(
      `SELECT m.id, m.workspace_id, m.object_key FROM media_objects m
       LEFT JOIN media_transcriptions t ON t.media_id = m.id
       WHERE m.state = 'validated' AND m.retained = 0 AND t.id IS NULL AND m.created_at <= ?
         AND NOT EXISTS (SELECT 1 FROM message_image_attachments a WHERE a.media_id = m.id)
         AND NOT EXISTS (SELECT 1 FROM document_extractions d WHERE d.media_id = m.id)
         AND NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.media_id = m.id AND l.workspace_id = m.workspace_id AND l.state = 'active')
       ORDER BY m.created_at ASC LIMIT ?`,
    )
    .bind(orphanCutoff, limit)
    .all<{ id: string; workspace_id: string; object_key: string }>();
  for (const row of orphans ?? []) {
    try {
      if (await remove(row, 'deleted')) result.abandoned += 1;
    } catch {
      result.failed += 1;
    }
  }

  return result;
}
