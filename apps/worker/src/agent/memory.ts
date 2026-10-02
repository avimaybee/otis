/**
 * @otis/worker/agent/memory
 * Deterministic extractive memory summarization, asynchronous refresh jobs,
 * and deterministic replay/rebuild of memory projections.
 * In accordance with plans/006-implementation-handoff.md Section 9 & 10.
 */

import { rebuildProjections } from '@otis/ledger';
import type {
  ChannelType,
  LedgerEvent,
  LedgerEventKind,
  Provenance,
} from '@otis/contracts';

export interface ExtractiveSummaryResult {
  summaryText: string;
  sourceManifest: Array<{ type: string; id: string }>;
  builtFromRevision: number;
}

export interface ReplayMemoryResult {
  entriesCount: number;
  suppressionsCount: number;
  ftsCount: number;
}

/**
 * Extracts raw summary text and source manifest for a given scope without writing to DB.
 * Pure extraction from canonical records and active notes; no LLM call and no invented facts.
 */
export async function extractSummaryContent(
  db: D1Database,
  params: {
    workspaceId: string;
    scope: string;
    subjectKey: string;
  },
): Promise<{ summaryText: string; manifest: Array<{ type: string; id: string }> }> {
  const { workspaceId, scope, subjectKey } = params;
  const manifest: Array<{ type: string; id: string }> = [];
  const lines: string[] = [];

  if (scope === 'workspace') {
    // 1. Active workspace-level notes ONLY (filter scope = 'workspace' to avoid member preference contamination)
    const notes = (
      await db
        .prepare(
          `SELECT id, category, content, observed_at
           FROM memory_entries
           WHERE workspace_id = ? AND status = 'active' AND scope = 'workspace'
           ORDER BY observed_at DESC LIMIT 15`,
        )
        .bind(workspaceId)
        .all<{ id: string; category: string; content: string; observed_at: string }>()
    ).results || [];

    if (notes.length > 0) {
      lines.push('Active Context & Preferences:');
      for (const n of notes) {
        lines.push(`- [${n.category}] ${n.content}`);
        manifest.push({ type: 'memory_entry', id: n.id });
      }
    }

    // 2. High-level pipeline entities
    const entities = (
      await db
        .prepare(
          `SELECT id, name, kind, status
           FROM entities
           WHERE workspace_id = ?
           ORDER BY updated_at DESC LIMIT 10`,
        )
        .bind(workspaceId)
        .all<{ id: string; name: string; kind: string; status: string }>()
    ).results || [];

    if (entities.length > 0) {
      lines.push('\nActive Pipeline Entities:');
      for (const e of entities) {
        lines.push(`- ${e.name} (${e.status})`);
        manifest.push({ type: 'entity', id: e.id });
      }
    }

    // 3. Open tasks
    const tasks = (
      await db
        .prepare(
          `SELECT id, title, due_kind, due_local_date, due_instant
           FROM tasks
           WHERE workspace_id = ? AND status = 'open'
           ORDER BY updated_at DESC LIMIT 10`,
        )
        .bind(workspaceId)
        .all<{ id: string; title: string; due_kind: string | null; due_local_date: string | null; due_instant: string | null }>()
    ).results || [];

    if (tasks.length > 0) {
      lines.push('\nOpen Tasks:');
      for (const t of tasks) {
        const dueStr = t.due_local_date || t.due_instant || 'no deadline';
        lines.push(`- ${t.title} (due: ${dueStr})`);
        manifest.push({ type: 'task', id: t.id });
      }
    }
  } else if (scope === 'entity') {
    const entity = await db
      .prepare(`SELECT id, name, kind, status FROM entities WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, subjectKey)
      .first<{ id: string; name: string; kind: string; status: string }>();

    if (entity) {
      lines.push(`Entity Summary: ${entity.name} (${entity.kind}, status: ${entity.status})`);
      manifest.push({ type: 'entity', id: entity.id });

      const notes = (
        await db
          .prepare(
            `SELECT id, category, content
             FROM memory_entries
             WHERE workspace_id = ? AND scope = 'entity' AND subject_id = ? AND status = 'active'
             ORDER BY observed_at DESC LIMIT 10`,
          )
          .bind(workspaceId, subjectKey)
          .all<{ id: string; category: string; content: string }>()
      ).results || [];

      if (notes.length > 0) {
        lines.push('Notes:');
        for (const n of notes) {
          lines.push(`- [${n.category}] ${n.content}`);
          manifest.push({ type: 'memory_entry', id: n.id });
        }
      }
    }
  } else if (scope === 'member_in_workspace') {
    const memberNotes = (
      await db
        .prepare(
          `SELECT id, category, content
           FROM memory_entries
           WHERE workspace_id = ? AND scope = 'member_in_workspace' AND subject_id = ? AND status = 'active'
           ORDER BY observed_at DESC LIMIT 10`,
        )
        .bind(workspaceId, subjectKey)
        .all<{ id: string; category: string; content: string }>()
    ).results || [];

    if (memberNotes.length > 0) {
      lines.push(`Member Preferences & Notes for ${subjectKey}:`);
      for (const n of memberNotes) {
        lines.push(`- [${n.category}] ${n.content}`);
        manifest.push({ type: 'memory_entry', id: n.id });
      }
    }
  }

  const summaryText = lines.join('\n');
  return { summaryText, manifest };
}

/**
 * Builds a deterministic, extractive summary and source manifest for a given scope.
 * Pure extraction from canonical records and active notes; no LLM call and no invented facts.
 */
export async function buildExtractiveSummary(
  db: D1Database,
  params: {
    workspaceId: string;
    scope: string;
    subjectKey: string;
    currentRevision: number;
  },
): Promise<ExtractiveSummaryResult> {
  const { workspaceId, scope, subjectKey, currentRevision } = params;
  const { summaryText, manifest } = await extractSummaryContent(db, { workspaceId, scope, subjectKey });
  const now = new Date().toISOString();
  const summaryId = `sum_${crypto.randomUUID()}`;

  // Persist to memory_summaries guarded by revision
  await db
    .prepare(
      `INSERT INTO memory_summaries (
         id, workspace_id, scope, subject_key, summary_text, source_manifest_json,
         built_from_revision, format_version, generation_model, built_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)
       ON CONFLICT(workspace_id, scope, subject_key) DO UPDATE SET
         summary_text = excluded.summary_text,
         source_manifest_json = excluded.source_manifest_json,
         built_from_revision = excluded.built_from_revision,
         format_version = excluded.format_version,
         built_at = excluded.built_at
       WHERE memory_summaries.built_from_revision <= excluded.built_from_revision`,
    )
    .bind(
      summaryId,
      workspaceId,
      scope,
      subjectKey,
      summaryText,
      JSON.stringify(manifest),
      currentRevision,
      now,
    )
    .run();

  return {
    summaryText,
    sourceManifest: manifest,
    builtFromRevision: currentRevision,
  };
}

/**
 * Processes eligible memory refresh jobs conditionally under lease.
 * Supports discovery by workspace or job ID.
 */
export async function processMemoryRefreshJobs(
  db: D1Database,
  options?: { workspaceId?: string; jobId?: string; limit?: number },
): Promise<{ processed: number; completed: number }> {
  const limit = options?.limit ?? 5;
  const now = new Date();
  const nowIso = now.toISOString();

  // 0. Clean up lease-expired running jobs that have exhausted max_attempts
  await db
    .prepare(
      `UPDATE memory_refresh_jobs
       SET state = 'failed', claim_token = NULL, claim_expires_at = NULL,
           error_class = 'LeaseExpiredExhausted', updated_at = ?
       WHERE state = 'running' AND claim_expires_at < ? AND attempts >= max_attempts`,
    )
    .bind(nowIso, nowIso)
    .run();

  // 1. Discover pending or lease-expired running jobs
  let query = `SELECT id, workspace_id, scope, subject_key, target_revision, attempts, max_attempts
               FROM memory_refresh_jobs
               WHERE attempts < max_attempts
                 AND ((state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
                      OR (state = 'running' AND claim_expires_at < ?))`;
  const binds: (string | number)[] = [nowIso, nowIso];

  if (options?.workspaceId) {
    query += ` AND workspace_id = ?`;
    binds.push(options.workspaceId);
  }
  if (options?.jobId) {
    query += ` AND id = ?`;
    binds.push(options.jobId);
  }

  query += ` ORDER BY created_at ASC LIMIT ?`;
  binds.push(limit);

  const jobs = (await db.prepare(query).bind(...binds).all<Record<string, unknown>>()).results || [];
  if (jobs.length === 0) {
    return { processed: 0, completed: 0 };
  }

  let completedCount = 0;

  for (const job of jobs) {
    const jobId = String(job['id']);
    const wsId = String(job['workspace_id']);
    const scope = String(job['scope']);
    const subjectKey = String(job['subject_key']);
    const targetRev = Number(job['target_revision'] ?? 0);
    const attempts = Number(job['attempts'] ?? 0);
    const maxAttempts = Number(job['max_attempts'] ?? 3);
    const claimToken = `claim_${crypto.randomUUID()}`;
    const claimExpiresAt = new Date(now.getTime() + 60000).toISOString();

    // 2. Claim job conditionally
    const claimRes = await db
      .prepare(
        `UPDATE memory_refresh_jobs
         SET state = 'running', claim_token = ?, claim_expires_at = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND attempts < max_attempts AND (
           (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
           OR (state = 'running' AND claim_expires_at < ?)
         )`,
      )
      .bind(claimToken, claimExpiresAt, nowIso, jobId, nowIso, nowIso)
      .run();

    if ((claimRes.meta.changes ?? 0) !== 1) {
      // Contended or already claimed
      continue;
    }

    try {
      // 3. Read current workspace business_revision
      const ws = await db
        .prepare(`SELECT business_revision FROM workspaces WHERE id = ?`)
        .bind(wsId)
        .first<{ business_revision: number }>();
      const currentRev = ws?.business_revision ?? 0;

      if (currentRev !== targetRev) {
        // Sources changed since this refresh was scheduled: terminate job without publishing stale summary
        await db
          .prepare(
            `UPDATE memory_refresh_jobs
             SET state = 'completed', claim_token = NULL, claim_expires_at = NULL,
                 error_class = 'RevisionMismatch', updated_at = ?
             WHERE id = ? AND claim_token = ?`,
          )
          .bind(new Date().toISOString(), jobId, claimToken)
          .run();
        continue;
      }

      // 4. Extract summary without writing
      const { summaryText, manifest } = await extractSummaryContent(db, {
        workspaceId: wsId,
        scope,
        subjectKey,
      });

      const summaryId = `sum_${crypto.randomUUID()}`;
      const completedIso = new Date().toISOString();

      // 5. Complete job and publish summary in one guarded D1 batch
      // Statement 0 publishes while job is running with matching claim and target revision matching workspace
      // Statement 1 completes job under the identical ownership and revision guard
      const statements: D1PreparedStatement[] = [
        db
          .prepare(
            `INSERT INTO memory_summaries (
               id, workspace_id, scope, subject_key, summary_text, source_manifest_json,
               built_from_revision, format_version, generation_model, built_at
             )
             SELECT ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?
             FROM memory_refresh_jobs
             WHERE id = ?
               AND state = 'running'
               AND claim_token = ?
               AND claim_expires_at > ?
               AND target_revision = ?
               AND (SELECT business_revision FROM workspaces WHERE id = memory_refresh_jobs.workspace_id) = ?
             ON CONFLICT(workspace_id, scope, subject_key) DO UPDATE SET
               summary_text = excluded.summary_text,
               source_manifest_json = excluded.source_manifest_json,
               built_from_revision = excluded.built_from_revision,
               format_version = excluded.format_version,
               built_at = excluded.built_at
             WHERE memory_summaries.built_from_revision <= excluded.built_from_revision`,
          )
          .bind(
            summaryId,
            wsId,
            scope,
            subjectKey,
            summaryText,
            JSON.stringify(manifest),
            currentRev,
            completedIso,
            jobId,
            claimToken,
            completedIso,
            targetRev,
            targetRev,
          ),
        db
          .prepare(
            `UPDATE memory_refresh_jobs
             SET state = 'completed', claim_token = NULL, claim_expires_at = NULL, updated_at = ?
             WHERE id = ?
               AND state = 'running'
               AND claim_token = ?
               AND claim_expires_at > ?
               AND target_revision = ?
               AND (SELECT business_revision FROM workspaces WHERE id = memory_refresh_jobs.workspace_id) = ?`,
          )
          .bind(
            completedIso,
            jobId,
            claimToken,
            completedIso,
            targetRev,
            targetRev,
          ),
      ];

      const batchRes = await db.batch(statements);
      const summaryInsertedOrUpdated = (batchRes[0]?.meta.changes ?? 0) >= 1;
      const jobCompleted = (batchRes[1]?.meta.changes ?? 0) === 1;

      if (summaryInsertedOrUpdated && jobCompleted) {
        completedCount += 1;
      } else if (!jobCompleted) {
        // If the batch could not complete the job, check if revision changed in the meantime
        const latestWs = await db
          .prepare(`SELECT business_revision FROM workspaces WHERE id = ?`)
          .bind(wsId)
          .first<{ business_revision: number }>();
        if (latestWs && latestWs.business_revision !== targetRev) {
          await db
            .prepare(
              `UPDATE memory_refresh_jobs
               SET state = 'completed', claim_token = NULL, claim_expires_at = NULL,
                   error_class = 'RevisionMismatch', updated_at = ?
               WHERE id = ? AND claim_token = ?`,
            )
            .bind(completedIso, jobId, claimToken)
            .run();
        }
      }
    } catch (err) {
      // Record failure with backoff or mark failed if attempts exhausted
      const isExhausted = attempts + 1 >= maxAttempts;
      const nextAttemptAt = new Date(now.getTime() + 30000).toISOString();
      await db
        .prepare(
          `UPDATE memory_refresh_jobs
           SET state = ?, claim_token = NULL, claim_expires_at = NULL,
               error_class = ?, next_attempt_at = ?, updated_at = ?
           WHERE id = ? AND claim_token = ?`,
        )
        .bind(
          isExhausted ? 'failed' : 'pending',
          err instanceof Error ? err.name : 'UnknownError',
          nextAttemptAt,
          new Date().toISOString(),
          jobId,
          claimToken,
        )
        .run();
    }
  }

  return { processed: jobs.length, completed: completedCount };
}

/**
 * Operator / recovery rebuild function for workspace memory.
 * Reconstructs memory_entries, memory_suppressions, and active FTS exclusively
 * from historical ledger events. Generates zero new business events or chat messages.
 */
export async function replayWorkspaceMemory(
  db: D1Database,
  workspaceId: string,
): Promise<ReplayMemoryResult> {
  const ws = await db
    .prepare(`SELECT business_revision, last_event_sequence FROM workspaces WHERE id = ?`)
    .bind(workspaceId)
    .first<{ business_revision: number; last_event_sequence: number }>();
  if (!ws) {
    throw new Error(`Workspace ${workspaceId} not found`);
  }
  const expectedRevision = ws.business_revision;
  const expectedSeq = ws.last_event_sequence;

  // 1. Fetch all events for the workspace in sequence order
  const rows = (
    await db
      .prepare(
        `SELECT id, workspace_id, sequence, entity_id, actor_kind, actor_user_id, actor_job_id, kind, schema_version, payload_json, occurred_at, recorded_at, channel, source_message_id, source_job_id, action_id, supersedes_event_id, reverts_event_id, provenance, created_at
         FROM events
         WHERE workspace_id = ?
         ORDER BY sequence ASC`,
      )
      .bind(workspaceId)
      .all<Record<string, unknown>>()
  ).results || [];

  const ledgerEvents: LedgerEvent[] = rows.map((r) => ({
    id: String(r['id']),
    workspace_id: String(r['workspace_id']),
    sequence: Number(r['sequence']),
    entity_id: r['entity_id'] ? String(r['entity_id']) : null,
    actor_kind: (r['actor_kind'] as 'member' | 'system') || 'member',
    actor_user_id: r['actor_user_id'] ? String(r['actor_user_id']) : null,
    actor_job_id: r['actor_job_id'] ? String(r['actor_job_id']) : null,
    kind: r['kind'] as LedgerEventKind,
    schema_version: Number(r['schema_version'] ?? 1),
    payload: JSON.parse(String(r['payload_json'] || '{}')),
    recorded_at: String(r['recorded_at']),
    occurred_at: String(r['occurred_at']),
    channel: (r['channel'] as ChannelType) || 'web',
    source_message_id: r['source_message_id'] ? String(r['source_message_id']) : null,
    source_job_id: r['source_job_id'] ? String(r['source_job_id']) : null,
    action_id: String(r['action_id'] || ''),
    supersedes_event_id: r['supersedes_event_id'] ? String(r['supersedes_event_id']) : null,
    reverts_event_id: r['reverts_event_id'] ? String(r['reverts_event_id']) : null,
    provenance: (r['provenance'] as Provenance) || 'stated',
    created_at: String(r['created_at'] || r['recorded_at']),
  }));

  // 2. Pure projection rebuild reusing causal revert semantics from @otis/ledger
  const projection = rebuildProjections(ledgerEvents);
  const memoryEntries = projection.memoryEntries;
  const suppressions = projection.memorySuppressions;

  // 3. Clear existing projections in D1 guarded by current sequence and revision
  const existingEntries = (
    await db
      .prepare(`SELECT id FROM memory_entries WHERE workspace_id = ?`)
      .bind(workspaceId)
      .all<{ id: string }>()
  ).results || [];

  const guardId = `guard_${crypto.randomUUID()}`;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO ledger_guards (id, guard_ok)
         VALUES (?, (
           SELECT 1 FROM workspaces
           WHERE id = ? AND business_revision = ? AND last_event_sequence = ?
         ))`,
      )
      .bind(guardId, workspaceId, expectedRevision, expectedSeq),
    db.prepare(`DELETE FROM memory_entries WHERE workspace_id = ?`).bind(workspaceId),
    db.prepare(`DELETE FROM memory_suppressions WHERE workspace_id = ?`).bind(workspaceId),
  ];

  for (const ent of existingEntries) {
    statements.push(
      db.prepare(`DELETE FROM memory_entries_fts WHERE entry_id = ?`).bind(ent.id),
    );
  }

  // 4. Re-insert reconstructed memory entries
  for (const mem of memoryEntries.values()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO memory_entries (
             id, workspace_id, scope, subject_id, category, content, status, provenance,
             source_event_id, source_message_id, author_user_id, observed_at, created_at,
             superseding_event_id, business_revision
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          mem.id,
          mem.workspace_id,
          mem.scope,
          mem.subject_id ?? null,
          mem.category,
          mem.content,
          mem.status,
          mem.provenance ?? 'stated',
          mem.source_event_id ?? null,
          mem.source_message_id ?? null,
          mem.author_user_id ?? null,
          mem.observed_at,
          mem.created_at,
          mem.superseding_event_id ?? null,
          mem.business_revision,
        ),
    );

    // If active, insert into FTS
    if (mem.status === 'active') {
      statements.push(
        db
          .prepare(`INSERT INTO memory_entries_fts (entry_id, content) VALUES (?, ?)`)
          .bind(mem.id, mem.content),
      );
    }
  }

  // 5. Re-insert reconstructed suppressions
  for (const sup of suppressions.values()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO memory_suppressions (
             id, workspace_id, target_memory_id, source_event_id, source_message_id,
             suppression_event_id, revision, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          sup.id,
          sup.workspace_id,
          sup.target_memory_id,
          sup.source_event_id ?? null,
          sup.source_message_id ?? null,
          sup.suppression_event_id,
          sup.revision,
          sup.created_at,
        ),
    );
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }

  const ftsCount = Array.from(memoryEntries.values()).filter((m) => m.status === 'active').length;

  return {
    entriesCount: memoryEntries.size,
    suppressionsCount: suppressions.size,
    ftsCount,
  };
}
