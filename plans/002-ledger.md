# Plan 002: Make the event ledger the only writer of business state

> Executor: work only after plan 001's commands pass. Read product.md sections 5, 7, 8.1, 8.2, 12.2–12.3 and Appendix A. This plan implements deterministic business state without a model or channel. Check document drift against the baseline in plans/README.md and inspect the current migrations before editing.

## Status

- Priority P0; effort L; risk high; category correctness/data; depends on 001.
- Planned at unversioned document snapshot, 2026-09-29. After Git exists, replace this with the current commit in the implementation PR and review intervening migration changes.

## Why and current state

Product.md requires an append-only events table, derived entity_state/tasks, conflict status, attributed writes, and revert events. It defines core status as new/cold/warm/hot/won/lost/deprioritized and task status as open/done/cancelled; snooze is a timestamp. No schema or ledger code exists. This is the highest-risk foundation: channel or model code must never write business tables directly.

## Scope

Modify packages/ledger, packages/contracts, migrations, Worker binding/repository wiring only as needed, and ledger tests. Do not build UI, call a model, send Telegram messages, or implement custom field creation (Phase 2). Use D1 for events and projections. Scope every business query by workspace ID. Identity/routing tables are handled in later plans.

## Required data and behavior

Migrate workspaces' business records: entities and aliases; events with event ID, workspace, entity optional, actor, kind, body/data, occurred_at and recorded_at UTC, channel, exactly one of source_message_id/source_job_id, optional reverts_event_id and untrusted flag; entity_state with clear/disputed status, nullable current value, provenance, candidate event IDs and historical last-confirmed value; tasks with assignee, reason_key, due/snooze, and source event; drafts can be migrated here but draft behavior belongs to plan 012. Unique indexes must prevent duplicate event/action IDs and duplicate revert of the same action. Keep custom field definitions possible but do not seed sheet projection columns as field definitions.

Implement one ledger command boundary: log a note/contact/visit/quote, set a core value, create/update task, record an explicit draft/sent event, resolve a dispute, and undo by stable action ID. Validate the actor and workspace before transaction. Each command appends event and updates projection in one D1 batch/transaction, and returns event/action IDs plus before/after summary for Working. Rebuild projection from events in deterministic order (recorded_at plus event ID tie-break, with occurred_at preserved as business time). A revert excludes the targeted effect while retaining both events in history. If another write depends on the reverted one, return needs_clarification instead of rolling it back. Reverting one disputed candidate recomputes from remaining non-reverted claims; clear only when one current value remains. Reject untrusted forwarded text as a source of field/task writes.

## Proposed file map and verification commands

These paths are targets to create or extend; the repository has no source files at planning time. In scope: migrations/0001_business.sql (or the first migration after scaffold); packages/ledger/src/schema.ts, reducer.ts, repository.ts, service.ts, undo.ts; packages/ledger/test/rebuild.test.ts, service.test.ts; packages/contracts/src/business.ts. Keep migration numbering monotonic.

Verification after plan 001 establishes the scripts: pnpm typecheck; pnpm lint; pnpm test; pnpm build. The ledger-focused Vitest invocation must run all rebuild, dispute, undo and cross-workspace cases. Do not report a command as passed if it has not run. If a proposed path conflicts with the scaffold, preserve the module boundary and document the exact mapping before editing. Do not push or open a PR unless the operator asks.

## Steps and verification

1. Write D1 migrations and typed repository interfaces. Include indexes on workspace/entity/time, workspace/task status+assignee, and event source/action IDs. Verify local migration applies to a fresh database and a second run is safe; pnpm typecheck exits 0.
2. Implement pure reducers for field and task projections. Feed them canonical ordered events, including corrections and reverts. Verify pnpm test --filter ledger (or the exact equivalent established in 001) passes fixtures A1–A4 and A9 adapted to pure events.
3. Implement D1 ledger transactions and workspace-scoped read repositories. Compare a live projection with a full rebuild after each fixture. Verify Worker integration tests pass for atomic append+projection, duplicate action IDs, cross-workspace IDs, and simulated failure between commands.
4. Add explicit dispute and undo tests: Avi reports 3500, Hunor reports 3600; current value becomes null/disputed, history retains both; resolution clears; undo of one candidate recomputes; an unrelated later edit survives undo; an ambiguous dependent edit returns a clarification result. Verify root pnpm test, typecheck, lint, build all pass.

## Done criteria

No non-ledger module has a write-capable D1 repository for events/entity_state/tasks/field_defs. Each applied command has one stable action ID and produces a rebuild-equivalent projection. No test writes across workspaces. A failed transaction leaves neither orphaned event nor changed projection. Test source_event/source_job exclusivity and last-user attribution. The documented reset/erase flow is not implemented here.

## STOP conditions and maintenance

Stop if D1 cannot atomically perform the chosen event+projection batch, if the product's desired undo conflicts with a later dependent write that cannot be identified, or if a migration changes event meaning without a rebuild strategy. Report examples. Reviewer should inspect every mutation path and ensure future field types pass through the same ledger rather than bypassing it.
