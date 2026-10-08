> Closed historical plan record, reconciled 2026-10-07 from `plans/006-review-round6.md`. Family 006: core loop/memory present; grounding/recovery/quality partial. Remaining R02, R03, R04, R13 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# Gate 006 repair review — round 6 (independent, 2026-10-02)

Reviewed HEAD `859ed92` plus the current uncommitted tree in `D:\vs code\Otis`.
No commits, pushes, deployments, or live inference. No source edits.
Added: this document. Retained: `plans/review-evidence/006-a9fk.repro.test.ts`
(round-5 FK probe, now passing). A temporary R2-03/R2-04/R2-05 execution
probe was removed after capturing evidence (logs in `D:\wtmp\round5-verify*.log`).

**Verdict: ACCEPTED for the stated bounded scope.** Gate 006's required
conversational-agent and durable-memory behavior is demonstrated by live
source and complete-flow tests. Details below.

## Commands actually executed and observed outcomes

From `D:\vs code\Otis` with `$env:TEMP='D:\wtmp'` and `$env:TMP='D:\wtmp'`:

- Round-5 FK probe (`006-a9fk`): **1 passed** — bare undo of an entity
  creation with a prior applied quote in the workspace now completes and the
  entity is removed. The probe file is unmodified from round 5 (verified by
  read); it was not neutered.
- 7 original defect probes: **7 failed** — all previously probed defects
  remain eliminated (failing is the desired outcome for bad-behavior probes).
- `pnpm typecheck`: exit 0. `pnpm lint`: exit 0, 0 errors, 0 warnings.
- `pnpm test`: **26 files, 326 passed**, exit 0 (~24 s).
- `pnpm eval:agent`: exit 0 (1 test / 14 scripted fixtures).
- `pnpm build`: exit 0 (Vite + tsc + Wrangler dry-run; not a deployment).
- `git diff --check`: exit 0.

## Round-5 blockers: both closed with evidence

### N1 — undo FK crash: FIXED and verified

- Fix (source-verified): `computeUndoPreview` scopes removal reporting to
  `createdEntityIds`/`createdTaskIds` of the reverted action
  (`undo.ts:64-100,128-173`); `handleUndoCommit` preserves non-reverted
  entities/tasks in `nextState` (`undo.ts:259-285`); executor deletes
  dependents before parents. Scoping is conservative (reverted IDs stay
  deleted; unrelated rows can no longer be swept into deletions).
- Owning regressions: `A9_suffix_undo` and `A9_explicit_undo` now run in
  shared `chat1` behind A1's applied quotes — the exact crashing shape —
  asserting completion, projection removal, revert event, and rebuild match.
  Both pass in full-file order; the FK probe passes standalone.
- Fair caveat: D1 never names the failing statement, so the precise
  constraint behind the original crash is behaviorally (not forensically)
  established. Behavior + rebuild-equality coverage is what acceptance rests
  on, and both hold.

### N2 — bulk approval dead end: FIXED and verified

- Fix (source-verified): `resumeRun` parses the stored payload and only takes
  the ledger branch for real ledger commands; `bulk_operation` falls through
  to standard resumption (`dispatch.ts:1383-1404`), requeueing the run; the
  handler then executes the saved proposal under `approvedBulkScope` or
  completes cancelled on rejection (`handler.ts:252-276`).
- Owning regressions: approval test asserts pause → versioned
  `bulk_operation` payload → `resumed:true` → duplicate answer rejected →
  fresh-handler restart → `completed` with 4 applied receipts and 4 entities;
  rejection test asserts `completed` with 0 commits. Both pass.

## Coverage gaps from round 5: closed where required

- Wire dedup is now pinned at the HTTP body
  (`provider-gemini.test.ts:346-368`: exactly one `function_result` per call).
- Bulk approval/rejection execute end to end in the owning suite (above).
- Composed D1 eval covers A1/A6/A9×2/A11/A13/A14 against real tables.
- Residual, non-blocking: changed-scope-needs-new-approval and split-call
  threshold-evasion variants are code-present (`approvedBulkScope` diffing)
  but not executed; recommend them as hardening follow-ups, not a gate.

## Standing of earlier findings

R2-01 (revision-guarded publish-before-complete + exhaustion handling, row
asserted), R2-02 (commit-boundary quota guard + increment, fail-fast budgets,
round cap; counter rows asserted), R2-04 (v1 control payload → resume →
single task; executed), R2-06 (FTS restore + replay equality), and R2-08
hygiene items were verified in round 5 and remain green in the current suite.
The F12 composed-evaluation demand is now substantially met by the 7-fixture
D1 suite plus restart/duplicate coverage in the bulk test; the offline runner
stays correctly labeled as unmeasured.

## Limitations

Local workerd/D1, fake providers, mocked HTTP only. No deployed service,
browser/device, live-model, cost/latency, or dependency audit. Secrets never
read. One full-suite run during this review showed load-flake timeouts under
concurrent background suites; the serial re-run is fully green — run
verification serially. The implementation agent edited the tree during this
review (including viewing the retained probe); all verdict-critical evidence
above was executed on the final tree.

## Next

Gate 006 is DONE (local evidence only). Gate 007 becomes eligible as the next
bounded gate. Suggested hardening backlog (not gates): changed-scope and
split-call bulk variants; deeper composed restart/duplicate/memory-lifecycle
fixtures; statement-level D1 error attribution if the platform ever exposes
it. No new infrastructure.
