/** Verified fixes regression test: passing asserts correct resolved behavior. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isExplicitSentConfirmation, isExplicitStatusIntent } from '../../packages/agent/src/policy.js';
import { validateCreateTaskArgs, validateTaskDue, validateUpdateTaskArgs } from '../../packages/agent/src/tools.js';
import { handleCreateTask, handleUpdateTask } from '../../packages/ledger/src/commands/tasks.js';
import { handleRecordDraft } from '../../packages/ledger/src/commands/recordDraft.js';
import type { LedgerCommandContext, LedgerProjectionState, RecordDraftArgs } from '../../packages/ledger/src/types.js';
import { createOutboxEntry, markOutboxFailed, retryOutboxEntry, resetOutboxForTests } from '../../apps/web/src/api/outbox.js';
import { FLUSH_MAX_ATTEMPTS, selectDueEntries } from '../../apps/web/src/api/flush.js';
import { mergeActivity } from '../../apps/web/src/hooks/useActivityStream.js';
import type { PublicActivity } from '../../packages/contracts/src/index.js';

vi.mock('idb-keyval', () => ({
  get: vi.fn(async () => undefined), set: vi.fn(async () => undefined),
  del: vi.fn(async () => undefined), update: vi.fn(async () => undefined),
}));

const context: LedgerCommandContext = {
  workspace_id: 'audit-workspace', actor: { kind: 'member', user_id: 'audit-user' },
  membership_revision: 1, source_message_id: 'audit-message', request_id: 'audit-request',
  action_id: 'audit-action', expected_business_revision: 0, run_id: 'audit-run',
};
const empty = (): LedgerProjectionState => ({
  entities: new Map(), aliases: new Map(), fields: new Map(), tasks: new Map(),
  drafts: new Map(), memoryEntries: new Map(), memorySuppressions: new Map(),
});

afterEach(() => resetOutboxForTests());

describe('Sol audit — verified fixes regression test', () => {
  it('distinct live events with cursor zero collapse into the first event', () => {
    const first: PublicActivity = { schema_version: 1, id: 'audit-activity-1', cursor: 0, workspace_id: 'audit-workspace', chat_id: 'audit-chat', run_id: 'audit-run', created_at: '2026-10-05T00:00:00Z', type: 'text_chunk', payload: { text: 'First' } };
    const second = { ...first, id: 'audit-activity-2', payload: { text: 'Second' } };
    expect(mergeActivity(mergeActivity([], first), second)).toEqual([first]);
  });
  it.each(['Has Bistro signed?', 'If we signed, would it count as won?', 'The client asked: "Have we signed?"'])('status guard rejects non-affirmative statement: %s', text => {
    expect(isExplicitStatusIntent(text, 'won').isExplicit).toBe(false);
  });
  it('unsnooze-only request successfully parses with explicit null', () => {
    const validated = validateUpdateTaskArgs({ task_id: 'audit-task', snooze_until: null });
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.data.snooze_until).toBeNull();
  });

  it.each([
    { kind: 'date', local_date: '2026-02-31', timezone: 'Europe/Bucharest' },
    { kind: 'date', local_date: '2026-10-05', timezone: 'Mars/Olympus' },
    { kind: 'instant', at: '2026-10-05', timezone: 'Europe/Bucharest' },
  ])('deadline validator rejects invalid or underspecified value %j', due => {
    expect(validateTaskDue(due).ok).toBe(false);
  });

  it('task tool defaults omitted assignee to the acting member', () => {
    const validated = validateCreateTaskArgs({ title: 'My follow-up', explicit_no_deadline: true });
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error('Unexpected validator rejection');
    const result = handleCreateTask(context, empty(), 1, validated.data);
    const id = result.events[0]!.payload.task_id as string;
    expect(result.nextState!.tasks.get(id)!.assignee_user_id).toBe('audit-user');
  });

  it.each(['I have not sent it', 'Have you sent it?', 'They said: "I sent it"'])('sent guard rejects non-affirmative statement: %s', text => {
    expect(isExplicitSentConfirmation(text).isConfirmed).toBe(false);
  });

  it('manual retry after automatic cap resets attempt count and is picked up for delivery', () => {
    let entry = createOutboxEntry({ userId: 'audit-user', workspaceId: 'audit-workspace', chatId: 'audit-chat', text: 'Synthetic note' });
    for (let i = 0; i < FLUSH_MAX_ATTEMPTS; i++) entry = markOutboxFailed(entry.clientId, { code: 'transport', message: 'Synthetic transport failure' })!;
    const retried = retryOutboxEntry(entry.clientId)!;
    expect(retried.state).toBe('sending');
    expect(retried.attempts).toBe(0);
    const due = selectDueEntries([retried], Date.now(), FLUSH_MAX_ATTEMPTS);
    expect(due).toHaveLength(1);
    expect(due[0]!.clientId).toBe(entry.clientId);
  });

  it('done plus corrected title updates title and status together', () => {
    const created = handleCreateTask(context, empty(), 1, { title: 'Old title', explicit_no_deadline: true });
    const id = created.events[0]!.payload.task_id as string;
    const updated = handleUpdateTask(context, created.nextState!, 2, { task_id: id, status: 'done', title: 'Corrected title' });
    expect(updated.result.status).toBe('applied');
    expect(updated.nextState!.tasks.get(id)!.status).toBe('done');
    expect(updated.nextState!.tasks.get(id)!.title).toBe('Corrected title');
  });

  it('recipient-only draft edit updates recipient and preserves existing content', () => {
    const created = handleRecordDraft(context, empty(), 1, { draft_id: 'audit-draft', channel: 'whatsapp', content_text: 'Synthetic offer', recipient_address: 'synthetic-recipient' });
    const adapterArgs = { draft_id: 'audit-draft', content_text: undefined, recipient_address: 'replacement-recipient' } as unknown as RecordDraftArgs;
    const updated = handleRecordDraft(context, created.nextState!, 2, adapterArgs);
    expect(updated.result.status).toBe('applied');
    expect(updated.nextState!.drafts.get('audit-draft')!.recipient_address).toBe('replacement-recipient');
    expect(updated.nextState!.drafts.get('audit-draft')!.content_text).toBe('Synthetic offer');
  });

  it('content-only draft edit updates content and preserves existing recipient', () => {
    const created = handleRecordDraft(context, empty(), 1, { draft_id: 'audit-draft', channel: 'whatsapp', content_text: 'Synthetic offer', recipient_address: 'synthetic-recipient' });
    const adapterArgs = { draft_id: 'audit-draft', content_text: 'Short offer', recipient_address: undefined } as unknown as RecordDraftArgs;
    const updated = handleRecordDraft(context, created.nextState!, 2, adapterArgs);
    expect(updated.result.status).toBe('applied');
    expect(updated.nextState!.drafts.get('audit-draft')!.content_text).toBe('Short offer');
    expect(updated.nextState!.drafts.get('audit-draft')!.recipient_address).toBe('synthetic-recipient');
  });
});
