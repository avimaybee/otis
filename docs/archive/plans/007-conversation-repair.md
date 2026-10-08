> Closed historical plan record, reconciled 2026-10-07 from `plans/007-conversation-repair.md`. Family 007: APIs/commands/wake present; streaming authority/recovery partial. Remaining R02, R04, R05, R14 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# Repair the deployed conversation before adding features

Status: TODO. Priority: P0 for native provider transport; P1 for dispatch, streaming, readiness and misleading UI. Planned at `8f88638`, 2026-10-03. Category: runtime correctness / integration / UX. This is a repair within the existing architecture, not a new roadmap gate.

The reviewer inspected source and reproduced runtime defects locally. Production repair and deployment are not claimed. Existing gate acceptance covers its recorded local evidence; it does not establish a working deployed chat. This repair takes priority over further thinking options, voice, briefs, exports, and additional provider/model work.

## Goal

Avi signs in, types a message, sees Otis begin promptly and receive a streamed reply, then refreshes and finds the same conversation. Commands are optional helpers. A successful `/model` or `/thinking` command is not proof that the agent can answer.

Do not create another orchestration framework, migrate cloud providers, rewrite the ledger, introduce an ORM, remove idempotency/fencing, or add paid infrastructure to solve these problems. Implement and prove one working conversational path using the existing verified Go model and existing Cloudflare services first. Preserve business data, member isolation, equal membership and author-only chat appends.

## Observed failures and independent evidence

User screenshots show: missing_budgets; model_unavailable/no_model_selected after a positive `/model default` confirmation; provider_stream_error/Provider transport failed; a green `turn:agent` step on a failed request; developer-facing voice messages. Attached browser log contains repeated SSE reconnects and repeated full-history run reads. The log does not expose the original provider exception, the live Cloudflare plan, or current deployment configuration.

| Finding | Source and evidence | Required outcome |
| --- | --- | --- |
| P0 native fetch receiver | `apps/worker/src/providers/service.ts` passes `params.fetchFn ?? fetch` into adapter classes. Both classes call `this.fetchFn(...)`. Actual adapters bundled into Miniflare/workerd with native fetch and a synthetic key return `transient / Provider transport failed`. A native holder call directly throws Illegal invocation. The actual Go adapter with an arrow wrapper and a mocked native HTTP response yields text_delta then finish/success. | Correct receiver handling in both real adapters/default injection; regression in the Workers runtime rather than only Node mocks. |
| P1 dispatch depends on queue and periodic recovery | `apps/worker/src/dispatchHint.ts` publishes only a queue hint; no queue means return and wait for cron. `wrangler.jsonc` has batch size 10 and no batch timeout. `WorkspaceActor` exists but ordinary input does not call it. | Explicit low-latency normal dispatch, with the five-minute cron only a recovery backstop. |
| P1 checkpoint can wait for another hint | `dispatchWorkspace` breaks on deferred; handler normally slices after two rounds; index.queue processes one slice and does not schedule another. | Pending continuations get a near-term wake, including a single user message requiring more than two rounds. |
| P1 expensive SSE polling | `chat/stream.ts` checks session/membership twice per empty iteration and reads chat/activity each iteration. `verifySession` additionally updates last_seen_at on every check. Default poll is 500ms, stream lifetime five minutes. An independent execution of the actual stream with a synthetic 50-query D1 ceiling fails at query 51 after only the initial retry frame. | Query-bounded live delivery, clean cursor reconnects, no full-history reload loop. |
| P1 readiness not surfaced | Handler rejects unconfigured limits; default model can be NULL; `/model default` positively confirms without validating that the default is usable. Model list availability checks credential/lifecycle but not the complete resolver. Settings shows model read-only. | Configure and expose a usable model/key/runtime before presenting an ordinary ready composer. No opaque failure after every greeting. |
| P1 preview buffering | `agent/handler.ts` flushes public text only at 2048 characters or stream completion. | Short answers become visible while the provider is streaming. |
| P1 misleading interaction | `components/Transcript.tsx` treats internal turn receipts as user work; succeeded receipt may contain a failed TurnOutcome. Composer voice button only toasts a future gate; `/help` plain newlines collapse under Markdown. | Honest progress, useful failure recovery, no dead controls or build-stage jargon. |

The Workers receiver bug is established independently of any live provider/key problem. The D1 ceiling reproduction proves a design incompatibility with the documented Free limit; it does not establish that this particular deployed account is Free or that this is the only cause of the user's SSE disconnects. Do not report an unobserved production exception as confirmed.

Primary references, checked 2026-10-03:

- [Workers Illegal invocation](https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors)
- [Queue batching](https://developers.cloudflare.com/queues/configuration/batching-retries/): default batch wait is five seconds.
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/): queries per invocation 50 Free / 1000 Paid.
- [Workers execution lifetime](https://developers.cloudflare.com/workers/platform/limits/): HTTP waitUntil extends work for up to 30 seconds after response/disconnect; queue consumers and DO alarms have different lifetimes.
- [DO alarms](https://developers.cloudflare.com/durable-objects/api/alarms/): durable scheduling and at-least-once execution if an existing-actor wake is needed.

## Work rules and source owners

Read AGENTS.md, design.md, current product/contracts and this entire plan. Inspect Git status and compare current source with the evidence above. Preserve concurrent modifications. Use prepared SQL and existing error envelopes, acceptance owner, scoped membership guards, run receipts and dispatch path. The review is not authorization to publish a deployment or send real lead messages; apply existing session authorization and record what actually ran.

Relevant owners:

- `apps/worker/src/index.ts`: runtime handler construction, WorkspaceActor, queue/cron entrypoints.
- `apps/worker/src/dispatchHint.ts`, `routes/chats.ts`, `routes/clarifications.ts`: accepted-input and resume wake-up.
- `apps/worker/src/actor/dispatch.ts`, `leases.ts`: durable claims, slices, continuations, lease fencing.
- `apps/worker/src/providers/service.ts` and provider adapters: default real fetch injection and verified model resolver.
- `apps/worker/src/chat/stream.ts`, `activity.ts`, identity session helpers: live delivery and authentication.
- `apps/worker/src/agent/handler.ts`: provider loop, public chunks, typed failure handling.
- `apps/web/src/ConversationScreen.tsx`, `hooks/useActivityStream.ts`: load, cursor and subscription state.
- `apps/web/src/components/Transcript.tsx`, `Composer.tsx`, `SettingsPane.tsx`: actual user experience.
- `packages/commands/src/help.ts`: generated help text.
- Existing `apps/worker/test` runtime/integration suites, package adapter suites, web owning tests, and native browser review record.

## Step 1 — fix the real provider call, then prove it

Use the smallest receiver-safe transport change. Suitable default injection: `params.fetchFn ?? ((url, init) => fetch(url, init))`. Alternatively make adapter invocation receiver-safe at its owner, e.g. normalize supplied functions with an arrow wrapper. Ensure both Gemini and Go remain safe when given native platform fetch directly. An arrow wrapper around the lexical fetch invocation should not attach the adapter as its receiver. Do not switch SDKs or modify endpoint IDs to mask this bug.

Write a workerd integration regression using native global fetch with the platform's HTTP fetch mock to return valid provider SSE. Exercise the **production transport selection**, not only an injected arrow fake. Go must yield the fixture text and success; Gemini must parse its own valid Interactions fixture. Verify exactly the expected request and no real network. Mock transports that ignore receiver requirements are insufficient to catch this failure.

Preserve typed failure information through the collector/handler. The current catch turns every provider failure into provider_stream_error and hides the underlying exception. Operator diagnostics need a bounded safe code and stage (transport/HTTP/decoding/limits), request/run IDs, provider/model and HTTP status where available. Never log authorization headers, keys, full prompts, raw payloads or arbitrary upstream bodies. Avoid a generic infrastructure exception being labeled a model reasoning problem.

Local receiver reproduction already run by the reviewer:

```js
// Inside a Workers request handler, not a Node-only test:
const holder = { fetchFn: fetch };
await holder.fetchFn('https://example.com'); // current receiver pattern throws
await ((url, init) => fetch(url, init))('https://example.com'); // works
```

Actual Go adapter result with synthetic native HTTP mocking:

```text
native fetch stored/invoked as member -> transient / Provider transport failed
arrow wrapper -> text_delta("Hello from the fixture"), finish(success)
```

This is transport evidence, not a real provider model/key inference test. After the local fix, run a bounded synthetic greeting through the deployed application only where authorized. The request must traverse authentication, persisted input, actual dispatch, stored workspace credential, real adapter, public stream and durable final answer. Standalone smoke.live.ts cannot substitute for this path.

## Step 2 — readiness should be clear before a failed conversation

Verify the actual deployment has required limits, CREDENTIALS_KEY, schema, verified workspace credential, usable default model, queue producer/consumer and trigger configuration. Read/report names and health only; never emit secret values or chat contents in diagnostics. The current wrangler config contains limits 200 actions/day and 20 rounds/run, but that does not prove an older deployed version has them.

Do not force Avi to debug those operator requirements through chat. Validate runtime settings at an appropriate startup/health/config boundary; expose a scoped readiness result to the browser with safe reasons and next actions. Reuse existing routes where possible. An unavailable workspace should display one concise setup state while retaining the user's draft/history. It must not invite an endless sequence of messages guaranteed to fail after queueing.

Use the existing verified handpicked registry and shared encrypted credential storage. Present full model display names. For Kerning dogfood, configure an actual usable default rather than leaving default_model NULL; use the existing guarded settings owner and evidence-backed choice. A model picker must use the same complete availability rules as the resolver (approval, lifecycle, required text/tools/stream capabilities, credential health). No automatic paid fallback or automatic enablement of secondary models.

Fix `/model default`: it may clear an override, but if no usable default exists, its recorded reply must say so and offer usable choices. It must not announce readiness. Do not conflate saving a key, verifying a key, and proving a live inference; keep those distinctions in operator evidence without putting jargon into ordinary conversation.

Add a minimal usable model/configuration control by reusing existing settings APIs. API keys remain a one-time masked/write-only field through the encrypted settings owner when needed. No dashboard, provider-management framework or required per-message command workflow.

## Step 3 — immediate dispatch and prompt continuation, within the existing stack

First repair the existing queue route: use batch size 1 and a verified zero/lowest supported batch wait for interactive wake-ups, ensure the consumer is actually deployed, and prove ordinary input begins dispatch without invoking cron. A production binding alone is not evidence of a running consumer. Keep the queue as an execution trigger; queue hints must not replace D1 truth or authorize business writes.

A slice ending at a checkpoint must publish/schedule a near-term continuation. A contended wake must not disappear with all messages acknowledged while a later pending run waits until cron. Use the existing queue retry/send path to continue pending work, with a bounded delay for real contention rather than a busy loop. Inspect dispatch outcomes and durable pending work before acknowledging a consumed hint as finished. Continue to use existing leases/receipt/fence guards.

Do not run an unbounded provider loop in HTTP ctx.waitUntil after returning 202: provider timeout is 60 seconds and HTTP post-response lifetime is 30 seconds. If measured queue latency still fails the target, adapt the **existing** WorkspaceActor to accept a short wake, arm an immediate durable alarm, and execute the existing bounded dispatch slice from its alarm. Queue and cron can remain fallback recovery triggers. Choose one normal execution owner; do not add queue + DO + direct HTTP copies of the agent loop. A DO alarm is a platform-supported fallback implementation, not a prerequisite for the initial fetch repair.

Use precise monotonic timestamps for accepted_at, dispatch_started_at, provider_started_at, first_public_text_at and finished_at in diagnostics. Acceptance response need not wait for generation. Local deterministic acceptance should wake an idle workspace immediately; dogfood target is dispatch beginning within one second in normal idle conditions, measured separately from provider response latency. If Cloudflare's measured queue delivery cannot meet that, report actual timings and use the actor wake rather than claiming immediate behavior from a comment.

Retain same-workspace write serialization for this repair; do not add a new read/write scheduler. Real contention can be explained briefly. An idle workspace must never say “waiting its turn” because its wake mechanism is absent. Clarification continues to release the slot. More concurrency is separate future optimization and not required to reply to a greeting.

Test provider/run execution longer than a slice and approaching the live lease. Current lease default is 120 seconds and slices can include two 60-second provider requests. Keep renewals/checkpoints safe within this bound; a expired holder cannot renew and commit stale work. Do not introduce indefinite retries to repair latency. Bound provider retries and retain the same run/receipts; no duplicate business effects.

## Step 4 — make streaming real and cheap

Change preview flushing from 2048-character/end-only to small bounded time/size batches, targeting visible text updates around 100–250ms while tokens arrive. Flush the first nonempty text promptly. Preserve existing payload caps and persist-before-publish guarantees. Do not create one D1 transaction per token. Clean up timers on finish, cancellation and failure; no leftover flush after lease loss. An awaited DB write must not reorder provider tool events.

Repair SSE query usage before extending stream duration. The empty polling path currently performs roughly eight SQL operations per iteration, including last_seen writes, and can exceed Free's 50-query request budget quickly. Eliminate duplicate auth checks and hot-loop last_seen updates. Use a small scoped auth/session/membership read appropriate to a live stream, preserving revocation checks before content delivery.

For the existing polling implementation, track a conservative per-request query budget and deliberately rotate before the platform ceiling, accounting for route setup queries too. A clean bounded reconnect from the last delivered cursor is acceptable; it should not trigger a full transcript+all historical runs reload. Do not promise five uninterrupted minutes of SQL polling on the Free tier. Reuse existing cursor replay and emit a controlled reconnect signal if needed. Unknown transport/DB exceptions need safe operator diagnostics; do not silently disguise every server error as a stale cursor.

Client catch-up resumes after its last applied cursor. Reconnect performs a scoped incremental read; full snapshots are for actual resync/gaps or initial opening. Cache immutable terminal run detail in the current view; after one activity change, refresh the affected run rather than all runs from the transcript. The supplied log currently shows four base reads followed by nine run reads repeatedly, including the same old failure warnings. Avoid this fan-out and log each terminal transition once.

Keep the simple existing SSE contract for this repair. No WebSocket migration, broker or observability service. Only use DO push if later measured limits require it; it is not necessary to fix receiver handling, chunk buffering and bounded reconnects.

## Step 5 — remove friction and false signals

- Accepting a message shows it promptly with one quiet Starting/Working state. The status reflects actual lifecycle. A genuine teammate run can show a brief contention explanation; do not make ordinary internal queue mechanics the central chat content.
- Internal `turn:agent` and checkpoint rows remain operator/recovery receipts, not claimed user tool actions. Exclude them from ordinary Working step counts. A receipt succeeding means the handler returned an outcome, not that the user request succeeded. Derive visible success/failure from actual tool results/run outcome. A failed greeting must not show a green completed tool step.
- Display actual tool labels/activity while tools run and compact them after completion. A plain answer with no tools should not manufacture a one-step Working history.
- Failures use human-readable language and one actionable next step, with technical detail available on inspection. Keep run/request IDs accessible for diagnosis. For a failure with no applied business effects, offer a deliberate retry using the existing request lifecycle and a fresh accepted operation where necessary. Do not replay an old acceptance ID expecting it to re-execute, and do not retry a partially committed task as a new run without checking receipts and explaining what was saved.
- Add an author-scoped Stop control using the existing stop endpoint, retaining the ability to send follow-up text. Stop should affect future work and public state promptly; preserve committed changes.
- Hide the nonfunctional voice/attachment controls until their real implementation is ready. Remove the `Gate 010` toast. The user must never need implementation-plan knowledge to use Otis.
- `/help` must render as a readable Markdown list, with a short useful set of available commands. Do not include unimplemented `/sheet` as an ordinary available action or make commands mandatory for chatting. Remove unrelated voice-not-available boilerplate from every model confirmation.
- Preserve charcoal tokens, assistant prose, mobile-first layout and one composer. Inspect actual deployed typography and spacing against design.md; do not assume a screenshot proves current CSS is loaded. Fix only demonstrated font/layout issues after the reply path works.

## Required evidence, in implementation order

1. Receiver regression in real workerd: actual production transport + native fetch + mocked HTTP yields a complete answer; both adapters covered. Test must fail against the current pattern.
2. Ordinary accepted message dispatches with cron disabled; test actual wake/consumer binding, not only direct dispatchWorkspace. Verify a message requiring three or more model rounds finishes without another human message or cron.
3. Duplicate hint, concurrent input and restart still produce one set of business effects and one final reply. A parked clarification lets the teammate proceed.
4. Empty and active stream requests stay under a synthetic 50-query ceiling. Controlled rotation resumes cursor without gaps or duplicate visible text; membership revocation stops subsequent delivery. Inject an actual DB failure and prove bounded reconnection rather than a request storm.
5. A fixture emits a short response with deliberate time between chunks: first text is persisted and visible before provider completion, not only at the end. Timer cleanup and a stale lease cannot emit unauthorized late chunks.
6. Unconfigured default/credential/runtime shows one actionable setup state and preserves the draft. Model availability agrees with resolver; `/model default` cannot claim a usable configuration when absent.
7. Failed greeting has no green `turn:agent` history; a genuine applied tool remains inspectable/undoable. Help is readable and no dead voice button remains.
8. Run owning tests and `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `git diff --check`. Preserve existing root test configuration; no real inference in CI and no broad weakening of assertions to make them pass.
9. Record a real browser session against the application, using native browser controls, no Playwright: greeting, contextual follow-up, refresh, clear business instruction, missing-date clarification, reply, retrieve saved fact, correction, tool inspection, failure recovery. First prove the greeting before adding more features. Exercise phone width and desktop; timing evidence separates dispatch latency from model latency. No private lead data required.

Acceptance requires visible end-to-end behavior, not just green command replies or a standalone provider probe. Report local evidence separately from remote deployment/browser evidence. Do not label this repaired until the real deployed conversation answers and persists correctly.

## D1 economics containment — implemented 2026-10-04 (local only; deployed unverified)

Production exhausted the D1 free 100,000-writes/day budget with an idle app. The containment below is implemented and proven in this worktree only. Nothing here is deployed, and no historical production behavior is claimed fixed: the deployed worker may predate this source (notably the `touch: false` stream ticks), so deployed write sources must be re-measured after deploy, not inferred from this diff.

### Containment diff (narrow; UI frozen, no new services)

- `packages/identity/src/session.ts`: `verifySession` is now a pure read. The `touch`/`touchIntervalSeconds` mechanism and its fire-and-forget `UPDATE sessions SET last_seen_at` are deleted (the column still records creation time; nothing reads `last_seen_at` — no cleanup, UI, or policy consumes it — so touches were eliminated, not re-debounced). Every GET scope route (`/api/me`, `/api/workspaces/:id`, all `requireWorkspaceScope` readers, SSE connect/reconnect/heartbeat polling) now costs zero D1 writes by construction. Remaining route-level writes are POST meaningful actions only (undo/command handlers in `routes/actions.ts`, message acceptance) — verified by grep, no GET-path writes remain.
- `apps/worker/src/chat/stream.ts` + `chat/activity.ts`: per-request query budget rotation. Stream-internal reads are counted (`STREAM_QUERY_BUDGET = 40`; `readChatActivity` takes an optional exact counter) and the stream ends with a clean close at 40 — 3 route setup reads + 40 internal + worst-case final tick 4 = 47, held under the documented D1 Free 50-queries-per-invocation ceiling with margin. Budget expiry deliberately does NOT emit `resync_required` (that forces a full snapshot reload for a healthy stream); the existing clean-rotation path reopens from the cursor with a cheap connect. Revocation still closes immediately via `membership_revoked`; stale cursors still get `resync_required`; budget and staleness are separate signals.
- Deliberately NOT changed (audit result): cron `scheduled()`, `processMemoryRefreshJobs` step-0 cleanup, `recoverWorkspace` (incl. the parked `waiting_for_input` revisit and the restrictive cancelled-outbox UPDATE), leases, dispatch claims. The unconditional UPDATEs match zero rows when idle — proven by changed-rows evidence below, not rewritten. Blind rewrites of recovery semantics were refused.
- Deliberately NOT changed (needs Avi product call, see 014): 500ms poll cadence, per-round preview caps, idle backoff.

### Executable evidence (all local workerd; deployed unverified)

- New `apps/worker/test/d1-economics.integration.test.ts` (6 tests): a counting D1 wrapper records every statement by verb plus `rows_read`/`rows_written` from `run`/`all`/`batch` result meta (meta presence itself asserted — miniflare provides it there; `.first()` returns no meta, so `first()`-based SELECTs contribute statements but no measured rows, while write coverage is complete because all writes go through `run`/`batch`). Setup fixtures run on the raw binding; only measured phases run counted.
  - Production GET scope (`/api/me`, `/api/workspaces/:id`, activity JSON): exactly 9 statements (2 + 3 + 4), 0 write statements, 0 rows written.
  - Idle SSE to budget rotation: 40–44 internal statements, 0 writes, clean close (heartbeats present, no `resync_required`).
  - 3 concurrent tabs × (stream + reconnect): each ≤ 88 statements, 0 writes, no `resync_required`.
  - Idle memory refresh + recovery discovery: 1 zero-row UPDATE statement, 0 rows written.
  - Idle + parked-`waiting_for_input` recovery + idle dispatch: 2 zero-row UPDATE statements, 0 rows written.
- Rewritten `chat-api.integration.test.ts` touch test → `verifySession` never writes across repeated calls. Full worker project: 15 files / 238 tests green; web+pure: 27 files / 348 green (incl. R8 echo as deterministic acceptance-boundary proof — bubble with held network/nav, one identity — instead of wall-clock around `React.act`; the product 100ms target stands in design.md/docs, evidenced natively by `immediateEcho` in `plans/008-browser-evidence/synthetic-app-probe.json` / `two-send-probe.json`).
- `pnpm typecheck` / `pnpm lint` green. Full `pnpm test` could not be re-run to completion: C: has 0 bytes free, so workerd-based runs hang on SQLITE_FULL (TEMP redirected to D: for the runs above). No commit/push/deploy.

### Read/write budget (free tier assumed 5M rows read / 100K rows written per day; MEASURED = D1 meta or test-asserted, EXACT = code-counted statements, ESTIMATE = index math shown)

Meta coverage, precisely: the counting wrapper records `rows_read`/`rows_written` from `run`/`all`/`batch` result meta only — `.first()` returns no meta, so `first()`-based SELECTs contribute statements but no measured rows. Write coverage is still complete: every D1 write in this codebase goes through `run()` or `batch()`, never `first()`.

- Idle vs active kept separate: the touch removal above fixes idle WRITES; the fanout proposal (014) addresses idle polling READS and active preview persistence. The preview change is not claimed to explain idle writes.
- Idle SSE per tab-hour (ESTIMATE from exact tick cadence): ~7,200 cursor reads + ~480 membership rows + ~170 budget-rotation reconnects × ~5 setup rows ≈ ~8.7k rows read, 0 written (zero writes MEASURED).
- Idle 24h (ESTIMATE): 1 tab ≈ 209k reads / 0 writes; 2 tabs ≈ 418k; 10 tabs ≈ 2.1M reads / 0 writes. Plus idle cron ≈ 3–4k reads/day, 0 written (MEASURED). Idle per-request statements are EXACT: GET scope 9, stream request ≤ 47.
- Active 60s / 20-round answer (statements EXACT, rows ESTIMATE): accept ≈ 8 statements; previews up to 32 text batches/round = 640 batches × 3 statements (guard INSERT + chats UPDATE + run_activity INSERT) = 1,920 statements; thinking batches flush size-triggered (1,000 chars) or timer-triggered (400ms, 32-char floor), so the 24k char cap does NOT imply ≤24 rows — worst case approaches 24,000/32 ≈ 750 tiny rows per run; end receipts ≈ 2/round. Rows written depends on index accounting — present structures are row + PK plus `(chat_id, cursor)` on `run_activity`; NO universal multiplier is assumed here. Indicatively, at ~2 rows_written per statement a heavy answer costs low-thousands rows (previews alone), but the real factor must come from D1 metadata after deploy, not this doc. Per-round caps do not bound the run (whole-run discipline proposed in 014 as zero preview rows, not a persisted cap).
- Transient display (ephemeral-eligible, see 014): `text_chunk` (≤640/run by the per-round cap), thinking batches (flush-timing dependent, worst case ~750/run), heartbeats (already network-only). Business facts (must stay durable): `message_accepted`, `answer_saved`, `action_applied`/`action_reverted`, receipts, checkpoints, completion rows.
- Residual risks (not fixed here): idle reads approach half the free tier at 10 tabs (push fanout in 014 addresses it); long-run preview writes are unbounded per run (zero preview rows proposed in 014); the incident's exact deployed write mix is unmeasured — redeploy + D1 dashboard required, not assumed. Hibernation gives no universal zero-cost, sub-10ms, or disconnect-resilience guarantee.

## Stop conditions and handoff

If source drift changes an owner, adjust the narrow integration rather than creating a replacement subsystem. If a live key/model fails after receiver repair, preserve the sanitized typed reason, verify exact endpoint/catalog/credential, and report that separate failure. Do not assume every provider error was the receiver bug.

If remote access, deployment authorization or browser session is unavailable, complete local fixes and exact review evidence first; leave the specific external acceptance step open. Do not request another vague product-vision discussion. The required vision is already settled: conversational, quick to respond, stateful, understandable and simple.

Return focused changed files; runtime regressions that failed before and passed after; actual dispatch/first-text timings; query budget evidence; UI/browser observations; config/deployment differences; any remaining production blocker. Update relevant contracts/design/operations notes only to match final behavior. Do not add another speculative roadmap or declare acceptance yourself.
