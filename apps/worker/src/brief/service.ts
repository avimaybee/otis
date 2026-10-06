/**
 * @otis/worker/brief/service
 *
 * 011B scheduled daily brief + on-demand today service (plan 011 slice
 * 011B). Callable from cron and from the `/today` command route
 * (coordinator owns route/cron linking; this module has no transport).
 *
 * - Disabled/incomplete/invalid schedules do nothing; schedules stay
 *   opted-out and no 09:00 fallback exists anywhere in this path.
 * - One canonical brief per (workspace, user, local date, `scheduled_daily`)
 *   enforced by a UNIQUE constraint: concurrent ticks race, exactly one
 *   commits, losers read back `already`. Deterministic row IDs make retries
 *   idempotent. The current-member check runs inside the committing batch
 *   (guard row), so removal between read and commit aborts the write.
 * - Ready briefs persist the canonical system web message + public activity
 *   through the existing chat_messages/run_activity mechanism (same pattern
 *   as routes/actions.ts). Empty days persist an `empty` handled marker and
 *   send nothing.
 * - Telegram delivery goes through the single existing sender: intent rows
 *   use the shared delivery builder (topic `send_message`, kind `brief`,
 *   multipart splitting) and the existing consumer sends them after
 *   revalidating the canonical brief row, membership, live binding and
 *   chosen channel (`resolveBriefDeliveryTarget`). Unknown-send outcomes
 *   keep existing outbox semantics and external exactly-once is never
 *   claimed.
 * - No promise markers or last-contact values are invented: see read.ts for
 *   the exact omitted categories and schema gaps.
 */

import type {
  BriefKernel,
  LocalBriefSchedule,
  LocalSavedBriefItem,
  LocalScheduleDecision,
} from './types.js';
import {
  findBrief,
  readBriefCandidates,
  readLastGeneratedLocalDate,
  readMemberBriefSchedule,
  readMembership,
  readTargetChat,
  readTelegramLink,
} from './read.js';
import { buildTelegramDeliveryStatements } from '../inbox/telegramDelivery.js';

export const BRIEF_KIND_SCHEDULED_DAILY = 'scheduled_daily';
/** Same default as the inbound Telegram route; the consumer revalidates. */
export const BRIEF_TELEGRAM_INSTALLATION_DEFAULT = 'otis_bot';

export interface GenerateBriefParams {
  workspaceId: string;
  userId: string;
  /** Injected clock (UTC ISO); also stamps created/updated rows. */
  nowIso: string;
  /** Required policy input: days since last contact counting as stale. */
  staleAfterDays: number;
  /** Resolved bot installation identity for Telegram intent rows. */
  telegramInstallationId?: string;
}

export type BriefSkippedReason =
  | 'not_member'
  | 'schedule_disabled'
  | 'schedule_incomplete'
  | 'schedule_invalid'
  | 'not_due_weekday'
  | 'not_yet_due';

export type GenerateBriefResult =
  | {
      status: 'ready';
      briefId: string;
      localDate: string;
      itemCount: number;
      chatId: string | null;
      messageId: string | null;
      /** 'web' = canonical message only; 'telegram_intent' adds outbox rows. */
      delivery: 'web' | 'telegram_intent';
      /** Number of Telegram outbox parts queued (multipart splitting). */
      telegramParts?: number;
    }
  | { status: 'empty'; briefId: string; localDate: string }
  | { status: 'already'; briefId: string; localDate: string }
  | { status: 'skipped'; reason: BriefSkippedReason };

export interface TodayBriefResult {
  status: 'ok';
  localDate: string;
  timezone: string;
  items: LocalSavedBriefItem[];
  text: string;
}

function mapDecision(decision: LocalScheduleDecision): BriefSkippedReason {
  switch (decision) {
    case 'weekday_not_selected':
      return 'not_due_weekday';
    case 'not_yet_due':
      return 'not_yet_due';
    case 'invalid':
      return 'schedule_invalid';
    case 'incomplete':
      return 'schedule_incomplete';
    case 'disabled':
      return 'schedule_disabled';
    case 'due':
    case 'already_generated':
      return 'schedule_disabled';
  }
}

function membershipGuard(
  db: D1Database,
  workspaceId: string,
  userId: string,
  chatId: string | null,
): D1PreparedStatement {
  const guardId = `guard_brf_${crypto.randomUUID()}`;
  if (chatId) {
    return db.prepare(
      `INSERT INTO acceptance_guards (id, guard_ok)
       VALUES (?, CASE WHEN EXISTS (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?)
         AND EXISTS (SELECT 1 FROM chats WHERE id = ? AND workspace_id = ? AND author_user_id = ?)
         THEN 1 ELSE NULL END)`,
    ).bind(guardId, workspaceId, userId, chatId, workspaceId, userId);
  }
  return db.prepare(
    `INSERT INTO acceptance_guards (id, guard_ok)
     VALUES (?, CASE WHEN EXISTS (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?)
       THEN 1 ELSE NULL END)`,
  ).bind(guardId, workspaceId, userId);
}

async function alreadyIfPresent(
  db: D1Database,
  workspaceId: string,
  userId: string,
  localDate: string,
): Promise<GenerateBriefResult | null> {
  const existing = await findBrief(db, workspaceId, userId, localDate);
  return existing ? { status: 'already', briefId: existing.id, localDate } : null;
}

/**
 * Sweep pacing (B4): after every committed outcome, persist when this member
 * becomes due again so the cron selects due members only. Runnable outcomes
 * stamp the next slot past the committed date; broken enabled schedules
 * (incomplete/invalid) recheck daily instead of every sweep; anything else
 * clears the stamp. Disabled members are never selected by the enabled-only
 * sweep, and members without a settings row stamp zero rows.
 */
const BROKEN_SCHEDULE_RECHECK_MS = 24 * 60 * 60 * 1000;

async function advanceSweepStamp(
  db: D1Database,
  kernel: BriefKernel,
  params: {
    workspaceId: string;
    userId: string;
    stored: LocalBriefSchedule | null;
    fromUtcIso: string;
    /** Local date committed by this outcome, or the pre-existing last-generated date. */
    committedLocalDate: string | null;
    lastGenerated: string | null;
  },
): Promise<void> {
  let stamp: string | null = null;
  if (params.stored?.enabled) {
    stamp =
      kernel.nextDueUtc({
        schedule: params.stored,
        fromUtcIso: params.fromUtcIso,
        lastGeneratedLocalDate: params.committedLocalDate ?? params.lastGenerated,
      }) ?? new Date(Date.parse(params.fromUtcIso) + BROKEN_SCHEDULE_RECHECK_MS).toISOString();
  }
  await db
    .prepare(`UPDATE member_settings SET brief_next_due_utc = ?, updated_at = ? WHERE workspace_id = ? AND user_id = ?`)
    .bind(stamp, params.fromUtcIso, params.workspaceId, params.userId)
    .run();
}

export async function generateDailyBrief(
  db: D1Database,
  kernel: BriefKernel,
  params: GenerateBriefParams,
): Promise<GenerateBriefResult> {
  const { workspaceId, userId, nowIso } = params;
  if (Number.isNaN(Date.parse(nowIso))) throw new Error(`Invalid now instant: ${nowIso}.`);

  if (!(await readMembership(db, workspaceId, userId))) {
    return { status: 'skipped', reason: 'not_member' };
  }
  const stored = await readMemberBriefSchedule(db, workspaceId, userId);
  if (!stored || !stored.enabled) {
    await advanceSweepStamp(db, kernel, { workspaceId, userId, stored, fromUtcIso: nowIso, committedLocalDate: null, lastGenerated: null });
    return { status: 'skipped', reason: 'schedule_disabled' };
  }

  const lastGenerated = await readLastGeneratedLocalDate(
    db,
    workspaceId,
    userId,
    BRIEF_KIND_SCHEDULED_DAILY,
  );
  const evaluation = kernel.evaluateSchedule(
    {
      enabled: true,
      localTime: stored.localTime,
      timezone: stored.timezone,
      weekdays: stored.weekdays,
      channel: stored.channel,
    },
    nowIso,
    lastGenerated,
  );
  if (!evaluation.runnable || !evaluation.localDate) {
    if (evaluation.decision === 'already_generated' && evaluation.localDate) {
      const present = await alreadyIfPresent(db, workspaceId, userId, evaluation.localDate);
      if (present) {
        await advanceSweepStamp(db, kernel, {
          workspaceId,
          userId,
          stored,
          fromUtcIso: nowIso,
          committedLocalDate: evaluation.localDate,
          lastGenerated,
        });
        return present;
      }
    }
    await advanceSweepStamp(db, kernel, {
      workspaceId,
      userId,
      stored,
      fromUtcIso: nowIso,
      committedLocalDate:
        evaluation.decision === 'already_generated' ? evaluation.localDate : lastGenerated,
      lastGenerated,
    });
    return { status: 'skipped', reason: mapDecision(evaluation.decision) };
  }
  const localDate = evaluation.localDate;

  const briefId = `brf_${workspaceId}_${userId}_${localDate}`;
  const jobId = `brfjob_${workspaceId}_${userId}_${localDate}`;
  const runId = `brfrun_${workspaceId}_${userId}_${localDate}`;
  const messageId = `msg_${briefId}`;
  const activityId = `act_${briefId}`;

  const candidates = await readBriefCandidates(db, workspaceId, userId);
  const timezone = stored.timezone ?? 'UTC';
  const selected = kernel.selectItems({
    nowUtcIso: nowIso,
    briefLocalDate: localDate,
    briefTimezone: timezone,
    tasks: candidates.tasks,
    leads: candidates.leads,
    staleAfterDays: params.staleAfterDays,
  });
  const saved = kernel.orderForSave(selected);
  const text = kernel.renderText(saved);

  const jobStmt = db.prepare(
    `INSERT INTO system_jobs (id, workspace_id, job_kind, status, scheduled_at, attempt_count, max_attempts, created_at, updated_at)
     VALUES (?, ?, 'scheduled_daily_brief', 'succeeded', ?, 1, 3, ?, ?)`,
  ).bind(jobId, workspaceId, nowIso, nowIso, nowIso);
  const runStmt = db.prepare(
    `INSERT INTO agent_runs (id, workspace_id, chat_id, source_job_id, executor_kind, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'system', 'succeeded', ?, ?)`,
  );

  try {
    if (saved.length === 0) {
      // Empty day: handled marker only. No message, no activity, no outbox.
      await db.batch([
        membershipGuard(db, workspaceId, userId, null),
        jobStmt,
        runStmt.bind(runId, workspaceId, null, jobId, nowIso, nowIso),
        db.prepare(
          `INSERT INTO briefs (id, workspace_id, user_id, local_date, kind, status, chat_id, message_id, run_id, body_text, item_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'scheduled_daily', 'empty', NULL, NULL, ?, '', 0, ?, ?)`,
        ).bind(briefId, workspaceId, userId, localDate, runId, nowIso, nowIso),
      ]);
      await advanceSweepStamp(db, kernel, {
        workspaceId,
        userId,
        stored,
        fromUtcIso: nowIso,
        committedLocalDate: localDate,
        lastGenerated,
      });
      return { status: 'empty', briefId, localDate };
    }

    const chat = await readTargetChat(db, workspaceId, userId);
    // First-ever brief: provision the member's own canonical chat in the
    // same atomic batch (existing chat schema + membership guard), so an
    // opted-in member without any chat still receives the daily brief.
    // The deterministic id keeps concurrent first runs to one chat.
    let chatId = chat?.id ?? null;
    const preamble: D1PreparedStatement[] = [];
    if (!chatId) {
      chatId = `chat_brf_${workspaceId}_${userId}`;
      preamble.push(
        db.prepare(
          `INSERT INTO chats (id, workspace_id, author_user_id, title, model_override, is_archived, activity_cursor, created_at, updated_at, last_activity_at)
           VALUES (?, ?, ?, 'Brief', NULL, 0, 0, ?, ?, ?)`,
        ).bind(chatId, workspaceId, userId, nowIso, nowIso, nowIso),
      );
    }

    const statements: D1PreparedStatement[] = [
      ...preamble,
      membershipGuard(db, workspaceId, userId, chatId),
      jobStmt,
      runStmt.bind(runId, workspaceId, chatId, jobId, nowIso, nowIso),
      // Message before briefs: the brief row references it by FK.
      db.prepare(
        `INSERT INTO chat_messages (id, workspace_id, chat_id, author_kind, channel, content_text, run_id, sequence, created_at, updated_at)
         SELECT ?, ?, ?, 'system', 'system', ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ? FROM chat_messages WHERE chat_id = ?`,
      ).bind(messageId, workspaceId, chatId, text, runId, nowIso, nowIso, chatId),
      db.prepare(
        `UPDATE chats SET activity_cursor = activity_cursor + 1, last_activity_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(nowIso, nowIso, chatId),
      db.prepare(
        `INSERT INTO run_activity (id, workspace_id, chat_id, run_id, cursor, type, payload_json, created_at)
         SELECT ?, ?, ?, ?, activity_cursor, 'answer_saved', ?, ? FROM chats WHERE id = ?`,
      ).bind(
        activityId,
        workspaceId,
        chatId,
        runId,
        JSON.stringify({ reply: text, brief_id: briefId, scheduled: true }),
        nowIso,
        chatId,
      ),
      db.prepare(
        `INSERT INTO briefs (id, workspace_id, user_id, local_date, kind, status, chat_id, message_id, run_id, body_text, item_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'scheduled_daily', 'ready', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        briefId,
        workspaceId,
        userId,
        localDate,
        chatId,
        messageId,
        runId,
        text,
        saved.length,
        nowIso,
        nowIso,
      ),
      ...saved.map((item) =>
        db.prepare(
          `INSERT INTO brief_items (brief_id, position, kind, task_id, entity_id, title, reason, source_event_id, due_label)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          briefId,
          item.position,
          item.kind,
          item.taskId,
          item.entityId,
          item.title,
          item.reason,
          item.sourceEventId,
          item.dueLabel,
        ),
      ),
    ];

    // Telegram delivery reuses the single existing sender: the shared
    // builder splits the text and keys the rows; the consumer revalidates
    // kind 'brief' rows against the canonical brief before any send.
    let telegramParts = 0;
    if (stored.channel === 'telegram') {
      const link = await readTelegramLink(db, userId, workspaceId);
      if (link && chatId) {
        const deliveryStatements = buildTelegramDeliveryStatements(db, {
          workspaceId,
          userId,
          chatId,
          // Synthetic source: briefs have no inbound telegram update.
          sourceMessageId: `brief:${briefId}`,
          runId,
          kind: 'brief',
          key: briefId,
          text,
          briefId,
          target: {
            botInstallationId:
              params.telegramInstallationId ?? BRIEF_TELEGRAM_INSTALLATION_DEFAULT,
            telegramUserId: link.telegramUserId,
            // Private-chat invariant: the chat id is the user id. The
            // delivery consumer revalidates before any send.
            telegramChatId: link.telegramUserId,
          },
        });
        telegramParts = deliveryStatements.length;
        statements.push(...deliveryStatements);
      }
    }

    await db.batch(statements);
    await advanceSweepStamp(db, kernel, {
      workspaceId,
      userId,
      stored,
      fromUtcIso: nowIso,
      committedLocalDate: localDate,
      lastGenerated,
    });
    return {
      status: 'ready',
      briefId,
      localDate,
      itemCount: saved.length,
      chatId,
      messageId,
      delivery: telegramParts > 0 ? 'telegram_intent' : 'web',
      ...(telegramParts > 0 ? { telegramParts } : {}),
    };
  } catch (err) {
    // Concurrent tick or retried request: the canonical row decides.
    const present = await alreadyIfPresent(db, workspaceId, userId, localDate);
    if (present) {
      await advanceSweepStamp(db, kernel, {
        workspaceId,
        userId,
        stored,
        fromUtcIso: nowIso,
        committedLocalDate: localDate,
        lastGenerated,
      });
      return present;
    }
    throw err;
  }
}

export interface TodayBriefParams {
  workspaceId: string;
  userId: string;
  nowIso: string;
  staleAfterDays: number;
}

/**
 * On-demand `/today`: current due work without a schedule and without
 * persisting another scheduled delivery. Read-only; coordinator renders.
 */
export async function buildTodayBrief(
  db: D1Database,
  kernel: BriefKernel,
  params: TodayBriefParams,
): Promise<TodayBriefResult | { status: 'skipped'; reason: 'not_member' }> {
  const { workspaceId, userId, nowIso } = params;
  if (Number.isNaN(Date.parse(nowIso))) throw new Error(`Invalid now instant: ${nowIso}.`);
  if (!(await readMembership(db, workspaceId, userId))) {
    return { status: 'skipped', reason: 'not_member' };
  }
  const stored = await readMemberBriefSchedule(db, workspaceId, userId);
  const timezone =
    stored?.timezone && kernel.isValidTimezone(stored.timezone) ? stored.timezone : 'UTC';
  const localDate = kernel.localDate(nowIso, timezone);
  const candidates = await readBriefCandidates(db, workspaceId, userId);
  const selected = kernel.selectItems({
    nowUtcIso: nowIso,
    briefLocalDate: localDate,
    briefTimezone: timezone,
    tasks: candidates.tasks,
    leads: candidates.leads,
    staleAfterDays: params.staleAfterDays,
  });
  const items = kernel.orderForSave(selected);
  return { status: 'ok', localDate, timezone, items, text: kernel.renderText(items) };
}
