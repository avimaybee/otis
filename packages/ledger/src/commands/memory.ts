/**
 * @otis/ledger/commands/memory
 * Command handlers for remember_context and forget_memory.
 * In accordance with docs/archive/plans/006-implementation-handoff.md Section 5 & 9.
 */

import type {
  CommandResult,
  LedgerEvent,
  MemoryForgottenPayload,
  MemoryNotePayload,
} from '@otis/contracts';
import type {
  ForgetMemoryArgs,
  LedgerCommandContext,
  LedgerProjectionState,
  RememberContextArgs,
} from '../types.js';
import { createLedgerEvent } from './events.js';
import { reduceMemory } from '../reducers/memory.js';

const VALID_SCOPES = new Set(['workspace', 'entity', 'member_in_workspace']);
const VALID_CATEGORIES = new Set([
  'communication_preference',
  'relationship_context',
  'workflow_context',
  'other_context',
]);

export function handleRememberContext(
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: RememberContextArgs,
): {
  result: CommandResult;
  events: LedgerEvent[];
  nextState?: LedgerProjectionState;
} {
  if (!args || typeof args !== 'object') {
    return {
      result: {
        status: 'rejected',
        action_id: context.action_id,
        error: { code: 'invalid_args', message: 'Missing remember_context arguments.' },
      },
      events: [],
    };
  }

  // 1. Validate scope
  if (!args.scope || !VALID_SCOPES.has(args.scope)) {
    return {
      result: {
        status: 'rejected',
        action_id: context.action_id,
        error: {
          code: 'invalid_scope',
          message: `Scope must be 'workspace', 'entity', or 'member_in_workspace'. Received '${String(args.scope)}'.`,
        },
      },
      events: [],
    };
  }

  // 2. Validate subject
  if (args.scope === 'workspace') {
    if (args.subject_id !== null && args.subject_id !== undefined && args.subject_id !== '') {
      return {
        result: {
          status: 'rejected',
          action_id: context.action_id,
          error: {
            code: 'invalid_subject',
            message: "Workspace scope cannot specify a subject_id.",
          },
        },
        events: [],
      };
    }
  } else if (args.scope === 'entity') {
    if (!args.subject_id || typeof args.subject_id !== 'string' || !args.subject_id.trim()) {
      return {
        result: {
          status: 'rejected',
          action_id: context.action_id,
          error: {
            code: 'missing_subject',
            message: "Entity-scoped memory requires an entity subject_id.",
          },
        },
        events: [],
      };
    }
    const entity = state.entities.get(args.subject_id);
    if (!entity) {
      return {
        result: {
          status: 'rejected',
          action_id: context.action_id,
          error: {
            code: 'entity_not_found',
            message: `Entity '${args.subject_id}' not found in workspace.`,
          },
        },
        events: [],
      };
    }
  } else if (args.scope === 'member_in_workspace') {
    if (!args.subject_id || typeof args.subject_id !== 'string' || !args.subject_id.trim()) {
      return {
        result: {
          status: 'rejected',
          action_id: context.action_id,
          error: {
            code: 'missing_subject',
            message: "Member-scoped memory requires a member user subject_id.",
          },
        },
        events: [],
      };
    }
  }

  // 3. Validate category
  if (!args.category || !VALID_CATEGORIES.has(args.category)) {
    return {
      result: {
        status: 'rejected',
        action_id: context.action_id,
        error: {
          code: 'invalid_category',
          message: `Invalid category '${String(args.category)}'.`,
        },
      },
      events: [],
    };
  }

  // 4. Validate content
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  if (!content || content.length > 4000) {
    return {
      result: {
        status: 'rejected',
        action_id: context.action_id,
        error: {
          code: 'invalid_content',
          message: 'Memory content must be between 1 and 4000 characters.',
        },
      },
      events: [],
    };
  }

  // 5. Validate supersedes_memory_id if present
  if (args.supersedes_memory_id) {
    const existing = state.memoryEntries.get(args.supersedes_memory_id);
    if (!existing) {
      return {
        result: {
          status: 'rejected',
          action_id: context.action_id,
          error: {
            code: 'memory_not_found',
            message: `Target memory entry '${args.supersedes_memory_id}' to supersede was not found.`,
          },
        },
        events: [],
      };
    }
    if (existing.status !== 'active') {
      return {
        result: {
          status: 'conflict',
          action_id: context.action_id,
          error: {
            code: 'memory_inactive',
            message: `Target memory entry '${args.supersedes_memory_id}' is '${existing.status}', not active.`,
          },
        },
        events: [],
      };
    }
  }

  const memoryId = args.memory_id || `mem_${crypto.randomUUID()}`;

  const payload: MemoryNotePayload = {
    memory_id: memoryId,
    scope: args.scope,
    subject_id: args.subject_id || null,
    category: args.category,
    content,
    supersedes_memory_id: args.supersedes_memory_id || null,
  };

  const event = createLedgerEvent<MemoryNotePayload>(context, nextSequence, {
    kind: 'memory_note',
    entity_id: args.scope === 'entity' ? args.subject_id : null,
    payload,
    provenance: args.provenance || 'stated',
  });

  const nextState: LedgerProjectionState = {
    entities: new Map(state.entities),
    aliases: new Map(state.aliases),
    fields: new Map(state.fields),
    interactions: new Map(state.interactions),
    tasks: new Map(state.tasks),
    drafts: new Map(state.drafts),
    memoryEntries: new Map(state.memoryEntries),
    memorySuppressions: new Map(state.memorySuppressions),
  };

  reduceMemory(nextState.memoryEntries, nextState.memorySuppressions, event);

  return {
    result: {
      status: 'applied',
      action_id: context.action_id,
      affected_resource_ids: [memoryId],
      event_ids: [event.id],
      committed_revision: nextSequence,
      summary: `Remembered ${args.scope} context (${args.category}).`,
      data: { memory_id: memoryId },
    },
    events: [event],
    nextState,
  };
}

export function handleForgetMemory(
  context: LedgerCommandContext,
  state: LedgerProjectionState,
  nextSequence: number,
  args: ForgetMemoryArgs,
): {
  result: CommandResult;
  events: LedgerEvent[];
  nextState?: LedgerProjectionState;
} {
  if (!args || typeof args !== 'object' || !args.memory_id) {
    return {
      result: {
        status: 'rejected',
        action_id: context.action_id,
        error: { code: 'missing_memory_id', message: 'Missing memory_id in forget_memory.' },
      },
      events: [],
    };
  }

  const target = state.memoryEntries.get(args.memory_id);
  if (!target) {
    return {
      result: {
        status: 'rejected',
        action_id: context.action_id,
        error: {
          code: 'not_found',
          message: `Memory entry '${args.memory_id}' not found.`,
        },
      },
      events: [],
    };
  }

  if (target.status === 'forgotten') {
    return {
      result: {
        status: 'already_applied',
        action_id: context.action_id,
        summary: `Memory entry '${args.memory_id}' is already forgotten.`,
      },
      events: [],
    };
  }

  if (target.status === 'superseded') {
    return {
      result: {
        status: 'conflict',
        action_id: context.action_id,
        error: {
          code: 'already_superseded',
          message: `Memory entry '${args.memory_id}' is already superseded.`,
        },
      },
      events: [],
    };
  }

  const payload: MemoryForgottenPayload = {
    memory_id: args.memory_id,
    rationale: args.rationale,
  };

  const event = createLedgerEvent<MemoryForgottenPayload>(context, nextSequence, {
    kind: 'memory_forgotten',
    entity_id: target.scope === 'entity' ? target.subject_id : null,
    payload,
    provenance: 'stated',
  });

  const nextState: LedgerProjectionState = {
    entities: new Map(state.entities),
    aliases: new Map(state.aliases),
    fields: new Map(state.fields),
    interactions: new Map(state.interactions),
    tasks: new Map(state.tasks),
    drafts: new Map(state.drafts),
    memoryEntries: new Map(state.memoryEntries),
    memorySuppressions: new Map(state.memorySuppressions),
  };

  reduceMemory(nextState.memoryEntries, nextState.memorySuppressions, event);

  return {
    result: {
      status: 'applied',
      action_id: context.action_id,
      affected_resource_ids: [args.memory_id],
      event_ids: [event.id],
      committed_revision: nextSequence,
      summary: `Forgotten memory entry '${args.memory_id}'.`,
      data: { memory_id: args.memory_id },
    },
    events: [event],
    nextState,
  };
}
