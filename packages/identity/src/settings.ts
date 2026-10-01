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
  | 'not_member';

export class SettingsError extends Error {
  public readonly code: SettingsErrorCode;

  constructor(code: SettingsErrorCode, message: string) {
    super(message);
    this.name = 'SettingsError';
    this.code = code;
  }
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

/**
 * Updates personal preferences. Enabling the brief requires a complete
 * schedule; a partial schedule stays disabled rather than inventing a time.
 * Members can only update their own preferences (enforced by routes).
 */
export async function setMemberSettings(
  db: D1Database,
  params: { workspaceId: string; userId: string; actorUserId: string; input: MemberSettingsInput },
): Promise<MemberSettings> {
  validateMemberInput(params.input);
  const nowIso = new Date().toISOString();
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
  });

  return { ...next, created_at: current.created_at };
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
  },
): Promise<void> {
  try {
    await db.batch([
      // Guard: the actor is still a member at commit time.
      db
        .prepare(
          `INSERT INTO lifecycle_guards (id, guard_ok)
           VALUES (?, (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?))`
        )
        .bind(crypto.randomUUID(), params.workspaceId, params.actorUserId),
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
             updated_at = excluded.updated_at`
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
    ]);
  } catch (err) {
    if (isGuardFailure(err) && !(await isMember(db, params.workspaceId, params.actorUserId))) {
      throw new SettingsError('not_member', 'Caller is no longer a member of this workspace.');
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
           VALUES (?, (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?))`
        )
        .bind(crypto.randomUUID(), params.workspaceId, params.actorUserId),
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
