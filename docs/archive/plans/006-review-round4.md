> Closed historical plan record, reconciled 2026-10-07 from `plans/006-review-round4.md`. Family 006: core loop/memory present; grounding/recovery/quality partial. Remaining R02, R03, R04, R13 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# Gate 006 repair review — round 4 (independent, 2026-10-02)

Reviewed HEAD `859ed92` plus the current uncommitted tree in `D:\vs code\Otis`.
No commits, pushes, deployments, live inference, or source edits.
Only this review document was added under `plans/`.

**Verdict: NOT ACCEPTED.** Gate 006 stays `IMPLEMENTED; review fixes required`.
Gate 007 is not eligible.

This round adjudicates the re-submitted implementation claim that all F01–F13
are repaired with 313 passing tests and 14/14 eval fixtures. The claim was
checked against live source, the owning normal-suite assertions, and fresh
executions. The tree is materially unchanged since round 3 (same HEAD, same
uncommitted Gate 006 work, plus the round-3 review doc). All seven round-2/3
defect reproductions still pass on the current tree.

## Commands actually executed and observed outcomes

From `D:\vs code\Otis` with `$env:TEMP='D:\wtmp'` and `$env:TMP='D:\wtmp'`
(`D:\wtmp` confirmed present):

- `pnpm typecheck`: exit 0 (`tsc --build`).
- `pnpm lint`: exit 0 (`eslint .`).
- `pnpm test`: 25 files, **313 passed**.
- `pnpm exec vitest run --config plans/review-evidence/006-review.config.ts plans/review-evidence/006-repair-agent.repro.test.ts plans/review-evidence/006-repair-memory.repro.test.ts`: 2 files, **7 passed**.

These seven probes deliberately assert defective behavior, so passing means
each defect is still present. They are not acceptance tests. The 313 passing
normal tests do not override them, because the relevant normal assertions
stop at an intermediate state (details below). `pnpm eval:agent` was not
re-run this round; the eval source is unchanged since round 3, where it was 1
test passing over 14 scripted fixtures with `memory_promotion_accuracy: null`.

## What the implementation report gets right

The report's narrow fixes are real and remain present: fenced progress
publication with row-count checks, contiguous fresh tool/checkpoint indexing,
real-branch pinned registry key use, transcript messages reaching requests,
cancelled/incomplete stream rejection, explicit undo target acceptance,
reverted-note deletion with full causal replay, workspace-summary member-note
exclusion with a member-scope branch, expired-`running` refresh discovery, and
the null unmeasured metric. These are improvements, not group closures.

## Blocking findings (all re-verified on live source plus execution)

### R2-01 — P1, F11: refresh completes before it publishes (UNRESOLVED)

- Live: `apps/worker/src/agent/memory.ts:303-345`. Statement 1 updates the job
  to `completed` guarded on `state='running'`; statement 2 inserts the summary
  via `SELECT ... FROM memory_refresh_jobs WHERE id=? AND state='running' AND
  claim_token=? AND claim_expires_at>?`. In-order batch execution makes the
  second statement select zero rows, while `completedCount` is incremented
  from the first statement's row change.
- Executed: `repair-publication` probe returns `completed: 1`, durable state
  `completed`, zero `memory_summaries` rows.
- The owning normal test (`memory.integration.test.ts:567`) asserts only
  `processed/completed/state`, never the summary row, so it passes alongside
  the bug. No current-revision equality guard; expired-at-`max_attempts` jobs
  stay undiscoverable.
- Smallest repair: publish-while-guarded first (ownership/expiry/unchanged
  revision), then complete, counting only verified publication; handle
  revision change and exhaustion terminally.

### R2-02 — P1, F07: atomic daily counting does not exist (UNRESOLVED)

- Live: the only `workspace_daily_actions` touch in app code is a read at
  `apps/worker/src/agent/handler.ts:566`. No insert/update exists in
  `packages/ledger/src/repository/executor.ts` or
  `packages/identity/src/settings.ts`. `maxRoundsPerRun` is declared, never
  enforced; production `createWorkerAgentHandler` supplies no limits.
- Executed: `{maxDailyActions:1,maxRoundsPerRun:1}` with two entity mutations
  commits both and leaves zero counter rows; missing config still completes.
- The report's "atomically increment" claim contradicts live source. A
  read-before-commit check is neither atomic accounting nor commit-boundary
  enforcement. Do not invent numeric production defaults.
- Smallest repair: validated required limits through the real composition
  root plus atomic counting inside the ledger/settings committing
  transactions (UTC-day scope; reads/replays zero; compound/memory/settings
  per the counting contract).

### R2-03 — P1, F06/F08: bulk approval is discarded and re-asked (UNRESOLVED)

- Live: bulk gate parks before persisting round/proposal/scope and returns
  `needs_input` with no `pendingOperation`; `dispatch.ts:waitForInput` stores
  `operation_payload_json = NULL`. Resume takes the non-ledger path and the
  next identical proposal re-triggers the gate.
- Executed: four proposed, explicitly confirmed, resumed (`resumed:true`),
  re-asked, zero applied receipts.
- Owning test (`agent.integration.test.ts:732`) stops at the first
  `waiting_for_input` with zero writes and one question; it never answers, so
  it passes alongside the bug.
- Smallest repair: persist exact proposal/scope before asking; bind approval
  to question and exact targets; resume once; reject added targets; count
  scope across calls/rounds.

### R2-04 — P1, F06: control clarification saves the wrong payload (UNRESOLVED)

- Live: `repository.ts:414` returns the typed op at
  `result.clarification.pending_operation` (`version:1`, `command_name`, ...).
  `handler.ts:663` reads `result['pending_operation']` and falls back to
  `{command:call.name, params:call.args}` — an unversioned wrapper the ledger
  resumer rejects. Separately, `handler.ts:237-244` reconciles with latest
  receipt in run (`ORDER BY created_at DESC LIMIT 1`), not the bound
  clarification/call/action.
- Executed: missing-deadline `create_task` via `request_clarification` saves
  the wrapper; authenticated no-deadline answer returns `resumed:false`.
- Owning F06 test (`agent.integration.test.ts:844`) exercises the
  ledger-typed missing-deadline path and checks task count/text only — not the
  control-tool payload shape, receipt correspondence, or multi-call
  continuation — so it passes alongside the bug.
- Smallest repair: pass through the canonical payload at its real nesting
  with args/revision intact; preserve clarification/call/action IDs; resolve
  exactly that receipt.

### R2-05 — P1, F04: Gemini wire duplicates the completed result (UNRESOLVED)

- Live: handler puts all completed rounds (including latest) into `messages`
  (`handler.ts:369-389`) and the latest round again into `pendingToolResults`
  (`handler.ts:392-411`); the adapter serializes both. Historical tool blocks
  omit names, matching the observed empty-name duplicate.
- Executed with mocked HTTP (no external request): two `function_result`
  blocks for one call ID.
- Owning test (`agent.integration.test.ts:650`) captures intermediate
  `TurnInput` and asserts nonempty `pendingToolResults`; it never inspects the
  final adapter payload, so it passes alongside the bug.
- Smallest repair: single owner for serializing the pending group — exactly
  one result per call at the wire boundary, full history/continuation/names/
  args/order preserved.

### R2-06 — P1, F09: undo-forget diverges from rebuild on FTS (UNRESOLVED)

- Live: executor FTS maintenance responds to `memory_note`/`memory_forgotten`
  events; undo emits `revert` and restores projection/suppression without
  reinserting FTS.
- Executed: remember → forget → single undo of forget gives active note, zero
  suppressions (fixed part intact), zero FTS rows; full replay gives one FTS
  row.
- Owning test (`memory.integration.test.ts:485`) covers remember → undo (note
  deletion, no resurrection), not forget → undo (FTS restore), so it passes
  alongside the bug.
- Smallest repair: reconcile FTS from resulting active projection for
  affected notes inside the same guarded batch (forget and supersession undo);
  fence operator replay against concurrent source commits.

### R2-07 — P1, F12: eval still simulates pipeline success (UNRESOLVED)

- Live: `eval/runner.ts:157` hypothetically increments applied writes;
  `:198` counts nonempty text/user as correct source links; no composed
  handler or D1 effects run. `memory_promotion_accuracy:null` (`:272`) is
  honest labeling, not pipeline evidence.
- `eval/agent-eval.test.ts:13` is one test executing 14 scripted fixtures; its
  pass plus `memory_promotion_accuracy: null` (`:57`) does not establish zero
  wrong writes, sourcing, isolation, undo, or memory lifecycle.
- Smallest repair: keep pure helper eval labeled as such; add deterministic
  composed fixtures (fake inference + migrated D1) asserting actual
  targets/values/events/receipts/questions/sources and forbidden effects.

### R2-08 — remaining contract gaps (STILL OPEN, source-verified)

Prior source-verified items are unchanged and therefore not re-executed here:
stale handler-entry clock into step writes, partial progress/snapshot guards,
missing production `sourceTrust` wiring (defaults to member), absent
draft/sent-confirmation and disputed-reliance checks at execution, first-field-
only unbound status matching, incomplete authoritative context (disputed
fields, pending op, source/applicability, historical suppression),
over-broad transcript text filter, wall-clock/brief-timezone dates, silently
ignored read filters/cursors, FTS fallback swallowing failures, and
author-only chat-unscoped bare undo. No new framework or product scope is
needed; these are existing contract behaviors.

## Limitations

Local workerd/D1, fake providers, mocked HTTP only. No deployed service,
browser/device, live-model, cost/latency, or dependency audit. Secrets never
read or reproduced. Scope was the Gate 006 runner/context/repository/memory
path and its ledger/identity/provider/actor integration, tests, and eval.

## Next bounded instruction

Preserve the uncommitted tree. Keep 006 `IMPLEMENTED; review fixes required`;
fix docs claiming F01–F13 closure or atomic quota existence. Work in small
verified batches: (1) refresh publication + FTS consistency; (2) exact
clarification/approval payloads + wire serialization; (3) configured limits
with commit-boundary counting + trust/context boundaries; (4) composed
pipeline acceptance for Appendix A and 006A–006D with final DB/wire
assertions. Each batch reports files, final-state regressions, and unresolved
IDs. New migrations use the next unused number; never rewrite applied ones.
