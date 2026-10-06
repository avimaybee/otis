/**
 * Scoped voice-recording sessions in IndexedDB (010 capture baseline).
 *
 * One record per account holds every local recording session metadata, with
 * chunks in separate keys (`otis/voice/v1/chunk/{sessionId}/{sequence}`), so
 * ordered 1 s chunks survive a reload without rewriting the whole record per
 * chunk. Writes for one session are serialized through a per-session queue;
 * finalize awaits that queue before reassembling, so a final Send can never
 * race an unfinished chunk write.
 *
 * Scope and purge follow the proven drafts/outbox generation fence: every
 * mutation carries the owner generation its caller observed, and the storage
 * transaction compares it against the persisted record atomically. Logout,
 * account change and revocation bump the generation and clear the record
 * (never delete it, so the fence survives); a delayed writer replaying an
 * older session aborts instead of resurrecting private audio. First
 * observation may adopt the persisted generation, which is the normal fresh
 * login / reload path.
 *
 * Storage is best-effort. A storage exception never pretends recording is
 * durable: the caller keeps in-memory bytes and reads `durable: false` from
 * the write result. Raw audio bytes are deleted after known successful
 * handoff, explicit discard, or owner purge.
 */

import { delMany as idbDelMany, get as idbGet, getMany as idbGetMany, set as idbSet, update as idbUpdate } from 'idb-keyval';
import { VOICE_BOUNDS } from '@otis/contracts';

export const VOICE_SESSION_SCHEMA_VERSION = 1;

export type VoiceInterruption = 'none' | 'background' | 'error';

export interface VoiceSessionMeta {
  schemaVersion: 1;
  sessionId: string;
  userId: string;
  workspaceId: string;
  chatId: string | null;
  /** Negotiated MediaRecorder MIME; never a renamed byte stream. */
  mimeType: string;
  startedAt: string;
  updatedAt: string;
  /** Client-collected duration; playback metadata may refine it at finalize. */
  durationMs: number;
  /** Highest appended 1-based sequence index. */
  finalSequence: number;
  byteSize: number;
  /** True only after the recorder emitted its final dataavailable/stop. */
  complete: boolean;
  interruption: VoiceInterruption;
  /** Stable message UUID for upload retry; created once at finalize. */
  clientMessageId: string | null;
}

export interface VoiceSessionScope {
  userId: string;
  workspaceId: string;
  chatId: string | null;
}

interface VoiceUserRecord {
  schemaVersion: 1;
  /** Owner generation; bumped by every whole-owner purge. Never deleted. */
  generation: number;
  sessions: Record<string, VoiceSessionMeta>;
}

interface VoiceFlight {
  generation: number;
  /** True only before this instance first observes the owner. */
  upgradeable: boolean;
}

const userRecordKey = (userId: string): string => `otis/voice/v1/user/${userId}`;
const chunkKey = (sessionId: string, sequence: number): string => `otis/voice/v1/chunk/${sessionId}/${sequence}`;

/**
 * Last observed persisted generation per account. Synchronous tokens come
 * from here; the storage transaction rechecks against the persisted record,
 * which is what fences other tabs — never this cache alone.
 */
const ownerGenerations = new Map<string, number>();

/** Last observed persistence outcome per session (false = memory only). */
const sessionDurability = new Map<string, boolean>();

/** Serialized write queue per session; finalize awaits its tail. */
const writeQueues = new Map<string, Promise<unknown>>();

function validRecord(value: unknown): VoiceUserRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<VoiceUserRecord>;
  if (record.schemaVersion !== VOICE_SESSION_SCHEMA_VERSION) return null;
  if (!record.sessions || typeof record.sessions !== 'object') return null;
  if (record.generation !== undefined && typeof record.generation !== 'number') return null;
  return {
    schemaVersion: VOICE_SESSION_SCHEMA_VERSION,
    generation: record.generation ?? 0,
    sessions: record.sessions as Record<string, VoiceSessionMeta>,
  };
}

function captureFlight(userId: string): VoiceFlight {
  const generation = ownerGenerations.get(userId);
  if (generation !== undefined) return { generation, upgradeable: false };
  return { generation: 0, upgradeable: true };
}

function adoptGeneration(userId: string, observed: number | null): void {
  const cached = ownerGenerations.get(userId) ?? 0;
  const next = Math.max(cached, observed ?? 0);
  ownerGenerations.set(userId, next);
}

/**
 * One atomic read-modify-write against the owner record. Resolves
 * `{ ok: false, durable: true }` when the mutation was fenced/rejected and
 * `{ ok: false, durable: false }` when storage itself failed.
 */
async function mutateRecord<T>(
  userId: string,
  flight: VoiceFlight,
  mutate: (record: VoiceUserRecord) => { value: T; commit: boolean },
): Promise<{ ok: boolean; durable: boolean; value?: T }> {
  let observed: number | null = null;
  let rejected = false;
  let value: T | undefined;
  try {
    await idbUpdate<VoiceUserRecord>(userRecordKey(userId), previous => {
      const stored = validRecord(previous);
      const storedGen = stored?.generation ?? 0;
      observed = storedGen;
      let generation = flight.generation;
      if (storedGen > generation) {
        // A whole-owner purge landed. A first-observation flight (fresh
        // login/reload) adopts the persisted generation; a session-scoped
        // writer holding an older observed generation is abolished content
        // and must not resurrect private audio.
        if (flight.upgradeable) {
          generation = storedGen;
        } else {
          rejected = true;
          throw new Error('voice owner changed');
        }
      }
      const next: VoiceUserRecord = {
        schemaVersion: VOICE_SESSION_SCHEMA_VERSION,
        generation: Math.max(generation, storedGen),
        sessions: { ...(stored?.sessions ?? {}) },
      };
      const outcome = mutate(next);
      value = outcome.value;
      if (!outcome.commit) {
        rejected = true;
        throw new Error('voice mutation rejected');
      }
      return next;
    });
    adoptGeneration(userId, observed);
    return { ok: true, durable: true, value };
  } catch {
    if (!rejected) return { ok: false, durable: false };
    adoptGeneration(userId, observed);
    return { ok: false, durable: true };
  }
}

function enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(sessionId) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeQueues.set(sessionId, next.catch(() => {}));
  return next;
}

/** Awaits every queued write for one session (finalize cannot race a chunk). */
export function voiceSessionWritesSettled(sessionId: string): Promise<void> {
  return (writeQueues.get(sessionId) ?? Promise.resolve()).then(() => {});
}

/** True when the last write for this session committed to IndexedDB. */
export function voiceSessionDurable(sessionId: string): boolean {
  return sessionDurability.get(sessionId) ?? true;
}

/** Hydrates the owner generation before the first recording write. */
export async function rehydrateVoiceSessions(userId: string): Promise<void> {
  try {
    const record = validRecord(await idbGet<VoiceUserRecord>(userRecordKey(userId)));
    if (record) adoptGeneration(userId, record.generation);
  } catch {
    /* Memory-only recording stays possible; durability reports false. */
  }
}

export async function createVoiceSession(input: {
  sessionId: string;
  userId: string;
  workspaceId: string;
  chatId: string | null;
  mimeType: string;
  startedAt?: string;
}): Promise<{ meta: VoiceSessionMeta; durable: boolean }> {
  const now = new Date().toISOString();
  const meta: VoiceSessionMeta = {
    schemaVersion: VOICE_SESSION_SCHEMA_VERSION,
    sessionId: input.sessionId,
    userId: input.userId,
    workspaceId: input.workspaceId,
    chatId: input.chatId,
    mimeType: input.mimeType,
    startedAt: input.startedAt ?? now,
    updatedAt: now,
    durationMs: 0,
    finalSequence: 0,
    byteSize: 0,
    complete: false,
    interruption: 'none',
    clientMessageId: null,
  };
  const result = await mutateRecord(input.userId, captureFlight(input.userId), record => {
    record.sessions[input.sessionId] = meta;
    return { value: meta, commit: true };
  });
  sessionOwners.set(input.sessionId, input.userId);
  const durable = result.ok && result.durable;
  sessionDurability.set(input.sessionId, durable);
  return { meta, durable };
}

/**
 * Session records live under their owner, but chunk writes only carry the
 * session ID. The hook keeps the owner in the meta it just created; reload
 * recovery repopulates this map through `listVoiceSessions`.
 */
const sessionOwners = new Map<string, string>();

export async function appendVoiceChunk(input: {
  sessionId: string;
  sequence: number;
  chunk: Blob;
  durationMs: number;
}): Promise<{ ok: boolean; durable: boolean }> {
  if (input.chunk.size === 0) {
    return { ok: true, durable: voiceSessionDurable(input.sessionId) };
  }
  return enqueue(input.sessionId, async () => {
    const owner = sessionOwners.get(input.sessionId);
    if (!owner) return { ok: false, durable: false };
    const record = validRecord(await idbGet<VoiceUserRecord>(userRecordKey(owner)).catch(() => undefined));
    const current = record?.sessions[input.sessionId];
    if (!current) {
      sessionDurability.set(input.sessionId, false);
      return { ok: false, durable: false };
    }
    if (current.byteSize + input.chunk.size > VOICE_BOUNDS.MAX_BYTES) {
      return { ok: false, durable: voiceSessionDurable(input.sessionId) };
    }
    try {
      await idbSet(chunkKey(input.sessionId, input.sequence), input.chunk);
    } catch {
      sessionDurability.set(input.sessionId, false);
      return { ok: false, durable: false };
    }
    const result = await mutateRecord(owner, captureFlight(owner), recordState => {
      const latest = recordState.sessions[input.sessionId];
      if (!latest) return { value: undefined, commit: false };
      recordState.sessions[input.sessionId] = {
        ...latest,
        finalSequence: Math.max(latest.finalSequence, input.sequence),
        byteSize: latest.byteSize + input.chunk.size,
        durationMs: Math.max(latest.durationMs, input.durationMs),
        updatedAt: new Date().toISOString(),
      };
      return { value: true, commit: true };
    });
    sessionDurability.set(input.sessionId, result.durable);
    return { ok: result.ok, durable: result.durable };
  });
}

export async function checkpointVoiceSession(input: {
  sessionId: string;
  durationMs: number;
  complete?: boolean;
  interruption?: VoiceInterruption;
  clientMessageId?: string;
}): Promise<{ ok: boolean; durable: boolean }> {
  return enqueue(input.sessionId, async () => {
    const owner = sessionOwners.get(input.sessionId);
    if (!owner) return { ok: false, durable: false };
    const result = await mutateRecord(owner, captureFlight(owner), record => {
      const current = record.sessions[input.sessionId];
      if (!current) return { value: undefined, commit: false };
      record.sessions[input.sessionId] = {
        ...current,
        durationMs: Math.max(current.durationMs, input.durationMs),
        complete: input.complete ?? current.complete,
        interruption: input.interruption ?? current.interruption,
        clientMessageId: input.clientMessageId ?? current.clientMessageId,
        updatedAt: new Date().toISOString(),
      };
      return { value: true, commit: true };
    });
    sessionDurability.set(input.sessionId, result.durable);
    return { ok: result.ok, durable: result.durable };
  });
}

/**
 * Reassembles the complete ordered sequence after every queued write settles.
 * Returns the stored blob and how many sequence slots were missing: a gap is
 * reported honestly and left to playback validation, never hidden.
 */
export async function finalizeVoiceSession(sessionId: string): Promise<{ meta: VoiceSessionMeta; blob: Blob; missing: number } | null> {
  await voiceSessionWritesSettled(sessionId);
  const owner = sessionOwners.get(sessionId);
  if (!owner) return null;
  let record: VoiceUserRecord | null = null;
  try {
    record = validRecord(await idbGet<VoiceUserRecord>(userRecordKey(owner)));
  } catch {
    return null;
  }
  const meta = record?.sessions[sessionId];
  if (!meta) return null;
  const parts: Blob[] = [];
  let missing = 0;
  for (const chunk of await readChunksBatched(sessionId, meta.finalSequence)) {
    if (chunk && chunk.size > 0) parts.push(chunk);
    else missing += 1;
  }
  if (parts.length === 0) return null;
  return { meta, blob: new Blob(parts, { type: meta.mimeType }), missing };
}

/**
 * Ordered chunk reads in bounded groups sharing one IndexedDB transaction
 * each (F19): 180 serial gets become a handful of roundtrips. Order,
 * zero-size handling and missing-slot counting match the old loop exactly;
 * an unreadable group degrades to missing slots, never a failed finalize.
 */
const CHUNK_READ_GROUP_SIZE = 32;

async function readChunksBatched(sessionId: string, finalSequence: number): Promise<Array<Blob | undefined>> {
  const out: Array<Blob | undefined> = [];
  for (let start = 1; start <= finalSequence; start += CHUNK_READ_GROUP_SIZE) {
    const end = Math.min(finalSequence, start + CHUNK_READ_GROUP_SIZE - 1);
    const keys: string[] = [];
    for (let sequence = start; sequence <= end; sequence += 1) {
      keys.push(chunkKey(sessionId, sequence));
    }
    try {
      const values = await idbGetMany<Blob>(keys);
      for (let index = 0; index < keys.length; index += 1) {
        out.push(values[index]);
      }
    } catch {
      for (let index = 0; index < keys.length; index += 1) {
        out.push(undefined);
      }
    }
  }
  return out;
}

/** Sessions for one exact scope, newest first; used for reload recovery. */
export async function listVoiceSessions(scope: VoiceSessionScope): Promise<VoiceSessionMeta[]> {
  try {
    const record = validRecord(await idbGet<VoiceUserRecord>(userRecordKey(scope.userId)));
    if (!record) return [];
    const cached = ownerGenerations.get(scope.userId);
    if (cached === undefined) adoptGeneration(scope.userId, record.generation);
    else if (record.generation > cached) adoptGeneration(scope.userId, record.generation);
    else if (cached > record.generation) return [];
    for (const meta of Object.values(record.sessions)) sessionOwners.set(meta.sessionId, meta.userId);
    return Object.values(record.sessions)
      .filter(meta => meta.workspaceId === scope.workspaceId && meta.chatId === scope.chatId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch {
    return [];
  }
}

/** Explicit discard: removes metadata, ordered chunks and in-memory state. */
export async function deleteVoiceSession(sessionId: string): Promise<void> {
  const owner = sessionOwners.get(sessionId);
  writeQueues.delete(sessionId);
  sessionDurability.delete(sessionId);
  sessionOwners.delete(sessionId);
  if (!owner) return;
  try {
    const record = validRecord(await idbGet<VoiceUserRecord>(userRecordKey(owner)));
    const meta = record?.sessions[sessionId];
    await mutateRecord(owner, captureFlight(owner), next => {
      delete next.sessions[sessionId];
      return { value: undefined, commit: true };
    });
    if (meta) await deleteChunks(sessionId, meta.finalSequence);
  } catch {
    /* Best-effort; memory state is already gone. */
  }
}

async function deleteChunks(sessionId: string, finalSequence: number): Promise<void> {
  const keys: string[] = [];
  for (let sequence = 1; sequence <= finalSequence; sequence += 1) {
    keys.push(chunkKey(sessionId, sequence));
  }
  // Chunk keys are bounded by the recorder cap: one transaction deletes them
  // together instead of one roundtrip per chunk. Best-effort like before;
  // orphans stay bounded and unreferenced.
  try {
    await idbDelMany(keys);
  } catch {
    /* Orphan chunks are bounded and unreferenced. */
  }
}

/**
 * Logout, account change and revocation purge one account's local audio
 * wholly: bump the generation first so delayed writes can never resurrect
 * private content, persist a cleared record (the generation survives), then
 * remove chunk keys best-effort.
 */
export async function deleteVoiceSessionsForUser(userId: string): Promise<void> {
  const next = (ownerGenerations.get(userId) ?? 0) + 1;
  ownerGenerations.set(userId, next);
  let sessions: VoiceSessionMeta[] = [];
  try {
    const record = validRecord(await idbGet<VoiceUserRecord>(userRecordKey(userId)));
    sessions = Object.values(record?.sessions ?? {});
    await idbUpdate<VoiceUserRecord>(userRecordKey(userId), previous => {
      const storedGen = validRecord(previous)?.generation ?? 0;
      return {
        schemaVersion: VOICE_SESSION_SCHEMA_VERSION,
        generation: Math.max(storedGen + 1, next),
        sessions: {},
      };
    });
  } catch {
    /* Best-effort; memory sessions die with the session. */
  }
  for (const meta of sessions) {
    writeQueues.delete(meta.sessionId);
    sessionDurability.delete(meta.sessionId);
    sessionOwners.delete(meta.sessionId);
    await deleteChunks(meta.sessionId, meta.finalSequence);
  }
}

/** Test hook: reset module state between cases. */
export function resetVoiceSessionsForTests(): void {
  ownerGenerations.clear();
  sessionDurability.clear();
  writeQueues.clear();
  sessionOwners.clear();
}
