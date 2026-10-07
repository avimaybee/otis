import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamPublisher, type StreamPublishFn } from '../../apps/worker/src/agent/streamPublish.js';
import { publishAgentActivity } from '../../apps/worker/src/agent/activity.js';
import { liveChatBus } from '../../apps/worker/src/chat/liveBus.js';
import { getTurnContext } from '../../apps/worker/src/agent/context.js';
import { getWorkspaceProjectionState } from '../../packages/ledger/src/repository/queries.js';
import { fetchChatSnapshot } from '../../apps/web/src/api/snapshot.js';
import { api } from '../../apps/web/src/api/client.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function recordingDb(rowsFor: (sql: string) => unknown = () => []) {
  const calls: string[] = [];
  const toRows = (sql: string): unknown[] => {
    const value = rowsFor(sql);
    return Array.isArray(value) ? value : value ? [value] : [];
  };
  const db = {
    prepare(sql: string) {
      const statement = {
        __sql: sql,
        bind: (..._args: unknown[]) => statement,
        async first() { calls.push(sql); return toRows(sql)[0] ?? null; },
        async all() { calls.push(sql); return { results: toRows(sql) }; },
      };
      return statement;
    },
    async batch(statements: Array<{ __sql?: string }>) {
      calls.push(`BATCH ${statements.length}`);
      return statements.map((item) => {
        const sql = typeof item?.__sql === 'string' ? item.__sql : '';
        return { success: true, results: toRows(sql), meta: { changes: 1 } };
      });
    },
  };
  return { calls, db: db as unknown as D1Database };
}

describe('Latency audit: fixed behavior (reproductions now prove the cures)', () => {
  it('first preview flushes on the short cadence, not a fixed 400ms tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1);
    const publish = vi.fn<StreamPublishFn>(async () => undefined);
    const publisher = new StreamPublisher(publish, 0, 'gemini');
    publisher.pushText('Hi');
    await publisher.tick(400);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[1]).toBe('text_chunk');
    await publisher.close('complete');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('one text chunk persists in a single atomic batch before broadcast', async () => {
    const { calls, db } = recordingDb(sql => (sql.startsWith('INSERT INTO run_activity') ? { cursor: 7 } : []));
    const received = vi.fn(() => undefined);
    const unsubscribe = liveChatBus.subscribe('audit-ws', 'audit-chat', received);
    try {
      await publishAgentActivity({ db, workspaceId: 'audit-ws', chatId: 'audit-chat', runId: 'audit-run' } as never,
        'text0', 'text_chunk', { text: 'Hi' });
      expect(calls).toEqual(['BATCH 2']);
      expect(received).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
  });

  it('greeting context batches independent reads; the note cap still applies first', async () => {
    const note = (id: string, scope = 'workspace') => ({
      id, scope, subject_id: scope === 'workspace' ? null : 'audit-user',
      category: 'other', content: id, observed_at: '2026-10-06T00:00:00Z', business_revision: 1,
    });
    const { calls, db } = recordingDb(sql => {
      if (sql.includes('SELECT name, business_revision')) return { name: 'Audit', business_revision: 1 };
      if (sql.includes("scope = 'workspace' AND status")) return Array.from({ length: 12 }, (_, i) => note(`general-${i}`));
      if (sql.includes("scope = 'member_in_workspace'")) return [note('relevant-member', 'member_in_workspace')];
      if (sql.includes('memory_entries_fts fts')) return [note('relevant-search')];
      return [];
    });
    const context = await getTurnContext(db, {
      workspaceId: 'audit-ws', actorUserId: 'audit-user', chatId: 'audit-chat', sourceText: 'hi',
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.startsWith('BATCH')).toBe(true);
    expect(calls.slice(1).every(sql => sql.includes('memory_entries_fts') || sql.includes('FROM briefs'))).toBe(true);
    expect(context.activeNotes).toHaveLength(12);
    // Tiered ranking surfaces the matching member and search notes first
    // instead of crowding them out behind general notes.
    expect(context.activeNotes.some(note => note.id.startsWith('relevant-'))).toBe(true);
  });

  it('ordinary projection load batches the seven tables into two roundtrips', async () => {
    const { calls, db } = recordingDb();
    await getWorkspaceProjectionState(db, 'audit-ws');
    expect(calls).toEqual(['BATCH 5', 'BATCH 2']);
    expect(calls.every(sql => !/\bLIMIT\b/.test(sql))).toBe(true);
  });

  it('a 50-run chat snapshot issues 5 API calls: 4 parallel plus one batched run page', async () => {
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: { id: 'audit-chat' } } as never);
    vi.spyOn(api, 'listMessages').mockResolvedValue({
      messages: Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, run_id: `r${i}`, sequence: i })),
      next_before_sequence: null,
    } as never);
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] } as never);
    const batched = vi.spyOn(api, 'runs').mockImplementation(async (_ws, ids) => ({
      runs: ids.map((id) => ({ run: { id }, activities: [], steps: [], actions: [] })),
    } as never));
    const snapshot = await fetchChatSnapshot('audit-ws', 'audit-chat');
    expect(batched).toHaveBeenCalledTimes(1);
    expect(batched).toHaveBeenCalledWith('audit-ws', expect.arrayContaining(['r0', 'r49']));
    expect(Object.keys(snapshot.runs)).toHaveLength(50);
    expect([api.getChat, api.listMessages, api.activity, api.clarifications, api.runs]
      .reduce((count, method) => count + vi.mocked(method).mock.calls.length, 0)).toBe(5);
  });
});
