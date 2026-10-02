# Gate 006 independent review and repair contract

**Latest status:** [Round 2 repair review](006-review-round2.md) rejects the report of full repair completion and records seven additional executed defect reproductions. The findings below remain the original contract; some narrow symptoms have since been corrected, as documented in round 2.

Reviewed 2026-10-02 against HEAD `859ed92` **and the current uncommitted working tree** in `D:\vs code\Otis`. The tree also contains previously accepted Gate 005 work and other user changes; preserve them. This is a review of the new Gate 006 implementation and its immediate integration boundaries, not a rejection of all changes since HEAD.

**Verdict: NOT ACCEPTED. Keep 006 IMPLEMENTED; review fixes required. Do not start dependent Gate 007 as though 006 were accepted.** The implementation contains useful foundations, but it fails normal conversation, continuation, clarification, memory undo and recovery behaviors required by its existing contract. A passing root suite does not override the failures below.

The reviewer read source directly and ran independent reproductions without delegation. Only review documents and evidence under `plans/` were added/edited; no application fixes, commits, remote deployments or live provider requests were performed.

## Verification and how to read the evidence

Independent checks on the reviewed tree:

| Command | Observed result | What this establishes |
|---|---|---|
| `pnpm typecheck` | Exit 0 | Existing TypeScript projects compile. |
| `pnpm lint` | Exit 0 | Includes linting the added review fixtures. |
| `pnpm test` | 300 passed, 25 files | Existing automated assertions pass. |
| `pnpm eval:agent` | 1 test file / 1 test passed | The current scripted validator evaluation passes; see F12 before treating this as agent acceptance. |
| `pnpm build` | Exit 0, Vite/TypeScript/Wrangler dry-run | Local compilation and packaging only. No remote deployment. |
| `git diff --check` | Exit 0 | No tracked diff whitespace failures; Git reports existing line-ending conversion notices. |
| `pnpm exec vitest run --config plans/review-evidence/006-review.config.ts` | 14 passed, 2 files | **Fourteen assertions reproduce defective behavior**, not fourteen acceptance checks. |

On this machine, set `$env:TEMP='D:\wtmp'` and `$env:TMP='D:\wtmp'` before workerd commands. Tests use migrated local D1 and fake adapters/mock transport, not real provider inference. Wrangler loads local development configuration; do not print its values.

Evidence files:

- `plans/review-evidence/006-agent.repro.test.ts`: ten probes covering negated intent, explicit undo rejection, step collision, malformed history, missing conversational history, unconfirmed bulk writes, cancelled-stream mutation, production-branch model substitution, duplicate clarified task, and expired progress/completed-phase spin.
- `plans/review-evidence/006-memory.repro.test.ts`: four probes covering undone-memory resurrection, member preference contamination, lower-trust memory promotion, and undiscoverable expired summary jobs.
- `plans/review-evidence/006-review.config.ts`: isolated Workers Vitest project. The root test command does not include these review probes.

**Do not make the implementation pass by retaining the bad-behavior assertions as acceptance tests.** Move each relevant scenario into its owning normal suite and assert the correct result instead. It is expected that the original review probes stop passing after their defects are repaired. Keep them as historical evidence or clearly retire them; never weaken the normal regression assertion to match a bug.

## Existing decisions and scope

Otis is a conversational business-memory agent for Kerning, using Google-authenticated members, shared workspace records, per-member applicability of preferences, and the existing Cloudflare Worker/DO/D1/R2/queue architecture. Clear complete instructions save directly. Missing deadlines and inferred status changes ask. Users can inspect shared history; inspection does not make another member's preferences applicable to the current member. Undo defaults to the selected action and its following actions in the same run. Provider choice stays pinned throughout an accepted run.

Use `plans/006-implementation-handoff.md` as the existing implementation contract. This document identifies deviations and specifies repairs; it does not introduce a new product scope. Gate 006 does not own the web UI, Telegram UX, recording/transcription, live voice, MCP, third-party sending or new onboarding.

Preserve the existing service ownership:

- Worker `apps/worker/src/agent/`: D1 context retrieval, orchestration and bridge execution.
- `packages/agent`: pure declarations/policies/progress types and provider protocol code.
- `packages/ledger`: business/memory commands, guarded receipts/projections and undo.
- `packages/identity`: guarded typed preference/settings writes.
- Existing actor: leases, dispatch, stop, clarification scheduling and recovery.

Keeping D1-dependent memory code in the Worker is acceptable. No separate `packages/memory`, new scheduler, workflow framework, event bus, generic authorization DSL or paid service is required. Prefer small named functions for actual repeated responsibilities, not a framework rewrite.

## Vetted findings

All findings below concern current Gate 006 additions/integration. Effort S means local correction plus tests; M means several cooperating boundaries; L means implementation of an omitted existing contract. Risk describes the repair, not the defect. Confidence is high unless explicitly limited to a static trace.

| ID | Priority | Finding | Effort / repair risk | Evidence |
|---|---|---|---|---|
| F01 | P0 | Progress writes outlive the lease; recovered completed phase loops indefinitely | M / high | `apps/worker/src/agent/handler.ts:65,166,190,200,333,477`; expired-progress probe |
| F02 | P1 | Agent step allocation collides with dispatcher checkpoints; unfinished steps are not durably reconciled | M / medium | `handler.ts:361,379,415`; `apps/worker/src/actor/dispatch.ts:1124`; checkpoint probe |
| F03 | P1 | Real transport ignores a saved model pin | S / medium | `handler.ts:122,287,307`; mocked real-transport probe |
| F04 | P1 | Subsequent requests lose actual tool names, arguments, round boundaries and continuation; cancellation can still execute tools | M / medium | `handler.ts:239,267,456`; `packages/agent/src/run.ts:153,172`; history/cancellation probes |
| F05 | P1 | Persisted chat history is never sent; authoritative decision context is incomplete | M / medium | `handler.ts:217,229`; `apps/worker/src/agent/context.ts:132,340`; prior-reference probe |
| F06 | P1 | Clarification resume duplicates a committed operation and drops the original operation contract | M / high | `handler.ts:190,425`; `apps/worker/src/agent/repository.ts:336`; duplicate-task probe |
| F07 | P1 | No cumulative run budgets, required configuration check or atomic daily-action enforcement | L / high | `handler.ts:196,269`; `packages/agent/src/run.ts:30`; `migrations/0008_memory_and_agent_runs.sql:94`; four-write probe |
| F08 | P1 | Confirmation/trust policy is incomplete and not enforced at the real execution boundary | M / high | `packages/agent/src/policy.ts:17,69,98,167`; `repository.ts:75,109,565,578`; negation/promotion/bulk probes |
| F09 | P1 | Explicit undo targets are forbidden; bare undo can target another chat; memory projections/replay ignore reverts | M / high | `packages/agent/src/tools.ts:19,960`; `repository.ts:604`; `packages/ledger/src/repository/executor.ts:1024`; `apps/worker/src/agent/memory.ts:308`; undo probes |
| F10 | P1 | Workspace summaries make one member's personal preferences standing context for another member | S / medium | `memory.ts:48`; `context.ts:316`; preference probe |
| F11 | P1 | Summary refresh recovery, retry bounds and publication guards are missing/broken | M / high | `memory.ts:150,192,229,259,275`; `migrations/0008_memory_and_agent_runs.sql:68`; expired-job probe plus static publication trace |
| F12 | P1 | Evaluation simulates successes and reports unmeasured perfect metrics | M / medium | `eval/runner.ts:145,200,215,272`; independently read and executed eval |
| F13 | P2 | Read tool schemas promise search/filter/pagination behavior the repository silently ignores | S–M / low | `repository.ts:184,251`; `packages/agent/src/tools.ts:697`; static trace |

### F01 — Fence progress and terminate every durable phase

`saveProgress` checks run ID/workspace/attempt/fence but not running status, current workspace lease ownership/expiry or live membership, and does not check affected rows. Model-snapshot publication has only a partial guard. A handler also passes its single captured entry clock to later step mutations. These checks do not have the same live-clock protection as the accepted ledger boundary.

The reproduction expires the lease during a final response. The handler publishes `phase: completed`; the dispatcher correctly rejects completion and requeues. On redispatch, the handler loads completed progress, enters its while loop, and repeatedly reads status without entering either phase branch or incrementing the loop counter. The probe bounds the database wrapper at four repeated status reads to demonstrate the spin without running forever.

Repair within the existing owner:

1. Use a current, injectable clock for every guarded operation; never carry handler-entry time into later lease checks.
2. Publish model/progress only under the same running/attempt/fence/live-lease/member conditions as the dispatch owner. Verify exactly one row changes; zero is lease loss, not success.
3. Handle every persisted phase explicitly before looping. A valid completed candidate returns that saved answer for the dispatcher to commit; it never requests more inference or spins. A stale holder cannot publish it.
4. Align request timeouts/slice duration with the existing lease mechanism, including renewal or yielding as appropriate. Do not add a parallel lease owner. A 60-second request must not silently outlive a shorter lease and poison recovery.

Tests: stop/removal/expiry immediately before progress publication; takeover before the old provider returns; snapshot publication losing ownership; crash after final candidate but before final delivery; redispatch returns once without a provider call; no old holder writes progress/steps/replies. Preserve accepted 004B race tests.

### F02 — Use one contiguous step allocation/reconciliation rule

The dispatcher owns step 0. The handler allocates `COUNT(*) + 1`, yielding first tool index 2, while the dispatcher's next checkpoint uses `listRunSteps(...).length`, also 2. A normal one-round slice that creates an entity commits the business action and then throws a conflicting-step error. This is reproducible without a crash.

Use a consistent allocation rule for both owners, e.g. maximum occupied index plus one, with the existing fenced persistence operation. Persist each logical planned call's stable step reference. Recovery must adopt/reconcile that reference rather than allocate a fresh receipt for an unfinished tool. Do not change action identity on attempts or add a separate receipt store.

The handler currently expects all `action_receipts.result_json` values to be `CommandResult`, but identity stores plain `MemberSettings` for `update_preference`. Normalize at the owner boundary or decode its documented receipt type into the agent result. Do not hand the provider an undefined-status result after a crash.

Tests: default two-round slice yielding a checkpoint; explicitly one-round slice; read-only and compound commands; crash after planning/before execution; crash after settings commit/before progress advance; retry uses the same logical operation and reports its actual committed result. Assert no duplicate steps/effects and no checkpoint collision.

### F03 — Use the pin in the real provider branch

After loading `model_snapshot_json`, `effectiveEntry` remains null. The real branch resolves the current chat/workspace choice again. The fake-adapter branch receives the pin, so the existing fake test misses the bug.

The review seeds a pin for MiMo v2.5, changes the shared default to v2.6 Pro, mocks HTTP, and captures the real transport body: it sends `mimo-v2.6-pro` while the run still advertises `mimo-25`.

Resolve the approved registry entry matching the saved provider/model ID/endpoint family/prompt-schema version. Initial choice is resolved once; retry never adopts a changed default. If the pin is no longer supported or its credential unavailable, give a typed failure; do not silently substitute another model. Internal registry keys remain internal; preserve the existing readable user-facing names.

Tests must capture outgoing bodies for the real adapter composition with mocked fetch, not only fake descriptor inputs. Cover a switch between attempts, a removed pin, credential revocation and incompatible endpoint family.

### F04 — Persist exact protocol history and reject incomplete/cancelled rounds

Completed results retain call ID/action ID/result, but discard name/arguments. The next assistant message sets `name` to an Otis action ID and arguments to `{}`. It merges historical calls into one group, sends empty `pendingToolResults`, and clears the continuation before the next request. This is not faithful provider history and can break function-calling protocols or lose the model's reasoning continuity.

Persist the exact validated assistant calls and matching one-result-per-call history per round. Feed the current completed tool group and its continuation to adapters according to the existing adapter contract; avoid duplicating a group already in complete history. Preserve any required Gemini thought-signature/server protocol data privately without inventing signatures or exposing private provider state as public thoughts.

The stream collector treats `cancelled` as acceptable and accepts JSON argument fragments without a completed call-end event. The cancelled-stream probe actually creates an entity. Reject cancellation/errors/incomplete calls before any call in the group executes. Check terminal uniqueness/order, start/end identity and complete group validity, rather than parsing a fragment as a completed proposal. Enforce the bounds in F07 while accumulating.

Tests: real adapter request capture over three rounds and recovery; retained exact names/args/order/signatures; no duplicate or missing result; cancelled finish, missing end, mismatched end, duplicate finish and disconnect all cause zero tool mutations. Existing valid fragmented streams continue to work.

### F05 — Send the bounded conversation and authoritative source context

`getTurnContext` loads `recentMessages`; the handler sends only its system prompt, current source and most recent clarification answer. The review saves a reference in one turn, asks about it in the next, and confirms the provider input has none of the persisted reference. This directly violates the intended ongoing conversation.

Use a source-linked bounded transcript in chronological order with actual member/system attribution. Exclude the current input once by source identity rather than accidentally sending it twice. Retain sequential clarification questions/answers and exact prior provider tool history as separate protocol data.

Assemble the applicable member identity/local date, original pending operation, matched entity/alias, current typed clear/disputed fields, relevant events/tasks and sourced notes. Currently `pendingOperation` is accepted by the context parameter type but unused, and active note rendering drops IDs/applicability/source references. Do not rely solely on a possibly absent or stale summary for authoritative state. Preserve the decision's observed revision; do not fetch the latest revision immediately before writing and thereby bless an interpretation based on older facts.

Render stored/forwarded material as explicitly lower-trust data, not appended standing system instructions. Apply suppression to historical source excerpts before active preference/promotion assembly. Forgotten history may still be inspected as history; it must not silently become an active instruction again. Use bounded retrieval, not all-entity scans followed by an N+1 query for every matched name. Add aliases to the existing resolver rather than a new search service.

Tests: a reference remembered only in a previous turn; correction after several turns; sequential questions; Avi versus Hunor attribution; source manifests; current disputed amount never used as settled; missing/stale summary still retrieves typed facts; alias mention; source changed during inference produces a revision conflict; midnight and retry preserve the intended member-local date; forgotten source is inspectable but not applicable.

### F06 — Resume the saved operation and feed back its receipt

Typed ledger resume already commits the clarified command. The handler then discards the clarification phase, increments the round number and invites a new plan without the resolved command's result. A missing-date task followed by an explicit no-deadline answer yields one task during resume and another from the subsequent provider call.

Attach each pending question to its original planned call/step/logical operation. Persist and consume clarification IDs and resolved result receipts exactly once. If the existing typed resume commits the operation, reconcile that receipt into the original call's result and continue the remaining saved group. Do not independently execute the original operation again or abandon later saved calls.

For control-tool questions, preserve `pending_operation`/proposed arguments/source revision and the actual clarification ID. The repository returns that payload; the handler currently discards it while building `TurnOutcome.needs_input`. Status-confirmation questions must resume with verified approval instead of checking the original ambiguous sentence again forever.

Tests: missing deadline creates exactly one task after answer; restart between answer commit and handler resume; repeated answer; two successive questions; confirmation of an inferred status; four-target scope confirmation; a tool group with calls following the blocked call; source revision changed by Hunor while Avi answers; no new model proposal substitutes for the saved command.

### F07 — Implement the already-required bounded execution contract

`maxRoundsPerSlice` limits one invocation, not the run. Progress lacks durable cumulative request/tool/token counters or reservations. Output tokens/timeouts are hardcoded. `workspace_daily_actions` exists but has no committing enforcement. Missing production limit configuration permits inference and writes; the review records four actions with no quota row.

Use validated deployment/operator configuration for the limits named in the original handoff. **The illustrative 100 actions/day and 20k tokens/turn were not approved production defaults. Do not invent them.** Tests inject small explicit values. Missing required production configuration returns a configuration failure before provider inference and mutations while preserving accepted input; report the exact missing values for operator setup.

Persist request reservations before inference; reconcile each request's reported usage once, including cumulative usage snapshots. Unknown usage/cost remains unknown and interrupted reservations remain conservative. Enforce total provider rounds, calls, output/context/stream sizes, retry attempts and token allowances across restart. Count logical applied actions atomically with ledger/settings commits in UTC-day scope. Replays/reads count zero, compound events count by actual command action, and independently committed field children count individually.

Do not build a billing platform. A few counters/reservations tied to existing run/receipt identities suffice. Preserve typed transient/reset hints so known transient errors retry within a durable bound; the current generic stream-error collapse permanently fails all such errors.

Tests: absent config; per-call/per-round/per-run limit; interrupted provider/restart does not reset allowance; cumulative usage not double-counted; concurrent Avi/Hunor daily cap; ledger/memory/settings all count; duplicate replay; UTC midnight; partial committed work gets receipt-backed partial status/explanation.

### F08 — Enforce verified intent, confirmed scope and lower trust

`isExplicitStatusIntent('Do not mark Bistro as warm.', 'warm')` returns true. It is not bound to the proposed entity or verified evidence span. The repository checks only the first status field. Bulk/disputed policy helpers are exported but not used by the actual handler/repository path; four-target mutations proceed without confirmation.

Source trust defaults to member and the production handler does not supply authenticated forwarded/quoted-source metadata. The lower-trust mutating-tool set omits memory promotion and draft/sent operations. The review passes `sourceTrust: memory` and succeeds in persisting an imperative as a **stated** workspace note. Stored text is also rendered into a system message. `mark_message_sent` performs no explicit human-confirmation check.

Implement the small verified-proposal boundary from the existing handoff: proposed evidence must exist in the correct member-authored source, identify the target/change, and not be a negation, quote or unrelated instruction. Treat uncertain paraphrases conservatively with a saved clarification; do not grow the English regex collection into a natural-language authorization engine. A model boolean/provenance label is not approval.

Apply bulk limits across the entire proposed operation, including calls split across a group. Preserve the approved target scope across resume; approval cannot authorize extra entities. Validate disputed values before draft/task reliance. Require explicit draft request and sent confirmation; do not claim external sending occurred. Validate memory promotion as clearly durable and its entity/member subject inside the workspace; communication preferences apply to the correct member.

At read/execution boundaries, recheck live membership when a paused inference returns. Workspace filtering alone does not revoke a removed member's access. Keep existing source/chat/author checks; do not create new roles.

Tests through the real handler/repository: negation, quoted instruction, wrong-target instruction, Romanian/Hungarian explicit instructions versus inference, multiple status fields, four targets across calls, exact approved scope, disputed quote in a draft, unsolicited draft, unconfirmed sent mark, transient preference versus standing preference, invalid member subject, forwarded/stored imperative and removal during inference. Assert actual database effects/source IDs, not only policy helper return values.

### F09 — Repair undo targeting and memory consistency

The undo schema lists `action_id`, but the global forbidden-authority check rejects it before the undo-specific allowlist. Distinguish a historical **target** action reference from a model-selected identity for its new command. Validate the target through existing workspace/author/run ownership; do not globally remove trusted-ID protection.

Bare undo says it selects this chat's latest action, but filters workspace receipts only by author. Add current-chat scope through persisted run/source relationships. Preserve selected-step same-run suffix semantics and existing handling of intervening teammate writes.

Memory D1/FTS/suppression writes run only when newly emitted events include `memory_note` or `memory_forgotten`; undo emits `revert`. The note stays active after a successful undo. The operator replay reads only note/forget events, so it resurrects reverted notes as well. Reuse the existing `rebuildProjections` revert semantics rather than a second memory-only replay algorithm that omits causal reversions.

Make the guarded command publish the resulting memory projection/suppression/FTS state and refresh invalidation atomically, including deletions of entries no longer in the projection. Rebuild against a guarded revision/maintenance boundary so concurrent source commits cannot be lost. Invalidate affected summaries consistently. No new business events or chat replies during operator rebuild.

Tests: explicit selected action; current chat versus another chat by Avi; suffix undo; remember then undo; forget then undo; supersede then undo; online projection equals full rebuild; FTS and suppressions agree; forced final-statement rollback; concurrent source change rejects/retries rebuild rather than erasing new data.

### F10 — Preserve applicability through every summary layer

Direct context retrieval filters other members' preferences correctly, but workspace summarization selects all active memory scopes and strips scope/subject. The review records Avi's preference, builds a workspace summary at the current revision, and finds the preference in Hunor's actual system prompt even though `activeNotes` excludes it.

Workspace summary should contain workspace-applicable context. Keep member-scoped summaries keyed/selected for the actual subject and carry source/applicability metadata through rendering. The current builder has no member-scope branch and can mark an empty member summary completed; implement the bounded member extract or retain direct member retrieval with an honest unsupported/coalesced job policy. Never treat an empty unsupported build as successful coverage.

Tests: both members' conflicting preferences; each provider request receives only its applicable style, including summary path; all members can still inspect history/notes; removed member cannot read; valid subject/source manifest preserved. This is applicability isolation, not a new chat privacy requirement.

### F11 — Finish the existing durable refresh job correctly

Discovery queries expired `state='claimed'`, while schema and writer use `running`. A crashed running job is invisible forever; the probe demonstrates it. Discovery/claim also ignore `next_attempt_at` and `max_attempts`.

The builder writes the summary directly before job completion. Its publication has no claim token/expiry/current-revision check. An expired worker can publish despite losing its job, and overwrite a successor's newer summary. The final completion condition checks only token, not live ownership/revision. This race is a high-confidence static trace; do not claim the reviewer ran a paused competing-builder reproduction.

Separate bounded extraction from publication just enough to publish summary plus job completion in one guarded D1 batch. Check current claimed state/token/expiry and unchanged represented source revision. Stale workers publish nothing. Honor backoff/exhaustion, requeue/coalesce changed sources, and ensure represented business/memory/undo changes leave durable refresh intent for affected summaries. Source commit succeeds even if wake-up publication fails.

Reuse `otis-dispatch` and the current discriminated consumer; no second queue. The consumer branch exists, but durable refresh creation currently has no producer wake-up path. Publish a hint after source commit where available and prove cron can recover without the hint. Keep passes bounded and avoid starving later workspaces behind permanent failures.

Tests: expired running job; duplicate hint; missing hint; backoff; permanent/exhausted job; A paused before publish, expiry/takeover B publishes, A resumes and changes zero rows; source changes between extract/publish; business change/undo invalidation; empty scope handled honestly; safe direct-record fallback; no extra events/replies.

### F12 — Replace claimed acceptance with measured pipeline evidence

The eval runner computes hypothetical status from schema/policy checks and increments a counter for recognized mutations. It never runs `AgentHandler`, migrated D1 or real ledger effects. Source-link correctness is calculated from nonempty source text/user strings, and memory promotion accuracy is the literal `100.0`. Therefore its existing 14 fixture passes cannot establish zero actual wrong writes, correct sourcing, tenant isolation, undo or memory lifecycle.

Keep useful pure helper tests, but label them as such. Add deterministic fixture execution through the fake provider, real composed handler and migrated D1. Verify resulting command receipts/events/projections/questions/sources and exact allowed/forbidden changes against expected state. Measure outcomes from those effects. Unmeasured metrics are null/not evaluated, not 100%.

Include multi-turn fixtures for context, clarified tasks, confirmation, contradiction, suffix undo, memory recall/forget and cross-workspace isolation. Tests should fail on incorrect values/targets and missing expected writes, not only excessive counts. Seeded scripted calls test pipeline handling; they do not prove a live model interprets natural language perfectly. Keep that limitation explicit. No paid live inference is required for this repair.

Update completion documentation to remove unmeasured accuracy claims. Acceptance requires all original 006A–006D behaviors, not just the fourteen review probes. Have a reviewer inspect the actual metric computation before publishing scores again.

### F13 — Make supported read filters mean what they say

`search_memory` ignores its required query and returns recent active notes. `query` accepts entity/assignee/date/cursor filters that some resource branches discard silently. This gives the model apparently successful but unrelated results, e.g. all open tasks instead of a member's due-today tasks.

Implement the small documented filter set for its valid resource, stable ordering/cursor semantics, and bounded source-linked memory search using the existing FTS sanitization/fallback. Reject unsupported filter/resource combinations; never silently broaden a query. Reuse retrieval helpers only where they share actual behavior. Add no generic SQL/query DSL. This is a source trace, not an independently executed filter reproduction.

Tests: two entities/users/due dates; each accepted filter narrows correctly; cursor page has no duplicates; unrelated memory query excludes irrelevant notes; FTS fallback retains query intent and scope; unexpected storage/auth failure is not a successful empty result.

## Repair order and bounded handoff

Execute these as six review checkpoints within **006**, not new numbered roadmap gates. Keep working tree changes uncommitted unless the user separately authorizes committing; preserve all unrelated changes. After each checkpoint, report modified files, actual tests and remaining IDs. Do not announce gate completion after one group.

1. **Durable runner/protocol:** F01–F04. Files: Worker handler, pure progress/collector, narrow actor checkpoint integration, owning agent/actor/provider tests. Resolve clocks/fencing/allocation before adding further runner behavior.
2. **Context and clarification:** F05–F06, F13. Files: Worker context/repository/handler, prompt/types and narrow clarification integration. Use stable logical receipts from checkpoint 1. Do not independently redesign 004B.
3. **Bounded trusted execution:** F07–F08. Files: handler/progress/policies, ledger/identity committing boundaries, configuration/contracts and tests. Add only schema fields demonstrably necessary for durable counters/approval linkage. Use the next free migration if 0008 may have been applied; never rewrite applied migration history.
4. **Undo and scope consistency:** F09–F10. Files: tool validator, repository undo targeting, memory reducers/executor projection writes, retrieval/summary and tests. Shared inspection and per-member applicability both remain intact.
5. **Refresh correctness:** F11. Files: Worker memory refresh and existing queue/cron composition, narrow durable-intent bridge, tests. No new infrastructure. Source/summary/claim races are decisive acceptance cases.
6. **Honest acceptance:** F12 and documentation reconciliation. Keep desired-behavior regression tests in the normal suites. Execute all Appendix A cases through the composed pipeline and check every required 006A–006D scenario in the original handoff.

Per-checkpoint verification:

```powershell
$env:TEMP='D:\wtmp'
$env:TMP='D:\wtmp'
pnpm typecheck
pnpm lint
pnpm test
```

Final verification also runs `pnpm eval:agent`, `pnpm build` and `git diff --check`. These commands must exit 0 with new desired-behavior tests included; build is still only a dry-run. Show test names and decisive state assertions, not only a larger aggregate count.

Stop and report a concrete blocker if a repair requires changing a settled product decision, introducing new infrastructure, weakening the existing fence/source guard, inventing production caps, using live paid calls, or modifying unrelated user work. Ordinary helper extraction and test fixture choices are implementation decisions; they do not require repeated permission. If current code drifts, inspect the live symbol/diff before applying this contract rather than relying on line numbers.

## What was accepted as reasonable, and review limits

The pure agent/SQL bridge boundary is appropriate; the ledger and identity owners are reused; fake providers and migrated workerd D1 are useful; schema validation and an entire-call-group validation point exist; source mutation and refresh-intent batching are good directions; no extra runtime service is necessary. File length alone, an extractive summary instead of paid summarization, and placing D1 memory in the Worker are not release findings.

This review concentrated on new Gate 006 execution, policy, context/memory, ledger/settings adapters, tests/evals and immediate actor composition. It did not re-audit the entire previously accepted provider transport/auth stack, verify a deployed service, exercise real-browser mobile UI, probe live API models, measure performance/load, or audit third-party packages. Existing API keys were neither reproduced nor sent to providers. A local build is not deployment evidence. Those limitations do not weaken the independently reproduced defects.

**Acceptance owner:** independent reviewer. The implementation agent may mark repairs IMPLEMENTED; review pending with actual evidence. It may not change 006 to DONE or open dependent acceptance on the strength of its own summary or simulated metrics.
