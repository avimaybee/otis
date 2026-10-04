/**
 * @otis/worker/media/cleanup
 * Idempotent private audio retention cleanup for Gate 010.
 *
 * Accepted audio expires after 14 days; transcript/source rows are preserved.
 * Abandoned quarantine uploads whose ticket expired are removed promptly.
 * Deletion is idempotent and reports failures instead of pretending success.
 */

import { listExpiredMedia, markMediaDeleted, markMediaExpired } from './repository.js';

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

  for (const row of await listExpiredMedia(db, nowIso, limit)) {
    try {
      await storage.delete(row.object_key);
      await markMediaExpired(db, { workspaceId: row.workspace_id, mediaId: row.id, nowIso });
      result.expired += 1;
    } catch {
      result.failed += 1;
    }
  }

  const { results } = await db
    .prepare(
      `SELECT id, workspace_id, object_key FROM media_objects
       WHERE state = 'quarantine' AND upload_token_expires_at IS NOT NULL AND upload_token_expires_at <= ?
       ORDER BY upload_token_expires_at ASC LIMIT ?`,
    )
    .bind(nowIso, limit)
    .all<{ id: string; workspace_id: string; object_key: string }>();
  for (const row of results ?? []) {
    try {
      await storage.delete(row.object_key);
      await markMediaDeleted(db, { workspaceId: row.workspace_id, mediaId: row.id, nowIso });
      result.abandoned += 1;
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
       WHERE m.state = 'validated' AND t.id IS NULL AND m.created_at <= ?
       ORDER BY m.created_at ASC LIMIT ?`,
    )
    .bind(orphanCutoff, limit)
    .all<{ id: string; workspace_id: string; object_key: string }>();
  for (const row of orphans ?? []) {
    try {
      await storage.delete(row.object_key);
      await markMediaDeleted(db, { workspaceId: row.workspace_id, mediaId: row.id, nowIso });
      result.abandoned += 1;
    } catch {
      result.failed += 1;
    }
  }

  return result;
}
