/**
 * @otis/brief
 *
 * Deterministic chosen-time brief kernel (plan 011 slice 011A): schedule
 * evaluation, item selection, stable save ordering and plain-text fallback.
 * Pure library: no DB writes, no delivery, no model calls. Integration owns
 * persistence, outbox, rendering locale and Telegram delivery.
 *
 * Input shapes mirror `MemberSettings` brief fields and the ledger `Task`
 * projection structurally; this package is intentionally dependency-free so
 * the kernel cannot drift with shared-code refactors unnoticed.
 */

export * from './schedule.js';
export * from './selection.js';
export * from './brief.js';
