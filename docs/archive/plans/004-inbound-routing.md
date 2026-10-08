> Closed historical plan record, reconciled 2026-10-07 from `plans/004-inbound-routing.md`. Family 004: 004A/004B local implementation; adjacent publisher/recovery acceptance partial. Remaining R02, R04, R14 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# Plan 004: Durable conversations, message routing and workspace execution

Planned against a3bd462, revised 2026-10-01. Status: 004A DONE; 004B DONE (independently reviewed; local evidence only). **004A requires 003A and precedes 002. 004B requires 004A, 002 and 003B.** Read architecture.md sections 5–9/12/15, docs/contracts.md states/IDs/activity and roadmap gates C/R.

## Outcome

Accepted messages survive restart and retries. An identity resolves to exactly one explicit workspace before any agent/ledger work. Messages retain deterministic acceptance order. Human clarification releases the workspace slot without losing the operation. The initial handler is a deterministic echo; this plan does not call a model.

Current Worker has a placeholder WorkspaceActor returning active and a health endpoint. Extend it deliberately rather than treating its presence as a working queue.

## Scope

apps/worker/src/inbox/{repository,normalize,reconcile}.ts, actor/WorkspaceActor.ts, routes/inbound.ts, conversation repositories/checkpoints/outbox, contracts and next migrations, Worker tests. Add Queue/Cron bindings only when their handlers exist. No transcription, general agent logic, business writes in the echo handler or unsupported-media download.

## 004A: source and conversation storage

1. Create chats, chat_messages, messages_in, system_jobs, agent_runs, run_steps, run_activity, pending_clarifications and outbox. Use states and ownership from contracts. Sources precede ledger references; plan 007 reuses this storage.
2. Assign a monotonic workspace acceptance sequence and chat activity cursor atomically. Random IDs/timestamps are not ordering primitives.
3. Implement web durable acceptance with explicit authenticated workspace/chat and author. In one transaction persist input/message/execution/outbox, then return 202 stable IDs. Retried UUID with equal owner/chat/fingerprint returns those IDs; conflicting reuse returns 409 without data leakage.
4. Normalize Telegram update ID with bot installation scope; validate webhook secret/private-chat input before admission. Unlinked or ambiguous identities stay unrouted. One membership may auto-select; web selection never alters Telegram routing.
5. Add minimal source/history repositories and echo test harness. Chat author restriction and full-member read visibility already apply. Source IDs must be verifiable by the future ledger.
6. Unsupported photo/location stores metadata only. Attached text needs explicit text-only confirmation; no partial silent processing.

Verify acceptance, same UUID retry, differing UUID payload/actor, source scope, pagination, two users/workspaces and no acknowledged input loss. Run root checks. Record 004A complete; plan 002 can now reference real source tables.

### 004A Verification Evidence (Hardened & Re-verified 2026-09-30)

- **Migration**: `migrations/0002_conversations_sources.sql` applied locally via Wrangler and verified in `cloudflare:test` workerd pool directly from disk. Includes transaction guard tables `acceptance_guards` and `link_redemptions`, and pagination index `idx_chats_pagination`.
- **Contracts**: All conversation, message, inbound, run, step, activity, clarification, outbox, and Telegram link models implemented and exported in `@otis/contracts`.
- **Channel Normalization**: `@otis/channels` tested across 7 unit tests (webhook secret fail-closed validation, private-chat gating, `/start <code>` extraction, unsupported media classification, and attached text confirmation tagging).
- **Hardened Inbound & Storage Guarantees**:
  1. *Fail-Closed Telegram Webhook*: Endpoint disables with HTTP 503 `service_unavailable` if `TELEGRAM_WEBHOOK_SECRET` is unset or empty.
  2. *Live Membership & Authorship Check for Telegram*: Inbound Telegram verifies active `workspace_users` membership and chat author; removed members are safely categorized as `unrouted` (`not_an_active_member`) with zero message or run mutations.
  3. *Atomic Single-Use Link Codes*: Enforced via `link_redemptions` table with `PRIMARY KEY (link_code_id)` and `CHECK (guard_ok = 1)` inside the atomic D1 consumption batch. Tested with simultaneous competing redemption requests via `Promise.all` backed by database primary key and check constraints; at most one transaction commits and the losing transaction fails constraints and is rejected.
  4. *Start Command Isolation & Redacted Link Code Persistence*: `/start` and `/start <code>` are processed as administrative signals prior to conversation routing regardless of whether the account is unlinked or already linked. Plaintext link codes never enter `chat_messages`, `run_activity`, or `messages_in.raw_payload` across linked, unlinked, valid, or invalid submissions.
  5. *Unambiguous Workspace Selection*: If a user has exactly one active workspace, it is auto-selected; if a user has multiple active memberships, routing does not guess—the message is stored as `unrouted` (`Multiple workspaces available; please select a workspace first`).
  6. *Storage Failure Propagation to HTTP 500*: Clean-message and link-redemption batches distinguish verified guard rejections from unexpected database/storage errors. D1 infrastructure failures rethrow so the webhook route returns HTTP 500 (`internal_error`), instructing Telegram to retry delivery rather than acknowledging an unpersisted update.
  7. *Voice Note Isolation*: Inbound voice notes are stored as `status: 'unsupported'` with retained metadata, without appending empty text turns or queuing agent runs until Gate 010.
  8. *Web Acceptance Transaction Guard*: Batches include `INSERT INTO acceptance_guards` validating active membership and chat author within SQLite; late writes after removal fail the transaction atomically.
  9. *Retry-Safe Echo Harness*: Re-checks queued status, returns recorded reply idempotently if already succeeded, guards against concurrent execution, and updates outbox rows by exact primary key (`json_extract`).
  10. *Stable Monotonic Sequence Receipts*: Web acceptance returns the exact committed `acceptance_sequence` from `messages_in`.
  11. *Lossless Composite Pagination*: Encodes `(last_activity_at, id)` from the last returned item, breaking timestamp ties with `id DESC` without dropping chats.
- **Root Checks**:
  - `pnpm typecheck`: Exit code 0.
  - `pnpm lint`: Exit code 0 (0 problems).
  - `pnpm test`: 9 test files, 66 passed tests across pure, web, and workerd integration test suites.
  - `pnpm build`: Vite production bundle + declarations + Wrangler deploy dry-run passed cleanly.

## 004B: actor and durable recovery

Status: DONE, independently reviewed and accepted on 2026-10-01 for local implementation scope. Implemented in `apps/worker/src/actor/` (leases, step receipts, dispatch/recovery) with the deterministic echo handler routed through the same leased commit path; `WorkspaceActor` serves dispatch/recover per workspace; `scheduled()` (5-minute cron) and `queue()` (`otis-dispatch`) entrypoints wired in `apps/worker/src/index.ts` and declared in `wrangler.jsonc`. Migrations `0005_actor_dispatch.sql` (dispatch index), `0006_actor_hardening.sql` (attempt-scoped step receipts; durable clarification answers), and `0007_outbox_claim_owner.sql` (outbox claim ownership). New route `POST /api/workspaces/:ws/runs/:runId/stop` (author-scoped; stop is not undo). Review findings and their regression evidence are retained below. Acceptance does not establish deployed infrastructure, real-browser sign-in, or provider/agent behavior from later gates.

### 004B Verification Evidence (2026-09-30)

- **Lease + fencing:** `claimWorkspaceLease` succeeds only with no live lease and always advances the fence; `renewWorkspaceLease` fails after loss/expiry; releases are holder-scoped. One mutating turn per workspace; no in-memory lock anywhere.
- **Fenced commits:** every completion/clarification/failure batch re-verifies run status, attempt, fence, lease ownership/expiry, and actor membership in one transaction. A stale holder's commit throws `stale_lease` with zero writes; a stopped run's holder gets `run_inactive`.
- **Steps before work:** the logical turn step (with arguments hash) is persisted before the handler runs; duplicate delivery replays the receipt (one `run_steps` row, one reply). Recorded continuations always re-execute (progress lives in checkpoint steps); recorded questions re-execute only after the clarification is answered.
- **Clarification releases the slot:** waiting runs free the lease; teammates dispatch concurrently; `resumeRun` requeues once (resolved clarification, no duplicate question, no repeated steps).
- **Stop:** author-scoped; queued/waiting/running go cancelled, live outbox intents cancelled, lease released only if still held by the run's attempt. Committed actions untouched.
- **Recovery (`recoverWorkspace`):** no live lease → all running runs requeue (holders definitionally stale); stale `sending` outbox retries or, past max attempts, fails visibly as poison; queued runs without dispatch intent get one recreated (crash-before-publish backstop); cancelled runs' intents cancelled.
- **Poison:** repeated handler crashes exhaust attempts → run/messages `failed`, outbox `failed_known`. Sourceless runs cannot exist (agent_runs CHECK proven by test).
- **Revocation:** dispatch rechecks membership before pinning; removed members' runs fail as `member_removed` with no reply.
- **Fault matrix** (`apps/worker/test/actor.integration.test.ts`, 19 tests, all in real workerd/D1): oldest-first completion; concurrent duplicate delivery (exactly one effect + `already_done` redelivery); out-of-order wake-ups; orphaned acceptance recovery; mid-run holder death (single effect after recovery); stale-lease commit rejection then healed redispatch; clarification slot release + teammate progress + durable-answer resume; author-scoped stop + stopped-holder rejection; poison exhaustion; revocation denial; lease renew/loss/successor fencing; checkpoint chains (2 checkpoints, single reply); DO dispatch, cron `scheduled()`, and queue consumer (including malformed wake-up ack) entrypoints.

### 004B hardening pass (review findings, 2026-09-30)

1. **P0 — stale attempt overwrite (fixed).** All step writes are attempt-owned and pinned-run-gated (`run_steps.attempt_id`, migration 0006): the pinning attempt adopts in-flight/spent rows of its run, and stale writes change zero rows and surface as `StepError('stale_attempt')`. The handler-error requeue, poison terminal-failure, lease-lost requeue, and checkpoint paths are likewise gated on the attempt still owning the run (`requeueAsHolder`, guarded `failRunTerminal`); a stale holder touches no run, outbox, receipt, or lease state. Regression tests pause A mid-handler, expire its lease, let recovery requeue and B pin, then make A throw or return a checkpoint: A lands `deferred/stale_attempt`, writes nothing, and B completes with exactly one effect. A related real bug surfaced while proving this: re-pinned `running` steps rejected `markStepRunning`, and adoption wrongly refused legitimately re-pinned rows — both fixed.
2. **P0 — stale turn clock (fixed).** `dispatchOutboxItem` now uses a per-operation clock (`makeNow`); claim, renewal, and commit each take the current time, and tests can inject a controllable clock. Test: a 10s lease with a handler that advances the clock 11s ends `deferred/lease_lost` with no reply, run requeued, and no lease held.
3. **P1 — cron discovery (fixed).** `listWorkspacesNeedingRecovery` pages over workspaces derived from durable runs (`queued`/`running`/`waiting_for_input`) as well as live outbox rows; `scheduled()` uses it. Test: with the only dispatch intent deleted, `worker.scheduled()` still discovers the workspace, recreates the intent, and completes the run.
4. **P1 — durable clarification answers (fixed).** `resumeRun` now takes the member's answer and persists response text + optional source message on the clarification (`answer_message_id`, migration 0006); `TurnContext` carries `answerText`/`answerMessageId`, and consumption is computed from durable rows (`hasResolved && !hasPending`), including sequential Q1→Q2 flows. Tests run with no in-memory counters and prove a fresh dispatch receives the stored answer, resolves exactly once, never duplicates a question, and records two distinct questions for two sequential clarifications.
5. **P1 — stop/completion race (fixed).** Stop commits one guarded batch (active-status guard + run transition + outbox + inbox + pending-clarification + attempt-matched lease clear); a concurrent completion wins cleanly with `stopped:false`. Test races `stopRun` against `completeRun` and asserts the outcome pair is consistent (succeeded ⇒ one reply + `processed` + stop did not claim the stop; cancelled ⇒ zero replies + `cancelled`).

- **Root checks (hardening rerun):** `pnpm typecheck` 0, `pnpm lint` 0, `pnpm test` 141 passed / 12 files, `pnpm build` clean (Vite + dry-run with queues/cron).

### 004B hardening pass 2 (audit findings, 2026-10-01)

1. **[P1] Atomic pinning, requeueing, and recovery transitions (fixed).** Multi-statement races in `pinRun`, `requeueAsHolder`, and `recoverWorkspace` are eliminated by consolidating the run transition, step ownership adoption, inbox/outbox status updates, and workspace lease updates into a single atomic `db.batch` guarded by `acceptance_guards`. Regression test `hardened-01` proves that a paused stale attempt resuming after a successor took over cannot steal step ownership or corrupt outbox state.
2. **[P1] Lease contention failure budget protection (fixed).** In `claimRunnableRun`, when a run cannot proceed due to workspace lease contention (`!lease`), a non-queued status, or a lost pinning race, the `attempt_count` increment on the outbox is atomically refunded (`MAX(0, attempt_count - 1)`). Regression test `hardened-02` confirms that dispatching a turn 5 times under a held lease retains an intact attempt count and completes successfully once the lease is released.
3. **[P1] Specific clarification targeting and duplicate answer idempotency (fixed).** `resumeRun` now targets a specific `clarificationId` (with stable `answer.messageId` referencing `messages_in`), validates workspace, chat, and author membership, and checks for prior resolved deliveries. The committing transaction guards specifically on `c.id = ? AND c.status = 'pending'`, preventing a delayed or duplicate answer to Q1 from resolving Q2. Regression test `hardened-03` asserts that answering Q1, parking on Q2, and redelivering Q1's answer returns a replay result while Q2 remains pending.
4. **[P1] Actor clarification resumption coordination with ledger (fixed).** Resumptions containing typed operations (`operation_payload_json`) coordinate directly with `@otis/ledger`'s `resumePendingClarification`, merging allowed missing fields and executing the command within the atomic batch (`extraStatements`). Regression test `hardened-04` proves atomic execution, validation of missing fields, and persistence of the resulting business events and projections in D1.
5. **[P2] Stopped run and expired lease rejection in step operations (fixed).** All step mutators in `steps.ts` (`persistStep`, `adoptStep`, `markStepRunning`, `transitionStep`) enforce `r.status = 'running'`, attempt ownership, fence, and active workspace lease expiration (`w.lease_expires_at > ?`). Stopped runs (`cancelled`) and lost leases immediately reject step progression with `StepError`. Regression test `hardened-05` confirms that step completion, new planning, and step adoption are strictly rejected following a run cancellation or lease loss.
- **Incidental fixes:** the conversations pagination test used a hardcoded `12:00Z` tie timestamp that became a time bomb once wall-clock passed it (now `now + 1h`); the conversations and auth test setups now apply migration 0006 (and auth applies 0004) because invite/step writes touch the newer guard tables.
- **Environment notes:** C: disk full here; workerd suites ran with `TEMP=D:\wtmp` (log-write ENOSPC noise only). The `otis-dispatch` queue is declared but not yet provisioned — run `pnpm exec wrangler queues create otis-dispatch` before any real deploy that enables the consumer. Nothing in this gate was deployed.

### 004B hardening pass 3 (GPT 6.1 review follow-up, 2026-10-01)

1. **[P1] Pin/lease atomicity.** `pinRun` now verifies the workspace lease in its guard (`lease_owner/attempt/fence/expiry`), so a claimant that loses its lease between claim and pin cannot steal the run from its successor. New test `hardened-01b` expires A before pinning, lets B claim, and proves A's late pin fails while B owns the run.
2. **[P1] Contention never consumes budget.** `dispatchOutboxItem` no longer increments `attempt_count` on claim. The count increments only after lease + pin succeed (actual execution begins); lease contention, non-queued states, and pin-race losses reset to `pending` without touching the count. Poison is checked against the post-increment count with `expectedStatus='running'`. `hardened-02` still proves 5 contended dispatches leave `attempt_count=0` and complete after release.
3. **[P1] Ambiguous resumes rejected.** Omitted `clarificationId` now succeeds only for single-clarification runs; multi-question runs require an explicit ID, so a retried Q1 (new message row, no ID) cannot resolve Q2. Duplicate `answer.messageId` still returns `replay`. New test `hardened-03b` proves omission on a 2-question run resumes nothing; `hardened-03` still proves exact Q1 redelivery replays while Q2 stays pending.
4. **[P1] Ledger coordination exactly-once + stale guard.** `hardened-04` now proves redelivery creates no duplicate `task_created`, restart dispatch completes the queued continuation exactly once with one reply, and `hardened-04b` proves a stale `expected_business_revision` via `resumePendingClarification` conflicts with zero new events. Unsolicited-field rejection retained.
5. **[P2] Paused-handler Stop.** New test `hardened-05b` pauses a real dispatched handler inside the turn, stops the run, releases the handler, and asserts no `succeeded` receipt, no reply, and inbox `cancelled`. Direct `persist/complete/adopt` rejection after Stop retained in `hardened-05`.
- **Root checks (pass 3 rerun):** `pnpm typecheck` 0, `pnpm lint` 0, `pnpm test` 145 passed / 12 files, `pnpm build` clean (Vite + dry-run with queues/cron).

### 004B hardening pass 4 (review follow-up, 2026-10-01)

1. **[P1] Ledger clarification owns nothing twice.** `executeLedgerCommand` accepts `deferRunTransition`; dispatch handlers pass it so the ledger persists receipt + typed clarification + activity while `waitForInput` owns run/inbox/outbox/lease. New test `hardened-06` invokes a missing-date `create_task` inside `runTurn`, asserts pending typed clarification, no lease, inbox waiting, delivered intent, immediate Hunor completion, then answer + exactly-one task.
2. **[P1] Outbox ownership.** Migration `0007_outbox_claim_owner.sql` adds `outbox.claimed_by`. Claim sets it; resets, post-pin count, checkpoint refund, terminal delivered/failed, and recovery stale reset all enforce `(claimed_by IS NULL OR claimed_by = ?)` plus time/live-holder rechecks. New tests `hardened-07a` (pause before pin) and `hardened-07b` (pause before count) prove a stale A leaves B's status/count/owner unchanged.
3. **[P1] Answer provenance in transaction.** `resumeRun` requires persisted `answer.messageId`, derives author from `messages_in`, rejects mismatched `authorUserId`, requires author == requester and live membership, removes original-message fallback, and repeats all checks in the standard-path guard. Ledger path relies on its guard with derived author/source. New test `hardened-08` rejects other-member, missing/unknown/mismatched sources, and proves removal after precheck fails the commit.
- **Root checks (pass 4 rerun):** `pnpm typecheck` 0, `pnpm lint` 0, `pnpm test` 149 passed / 12 files, `pnpm build` clean (Vite + dry-run with queues/cron).

### 004B hardening pass 5 (fenced ledger writes, 2026-10-01)

1. **[P1] Fence reaches the ledger boundary.** `TurnContext` carries the dispatch's claimed `fence`; ordinary run-scoped ledger mutations without one fail closed (`missing_fence`) before any write. Clarification resumption stays exempt via `resuming_clarification_id`. New test `hardened-09` pauses A before an applied `create_task`, lets recovery hand the active run to B, then releases A: A resolves `conflict/fence_conflict` with zero events, tasks, or receipts and an unchanged business revision, while B completes the same turn exactly once.
- **Root checks (pass 5 rerun):** `pnpm typecheck` 0, `pnpm lint` 0, `pnpm test` 150 passed / 12 files, `pnpm build` clean (Vite + dry-run with queues/cron).

### 004B hardening pass 6 (live-lease fencing, 2026-10-01)

1. **[P1] Cleared leases no longer satisfy the guard.** The ledger transaction now requires, for ordinary dispatched run writes, `running` status, a present unexpired lease whose owner/attempt match the run's pinned attempt, and fence equality on both workspace and run. A `NULL` expiry after recovery fails even when the fence value still matches; absent expiry also reports `fence_conflict`. Resumption stays exempt via `resuming_clarification_id`. Ledger fixtures seed a live lease for the same reason. New variant `hardened-10` releases A after recovery but before B claims (asserts `conflict/fence_conflict` plus zero events, tasks, receipts, and revision change, then B finishes once); the ledger suite directly asserts `rejected/missing_fence` with zero mutations.
- **Root checks (pass 6 rerun):** `pnpm typecheck` 0, `pnpm lint` 0, `pnpm test` 152 passed / 12 files, `pnpm build` clean (Vite + dry-run with queues/cron).

### Independent acceptance (2026-10-01)

The reviewer inspected the final ledger live-lease transaction guard, immutable dispatch fence propagation, fixture lease setup, and the missing-fence and cleared-lease regression tests. The final fixes close the outstanding findings from the preceding reviews. The reviewer independently reran `pnpm typecheck`, `pnpm lint`, `pnpm test` (152 passed / 12 files), `pnpm build` (including Wrangler dry-run), and `git diff --check`; all passed. No application code was changed by this acceptance review. Gate 005 is next; no additional abstraction or module split is required for 004B acceptance. Queue provisioning, remote deployment/migrations, and real-browser sign-in remain unverified and must be recorded separately before claiming deployment readiness.


1. Claim the oldest eligible message using persisted lease owner/attempt/fence/expiry. Claim/renew atomically. One mutating agent turn per workspace; local processing flag is optional optimization only.
2. Add bounded execution slices/checkpoints and durable continuation outbox. Do not hold blockConcurrencyWhile across network calls or human answers. Do not rely on waitUntil alone for durability.
3. Persist logical step IDs before invoking handlers. A replay finds the receipt/checkpoint and returns it. Stale attempts/fences cannot commit business effects once model integration lands.
4. Questions store requester/chat/source/pending typed operation/missing fields/candidates/source revision, mark waiting, and release the slot. Another member can proceed. Answers revalidate state and continue without repeating completed steps.
5. Queue payloads contain scoped IDs only. Queue wake-up order is not business order. Cron recovers unsent outbox rows and expired leases. Bound retries and poison-message failures.
6. Stop cancels future steps/continuation, not prior business actions. Run and input status distinguish queued, running, waiting, partial, failure and cancellation.
7. Keep explicit outbound delivery intent/status; future Telegram cannot rely on an internal key as sendMessage idempotency. Avoid claiming exactly-once network delivery.

## Tests and completion

Use real local Workers/D1/DO integration with injected clock and deterministic handler. Fault cases: crash after acceptance before publish; duplicate/out-of-order Queue; concurrent members; actor restart; expired lease; old handler result after new fence; waiting human while teammate proceeds; canceled continuation; poison input; revoked membership.

Assert eventual processed or visible failed state and **no duplicate logical effect**, not that an at-least-once worker function was called only once. Check same source/action IDs persist across retry. Run pnpm typecheck/lint/test/build.

DONE requires both 004A and 004B evidence. Stop if the design can acknowledge input then lose it or commit after lease loss. Do not solve that by keeping an unbounded in-memory lock.

References: https://developers.cloudflare.com/queues/reference/delivery-guarantees/ ; https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
