/**
 * Post-commit R2 cleanup for workspace erasure.
 *
 * Erasure commits its D1 cascade first and deletes bytes after, so a failed
 * byte deletion leaves orphan bytes — never live rows pointing at missing
 * bytes. Whatever the request-bounded pass cannot finish is recorded in
 * `workspace_erasure_cleanups` (failed keys plus un-swept prefixes) and the
 * existing cron sweep retries it to completion. R2 delete is idempotent, so
 * retried keys and re-swept prefixes are safe.
 */

import { renditionKeyFor } from '../media/renditions.js';

export interface ErasureR2Inventory {
  /** Every inventoried key: originals, global renditions, extraction results, generated families. */
  keys: string[];
}

export interface ErasureR2Outcome {
  deleted: number;
  failedKeys: string[];
  /** Workspace-owned prefixes the bounded sweep did not finish. */
  pendingPrefixes: string[];
}

export function erasurePrefixes(workspaceId: string): string[] {
  return [`workspace/${workspaceId}/`, `${workspaceId}/documents/`];
}

/** Read-only inventory of every R2 key the workspace owns, before the D1 rows go. */
export async function collectErasureR2Inventory(
  db: D1Database,
  workspaceId: string,
): Promise<ErasureR2Inventory> {
  const mediaRows = (
    await db.prepare(
      `SELECT m.id, m.object_key, d.result_key FROM media_objects m
        LEFT JOIN document_extractions d ON d.media_id = m.id AND d.workspace_id = m.workspace_id
        WHERE m.workspace_id = ?`,
    )
      .bind(workspaceId)
      .all<{ id: string; object_key: string; result_key: string | null }>()
  ).results;
  const generatedKeys = (
    await db.prepare(`SELECT source_key FROM document_revisions WHERE workspace_id = ? AND source_key != ''`)
      .bind(workspaceId)
      .all<{ source_key: string }>()
  ).results;
  const keys = new Set<string>();
  for (const row of mediaRows) {
    keys.add(row.object_key);
    keys.add(renditionKeyFor(row.id));
    if (row.result_key) keys.add(row.result_key);
  }
  for (const rev of generatedKeys) {
    // Each revision owns its source Markdown, draft JSON, and structured
    // manifest under one predictable key family. Draft revisions carry
    // the draft key itself as their source key.
    const sourceKey: string = rev.source_key;
    const base = sourceKey.endsWith('-source.md')
      ? sourceKey.slice(0, -'-source.md'.length)
      : sourceKey.endsWith('-draft.json')
        ? sourceKey.slice(0, -'-draft.json'.length)
        : sourceKey;
    keys.add(sourceKey);
    keys.add(`${base}-source.md`);
    keys.add(`${base}-draft.json`);
    keys.add(`${base}-manifest.json`);
  }
  return { keys: [...keys] };
}

export interface ErasureR2Budgets {
  /** Max inventoried-key deletes per pass. */
  keyBudget?: number;
  /** Max swept-prefix object deletes per pass. */
  sweepBudget?: number;
}

/**
 * Delete inventoried keys, then sweep workspace-owned prefixes. Bounded per
 * pass: leftovers come back as failed keys / pending prefixes for the retry
 * record instead of looping forever inside one request.
 */
export async function runErasureR2Cleanup(
  storage: R2Bucket,
  workspaceId: string,
  inventory: ErasureR2Inventory,
  budgets: ErasureR2Budgets = {},
): Promise<ErasureR2Outcome> {
  const keyBudget = budgets.keyBudget ?? 600;
  const sweepBudget = budgets.sweepBudget ?? 2000;
  const outcome: ErasureR2Outcome = { deleted: 0, failedKeys: [], pendingPrefixes: [] };
  const keys = inventory.keys.slice(0, keyBudget);
  const deferredKeys = inventory.keys.slice(keys.length);
  for (const key of keys) {
    try {
      await storage.delete(key);
      outcome.deleted++;
    } catch {
      outcome.failedKeys.push(key);
    }
  }
  // Keys beyond the budget stay retryable: the prefix sweep below (or the
  // cron pass) covers every workspace-owned key; only globally-keyed
  // renditions need their explicit entries preserved.
  const globalRemainder = deferredKeys.filter((key) => !key.startsWith(`workspace/${workspaceId}/`) && !key.startsWith(`${workspaceId}/`));
  outcome.failedKeys.push(...globalRemainder);
  let swept = 0;
  for (const prefix of erasurePrefixes(workspaceId)) {
    let cursor: string | undefined = undefined;
    let prefixDone = false;
    while (!prefixDone) {
      let listed;
      try {
        listed = await storage.list({ prefix, limit: 100, ...(cursor ? { cursor } : {}) });
      } catch {
        break;
      }
      for (const obj of listed.objects) {
        if (swept >= sweepBudget) break;
        try {
          await storage.delete(obj.key);
          outcome.deleted++;
        } catch {
          outcome.failedKeys.push(obj.key);
        }
        swept++;
      }
      if (swept >= sweepBudget) break;
      if (listed.truncated) {
        cursor = listed.cursor;
      } else {
        prefixDone = true;
      }
    }
    if (!prefixDone) outcome.pendingPrefixes.push(prefix);
  }
  return outcome;
}

export interface ErasureCleanupRecord {
  failedKeys: string[];
  pendingPrefixes: string[];
  attempts: number;
}

/** One render attempt key retained across erasure with its sweep deadline. */
export interface ErasureAttemptKey {
  key: string;
  /** ISO time before which cron must not touch the key (in-flight window). */
  deleteAfter: string;
}

export interface ErasureCleanupState {
  erasureId: string;
  failedKeys: string[];
  pendingPrefixes: string[];
  attemptKeys: ErasureAttemptKey[];
  rawKeysJson: string;
  rawPrefixesJson: string;
  rawAttemptKeysJson: string;
}

/** Read the current cleanup record with the exact stored JSON for compare-and-swap. */
export async function readErasureCleanup(
  db: D1Database,
  workspaceId: string,
): Promise<ErasureCleanupState | null> {
  const row = await db.prepare(
    `SELECT erasure_id, failed_keys_json, pending_prefixes_json, attempt_keys_json FROM workspace_erasure_cleanups WHERE workspace_id = ?`,
  ).bind(workspaceId).first<{ erasure_id: string; failed_keys_json: string; pending_prefixes_json: string; attempt_keys_json: string | null }>();
  if (!row) return null;
  let failedKeys: string[] = [];
  let pendingPrefixes: string[] = [];
  let attemptKeys: ErasureAttemptKey[] = [];
  try {
    const parsedKeys: unknown = JSON.parse(row.failed_keys_json);
    if (Array.isArray(parsedKeys)) failedKeys = parsedKeys.filter((k): k is string => typeof k === 'string');
  } catch { /* corrupt key list reads as empty; prefixes still sweep workspace bytes */ }
  try {
    const parsedPrefixes: unknown = JSON.parse(row.pending_prefixes_json);
    if (Array.isArray(parsedPrefixes)) pendingPrefixes = parsedPrefixes.filter((p): p is string => typeof p === 'string');
  } catch { /* corrupt prefixes read as empty */ }
  try {
    const parsedAttempts: unknown = row.attempt_keys_json ? JSON.parse(row.attempt_keys_json) : [];
    if (Array.isArray(parsedAttempts)) {
      attemptKeys = parsedAttempts.filter((a): a is ErasureAttemptKey =>
        !!a && typeof (a as ErasureAttemptKey).key === 'string' && typeof (a as ErasureAttemptKey).deleteAfter === 'string');
    }
  } catch { /* corrupt attempt keys read as empty */ }
  return {
    erasureId: row.erasure_id,
    failedKeys,
    pendingPrefixes,
    attemptKeys,
    rawKeysJson: row.failed_keys_json,
    rawPrefixesJson: row.pending_prefixes_json,
    rawAttemptKeysJson: row.attempt_keys_json ?? '[]',
  };
}

function unionKeys(first: string[], second: string[]): string[] {
  const seen = new Set(first);
  const out = [...first];
  for (const key of second) {
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/**
 * Reconcile a cleanup pass against the record with optimistic concurrency.
 * The write applies only when the stored JSON still matches what the pass
 * started from; keys/prefixes/attempts added concurrently (late render
 * orphans) are merged back in on conflict and the compare retries.
 * Successfully completed work is never resurrected: only additions since
 * `prev` carry over, so a concurrent retire of swept keys stays retired. A
 * pass whose leftovers are empty retires the row with the same guard instead
 * of blindly deleting a concurrently appended record.
 *
 * Returns the remaining pending state the caller must report. When bounded
 * retries exhaust under sustained contention, no blind write happens:
 * `reconciled` is false and the caller reports the work as deferred/pending
 * so the durable inventory stays intact for the next tick. Attempt keys
 * merge by key keeping the later deadline.
 */
export async function reconcileErasureCleanup(
  db: D1Database,
  params: {
    workspaceId: string;
    erasureId: string;
    /** Record state the pass started from; null when the pass wrote nothing yet. */
    prev: ErasureCleanupState | null;
    failedKeys: string[];
    pendingPrefixes: string[];
    attemptKeys?: ErasureAttemptKey[];
  },
  maxAttempts = 8,
): Promise<{ reconciled: boolean; failedKeys: string[]; pendingPrefixes: string[]; attemptKeys: ErasureAttemptKey[] }> {
  const now = () => new Date().toISOString();
  const wantedAttempts = params.attemptKeys ?? params.prev?.attemptKeys ?? [];
  let lastMerged = { failedKeys: params.failedKeys, pendingPrefixes: params.pendingPrefixes, attemptKeys: wantedAttempts };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const current = await readErasureCleanup(db, params.workspaceId);
    // Work recorded after `prev` (a render orphan appended mid-pass) must
    // survive this reconcile even though the pass never saw it.
    const concurrentKeys = current
      ? current.failedKeys.filter((key) => !(params.prev?.failedKeys.includes(key) ?? false))
      : [];
    const concurrentPrefixes = current
      ? current.pendingPrefixes.filter((prefix) => !(params.prev?.pendingPrefixes.includes(prefix) ?? false))
      : [];
    const prevAttemptKeys = new Map((params.prev?.attemptKeys ?? []).map((a) => [a.key, a.deleteAfter]));
    // New keys carry over, and so do later deadlines for keys the snapshot
    // already had: a stale pass must neither shorten an extended deadline
    // nor drop the key as complete. Unchanged deadlines stay excludable so
    // finished work still retires.
    const concurrentAttempts = (current?.attemptKeys ?? []).filter((a) => prevAttemptKeys.get(a.key) !== a.deleteAfter);
    const mergedKeys = unionKeys(params.failedKeys, concurrentKeys);
    const mergedPrefixes = unionKeys(params.pendingPrefixes, concurrentPrefixes);
    const mergedAttempts = mergeAttemptKeys(wantedAttempts, concurrentAttempts);
    lastMerged = { failedKeys: mergedKeys, pendingPrefixes: mergedPrefixes, attemptKeys: mergedAttempts };
    const empty = mergedKeys.length === 0 && mergedPrefixes.length === 0 && mergedAttempts.length === 0;
    if (!current) {
      if (empty) return { reconciled: true, ...lastMerged };
      const inserted = await db.prepare(
        `INSERT INTO workspace_erasure_cleanups (workspace_id, erasure_id, failed_keys_json, pending_prefixes_json, attempt_keys_json, attempts, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(workspace_id) DO NOTHING`,
      ).bind(params.workspaceId, params.erasureId, JSON.stringify(mergedKeys), JSON.stringify(mergedPrefixes), JSON.stringify(mergedAttempts), now()).run();
      if ((((inserted as unknown as { meta?: { changes?: number } })?.meta?.changes) ?? 0) === 1) {
        return { reconciled: true, ...lastMerged };
      }
      continue;
    }
    if (empty) {
      const deleted = await db.prepare(
        `DELETE FROM workspace_erasure_cleanups WHERE workspace_id = ? AND failed_keys_json = ? AND pending_prefixes_json = ? AND COALESCE(attempt_keys_json, '[]') = ?`,
      ).bind(params.workspaceId, current.rawKeysJson, current.rawPrefixesJson, current.rawAttemptKeysJson).run();
      if ((((deleted as unknown as { meta?: { changes?: number } })?.meta?.changes) ?? 0) === 1) {
        return { reconciled: true, ...lastMerged };
      }
      continue;
    }
    const updated = await db.prepare(
      `UPDATE workspace_erasure_cleanups
       SET erasure_id = ?, failed_keys_json = ?, pending_prefixes_json = ?, attempt_keys_json = ?, attempts = attempts + 1, updated_at = ?
       WHERE workspace_id = ? AND failed_keys_json = ? AND pending_prefixes_json = ? AND COALESCE(attempt_keys_json, '[]') = ?`,
    ).bind(
      params.erasureId,
      JSON.stringify(mergedKeys),
      JSON.stringify(mergedPrefixes),
      JSON.stringify(mergedAttempts),
      now(),
      params.workspaceId,
      current.rawKeysJson,
      current.rawPrefixesJson,
      current.rawAttemptKeysJson,
    ).run();
    if ((((updated as unknown as { meta?: { changes?: number } })?.meta?.changes) ?? 0) === 1) {
      return { reconciled: true, ...lastMerged };
    }
    // Stored state moved under this pass: reread and merge again. `prev`
    // stays the pass's original read so every concurrent addition carries.
  }
  // Retries exhausted under sustained contention: report deferred and leave
  // the durable inventory untouched for the next pass. No blind write. The
  // returned counts are an explicitly observed durable snapshot — never the
  // uncommitted proposal — so callers cannot present merged-but-unwritten
  // work as stored totals. A missing row means another pass retired the
  // inventory: report empty, still deferred.
  const observed = await readErasureCleanup(db, params.workspaceId);
  if (observed) {
    return {
      reconciled: false,
      failedKeys: observed.failedKeys,
      pendingPrefixes: observed.pendingPrefixes,
      attemptKeys: observed.attemptKeys,
    };
  }
  return { reconciled: false, failedKeys: [], pendingPrefixes: [], attemptKeys: [] };
}

/** Merge attempt-key lists by key, keeping the later sweep deadline. */
function mergeAttemptKeys(first: ErasureAttemptKey[], second: ErasureAttemptKey[]): ErasureAttemptKey[] {
  const merged = new Map<string, string>();
  for (const entry of [...first, ...second]) {
    const prior = merged.get(entry.key);
    if (prior === undefined || entry.deleteAfter > prior) merged.set(entry.key, entry.deleteAfter);
  }
  return [...merged].map(([key, deleteAfter]) => ({ key, deleteAfter }));
}

/**
 * Persist pass leftovers for the cron retry, or retire the record when
 * nothing remains. `prev` must be the record state the pass started from
 * (see reconcileErasureCleanup): concurrent appends merge back in instead
 * of being overwritten or deleted with the row. Returns the remaining
 * pending state and whether it reconciled; unreconciled work stays recorded
 * for the next pass.
 */
export async function storeErasureCleanup(
  db: D1Database,
  params: { workspaceId: string; erasureId: string; prev: ErasureCleanupState | null; failedKeys: string[]; pendingPrefixes: string[]; attemptKeys?: ErasureAttemptKey[] },
): Promise<{ reconciled: boolean; failedKeys: string[]; pendingPrefixes: string[]; attemptKeys: ErasureAttemptKey[] }> {
  return reconcileErasureCleanup(db, params);
}

/**
 * Retain one late render-orphan key in an erased workspace's cleanup record.
 * Used when an in-flight render uploads after erasure and its byte deletion
 * also fails: the workspace cascade removed every inventory row (including
 * the attempt's pre-registered row), so without this the bytes would be
 * undiscoverable. The append is compare-and-swap guarded like every other
 * reconcile: a concurrent cron retire between the read and the write retries
 * against the fresh state instead of updating zero rows and reporting
 * success, and the insert conflict branch merges rather than overwrites.
 * Returns false only when no cleanup row and no erasure tombstone exist.
 */
export async function retainRenderOrphanKey(
  db: D1Database,
  workspaceId: string,
  key: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await readErasureCleanup(db, workspaceId);
    if (current) {
      if (current.failedKeys.includes(key)) return true;
      const updated = await db.prepare(
        `UPDATE workspace_erasure_cleanups
         SET failed_keys_json = ?, attempts = attempts + 1, updated_at = ?
         WHERE workspace_id = ? AND failed_keys_json = ? AND pending_prefixes_json = ?`,
      ).bind(
        JSON.stringify([...current.failedKeys, key]),
        now,
        workspaceId,
        current.rawKeysJson,
        current.rawPrefixesJson,
      ).run();
      if ((((updated as unknown as { meta?: { changes?: number } })?.meta?.changes) ?? 0) === 1) return true;
      // The row moved (cron reconciled concurrently): reread and retry.
      continue;
    }
    const tomb = await db.prepare(
      `SELECT id FROM workspace_erasures WHERE workspace_id = ? ORDER BY erased_at DESC LIMIT 1`,
    ).bind(workspaceId).first<{ id: string }>();
    if (!tomb) return false;
    const inserted = await db.prepare(
      `INSERT INTO workspace_erasure_cleanups (workspace_id, erasure_id, failed_keys_json, pending_prefixes_json, attempts, updated_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(workspace_id) DO NOTHING`,
    ).bind(workspaceId, tomb.id, JSON.stringify([key]), JSON.stringify(erasurePrefixes(workspaceId)), now).run();
    if ((((inserted as unknown as { meta?: { changes?: number } })?.meta?.changes) ?? 0) === 1) return true;
    // Another appender won the race: reread and merge instead of
    // overwriting its keys.
  }
  return false;
}

/**
 * Cron retry: re-delete recorded keys and re-sweep recorded prefixes,
 * bounded per tick. Clears each workspace row when its bytes are gone.
 */
export async function processErasureR2Cleanups(
  db: D1Database,
  storage: R2Bucket,
  opts: { rowLimit?: number } & ErasureR2Budgets = {},
): Promise<{ workspaces: number; deleted: number; remaining: number }> {
  const summary = { workspaces: 0, deleted: 0, remaining: 0 };
  const rows = (
    await db.prepare(
      `SELECT workspace_id FROM workspace_erasure_cleanups ORDER BY updated_at ASC LIMIT ?`,
    )
      .bind(opts.rowLimit ?? 5)
      .all<{ workspace_id: string }>()
  ).results;
  for (const row of rows) {
    summary.workspaces++;
    // The pre-sweep read anchors the reconcile below: keys a renderer
    // appends while this pass runs merge back in instead of being
    // overwritten by this pass's older leftovers.
    const prev = await readErasureCleanup(db, row.workspace_id);
    if (!prev) continue;
    let erasureId = prev.erasureId;
    try {
      const tomb = await db.prepare(
        `SELECT id FROM workspace_erasures WHERE workspace_id = ? ORDER BY erased_at DESC LIMIT 1`,
      ).bind(row.workspace_id).first<{ id: string }>();
      if (tomb) erasureId = tomb.id;
    } catch { /* keep the recorded erasure identity */ }
    const outcome = await runErasureR2Cleanup(
      storage,
      row.workspace_id,
      { keys: prev.failedKeys },
      { keyBudget: opts.keyBudget ?? 600, sweepBudget: opts.sweepBudget ?? 2000 },
    );
    // Registered in-flight attempt keys sweep only past their deadline:
    // deleting earlier could remove bytes an attempt is still uploading,
    // while dropping them early would strand a post-sweep upload. Skipped
    // keys stay recorded for the next tick.
    const nowIso = new Date().toISOString();
    const dueAttempts = prev.attemptKeys.filter((a) => a.deleteAfter <= nowIso);
    const futureAttempts = prev.attemptKeys.filter((a) => a.deleteAfter > nowIso);
    const attemptFailures: string[] = [];
    for (const attempt of dueAttempts.slice(0, opts.keyBudget ?? 600)) {
      try {
        await storage.delete(attempt.key);
        outcome.deleted++;
      } catch {
        attemptFailures.push(attempt.key);
      }
    }
    const deferredAttempts = dueAttempts.slice(opts.keyBudget ?? 600);
    const remainingAttempts = [
      ...attemptFailures.map((key) => ({ key, deleteAfter: nowIso })),
      ...deferredAttempts,
      ...futureAttempts,
    ];
    // The pass sweeps every workspace-owned prefix, so whatever it reports
    // pending is exactly what remains; recorded prefixes it finished drop
    // out. Failed keys (including globally-keyed renditions outside any
    // workspace prefix) carry over explicitly for the next tick.
    const remainingPrefixes = outcome.pendingPrefixes;
    const reconciled = await reconcileErasureCleanup(db, {
      workspaceId: row.workspace_id,
      erasureId,
      prev,
      failedKeys: outcome.failedKeys,
      pendingPrefixes: remainingPrefixes,
      attemptKeys: remainingAttempts,
    });
    summary.deleted += outcome.deleted;
    // Pending reflects the reconciled durable state, not just this pass's
    // outcome: merged concurrent appends keep the row alive.
    if (!reconciled.reconciled || reconciled.failedKeys.length > 0 ||
      reconciled.pendingPrefixes.length > 0 || reconciled.attemptKeys.length > 0) {
      summary.remaining++;
    }
  }
  return summary;
}
