> Closed historical plan record, reconciled 2026-10-07 from `plans/006-review-round2.md`. Family 006: core loop/memory present; grounding/recovery/quality partial. Remaining R02, R03, R04, R13 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# Gate 006 repair review — round 2

Reviewed independently on 2026-10-02 against HEAD `859ed92` plus the current uncommitted tree. This reviews the implementation agent's report claiming all F01–F13 repairs complete. Source and tests were inspected directly; no subagents, live provider calls, commits or deployments were used. Only review documents/evidence under `plans/` were added or changed.

**Verdict: NOT ACCEPTED. Several narrow repairs are real; all thirteen finding groups are not resolved.** Continue Gate 006 repairs. Do not advance dependent Gate 007 or treat the completion report as independent acceptance.

The original [repair contract](006-review-followup.md) still governs scope and regression coverage. This document narrows the immediate next work and records new evidence; it does not add product features or infrastructure.

## Independent verification

- `pnpm test`: **313 passed / 25 files**, independently rerun.
- `pnpm typecheck`: exit 0.
- `pnpm lint`: exit 0, including the new review probes.
- `pnpm eval:agent`: exit 0, still a pure scripted validator evaluation rather than composed agent acceptance.
- `pnpm build`: exit 0; local Vite/TypeScript/Wrangler dry-run only.
- Seven additional assertions in two review files reproduce current defects. Passing these probes confirms bad behavior; they are not acceptance tests.

Run the new probes from repo root:

```powershell
$env:TEMP='D:\wtmp'
$env:TMP='D:\wtmp'
pnpm exec vitest run --config plans/review-evidence/006-review.config.ts plans/review-evidence/006-repair-agent.repro.test.ts plans/review-evidence/006-repair-memory.repro.test.ts
```

The original fourteen review probes are historical and may now fail when their particular bugs are fixed. Use the explicit file filter above for round 2. Promote scenarios to normal suites with correct-behavior assertions; do not copy bad-behavior expectations into acceptance tests.

## Fixes that are present

The immediate completed-phase spin is handled; progress publication now checks running status and live lease ownership and checks row changes; normal fresh tool/checkpoint indexing is contiguous; the real-provider branch now uses the saved registry key rather than a changed workspace default; prior transcript messages reach requests; cancelled/incomplete calls are rejected; explicit undo targets are accepted; reverted note deletion/full causal replay is implemented; workspace summary extraction excludes member notes and has a member-scope branch; expired `running` refresh jobs can be discovered; memory promotion's unmeasured metric is now null.

These are meaningful improvements. They establish narrow behavior, not full closure of each original finding group. In particular, some added tests check only the first half of a flow.

## Blocking findings and exact repairs

### R2-01 — P1: refresh jobs complete without publishing a summary (F11)

**Evidence:** `apps/worker/src/agent/memory.ts:307` changes the job from `running` to `completed` in batch statement one. Statement two at line 319 selects the same job only when `state='running'`. Statements execute in order, so the second statement selects zero rows. The code counts the first update as success without verifying publication.

**Executed reproduction:** process a fresh pending workspace refresh job. Result says `completed: 1`, durable job says `completed`, but there is **no memory_summaries row**. The normal expired-job regression asserts completion/state only; it never asserts a summary was published, so it misses this.

Repair the existing publication batch: guard ownership/expiry and the unchanged current workspace revision; publish while the guard is valid, then complete the job, with a real transactional failure guard rather than silently accepting zero-row publication. If source revision changes, retain/requeue current work rather than marking it complete with a stale extract. The current batch does not verify current business revision either. Honor exhaustion after crashes: an expired `running` job whose attempts already equal `max_attempts` must reach an inspectable terminal state, not remain excluded forever.

Required normal tests: published text/source manifest/current revision after a successful refresh; failure rolls back publication and completion; paused A expires, B publishes, A changes nothing; sources change during extraction; expired job at maximum attempts; failed hint still discovered by cron. Preserve one refresh owner and the existing queue.

### R2-02 — P1: the reported atomic daily increments do not exist (F07)

**Evidence:** `handler.ts:563` conditionally reads the daily counter, but the ledger and identity settings committing batches do not insert/update `workspace_daily_actions`. Production `createWorkerAgentHandler` supplies no limits. `maxRoundsPerRun` is declared at line 48 and never enforced. Token/call/context reservations and total run bounds remain absent.

**Executed reproduction:** configure `{maxDailyActions: 1, maxRoundsPerRun: 1}` and propose two entity creations. Both commit, the run completes, and no daily-counter row exists. Another probe confirms missing required limit configuration still allows inference and completion.

This contradicts the report's claim that mutations atomically increment the counter. A read before commit is not atomic accounting or enforcement, even if something else eventually increments it.

Implement validated required operator limits, wire them through the real composition root, reserve/account durably across restart, and enforce/count actions inside the ledger/settings commit transaction. Do not invent unapproved numeric production defaults. Test small explicit limits. Reads/replays consume no applied-action allowance; memory/settings/compound child actions follow the original counting contract. A transient error must retain its typed retry/reset information and retry only within durable bounds.

Required tests: two members racing for the last allowed action; limit=1 permits at most one logical mutation; interrupted request/restart preserves allowance; actual total provider round cap; absent production configuration blocks inference; UTC midnight; settings/memory quotas; partial results identify committed receipts.

### R2-03 — P1: bulk confirmation loses the proposal and asks again (F06/F08)

**Evidence:** `handler.ts:481` parks the run before persisting `currentRound`, its ordered calls or an approval contract. The returned needs-input outcome has no pending operation. Resume has no saved scope to approve; it returns to inference and applies the same greater-than-three check again.

**Executed reproduction:** propose four businesses, receive the question, send an authenticated explicit confirmation, resume, and return the same calls from the provider. Otis asks the same question again and commits zero actions. `operation_payload_json` is null. The added normal bulk test stops after the initial question and does not answer it.

Persist the exact proposal/scope before asking. Bind approval to its question and exact targets, resume the saved operation once, and disallow added targets. Count operation scope across calls/rounds as required, not only the current round. Do not rely on the model to paraphrase approval into a new plan.

Required tests: confirmed original four targets execute once; restart after approval; duplicate answer; changed scope requires new approval; split calls cannot evade the threshold; rejection cancels the saved proposal; a teammate can continue while the question is parked.

### R2-04 — P1: control clarification persists the wrong payload and cannot resume (F06)

**Evidence:** `repository.ts` returns the typed operation under `result.clarification.pending_operation`. `handler.ts:663` instead checks `result.pending_operation`, then substitutes `{command: call.name, params: call.args}`. For the control tool this saves an unversioned `request_clarification` wrapper instead of its intended operation. The ledger resumer requires `version: 1` and `command_name`.

**Executed reproduction:** `request_clarification` proposes a missing-deadline `create_task`; the saved payload has no version and says `command: request_clarification`. An authenticated no-deadline answer returns `resumed: false`.

Also, `handler.ts:237` selects the most recently created receipt for the entire run, rather than the receipt tied to this clarification and original call. An earlier or unrelated receipt is not evidence that the blocked operation completed. Preserve the original clarification/call/action IDs and use that exact resolved receipt. Never mark a call consumed based on `ORDER BY created_at DESC LIMIT 1`.

Repair the canonical typed payload handoff at its real nesting, keep original operation arguments/source revision, and bind resolution to its operation. The new one-task regression now has only a text response after resume; that proves its happy path but not receipt correspondence or continuation of a blocked multi-call group.

Required tests: control-tool question answers and creates exactly one intended task; status approval can resume; two sequential questions; previous unrelated receipt cannot consume the current blocked call; duplicate/restarted answer; remaining saved tools continue in order; stale source revision conflicts.

### R2-05 — P1: actual Gemini request contains duplicate results (F04)

**Evidence:** the handler puts every completed round, including the latest, in `messages` and also puts latest results in `pendingToolResults`. `packages/agent/src/providers/gemini.ts:90` serializes historical tool messages; line 142 appends pending results again. Handler historical tool messages omit their names, so one duplicated result has an empty name.

**Executed reproduction:** capture the composed handler's second input and pass it through the real Gemini adapter with mocked HTTP. The outgoing body contains **two function_result blocks for the same call ID**. No real provider request is made. The normal regression captures the intermediate input and checks nonempty pending results; it does not inspect the final adapter payload.

Assign one owner to serializing the pending group. Full history and continuation data must produce exactly one call/result pair per call at the wire boundary. Preserve earlier rounds and server protocol metadata. Use the existing adapter contract; do not fix this by globally dropping history or continuation.

Required tests: mocked actual outgoing Gemini and both Go endpoint families over multiple rounds and a restart; exact names/args/order; exactly one result per call; complete prior history retained; continuation present/absent; malformed terminal and mismatch cases. Repair the handler/adaptor composition narrowly and keep accepted provider tests.

### R2-06 — P1: undo-forget leaves FTS inconsistent (F09)

**Evidence:** the executor now restores memory entry state and removes superseded suppressions, but FTS maintenance at `packages/ledger/src/repository/executor.ts:1125` responds only to newly emitted note/forget events. Undo emits revert events and does not reinsert a restored active note.

**Executed reproduction:** remember, forget, then explicitly undo the forget. The note is active and the suppression is correctly gone, but FTS contains zero entries. Full replay inserts one entry. Online projection and replay therefore differ. Do not claim the note remains suppressed: that part is fixed.

Reconcile FTS from the resulting active projection for affected notes inside the same guarded command batch, including undo of forget and supersession. Avoid a second memory reducer or unguarded repair after commit. Guard operator replay against concurrent source revision changes; its current read/rebuild/clear path is still unfenced against source mutation.

Required tests: remember/undo, forget/undo, supersede/undo, suffix undo; active projection/suppression/FTS equals full replay; forced final statement rollback; concurrent replay/source commit cannot erase new notes.

### R2-07 — P1: changing one metric to null does not implement the acceptance evaluator (F12)

**Evidence:** `eval/runner.ts:157` still increments hypothetical applied writes after validator/policy checks. Lines 197–198 still treat nonempty text/user strings as a correct source link. It does not execute the composed handler or D1 effects. Only memory promotion's literal 100% was changed to null.

Keep this as a clearly named pure helper evaluation, but implement the required deterministic composed-pipeline fixtures with real migrated D1 and fake inference. Assert actual targets/values/receipts/events/questions/projections/source links and forbidden effects. Label all unmeasured metrics honestly. No live or paid inference is necessary. Do not claim F12 closed through a label change.

### R2-08 — P1: other original contract gaps remain (F01/F05/F08/F13)

These are source-verified outstanding items, not additional independently executed reproductions in this pass:

- Handler-entry `nowIso` is still passed to later `persistStep`/`completeStep` at `handler.ts:606,633`. Progress is fresher, but step checks still use an old clock. Current progress/snapshot guards also lack live membership and workspace fence equality; retain the accepted ownership guard rather than a partial variant.
- Production execution still does not pass source trust metadata to `executeAgentTool`; repository defaults to member. Expanding the pure helper's blocked-tool list does not secure the actual forwarded/stored path. Draft/sent confirmation and disputed-field checks remain missing from actual command execution. Status policy still matches global text, checks only the first status field and is not target/source-span bound. Negation detection is only a narrow fix.
- Context still lacks authoritative typed disputed fields, original pending operation, source/applicability rendering and suppression of historical source excerpts. The new transcript filter also drops **all** historical messages matching current text (`context.ts:153`), rather than only the current source. Repeating the same user instruction must not erase previous context. Dates still come from current wall clock and brief timezone rather than a pinned member-local decision context.
- Some read filter combinations remain silently ignored, such as `query(entities, filters.entity_id)`; invalid event cursors silently broaden the query. FTS search is improved, but fallback must preserve intent and not swallow unexpected authorization/storage failures. Recheck current membership before returning data after a paused inference.

Do not mark an original finding closed until its mandatory behavior/tests in the first review contract are covered. No new framework or extra product scope is needed to finish these.

## Next implementation instruction

Preserve all existing uncommitted changes. Keep Gate 006 `IMPLEMENTED; review fixes required`. Correct documentation that currently says all F01–F13 are repaired or atomic quota tracking exists.

Work in small verified batches: (1) refresh publication and FTS projection consistency; (2) exact clarification/approval and adapter payloads; (3) durable configured limits and actual trust/context boundaries; (4) real pipeline acceptance evidence. Implement the current contracts using current services. No new queues, paid services, generic workflow engine, UI, or speculative abstractions.

Each batch reports actual modified files, regression scenarios and unresolved finding IDs. Tests must exercise complete flows and final database/wire outcomes, not just the status at the intermediate point where the first symptom was fixed. Final root checks must all pass, but independent acceptance is still required. A new migration uses the next unused number if existing migrations have been applied.

The review source scope was the changed runner/context/repository/memory path, its immediate ledger/identity/provider/actor integration, and the new tests/evaluator. No deployed/browser acceptance, external model capability probes, dependency audit or load test was performed in this pass.
