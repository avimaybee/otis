/**
 * One scoped flush owner per browser/account (008D).
 *
 * The outbox module owns entries; this module owns waking and delivering
 * them. Local acceptance (echo, draft clear, follow) stays instant in
 * `send()`; network acceptance dispatch joins this single per-chat/claim
 * path, so a follow-up submit never overtakes a still-unacknowledged first
 * POST while the composer never blocks. Retries preserve per-chat
 * chronological order and never bypass an unresolved earlier acceptance;
 * the server UUID dedupe remains the final duplicate-effect protection.
 *
 * Cross-tab discipline without a lock service: the flushing tab holds a
 * short exclusive claim (Web Locks `ifAvailable`, else an atomic IndexedDB
 * compare-and-set with owner-token guarded release and renewal), so a
 * second tab skips instead of storming. Skipped tabs simply wait for the
 * next wake event. `navigator.onLine` is only a hint; every attempt still
 * proves connectivity by posting.
 */

import { entriesForUser, type OutboxEntry } from './outbox.js';
import { debugLog } from './log.js';

/** Bounded automatic retries; explicit user Retry is never capped. */
export const FLUSH_MAX_ATTEMPTS = 8;
/** Exponential backoff base and cap for transient failures. Not visual. */
export const FLUSH_BACKOFF_BASE_MS = 2000;
export const FLUSH_BACKOFF_CAP_MS = 5 * 60_000;
/**
 * Parsing bound for server Retry-After instants (24h). Valid server values
 * below it are used exactly; the exponential cap never shortens them.
 */
export const SERVER_RETRY_AFTER_MAX_MS = 24 * 60 * 60_000;
/** Cross-tab claim lifetime; expiry bounds a crashed holder. Not visual. */
export const FLUSH_CLAIM_TTL_MS = 30_000;

export type SendErrorKind = 'transient' | 'permanent';

/**
 * Separates retryable transport/rate failures from final ones. Auth and
 * validation failures (including obsolete clarifications) are permanent:
 * they pause with their message-attached recovery action and never reroute
 * to another chat or workspace.
 */
export function classifySendError(err: unknown): SendErrorKind {
  if (err !== null && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') {
      if (status === 408 || status === 425 || status === 429 || status >= 500) return 'transient';
      return 'permanent';
    }
  }
  // No HTTP status arrived (offline, DNS, CORS, aborted fetch): transient.
  return 'transient';
}

/** Bounded exponential backoff honoring a server Retry-After when present. */
export function computeBackoffMs(attempts: number, retryAfterMs?: number): number {
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    // A valid server retry instant is authoritative: the exponential cap
    // applies to our own delay only, never shortens a rate limit. Absurd
    // values are clamped by a documented parsing bound, not the backoff cap.
    return Math.min(SERVER_RETRY_AFTER_MAX_MS, Math.floor(retryAfterMs));
  }
  const safeAttempts = Math.max(0, Math.floor(attempts));
  return Math.min(FLUSH_BACKOFF_CAP_MS, FLUSH_BACKOFF_BASE_MS * 2 ** Math.min(safeAttempts, 10));
}

const TAB_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto
  ? crypto.randomUUID()
  : `tab-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

const CLAIM_DB_NAME = 'otis-flush-claims';
const CLAIM_STORE_NAME = 'claims';

interface ClaimRecord {
  userId: string;
  owner: string;
  expiresAt: number;
}

function claimFactory(explicit?: IDBFactory): IDBFactory | null {
  if (explicit) return explicit;
  try {
    return typeof indexedDB !== 'undefined' ? indexedDB : null;
  } catch {
    return null;
  }
}

function openClaimDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(CLAIM_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CLAIM_STORE_NAME)) {
        request.result.createObjectStore(CLAIM_STORE_NAME, { keyPath: 'userId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('open claim db failed'));
  });
}

function runClaimTransaction<T>(
  db: IDBDatabase,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  // The operation result is held until the transaction itself settles: a
  // request may succeed and the transaction still abort afterwards (another
  // tab upgrading/deleting the database, quota, I/O). Resolving on request
  // success would report an acquired claim that never committed.
  return new Promise<T>((resolve, reject) => {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | null = null;
    const tx = db.transaction(CLAIM_STORE_NAME, 'readwrite');
    tx.oncomplete = () => {
      if (outcome?.ok) resolve(outcome.value);
      else reject(outcome && !outcome.ok ? outcome.error : new Error('claim transaction completed without settling'));
    };
    tx.onabort = () => {
      reject(outcome && !outcome.ok ? outcome.error : (tx.error ?? new Error('claim transaction aborted')));
    };
    tx.onerror = () => {
      // Request errors auto-abort the transaction; onabort above rejects.
    };
    void run(tx.objectStore(CLAIM_STORE_NAME)).then(
      value => {
        outcome = { ok: true, value };
      },
      error => {
        outcome = { ok: false, error };
        try {
          tx.abort();
        } catch {
          /* onabort below still rejects. */
        }
      },
    );
  });
}

async function withClaimDb<T>(factory: IDBFactory | undefined, run: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const impl = claimFactory(factory);
  if (!impl) throw new Error('indexedDB unavailable');
  const db = await openClaimDb(impl);
  try {
    return await run(db);
  } finally {
    try {
      db.close();
    } catch {
      /* Short-lived connections; close is best-effort. */
    }
  }
}

/**
 * Atomically acquires the flush claim for a user scope. Read and conditional
 * write happen in a single readwrite transaction, so two tabs racing the
 * same scope cannot both win: the store lock serializes them and the loser
 * observes the winner's committed claim. Returns true when this owner holds
 * a fresh claim afterwards.
 */
export async function acquireFlushClaim(
  userId: string,
  owner: string,
  nowMs: number,
  factory?: IDBFactory,
): Promise<boolean> {
  return withClaimDb(factory, db =>
    runClaimTransaction(db, store => new Promise<boolean>((resolve, reject) => {
      const getRequest = store.get(userId);
      getRequest.onsuccess = () => {
        const current = getRequest.result as ClaimRecord | undefined;
        if (current && current.owner !== owner && current.expiresAt > nowMs) {
          resolve(false);
          return;
        }
        const putRequest = store.put({ userId, owner, expiresAt: nowMs + FLUSH_CLAIM_TTL_MS } satisfies ClaimRecord);
        putRequest.onsuccess = () => resolve(true);
        putRequest.onerror = () => reject(putRequest.error ?? new Error('claim write failed'));
      };
      getRequest.onerror = () => reject(getRequest.error ?? new Error('claim read failed'));
    })),
  );
}

/**
 * Reads the current claim for inspection (tests, diagnostics). Never used
 * for coordination decisions outside a claim transaction.
 */
export async function readFlushClaim(
  userId: string,
  factory?: IDBFactory,
): Promise<{ owner: string; expiresAt: number } | null> {
  const record = await withClaimDb(factory, db =>
    new Promise<{ owner: string; expiresAt: number } | null | undefined>((resolve, reject) => {
      const tx = db.transaction(CLAIM_STORE_NAME, 'readonly');
      const getRequest = tx.objectStore(CLAIM_STORE_NAME).get(userId);
      getRequest.onsuccess = () => resolve(getRequest.result as { owner: string; expiresAt: number } | undefined ?? null);
      getRequest.onerror = () => reject(getRequest.error ?? new Error('claim read failed'));
    }),
  );
  return record ?? null;
}

/**
 * Renews a held claim's lease inside one atomic transaction. Returns false
 * when the claim belongs to someone else (or is gone): the caller must stop.
 */
export async function renewFlushClaim(
  userId: string,
  owner: string,
  nowMs: number,
  factory?: IDBFactory,
): Promise<boolean> {
  return withClaimDb(factory, db =>
    runClaimTransaction(db, store => new Promise<boolean>((resolve, reject) => {
      const getRequest = store.get(userId);
      getRequest.onsuccess = () => {
        const current = getRequest.result as ClaimRecord | undefined;
        if (!current || current.owner !== owner) {
          resolve(false);
          return;
        }
        const putRequest = store.put({ userId, owner, expiresAt: nowMs + FLUSH_CLAIM_TTL_MS } satisfies ClaimRecord);
        putRequest.onsuccess = () => resolve(true);
        putRequest.onerror = () => reject(putRequest.error ?? new Error('claim renew failed'));
      };
      getRequest.onerror = () => reject(getRequest.error ?? new Error('claim read failed'));
    })),
  );
}

/**
 * Releases a claim only when this owner still holds it. A tab that lost the
 * lease (expiry takeover) can never delete another tab's claim.
 */
export async function releaseFlushClaim(
  userId: string,
  owner: string,
  factory?: IDBFactory,
): Promise<boolean> {
  return withClaimDb(factory, db =>
    runClaimTransaction(db, store => new Promise<boolean>((resolve, reject) => {
      const getRequest = store.get(userId);
      getRequest.onsuccess = () => {
        const current = getRequest.result as ClaimRecord | undefined;
        if (!current || current.owner !== owner) {
          resolve(false);
          return;
        }
        const deleteRequest = store.delete(userId);
        deleteRequest.onsuccess = () => resolve(true);
        deleteRequest.onerror = () => reject(deleteRequest.error ?? new Error('claim release failed'));
      };
      getRequest.onerror = () => reject(getRequest.error ?? new Error('claim read failed'));
    })),
  );
}

interface WebLocks {
  request: <T>(name: string, options: { mode: 'exclusive'; ifAvailable: true }, callback: (lock: object | null) => Promise<T>) => Promise<T>;
}

function webLocks(): WebLocks | null {
  try {
    const locks = (navigator as Navigator & { locks?: WebLocks }).locks;
    return typeof locks?.request === 'function' ? locks : null;
  } catch {
    return null;
  }
}

/**
 * Runs `work` under this tab's exclusive flush claim, or reports 'skipped'
 * when another tab holds it. Best-effort by design: the server UUID dedupe
 * stays the final duplicate-effect protection, and expiry bounds a crashed
 * holder so one dead tab cannot silence the others.
 *
 * The work callback receives a live ownership check it must call before
 * every POST after the first: under Web Locks ownership cannot be lost
 * mid-callback, but a fallback lease can be taken over after expiry, and a
 * holder that lost its lease must stop instead of delivering alongside the
 * new owner. A lease that fails to renew after a takeover is never silently
 * re-taken: renewal is an atomic compare-and-set on the owner token.
 */
export async function withFlushLock(
  userId: string,
  work: (stillOwner: () => Promise<boolean>) => Promise<void>,
): Promise<'ran' | 'skipped'> {
  const locks = webLocks();
  if (locks) {
    return locks.request(`otis-flush:${userId}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) return 'skipped';
      await work(async () => true);
      return 'ran';
    });
  }
  let acquired = false;
  try {
    acquired = await acquireFlushClaim(userId, TAB_ID, Date.now());
  } catch {
    /* Storage-backed claims are best-effort; a rejected acquire still runs
       once locally rather than dropping the user's message silently. */
    await work(async () => true);
    return 'ran';
  }
  if (!acquired) return 'skipped';
  const stillOwner = async (): Promise<boolean> => {
    try {
      return await renewFlushClaim(userId, TAB_ID, Date.now());
    } catch {
      return false;
    }
  };
  try {
    await work(stillOwner);
    return 'ran';
  } finally {
    await releaseFlushClaim(userId, TAB_ID).catch(() => {});
  }
}

export interface FlushOwner {
  userId: string;
  /** Single-attempt transport owned by the mounted conversation screen. */
  deliver: (entry: OutboxEntry) => Promise<unknown>;
  /** False once the owner unmounted, logged out, or lost access. */
  isCurrent: () => boolean;
}

let owner: FlushOwner | null = null;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

function clearWakeTimer(): void {
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
}

/**
 * Attempt list for one flush pass: at most the first unresolved entry per
 * chat, in chronological order. A chat's walk stops at the first entry whose
 * acceptance is still unknown and not attemptable now (a transient retry
 * scheduled for the future, or an in-flight/resumed send handled elsewhere
 * this pass): newer inputs must not bypass it, so they wait for a later
 * wake instead of posting out of order. Entries with explicitly resolved
 * state are skipped without blocking — saved rows need nothing, and
 * permanent or exhausted failures stay failed until the user retries or
 * discards (a manual retry re-teaches kind to legacy rows). Entries already
 * attempted in the current pass block like unknown ones, so a pass always
 * terminates.
 *
 * Immediate user send/Retry enters through this same flush path (see
 * `send`): the echo, draft clear and follow stay instant, while network
 * acceptance dispatch joins the per-chat order and the shared claim — a
 * follow-up can never overtake a still-unacknowledged first POST.
 */
export function selectDueEntries(
  all: OutboxEntry[],
  nowMs: number,
  maxAttempts: number,
  attempted: Set<string> = new Set(),
): OutboxEntry[] {
  const byChat = new Map<string, OutboxEntry[]>();
  for (const entry of all) {
    const key = `${entry.workspaceId} ${entry.chatId ?? 'new'}`;
    const list = byChat.get(key);
    if (list) list.push(entry);
    else byChat.set(key, [entry]);
  }
  const picked: OutboxEntry[] = [];
  for (const list of byChat.values()) {
    list.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const entry of list) {
      // Exhausted entries belong to explicit user action now, never the loop.
      if (entry.attempts >= maxAttempts) continue;
      if (entry.state === 'saved') continue;
      // Permanent and legacy failures carry no deferral: resolved, skip.
      if (entry.state === 'failed' && entry.nextRetryAt === undefined) continue;
      if (attempted.has(entry.clientId)) break;
      // A transient retry scheduled for the future blocks its chat: newer
      // inputs wait rather than posting out of order.
      if (entry.state === 'failed' && Date.parse(entry.nextRetryAt as string) > nowMs) break;
      picked.push(entry);
      break;
    }
  }
  return picked.sort((left, right) => {
    const leftChat = `${left.workspaceId} ${left.chatId ?? ''}`;
    const rightChat = `${right.workspaceId} ${right.chatId ?? ''}`;
    return leftChat.localeCompare(rightChat) || left.createdAt.localeCompare(right.createdAt);
  });
}

async function runFlush(reason: string): Promise<void> {
  const active = owner;
  if (!active || !active.isCurrent()) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  // No global in-flight flag: a transport that never settles must never
  // wedge the owner. Same-UUID reentrancy is fenced by the per-UUID delivery
  // claim inside deliverEntry plus the per-pass attempted set below, and
  // cross-tab overlap by the shared claim — concurrent passes are safe and
  // each terminates.
  // Recompute after every delivery: successes unblock their chat's next
  // input within the same wake, while failures re-fence themselves.
  // Attempted UUIDs block like unknown ones, so a pass always terminates.
  const attempted = new Set<string>();
  for (;;) {
    const due = selectDueEntries(entriesForUser(active.userId), Date.now(), FLUSH_MAX_ATTEMPTS, attempted);
    if (due.length === 0 || owner !== active || !active.isCurrent()) break;
    debugLog('flush', 'starting', { reason, entries: due.length });
    const outcome = await withFlushLock(active.userId, async stillOwner => {
      let first = true;
      for (const entry of due) {
        if (owner !== active || !active.isCurrent()) return;
        // The first POST runs under the just-acquired claim; every later
        // one re-verifies live ownership first so an expired holder stops
        // instead of delivering alongside the tab that took over.
        if (!first && !(await stillOwner())) return;
        first = false;
        attempted.add(entry.clientId);
        await active.deliver(entry);
      }
    });
    if (outcome === 'skipped' || owner !== active || !active.isCurrent()) break;
  }
  if (owner !== active || !active.isCurrent()) return;
  // Schedule the earliest deferred retry; everything else wakes on events.
  // Timer delays stay capped even when a server instant runs longer: the
  // wake re-arms until the deferral is genuinely due.
  const pending = entriesForUser(active.userId)
    .filter(entry => entry.state === 'failed' && entry.nextRetryAt !== undefined)
    .map(entry => Date.parse(entry.nextRetryAt as string))
    .filter(value => Number.isFinite(value) && value > Date.now());
  if (pending.length > 0) {
    const delay = Math.min(FLUSH_BACKOFF_CAP_MS, Math.max(0, Math.min(...pending) - Date.now()));
    clearWakeTimer();
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      void requestFlush('timer');
    }, delay);
  }
  debugLog('flush', 'settled', { reason });
}

/** Wake the flush owner: mount, send, online, foreground, or timer. */
export function requestFlush(reason: string): void {
  if (!owner) return;
  void runFlush(reason);
}

function onOnline(): void {
  requestFlush('online');
}

function onVisibility(): void {
  if (typeof document !== 'undefined' && !document.hidden) requestFlush('foreground');
}

/** Mounts (or replaces) the single flush owner for this browser/account. */
export function registerFlushOwner(next: FlushOwner): void {
  if (owner) {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisibility);
    clearWakeTimer();
  }
  owner = next;
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisibility);
  requestFlush('mount');
}

/** Unmounts the flush owner: timers and listeners stop, no callback fires after. */
export function unregisterFlushOwner(userId: string): void {
  if (owner?.userId !== userId) return;
  owner = null;
  window.removeEventListener('online', onOnline);
  document.removeEventListener('visibilitychange', onVisibility);
  clearWakeTimer();
}

/** Test hook: forget registration and timers between cases. */
export function resetFlushForTests(): void {
  owner = null;
  clearWakeTimer();
  if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
}
