> Closed historical plan record, reconciled 2026-10-07 from `plans/015A1-review-followup.md`. Family 015: 015A.1 and parts of 015B present; reads/guards/retention partial; concurrency optional. Remaining R09, R13 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# 015A.1 independent review followup — evidence gaps

2026-10-04, current dirty tree on 663f0b3. Reviewed the complete executor diff and new cost fixture personally. No own subagents. Independent focused run: ledger-footprint + ledger + actor, 61 tests / 3 files passed; typecheck and lint passed; diff check passed with existing newline warnings. This is not full-suite or deployed proof.

## Implementation assessment
- Narrow existing-boundary change; immutable value snapshots captured before handlers, changed-only statements, delete bindings preserved, original transactional guard and durable receipts/revisions kept. No demonstrated new source regression from current reads/tests.
- Do not broaden scope or add a framework. Full-state reads and live transport remain separate work.

## Required evidence repair before acceptance
1. `apps/worker/test/ledger-footprint.integration.test.ts` records rowsRead/rowsWritten/metaSeen but never asserts or emits them. The rename test only asserts statement count. Assert metadata exists, compare actual successful writes for small/large operations, and retain sanitized measured results for both sizes. Missing `.first()` metadata must remain explicitly excluded from read totals. Published numbers cannot substitute for a regression assertion.
2. The fixture titled revision/membership/fence does not execute a fence case. Cover a real stale/expired fenced command with zero event/receipt/projection/revision changes, or reference the independently rerun existing actor/ledger fence cases and correct the new fixture title/evidence claims. Do not invent coverage.
3. The fixture's late duplicate-PK failure is passed through extraStatements; executor appends these immediately after the guard, before entities/events/receipts. It does not prove failure after business mutations. In a test-only counted DB batch wrapper, append the deliberately invalid statement at the true end of the production-generated batch; prove target value, events, receipt, revision and quota all unchanged. Keep no production hook or new abstraction. Failure metadata unavailable is not measured zero cost.
4. Required before/after actual cost proof is incomplete: baseline SMALL has only failed statement assertion output and LARGE is code counted. Record a controlled baseline for both sizes from the original executor (without replacing the current source or clobbering dirty work), plus current metadata. If local runtime baseline invocation cannot produce metrics, state limitation and provide reproducible evidence without calling it measured.

## Additional bounded coverage
Run existing memory integration cases for Undo-of-forget restoring FTS and Undo-of-note removing it; these are relevant to the transition-only FTS optimization. No need to duplicate all existing tests in the new fixture.

## Handoff
Only repair these tests/evidence and misleading completion claims. Preserve the current source implementation unless a concrete regression emerges. Root tests/typecheck/lint/build and diff check once after the evidence changes. Remain review pending, uncommitted, no deploy.
