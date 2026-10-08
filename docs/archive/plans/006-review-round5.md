> Closed historical plan record, reconciled 2026-10-07 from `plans/006-review-round5.md`. Family 006: core loop/memory present; grounding/recovery/quality partial. Remaining R02, R03, R04, R13 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# Gate 006 repair review — round 5 (independent, 2026-10-02)

Reviewed HEAD `859ed92` plus the current uncommitted tree in `D:\vs code\Otis`.
No commits, pushes, deployments, or live inference. No source edits.
Added: this document and one diagnostic probe
(`plans/review-evidence/006-a9fk.repro.test.ts`). A second temporary probe
used to execute the R2-03/R2-04/R2-05 repair paths was removed after capturing
evidence (logs retained in `D:\wtmp\round5-verify*.log`); its scenarios belong
in the owning suites, not in review-evidence.

**Verdict: NOT ACCEPTED.** Gate 006 stays `IMPLEMENTED; review fixes required`.
Gate 007 is not eligible.

Real progress since round 4: the seven original defect probes now fail
(defects gone), budgets/quotas/refresh/FTS/control/wire repairs verified
working, and a composed D1 eval suite exists. Two new P1 blockers were found
by executing the repaired paths end to end — one crash, one dead end — plus
regression-coverage gaps for two repaired paths.

## Commands actually executed and observed outcomes

From `D:\vs code\Otis` with `$env:TEMP='D:\wtmp'` and `$env:TMP='D:\wtmp'`
(`D:\wtmp` confirmed present):

- 7-probe defect suite (`006-review.config.ts` + `006-repair-agent/memory`):
  2 files, **7 failed** — all seven originally probed defects eliminated.
  (Failing is the desired outcome for bad-behavior probes.)
- `pnpm typecheck`: exit 0.
- `pnpm lint`: exit 0, 0 errors, 0 warnings (includes the retained probe).
- `pnpm test`: **26 files, 323 passed**, exit 0, ~22 s. An earlier full run
  during this review showed 9 `Test timed out in 5000ms` failures across 6
  files; a clean re-run passed fully. Those timeouts were environmental load
  (concurrent background suites in the same checkout), not product failures —
  but see the process note below.
- `pnpm eval:agent`: exit 0, 1 test (14 scripted fixtures inside).
- `pnpm build`: exit 0 (Vite + tsc + Wrangler dry-run; not a deployment).
- `git diff --check`: exit 0 (CRLF warnings pre-existing).

## Repairs independently verified as working

- **R2-01 refresh publication**: `memory.ts:330-391` publishes while guarded
  (claim + expiry + `target_revision` + live `business_revision` CAS equality)
  before completing; exhausted/expired jobs terminally fail (`memory.ts:228-237`
  + catch path). Normal test 11 asserts a published summary row with matching
  `built_from_revision`. Minor oddity (not a blocker): the revision-mismatch
  early path completes the job without incrementing `completed`, so the old
  probe now fails on the count rather than the row — counting semantics only.
- **R2-02 budgets/quotas**: commit-boundary `COALESCE(...action_count...)`
  guard + upsert increment in `executor.ts:157-210,946-958` and
  `settings.ts:287-303,352-365`; handler fail-fast `missing_budgets`
  (`handler.ts:82-95`), `maxRoundsPerRun` (`handler.ts:351`), env wiring
  (`index.ts:85-95`). Normal tests assert counter row = 1, second mutation
  rejected, missing budgets refused, round cap enforced.
- **R2-04 control clarification**: executed end to end — versioned
  (`version:1`, `command_name:create_task`) payload persisted, `resumed:true`,
  exactly one intended task committed, run completed.
- **R2-05 wire dedup**: executed end to end — handler emits latest-round
  results only via `pendingToolResults` (`handler.ts:404-461`), adapter
  suppresses already-seen call IDs (`gemini.ts:83-159`); mocked-HTTP body
  carries exactly one `function_result` for the call.
- **R2-06 FTS forget→undo**: normal test 8b asserts FTS restore (1 row) and
  replay equality. (Narrow remember→undo path was already fine.)
- **R2-08 hygiene items** (source-traced): live `this.nowIso()` at step
  persist/complete (`handler.ts:680,709`), `sourceTrust` threaded
  (`handler.ts:697`), disputed-field draft gate (`repository.ts:616-656`),
  sent-confirmation gate (`repository.ts:675+`), chat-scoped bare undo
  (`repository.ts:728-780`), identity-filter transcript exclusion
  (`context.ts:150-155`).

## Blocking findings

### N1 — P1 (new): undo of an entity creation crashes with FK violation when a prior applied quote exists

- **Trigger (minimal, executed fresh on current source):** commit one
  `log_event` quote, commit one `upsert_entity` creation, then bare
  `undo(mode:single)` (or explicit undo of the creation — both fail).
  Waiting runs are not required; a single prior applied quote suffices.
  Isolation (creation alone) passes; waiting-run-only pollution passes.
- **Actual:** run ends `failed`/`handler_error`:
  `D1_ERROR: FOREIGN KEY constraint failed`, poison after retries; the undo
  never applies and the entity remains.
- **Expected:** the revert commits atomically regardless of unrelated prior
  actions in the workspace; single-action undo is a core product promise.
- **Evidence:** `plans/review-evidence/006-a9fk.repro.test.ts` (retained);
  `D:\wtmp\round5-fk*.log`. The composed A9 test passes only because it was
  rewritten to use a fresh chat (`agent-composed-eval…test.ts:295`), which
  dodges this exact scenario instead of covering it.
- **Smallest repair:** fix the undo commit batch under multi-action state
  (statement ordering / projection-diff scope for the revert path), then add
  the shared-chat variant (prior quote + creation + bare undo) to the owning
  suite asserting completion, entity removal, revert event, and replay
  equality. No new infrastructure.

### N2 — P1 (new): bulk approval dead-ends — versioned payload persists but resume is impossible

- **Live chain:** bulk gate persists `{version:1, command_name:'bulk_operation',
  targets, calls}` (`handler.ts:534-571`, verified in DB) → `resumeRun`
  takes the ledger branch whenever `operation_payload_json` exists
  (`dispatch.ts:1384`) → `resumePendingClarification` finds no registered
  handler for `bulk_operation` (`executor.ts:1424-1436`,
  `unsupported_command`) → `resumeRun` returns `{resumed:false}`
  (`dispatch.ts:1472-1475`) with no fallthrough. Nothing is committed;
  the run stays `waiting_for_input` permanently.
- **Actual (executed):** four targets proposed → question → explicit approval
  → `resumed:false` → zero entities ever commit.
- **Expected:** approval resumes the saved exact operation once (existing
  `approvedBulkScope` handler path, `handler.ts:252-258`, is currently dead
  code because the ledger branch always claims the payload first).
- **Smallest repair:** in `resumeRun`, route non-ledger command names
  (`bulk_operation`) to the standard non-ledger resumption path (section 5),
  preserving the approval scope binding; keep unknown ledger commands
  rejecting. Required tests: approval executes exact four once with no
  re-ask; restart after approval; duplicate answer; changed scope needs new
  approval; rejection cancels.
- **Coverage gap (P2):** no owning-suite test executes bulk approval at all —
  the F08 bulk test stops at the question (`agent.integration.test.ts:734`).
  Same for wire-level dedup (only intermediate-input assertions) — source +
  my temp execution verify it, but no normal test pins the wire body.

### Notes on R2-07 and process

- The composed eval file (6 fixtures incl. A1/A6/A9/A11/A13/A14 asserting D1
  effects) is genuine progress, but thin: no restart/duplicate-answer,
  changed-scope, multi-call continuation, or memory-lifecycle depth beyond
  A13. The offline `eval:agent` runner remains pure-validator (labeled
  honestly). Treat F12 as partly resolved.
- **Concurrent-work warning:** file mtimes show source edits during this
  review (`executor.ts`, composed test), and the implementation log confirms
  it removed my first diagnostic probe mid-review. My full-suite 9-timeout
  run coincided with background suites running in the same checkout. None of
  this changes the findings above (each was re-executed on current source),
  but the next repair pass should avoid concurrent verification runs, and
  `git status` should be checked before every evidence run.

## Limitations

Local workerd/D1, fake providers, mocked HTTP only. No deployed service,
browser/device, live-model, cost/latency, or dependency audit. Secrets never
read (synthetic key). Scope: Gate 006 runner/context/repository/memory path
and its ledger/identity/provider/actor integration, tests, eval.

## Next bounded instruction

Keep 006 `IMPLEMENTED; review fixes required`; fix docs implying full
F01–F13 closure. Two minimal batches, no new infrastructure: (1) undo-batch
FK repair + shared-chat undo regression (prior quote + creation + bare and
explicit undo; completion/removal/revert/replay assertions); (2) bulk resume
routing repair + approval-execution regressions (exact scope once, restart,
duplicate, changed scope, rejection) + wire-body dedup regression in the
owning suite. Then re-run the full battery serially. A new migration only if
schema must change; never rewrite applied ones.
