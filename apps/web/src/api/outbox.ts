/**
 * Scoped local delivery module (008B send path; shared foundation for 008D).
 *
 * One client UUID identifies one immutable submitted payload. Entries carry
 * account/workspace/chat scope (or a stable new-chat identity), clarification
 * linkage, delivery state, retry metadata and the authoritative server mapping
 * once known. Retry reuses the original identity; editing failed content
 * creates a new entry with a new UUID.
 *
 * Persistence is best-effort idb-keyval behind an in-memory primary. Module
 * durability (`outboxDurable()`) is the single truthful owner: entries never
 * snapshot it, because the async write can fail after creation. Every
 * durability transition notifies subscribers so the UI re-renders honest
 * reload-recovery state. Storage is per-account records written through
 * atomic read-modify-write transactions carrying a persisted owner
 * generation, so tabs racing the same scope converge and a whole-owner
 * purge fences every tab — not just the UUIDs the purging tab knew.
 * Same-UUID server idempotency remains the final duplicate-effect
 * protection.
 */

import { del as idbDel, get as idbGet, update as idbUpdate } from 'idb-keyval';
import { debugLog, failureLog } from './log.js';

export const OUTBOX_SCHEMA_VERSION = 1;
export const OUTBOX_STORAGE_KEY = 'otis/outbox/v1';

export type OutboxDeliveryState = 'sending' | 'saved' | 'failed';

export interface OutboxEntry {
  schemaVersion: 1;
  clientId: string;
  userId: string;
  workspaceId: string;
  /** Null while the chat itself is still being created. */
  chatId: string | null;
  /** Stable retry identity for chat creation; server `new-{key}` is idempotent. */
  newChatKey: string | null;
  /** Immutable submitted payload. Never edited in place. */
  text: string;
  /**
   * Validated private voice media attached to this message (010). Immutable,
   * preserved across retry, so a retried recording keeps one message identity.
   */
  mediaId?: string;
  /**
   * Validated still-image uploads attached to this message (Slice 4).
   * Immutable server media identities finalized before submit, preserved
   * across retry like the voice recording above.
   */
  imageMediaIds?: string[];
  /**
   * Validated document uploads attached to this message (PDF, text, markdown).
   * Immutable server media identities finalized before submit, preserved across retry.
   */
  documentMediaIds?: string[];
  /** Whether this turn text originated from an oversized pasted text conversion. */
  isPastedText?: boolean;
  /** Immutable clarification linkage, preserved across retry. */
  clarificationId?: string;
  /**
   * Immutable records-page target frozen at send, preserved across retry
   * like the text itself. Only turns composed beside the grid carry one;
   * ordinary chat never invents it.
   */
  recordsContext?: import('@otis/contracts').RecordsContext;
  createdAt: string;
  state: OutboxDeliveryState;
  attempts: number;
  /**
   * Next automatic retry instant (008D bounded flush). Absent means due now
   * (never deferred) or never retried automatically (permanent failure):
   * only transient failures set it, so the flush owner retries exactly the
   * entries that asked to be retried. Optional: schema v1 readers ignore it.
   */
  nextRetryAt?: string;
  messageId?: string;
  runId?: string;
  sequence?: number;
  errorCode?: string;
  errorMessage?: string;
}

interface OutboxSnapshot {
  schemaVersion: 1;
  entries: OutboxEntry[];
  newChats: Record<string, { chatId: string; userId: string }>;
}

/**
 * Per-account outbox record (008D). Writes go through one atomic
 * read-modify-write transaction per account, so two tabs racing the same
 * scope converge instead of last-writer-wins clobbering each other:
 * stored rows unknown locally are kept, locally deleted UUIDs stay deleted
 * through sticky per-generation tombstones, and live memory always wins for
 * UUIDs it still holds. The persisted `generation` is bumped by every
 * whole-owner purge (logout, account change, revocation) and checked
 * atomically on every write: a tab persisting with an older observed
 * generation — including entries it created but never persisted before the
 * purge — has its rows dropped instead of resurrecting them. Tombstones are
 * scoped to one generation and cleared by the purge, so they stay bounded
 * by a single login's activity instead of growing forever; the generation
 * fence, not an eviction cap, is what retires them. Union snapshots without
 * tombstones are what resurrected deletions; they are never written anymore
 * (the legacy shared envelope below is read and migrated only).
 */
interface UserOutboxRecord {
  schemaVersion: 1;
  /** Owner generation; bumped by every whole-owner purge. Never deleted. */
  generation: number;
  entries: Record<string, OutboxEntry>;
  /** `e:<clientId>` / `m:<mappingKey>` explicitly removed; sticky per generation. */
  tombstones: Record<string, string>;
  newChats: Record<string, { chatId: string; userId: string }>;
}

const tombForEntry = (clientId: string): string => `e:${clientId}`;
const tombForMapping = (key: string): string => `m:${key}`;

const userRecordKey = (userId: string): string => `otis/outbox/v1/user/${userId}`;

function validUserRecord(value: unknown): UserOutboxRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<UserOutboxRecord>;
  if (record.schemaVersion !== OUTBOX_SCHEMA_VERSION) return null;
  if (!record.entries || typeof record.entries !== 'object') return null;
  if (!record.tombstones || typeof record.tombstones !== 'object') return null;
  if (!record.newChats || typeof record.newChats !== 'object') return null;
  // Legacy records predate the persisted generation; they read as gen 0 and
  // are stamped on the next atomic write.
  if (record.generation !== undefined && typeof record.generation !== 'number') return null;
  return {
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    generation: record.generation ?? 0,
    entries: record.entries as Record<string, OutboxEntry>,
    tombstones: record.tombstones as Record<string, string>,
    newChats: record.newChats as Record<string, { chatId: string; userId: string }>,
  };
}

/** Locally deleted UUIDs/mappings, carried into the next persisted record. */
const localTombstones = new Map<string, { userId: string; at: string }>();

/**
 * Last observed persisted generation per account. The purging tab bumps its
 * cache before persisting; any other tab observes the bumped value on its
 * next read or rejected write and adopts it. The cache alone never
 * authorizes anything — every storage transaction rechecks against the
 * persisted record.
 */
const ownerGenerations = new Map<string, number>();

/**
 * Local purge intent per account, set synchronously by `clearUserOutbox`.
 * It distinguishes this tab's own pending purge from a stale writer: only
 * the persisted generation fences other tabs — this flag merely tells the
 * next persist to write the bumped cleared record even when storage moved
 * ahead meanwhile. Cleared when the purge persist lands; a failed persist
 * keeps it so the next round retries the purge.
 */
const purgePending = new Set<string>();

/**
 * Restore intents started by this instance, per account. Set synchronously
 * when `rehydrateOutbox` begins — before any storage read resolves — so a
 * first observation can tell post-login input (this instance is freshly
 * authenticated: login precedes mount precedes restore, hence precedes any
 * send) from a stale replay. Never cleared: observation caches only grow.
 */
const restoreInitiated = new Set<string>();

function generationOf(userId: string, storedFallback = 0): number {
  return ownerGenerations.get(userId) ?? storedFallback;
}

function tombstoneEntry(clientId: string, userId: string): void {
  localTombstones.set(tombForEntry(clientId), { userId, at: new Date().toISOString() });
}

const entries = new Map<string, OutboxEntry>();
const newChats = new Map<string, { chatId: string; userId: string }>();
/** In-flight delivery claims: one POST per UUID even across remounts. */
const deliveryClaims = new Set<string>();
/**
 * Hydration epoch: clear/reset during a deferred restore must not resurrect
 * another scope's entries afterwards.
 */
let hydrateEpoch = 0;
const listeners = new Set<() => void>();
let version = 0;
let storageOk = true;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const dirtyUsers = new Set<string>();

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function outboxVersion(): number {
  return version;
}

/** True when the last persistence round succeeded. */
export function outboxDurable(): boolean {
  return storageOk;
}

async function persistUser(userId: string): Promise<void> {
  // Set when this tab discovers mid-transaction that another tab purged
  // first: memory rows for the owner are abolished and must be dropped.
  let staleStoredGen: number | null = null;
  let purgedGen: number | null = null;
  let adoptedGen: number | null = null;
  try {
    await idbUpdate<UserOutboxRecord>(userRecordKey(userId), previous => {
      const stored = validUserRecord(previous);
      const storedGen = stored?.generation ?? 0;
      let localGen = ownerGenerations.get(userId);
      if (localGen === undefined && !purgePending.has(userId)) {
        // First observation in this instance. Fresh-login input created
        // before the restore resolves is current-session content: login
        // precedes mount precedes restore, hence precedes any send — but
        // only when this instance actually started a restore. Without one,
        // rows held against post-purge storage may predate the purge, so
        // fail closed and let the stale path below drop them.
        if (storedGen > 0 && !restoreInitiated.has(userId)) {
          staleStoredGen = storedGen;
          if (!stored) {
            return { schemaVersion: OUTBOX_SCHEMA_VERSION, generation: storedGen, entries: {}, tombstones: {}, newChats: {} };
          }
          return {
            schemaVersion: OUTBOX_SCHEMA_VERSION,
            generation: stored.generation,
            entries: { ...stored.entries },
            tombstones: { ...stored.tombstones },
            newChats: { ...stored.newChats },
          };
        }
        adoptedGen = storedGen;
        localGen = storedGen;
      }
      const observedGen = localGen ?? storedGen;
      if (purgePending.has(userId)) {
        // Own purge (memory was cleared at purge time, so anything held now
        // was created after it and is kept). Tombstones belong to the
        // abolished generation and are not carried forward. Monotonic against
        // a concurrent purge from another tab.
        const nextGen = Math.max(storedGen + 1, observedGen);
        purgedGen = nextGen;
        const mergedEntries: Record<string, OutboxEntry> = {};
        for (const entry of entries.values()) {
          if (entry.userId !== userId) continue;
          mergedEntries[entry.clientId] = entry;
        }
        const mergedChats: Record<string, { chatId: string; userId: string }> = {};
        for (const [key, mapping] of newChats) {
          if (mapping.userId !== userId) continue;
          mergedChats[key] = mapping;
        }
        return { schemaVersion: OUTBOX_SCHEMA_VERSION, generation: nextGen, entries: mergedEntries, tombstones: {}, newChats: mergedChats };
      }
      if (storedGen > observedGen) {
        // Stale writer: another tab purged after this tab last observed.
        // Keep storage exactly as-is — memory entries, including rows this
        // tab created but never persisted before the purge, are dropped by
        // the caller after the transaction. Never merge them back. (Copied
        // no-op writes: the updater type cannot return undefined, and stored
        // is always defined here since a missing record reads as gen 0.)
        staleStoredGen = storedGen;
        if (!stored) {
          return { schemaVersion: OUTBOX_SCHEMA_VERSION, generation: storedGen, entries: {}, tombstones: {}, newChats: {} };
        }
        return {
          schemaVersion: OUTBOX_SCHEMA_VERSION,
          generation: stored.generation,
          entries: { ...stored.entries },
          tombstones: { ...stored.tombstones },
          newChats: { ...stored.newChats },
        };
      }
      // Same-generation merge: stored rows unknown locally are kept,
      // locally deleted UUIDs stay deleted through sticky tombstones, and
      // live memory always wins for UUIDs it still holds.
      const tombstones: Record<string, string> = { ...(stored?.tombstones ?? {}) };
      for (const [tomb, meta] of localTombstones) {
        if (meta.userId === userId) tombstones[tomb] = meta.at;
      }
      const mergedEntries: Record<string, OutboxEntry> = {};
      if (stored) {
        for (const [id, storedEntry] of Object.entries(stored.entries)) {
          if (!tombstones[tombForEntry(id)]) mergedEntries[id] = storedEntry;
        }
      }
      for (const entry of entries.values()) {
        if (entry.userId !== userId || tombstones[tombForEntry(entry.clientId)]) continue;
        mergedEntries[entry.clientId] = entry;
      }
      const mergedChats: Record<string, { chatId: string; userId: string }> = {};
      if (stored) {
        for (const [key, mapping] of Object.entries(stored.newChats)) {
          if (!tombstones[tombForMapping(key)]) mergedChats[key] = mapping;
        }
      }
      for (const [key, mapping] of newChats) {
        if (mapping.userId !== userId || tombstones[tombForMapping(key)]) continue;
        mergedChats[key] = mapping;
      }
      return { schemaVersion: OUTBOX_SCHEMA_VERSION, generation: storedGen, entries: mergedEntries, tombstones, newChats: mergedChats };
    });
    if (staleStoredGen !== null) {
      // Adopt the purge generation and drop abolished memory rows; a failed
      // persist keeps storage purged, so the next round cannot resurrect.
      ownerGenerations.set(userId, staleStoredGen);
      for (const [clientId, entry] of entries) {
        if (entry.userId === userId) entries.delete(clientId);
      }
      for (const [key, mapping] of newChats) {
        if (mapping.userId === userId) newChats.delete(key);
      }
      for (const [tomb, meta] of localTombstones) {
        if (meta.userId === userId) localTombstones.delete(tomb);
      }
      notify();
      return;
    }
    if (purgedGen !== null) {
      // Own purge landed: retire the intent and observe the generation so
      // later writes in this session carry the new session token.
      purgePending.delete(userId);
      ownerGenerations.set(userId, purgedGen);
    } else if (adoptedGen !== null) {
      // First observation landed: later writes in this session carry the
      // adopted generation instead of re-resolving it every persist.
      ownerGenerations.set(userId, adoptedGen);
    }
    if (!storageOk) {
      storageOk = true;
      debugLog('outbox', 'persistence recovered', {});
      notify();
    }
  } catch (err) {
    if (storageOk) {
      storageOk = false;
      failureLog('outbox', 'persistence unavailable; content stays in memory only', {
        error: err instanceof Error ? err.message : String(err),
      });
      notify();
    }
  }
}

function schedulePersist(userId?: string): void {
  notify();
  if (userId) dirtyUsers.add(userId);
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const pending = [...dirtyUsers];
    dirtyUsers.clear();
    void (async () => {
      for (const dirty of pending) await persistUser(dirty);
    })();
  }, 0);
}

export async function rehydrateOutbox(userId: string): Promise<void> {
  const flight = hydrateEpoch;
  // Initiation is synchronous so a first persist racing this restore can
  // tell post-login input from a stale replay.
  restoreInitiated.add(userId);
  try {
    const [record, legacy] = await Promise.all([
      idbGet<UserOutboxRecord>(userRecordKey(userId)).catch(() => null),
      idbGet<OutboxSnapshot>(OUTBOX_STORAGE_KEY).catch(() => null),
    ]);
    // A clear/reset won the race while storage was deferred: never resurrect.
    if (flight !== hydrateEpoch) return;
    const stored = validUserRecord(record);
    const storedGen = stored?.generation ?? 0;
    const cached = ownerGenerations.get(userId);
    if (cached !== undefined && cached > storedGen) {
      // This tab purged after the stored record was written: the stored rows
      // are abolished. Never merge them back; push the purge instead.
      schedulePersist(userId);
      return;
    }
    if (cached === undefined) {
      // First observation in this instance (fresh login before or after the
      // restore resolves): adopt the persisted generation and merge —
      // memory rows can only be current-session input, never abolished
      // data. Notably, input sent while this restore was deferred is kept.
      ownerGenerations.set(userId, storedGen);
    } else if (storedGen > cached) {
      // Another tab purged after this tab last observed: adopt the persisted
      // generation and drop abolished memory rows before merging. A stale
      // tab remounting (explicit reactivation) resumes the new generation
      // empty; only rows created after it persist again.
      ownerGenerations.set(userId, storedGen);
      if (stored) {
        for (const [clientId, entry] of entries) {
          if (entry.userId === userId) entries.delete(clientId);
        }
        for (const [key, mapping] of newChats) {
          if (mapping.userId === userId) newChats.delete(key);
        }
        for (const [tomb, meta] of localTombstones) {
          if (meta.userId === userId) localTombstones.delete(tomb);
        }
      }
    }
    const tombstones: Record<string, string> = { ...(stored?.tombstones ?? {}) };
    for (const [tomb, meta] of localTombstones) {
      if (meta.userId === userId) tombstones[tomb] = meta.at;
    }
    if (stored) {
      // Merge, never overwrite: entries created, saved, retried or failed
      // while the restore was in flight are newer than the stored record.
      // Stored rows only fill client UUIDs this session has never seen, and
      // tombstoned rows never come back.
      for (const [id, storedEntry] of Object.entries(stored.entries)) {
        if (tombstones[tombForEntry(id)] || entries.has(id)) continue;
        if ((storedEntry as OutboxEntry).userId !== userId) continue;
        const { durable: _dropped, ...rest } = storedEntry as OutboxEntry & { durable?: unknown };
        entries.set(rest.clientId, rest);
      }
      for (const [key, mapping] of Object.entries(stored.newChats)) {
        if (tombstones[tombForMapping(key)] || newChats.has(key)) continue;
        if (mapping.userId !== userId) continue;
        newChats.set(key, mapping);
      }
    }
    // One-time legacy migration from the pre-008D shared envelope: same
    // merge rules (tombstones apply, unknown UUIDs only). The legacy key is
    // removed only once it holds nothing for any other account, so a shared
    // device never loses another user's unmigrated rows; a leftover key is
    // re-merged idempotently next time.
    if (legacy && legacy.schemaVersion === OUTBOX_SCHEMA_VERSION) {
      let migrated = false;
      for (const storedEntry of (legacy.entries ?? []) as Array<OutboxEntry & { durable?: unknown }>) {
        if (storedEntry.userId !== userId || entries.has(storedEntry.clientId)) continue;
        if (tombstones[tombForEntry(storedEntry.clientId)]) continue;
        const { durable: _dropped, ...rest } = storedEntry;
        entries.set(rest.clientId, rest);
        migrated = true;
      }
      const storedMappings = (legacy.newChats ?? {}) as Record<string, { chatId: string; userId: string } | string>;
      for (const [key, value] of Object.entries(storedMappings)) {
        // Tolerate the pre-release plain-string shape; current writes are scoped.
        const mapping = typeof value === 'string' ? { chatId: value, userId: '' } : value;
        if (mapping.userId !== userId || newChats.has(key)) continue;
        if (tombstones[tombForMapping(key)]) continue;
        newChats.set(key, mapping);
        migrated = true;
      }
      const stranded = (legacy.entries ?? []).some(entry => entry.userId !== userId)
        || Object.values(legacy.newChats ?? {}).some(value =>
          (typeof value === 'string' ? '' : value.userId) !== userId);
      if (!stranded) {
        try {
          await idbDel(OUTBOX_STORAGE_KEY);
        } catch {
          /* A stale legacy envelope is re-merged idempotently next time. */
        }
      }
      if (migrated) schedulePersist(userId);
    }
    storageOk = true;
    notify();
  } catch (err) {
    if (flight !== hydrateEpoch) return;
    storageOk = false;
    failureLog('outbox', 'rehydration failed; starting memory-only', {
      error: err instanceof Error ? err.message : String(err),
    });
    notify();
  }
}

export async function clearOutboxStorage(): Promise<void> {
  try {
    await idbDel(OUTBOX_STORAGE_KEY);
  } catch {
    // Best effort; memory state is authoritative for the session.
  }
}

export function createOutboxEntry(input: {
  userId: string;
  workspaceId: string;
  chatId: string | null;
  text: string;
  /** Recording identity supplied by the recorder; one UUID per note. */
  clientId?: string;
  /** Validated media identity to attach through the acceptance path. */
  mediaId?: string;
  /** Validated still-image identities to attach through the acceptance path. */
  imageMediaIds?: string[];
  /** Validated document identities to attach through the acceptance path. */
  documentMediaIds?: string[];
  isPastedText?: boolean;
  clarificationId?: string;
  /** Frozen records target, preserved across retry like the text itself. */
  recordsContext?: import('@otis/contracts').RecordsContext;
}): OutboxEntry {
  const now = new Date().toISOString();
  const entry: OutboxEntry = {
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    clientId: input.clientId ?? crypto.randomUUID(),
    userId: input.userId,
    workspaceId: input.workspaceId,
    chatId: input.chatId,
    newChatKey: input.chatId ? null : getOrCreatePendingNewChat(input.userId, input.workspaceId),
    text: input.text,
    ...(input.mediaId ? { mediaId: input.mediaId } : {}),
    ...(input.imageMediaIds && input.imageMediaIds.length > 0 ? { imageMediaIds: input.imageMediaIds } : {}),
    ...(input.documentMediaIds && input.documentMediaIds.length > 0 ? { documentMediaIds: input.documentMediaIds } : {}),
    ...(input.isPastedText ? { isPastedText: true } : {}),
    ...(input.clarificationId ? { clarificationId: input.clarificationId } : {}),
    ...(input.recordsContext ? { recordsContext: input.recordsContext } : {}),
    createdAt: now,
    state: 'sending',
    attempts: 0,
  };
  entries.set(entry.clientId, entry);
  schedulePersist(input.userId);
  debugLog('outbox', 'created', { operationId: entry.clientId, chatId: entry.chatId ?? null });
  return entry;
}

export function getOutboxEntry(clientId: string): OutboxEntry | undefined {
  return entries.get(clientId);
}

export function entriesForChat(userId: string, workspaceId: string, chatId: string | null): OutboxEntry[] {
  return [...entries.values()]
    .filter(entry => entry.userId === userId && entry.workspaceId === workspaceId
      && (chatId !== null ? entry.chatId === chatId : entry.chatId === null))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** Every local entry of one account, oldest first. The flush owner scopes by this. */
export function entriesForUser(userId: string): OutboxEntry[] {
  return [...entries.values()]
    .filter(entry => entry.userId === userId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * One pending new-chat identity per (user, workspace), so two rapid sends
 * from a fresh view share the created chat instead of forking it. The mapping
 * persists, so a crash between creation and acceptance still reuses the chat;
 * starting another new view clears the pending key for a fresh conversation.
 */
const pendingNewChats = new Map<string, string>();

export function getOrCreatePendingNewChat(userId: string, workspaceId: string): string {
  const scope = `${userId}/${workspaceId}`;
  const existing = pendingNewChats.get(scope);
  if (existing) return existing;
  const key = crypto.randomUUID();
  pendingNewChats.set(scope, key);
  return key;
}

export function clearPendingNewChat(userId: string, workspaceId: string): void {
  pendingNewChats.delete(`${userId}/${workspaceId}`);
}

export function markOutboxSaved(clientId: string, server: { messageId: string; runId: string; sequence: number }): OutboxEntry | undefined {
  const entry = entries.get(clientId);
  if (!entry) return undefined;
  const next: OutboxEntry = { ...entry, state: 'saved', messageId: server.messageId, runId: server.runId, sequence: server.sequence, errorCode: undefined, errorMessage: undefined };
  entries.set(clientId, next);
  schedulePersist(entry.userId);
  return next;
}

export function markOutboxFailed(clientId: string, error: { code: string; message: string }): OutboxEntry | undefined {
  const entry = entries.get(clientId);
  if (!entry) return undefined;
  const next: OutboxEntry = { ...entry, state: 'failed', attempts: entry.attempts + 1, errorCode: error.code, errorMessage: error.message };
  entries.set(clientId, next);
  schedulePersist(entry.userId);
  return next;
}

export function retryOutboxEntry(clientId: string): OutboxEntry | undefined {
  const entry = entries.get(clientId);
  if (!entry) return undefined;
  // Explicit user retry runs now: it clears any scheduled automatic retry
  // and resets the attempt counter so exhausted retries get a fresh budget.
  const next: OutboxEntry = { ...entry, state: 'sending', attempts: 0, nextRetryAt: undefined, errorCode: undefined, errorMessage: undefined };
  entries.set(clientId, next);
  schedulePersist();
  return next;
}

/**
 * Records the next automatic retry instant after a transient failure.
 * Never invents a retry for permanent failures: only the flush wake path
 * (or an explicit user Retry) may call this.
 */
export function deferOutboxRetry(clientId: string, nextRetryAt: string): OutboxEntry | undefined {
  const entry = entries.get(clientId);
  if (!entry || entry.state === 'saved') return undefined;
  const next: OutboxEntry = { ...entry, nextRetryAt };
  entries.set(clientId, next);
  schedulePersist(entry.userId);
  return next;
}

/**
 * Explicitly discards one unsent local entry. Returns false when the entry
 * is missing or already accepted: discarding is local-only and can never
 * unsend an accepted message (its server row reconciles through snapshots).
 */
export function discardUnsentEntry(clientId: string): boolean {
  const entry = entries.get(clientId);
  if (!entry || entry.state === 'saved') return false;
  entries.delete(clientId);
  tombstoneEntry(clientId, entry.userId);
  schedulePersist(entry.userId);
  return true;
}

/**
 * Claims one delivery attempt for a UUID. True when newly claimed; false
 * when another mount already owns it (StrictMode remount, reload resume).
 * Release when the attempt settles so later retries can proceed.
 */
export function claimDelivery(clientId: string): boolean {
  if (deliveryClaims.has(clientId)) return false;
  deliveryClaims.add(clientId);
  return true;
}

export function releaseDelivery(clientId: string): void {
  deliveryClaims.delete(clientId);
}

/** Binds a new-chat entry to its created chat once the server answers. */
export function updateOutboxChatId(clientId: string, chatId: string): OutboxEntry | undefined {
  const entry = entries.get(clientId);
  if (!entry) return undefined;
  const next: OutboxEntry = { ...entry, chatId };
  entries.set(clientId, next);
  schedulePersist(entry.userId);
  return next;
}

/**
 * Drops non-failed entries once the authoritative server record carrying the
 * same client UUID is visible. Failed entries stay until retried or replaced.
 * Pruned UUIDs are tombstoned so a stale tab can never resurrect them; the
 * server row remains the truth and reconciles them away everywhere.
 */
export function pruneReconciledEntries(reconciledClientIds: Set<string>): void {
  const dirty = new Set<string>();
  for (const [clientId, entry] of entries) {
    if (entry.state !== 'failed' && reconciledClientIds.has(clientId)) {
      entries.delete(clientId);
      tombstoneEntry(clientId, entry.userId);
      dirty.add(entry.userId);
    }
  }
  for (const userId of dirty) schedulePersist(userId);
}

/**
 * Awaits one entry's first settled outcome (010 voice send): 'saved' once the
 * server accepted it (or it was reconciled/pruned, which means the
 * authoritative row exists), 'failed' on the first failed state. Used by the
 * recorder before deleting local bytes; a retained recording retries through
 * the same entry identity.
 */
export function awaitOutboxSettlement(clientId: string): Promise<'saved' | 'failed'> {
  const current = entries.get(clientId);
  if (!current) return Promise.resolve('saved');
  if (current.state === 'saved') return Promise.resolve('saved');
  if (current.state === 'failed') return Promise.resolve('failed');
  return new Promise(resolve => {
    const unsubscribe = subscribeOutbox(() => {
      const entry = entries.get(clientId);
      if (!entry || entry.state === 'saved') {
        unsubscribe();
        resolve('saved');
      } else if (entry.state === 'failed') {
        unsubscribe();
        resolve('failed');
      }
    });
  });
}

export function setNewChatMapping(newChatKey: string, chatId: string, userId: string): void {
  newChats.set(newChatKey, { chatId, userId });
  schedulePersist(userId);
}

export function getNewChatMapping(newChatKey: string, userId?: string): string | undefined {
  const mapping = newChats.get(newChatKey);
  if (!mapping) return undefined;
  if (userId !== undefined && mapping.userId !== userId) return undefined;
  return mapping.chatId;
}

/** Logout, account change and revocation purge a user's local delivery state. */
export function clearUserOutbox(userId: string): void {
  hydrateEpoch += 1;
  // Bump the persisted generation first: delayed writes, retries and
  // hydration started before the purge can never resurrect private content —
  // including rows this tab never knew, which no tombstone could cover, and
  // entries another tab created but never persisted before the purge. Memory
  // is cleared so anything held afterwards was explicitly created post-purge.
  ownerGenerations.set(userId, generationOf(userId) + 1);
  purgePending.add(userId);
  for (const [clientId, entry] of entries) {
    if (entry.userId === userId) entries.delete(clientId);
  }
  for (const [key, mapping] of newChats) {
    if (mapping.userId === userId) newChats.delete(key);
  }
  for (const [tomb, meta] of localTombstones) {
    if (meta.userId === userId) localTombstones.delete(tomb);
  }
  // Always persist: even with empty memory the stored record may hold rows
  // this tab never knew, and only the generation-bumped write drops them.
  schedulePersist(userId);
}

/** Test hook: reset module state between cases. */
export function resetOutboxForTests(): void {
  hydrateEpoch += 1;
  entries.clear();
  newChats.clear();
  pendingNewChats.clear();
  deliveryClaims.clear();
  localTombstones.clear();
  ownerGenerations.clear();
  purgePending.clear();
  restoreInitiated.clear();
  dirtyUsers.clear();
  storageOk = true;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  notify();
}
