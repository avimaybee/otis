import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import {
  scheduleNextTranscriptionWake,
  TRANSCRIPTION_RETRY_WAKE_CEILING_SECONDS,
  type TranscriptionWakeQueue,
} from '../src/media/transcription.js';

/**
 * Transcription retry wakes (workerd, real D1). A deferred retry anchors
 * exactly one follow-up wake to the job's own durable due instant — never a
 * fixed poll — so a failed immediate pass recovers in seconds via the queue
 * instead of sleeping until the five-minute cron sweep.
 */
describe('Transcription retry wakes (workerd)', () => {
  const ws = 'ws-voice-wake';
  const aviId = 'usr_voice_wake';
  const now = new Date().toISOString();

  function makeQueue() {
    const sends: Array<{ body: { workspace_id: string }; options?: { delaySeconds?: number } }> = [];
    const send: TranscriptionWakeQueue['send'] = async (body, options) => {
      sends.push({ body, options });
    };
    return { sends, queue: { send } };
  }

  async function clearWakeRows(): Promise<void> {
    await env.DB.prepare(`DELETE FROM media_transcriptions WHERE id LIKE 'wake\\_%' ESCAPE '\\'`).run();
    await env.DB.prepare(`DELETE FROM media_objects WHERE id LIKE 'wake\\_media\\_%' ESCAPE '\\'`).run();
  }

  async function seedJob(id: string, mediaId: string, overrides: { state?: string; route?: string; nextAttemptAt?: string | null } = {}): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO media_objects (id, workspace_id, uploader_user_id, object_key, format, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'audio/ogg', ?, ?, ?)`,
    ).bind(mediaId, ws, aviId, `audio/${mediaId}.ogg`, new Date(Date.now() + 14 * 86400 * 1000).toISOString(), now, now).run();
    await env.DB.prepare(
      `INSERT INTO media_transcriptions (id, workspace_id, media_id, state, route, format, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'audio/ogg', ?, ?, ?)`,
    ).bind(
      id, ws, mediaId,
      overrides.state ?? 'pending',
      overrides.route ?? 'groq_stt',
      overrides.nextAttemptAt === undefined ? null : overrides.nextAttemptAt,
      now, now,
    ).run();
  }

  beforeAll(async () => {
    await applyMigrations(env.DB);
    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(aviId, `fb_${aviId}`, 'avi.wake@test', 'Avi', now, now).run();
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
       VALUES (?, 'Wake WS', ?, 0, 1, ?, ?)`,
    ).bind(ws, aviId, now, now).run();
    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?, ?)`,
    ).bind(ws, aviId, now, now, now).run();
  });

  it('schedules one wake at a future retry instant', async () => {
    await clearWakeRows();
    const dueAt = new Date(Date.now() + 65_000).toISOString();
    await seedJob('wake_job_1', 'wake_media_1', { nextAttemptAt: dueAt });
    const { sends, queue } = makeQueue();
    await scheduleNextTranscriptionWake({ db: env.DB, queue }, ws);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.body).toEqual({ workspace_id: ws });
    const delay = sends[0]!.options?.delaySeconds ?? 0;
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(66);
    await clearWakeRows();
  });

  it('caps far-future retries at the ceiling and sends nothing when idle', async () => {
    await clearWakeRows();
    const far = new Date(Date.now() + 3_600_000).toISOString();
    await seedJob('wake_job_2', 'wake_media_2', { nextAttemptAt: far });
    const capped = makeQueue();
    await scheduleNextTranscriptionWake({ db: env.DB, queue: capped.queue }, ws);
    expect(capped.sends).toHaveLength(1);
    expect(capped.sends[0]!.options?.delaySeconds).toBe(TRANSCRIPTION_RETRY_WAKE_CEILING_SECONDS);
    await clearWakeRows();

    const idle = makeQueue();
    await scheduleNextTranscriptionWake({ db: env.DB, queue: idle.queue }, ws);
    expect(idle.sends).toHaveLength(0);
    await scheduleNextTranscriptionWake({ db: env.DB, queue: undefined }, ws);
  });

  it('ignores non-groq routes and non-pending states', async () => {
    await clearWakeRows();
    await seedJob('wake_job_3', 'wake_media_3', { route: 'native' });
    await seedJob('wake_job_4', 'wake_media_4', { state: 'ready' });
    const { sends, queue } = makeQueue();
    await scheduleNextTranscriptionWake({ db: env.DB, queue }, ws);
    expect(sends).toHaveLength(0);
    await clearWakeRows();
  });
});
