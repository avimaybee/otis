/**
 * Per-device question-panel state: which pending questions this browser has
 * already surfaced or deferred.
 *
 * Skip/close defers display without resolving the pending operation
 * (product.md section 6), but the pre-existing in-memory dismissal was
 * cleared on every chat open, so a skipped question auto-opened again on
 * every revisit. Persisting dismissed + already-surfaced ids per
 * user/workspace/chat keeps reopening quiet while the transcript's explicit
 * "Answer question" callout stays reachable, and a genuinely new arrival
 * still opens once.
 *
 * Storage is best-effort local state, never business truth: every helper
 * no-ops when storage is unavailable and caps stored ids.
 */

export type QuestionStateKind = 'dismissed' | 'seen';

export const QUESTION_STATE_LIMIT = 100;

const PREFIX = 'otis:questions';

export function questionStateKey(
  kind: QuestionStateKind,
  userId: string,
  workspaceId: string,
  chatId: string,
): string {
  return `${PREFIX}:${kind}:${encodeURIComponent(userId)}/${encodeURIComponent(workspaceId)}/${encodeURIComponent(chatId)}`;
}

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & {
  readonly length?: number;
  key?: (index: number) => string | null;
};

function storageOf(): WritableStorage | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    return localStorage;
  } catch {
    return undefined;
  }
}

export function readStoredQuestionIds(
  storage: ReadableStorage | null | undefined,
  key: string,
  limit: number = QUESTION_STATE_LIMIT,
): string[] {
  if (!storage || !key) return [];
  let raw: string | null = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids: string[] = [];
    for (const item of parsed) {
      if (typeof item === 'string' && item !== '' && !ids.includes(item)) ids.push(item);
      if (ids.length >= limit) break;
    }
    return ids;
  } catch {
    return [];
  }
}

export function writeStoredQuestionIds(
  storage: WritableStorage | null | undefined,
  key: string,
  ids: readonly string[],
  limit: number = QUESTION_STATE_LIMIT,
): void {
  if (!storage || !key) return;
  try {
    const bounded = [...new Set(ids.filter(id => typeof id === 'string' && id !== ''))].slice(0, limit);
    if (bounded.length === 0) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify(bounded));
  } catch {
    /* Best-effort local state; the mounted component stays usable. */
  }
}

export function addStoredQuestionId(
  storage: WritableStorage | null | undefined,
  key: string,
  id: string,
  limit: number = QUESTION_STATE_LIMIT,
): string[] {
  const current = readStoredQuestionIds(storage, key, limit);
  if (current.includes(id)) return current;
  const next = [...current, id].slice(-limit);
  writeStoredQuestionIds(storage, key, next, limit);
  return next;
}

/**
 * Drops stored ids that are no longer pending so deferred/seen state cannot
 * grow without bound across resolved questions.
 */
export function pruneStoredQuestionIds(
  stored: readonly string[],
  pendingIds: readonly string[],
  limit: number = QUESTION_STATE_LIMIT,
): string[] {
  const pending = new Set(pendingIds);
  return stored.filter(id => pending.has(id)).slice(0, limit);
}

export function clearUserQuestionState(
  storage: WritableStorage | null | undefined,
  userId: string,
): void {
  if (!storage || !userId) return;
  try {
    const encoded = encodeURIComponent(userId);
    const keys: string[] = [];
    const length = typeof storage.length === 'number' ? storage.length : 0;
    if (typeof storage.key === 'function' && length > 0) {
      for (let i = 0; i < length; i++) {
        const key = storage.key(i);
        if (key && key.startsWith(`${PREFIX}:`) && key.includes(`:${encoded}/`)) keys.push(key);
      }
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* Best-effort. */
  }
}

export interface AutoOpenQuestion {
  id: string;
  status: string;
  answerable_by_caller: boolean;
}

/**
 * Picks the question to auto-open, if any. An already-open panel never
 * switches underneath; dismissed, in-session-known and already-surfaced
 * questions never re-open. The latest remaining fresh question wins.
 */
export function selectAutoOpenQuestion(
  questions: readonly AutoOpenQuestion[],
  replyId: string | null,
  dismissedIds: readonly string[],
  knownIds: ReadonlySet<string>,
  seenIds: readonly string[],
): AutoOpenQuestion | undefined {
  if (replyId !== null) return undefined;
  const dismissed = new Set(dismissedIds);
  const seen = new Set(seenIds);
  let latest: AutoOpenQuestion | undefined;
  for (const question of questions) {
    if (question.status !== 'pending' || !question.answerable_by_caller) continue;
    if (dismissed.has(question.id) || knownIds.has(question.id) || seen.has(question.id)) continue;
    latest = question;
  }
  return latest;
}

export function readQuestionState(
  kind: QuestionStateKind,
  userId: string,
  workspaceId: string,
  chatId: string | null,
): string[] {
  if (!chatId) return [];
  return readStoredQuestionIds(storageOf(), questionStateKey(kind, userId, workspaceId, chatId));
}

export function persistQuestionState(
  kind: QuestionStateKind,
  userId: string,
  workspaceId: string,
  chatId: string | null,
  ids: readonly string[],
): void {
  if (!chatId) return;
  writeStoredQuestionIds(storageOf(), questionStateKey(kind, userId, workspaceId, chatId), ids);
}

export function clearCurrentUserQuestionState(userId: string): void {
  clearUserQuestionState(storageOf(), userId);
}
