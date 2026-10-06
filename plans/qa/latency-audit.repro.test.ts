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
  const db = {
    prepare(sql: string) {
      const statement = {
        bind: (..._args: unknown[]) => statement,
        async first() { calls.push(sql); const value = rowsFor(sql); return Array.isArray(value) ? value[0] ?? null : value; },
        async all() { calls.push(sql); return { results: rowsFor(sql) }; },
      };
      return statement;
    },
    async batch(statements: unknown[]) {
      calls.push(`BATCH ${statements.length}`);
      return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
    },
  };
  return { calls, db: db as unknown as D1Database };
}

describe('Latency audit: current behavior reproductions, not desired behavior', () => {
  it('a token just after an interval tick can wait 799ms for publication', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1);
    const publish = vi.fn<StreamPublishFn>(async () => undefined);
    const publisher = new StreamPublisher(publish, 0, 'gemini');
    publisher.pushText('Hi');
    await publisher.tick(400);
    expect(publish).not.toHaveBeenCalled();
    await publisher.tick(800);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[1]).toBe('text_chunk');
    await publisher.close('complete');
  });

  it('one text chunk has three sequential database calls before broadcast', async () => {
    let cursorReads = 0;
    const { calls, db } = recordingDb(() => ++cursorReads === 1 ? null : { cursor: 1 });
    const received = vi.fn(() => expect(calls).toHaveLength(3));
    const unsubscribe = liveChatBus.subscribe('audit-ws', 'audit-chat', received);
    try {
      await publishAgentActivity({ db, workspaceId: 'audit-ws', chatId: 'audit-chat', runId: 'audit-run' } as never,
        'text0', 'text_chunk', { text: 'Hi' });
      expect(calls[1]).toBe('BATCH 2');
      expect(received).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
  });

  it('greeting context executes 11 reads and can crowd out relevant memory', async () => {
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
    expect(calls).toHaveLength(11);
    expect(calls.some(sql => sql === 'SELECT id, name FROM entities WHERE workspace_id = ?')).toBe(true);
    expect(context.activeNotes).toHaveLength(12);
    expect(context.activeNotes.some(note => note.id.startsWith('relevant-'))).toBe(false);
  });

  it('ordinary projection load queries seven complete tables', async () => {
    const { calls, db } = recordingDb();
    await getWorkspaceProjectionState(db, 'audit-ws');
    expect(calls).toHaveLength(7);
    expect(calls.every(sql => !/\bLIMIT\b/.test(sql))).toBe(true);
  });

  it('a 50-run chat snapshot issues 54 API calls', async () => {
    vi.spyOn(api, 'getChat').mockResolvedValue({ chat: { id: 'audit-chat' } } as never);
    vi.spyOn(api, 'listMessages').mockResolvedValue({
      messages: Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, run_id: `r${i}`, sequence: i })),
      next_before_sequence: null,
    } as never);
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] } as never);
    const runs = vi.spyOn(api, 'run').mockImplementation(async (_ws, id) => ({
      run: { id }, activities: [], steps: [], actions: [],
    } as never));
    await fetchChatSnapshot('audit-ws', 'audit-chat');
    expect(runs).toHaveBeenCalledTimes(50);
    expect([api.getChat, api.listMessages, api.activity, api.clarifications]
      .reduce((count, method) => count + vi.mocked(method).mock.calls.length, runs.mock.calls.length)).toBe(54);
  });
});
