/**
 * Shared workspace settings and per-member preferences.
 * Schedules start disabled: enabling a brief requires an explicitly chosen
 * local time, IANA timezone, weekdays, and channel. There is no 09:00
 * fallback and no silent default. Every change writes an attributed audit row.
 */

import type { MemberSettings, WorkspaceSettings } from '@otis/contracts';

export type SettingsErrorCode =
  | 'brief_incomplete'
  | 'invalid_timezone'
  | 'invalid_time'
  | 'invalid_weekdays'
  | 'invalid_channel'
  | 'invalid_language'
  | 'invalid_model'
  | 'not_member'
  | 'conflict'
  | 'fence_conflict';

export class SettingsError extends Error {
  public readonly code: SettingsErrorCode;

  constructor(code: SettingsErrorCode, message: string) {
    super(message);
    this.name = 'SettingsError';
    this.code = code;
  }
}

export interface FencedSettingsContext {
  runId: string;
  stepId?: string;
  fence: number;
  actionId: string;
  sourceMessageId?: string;
  maxDailyActions?: number;
}

export interface MemberSettingsInput {
  brief_enabled?: boolean;
  brief_local_time?: string | null;
  brief_timezone?: string | null;
  brief_weekdays?: number[] | null;
  brief_channel?: 'web' | 'telegram';
  preferred_language?: string;
}

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function validateMemberInput(input: MemberSettingsInput): void {
  if (input.brief_channel !== undefined && input.brief_channel !== 'web' && input.brief_channel !== 'telegram') {
    throw new SettingsError('invalid_channel', 'Brief channel must be web or telegram.');
  }
  if (
    input.preferred_language !== undefined &&
    (input.preferred_language.length < 1 || input.preferred_language.length > 32)
  ) {
    throw new SettingsError('invalid_language', 'Preferred language must be 1-32 characters.');
  }
  if (input.brief_local_time !== undefined && input.brief_local_time !== null) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.brief_local_time)) {
      throw new SettingsError('invalid_time', 'Brief time must be HH:MM in 24-hour format.');
    }
  }
  if (input.brief_timezone !== undefined && input.brief_timezone !== null) {
    if (!isValidTimezone(input.brief_timezone)) {
      throw new SettingsError('invalid_timezone', 'Brief timezone must be a valid IANA timezone.');
    }
  }
  if (input.brief_weekdays !== undefined && input.brief_weekdays !== null) {
    const days = input.brief_weekdays;
    if (
      !Array.isArray(days) ||
      days.length === 0 ||
      days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
    ) {
      throw new SettingsError('invalid_weekdays', 'Brief weekdays must be a non-empty list of 0-6.');
    }
  }
}

function defaultMemberSettings(workspaceId: string, userId: string, nowIso: string): MemberSettings {
  return {
    workspace_id: workspaceId,
    user_id: userId,
    brief_enabled: false,
    brief_local_time: null,
    brief_timezone: null,
    interpretation_timezone: null,
    brief_weekdays: null,
    brief_channel: 'web',
    preferred_language: 'en',
    created_at: nowIso,
    updated_at: nowIso,
  };
}

function rowToMemberSettings(
  workspaceId: string,
  userId: string,
  row: Record<string, unknown> | null,
  nowIso: string,
): MemberSettings {
  if (!row) return defaultMemberSettings(workspaceId, userId, nowIso);
  let weekdays: number[] | null = null;
  if (row['brief_weekdays']) {
    try {
      const parsed: unknown = JSON.parse(String(row['brief_weekdays']));
      weekdays = Array.isArray(parsed) ? (parsed as number[]) : null;
    } catch {
      weekdays = null;
    }
  }
  return {
    workspace_id: workspaceId,
    user_id: userId,
    brief_enabled: Number(row['brief_enabled']) === 1,
    brief_local_time: row['brief_local_time'] ? String(row['brief_local_time']) : null,
    brief_timezone: row['brief_timezone'] ? String(row['brief_timezone']) : null,
    interpretation_timezone: row['interpretation_timezone'] ? String(row['interpretation_timezone']) : null,
    brief_weekdays: weekdays,
    brief_channel: row['brief_channel'] === 'telegram' ? 'telegram' : 'web',
    preferred_language: String(row['preferred_language'] ?? 'en'),
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
  };
}

export async function getMemberSettings(
  db: D1Database,
  params: { workspaceId: string; userId: string },
): Promise<MemberSettings> {
  // Pre-migration databases lack interpretation_timezone: degrade to null
  // instead of failing settings reads on a not-yet-migrated D1.
  try {
    const row = await db
      .prepare(
        `SELECT brief_enabled, brief_local_time, brief_timezone, interpretation_timezone, brief_weekdays,
                brief_channel, preferred_language, created_at, updated_at
         FROM member_settings WHERE workspace_id = ? AND user_id = ?`
      )
      .bind(params.workspaceId, params.userId)
      .first<Record<string, unknown>>();
    return rowToMemberSettings(params.workspaceId, params.userId, row, new Date().toISOString());
  } catch (err) {
    if (!String(err).includes('no such column')) throw err;
    const row = await db
      .prepare(
        `SELECT brief_enabled, brief_local_time, brief_timezone, brief_weekdays,
                brief_channel, preferred_language, created_at, updated_at
         FROM member_settings WHERE workspace_id = ? AND user_id = ?`
      )
      .bind(params.workspaceId, params.userId)
      .first<Record<string, unknown>>();
    return rowToMemberSettings(params.workspaceId, params.userId, row, new Date().toISOString());
  }
}

/**
 * Bounded zone read for date interpretation: device-reported zone first,
 * brief schedule second, null when unknown. Never throws for a missing
 * interpretation_timezone column — pre-migration databases simply resolve
 * unknown until 0022 lands.
 */
export async function getMemberZones(
  db: D1Database,
  params: { workspaceId: string; userId: string },
): Promise<{ brief_timezone: string | null; interpretation_timezone: string | null }> {
  const empty = { brief_timezone: null as string | null, interpretation_timezone: null as string | null };
  try {
    const row = await db
      .prepare(`SELECT brief_timezone, interpretation_timezone FROM member_settings WHERE workspace_id = ? AND user_id = ?`)
      .bind(params.workspaceId, params.userId)
      .first<Record<string, unknown>>();
    if (!row) return empty;
    return {
      brief_timezone: row['brief_timezone'] ? String(row['brief_timezone']) : null,
      interpretation_timezone: row['interpretation_timezone'] ? String(row['interpretation_timezone']) : null,
    };
  } catch (err) {
    if (!String(err).includes('no such column')) throw err;
    const row = await db
      .prepare(`SELECT brief_timezone FROM member_settings WHERE workspace_id = ? AND user_id = ?`)
      .bind(params.workspaceId, params.userId)
      .first<{ brief_timezone: string | null }>();
    return { brief_timezone: row?.brief_timezone ?? null, interpretation_timezone: null };
  }
}

async function computeSha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  const hashArray = Array.from(new Uint8Array(buffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Updates personal preferences. Enabling the brief requires a complete
 * schedule; a partial schedule stays disabled rather than inventing a time.
 * Members can only update their own preferences (enforced by routes).
 */
export async function setMemberSettings(
  db: D1Database,
  params: {
    workspaceId: string;
    userId: string;
    actorUserId: string;
    input: MemberSettingsInput;
    fencedContext?: FencedSettingsContext;
  },
): Promise<MemberSettings> {
  validateMemberInput(params.input);
  const nowIso = new Date().toISOString();

  // If executing inside a fenced run, check action receipt idempotency first
  let payloadHash: string | undefined;
  if (params.fencedContext) {
    payloadHash = await computeSha256(JSON.stringify({ command: 'update_preference', input: params.input }));
    const existing = await db
      .prepare(`SELECT payload_hash, result_json FROM action_receipts WHERE workspace_id = ? AND action_id = ?`)
      .bind(params.workspaceId, params.fencedContext.actionId)
      .first<Record<string, unknown>>();
    if (existing) {
      if (existing['payload_hash'] === payloadHash) {
        return JSON.parse(String(existing['result_json'])) as MemberSettings;
      }
      throw new SettingsError('conflict', 'Action ID already committed with different payload.');
    }
  }

  const current = await getMemberSettings(db, { workspaceId: params.workspaceId, userId: params.userId });

  const next: MemberSettings = {
    ...current,
    brief_enabled: params.input.brief_enabled ?? current.brief_enabled,
    brief_local_time: params.input.brief_local_time !== undefined ? params.input.brief_local_time : current.brief_local_time,
    brief_timezone: params.input.brief_timezone !== undefined ? params.input.brief_timezone : current.brief_timezone,
    brief_weekdays: params.input.brief_weekdays !== undefined ? params.input.brief_weekdays : current.brief_weekdays,
    brief_channel: params.input.brief_channel ?? current.brief_channel,
    preferred_language: params.input.preferred_language ?? current.preferred_language,
    updated_at: nowIso,
  };

  if (next.brief_enabled) {
    if (!next.brief_local_time || !next.brief_timezone || !next.brief_weekdays?.length) {
      throw new SettingsError(
        'brief_incomplete',
        'Enabling the brief requires an explicit time, timezone, and weekdays.',
      );
    }
    // Enabling is a deliberate choice of all four schedule fields. A carried
    // default channel is not a choice: the request that flips the switch must
    // name the channel explicitly.
    if (params.input.brief_enabled === true && params.input.brief_channel === undefined) {
      throw new SettingsError(
        'brief_incomplete',
        'Enabling the brief requires explicitly choosing a delivery channel.',
      );
    }
  }

  const changed: Record<string, unknown> = {};
  (Object.keys(next) as Array<keyof MemberSettings>).forEach((k) => {
    if (k === 'workspace_id' || k === 'user_id' || k === 'created_at' || k === 'updated_at') return;
    if (JSON.stringify(next[k]) !== JSON.stringify(current[k])) changed[k] = next[k];
  });

  await writeMemberSettings(db, {
    workspaceId: params.workspaceId,
    userId: params.userId,
    actorUserId: params.actorUserId,
    next,
    createdAt: current.created_at,
    changed,
    nowIso,
    fencedContext: params.fencedContext,
    payloadHash,
  });

  return { ...next, created_at: current.created_at };
}

/** True when the brief schedule itself changed (not just channel/language). */
function scheduleFieldsChanged(changed: Record<string, unknown>): boolean {
  return (
    'brief_enabled' in changed ||
    'brief_local_time' in changed ||
    'brief_timezone' in changed ||
    'brief_weekdays' in changed
  );
}

async function writeMemberSettings(
  db: D1Database,
  params: {
    workspaceId: string;
    userId: string;
    actorUserId: string;
    next: MemberSettings;
    createdAt: string;
    changed: Record<string, unknown>;
    nowIso: string;
    fencedContext?: FencedSettingsContext;
    payloadHash?: string;
  },
): Promise<void> {
  const statements: D1PreparedStatement[] = [];

  // Guard: the actor is still a member at commit time.
  statements.push(
    db
      .prepare(
        `INSERT INTO lifecycle_guards (id, guard_ok)
         VALUES (?, (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?))
         ON CONFLICT(id) DO UPDATE SET guard_ok = excluded.guard_ok`
      )
      .bind(`guard_life_member_${params.workspaceId}`, params.workspaceId, params.actorUserId),
  );

  // If executing inside a fenced run, guard run, lease, and fence
  if (params.fencedContext) {
    statements.push(
      db
        .prepare(
          `INSERT INTO lifecycle_guards (id, guard_ok)
           VALUES (?, (
             SELECT 1
             FROM workspaces w
             JOIN agent_runs ar ON ar.id = ? AND ar.workspace_id = w.id
             WHERE w.id = ?
               AND ar.status = 'running'
               AND w.lease_fence = ?
               AND w.lease_expires_at IS NOT NULL
               AND unixepoch(w.lease_expires_at) > unixepoch('now')
               AND w.lease_owner = ar.attempt_id
               AND w.lease_attempt_id = ar.attempt_id
               AND (? IS NULL OR COALESCE((
                 SELECT action_count
                 FROM workspace_daily_actions
                 WHERE workspace_id = w.id AND date_utc = ?
               ), 0) < ?)
           ))
           ON CONFLICT(id) DO UPDATE SET guard_ok = excluded.guard_ok`
        )
        .bind(
          `guard_life_fence_${params.workspaceId}`,
          params.fencedContext.runId,
          params.workspaceId,
          params.fencedContext.fence,
          params.fencedContext.maxDailyActions !== undefined ? params.fencedContext.maxDailyActions : null,
          params.nowIso.slice(0, 10),
          params.fencedContext.maxDailyActions !== undefined ? params.fencedContext.maxDailyActions : 0,
        ),
    );
  }

  statements.push(
    ...(scheduleFieldsChanged(params.changed)
      ? [
          // A schedule edit invalidates the sweep's cached next-due instant:
          // reset to NULL so the next sweep re-evaluates instead of trusting
          // a stamp computed from the old time, zone or weekdays. Unrelated
          // preference changes preserve the stamp.
          db
            .prepare(
              `INSERT INTO member_settings
                 (workspace_id, user_id, brief_enabled, brief_local_time, brief_timezone,
                  brief_weekdays, brief_channel, preferred_language, brief_next_due_utc, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
               ON CONFLICT (workspace_id, user_id) DO UPDATE SET
                 brief_enabled = excluded.brief_enabled,
                 brief_local_time = excluded.brief_local_time,
                 brief_timezone = excluded.brief_timezone,
                 brief_weekdays = excluded.brief_weekdays,
                 brief_channel = excluded.brief_channel,
                 preferred_language = excluded.preferred_language,
                 brief_next_due_utc = NULL,
                 updated_at = excluded.updated_at`,
            )
            .bind(
              params.workspaceId,
              params.userId,
              params.next.brief_enabled ? 1 : 0,
              params.next.brief_local_time,
              params.next.brief_timezone,
              params.next.brief_weekdays ? JSON.stringify(params.next.brief_weekdays) : null,
              params.next.brief_channel,
              params.next.preferred_language,
              params.createdAt,
              params.nowIso,
            ),
        ]
      : [
          db
            .prepare(
              `INSERT INTO member_settings
                 (workspace_id, user_id, brief_enabled, brief_local_time, brief_timezone,
                  brief_weekdays, brief_channel, preferred_language, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (workspace_id, user_id) DO UPDATE SET
                 brief_enabled = excluded.brief_enabled,
                 brief_local_time = excluded.brief_local_time,
                 brief_timezone = excluded.brief_timezone,
                 brief_weekdays = excluded.brief_weekdays,
                 brief_channel = excluded.brief_channel,
                 preferred_language = excluded.preferred_language,
                 updated_at = excluded.updated_at`,
            )
            .bind(
              params.workspaceId,
              params.userId,
              params.next.brief_enabled ? 1 : 0,
              params.next.brief_local_time,
              params.next.brief_timezone,
              params.next.brief_weekdays ? JSON.stringify(params.next.brief_weekdays) : null,
              params.next.brief_channel,
              params.next.preferred_language,
              params.createdAt,
              params.nowIso,
            ),
        ]),
  );

  statements.push(
    db
      .prepare(
        `INSERT INTO settings_audit (id, workspace_id, user_id, actor_user_id, scope, changed_fields_json, occurred_at)
         VALUES (?, ?, ?, ?, 'member', ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        params.workspaceId,
        params.userId,
        params.actorUserId,
        JSON.stringify(params.changed),
        params.nowIso,
      ),
  );

  // If executing inside a fenced run, atomically insert action receipt and increment daily action counter
  if (params.fencedContext && params.payloadHash) {
    const todayUtc = params.nowIso.slice(0, 10);
    statements.push(
      db
        .prepare(
          `INSERT INTO workspace_daily_actions (workspace_id, date_utc, action_count, updated_at)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(workspace_id, date_utc) DO UPDATE SET
             action_count = action_count + 1,
             updated_at = excluded.updated_at`
        )
        .bind(params.workspaceId, todayUtc, params.nowIso),
    );

    statements.push(
      db
        .prepare(
          `INSERT INTO action_receipts (
             id, workspace_id, action_id, payload_hash, command_name, result_status, result_json,
             actor_kind, actor_user_id, source_message_id, source_job_id, run_id, step_id,
             committed_revision, created_at
           ) VALUES (?, ?, ?, ?, 'update_preference', 'applied', ?, 'member', ?, ?, NULL, ?, ?, 0, ?)`
        )
        .bind(
          crypto.randomUUID(),
          params.workspaceId,
          params.fencedContext.actionId,
          params.payloadHash,
          JSON.stringify(params.next),
          params.actorUserId,
          params.fencedContext.sourceMessageId || null,
          params.fencedContext.runId,
          params.fencedContext.stepId || null,
          params.nowIso,
        ),
    );
  }

  try {
    await db.batch(statements);
  } catch (err) {
    if (isGuardFailure(err)) {
      if (!(await isMember(db, params.workspaceId, params.actorUserId))) {
        throw new SettingsError('not_member', 'Caller is no longer a member of this workspace.');
      }
      if (params.fencedContext) {
        if (params.fencedContext.maxDailyActions !== undefined) {
          const todayUtc = params.nowIso.slice(0, 10);
          const quotaRow = await db
            .prepare(`SELECT action_count FROM workspace_daily_actions WHERE workspace_id = ? AND date_utc = ?`)
            .bind(params.workspaceId, todayUtc)
            .first<{ action_count: number }>();
          if ((quotaRow?.action_count ?? 0) >= params.fencedContext.maxDailyActions) {
            throw new SettingsError('conflict', `Workspace daily action limit (${params.fencedContext.maxDailyActions}) exceeded.`);
          }
        }
        throw new SettingsError('fence_conflict', 'Fenced settings execution guard failed: run inactive, lease expired, or fence mismatch.');
      }
    }
    throw err;
  }
}

export async function getWorkspaceSettings(
  db: D1Database,
  workspaceId: string,
): Promise<WorkspaceSettings> {
  const nowIso = new Date().toISOString();
  const row = await db
    .prepare(`SELECT workspace_id, default_model, created_at, updated_at FROM workspace_settings WHERE workspace_id = ?`)
    .bind(workspaceId)
    .first<Record<string, unknown>>();
  if (!row) {
    return { workspace_id: workspaceId, default_model: null, created_at: nowIso, updated_at: nowIso };
  }
  return {
    workspace_id: workspaceId,
    default_model: row['default_model'] ? String(row['default_model']) : null,
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
  };
}

/**
 * Updates shared workspace settings. An empty/unverified operator model
 * registry means no usable model yet; storing a key never invents
 * availability. Registry validation lands with the provider gate (005).
 */
export async function setWorkspaceSettings(
  db: D1Database,
  params: { workspaceId: string; actorUserId: string; defaultModel?: string | null },
): Promise<WorkspaceSettings> {
  if (params.defaultModel !== undefined && params.defaultModel !== null) {
    if (params.defaultModel.length < 1 || params.defaultModel.length > 120) {
      throw new SettingsError('invalid_model', 'Default model key must be 1-120 characters.');
    }
  }
  const nowIso = new Date().toISOString();
  const current = await getWorkspaceSettings(db, params.workspaceId);
  const next: WorkspaceSettings = {
    workspace_id: params.workspaceId,
    default_model: params.defaultModel !== undefined ? params.defaultModel : current.default_model,
    created_at: current.created_at,
    updated_at: nowIso,
  };
  try {
    await db.batch([
      // Guard: the actor is still a member at commit time.
      db
        .prepare(
          `INSERT INTO lifecycle_guards (id, guard_ok)
           VALUES (?, (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?))
           ON CONFLICT(id) DO UPDATE SET guard_ok = excluded.guard_ok`
        )
        .bind(`guard_life_ws_${params.workspaceId}`, params.workspaceId, params.actorUserId),
      db
        .prepare(
          `INSERT INTO workspace_settings (workspace_id, default_model, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (workspace_id) DO UPDATE SET
             default_model = excluded.default_model, updated_at = excluded.updated_at`
        )
        .bind(params.workspaceId, next.default_model, current.created_at, nowIso),
      db
        .prepare(
          `INSERT INTO settings_audit (id, workspace_id, user_id, actor_user_id, scope, changed_fields_json, occurred_at)
           VALUES (?, ?, NULL, ?, 'shared', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          params.workspaceId,
          params.actorUserId,
          JSON.stringify({ default_model: next.default_model }),
          nowIso,
        ),
    ]);
  } catch (err) {
    if (isGuardFailure(err) && !(await isMember(db, params.workspaceId, params.actorUserId))) {
      throw new SettingsError('not_member', 'Caller is no longer a member of this workspace.');
    }
    throw err;
  }
  return next;
}

async function isMember(db: D1Database, workspaceId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
    .bind(workspaceId, userId)
    .first();
  return row !== null;
}

function isGuardFailure(err: unknown): boolean {
  const s = String(err);
  return (
    s.includes('SQLITE_CONSTRAINT') ||
    s.includes('guard_ok') ||
    s.includes('PRIMARY KEY')
  );
}
