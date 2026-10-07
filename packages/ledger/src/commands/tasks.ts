/**
 * @otis/ledger/commands/tasks
 * Handles create_task and update_task commands with missing-deadline gating and snooze invariants.
 */

import type { CommandResult, LedgerEvent, TaskDue } from '@otis/contracts';
import type { CreateTaskArgs, LedgerCommandContext, LedgerProjectionState, UpdateTaskArgs } from '../types.js';
import { createLedgerEvent } from './events.js';
import { reduceTasks } from '../reducers/tasks.js';

export function handleCreateTask(
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: CreateTaskArgs,
): {
  result: CommandResult<{ task_id: string }>;
  events: LedgerEvent[];
  nextState?: LedgerProjectionState;
} {
  const trimmedTitle = args.title.trim();
  if (!trimmedTitle) {
    return {
      result: {
        status: 'rejected',
        error: { code: 'bad_request', message: 'Task title cannot be empty.' },
      },
      events: [],
    };
  }

  // 1. Missing deadline rule:
  // If a new intended task has no date and no explicit no-deadline instruction,
  // preserve the request as pending clarification; never assign today.
  let resolvedDue: TaskDue = null;
  if (args.due !== undefined) {
    resolvedDue = args.due;
  } else if (!args.explicit_no_deadline) {
    return {
      result: {
        status: 'needs_clarification',
        action_id: context.action_id,
        summary: `Missing deadline for task '${trimmedTitle}'. Please provide a due date or confirm no deadline.`,
        clarification: {
          prompt: `When is '${trimmedTitle}' due, or should it have no deadline?`,
          missing_fields: ['due'],
        },
      },
      events: [],
    };
  }

  // 2. Member-authored task defaults to that member unless explicitly assigned
  const assignee = args.assignee_user_id !== undefined
    ? args.assignee_user_id
    : (context.actor.kind === 'member' ? context.actor.user_id || null : null);

  const taskId = `tsk_${crypto.randomUUID()}`;

  const event = createLedgerEvent(context, nextSequence, {
    entity_id: args.entity_id || null,
    kind: 'task_created',
    payload: {
      task_id: taskId,
      title: trimmedTitle,
      entity_id: args.entity_id || null,
      assignee_user_id: assignee,
      due: resolvedDue,
      explicit_no_deadline: args.explicit_no_deadline === true,
      is_promise: args.is_promise === true,
    },
    provenance: 'stated',
  });

  const nextTasks = new Map(state.tasks);
  reduceTasks(nextTasks, event);

  return {
    result: {
      status: 'applied',
      action_id: context.action_id,
      affected_resource_ids: [taskId],
      event_ids: [event.id],
      summary: `Created task '${trimmedTitle}'${resolvedDue ? ` due ${resolvedDue.kind === 'date' ? resolvedDue.local_date : resolvedDue.at}` : ' with no deadline'}.`,
      data: { task_id: taskId },
    },
    events: [event],
    nextState: { ...state, tasks: nextTasks },
  };
}

export function handleUpdateTask(
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: UpdateTaskArgs,
): {
  result: CommandResult<{ task_id: string }>;
  events: LedgerEvent[];
  nextState?: LedgerProjectionState;
} {
  const task = state.tasks.get(args.task_id);
  if (!task) {
    return {
      result: {
        status: 'rejected',
        error: { code: 'not_found', message: `Task '${args.task_id}' not found.` },
      },
      events: [],
    };
  }

  if (args.expected_revision !== undefined && task.revision !== args.expected_revision) {
    return {
      result: {
        status: 'conflict',
        error: {
          code: 'revision_conflict',
          message: `Stale task revision: expected ${args.expected_revision}, current is ${task.revision}.`,
        },
      },
      events: [],
    };
  }

  // Handle status transitions
  const hasOtherFields = args.title !== undefined || args.due !== undefined || args.snooze_until !== undefined;

  if (!hasOtherFields && args.status === 'done' && task.status !== 'done') {
    const event = createLedgerEvent(context, nextSequence, {
      entity_id: task.entity_id,
      kind: 'task_done',
      payload: { task_id: task.id },
      provenance: 'stated',
    });
    const nextTasks = new Map(state.tasks);
    reduceTasks(nextTasks, event);
    return {
      result: {
        status: 'applied',
        action_id: context.action_id,
        affected_resource_ids: [task.id],
        event_ids: [event.id],
        summary: `Marked task '${task.title}' as done.`,
        data: { task_id: task.id },
      },
      events: [event],
      nextState: { ...state, tasks: nextTasks },
    };
  }

  if (!hasOtherFields && args.status === 'cancelled' && task.status !== 'cancelled') {
    const event = createLedgerEvent(context, nextSequence, {
      entity_id: task.entity_id,
      kind: 'task_cancelled',
      payload: { task_id: task.id },
      provenance: 'stated',
    });
    const nextTasks = new Map(state.tasks);
    reduceTasks(nextTasks, event);
    return {
      result: {
        status: 'applied',
        action_id: context.action_id,
        affected_resource_ids: [task.id],
        event_ids: [event.id],
        summary: `Cancelled task '${task.title}'.`,
        data: { task_id: task.id },
      },
      events: [event],
      nextState: { ...state, tasks: nextTasks },
    };
  }

  // General task update (snooze, due, title, assignee)
  const event = createLedgerEvent(context, nextSequence, {
    entity_id: task.entity_id,
    kind: 'task_updated',
    payload: {
      task_id: task.id,
      title: args.title,
      due: args.due,
      snooze_until: args.snooze_until,
      status: args.status,
    },
    provenance: 'stated',
  });

  const nextTasks = new Map(state.tasks);
  reduceTasks(nextTasks, event);

  return {
    result: {
      status: 'applied',
      action_id: context.action_id,
      affected_resource_ids: [task.id],
      event_ids: [event.id],
      summary: `Updated task '${task.title}'.`,
      data: { task_id: task.id },
    },
    events: [event],
    nextState: { ...state, tasks: nextTasks },
  };
}
