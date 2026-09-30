import { describe, it, expect } from 'vitest';
import {
  assertEventInvariant,
  handleCreateEntity,
  handleRenameEntity,
  handleAddAlias,
  handleSetField,
  handleLogEvent,
  handleCreateTask,
  handleUpdateTask,
  handleResolveConflict,
  computeUndoPreview,
  handleUndoCommit,
  rebuildProjections,
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

  describe('conflicting current reports and dispute resolution (CF-01, CF-02)', () => {
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
      expect(f1.value_text).toContain('300000 EUR');

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
      expect(f2.last_confirmed_value_text).toContain('300000 EUR');
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

  describe('rebuild determinism and grouped undo (UN-01, UN-02, UN-03)', () => {
    it('produces identical projections when rebuilding from event stream', () => {
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
