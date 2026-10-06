/**
 * @otis/worker/brief/cron
 *
 * Discovers members with enabled brief schedules and evaluates/generates
 * daily briefs during the cron sweep.
 */

import { generateDailyBrief } from './service.js';
import { productionBriefKernel } from './kernel.js';

export interface ProcessScheduledBriefsResult {
  evaluated: number;
  generated: number;
  skipped: number;
  errors: number;
}

export async function processScheduledDailyBriefs(
  db: D1Database,
  nowIso: string = new Date().toISOString(),
): Promise<ProcessScheduledBriefsResult> {
  const result: ProcessScheduledBriefsResult = {
    evaluated: 0,
    generated: 0,
    skipped: 0,
    errors: 0,
  };

  // Due-only selection: enabled members whose next-due instant has passed,
  // earliest first. NULL covers legacy rows and schedules edited since the
  // last sweep (SQLite sorts NULLs first on ASC), so every member is still
  // evaluated once before being stamped. Members stamped into the future
  // cost zero reads here; an over-50 due backlog rotates in as earlier
  // members advance past the sweep instant.
  const rows = (
    await db
      .prepare(
        `SELECT ms.workspace_id, ms.user_id
         FROM member_settings ms
         JOIN workspace_users wu ON wu.workspace_id = ms.workspace_id AND wu.user_id = ms.user_id
         WHERE ms.brief_enabled = 1 AND (ms.brief_next_due_utc IS NULL OR ms.brief_next_due_utc <= ?)
         ORDER BY ms.brief_next_due_utc ASC
         LIMIT 50`,
      )
      .bind(nowIso)
      .all<{ workspace_id: string; user_id: string }>()
  ).results || [];

  for (const row of rows) {
    result.evaluated++;
    try {
      const outcome = await generateDailyBrief(db, productionBriefKernel, {
        workspaceId: row.workspace_id,
        userId: row.user_id,
        nowIso,
        staleAfterDays: 14,
      });

      if (outcome.status === 'ready' || outcome.status === 'empty') {
        result.generated++;
      } else {
        result.skipped++;
      }
    } catch (err) {
      result.errors++;
      console.error(`Scheduled brief evaluation failed for user '${row.user_id}' in '${row.workspace_id}':`, err);
    }
  }

  return result;
}
