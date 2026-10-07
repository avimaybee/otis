/**
 * @otis/ledger/reducers/tasks
 * Reducer for tasks projection, typed due dates, status lifecycle, and snooze.
 */

import type { LedgerEvent, Task, TaskCreatedPayload, TaskUpdatedPayload } from '@otis/contracts';

export function reduceTasks(
  tasks: Map<string, Task>,
  event: LedgerEvent,
): void {
  switch (event.kind) {
    case 'task_created': {
      const p = event.payload as TaskCreatedPayload;
      const task: Task = {
        id: p.task_id,
        workspace_id: event.workspace_id,
        entity_id: p.entity_id || null,
        title: p.title,
        assignee_user_id: p.assignee_user_id || null,
        status: 'open',
        due_kind: p.due ? p.due.kind : null,
        due_local_date: p.due && p.due.kind === 'date' ? p.due.local_date : null,
        due_instant: p.due && p.due.kind === 'instant' ? p.due.at : null,
        due_timezone: p.due ? p.due.timezone : null,
        snooze_until: null,
        // Old task_created rows predate both markers and reduce to false,
        // preserving their historical selection behavior exactly.
        explicit_no_deadline: p.explicit_no_deadline === true,
        is_promise: p.is_promise === true,
        source_event_id: event.id,
        revision: 1,
        created_at: event.recorded_at,
        updated_at: event.recorded_at,
      };
      tasks.set(p.task_id, task);
      break;
    }

    case 'task_updated': {
      const p = event.payload as TaskUpdatedPayload;
      const task = tasks.get(p.task_id);
      if (task) {
        if (p.title !== undefined) task.title = p.title;
        if (p.assignee_user_id !== undefined) task.assignee_user_id = p.assignee_user_id;
        if (p.due !== undefined) {
          task.due_kind = p.due ? p.due.kind : null;
          task.due_local_date = p.due && p.due.kind === 'date' ? p.due.local_date : null;
          task.due_instant = p.due && p.due.kind === 'instant' ? p.due.at : null;
          task.due_timezone = p.due ? p.due.timezone : null;
        }
        if (p.snooze_until !== undefined) {
          // Snooze updates notification timing only; it preserves the original due date
          task.snooze_until = p.snooze_until;
        }
        if (p.status !== undefined) task.status = p.status;
        task.revision += 1;
        task.updated_at = event.recorded_at;
      }
      break;
    }

    case 'task_done': {
      const p = event.payload as { task_id: string };
      const task = tasks.get(p.task_id);
      if (task) {
        task.status = 'done';
        task.revision += 1;
        task.updated_at = event.recorded_at;
      }
      break;
    }

    case 'task_cancelled': {
      const p = event.payload as { task_id: string };
      const task = tasks.get(p.task_id);
      if (task) {
        task.status = 'cancelled';
        task.revision += 1;
        task.updated_at = event.recorded_at;
      }
      break;
    }
  }
}
