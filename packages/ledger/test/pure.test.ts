import { describe, it, expect } from 'vitest';
import {
  assertEventInvariant,
  handleCreateEntity,
  handleDeleteEntity,
  handleRenameEntity,
  handleAddAlias,
  handleSetField,
  handleSetFields,
  normalizeStatusResumeAnswer,
  handleLogEvent,
  handleReviseInteraction,
  handleRemoveInteraction,
  handleCreateTask,
  handleRememberContext,
  handleUpdateTask,
  handleResolveConflict,
  computeUndoPreview,
  handleUndoCommit,
  rebuildProjections,
  formatQuoteText,
  type LedgerCommandContext,
  type LedgerProjectionState,
} from '../src/index.js';
import type { ActionReceipt, LedgerEvent } from '@otis/contracts';

describe('Ledger Invariants & Pure Reducers', () => {
  const dummyContext: LedgerCommandContext = {
    workspace_id: 'ws-test',
    actor: { kind: 'member', user_id: 'usr-avi' },
    membership_revision: 1,
    source_message_id: 'msg-101',
    request_id: 'req-1',
    action_id: 'act-1',
    expected_business_revision: 0,
    run_id: 'run-1',
  };

  const emptyState: LedgerProjectionState = {
    entities: new Map(),
    aliases: new Map(),
    fields: new Map(),
    tasks: new Map(),
    drafts: new Map(),
  };

  describe('assertEventInvariant', () => {
    it('enforces that an event must have exactly one source reference (message or job)', () => {
      const validMessageEvent: LedgerEvent = {
        id: 'evt-1',
        workspace_id: 'ws-kerning',
        sequence: 1,
        actor_kind: 'member',
        actor_user_id: 'usr-hunor',
        kind: 'visit',
        schema_version: 1,
        payload: { summary: 'Pitched restaurant 2', contact_made: true },
        occurred_at: '2026-09-29T10:00:00Z',
        recorded_at: '2026-09-29T10:00:02Z',
        channel: 'telegram',
        source_message_id: 'msg-101',
        action_id: 'act-1',
        provenance: 'stated',
        created_at: '2026-09-29T10:00:02Z',
      };

      expect(assertEventInvariant(validMessageEvent)).toBe(true);

      const invalidDualSourceEvent: LedgerEvent = {
        ...validMessageEvent,
        source_job_id: 'job-brief-1',
      };
      expect(assertEventInvariant(invalidDualSourceEvent)).toBe(false);

      const invalidNoSourceEvent: LedgerEvent = {
        ...validMessageEvent,
        source_message_id: undefined,
        source_job_id: undefined,
      };
      expect(assertEventInvariant(invalidNoSourceEvent)).toBe(false);
    });

    it('enforces that system job events must use channel="system"', () => {
      const jobEvent: LedgerEvent = {
        id: 'evt-job',
        workspace_id: 'ws-kerning',
        sequence: 2,
        actor_kind: 'system',
        actor_job_id: 'job-sweep-1',
        kind: 'note',
        schema_version: 1,
        payload: { text: 'Automated note' },
        occurred_at: '2026-09-29T10:00:00Z',
        recorded_at: '2026-09-29T10:00:02Z',
        channel: 'system',
        source_job_id: 'job-sweep-1',
        action_id: 'act-sys',
        provenance: 'stated',
        created_at: '2026-09-29T10:00:02Z',
      };
      expect(assertEventInvariant(jobEvent)).toBe(true);

      const invalidJobChannel: LedgerEvent = {
        ...jobEvent,
        channel: 'web',
      };
      expect(assertEventInvariant(invalidJobChannel)).toBe(false);
    });
  });

  describe('create_entity & duplicate detection', () => {
    it('creates an entity with neutral "new" status and saves original name as alias', () => {
      const { result, events, nextState } = handleCreateEntity(dummyContext, emptyState, 1, {
        name: 'Bistro Central',
      });

      expect(result.status).toBe('applied');
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe('entity_created');
      expect(events[0]!.payload).toMatchObject({
        name: 'Bistro Central',
        initial_status: 'new',
      });

      expect(nextState?.entities.size).toBe(1);
      const entity = nextState!.entities.get(events[0]!.entity_id!)!;
      expect(entity.name).toBe('Bistro Central');
      expect(entity.status).toBe('new');

      expect(nextState?.aliases.has('ws-test:bistro central')).toBe(true);
    });

    it('returns already_applied on exact duplicate entity name', () => {
      const { nextState } = handleCreateEntity(dummyContext, emptyState, 1, {
        name: 'Bistro Central',
      });

      const dup = handleCreateEntity(dummyContext, nextState!, 2, {
        name: 'bistro central',
      });
      expect(dup.result.status).toBe('already_applied');
      expect(dup.events).toHaveLength(0);
    });

    it('returns needs_clarification on near-duplicate entity name', () => {
      const { nextState } = handleCreateEntity(dummyContext, emptyState, 1, {
        name: 'Bistro Central',
      });

      const near = handleCreateEntity(dummyContext, nextState!, 2, {
        name: 'Le Bistro Central',
      });
      expect(near.result.status).toBe('needs_clarification');
      expect(near.result.summary).toContain('Possible duplicate entity found');
      expect(near.events).toHaveLength(0);
    });
  });

  describe('rename_entity & add_alias', () => {
    it('renames an entity, updates current name, and preserves former name as alias', () => {
      const { events: [createdEvt], nextState: state1 } = handleCreateEntity(
        dummyContext,
        emptyState,
        1,
        { name: 'Old Bistro' },
      );

      const entityId = createdEvt!.entity_id!;
      const rename = handleRenameEntity(dummyContext, state1!, 2, {
        entity_id: entityId,
        new_name: 'New Bistro',
      });

      expect(rename.result.status).toBe('applied');
      const updatedEntity = rename.nextState!.entities.get(entityId)!;
      expect(updatedEntity.name).toBe('New Bistro');

      // Both names exist as aliases
      expect(rename.nextState!.aliases.has('ws-test:old bistro')).toBe(true);
      expect(rename.nextState!.aliases.has('ws-test:new bistro')).toBe(true);
    });

    it('rejects name collisions when renaming or adding alias', () => {
      const { nextState: s1 } = handleCreateEntity(dummyContext, emptyState, 1, {
        name: 'Entity Alpha',
      });
      const { events: [e2], nextState: s2 } = handleCreateEntity(dummyContext, s1!, 2, {
        name: 'Entity Beta',
      });

      const renameConflict = handleRenameEntity(dummyContext, s2!, 3, {
        entity_id: e2!.entity_id!,
        new_name: 'Entity Alpha',
      });
      expect(renameConflict.result.status).toBe('conflict');

      const aliasConflict = handleAddAlias(dummyContext, s2!, 3, {
        entity_id: e2!.entity_id!,
        alias: 'Entity Alpha',
      });
      expect(aliasConflict.result.status).toBe('conflict');
    });
  });

  describe('lead status and missing-deadline clarification rules', () => {
    it('asks clarification when status change is inferred from sentiment (no silent mutation)', () => {
      const { events: [e1], nextState: s1 } = handleCreateEntity(dummyContext, emptyState, 1, {
        name: 'Client Alpha',
      });

      const inferred = handleSetField(dummyContext, s1!, 2, {
        entity_id: e1!.entity_id!,
        field_name: 'status',
        value: 'warm',
        provenance: 'inferred',
      });

      expect(inferred.result.status).toBe('needs_clarification');
      expect(inferred.result.summary).toContain('requires member confirmation before mutation');
      expect(inferred.events).toHaveLength(0);
    });

    it('asks clarification when status is "closed" (ambiguous between won and lost)', () => {
      const { events: [e1], nextState: s1 } = handleCreateEntity(dummyContext, emptyState, 1, {
        name: 'Client Alpha',
      });

      const closed = handleSetField(dummyContext, s1!, 2, {
        entity_id: e1!.entity_id!,
        field_name: 'status',
        value: 'closed',
        provenance: 'stated',
      });

      expect(closed.result.status).toBe('needs_clarification');
      expect(closed.result.summary).toContain("'Closed' is ambiguous between won and lost");
      expect(closed.events).toHaveLength(0);
    });

    it('saves explicit status changes directly without asking', () => {
      const { events: [e1], nextState: s1 } = handleCreateEntity(dummyContext, emptyState, 1, {
        name: 'Client Alpha',
      });

      const explicit = handleSetField(dummyContext, s1!, 2, {
        entity_id: e1!.entity_id!,
        field_name: 'status',
        value: 'warm',
        provenance: 'stated',
      });

      expect(explicit.result.status).toBe('applied');
      expect(explicit.events).toHaveLength(1);
      expect(explicit.nextState!.entities.get(e1!.entity_id!)!.status).toBe('warm');
    });

    it('asks clarification when task has no due date and no explicit no-deadline instruction (never assigns today)', () => {
      const missingDue = handleCreateTask(dummyContext, emptyState, 1, {
        title: 'Send Bistro the offer',
      });

      expect(missingDue.result.status).toBe('needs_clarification');
      expect(missingDue.result.summary).toContain('Missing deadline for task');
      expect(missingDue.events).toHaveLength(0);
    });

    it('creates task with due = null when explicit_no_deadline is true', () => {
      const noDeadline = handleCreateTask(dummyContext, emptyState, 1, {
        title: 'Background research',
        explicit_no_deadline: true,
      });

      expect(noDeadline.result.status).toBe('applied');
      expect(noDeadline.events).toHaveLength(1);
      const taskId = noDeadline.events[0]!.payload.task_id;
      const task = noDeadline.nextState!.tasks.get(taskId)!;
      expect(task.title).toBe('Background research');
      expect(task.due_kind).toBeNull();
      expect(task.assignee_user_id).toBe('usr-avi'); // defaults to member author
    });

    it('snoozing a task changes notification instant without overwriting due date', () => {
      const created = handleCreateTask(dummyContext, emptyState, 1, {
        title: 'Review proposal',
        due: { kind: 'date', local_date: '2026-10-05', timezone: 'Europe/Bucharest' },
      });

      const taskId = created.events[0]!.payload.task_id;
      const snoozeInstant = '2026-10-04T12:00:00Z';

      const updated = handleUpdateTask(dummyContext, created.nextState!, 2, {
        task_id: taskId,
        snooze_until: snoozeInstant,
      });

      expect(updated.result.status).toBe('applied');
      const task = updated.nextState!.tasks.get(taskId)!;
      expect(task.due_local_date).toBe('2026-10-05'); // Due date preserved!
      expect(task.snooze_until).toBe(snoozeInstant);
    });
  });

  describe('atomic field batches (set_fields)', () => {
    const batchContext: LedgerCommandContext = {
      ...dummyContext,
      action_id: 'act-batch-1',
    };
    function seededState() {
      const { events: [e1], nextState: s1 } = handleCreateEntity(dummyContext, emptyState, 1, {
        name: 'Client Batch',
      });
      return { entityId: e1!.entity_id!, state: s1! };
    }

    it('commits several ready fields with consecutive sequences under one parent action', () => {
      const { entityId, state } = seededState();
      const res = handleSetFields(batchContext, state, 2, {
        entity_id: entityId,
        fields: [
          { field_name: 'phone', value: '+40123456789' },
          { field_name: 'preferred_language', value: 'ro' },
        ],
      });
      expect(res.result.status).toBe('applied');
      expect(res.events).toHaveLength(2);
      expect(res.events[0]!.sequence).toBe(2);
      expect(res.events[1]!.sequence).toBe(3);
      for (const e of res.events) expect(e.action_id).toBe('act-batch-1');
      expect(res.actionCost).toBe(2);
      expect(res.result.data).toMatchObject({ entity_id: entityId, applied_fields: ['phone', 'preferred_language'] });
      expect(res.nextState!.fields.get(`${entityId}:phone`)).toBeTruthy();
    });

    it('collapses exact repeats and rejects conflicting duplicates with no commit', () => {
      const { entityId, state } = seededState();
      const collapsed = handleSetFields(batchContext, state, 2, {
        entity_id: entityId,
        fields: [
          { field_name: 'phone', value: '+40123456789' },
          { field_name: 'phone', value: '+40123456789', provenance: 'stated' },
        ],
      });
      expect(collapsed.result.status).toBe('applied');
      expect(collapsed.events).toHaveLength(1);

      const conflicted = handleSetFields(batchContext, state, 2, {
        entity_id: entityId,
        fields: [
          { field_name: 'phone', value: '+40123456789' },
          { field_name: 'phone', value: '+40987654321' },
        ],
      });
      expect(conflicted.result.status).toBe('rejected');
      expect(conflicted.result.error?.code).toBe('conflicting_fields');
      expect(conflicted.events).toHaveLength(0);
      expect(conflicted.nextState).toBeUndefined();
    });

    it('saves ready facts while parking only the uncertain status (mixed commit)', () => {
      const { entityId, state } = seededState();
      const res = handleSetFields(batchContext, state, 2, {
        entity_id: entityId,
        fields: [
          { field_name: 'phone', value: '+40123456789' },
          { field_name: 'status', value: 'warm', provenance: 'inferred' },
        ],
      });
      expect(res.result.status).toBe('applied');
      expect(res.events).toHaveLength(1);
      expect(res.events[0]!.kind).toBe('field_change');
      expect(res.actionCost).toBe(1);
      expect(res.result.clarification?.missing_fields).toEqual(['status_confirmation']);
      const op = res.result.clarification?.pending_operation;
      expect(op?.command_name).toBe('set_field');
      expect(op?.args).toMatchObject({ entity_id: entityId, field_name: 'status', value: 'warm' });
      expect(op?.args).not.toHaveProperty('phone');
      expect(res.result.data?.pending_field).toEqual({ field_name: 'status', value: 'warm' });
      expect(res.result.data?.applied_fields).toEqual(['phone']);
      // The ready fact committed; the status did not.
      expect(res.nextState!.fields.get(`${entityId}:phone`)).toBeTruthy();
    });

    it('applies an explicitly instructed status together with the ready facts', () => {
      const { entityId, state } = seededState();
      const res = handleSetFields(batchContext, state, 2, {
        entity_id: entityId,
        fields: [
          { field_name: 'phone', value: '+40123456789' },
          { field_name: 'status', value: 'warm' },
        ],
        explicit_status_indexes: [1],
      });
      expect(res.result.status).toBe('applied');
      expect(res.events).toHaveLength(2);
      expect(res.events[1]!.kind).toBe('status_change');
      expect(res.result.clarification).toBeUndefined();
      expect(res.nextState!.entities.get(entityId)!.status).toBe('warm');
    });

    it('parks a lone uncertain status as needs_clarification with a single-status operation', () => {
      const { entityId, state } = seededState();
      const res = handleSetFields(batchContext, state, 2, {
        entity_id: entityId,
        fields: [{ field_name: 'status', value: 'warm', provenance: 'inferred' }],
      });
      expect(res.result.status).toBe('needs_clarification');
      expect(res.events).toHaveLength(0);
      expect(res.result.clarification?.pending_operation?.command_name).toBe('set_field');
      expect(res.result.clarification?.pending_operation?.args).toEqual({
        entity_id: entityId,
        field_name: 'status',
        value: 'warm',
      });
    });

    it('rejects invalid status, unknown entity and disallowed fields without effects', () => {
      const { entityId, state } = seededState();
      const invalid = handleSetFields(batchContext, state, 2, {
        entity_id: entityId,
        fields: [{ field_name: 'status', value: 'frozen' }],
      });
      expect(invalid.result.status).toBe('rejected');
      expect(invalid.result.error?.code).toBe('invalid_status');

      const missing = handleSetFields(batchContext, state, 2, {
        entity_id: 'ent-nope',
        fields: [{ field_name: 'phone', value: 'x' }],
      });
      expect(missing.result.error?.code).toBe('not_found');

      const disallowed = handleSetFields(batchContext, state, 2, {
        entity_id: entityId,
        fields: [{ field_name: 'nickname', value: 'x' }],
      });
      expect(disallowed.result.error?.code).toBe('disallowed_field');
    });

    it('normalizes status answers: confirm applies, decline cancels, vagueness stays pending', () => {
      expect(normalizeStatusResumeAnswer('warm', 'yes')).toEqual({ action: 'apply', value: 'warm' });
      expect(normalizeStatusResumeAnswer('warm', 'CONFIRM')).toEqual({ action: 'apply', value: 'warm' });
      expect(normalizeStatusResumeAnswer('hot', 'warm')).toEqual({ action: 'apply', value: 'warm' });
      expect(normalizeStatusResumeAnswer('warm', 'no')).toEqual({ action: 'cancel' });
      expect(normalizeStatusResumeAnswer('warm', 'cancel')).toEqual({ action: 'cancel' });
      expect(normalizeStatusResumeAnswer('warm', 'maybe later')).toMatchObject({ action: 'ambiguous' });
      expect(normalizeStatusResumeAnswer('warm', 'closed')).toMatchObject({ action: 'ambiguous' });
    });
  });

  describe('conflicting current reports and dispute resolution (CF-01, CF-02)', () => {
    it('formats stored minor units as major units in quote display text', () => {
      // 4000 RON stored as 400000 minor units must read back as 4000 RON,
      // never as 400000 RON in entity state or model context.
      expect(formatQuoteText(400000, 'RON', 'expected')).toBe('4000 RON (expected)');
      expect(formatQuoteText(300000, 'EUR', 'offered')).toBe('3000 EUR (offered)');
      expect(formatQuoteText(400050, 'RON', 'expected')).toBe('4000.5 RON (expected)');
      expect(formatQuoteText(1, 'RON', 'expected')).toBe('0.01 RON (expected)');
      // Zero-decimal currencies keep the stored amount as-is.
      expect(formatQuoteText(5000, 'JPY', 'offered')).toBe('5000 JPY (offered)');
    });
    it('sets field to disputed (value = null, candidates preserved) on conflicting reports (CF-01)', () => {
      const { events: [e1], nextState: s1 } = handleCreateEntity(dummyContext, emptyState, 1, {
        name: 'Restaurant X',
      });
      const entityId = e1!.entity_id!;

      // Teammate A reports quote of 3000 EUR
      const quoteA = handleLogEvent(dummyContext, s1!, 2, {
        entity_id: entityId,
        kind: 'quote',
        payload: { amount: 300000, currency: 'EUR', role: 'offered' },
      });

      expect(quoteA.result.status).toBe('applied');
      const fieldKey = `${entityId}:quote`;
      const f1 = quoteA.nextState!.fields.get(fieldKey)!;
      expect(f1.state).toBe('clear');
      expect(f1.value_text).toContain('3000 EUR');

      // Teammate B reports competing quote of 4000 EUR without superseding
      const quoteB = handleLogEvent(
        { ...dummyContext, actor: { kind: 'member', user_id: 'usr-teammate' }, action_id: 'act-2' },
        quoteA.nextState!,
        3,
        {
          entity_id: entityId,
          kind: 'quote',
          payload: { amount: 400000, currency: 'EUR', role: 'offered' },
        },
      );

      expect(quoteB.result.status).toBe('applied');
      const f2 = quoteB.nextState!.fields.get(fieldKey)!;
      expect(f2.state).toBe('disputed');
      expect(f2.value_text).toBeNull(); // Current value MUST be null in dispute!
      expect(f2.value_json).toBeNull();
      expect(f2.candidate_event_ids).toHaveLength(2);
      expect(f2.candidate_event_ids).toContain(quoteA.events[0]!.id);
      expect(f2.candidate_event_ids).toContain(quoteB.events[0]!.id);
      // Historical last confirmed value remains inspectable
      expect(f2.last_confirmed_value_text).toContain('3000 EUR');
    });

    it('resolves dispute via resolve_conflict command into clear state with chosen value (CF-02)', () => {
      const { events: [e1], nextState: s1 } = handleCreateEntity(dummyContext, emptyState, 1, {
        name: 'Restaurant X',
      });
      const entityId = e1!.entity_id!;

      const q1 = handleLogEvent(dummyContext, s1!, 2, {
        entity_id: entityId,
        kind: 'quote',
        payload: { amount: 300000, currency: 'EUR', role: 'offered' },
      });
      const q2 = handleLogEvent(dummyContext, q1.nextState!, 3, {
        entity_id: entityId,
        kind: 'quote',
        payload: { amount: 400000, currency: 'EUR', role: 'offered' },
      });

      const fieldKey = `${entityId}:quote`;
      expect(q2.nextState!.fields.get(fieldKey)!.state).toBe('disputed');

      // Member explicitly resolves to 4000 EUR
      const resolved = handleResolveConflict(dummyContext, q2.nextState!, 4, {
        entity_id: entityId,
        field_name: 'quote',
        resolved_value: { amount: 400000, currency: 'EUR', role: 'offered' },
        candidate_event_ids: [q1.events[0]!.id, q2.events[0]!.id],
        rationale: 'Confirmed by manager',
      });

      expect(resolved.result.status).toBe('applied');
      const fResolved = resolved.nextState!.fields.get(fieldKey)!;
      expect(fResolved.state).toBe('clear');
      expect(fResolved.value_json).toContain('400000');
      expect(fResolved.candidate_event_ids).toBeNull();
    });

    it('rejects resolution if field is not disputed, candidates do not match, or field does not exist', () => {
      const { events: [e1], nextState: s1 } = handleCreateEntity(dummyContext, emptyState, 1, {
        name: 'Restaurant Y',
      });
      const entityId = e1!.entity_id!;

      const q1 = handleLogEvent(dummyContext, s1!, 2, {
        entity_id: entityId,
        kind: 'quote',
        payload: { amount: 300000, currency: 'EUR', role: 'offered' },
      });
      const q2 = handleLogEvent(dummyContext, q1.nextState!, 3, {
        entity_id: entityId,
        kind: 'quote',
        payload: { amount: 400000, currency: 'EUR', role: 'offered' },
      });

      // 1. Missing entity
      const resMissingEntity = handleResolveConflict(dummyContext, q2.nextState!, 4, {
        entity_id: 'non_existent_entity',
        field_name: 'quote',
        resolved_value: { amount: 400000 },
        candidate_event_ids: [q1.events[0]!.id, q2.events[0]!.id],
      });
      expect(resMissingEntity.result.status).toBe('rejected');
      expect(resMissingEntity.result.error?.code).toBe('not_found');

      // 2. Field not found on entity
      const resMissingField = handleResolveConflict(dummyContext, q2.nextState!, 4, {
        entity_id: entityId,
        field_name: 'non_existent_field',
        resolved_value: 'foo',
        candidate_event_ids: [q1.events[0]!.id, q2.events[0]!.id],
      });
      expect(resMissingField.result.status).toBe('rejected');
      expect(resMissingField.result.error?.code).toBe('field_not_found');

      // 3. Field is not disputed (try to resolve quote when it is in 'clear' state in q1)
      const resNotDisputed = handleResolveConflict(dummyContext, q1.nextState!, 3, {
        entity_id: entityId,
        field_name: 'quote',
        resolved_value: { amount: 300000, currency: 'EUR', role: 'offered' },
        candidate_event_ids: [q1.events[0]!.id],
      });
      expect(resNotDisputed.result.status).toBe('rejected');
      expect(resNotDisputed.result.error?.code).toBe('field_not_disputed');

      // 4. Candidate event IDs do not match active candidates (wrong ID provided)
      const resWrongCandidates = handleResolveConflict(dummyContext, q2.nextState!, 4, {
        entity_id: entityId,
        field_name: 'quote',
        resolved_value: { amount: 400000, currency: 'EUR', role: 'offered' },
        candidate_event_ids: [q1.events[0]!.id, 'ev_bogus_id'],
      });
      expect(resWrongCandidates.result.status).toBe('rejected');
      expect(resWrongCandidates.result.error?.code).toBe('candidate_mismatch');

      // 5. Incomplete candidates provided (only 1 of 2 candidates)
      const resIncompleteCandidates = handleResolveConflict(dummyContext, q2.nextState!, 4, {
        entity_id: entityId,
        field_name: 'quote',
        resolved_value: { amount: 400000, currency: 'EUR', role: 'offered' },
        candidate_event_ids: [q1.events[0]!.id],
      });
      expect(resIncompleteCandidates.result.status).toBe('rejected');
      expect(resIncompleteCandidates.result.error?.code).toBe('candidate_mismatch');
    });
  });

  describe('C1 characterization: single-interaction lifecycle before revision/removal', () => {
    const fullEmptyState: LedgerProjectionState = {
      entities: new Map(),
      aliases: new Map(),
      fields: new Map(),
      interactions: new Map(),
      tasks: new Map(),
      drafts: new Map(),
      memoryEntries: new Map(),
      memorySuppressions: new Map(),
    };

    function seedVisit() {
      const created = handleCreateEntity(dummyContext, fullEmptyState, 1, { name: 'Cluj Gym' });
      const entityId = created.events[0]!.entity_id!;
      const logged = handleLogEvent(dummyContext, created.nextState!, 2, {
        entity_id: entityId,
        kind: 'visit',
        payload: { summary: 'Met Monday', contact_made: true },
        occurred_at: '2026-10-05T10:00:00.000Z',
      });
      const root = logged.events[0]!.id;
      return { entityId, root, state: logged.nextState!, events: [created.events[0]!, logged.events[0]!] };
    }

    function interactionEntries(state: LedgerProjectionState) {
      return [...state.interactions.entries()].map(([k, v]) => [k, { ...v }]);
    }
    it('pins that offered and expected quotes currently dispute one shared field', () => {
      const { events: [e1], nextState: s1 } = handleCreateEntity(dummyContext, emptyState, 1, {
        name: 'Romanian Client',
      });
      const entityId = e1!.entity_id!;
      const offered = handleLogEvent(dummyContext, s1!, 2, {
        entity_id: entityId,
        kind: 'quote',
        payload: { amount: 45000, currency: 'EUR', role: 'offered' },
      });
      const expected = handleLogEvent(dummyContext, offered.nextState!, 3, {
        entity_id: entityId,
        kind: 'quote',
        payload: { amount: 400000, currency: 'RON', role: 'expected' },
      });
      const field = expected.nextState!.fields.get(`${entityId}:quote`)!;
      // Baseline gap (C1 step 6): two roles share one field, so the second
      // report disputes the first instead of sitting beside it.
      expect(field.state).toBe('disputed');
      expect(field.value_text).toBeNull();
      expect(field.candidate_event_ids).toHaveLength(2);
    });

    it('pins that a corrected visit is a second appended event with no effective head', () => {
      const { events: [e1], nextState: s1 } = handleCreateEntity(dummyContext, emptyState, 1, {
        name: 'Cluj Gym',
      });
      const entityId = e1!.entity_id!;
      const monday = handleLogEvent(dummyContext, s1!, 2, {
        entity_id: entityId,
        kind: 'visit',
        payload: { summary: 'Met Monday', contact_made: true },
        occurred_at: '2026-10-05T10:00:00.000Z',
      });
      const tuesday = handleLogEvent(dummyContext, monday.nextState!, 3, {
        entity_id: entityId,
        kind: 'visit',
        payload: { summary: 'Met Tuesday, not Monday', contact_made: true },
        occurred_at: '2026-10-06T10:00:00.000Z',
      });
      // Both reports survive as history; no reducer picks a current head yet.
      expect(tuesday.events).toHaveLength(1);
      expect(monday.events[0]!.id).not.toBe(tuesday.events[0]!.id);
      expect(tuesday.nextState!.fields.has(`${entityId}:visit`)).toBe(false);
      const rebuilt = rebuildProjections([
        e1!,
        monday.events[0]!,
        tuesday.events[0]!,
      ]);
      expect(rebuilt.fields.has(`${entityId}:visit`)).toBe(false);
    });

    it('pins that reverting a duplicate note keeps the original via rebuild', () => {
      const { events: [e1], nextState: s1 } = handleCreateEntity(dummyContext, emptyState, 1, {
        name: 'Dancer Girlfriend',
      });
      const entityId = e1!.entity_id!;
      const first = handleLogEvent(dummyContext, s1!, 2, {
        entity_id: entityId,
        kind: 'note',
        payload: { text: 'Wants a booking website' },
      });
      const duplicate = handleLogEvent(dummyContext, first.nextState!, 3, {
        entity_id: entityId,
        kind: 'note',
        payload: { text: 'Wants a booking website' },
      });
      const revert: LedgerEvent = {
        id: 'evt-revert-dup',
        workspace_id: 'ws-test',
        sequence: 4,
        entity_id: entityId,
        actor_kind: 'member',
        actor_user_id: 'usr-avi',
        kind: 'revert',
        schema_version: 1,
        payload: {
          target_event_id: duplicate.events[0]!.id,
          target_action_id: 'act-dup',
          target_event_kind: 'note',
          mode: 'single',
          group_operation_id: 'grp-1',
        },
        occurred_at: '2026-10-07T10:00:00.000Z',
        recorded_at: '2026-10-07T10:00:00.000Z',
        channel: 'web',
        action_id: 'act-revert',
        reverts_event_id: duplicate.events[0]!.id,
      };
      const rebuilt = rebuildProjections([
        e1!,
        first.events[0]!,
        duplicate.events[0]!,
        revert,
      ]);
      // Rebuild drops the reverted duplicate; the original report remains.
      expect(rebuilt.entities.has(entityId)).toBe(true);
      const liveIds = [e1!.id, first.events[0]!.id];
      expect(liveIds).toContain(first.events[0]!.id);
      expect(duplicate.events[0]!.id).not.toBe(first.events[0]!.id);
    });

    it('runs append, revise, revise, remove with live projection equal to rebuild', () => {
      const seed = seedVisit();
      const all = [...seed.events];

      const r1 = handleReviseInteraction(
        { ...dummyContext, action_id: 'act-rev-1' },
        seed.state,
        3,
        {
          interaction_id: seed.root,
          expected_head_event_id: seed.root,
          kind: 'visit',
          payload: { summary: 'Met Tuesday, not Monday', contact_made: true },
          occurred_at: '2026-10-06T10:00:00.000Z',
        },
      );
      expect(r1.result.status).toBe('applied');
      expect(r1.events[0]!.supersedes_event_id).toBe(seed.root);
      expect((r1.events[0]!.payload as Record<string, unknown>)['interaction_id']).toBe(seed.root);
      all.push(r1.events[0]!);
      let head = r1.result.data!.head_event_id;
      expect(r1.nextState!.interactions.get(seed.root)!.head_event_id).toBe(head);
      expect(r1.nextState!.interactions.get(seed.root)!.revision).toBe(2);
      expect(r1.nextState!.interactions.get(seed.root)!.state).toBe('active');
      expect(interactionEntries(rebuildProjections(all))).toEqual(interactionEntries(r1.nextState!));

      const r2 = handleReviseInteraction(
        { ...dummyContext, action_id: 'act-rev-2' },
        r1.nextState!,
        4,
        {
          interaction_id: seed.root,
          expected_head_event_id: head,
          kind: 'visit',
          payload: { summary: 'Met Tuesday at the gym', contact_made: true },
          occurred_at: '2026-10-06T10:00:00.000Z',
        },
      );
      expect(r2.result.status).toBe('applied');
      all.push(r2.events[0]!);
      head = r2.result.data!.head_event_id;
      expect(r2.nextState!.interactions.get(seed.root)!.revision).toBe(3);
      expect(interactionEntries(rebuildProjections(all))).toEqual(interactionEntries(r2.nextState!));

      const removed = handleRemoveInteraction(
        { ...dummyContext, action_id: 'act-rem-1' },
        r2.nextState!,
        5,
        { interaction_id: seed.root, expected_head_event_id: head, reason: 'duplicate visit' },
      );
      expect(removed.result.status).toBe('applied');
      expect(removed.events[0]!.kind).toBe('interaction_removed');
      all.push(removed.events[0]!);
      const row = removed.nextState!.interactions.get(seed.root)!;
      expect(row.state).toBe('removed');
      expect(row.head_event_id).toBe(removed.events[0]!.id);
      expect(interactionEntries(rebuildProjections(all))).toEqual(interactionEntries(removed.nextState!));

      // History retains every report: root, two revisions, removal.
      expect(all.map((e) => e.kind)).toEqual(['entity_created', 'visit', 'visit', 'visit', 'interaction_removed']);
    });

    it('rejects a stale head with a narrow conflict and commits nothing', () => {
      const seed = seedVisit();
      const r1 = handleReviseInteraction(
        { ...dummyContext, action_id: 'act-rev-1' },
        seed.state,
        3,
        {
          interaction_id: seed.root,
          expected_head_event_id: seed.root,
          kind: 'visit',
          payload: { summary: 'Corrected', contact_made: true },
        },
      );
      expect(r1.result.status).toBe('applied');

      // A teammate correction landed first; the stale edit must not apply silently.
      const stale = handleReviseInteraction(
        { ...dummyContext, action_id: 'act-rev-stale' },
        r1.nextState!,
        4,
        {
          interaction_id: seed.root,
          expected_head_event_id: seed.root,
          kind: 'visit',
          payload: { summary: 'Stale overwrite', contact_made: false },
        },
      );
      expect(stale.result.status).toBe('conflict');
      expect(stale.result.error?.code).toBe('head_conflict');
      expect(stale.events).toHaveLength(0);
      expect(stale.nextState).toBeUndefined();
    });

    it('rejects unknown roots, kind conversion, bad payloads and bad dates', () => {
      const seed = seedVisit();
      const unknown = handleReviseInteraction(
        dummyContext,
        seed.state,
        3,
        { interaction_id: 'evt_missing', expected_head_event_id: 'evt_missing', kind: 'visit', payload: {} },
      );
      expect(unknown.result.status).toBe('rejected');
      expect(unknown.result.error?.code).toBe('not_found');

      const converted = handleReviseInteraction(
        dummyContext,
        seed.state,
        3,
        {
          interaction_id: seed.root,
          expected_head_event_id: seed.root,
          kind: 'quote',
          payload: { amount: 50000, currency: 'EUR', role: 'offered' },
        },
      );
      expect(converted.result.status).toBe('rejected');
      expect(converted.result.error?.code).toBe('kind_mismatch');

      const badPayload = handleReviseInteraction(
        dummyContext,
        seed.state,
        3,
        {
          interaction_id: seed.root,
          expected_head_event_id: seed.root,
          kind: 'visit',
          payload: { summary: 'Missing flag' },
        },
      );
      expect(badPayload.result.status).toBe('rejected');
      expect(badPayload.result.error?.code).toBe('invalid_visit');

      const badDate = handleReviseInteraction(
        dummyContext,
        seed.state,
        3,
        {
          interaction_id: seed.root,
          expected_head_event_id: seed.root,
          kind: 'visit',
          payload: { summary: 'Dated', contact_made: true },
          occurred_at: 'not-a-date',
        },
      );
      expect(badDate.result.status).toBe('rejected');
      expect(badDate.result.error?.code).toBe('invalid_occurred_at');
    });

    it('validates quote revisions exactly like new quote logging', () => {
      const created = handleCreateEntity(dummyContext, fullEmptyState, 1, { name: 'Romanian Client' });
      const entityId = created.events[0]!.entity_id!;
      const logged = handleLogEvent(dummyContext, created.nextState!, 2, {
        entity_id: entityId,
        kind: 'quote',
        payload: { amount: 45000, currency: 'EUR', role: 'offered' },
      });
      const root = logged.events[0]!.id;

      const badUnits = handleReviseInteraction(
        dummyContext,
        logged.nextState!,
        3,
        {
          interaction_id: root,
          expected_head_event_id: root,
          kind: 'quote',
          payload: { amount: 450.5, currency: 'EUR', role: 'offered' },
        },
      );
      expect(badUnits.result.status).toBe('rejected');
      expect(badUnits.result.error?.code).toBe('invalid_quote');

      const corrected = handleReviseInteraction(
        { ...dummyContext, action_id: 'act-rev-q' },
        logged.nextState!,
        3,
        {
          interaction_id: root,
          expected_head_event_id: root,
          kind: 'quote',
          payload: { amount: 50000, currency: 'EUR', role: 'offered' },
          occurred_at: '2026-10-07T10:00:00.000Z',
        },
      );
      expect(corrected.result.status).toBe('applied');
      expect(corrected.result.summary).toContain('500 EUR (offered)');
      expect(corrected.nextState!.fields.get(`${entityId}:quote`)!.value_text).toContain('500 EUR');
    });

    it('makes double removal idempotent and blocks revising a removed root', () => {
      const seed = seedVisit();
      const removed = handleRemoveInteraction(
        { ...dummyContext, action_id: 'act-rem-1' },
        seed.state,
        3,
        { interaction_id: seed.root, expected_head_event_id: seed.root },
      );
      expect(removed.result.status).toBe('applied');

      const again = handleRemoveInteraction(
        { ...dummyContext, action_id: 'act-rem-2' },
        removed.nextState!,
        4,
        { interaction_id: seed.root, expected_head_event_id: seed.root },
      );
      expect(again.result.status).toBe('already_applied');
      expect(again.events).toHaveLength(0);

      const reviseAfterRemove = handleReviseInteraction(
        dummyContext,
        removed.nextState!,
        4,
        {
          interaction_id: seed.root,
          expected_head_event_id: removed.events[0]!.id,
          kind: 'visit',
          payload: { summary: 'Resurrected', contact_made: true },
        },
      );
      expect(reviseAfterRemove.result.status).toBe('rejected');
      expect(reviseAfterRemove.result.error?.code).toBe('interaction_removed');
    });

    it('rejects revise and remove when the owning entity is gone', () => {
      const seed = seedVisit();
      const deleted = handleDeleteEntity(
        { ...dummyContext, action_id: 'act-del-1' },
        seed.state,
        3,
        { entity_id: seed.entityId, confirm: 'yes' },
      );
      expect(deleted.result.status).toBe('applied');
      expect(deleted.nextState!.interactions.has(seed.root)).toBe(false);

      const revise = handleReviseInteraction(dummyContext, deleted.nextState!, 4, {
        interaction_id: seed.root,
        expected_head_event_id: seed.root,
        kind: 'visit',
        payload: { summary: 'Late edit', contact_made: true },
      });
      expect(revise.result.status).toBe('rejected');
      expect(revise.result.error?.code).toBe('not_found');

      const remove = handleRemoveInteraction(dummyContext, deleted.nextState!, 4, {
        interaction_id: seed.root,
        expected_head_event_id: seed.root,
      });
      expect(remove.result.status).toBe('rejected');
      expect(remove.result.error?.code).toBe('not_found');
    });

    it('orders heads by commit sequence when occurrence dates tie', () => {
      const seed = seedVisit();
      const sameDay = '2026-10-06T10:00:00.000Z';
      const r1 = handleReviseInteraction(
        { ...dummyContext, action_id: 'act-rev-1' },
        seed.state,
        3,
        {
          interaction_id: seed.root,
          expected_head_event_id: seed.root,
          kind: 'visit',
          payload: { summary: 'First correction', contact_made: true },
          occurred_at: sameDay,
        },
      );
      const r2 = handleReviseInteraction(
        { ...dummyContext, action_id: 'act-rev-2' },
        r1.nextState!,
        4,
        {
          interaction_id: seed.root,
          expected_head_event_id: r1.events[0]!.id,
          kind: 'visit',
          payload: { summary: 'Second correction', contact_made: true },
          occurred_at: sameDay,
        },
      );
      expect(r2.result.status).toBe('applied');
      expect(r2.nextState!.interactions.get(seed.root)!.head_event_id).toBe(r2.events[0]!.id);
      expect(r2.nextState!.interactions.get(seed.root)!.sequence).toBe(4);
    });

    it('restores prior heads when a revision or removal is reverted', () => {
      const seed = seedVisit();
      const all = [...seed.events];
      const r1 = handleReviseInteraction(
        { ...dummyContext, action_id: 'act-rev-1' },
        seed.state,
        3,
        {
          interaction_id: seed.root,
          expected_head_event_id: seed.root,
          kind: 'visit',
          payload: { summary: 'Corrected', contact_made: true },
        },
      );
      all.push(r1.events[0]!);
      const removed = handleRemoveInteraction(
        { ...dummyContext, action_id: 'act-rem-1' },
        r1.nextState!,
        4,
        { interaction_id: seed.root, expected_head_event_id: r1.events[0]!.id },
      );
      all.push(removed.events[0]!);

      const revertRemoval: LedgerEvent = {
        id: 'evt-revert-removal',
        workspace_id: 'ws-test',
        sequence: 5,
        entity_id: seed.entityId,
        actor_kind: 'member',
        actor_user_id: 'usr-avi',
        kind: 'revert',
        schema_version: 1,
        payload: {
          target_event_id: removed.events[0]!.id,
          target_action_id: 'act-rem-1',
          target_event_kind: 'interaction_removed',
          mode: 'single',
          group_operation_id: 'grp-1',
        },
        occurred_at: '2026-10-07T10:00:00.000Z',
        recorded_at: '2026-10-07T10:00:00.000Z',
        channel: 'web',
        source_message_id: 'msg-101',
        action_id: 'act-undo-1',
        reverts_event_id: removed.events[0]!.id,
      };
      const restored = rebuildProjections([...all, revertRemoval]);
      const row = restored.interactions.get(seed.root)!;
      expect(row.state).toBe('active');
      expect(row.head_event_id).toBe(r1.events[0]!.id);

      const revertRevision: LedgerEvent = {
        ...revertRemoval,
        id: 'evt-revert-revision',
        sequence: 6,
        payload: {
          target_event_id: r1.events[0]!.id,
          target_action_id: 'act-rev-1',
          target_event_kind: 'visit',
          mode: 'single',
          group_operation_id: 'grp-2',
        },
        action_id: 'act-undo-2',
        reverts_event_id: r1.events[0]!.id,
      };
      const original = rebuildProjections([...all, revertRemoval, revertRevision]);
      expect(original.interactions.get(seed.root)!.head_event_id).toBe(seed.root);
    });

    it('empties the quote field when its only active root is removed', () => {
      const created = handleCreateEntity(dummyContext, fullEmptyState, 1, { name: 'Solo Quote' });
      const entityId = created.events[0]!.entity_id!;
      const logged = handleLogEvent(dummyContext, created.nextState!, 2, {
        entity_id: entityId,
        kind: 'quote',
        payload: { amount: 45000, currency: 'EUR', role: 'offered' },
      });
      const root = logged.events[0]!.id;
      expect(logged.nextState!.fields.get(`${entityId}:quote`)!.value_text).toContain('450 EUR');

      const removed = handleRemoveInteraction(
        { ...dummyContext, action_id: 'act-rem solo' },
        logged.nextState!,
        3,
        { interaction_id: root, expected_head_event_id: root, reason: 'entered by mistake' },
      );
      expect(removed.result.status).toBe('applied');
      const field = removed.nextState!.fields.get(`${entityId}:quote`)!;
      expect(field.state).toBe('clear');
      expect(field.value_text).toBeNull();
      expect(field.value_json).toBeNull();
      expect(field.source_event_id).toBeNull();
      expect(field.last_confirmed_value_text).toContain('450 EUR');
      expect(
        interactionEntries(
          rebuildProjections([created.events[0]!, logged.events[0]!, removed.events[0]!]),
        ),
      ).toEqual(interactionEntries(removed.nextState!));
    });

    it('preserves a dispute when revising one disputant, swapping its candidate', () => {
      const created = handleCreateEntity(dummyContext, fullEmptyState, 1, { name: 'Disputed Co' });
      const entityId = created.events[0]!.entity_id!;
      const first = handleLogEvent(dummyContext, created.nextState!, 2, {
        entity_id: entityId,
        kind: 'quote',
        payload: { amount: 300000, currency: 'EUR', role: 'offered' },
      });
      const second = handleLogEvent(dummyContext, first.nextState!, 3, {
        entity_id: entityId,
        kind: 'quote',
        payload: { amount: 400000, currency: 'EUR', role: 'offered' },
      });
      const rootA = first.events[0]!.id;
      const rootB = second.events[0]!.id;
      expect(second.nextState!.fields.get(`${entityId}:quote`)!.state).toBe('disputed');

      const revised = handleReviseInteraction(
        { ...dummyContext, action_id: 'act-rev dispute' },
        second.nextState!,
        4,
        {
          interaction_id: rootA,
          expected_head_event_id: rootA,
          kind: 'quote',
          payload: { amount: 350000, currency: 'EUR', role: 'offered' },
        },
      );
      expect(revised.result.status).toBe('applied');
      const field = revised.nextState!.fields.get(`${entityId}:quote`)!;
      expect(field.state).toBe('disputed');
      expect(field.value_text).toBeNull();
      expect(field.candidate_event_ids).toHaveLength(2);
      expect(field.candidate_event_ids).toContain(rootB);
      expect(field.candidate_event_ids).toContain(revised.events[0]!.id);
      expect(field.candidate_event_ids).not.toContain(rootA);
      expect(
        interactionEntries(
          rebuildProjections([created.events[0]!, first.events[0]!, second.events[0]!, revised.events[0]!]),
        ),
      ).toEqual(interactionEntries(revised.nextState!));
    });

    it('resolves to the surviving root when removing one disputant', () => {
      const created = handleCreateEntity(dummyContext, fullEmptyState, 1, { name: 'Split Co' });
      const entityId = created.events[0]!.entity_id!;
      const first = handleLogEvent(dummyContext, created.nextState!, 2, {
        entity_id: entityId,
        kind: 'quote',
        payload: { amount: 300000, currency: 'EUR', role: 'offered' },
      });
      const second = handleLogEvent(dummyContext, first.nextState!, 3, {
        entity_id: entityId,
        kind: 'quote',
        payload: { amount: 400000, currency: 'EUR', role: 'offered' },
      });
      const removed = handleRemoveInteraction(
        { ...dummyContext, action_id: 'act-rem disputant' },
        second.nextState!,
        4,
        { interaction_id: first.events[0]!.id, expected_head_event_id: first.events[0]!.id },
      );
      expect(removed.result.status).toBe('applied');
      const field = removed.nextState!.fields.get(`${entityId}:quote`)!;
      expect(field.state).toBe('clear');
      expect(field.value_text).toContain('4000 EUR');
      expect(field.source_event_id).toBe(second.events[0]!.id);
    });

    it('keeps the original date on content-only revision and rejects impossible dates', () => {
      const seed = seedVisit();
      const fixed = handleReviseInteraction(
        { ...dummyContext, action_id: 'act-rev nodate' },
        seed.state,
        3,
        {
          interaction_id: seed.root,
          expected_head_event_id: seed.root,
          kind: 'visit',
          payload: { summary: 'Same day, better notes', contact_made: true },
        },
      );
      expect(fixed.result.status).toBe('applied');
      expect(fixed.events[0]!.occurred_at).toBe('2026-10-05T10:00:00.000Z');
      expect(fixed.nextState!.interactions.get(seed.root)!.occurred_at).toBe('2026-10-05T10:00:00.000Z');

      const impossible = handleReviseInteraction(
        dummyContext,
        seed.state,
        3,
        {
          interaction_id: seed.root,
          expected_head_event_id: seed.root,
          kind: 'visit',
          payload: { summary: 'Bad date', contact_made: true },
          occurred_at: '2026-02-30',
        },
      );
      expect(impossible.result.status).toBe('rejected');
      expect(impossible.result.error?.code).toBe('invalid_occurred_at');

      const impossibleInstant = handleReviseInteraction(
        dummyContext,
        seed.state,
        3,
        {
          interaction_id: seed.root,
          expected_head_event_id: seed.root,
          kind: 'visit',
          payload: { summary: 'Bad instant', contact_made: true },
          occurred_at: '2026-02-30T10:00:00.000Z',
        },
      );
      expect(impossibleInstant.result.status).toBe('rejected');
      expect(impossibleInstant.result.error?.code).toBe('invalid_occurred_at');
    });

    it('strips a smuggled root marker from new logs instead of hijacking another root', () => {
      const createdA = handleCreateEntity(dummyContext, fullEmptyState, 1, { name: 'First Client' });
      const entityA = createdA.events[0]!.entity_id!;
      const logged = handleLogEvent(dummyContext, createdA.nextState!, 2, {
        entity_id: entityA,
        kind: 'note',
        payload: { text: 'First client entry' },
      });
      const root = logged.events[0]!.id;

      // A lower-level caller smuggles another root's marker into a new log
      // for a different entity: the entry must land as its own fresh root.
      const smuggled = handleLogEvent(
        { ...dummyContext, action_id: 'act-smuggle' },
        logged.nextState!,
        3,
        {
          entity_id: entityA,
          kind: 'note',
          payload: { text: 'Second client entry', interaction_id: root },
        },
      );
      expect(smuggled.result.status).toBe('applied');
      expect(smuggled.events[0]!.id).not.toBe(root);
      const row = smuggled.nextState!.interactions.get(root)!;
      expect(row.entity_id).toBe(entityA);
      expect(row.head_event_id).toBe(root);
      expect(row.revision).toBe(1);
      // The smuggled entry stands alone under its own root.
      expect(smuggled.nextState!.interactions.get(smuggled.events[0]!.id)).toMatchObject({
        entity_id: entityA,
        head_event_id: smuggled.events[0]!.id,
      });
    });

    it('names the restored entry when previewing removal Undo', () => {
      const created = handleCreateEntity(dummyContext, fullEmptyState, 1, { name: 'Undo Target' });
      const logged = handleLogEvent(dummyContext, created.nextState!, 2, {
        entity_id: null,
        kind: 'note',
        payload: { text: 'Entry to restore' },
      });
      const root = logged.events[0]!.id;
      const removed = handleRemoveInteraction(
        { ...dummyContext, action_id: 'act-rem preview' },
        logged.nextState!,
        3,
        { interaction_id: root, expected_head_event_id: root },
      );
      expect(removed.result.status).toBe('applied');
      const removal = removed.events[0]!;
      const receipt: ActionReceipt = {
        id: 'rcpt-rem',
        workspace_id: 'ws-test',
        action_id: 'act-rem preview',
        payload_hash: 'hash',
        command_name: 'remove_interaction',
        result_status: 'applied',
        result_json: JSON.stringify(removed.result),
        actor_kind: 'member',
        actor_user_id: 'usr-avi',
        source_message_id: 'msg-101',
        source_job_id: null,
        run_id: 'run-1',
        step_id: null,
        committed_revision: 3,
        created_at: '2026-10-07T10:00:00.000Z',
      };
      const preview = computeUndoPreview(
        'act-rem preview',
        'single',
        [receipt],
        [created.events[0]!, logged.events[0]!, removal],
        removed.nextState!,
        3,
      );
      expect(preview.affected_event_ids).toHaveLength(1);
      expect(preview.affected_context).toHaveLength(1);
      expect(preview.affected_context[0]!.changes[0]).toContain('note');
    });

    it('flags later revisions as dependents when previewing undo of the original log', () => {
      const created = handleCreateEntity(dummyContext, fullEmptyState, 1, { name: 'Chain Co' });
      const logged = handleLogEvent(dummyContext, created.nextState!, 2, {
        entity_id: null,
        kind: 'note',
        payload: { text: 'Original' },
      });
      const root = logged.events[0]!.id;
      const revised = handleReviseInteraction(
        { ...dummyContext, action_id: 'act-rev chain' },
        logged.nextState!,
        3,
        {
          interaction_id: root,
          expected_head_event_id: root,
          kind: 'note',
          payload: { text: 'Correction' },
        },
      );
      const receiptFor = (actionId: string, command: string): ActionReceipt => ({
        id: `rcpt-${actionId}`,
        workspace_id: 'ws-test',
        action_id: actionId,
        payload_hash: 'hash',
        command_name: command,
        result_status: 'applied',
        result_json: '{}',
        actor_kind: 'member',
        actor_user_id: 'usr-avi',
        source_message_id: 'msg-101',
        source_job_id: null,
        run_id: 'run-1',
        step_id: null,
        committed_revision: 3,
        created_at: '2026-10-07T10:00:00.000Z',
      });
      const preview = computeUndoPreview(
        'act-1',
        'single',
        [receiptFor('act-1', 'log_event'), receiptFor('act-rev chain', 'revise_interaction')],
        [created.events[0]!, logged.events[0]!, revised.events[0]!],
        revised.nextState!,
        3,
      );
      expect(preview.dependencies.map((d) => d.action_id)).toContain('act-rev chain');
    });
  });

  describe('conversational entity deletion', () => {
    function seedLeadWithDetails() {
      const created = handleCreateEntity(dummyContext, emptyState, 1, { name: 'Romanian Client' });
      const entityId = created.events[0]!.entity_id!;
      let state = created.nextState!;
      let seq = 2;
      const quote = handleLogEvent(dummyContext, state, seq++, {
        entity_id: entityId,
        kind: 'quote',
        payload: { amount: 400000, currency: 'RON', role: 'expected' },
      });
      state = quote.nextState!;
      const aliased = handleAddAlias(dummyContext, state, seq++, { entity_id: entityId, alias: 'RC' });
      state = aliased.nextState!;
      const tasked = handleCreateTask(dummyContext, state, seq++, {
        entity_id: entityId,
        title: 'Send offer',
        explicit_no_deadline: true,
      });
      state = tasked.nextState!;
      const noted = handleRememberContext(dummyContext, state, seq++, {
        scope: 'entity',
        subject_id: entityId,
        category: 'relationship_context',
        content: 'Prefers WhatsApp',
      });
      state = noted.nextState!;
      const memberNote = handleRememberContext(dummyContext, state, seq++, {
        scope: 'member_in_workspace',
        subject_id: 'usr-avi',
        category: 'communication_preference',
        content: 'Short replies',
      });
      state = memberNote.nextState!;
      const events = [
        ...created.events, ...quote.events, ...aliased.events,
        ...tasked.events, ...noted.events, ...memberNote.events,
      ];
      return { entityId, state, events, seq };
    }

    it('requires confirmation and rejects unknown entities', () => {
      const { entityId, state, seq } = seedLeadWithDetails();
      const unconfirmed = handleDeleteEntity(dummyContext, state, seq, { entity_id: entityId });
      expect(unconfirmed.result.status).toBe('rejected');
      expect(unconfirmed.result.error?.code).toBe('confirmation_required');
      expect(unconfirmed.events).toHaveLength(0);

      const declined = handleDeleteEntity(dummyContext, state, seq, { entity_id: entityId, confirm: 'no' });
      expect(declined.result.status).toBe('rejected');

      const missing = handleDeleteEntity(dummyContext, state, seq, { entity_id: 'ent_missing', confirm: 'yes' });
      expect(missing.result.status).toBe('rejected');
      expect(missing.result.error?.code).toBe('not_found');
    });

    it('removes the entity subtree from projections while history stays', () => {
      const { entityId, state, events, seq } = seedLeadWithDetails();
      // The stored quote reads back in major units before deletion.
      expect(state.fields.get(`${entityId}:quote`)!.value_text).toBe('4000 RON (expected)');

      const deleted = handleDeleteEntity(dummyContext, state, seq, {
        entity_id: entityId,
        confirm: 'yes',
        reason: 'fake test data',
      });
      expect(deleted.result.status).toBe('applied');
      expect(deleted.events).toHaveLength(1);
      expect(deleted.events[0]!.kind).toBe('entity_deleted');

      const next = deleted.nextState!;
      expect(next.entities.has(entityId)).toBe(false);
      expect([...next.aliases.values()].some((a) => a.entity_id === entityId)).toBe(false);
      expect([...next.fields.keys()].some((k) => k.startsWith(`${entityId}:`))).toBe(false);
      expect([...next.tasks.values()].some((t) => t.entity_id === entityId)).toBe(false);
      expect([...next.drafts.values()].some((d) => d.entity_id === entityId)).toBe(false);
      expect(
        [...next.memoryEntries.values()].some((m) => m.scope === 'entity' && m.subject_id === entityId),
      ).toBe(false);
      // Member-scoped notes about other subjects survive.
      expect(
        [...next.memoryEntries.values()].some((m) => m.scope === 'member_in_workspace'),
      ).toBe(true);
      // History stays: every event including the delete is recorded.
      expect([...events, ...deleted.events]).toHaveLength(events.length + 1);
    });

    it('replays identically through rebuildProjections', () => {
      const { entityId, events, seq } = seedLeadWithDetails();
      const state = rebuildProjections(events);
      const deleted = handleDeleteEntity(dummyContext, state, seq, { entity_id: entityId, confirm: 'da' });
      expect(deleted.result.status).toBe('applied');

      const rebuilt = rebuildProjections([...events, ...deleted.events]);
      expect(rebuilt.entities.has(entityId)).toBe(false);
      expect([...rebuilt.tasks.values()].some((t) => t.entity_id === entityId)).toBe(false);
      expect(rebuilt.entities.size).toBe(0);
    });

    it('restores everything when the delete event is reverted (Undo)', () => {
      const { entityId, events, seq } = seedLeadWithDetails();
      const state = rebuildProjections(events);
      const deleted = handleDeleteEntity(dummyContext, state, seq, { entity_id: entityId, confirm: 'yes' });
      const deleteEvent = deleted.events[0]!;
      const revert = {
        ...deleteEvent,
        id: 'evt_revert_delete_1',
        kind: 'revert' as const,
        reverts_event_id: deleteEvent.id,
        payload: { target_event_id: deleteEvent.id },
      };
      const restored = rebuildProjections([...events, ...deleted.events, revert]);
      expect(restored.entities.get(entityId)?.name).toBe('Romanian Client');
      expect(restored.fields.get(`${entityId}:quote`)!.value_text).toBe('4000 RON (expected)');
      expect([...restored.tasks.values()].some((t) => t.entity_id === entityId)).toBe(true);
    });
  });

  describe('rebuild determinism and grouped undo (UN-01, UN-02, UN-03)', () => {    it('produces identical projections when rebuilding from event stream', () => {
      const { events: e1, nextState: s1 } = handleCreateEntity(dummyContext, emptyState, 1, {
        name: 'Bistro One',
      });
      const entityId = e1[0]!.entity_id!;
      const { events: e2, nextState: s2 } = handleSetField(dummyContext, s1!, 2, {
        entity_id: entityId,
        field_name: 'status',
        value: 'hot',
      });
      const { events: e3, nextState: s3 } = handleCreateTask(dummyContext, s2!, 3, {
        entity_id: entityId,
        title: 'Call owner',
        due: { kind: 'date', local_date: '2026-10-10', timezone: 'UTC' },
      });

      const allEvents = [...e1, ...e2, ...e3];
      const rebuilt = rebuildProjections(allEvents);

      expect(rebuilt.entities.get(entityId)!.status).toBe(s3!.entities.get(entityId)!.status);
      expect(rebuilt.fields.get(`${entityId}:status`)!.value_text).toBe(
        s3!.fields.get(`${entityId}:status`)!.value_text,
      );
      expect(rebuilt.tasks.size).toBe(s3!.tasks.size);
    });

    it('from_here undo reverts target action and subsequent actions in same run (UN-01)', () => {
      // Run 1: Create entity, update status to hot, create task
      const { events: e1, nextState: s1 } = handleCreateEntity(dummyContext, emptyState, 1, {
        name: 'Hotel Alpha',
      });
      const entityId = e1[0]!.entity_id!;

      const ctxRun1Act2 = { ...dummyContext, action_id: 'act-2', run_id: 'run-1' };
      const { events: e2, nextState: s2 } = handleSetField(ctxRun1Act2, s1!, 2, {
        entity_id: entityId,
        field_name: 'status',
        value: 'hot',
      });

      const ctxRun1Act3 = { ...dummyContext, action_id: 'act-3', run_id: 'run-1' };
      const { events: e3, nextState: s3 } = handleCreateTask(ctxRun1Act3, s2!, 3, {
        entity_id: entityId,
        title: 'Send brochure',
        due: { kind: 'date', local_date: '2026-10-12', timezone: 'UTC' },
      });

      const allEvents = [...e1, ...e2, ...e3];
      const allActions: ActionReceipt[] = [
        {
          id: 'rcpt-1',
          workspace_id: 'ws-test',
          action_id: 'act-1',
          payload_hash: 'h1',
          command_name: 'create_entity',
          result_status: 'applied',
          result_json: '{}',
          actor_kind: 'member',
          committed_revision: 1,
          run_id: 'run-1',
          created_at: new Date().toISOString(),
        },
        {
          id: 'rcpt-2',
          workspace_id: 'ws-test',
          action_id: 'act-2',
          payload_hash: 'h2',
          command_name: 'set_field',
          result_status: 'applied',
          result_json: '{}',
          actor_kind: 'member',
          committed_revision: 2,
          run_id: 'run-1',
          created_at: new Date().toISOString(),
        },
        {
          id: 'rcpt-3',
          workspace_id: 'ws-test',
          action_id: 'act-3',
          payload_hash: 'h3',
          command_name: 'create_task',
          result_status: 'applied',
          result_json: '{}',
          actor_kind: 'member',
          committed_revision: 3,
          run_id: 'run-1',
          created_at: new Date().toISOString(),
        },
      ];

      // Preview undo from_here starting at act-2
      const preview = computeUndoPreview('act-2', 'from_here', allActions, allEvents, s3!, 3);
      expect(preview.selected_action_ids).toEqual(['act-2', 'act-3']);
      expect(preview.affected_event_ids).toHaveLength(2); // e2 and e3

      // Commit undo
      const undoResult = handleUndoCommit(
        dummyContext,
        allEvents,
        allActions,
        s3!,
        4,
        {
          action_id: 'act-2',
          mode: 'from_here',
          client_operation_id: 'undo-op-1',
          expected_revision: 3,
        },
      );

      expect(undoResult.result.status).toBe('applied');
      expect(undoResult.events).toHaveLength(2); // Two revert events

      // Entity remains created with status "new", task is removed
      const finalEntity = undoResult.nextState!.entities.get(entityId)!;
      expect(finalEntity.status).toBe('new');
      expect(undoResult.nextState!.tasks.size).toBe(0);
    });

    it('single undo preserves independent later teammate actions (UN-02)', () => {
      // Act 1: Avi creates entity
      const { events: e1, nextState: s1 } = handleCreateEntity(dummyContext, emptyState, 1, {
        name: 'Hotel Beta',
      });
      const entityId = e1[0]!.entity_id!;

      // Act 2: Avi sets phone number
      const ctx2 = { ...dummyContext, action_id: 'act-2', run_id: 'run-1' };
      const { events: e2, nextState: s2 } = handleSetField(ctx2, s1!, 2, {
        entity_id: entityId,
        field_name: 'phone',
        value: '+1234567890',
      });

      // Act 3: Teammate Hunor in run-2 updates status to warm
      const ctx3: LedgerCommandContext = {
        workspace_id: 'ws-test',
        actor: { kind: 'member', user_id: 'usr-hunor' },
        membership_revision: 1,
        source_message_id: 'msg-hunor-1',
        request_id: 'req-3',
        action_id: 'act-3',
        expected_business_revision: 2,
        run_id: 'run-2',
      };
      const { events: e3, nextState: s3 } = handleSetField(ctx3, s2!, 3, {
        entity_id: entityId,
        field_name: 'status',
        value: 'warm',
      });

      const allEvents = [...e1, ...e2, ...e3];
      const allActions: ActionReceipt[] = [
        {
          id: 'r1',
          workspace_id: 'ws-test',
          action_id: 'act-1',
          payload_hash: 'h1',
          command_name: 'create_entity',
          result_status: 'applied',
          result_json: '{}',
          actor_kind: 'member',
          committed_revision: 1,
          run_id: 'run-1',
          created_at: new Date().toISOString(),
        },
        {
          id: 'r2',
          workspace_id: 'ws-test',
          action_id: 'act-2',
          payload_hash: 'h2',
          command_name: 'set_field',
          result_status: 'applied',
          result_json: '{}',
          actor_kind: 'member',
          committed_revision: 2,
          run_id: 'run-1',
          created_at: new Date().toISOString(),
        },
        {
          id: 'r3',
          workspace_id: 'ws-test',
          action_id: 'act-3',
          payload_hash: 'h3',
          command_name: 'set_field',
          result_status: 'applied',
          result_json: '{}',
          actor_kind: 'member',
          committed_revision: 3,
          run_id: 'run-2',
          created_at: new Date().toISOString(),
        },
      ];

      // Undo only act-2 (phone number)
      const undoResult = handleUndoCommit(
        dummyContext,
        allEvents,
        allActions,
        s3!,
        4,
        {
          action_id: 'act-2',
          mode: 'single',
          client_operation_id: 'undo-phone',
          expected_revision: 3,
        },
      );

      expect(undoResult.result.status).toBe('applied');
      // Phone number field is reverted
      expect(undoResult.nextState!.fields.has(`${entityId}:phone`)).toBe(false);
      // Teammate's status edit survives!
      expect(undoResult.nextState!.entities.get(entityId)!.status).toBe('warm');
    });

    it('undo preview flags dependency conflict when later run depends on an action being undone (UN-03)', () => {
      // Act 1: Create task
      const { events: e1, nextState: s1 } = handleCreateTask(dummyContext, emptyState, 1, {
        title: 'Important Task',
        explicit_no_deadline: true,
      });
      const taskId = e1[0]!.payload.task_id;

      // Act 2: Later run by teammate completes the task
      const ctxTeammate: LedgerCommandContext = {
        ...dummyContext,
        actor: { kind: 'member', user_id: 'usr-hunor' },
        action_id: 'act-2',
        run_id: 'run-2',
      };
      const { events: e2, nextState: s2 } = handleUpdateTask(ctxTeammate, s1!, 2, {
        task_id: taskId,
        status: 'done',
      });

      const allEvents = [...e1, ...e2];
      const allActions: ActionReceipt[] = [
        {
          id: 'r1',
          workspace_id: 'ws-test',
          action_id: 'act-1',
          payload_hash: 'h1',
          command_name: 'create_task',
          result_status: 'applied',
          result_json: '{}',
          actor_kind: 'member',
          committed_revision: 1,
          run_id: 'run-1',
          created_at: new Date().toISOString(),
        },
        {
          id: 'r2',
          workspace_id: 'ws-test',
          action_id: 'act-2',
          payload_hash: 'h2',
          command_name: 'update_task',
          result_status: 'applied',
          result_json: '{}',
          actor_kind: 'member',
          committed_revision: 2,
          run_id: 'run-2',
          created_at: new Date().toISOString(),
        },
      ];

      // Preview undoing act-1
      const preview = computeUndoPreview('act-1', 'single', allActions, allEvents, s2!, 2);
      expect(preview.dependencies).toHaveLength(1);
      expect(preview.dependencies[0]!.requires_clarification).toBe(true);
      expect(preview.dependencies[0]!.reason).toContain('modified task');

      // Attempting commit without resolving dependency returns needs_clarification
      const commit = handleUndoCommit(dummyContext, allEvents, allActions, s2!, 3, {
        action_id: 'act-1',
        mode: 'single',
        client_operation_id: 'undo-task-1',
        expected_revision: 2,
      });
      expect(commit.result.status).toBe('needs_clarification');
    });
  });
});
