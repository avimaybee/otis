> Closed historical plan record, reconciled 2026-10-07 from `plans/014-live-transport-review.md`. Family 014: actor-hosted SSE present; remaining transport/authority/cost acceptance partial. Remaining R02, R05, R13, R14 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# 014 transport proposal — reviewer requirements

Reviewed 2026-10-04 against the attached WebSocket proposal and current local source. Verdict: approve the transient/durable separation as direction; neither blueprint is implementation-ready. No transport source implementation authorized by this review alone. Preserve the current containment diff and dirty UI work.

## Diagnosis and economics
- Separate the idle incident (session touches on read paths) from active preview amplification. Pure authentication reads fix idle writes; live fanout removes idle polling reads and active preview persistence. Do not claim the proposed preview change alone explains idle writes.
- Count D1 meta.rows_read and meta.rows_written across real operations. SQL statement count, changed rows and index costs are different quantities. Do not multiply every statement by an assumed three index writes. State exact scenario and measurement/estimate status.
- Hibernation discards object memory but maintains healthy inbound WebSockets at the edge. Active provider fetches/handlers/timers can keep the actor active. No universal zero-cost, sub-10ms, or disconnect-resilience guarantee.

## One publication path with existing execution owners
- index.ts has WorkspaceActor dispatch AND direct scheduled/queue dispatchWorkspace callers. Trace every publisher call site before choosing a route. Either consolidate existing entrypoints through the actor, or define one scoped internal publication method from external handlers. Do not create a second agent loop.
- Keep accepted-message UUID idempotency, durable outbox, leases, attempt ownership, fenced ledger writes, stop, clarification slot release and retry behavior. A WebSocket listener is never the owner of a business run.
- No RPC per raw provider token. Ordered small bounded batches may use a short active-run flush window; no perpetual idle timer or database poll.

## Explicit transient versus durable protocol
- Ephemeral text/thinking previews never allocate durable activity cursors or write run_activity. Define a separate run_id/attempt/fence/preview_sequence envelope and reset/replace semantics.
- Durable messages, tool proposals/receipts, questions, final answers and terminal states commit before the durable notification. Reconnect catches up by durable cursor. No fabricated cursor equivalence.
- Retain the approved historical Thinking experience via a bounded completed public-summary record if that is required by current contracts; do not silently remove historical content. Specify truncation and possible loss of uncommitted preview after a crash. Never publish private/internal reasoning.
- Update AGENTS invariant 8, architecture.md, docs/contracts.md and clients/tests consistently so persistence-before-publication applies to authoritative facts, with an explicit exception for non-authoritative previews.

## Authorization and hibernation
- Browser WebSocket uses the existing same-origin session cookie. Validate Origin/upgrade, current session, workspace membership and chat ownership before subscription. No credentials in query strings and no trusted identity inferred from client-provided headers.
- Actor workspace identity is bound to its instance. A chat parameter must resolve to that workspace; no default or unchecked cross-workspace subscription.
- Persist only safe connection identity/scope/expiry references via socket attachments so hibernation cannot erase authorization metadata. Define logout, membership removal and session expiry enforcement with bounded read checks and invalidation; never a D1 check per socket per delta.
- Stale attempts and stopped runs cannot publish misleading previews after takeover. Existing fence and attempt guard semantics still apply.

## Reconnect, missed publication and capacity
- Snapshot then subscribe has a race. Establish subscription and buffer with a synchronization boundary, fetch durable catch-up, then apply buffered events with dedupe/ordering. Define a bounded preview snapshot or explicit preview reset on reconnect; appending a suffix to a missing prefix is incorrect.
- Commit then crash before broadcast remains recoverable from durable catch-up. Define a bounded repair mechanism that does not recreate idle polling or a per-token durable outbox.
- Bound preview memory, payload size, connection count and slow-client handling. Drop/close a lagging connection and catch up rather than retaining an unbounded queue or swallowing all errors.

## Required acceptance evidence
1. 1/2/10 idle subscribed tabs: zero D1 row writes and no steady 500ms D1 polling; state any bounded auth checks and separate recovery cron cost.
2. 60-second and 20-round synthetic runs: zero D1 writes for intermediate preview emission; actual durable totals including indexes measured from D1 metadata.
3. Two-member fanout; invalid Origin/session/workspace/chat denied; removal/logout/expiry enforcement survives actor hibernation.
4. Disconnect while provider works, reconnect during work, and reload after completion: no duplicate text, missing-prefix append, repeated tool effect or cross-chat content.
5. Event between catch-up and subscription; commit-before-broadcast crash; actor restart; stale lease/attempt takeover; stop race; clarification releases the slot.
6. Slow consumer and preview overflow remain bounded. UI receives ordered streamed content and authoritative completion without layout changes.

This is one bounded transport correction using the existing Worker, WorkspaceActor, D1, Queue and frontend. No Redis, KV event log, new workflow framework, paid fallback or business-ledger rewrite.

## Followup on the five-choice revision

The consolidated actor execution venue resolves per-flush RPC amplification in principle. Proposal remains pending on two concrete details: (1) a lost final broadcast has no later cursor notification, so a gap detector alone does NOT repair an already-connected idle viewer; specify an actual bounded repair trigger (e.g. the existing bounded alarm rechecks subscribed durable cursors, or a durable milestone delivery intent) and test loss of the final notification with no later user activity; (2) in-memory attempt checks must also reject elapsed leases, observed stop/removal and a successor claiming through any remaining external path. Actor memory identity alone does not replace live fencing. Further prerequisites: give auth alarm a fixed interval/request bound rather than implementer choice; include block-preserving public Thinking snapshot/completed history with the 16k payload and 24k run bounds; authenticate every origin/upgrade and reconstruct attachments on restart. Do not rewrite unrelated source while 015A.1 is assigned.
## 2026-10-04 implementation-readiness check (before any 014 source work)

Inspected actual current owners: `apps/worker/src/index.ts` WorkspaceActor.fetch and direct queue/scheduled dispatch; `apps/worker/src/dispatchHint.ts` (NOT actor/dispatchHint.ts or chat/dispatchHint.ts); `agent/activity.ts`, `agent/handler.ts`, `agent/streamPublish.ts`, `routes/activity.ts`, `hooks/useActivityStream.ts`, dispatch/leases. Preserve 015A.1 source while its evidence correction is underway.

Required concrete resolutions in 014 before assigning source:
1. Last-notification repair: no later event exists to reveal a gap. Choose an actual bounded trigger, specify exact interval and query bound, and show idle write/read arithmetic for 1/2/10 subscriptions. One batched alarm pass checking both subscription authority and durable chat cursors is a possible existing-actor solution; a vague gap detector is not. No new per-preview table, no 500ms polling. Schedule an alarm only while sockets require it; remove/refrain when none. Restore sockets/attachments across hibernation before alarm bookkeeping. Acks/cursors are untrusted: clamp or force resync if ahead, never let a client acknowledgement hide unsent committed history.
2. Live preview authority: dispatch currently exposes attempt and fence but not lease expiry; renewWorkspaceLease happens after the handler, not on a streaming heartbeat. Do not claim existing renewal provides an active streaming validator. Gate emission against the actual held attempt, expiry from that claim, and observed Stop/removal/takeover. Define how control routes reach the actor and how a missed invalidation is bounded/repaired. Never publish after an operation reports successful Stop/removal in the decisive race test. No D1 read per delta. No blockConcurrencyWhile around provider I/O (would block subscriptions and controls). Every durable mutation retains transactional D1 authority; ephemeral preview is not business authority.
3. Platform economics: Workers external subrequests, internal service subrequests, D1 queries and DO CPU/wall time are separate limits. Current official Workers page gives Free 50 general subrequests and 1,000 internal services; DO limits show default 30s CPU, with HTTP/RPC wall time while caller connected distinct from CPU. The proposal's generic low-hundreds ceiling is unsupported. Keep in-actor fanout for simplicity/cost, but replace false numerical justification. Review actual existing round/slice and lease limits; do not claim request budgets proven simply because the venue changes. Local workerd passing is not deployed-limit proof.
4. Protocol completeness: choose one endpoint and envelopes, snapshot/catch-up order and concrete memory/connection/message/slow-client bounds. Keep one native socket plus existing HTTP input; no RPC per delta. Preview reset must carry bounded text AND block-preserving public Thinking state for each round/block, states/modes/truncation, not only one text string. Completed historical record string <=16k and display budget24k must have deliberate per-run/block accounting; never silently conflate these.
5. Scope and testability: specify the paths for logout, member removal/leave, Stop, command-applied state, accepted input, final reply and clarification notifications. These writes can occur outside dispatch; consolidating queue/cron alone does not make their committed cursors reach subscribers. Preserve author identity, preview attempt rejection, UUID retry, steering, pending question slot release, offline outbox and approved UI. Require tests for actual route→actor→socket behavior, not just a fake callback; native browser comparison after source acceptance. No new ledger framework, no new database, no broad dependency upgrade.

Official primary sources verified 2026-10-04:
- https://developers.cloudflare.com/workers/platform/limits/ (subrequests section)
- https://developers.cloudflare.com/durable-objects/platform/limits/ (CPU versus wall time and Free SQLite)
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/ (Hibernation API and attachment restoration)

All of this remains a bounded transport correction, not a business-engine rewrite. These checks prevent the exact cost/latency failures already experienced; do not broaden into a general platform project.
