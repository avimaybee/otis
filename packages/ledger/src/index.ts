/**
 * @otis/ledger
 * Append-only auditable event ledger, deterministic state projections,
 * and transactional command boundaries for Otis.
 * In accordance with architecture.md sections 5, 8-10, docs/contracts.md, and plans/002-ledger.md.
 */

// Types & Contracts re-export
export * from './types.js';

// Reducers & Replay
export { reduceEntity } from './reducers/entities.js';
export { reduceFields } from './reducers/fields.js';
export { reduceTasks } from './reducers/tasks.js';
export { reduceDrafts } from './reducers/drafts.js';
export { rebuildProjections } from './reducers/rebuild.js';

// Command Handlers & Factory
export { assertEventInvariant, createLedgerEvent } from './commands/events.js';
export { handleCreateEntity } from './commands/createEntity.js';
export { handleRenameEntity, handleAddAlias } from './commands/renameEntity.js';
export { handleLogEvent } from './commands/logEvent.js';
export { handleSetField } from './commands/setField.js';
export { handleCreateTask, handleUpdateTask } from './commands/tasks.js';
export { handleResolveConflict } from './commands/resolveConflict.js';
export { handleRecordDraft } from './commands/recordDraft.js';
export { computeUndoPreview, handleUndoCommit } from './commands/undo.js';
export { findPotentialDuplicate, normalizeName, levenshteinDistance } from './commands/similarity.js';

// Repository & Transaction Executor
export {
  executeLedgerCommand,
  resumePendingClarification,
  DEFAULT_COMMAND_HANDLERS,
  type CommandHandler,
  type AnyCommandHandler,
  type ResumeClarificationOptions,
} from './repository/executor.js';
export {
  getActionReceipt,
  getWorkspaceRevision,
  getWorkspaceEvents,
  getWorkspaceActions,
  getWorkspaceProjectionState,
} from './repository/queries.js';
