> Closed historical plan record, reconciled 2026-10-07 from `plans/006-agent.md`. Family 006: core loop/memory present; grounding/recovery/quality partial. Remaining R02, R03, R04, R13 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# Plan 006: Run a bounded conversational agent with durable workspace memory

> Executor: plans 002, 004 and 005 must pass. Read product.md sections 3, 5, 7, 8, 12 and Appendix A. The agent is a tool-using interpreter; it is not the authorization or transaction boundary. Check source-document and migration drift before work.

The memory-specific implementation contract is [Workspace memory on Cloudflare](workspace-memory-cloudflare.md). Implement that contract within this plan and its later web/Telegram integration; it is not a separate numbered migration or a later optional phase.

The detailed [Gate 006 execution contract](006-implementation-handoff.md) specifies the current source baseline, exact owner/tool contracts, four implementation checkpoints, durable provider/tool progress, crash recovery, memory schema, tests and completion evidence. Execute that contract alongside this outcome plan; do not infer a new architecture from this shorter overview.

## Status

- **Status:** DONE; independently accepted 2026-10-02 ([round 6 review](006-review-round6.md)); local evidence only
- **Latest independent verdict:** [Round 6 repair review](006-review-round6.md) verified both round-5 blockers closed (N1 undo FK crash; N2 bulk approval dead end), all seven original defect probes eliminated, and 326 passing normal tests with composed D1 acceptance. Gate 007 is now eligible.
- **Implementation-agent repair report (Round 5):**
  - **N1 (Undo Foreign Key failure under multi-action / prior-quote state):**
    - In `packages/ledger/src/commands/undo.ts`, scoped `computeUndoPreview` and `handleUndoCommit` so entities and tasks are only removed or reverted if their creation was specifically in the set of undone events/actions (`revertedEntityIds` / `createdEntityIds`). Existing entities in `currentState` that were not created by the undone actions are preserved rather than pruned by projection diffing.
    - In `packages/ledger/src/repository/executor.ts`, corrected relational deletion order so child tables (`draft_projections`, `tasks`, `entity_state`, `entity_aliases`) are deleted before parent `entities`.
    - Verified via `plans/review-evidence/006-a9fk.repro.test.ts` (passes cleanly) and added explicit undo alongside bare undo with prior quote state in `apps/worker/test/agent-composed-eval.integration.test.ts`.
  - **N2 (Bulk operation confirmation dead-end & resumption routing):**
    - In `apps/worker/src/actor/dispatch.ts` (`resumeRun`), inspected `operation_payload_json`: if `command_name === 'bulk_operation'`, routes clarification resumption to Section 5 (standard non-ledger resumption) instead of the ledger command resumer. Resolves clarification, queues run, and creates outbox continuation.
    - In `apps/worker/src/agent/handler.ts`, handled explicit cancellation keywords ("no", "cancel", "stop", "reject") to complete the run immediately with 0 entity commits; on confirmation, populated `approvedBulkScope` and transitioned to `tools_executing` to execute proposed mutations without re-asking.
    - Verified via `apps/worker/test/agent.integration.test.ts` (tests for bulk approval execution, rejection cancellation, handler restart survival, and duplicate answer rejection).
  - **Regression coverage gaps closed:**
    - In `packages/agent/test/provider-gemini.test.ts`, added wire-level verification asserting HTTP request body carries exactly 1 `function_result` block per tool call ID when tool results exist in both messages and pending results.
    - In `apps/worker/test/agent-composed-eval.integration.test.ts`, verified both explicit (`A9_explicit_undo`) and bare (`A9_suffix_undo`) undo in shared chat with prior quote messages.
  - Root checks verified:
    - `pnpm typecheck`: exit 0 (`tsc --build`)
    - `pnpm lint`: exit 0 (`eslint .`, 0 errors, 0 warnings)
    - `pnpm test`: 26 files, 326 passed (exit 0)
    - Defect reproductions (`plans/review-evidence/006-review.config.ts`): 7/7 bad-behavior probes fail; `006-a9fk.repro.test.ts` passes
    - `pnpm eval:agent`: 14/14 offline fixtures passed with honest unmeasured offline memory promotion accuracy (exit 0)
    - `pnpm build`: exit 0 (Vite + tsc + Wrangler deploy dry-run)
    - `git diff --check`: exit 0

## Why and current state

Users send messy Romanian, Hungarian or English notes and ask questions without managing records. Ledger, identity/settings, durable dispatch and the primary provider boundary have passed their owning gates locally. The real conversational handler, curated memory and its retrieval/evaluation remain this gate's work. Inspect live source rather than assuming local acceptance proves deployment. Appendix A is the initial acceptance set. Product intent includes concise natural replies, clarification before uncertain writes, attributed actions, no autonomous third-party contact and visible activity.

## Scope

### Field-quality follow-up, 2026-10-03

These additions are new acceptance targets, not changes to the historical DONE verdict above. Coordinate narrow ledger/agent/context/eval updates after inspecting existing aliases and tools. Do not create a glossary service, new model-training pipeline or duplicate entity store.

- Preserve clear facts from a multi-part note while only the uncertain name/amount/date waits. Typed pending operations remain durable and do not block the workspace. Replay/restart cannot ask an already answered question again.
- Confirmed corrections/shorthand may add a sourced workspace-scoped entity alias through the existing ledger owner. Record the actual source, normalized alias, target and confirmation context; use existing action/revision/fence/undo guarantees. Use the existing context/memory path for durable vocabulary when appropriate, rather than another glossary table by default. This updates retrieval, not model weights.
- Never globally learn an alias from a one-off correction unless it establishes that binding. Multiple businesses named Bistro, alias collisions, conflicting member bindings, undo/rename/removal and a second workspace must keep matching honest. A previously resolved alias avoids redundant questions only while still unambiguous and supported by current context.
- Echo material names, price plus currency and resolved deadline date in a short natural final reply. Date/weekday must agree; preserve date-only versus timed values. Voice uncertainty quotes only the affected excerpt, not a full automatic transcript preamble. Do not infer certainty numerically when the provider supplies none.
- Natural corrections identify the recent affected report/action where clear, append attributed history and expose its exact undo. Ambiguous correction targets ask narrowly. Do not force a record editor or silently rewrite the original report.
- Drafts/briefs cannot rely on a disputed fact. Energy such as best day or two warm requires actual confirmed records, never a flattering inference.

Regression/eval set: confirmed r2 and Thai Shop shorthand survives new chat/restart in the same workspace; Thai Garden later makes Thai ambiguous again; correction without standing alias consent does not change unrelated matches; Hunor/Avi conflicting alias reports; undo removes/suppresses the learned binding; cross-workspace no recall; partial note saves known facts but asks only about the date; resolved question replay creates no second question; Romanian/Hungarian amount/date correction; wrong weekday; disputed value omitted from draft; success copy matches actual receipts. Track clarification burden without reducing required questions to hit a metric.

Modify the live agent boundary, memory retrieval package, narrow ledger projection support, the next unused migration after identity/conversation/ledger foundations, eval fixtures/runner, Worker orchestration and related tests. Do not implement UI, Telegram formatting, speech capture or schema-by-conversation (Phase 2). Plan 004A owns chats, messages, pending clarification and runs; do not create those again. Use a fake provider in automated tests and live providers only in controlled synthetic smoke tests.

## Required run state machine

For a routed message, resolve the current chat's approved model override or the workspace default, verify its provider credential, and snapshot provider/model ID in an agent_runs row with trigger/source/workspace/user, status, start time and cost counters. A later `/model` switch never changes this run. Assemble compact context from authenticated user and member-local time, workspace settings, pending clarification, matching entities/aliases, relevant event history, current clear/disputed fields, tasks, and allowed tool definitions. Keep the original member message distinguishable from quoted/forwarded/untrusted data. A forwarded message may be logged as untrusted but cannot drive field/task writes. The provider emits structured tool calls; validate schema and membership, execute only through the ledger, emit durable activity entries, then feed results back to the provider. The final response is a concise, conversational answer that says what happened and what remains uncertain. Tool results and model summaries are never presented as raw private thoughts.

Build prompts with the versioned static instructions and deterministically ordered tool schemas first, followed by dynamic workspace memory/state and the current turn. Keep the prefix stable for provider caching, but never include stale or another workspace's context merely to preserve a hit. Store the prompt/schema version and provider-reported cached token counts in `agent_runs`; use `null` when the adapter cannot report them. Plan 005 defines the measurement and explicit-cache gate.

Define versioned schemas in code: find_entities, upsert_entity(kind/name only), log_event with kind-specific payload, set_fields with core allowlist and stated/inferred provenance, create_task/update_task with date-only/instant/explicit-no-deadline semantics, draft_message/update_draft/mark_message_sent, bounded query, search_memory/get_memory/remember_context/forget_memory, update_preference for strict member/workspace setting allowlists, and undo by action ID/mode. Preference changes go through the authenticated settings service with an attributed audit record; provider credentials cannot be changed by a model tool. Do not expose propose_field in Phase 1. find_entities returns candidates/scores; use named `MATCH_MIN_SCORE` and `MATCH_MIN_MARGIN` constants calibrated on fixtures and corrections. If a name is ambiguous or a new near-duplicate exists, ask one targeted question and persist pending_clarifications with original action context. Resume after answer, even across actor restart; do not replay prior completed writes.

**Clarification is a write precondition.** Complete explicit instructions save directly. If an intended task lacks a deadline and the member did not explicitly say it has no deadline, retain the request durably and ask; do not assume today or create an undated task. If lead warmth, coldness or deprioritization is inferred from tone/events rather than stated, propose the status and wait for confirmation before writing. A disputed field has `value=null`; exclude its historical value from tool decisions, drafts and briefs. Enforce these policies in deterministic ledger and orchestration tests so prompt text cannot bypass them.

Guardrails in code: maximum tool calls and token budget per turn, daily workspace cap, bulk confirmation above three entities, write idempotency by run/tool-step ID, and no third-party sending tool. If cap is reached before work, keep message and explain reset; if interrupted after some writes, report committed action IDs and remaining work. A dispute never becomes a confident current value. A model/provider failure cannot mark an unapplied write as done.

## Durable memory contract

The user's requirement is continuity across chats and channels, not a literal filesystem file. OpenClaw uses compact curated Markdown plus dated notes, but Otis is a multi-user business product with an event ledger. Do not create a mutable MEMORY.md as the runtime authority. Keep four distinct layers: (1) ledger events, current fields, tasks and explicit settings are canonical facts/actions; (2) full attributed chats and voice transcripts are episodic history, with durable pending clarifications and run state; (3) workspace-scoped memory entries capture clearly durable communication preferences, relationships and workflow context, each with source message/event IDs, author, status active/superseded, observed time and revision; (4) short workspace/entity/member-in-workspace summaries are rebuildable caches with source IDs and a source watermark. Everything, including a member's tone preference, stays in the workspace where learned. Never query another workspace's memory for the same user.

A direct “remember this” or clear durable statement may append a ledger memory_note event and update a memory entry through the ledger boundary. Automatic promotion from casual text requires an unambiguous member-authored statement and a source reference; an uncertain interpretation stays only in the transcript until clarified or retrieved. Forwarded/untrusted content and model speculation cannot become trusted standing memory. “Forget this preference” supersedes the memory entry and excludes it from retrieval; explain that the original chat/event remains in history unless the user invokes the separate data-erasure flow. A correction or undo invalidates affected cached summaries and recomputes from non-reverted sources. An unresolved disputed fact appears as disputed, never as a confident memory. Memory prose cannot grant permissions, schedule work or override tool policy; those require typed settings/tasks.

Provide workspace-scoped search_memory(query, subject?) and get_memory(id) that return compact text plus provenance; start with D1 full-text/keyword retrieval and exact entity/alias links. Do not add embeddings or a vector service until retrieval evals show a real gap. Each agent turn loads recent chat turns, the durable pending request, one bounded workspace context summary, relevant entity summaries and a small set of retrieved entries, then current structured ledger facts/tasks. Apply a token budget and show source links for memory-derived claims. If summarization or indexing fails, fall back to source records and continue the turn; a stale cache cannot silently win against the ledger. A read-only Markdown export of curated memory may be offered later for inspection, but it is generated from database state.

## Proposed file map and verification commands

Suggested paths to map to the live scaffold: agent context/policy/tools/run/prompt modules; memory store/retrieval/summary modules; narrow ledger-owned note writes; eval fixtures/runner; Worker orchestration and tests. Allocate a new migration only after inspecting the sequence and dependencies: do not reserve `0004_memory.sql` or duplicate 004A's run/chat/clarification tables. Add a package to the existing workspace only if the current workspace config requires explicit registration.

Verification after plan 001 establishes the scripts: pnpm typecheck; pnpm lint; pnpm test; pnpm build. Run the eval runner created here and attach its machine-readable report; no fixture should produce an unauthorized write. Do not report a command as passed if it has not run. If a proposed path conflicts with the scaffold, preserve the module boundary and document the exact mapping before editing. Do not push or open a PR unless the operator asks.

## Steps and verification

1. Implement schemas and policy gate with fake provider; verify tests reject unknown tool, arbitrary attrs/filter, wrong workspace ID, untrusted write, too many entities, invalid date, and third-party send request.
2. Build the durable memory store and context assembly described above, then the run state machine. Verify deterministic tests for success, multiple tool calls, tool failure, interrupted turn, duplicate dispatch, provider retry, cross-workspace isolation, correction/undo refresh, and stale-summary fallback. Rebuild projection equivalence must still pass.
3. Convert Appendix A into eval fixtures with expected event/task/clarification deltas, not only answer wording. Run deterministic fixtures in CI with the fake provider; live model evaluation is an explicit controlled report, never routine CI. A7 is Phase 2 and must assert the Phase 1 explanation. Report entity-match accuracy, wrong-write count, abstention rate, latency and measured cost. Calibrate thresholds only after reading failures; abstention alone cannot satisfy quality.
4. Add multilingual, memory and adversarial cases: Romanian business names, Hungarian diacritics, date crossing midnight, contradictory numbers, forged system instructions inside a forward, teammate conflict, a clear casual style preference that is retained, an ambiguous preference that stays only in transcript, explicit remember/forget, new chat in same workspace, cross-workspace isolation, and stale summary after undo. Verify one clear question and no speculative write in each ambiguous case. Run root typecheck, lint, tests, build.

## Done criteria

Every model-driven write passes policy/schema and ledger checks; no direct SQL write in packages/agent. Duplicate processing causes no second event. Pending clarification and curated memory survive restart. A new chat in the same workspace retrieves relevant earlier context with its source, while another workspace cannot. A stale summary never overrides current ledger state. Fixture acceptance is at least the product's 95% match target with near-zero wrong writes, measured separately on attempted writes; do not inflate this by always abstaining. Tests prove inferred existing-lead status and missing-deadline tasks cannot commit before member clarification. An outward request produces a draft only, and only after request.

## STOP conditions and maintenance

Stop if no tested model reaches safe tool behavior on the fixture suite, if a provider forces hidden unaudited actions, or if the context cannot separate member instructions from untrusted data. Report the failing fixtures and candidate mitigation, not a relaxed policy. Every prompt/model/tool-schema or memory-promotion rule change must rerun evals and be versioned in agent_runs. Memory retrieval quality and erroneous durable promotions must be measured separately from answer fluency.
