/**
 * Scoped recoverable persistence for records drafts (R16 Slice C).
 * Keyed by (user, workspace, list) so drafts never leak across scopes.
 * Synchronous localStorage backend with in-memory fallback: storage failure
 * leaves memory editing usable and the caller reports limited recovery.
 * Whole-owner purge (logout, account change, revocation) clears every key
 * the owner generation fenced.
 */

export interface PersistedRecordsDraft {
  draftId: string;
  generation: number;
  baseRevision: number;
  operations: unknown[];
  updatedAt: string;
}

const KEY_PREFIX = 'otis:records-draft:';

function scopeKey(userId: string, workspaceId: string, listId: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}:${encodeURIComponent(listId)}`;
}

function memoryBackend(): { get: (k: string) => string | null; set: (k: string, v: string) => void; remove: (k: string) => void; keys: () => string[] } {
  const store = new Map<string, string>();
  return {
    get: (k) => store.get(k) ?? null,
    set: (k, v) => { store.set(k, v); },
    remove: (k) => { store.delete(k); },
    keys: () => [...store.keys()],
  };
}

function storageBackend() {
  try {
    if (typeof localStorage === 'undefined') return { backend: memoryBackend(), durable: false };
    const probe = `${KEY_PREFIX}probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return {
      durable: true,
      backend: {
        get: (k: string) => localStorage.getItem(k),
        set: (k: string, v: string) => localStorage.setItem(k, v),
        remove: (k: string) => localStorage.removeItem(k),
        keys: () => {
          const out: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(KEY_PREFIX)) out.push(key);
          }
          return out;
        },
      },
    };
  } catch {
    return { backend: memoryBackend(), durable: false };
  }
}

const { backend, durable } = storageBackend();

/** False when persistence fell back to memory (recovery limited to this tab). */
export function isRecordsDraftDurable(): boolean {
  return durable;
}

export function loadRecordsDraft(userId: string, workspaceId: string, listId: string): PersistedRecordsDraft | null {
  try {
    const raw = backend.get(scopeKey(userId, workspaceId, listId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedRecordsDraft>;
    if (!parsed || typeof parsed.draftId !== 'string' || !Array.isArray(parsed.operations)) return null;
    return {
      draftId: parsed.draftId,
      generation: typeof parsed.generation === 'number' ? parsed.generation : 0,
      baseRevision: typeof parsed.baseRevision === 'number' ? parsed.baseRevision : -1,
      operations: parsed.operations,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function storeRecordsDraft(
  userId: string,
  workspaceId: string,
  listId: string,
  draft: Omit<PersistedRecordsDraft, 'updatedAt'>,
): void {
  try {
    backend.set(
      scopeKey(userId, workspaceId, listId),
      JSON.stringify({ ...draft, updatedAt: new Date().toISOString() }),
    );
  } catch {
    // Memory editing stays usable; recovery is limited to this session.
  }
}

export function clearRecordsDraft(userId: string, workspaceId: string, listId: string): void {
  try {
    backend.remove(scopeKey(userId, workspaceId, listId));
  } catch {
    // Best effort; the draft simply stays until overwritten.
  }
}

/** Whole-owner purge: logout, account change, and revocation clear every records draft. */
export function purgeRecordsDraftsForUser(userId: string): void {
  try {
    const needle = `${KEY_PREFIX}${encodeURIComponent(userId)}:`;
    for (const key of backend.keys()) {
      if (key.startsWith(needle)) backend.remove(key);
    }
  } catch {
    // Best effort during teardown.
  }
}
