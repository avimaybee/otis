/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import {
  addStoredQuestionId,
  clearUserQuestionState,
  pruneStoredQuestionIds,
  questionStateKey,
  readStoredQuestionIds,
  selectAutoOpenQuestion,
  writeStoredQuestionIds,
  type AutoOpenQuestion,
} from '../src/api/questionState.js';

function memoryStorage(values: Record<string, string> = {}): Storage {
  const store = { ...values };
  return {
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
    getItem: (key: string) => (key in store ? store[key]! : null),
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const key of Object.keys(store)) delete store[key];
    },
  } as Storage;
}

const q = (id: string): AutoOpenQuestion => ({ id, status: 'pending', answerable_by_caller: true });

describe('question panel persistence', () => {
  it('scopes storage keys per user, workspace and chat', () => {
    expect(questionStateKey('dismissed', 'u1', 'ws', 'chat')).not.toBe(
      questionStateKey('dismissed', 'u2', 'ws', 'chat'),
    );
    expect(questionStateKey('dismissed', 'u1', 'ws', 'chat')).not.toBe(
      questionStateKey('dismissed', 'u1', 'ws', 'other'),
    );
    expect(questionStateKey('dismissed', 'u1', 'ws', 'chat')).not.toBe(
      questionStateKey('seen', 'u1', 'ws', 'chat'),
    );
  });

  it('reads only bounded string ids and tolerates corrupt storage', () => {
    const storage = memoryStorage({ k: '["qa","qb","qa","",42]' });
    expect(readStoredQuestionIds(storage, 'k')).toEqual(['qa', 'qb']);
    expect(readStoredQuestionIds(memoryStorage({ k: 'not-json' }), 'k')).toEqual([]);
    expect(readStoredQuestionIds(memoryStorage({ k: '{"a":1}' }), 'k')).toEqual([]);
    expect(readStoredQuestionIds(null, 'k')).toEqual([]);
  });

  it('adds without duplicates and prunes resolved questions', () => {
    const storage = memoryStorage();
    expect(addStoredQuestionId(storage, 'dismissed', 'qa')).toEqual(['qa']);
    expect(addStoredQuestionId(storage, 'dismissed', 'qa')).toEqual(['qa']);
    writeStoredQuestionIds(storage, 'dismissed', ['qa', 'qb', 'resolved-old']);
    expect(pruneStoredQuestionIds(readStoredQuestionIds(storage, 'dismissed'), ['qa', 'qb'])).toEqual([
      'qa',
      'qb',
    ]);
  });

  it('clears only the signed-in account on session loss', () => {
    const storage = memoryStorage();
    writeStoredQuestionIds(storage, questionStateKey('dismissed', 'u1', 'ws', 'chat'), ['qa']);
    writeStoredQuestionIds(storage, questionStateKey('seen', 'u2', 'ws', 'chat'), ['qb']);
    clearUserQuestionState(storage, 'u1');
    expect(readStoredQuestionIds(storage, questionStateKey('dismissed', 'u1', 'ws', 'chat'))).toEqual([]);
    expect(readStoredQuestionIds(storage, questionStateKey('seen', 'u2', 'ws', 'chat'))).toEqual(['qb']);
  });

  it('auto-opens the latest fresh question once, then stays quiet on revisit', () => {
    const questions = [q('qa'), q('qb')];
    const known = new Set<string>();
    // First open: latest fresh question opens.
    expect(selectAutoOpenQuestion(questions, null, [], known, [])?.id).toBe('qb');
    // Revisit after surfacing: seen suppresses every pending question.
    expect(selectAutoOpenQuestion(questions, null, [], known, ['qa', 'qb'])).toBeUndefined();
    // Skip defers: dismissed never re-opens.
    expect(selectAutoOpenQuestion(questions, null, ['qa', 'qb'], known, [])).toBeUndefined();
    // An open panel never switches underneath a new arrival.
    expect(selectAutoOpenQuestion([...questions, q('qc')], 'qa', [], known, [])).toBeUndefined();
    // Skipping one of two leaves the other openable in-session.
    expect(selectAutoOpenQuestion(questions, null, ['qa'], known, [])?.id).toBe('qb');
  });
});
