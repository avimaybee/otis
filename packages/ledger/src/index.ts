/**
 * @otis/ledger
 * Append-only auditable event ledger, deterministic state projections,
 * and transactional command boundaries for Otis.
 * In accordance with architecture.md sections 5, 8-10, docs/contracts.md, and docs/archive/plans/002-ledger.md.
 */

// Types & Contracts re-export
export * from './types.js';

// Reducers & Replay
export { reduceEntity } from './reducers/entities.js';
export { formatQuoteText, reduceFields } from './reducers/fields.js';
export { reduceTasks } from './reducers/tasks.js';
export { reduceDrafts } from './reducers/drafts.js';
export { reduceMemory } from './reducers/memory.js';
export { rebuildProjections } from './reducers/rebuild.js';

// Command Handlers & Factory
export { assertEventInvariant, createLedgerEvent } from './commands/events.js';
export { handleCreateEntity } from './commands/createEntity.js';
export { handleRenameEntity, handleAddAlias } from './commands/renameEntity.js';
export { handleDeleteEntity } from './commands/deleteEntity.js';
export { handleLogEvent } from './commands/logEvent.js';
export { handleReviseInteraction, handleRemoveInteraction } from './commands/interactions.js';
export {
  validateInteractionPayload,
  INTERACTION_KINDS,
  type InteractionKind,
  type InteractionPayloadValidation,
} from './commands/interactionPayload.js';
export { reduceInteractions } from './reducers/interactions.js';
export { handleSetField, ALLOWED_CORE_FIELDS, VALID_LEAD_STATUSES } from './commands/setField.js';
export {
  handleSetFields,
  normalizeStatusResumeAnswer,
  STATUS_CONFIRM_WORDS,
  STATUS_DECLINE_WORDS,
  type SetFieldsAppliedData,
  type StatusResumeDecision,
} from './commands/setFields.js';
export { handleCreateTask, handleUpdateTask } from './commands/tasks.js';
export { handleResolveConflict } from './commands/resolveConflict.js';
export { handleRecordDraft } from './commands/recordDraft.js';
export { handleMarkMessageSent } from './commands/markMessageSent.js';
export { handleRememberContext, handleForgetMemory } from './commands/memory.js';
export { computeUndoPreview, handleUndoCommit } from './commands/undo.js';
export {
  findPotentialDuplicate,
  rankEntityMatches,
  computeSimilarityScore,
  foldDiacritics,
  canonicalCaseFold,
  normalizeName,
  levenshteinDistance,
  MATCH_MIN_SCORE,
  MATCH_MIN_MARGIN,
  type EntityMatchCandidate,
  type EntityMatchResult,
} from './commands/similarity.js';

// Repository & Transaction Executor
export { readCurrentInteractions, resolveInteractionEntities } from './repository/interactions.js';
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
  getActionReceiptsByIds,
  getFieldProjectionState,
  getInteractionProjectionState,
  getLogEventProjectionState,
  getQuestionByAction,
  getWorkspaceRevision,
  getWorkspaceEvents,
  getWorkspaceActions,
  getWorkspaceProjectionState,
} from './repository/queries.js';
export { CURRENT_INTERACTION_COLUMNS, CURRENT_INTERACTION_JOINS, mapCurrentInteraction } from './repository/interactions.js';
export { handleChangeContact, validContactValue } from './commands/contacts.js';
export { handleLinkAttachment, handleUnlinkAttachment } from './commands/attachments.js';
export { handleMergeEntities, previewEntityMerge } from './commands/mergeEntity.js';
export { getBusinessProjectionState } from './repository/queries.js';
export { ENTITY_FAMILY_SQL, familyBinds } from './repository/canonical.js';
export { contactComparison } from './reducers/business.js';
