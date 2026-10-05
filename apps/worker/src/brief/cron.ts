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

  // Find members who have enabled daily briefs and are active workspace members
  const rows = (
    await db
      .prepare(
        `SELECT ms.workspace_id, ms.user_id
         FROM member_settings ms
         JOIN workspace_users wu ON wu.workspace_id = ms.workspace_id AND wu.user_id = ms.user_id
         WHERE ms.brief_enabled = 1
         LIMIT 50`,
      )
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
