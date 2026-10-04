/**
 * Workspace voice/STT settings (Gate 010).
 *
 * Minimal shared configuration: enabled flag, provider `groq`, and the
 * selected approved STT model. Verified formats are server-recorded evidence
 * from an actual transcription of the container; ordinary client settings
 * can never mutate them and a valid key alone proves nothing. Every change
 * writes an attributed audit row. Raw keys never appear here; credential
 * status is read through the credential module.
 */

import type { VoiceFormat, VoiceSttModel } from '@otis/contracts';

export type VoiceSettingsErrorCode = 'not_member' | 'invalid_model' | 'voice_incomplete';

export class VoiceSettingsError extends Error {
  public readonly code: VoiceSettingsErrorCode;

  constructor(code: VoiceSettingsErrorCode, message: string) {
    super(message);
    this.name = 'VoiceSettingsError';
    this.code = code;
  }
}

export interface StoredVoiceSettings {
  workspace_id: string;
  enabled: boolean;
  provider: 'groq' | null;
  model: VoiceSttModel | null;
  verified_formats: VoiceFormat[];
  created_at: string;
  updated_at: string;
}

export interface VoiceSettingsInput {
  enabled?: boolean;
  model?: VoiceSttModel | null;
}

async function writeVoiceSettings(
  db: D1Database,
  params: {
    workspaceId: string;
    actorUserId: string;
    next: StoredVoiceSettings;
    changed: Record<string, unknown>;
    nowIso: string;
  },
): Promise<void> {
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO lifecycle_guards (id, guard_ok)
           VALUES (?, (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?))`,
        )
        .bind(crypto.randomUUID(), params.workspaceId, params.actorUserId),
      db
        .prepare(
          `INSERT INTO workspace_voice_settings
             (workspace_id, stt_enabled, stt_provider, stt_model, verified_formats_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id) DO UPDATE SET
             stt_enabled = excluded.stt_enabled,
             stt_provider = excluded.stt_provider,
             stt_model = excluded.stt_model,
             verified_formats_json = excluded.verified_formats_json,
             updated_at = excluded.updated_at`,
        )
        .bind(
          params.workspaceId,
          params.next.enabled ? 1 : 0,
          params.next.provider,
          params.next.model,
          JSON.stringify(params.next.verified_formats),
          params.next.created_at,
          params.nowIso,
        ),
      db
        .prepare(
          `INSERT INTO settings_audit (id, workspace_id, user_id, actor_user_id, scope, changed_fields_json, occurred_at)
           VALUES (?, ?, NULL, ?, 'shared', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          params.workspaceId,
          params.actorUserId,
          JSON.stringify({ setting: 'voice', ...params.changed }),
          params.nowIso,
        ),
    ]);
  } catch (err) {
    if (isGuardFailure(err) && !(await isMember(db, params.workspaceId, params.actorUserId))) {
      throw new VoiceSettingsError('not_member', 'Caller is no longer a member of this workspace.');
    }
    throw err;
  }
}

/**
 * Updates ordinary shared voice choices. This path can never mutate
 * verification evidence: verified formats are recorded only by the server
 * probe that actually transcribed the container.
 */
export async function setWorkspaceVoiceSettings(
  db: D1Database,
  params: { workspaceId: string; actorUserId: string; input: VoiceSettingsInput },
): Promise<StoredVoiceSettings> {
  const nowIso = new Date().toISOString();
  const current = await getWorkspaceVoiceSettings(db, params.workspaceId);
  const next: StoredVoiceSettings = {
    ...current,
    enabled: params.input.enabled ?? current.enabled,
    model: params.input.model !== undefined ? params.input.model : current.model,
    provider: 'groq',
    updated_at: nowIso,
  };
  if (next.enabled && !next.model) {
    throw new VoiceSettingsError(
      'voice_incomplete',
      'Enabling voice requires an explicit approved STT model.',
    );
  }
  if (!next.enabled && !next.model) next.provider = null;

  await writeVoiceSettings(db, {
    workspaceId: params.workspaceId,
    actorUserId: params.actorUserId,
    next,
    changed: { enabled: next.enabled, provider: next.provider, model: next.model },
    nowIso,
  });
  return next;
}

/**
 * Server-only evidence mutation: records that the fixed STT route actually
 * transcribed a validated sample of this exact container with this model.
 * Called from the verification route after a real transcription; never from
 * ordinary client settings and never from the WAV credential probe.
 */
export async function recordVoiceFormatEvidence(
  db: D1Database,
  params: {
    workspaceId: string;
    actorUserId: string;
    format: VoiceFormat;
    model: VoiceSttModel;
  },
): Promise<StoredVoiceSettings> {
  const nowIso = new Date().toISOString();
  const current = await getWorkspaceVoiceSettings(db, params.workspaceId);
  const verified = [...new Set([...current.verified_formats, params.format])];
  const next: StoredVoiceSettings = {
    ...current,
    verified_formats: verified,
    updated_at: nowIso,
  };
  await writeVoiceSettings(db, {
    workspaceId: params.workspaceId,
    actorUserId: params.actorUserId,
    next,
    changed: {
      evidence: {
        format: params.format,
        model: params.model,
        source: 'server_transcription',
      },
    },
    nowIso,
  });
  return next;
}

function parseFormats(raw: unknown): VoiceFormat[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is VoiceFormat =>
        value === 'audio/webm' || value === 'audio/mp4' || value === 'audio/ogg',
    );
  } catch {
    return [];
  }
}

export async function getWorkspaceVoiceSettings(
  db: D1Database,
  workspaceId: string,
): Promise<StoredVoiceSettings> {
  const nowIso = new Date().toISOString();
  const row = await db
    .prepare(
      `SELECT stt_enabled, stt_provider, stt_model, verified_formats_json, created_at, updated_at
       FROM workspace_voice_settings WHERE workspace_id = ?`,
    )
    .bind(workspaceId)
    .first<Record<string, unknown>>();
  if (!row) {
    return {
      workspace_id: workspaceId,
      enabled: false,
      provider: null,
      model: null,
      verified_formats: [],
      created_at: nowIso,
      updated_at: nowIso,
    };
  }
  return {
    workspace_id: workspaceId,
    enabled: Number(row['stt_enabled']) === 1,
    provider: row['stt_provider'] === 'groq' ? 'groq' : null,
    model: row['stt_model'] ? (String(row['stt_model']) as VoiceSttModel) : null,
    verified_formats: parseFormats(row['verified_formats_json']),
    created_at: String(row['created_at']),
    updated_at: String(row['updated_at']),
  };
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
  return s.includes('SQLITE_CONSTRAINT') || s.includes('guard_ok') || s.includes('PRIMARY KEY');
}

