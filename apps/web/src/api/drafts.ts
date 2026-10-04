/**
 * Scoped composer drafts in IndexedDB (008D).
 *
 * One record per account holds every draft field plus a persisted owner
 * generation, so logout, account change and revocation purge atomically and
 * can never leave orphaned keys behind. Fields are keyed `workspace/chat`
 * (`null` chat renders as `new`). Concurrent tabs editing different chats
 * resolve last-writer-wins per record; drafts are ephemeral input, not
 * business state, and the mounted composer always wins for its own keystrokes.
 *
 * Cross-tab purge fence without a lock service: every mutation carries the
 * generation its caller observed (mount, keystroke, or pre-await flight),
 * and the storage transaction compares it against the persisted generation
 * atomically. A purge writes a cleared record with a bumped generation
 * (never a delete, so the generation survives); any write replaying an
 * older session aborts instead of resurrecting private content — including a
 * component unmount trailing-save firing after logout, a debounced timer in
 * another tab the purge cannot cancel, and a delayed write paused
 * mid-flight. The purging tab also cancels its own pending debounced saves.
 * A tab that went stale adopts the newer persisted generation on its next
 * read or rejected write; only then do fresh writes succeed, which is the
 * explicit reactivation (fresh login mount rehydrates before typing).
 *
 * Storage is best-effort: every operation catches and degrades to the
 * component's in-memory draft, which stays fully usable while mounted.
 */

import { get as idbGet, update as idbUpdate } from 'idb-keyval';

export const DRAFT_SCHEMA_VERSION = 1;

export interface DraftField {
  text: string;
  updatedAt: string;
}

interface DraftRecord {
  schemaVersion: 1;
  /** Owner generation; bumped by every whole-owner purge. Never deleted. */
  generation: number;
  drafts: Record<string, DraftField>;
}

const recordKey = (userId: string): string => `otis/drafts/v1/${userId}`;

/**
 * Last observed persisted generation per account. Synchronous tokens come
 * from here; the storage transaction rechecks them against the persisted
 * record, which is what fences other tabs — never this cache alone.
 */
const ownerGenerations = new Map<string, number>();

/** Whole-owner purges performed by this instance, per account. */
const purgeCounts = new Map<string, number>();

/**
 * Mount/hydration intents started by this instance, per account. Set
 * synchronously when a load begins — before any storage read resolves — so
 * a mutation captured after mount can tell post-login input (this instance
 * is freshly authenticated and hydrating) from a stale replay.
 */
const loadInitiated = new Set<string>();

/**
 * Storage round-trips currently running for each owner. A fired debounce
 * timer deletes its pending entry before its write settles, so draining
 * timers alone would report safe while a commit is still unsettled — every
 * write registers here and flushes await the snapshot.
 */
const inflightWrites = new Map<string, Set<Promise<boolean>>>();

function trackWrite(userId: string, start: () => Promise<boolean>): Promise<boolean> {
  let running = inflightWrites.get(userId);
  if (!running) {
    running = new Set<Promise<boolean>>();
    inflightWrites.set(userId, running);
  }
  const owned = running;
  const task = start();
  const watched = task.then(
    result => {
      owned.delete(watched);
      if (owned.size === 0 && inflightWrites.get(userId) === owned) inflightWrites.delete(userId);
      return result;
    },
    () => {
      owned.delete(watched);
      if (owned.size === 0 && inflightWrites.get(userId) === owned) inflightWrites.delete(userId);
      return false;
    },
  );
  owned.add(watched);
  return watched;
}

/**
 * Fields with text this instance failed to commit (fenced off or storage
 * failure). The text itself lives on in the mounted composer for retry — the
 * flag only records that storage does not have it yet. Cleared when the
 * field commits or is explicitly removed (submit-cancel, delete, move, whole
 * owner purge); never cleared by merely emptying the pending queue, so a
 * failed save is not silently treated as safe.
 */
const dirtyDraftFields = new Map<string, Set<string>>();

function markDraftDirty(userId: string, field: string): void {
  let fields = dirtyDraftFields.get(userId);
  if (!fields) {
    fields = new Set<string>();
    dirtyDraftFields.set(userId, fields);
  }
  fields.add(field);
}

function clearDraftDirty(userId: string, field: string): void {
  const fields = dirtyDraftFields.get(userId);
  if (!fields) return;
  fields.delete(field);
  if (fields.size === 0 && dirtyDraftFields.get(userId) === fields) dirtyDraftFields.delete(userId);
}

function clearDraftDirtyUser(userId: string): void {
  dirtyDraftFields.delete(userId);
}

function hasDraftDirty(userId: string): boolean {
  return (dirtyDraftFields.get(userId)?.size ?? 0) > 0;
}

/**
 * Synchronous safety inspection for one owner, for use immediately before
 * an irreversible action (update activation): true while a debounced save
 * is still scheduled, a write is still running, or a field is still dirty.
 * An awaited drain cannot see edits that land during its own awaits, so the
 * caller re-checks this with no await between the check and the action and
 * holds instead of looping unboundedly or losing reload data.
 */
export function hasUnsafeDrafts(userId: string): boolean {
  for (const save of pendingSaves.values()) {
    if (save.userId === userId) return true;
  }
  if ((inflightWrites.get(userId)?.size ?? 0) > 0) return true;
  return hasDraftDirty(userId);
}

function generationOf(userId: string): number {
  return ownerGenerations.get(userId) ?? 0;
}

/**
 * Current owner session for a draft key: null when the key is foreign, or
 * when this instance has never observed the owner's generation (fresh mount
 * or reload — the first read adopts the persisted generation). Callers must
 * treat null as "unobserved", never as generation zero: generation zero is a
 * real observed session that a purge can advance past.
 */
export function draftSession(key: string): number | null {
  const parsed = parseDraftKey(key);
  if (!parsed) return null;
  return ownerGenerations.has(parsed.userId) ? ownerGenerations.get(parsed.userId)! : null;
}

interface DraftFlight {
  session: number;
  /** True only before this instance first observes the owner. */
  upgradeable: boolean;
  purges: number;
}

/**
 * Captures the originating owner session for a mutation. An explicit session
 * (replayed debounced/unmount saves, pre-await flights, tests) is always
 * strict. A default session is strict once this instance has observed the
 * owner; before first observation it stays upgradeable so a fresh login's
 * first keystrokes adopt the persisted generation instead of being dropped
 * as stale.
 */
function captureFlight(userId: string, explicit?: number): DraftFlight {
  const purges = purgeCounts.get(userId) ?? 0;
  if (explicit !== undefined) return { session: explicit, upgradeable: false, purges };
  if (ownerGenerations.has(userId)) return { session: ownerGenerations.get(userId)!, upgradeable: false, purges };
  return { session: 0, upgradeable: true, purges };
}

/**
 * Storage-transaction fence: the persisted generation is authoritative. A
 * session at or ahead passes (the latter is this tab's own purge still
 * persisting, which restarts from empty). An older session passes only as a
 * first-observation upgrade — this instance never observed the owner,
 * started hydrating after login, and performed no purge since capture, so
 * its content is current-session input adopting the persisted generation.
 * Anything else is abolished input and aborts the write.
 */
function fenceSession(userId: string, flight: DraftFlight, storedGen: number): boolean {
  if (storedGen <= flight.session) return true;
  if (!flight.upgradeable) return false;
  if (!loadInitiated.has(userId)) return false;
  if ((purgeCounts.get(userId) ?? 0) !== flight.purges) return false;
  ownerGenerations.set(userId, storedGen);
  return true;
}

function validRecord(value: unknown): DraftRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<DraftRecord>;
  if (record.schemaVersion !== DRAFT_SCHEMA_VERSION || !record.drafts || typeof record.drafts !== 'object') return null;
  // Legacy records predate the persisted generation; they read as gen 0 and
  // are stamped on the next atomic write.
  if (record.generation !== undefined && typeof record.generation !== 'number') return null;
  return { schemaVersion: 1, generation: record.generation ?? 0, drafts: record.drafts as Record<string, DraftField> };
}

function parseDraftKey(key: string): { userId: string; field: string } | null {
  const match = /^otis:draft:([^:]+):([^:]+):(.+)$/.exec(key);
  if (!match) return null;
  return { userId: match[1]!, field: `${match[2]!}/${match[3]!}` };
}

async function readRecord(userId: string): Promise<DraftRecord | null> {
  try {
    return validRecord(await idbGet<DraftRecord>(recordKey(userId)));
  } catch {
    return null;
  }
}

export async function loadDraft(key: string): Promise<string | null> {
  const parsed = parseDraftKey(key);
  if (!parsed) return null;
  // Initiation is synchronous so later mutations can tell post-login input
  // from a stale replay; the session snapshot below distinguishes a purge
  // race from first observation.
  loadInitiated.add(parsed.userId);
  const hadSession = ownerGenerations.has(parsed.userId);
  const sessionBefore = ownerGenerations.get(parsed.userId);
  const record = await readRecord(parsed.userId);
  if (!record) return null;
  if (!hadSession) {
    // First observation in this instance (mount or reload): adopt the
    // persisted generation — this IS the authenticated session, not a purge
    // race — and return whatever it holds.
    ownerGenerations.set(parsed.userId, record.generation);
    return record.drafts[parsed.field]?.text ?? null;
  }
  // A generation that moved under an already-observed session means a purge
  // landed before or during the read: never fill abolished input. A session
  // ahead of storage (this tab's own purge still persisting) likewise
  // hydrates nothing.
  if (record.generation !== sessionBefore) return null;
  return record.drafts[parsed.field]?.text ?? null;
}

/** Adopt a newer persisted generation observed inside a rejected write. */
function adoptNewer(userId: string, observed: number | null, session: number): void {
  if (observed !== null && observed > session) {
    const cached = generationOf(userId);
    if (observed > cached) ownerGenerations.set(userId, observed);
  }
}

/**
 * Runs one draft write through the owner fence. Resolves true when the write
 * committed to storage, false when it was fenced off or storage failed: the
 * mounted composer keeps its own value either way, but only true is durable
 * proof a reload would recover (callers that destroy in-memory state — like
 * a service-worker update — must await true before proceeding).
 */
async function writeDraftFlight(userId: string, field: string, text: string, flight: DraftFlight): Promise<boolean> {
  return trackWrite(userId, async () => {
    let observed: number | null = null;
    try {
      // Atomic read-modify-write: concurrent tabs serialise on the store, so
      // neither tab's fields are silently dropped by a stale read. Throwing
      // inside the updater aborts the write when a purge landed mid-flight —
      // checked against the persisted record, so other tabs are fenced too. A
      // session ahead of storage is this tab's own purge still persisting:
      // start from empty rather than merging onto abolished drafts.
      await idbUpdate<DraftRecord>(recordKey(userId), previous => {
        const stored = validRecord(previous);
        const storedGen = stored?.generation ?? 0;
        observed = storedGen;
        if (!fenceSession(userId, flight, storedGen)) throw new Error('draft owner changed');
        if (previous !== undefined && !stored) return previous;
        const drafts = { ...(flight.session > storedGen ? {} : (stored?.drafts ?? {})) };
        drafts[field] = { text, updatedAt: new Date().toISOString() };
        return { schemaVersion: 1 as const, generation: Math.max(flight.session, storedGen), drafts };
      });
      clearDraftDirty(userId, field);
      return true;
    } catch {
      // Best-effort: the mounted composer keeps its own value. Adopt a newer
      // persisted generation so explicit reactivation (fresh login mount)
      // succeeds on its next attempt. The field stays dirty so a later flush
      // still reports unsafe until the text commits or is removed.
      adoptNewer(userId, observed, flight.session);
      markDraftDirty(userId, field);
      return false;
    }
  });
}

export async function saveDraft(key: string, text: string, session?: number): Promise<void> {
  const parsed = parseDraftKey(key);
  if (!parsed) return;
  await writeDraftFlight(parsed.userId, parsed.field, text, captureFlight(parsed.userId, session));
}

interface PendingDraftSave {
  key: string;
  userId: string;
  field: string;
  text: string;
  flight: DraftFlight;
  timer: ReturnType<typeof setTimeout>;
}

const pendingSaves = new Map<string, PendingDraftSave>();

/**
 * Re-resolves a captured flight at write time. Strict flights never change:
 * a replayed session is fenced exactly. An upgradeable flight (captured
 * before this instance first observed the owner) is re-captured fresh, so a
 * first-observation adoption in between upgrades it — unless this instance
 * purged since capture, which locks it strict and fences the write.
 */
function refreshFlight(userId: string, flight: DraftFlight): DraftFlight {
  if (!flight.upgradeable) return flight;
  if ((purgeCounts.get(userId) ?? 0) !== flight.purges) return { ...flight, upgradeable: false };
  return captureFlight(userId);
}

/** Debounced keystroke save bound to the originating owner session. */
export function scheduleDraftSave(key: string, text: string, delayMs = 400): void {
  const parsed = parseDraftKey(key);
  if (!parsed) return;
  const previous = pendingSaves.get(key);
  if (previous) clearTimeout(previous.timer);
  const flight = captureFlight(parsed.userId);
  pendingSaves.set(key, {
    key,
    userId: parsed.userId,
    field: parsed.field,
    text,
    flight,
    timer: setTimeout(() => {
      pendingSaves.delete(key);
      void writeDraftFlight(parsed.userId, parsed.field, text, refreshFlight(parsed.userId, flight));
    }, delayMs),
  });
}

/** Runs a pending debounced save immediately (component unmount path). */
export function flushDraftSaves(key: string): void {
  const pending = pendingSaves.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingSaves.delete(key);
  void writeDraftFlight(pending.userId, pending.field, pending.text, refreshFlight(pending.userId, pending.flight));
}

/** Drops a pending debounced save without writing (submit path). */
export function cancelDraftSave(key: string): void {
  const pending = pendingSaves.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    pendingSaves.delete(key);
  }
  // Submit consumes the text into the send itself: explicit removal clears
  // any dirty flag for the field.
  const parsed = parseDraftKey(key);
  if (parsed) clearDraftDirty(parsed.userId, parsed.field);
}

/**
 * Commits every pending debounced save of one owner and awaits the writes —
 * including writes already running (a fired timer deletes its pending entry
 * before its storage round-trip settles, so timers alone never prove
 * anything). Resolves true only when everything committed and no field is
 * dirty: a failed save stays dirty — retryable by retyping until it commits
 * or is explicitly removed — so an emptied pending queue alone never reads
 * as safe. Vacuously true when nothing is pending, running, or dirty.
 */
export async function flushUserDraftSaves(userId: string): Promise<boolean> {
  const pending = [...pendingSaves.values()].filter(save => save.userId === userId);
  for (const save of pending) {
    clearTimeout(save.timer);
    pendingSaves.delete(save.key);
  }
  const drains = pending.map(save => writeDraftFlight(save.userId, save.field, save.text, refreshFlight(save.userId, save.flight)));
  // Snapshot after draining: timer callbacks cannot interleave the sync
  // drain above, so anything running here fired before this flush began.
  // Writes starting later (keystrokes during the await) belong to the
  // caller's re-drain, never an unbounded loop here.
  const running = [...(inflightWrites.get(userId) ?? [])];
  const committed = await Promise.all([...drains, ...running]);
  return committed.every(Boolean) && !hasDraftDirty(userId);
}

export async function deleteDraft(key: string, session?: number): Promise<void> {
  const parsed = parseDraftKey(key);
  if (!parsed) return;
  // Deletion is explicit removal: whatever the transaction does, no unsaved
  // text remains to protect for this field afterwards.
  clearDraftDirty(parsed.userId, parsed.field);
  const flight = captureFlight(parsed.userId, session);
  let observed: number | null = null;
  try {
    await idbUpdate<DraftRecord>(recordKey(parsed.userId), previous => {
      const stored = validRecord(previous);
      const storedGen = stored?.generation ?? 0;
      observed = storedGen;
      if (!fenceSession(parsed.userId, flight, storedGen)) throw new Error('draft owner changed');
      if (previous !== undefined && !stored) return previous;
      const drafts = { ...(flight.session > storedGen ? {} : (stored?.drafts ?? {})) };
      delete drafts[parsed.field];
      return { schemaVersion: 1 as const, generation: Math.max(flight.session, storedGen), drafts };
    });
  } catch {
    adoptNewer(parsed.userId, observed, flight.session);
  }
}

/**
 * Moves a draft between keys (new-chat creation binding) in one atomic
 * read-modify-write: the source is always consumed, and the destination is
 * written only when the source differs from the just-sent text. Reading and
 * writing once (never write-then-stale-write) keeps the destination intact.
 */
export async function moveDraft(fromKey: string, toKey: string, sentText: string, session?: number): Promise<void> {
  const from = parseDraftKey(fromKey);
  const to = parseDraftKey(toKey);
  if (!from || !to || from.userId !== to.userId) return;
  // The source is consumed by the send either way: explicit removal.
  clearDraftDirty(from.userId, from.field);
  const flight = captureFlight(from.userId, session);
  let observed: number | null = null;
  await trackWrite(from.userId, async () => {
    try {
      await idbUpdate<DraftRecord>(recordKey(from.userId), previous => {
        const stored = validRecord(previous);
        const storedGen = stored?.generation ?? 0;
        observed = storedGen;
        if (!fenceSession(from.userId, flight, storedGen)) throw new Error('draft owner changed');
        if (previous !== undefined && !stored) return previous;
        const drafts = { ...(flight.session > storedGen ? {} : (stored?.drafts ?? {})) };
        const pending = drafts[from.field]?.text ?? null;
        if (pending && pending.trim() !== sentText.trim()) {
          drafts[to.field] = { text: pending, updatedAt: new Date().toISOString() };
        }
        delete drafts[from.field];
        return { schemaVersion: 1 as const, generation: Math.max(flight.session, storedGen), drafts };
      });
      clearDraftDirty(from.userId, to.field);
      return true;
    } catch {
      adoptNewer(from.userId, observed, flight.session);
      markDraftDirty(from.userId, to.field);
      return false;
    }
  });
}

/**
 * Logout, account change and revocation purge one account's drafts wholly.
 * Bumps the owner generation first so delayed writes, deletes, moves and
 * hydration started before the purge can never resurrect private content —
 * including a component unmount trailing-save that fires after logout and a
 * debounced timer in another tab — then cancels this tab's pending saves
 * and persists a cleared record carrying the bumped generation. The record
 * itself is kept (never deleted) so the generation survives for other tabs
 * to observe; concurrent purges converge via max.
 */
export async function deleteDraftsForUser(userId: string): Promise<void> {
  const next = generationOf(userId) + 1;
  ownerGenerations.set(userId, next);
  purgeCounts.set(userId, (purgeCounts.get(userId) ?? 0) + 1);
  // Post-logout there is no text left to protect for this owner.
  clearDraftDirtyUser(userId);
  for (const [key, pending] of pendingSaves) {
    if (pending.userId === userId) {
      clearTimeout(pending.timer);
      pendingSaves.delete(key);
    }
  }
  try {
    await idbUpdate<DraftRecord>(recordKey(userId), previous => {
      const storedGen = validRecord(previous)?.generation ?? 0;
      // Always advance past storage: a purge from a stale cache must still
      // fence in-flight writers holding the stored session.
      return { schemaVersion: 1 as const, generation: Math.max(storedGen + 1, next), drafts: {} };
    });
  } catch {
    /* Best-effort; memory drafts die with the session. */
  }
}
