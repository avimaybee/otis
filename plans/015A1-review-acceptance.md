# 015A.1 — independent reviewer acceptance

Codex reviewer, 2026-10-04. Current dirty tree on `663f0b3`; no commit or deployment. ACCEPTED for the narrow changed-only projection persistence scope. Other 015 tasks remain unassigned. Source reviewed personally; no reviewer subagents.

## Reviewed implementation

Read the complete `packages/ledger/src/repository/executor.ts` diff (+380/-89), the new `apps/worker/test/ledger-footprint.integration.test.ts`, and the evidence followup. Immutable persisted-value fingerprints are captured before reducers run; writes/deletes use the changed sets and prior keys. FTS transitions use prior memory flags. The existing committing guards, event/receipt/revision/quota path and domain handlers remain in place. Full-state loading is unchanged.

The current measured rename regression requires D1 metadata and asserts 16 statements and 21 reported row writes at both workspace sizes (6 versus 40 seeded entities, with other fixture records). Reported reads grow with size. `.first()` does not expose metadata in this wrapper: those calls count as statements but are excluded from the measured read-row total. These are local workerd measurements, not deployed billing forecasts or a guarantee that every command costs 21 writes.

The new true-tail failure wrapper appends its invalid statement after the production batch; it proves rollback with unchanged target value/revision and absent receipt. The expired-lease case rejects with fence_conflict and checks target/revision/receipt. The final replay-equivalence test and existing actor/ledger/memory tests provide additional coverage. Do not describe each new test as individually asserting every durable table: the explicit assertions are narrower.

The implementation agent reported separate before/after minimal-fixture baseline numbers obtained through a temporary stash and a deleted probe. The reviewer did not independently reproduce that deleted probe; those baseline totals are not acceptance evidence. Do not repeat that work merely to obtain a headline percentage. Current measured scaling assertions, direct diff review and working invariants establish the narrow change.

## Checks independently run against current source

- `pnpm test`: 595 passed / 43 files, exit 0 (2026-10-04 12:54:57, 56s). Includes ledger footprint, ledger, actor and memory suites. Known localhost:3000 connection-error noise occurred; no test failed, and this is not a successful live-provider claim.
- `pnpm typecheck`: exit 0.
- `pnpm lint`: exit 0.
- `pnpm build`: exit 0; Vite, TypeScript and Wrangler dry run. Existing bundle-size and Wrangler-version warnings are not new source blockers; no dependency upgrade assigned.
- Earlier `git diff --check`: exit 0 with existing LF/CRLF warnings; repeat after documentation updates.

Use of `TEMP`/`TMP=D:\wtmp` avoids the limited C: temporary space. Source implementation remains uncommitted. No remote migrations, provider calls, Telegram sends or deployment were part of this review.

## Next work

No additional ledger refactor is required by this acceptance. Follow `013-dogfood-execution-order.md`: reviewer-authored 009A text capture/reply/retrieval handoff next. Full web transport remains separate. Acceptance here does not close the whole 015 efficiency proposal or claim usable Telegram today.
