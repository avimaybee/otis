> SUPERSEDED DRAFT — 2026-10-04. This implementation-agent proposal is historical context, not implementation authority. Follow the reviewer-authored `014-implementation-handoff.md`; begin only an explicitly assigned checkpoint. No draft numeric estimate or control/cursor claim overrides that handoff.

# 014 — Separate live transport from D1 (proposal; no implementation)

Status: PROPOSED 2026-10-04, implementation-readiness round per
`014-live-transport-review.md`. Design only. No code, no migration, no new
services. Reviewer checks the call-site owners and failure proofs first;
nothing ships unilaterally.

Official sources for every limit below (verified 2026-10-04, re-check
before implementation since pages move):
- https://developers.cloudflare.com/workers/platform/limits/ (subrequests)
- https://developers.cloudflare.com/durable-objects/platform/limits/ (CPU
  versus wall time, Free SQLite)
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
  (Hibernation API and attachment restoration)

## Problem (idle and active kept separate)

- Idle incident: session touches on read paths wrote on every debounced
  verification. Fixed by containment (pure-read `verifySession`, 007
  evidence 2026-10-04). The preview change below is about active-run and
  idle-poll volume; it is not claimed to explain idle writes.
- Active amplification: TEXT_MAX_CHUNKS (32) is per ROUND and the 24k
  thinking cap is chars, not rows — a 60s/20-round run persists up to ~640
  text batches, and thinking batches flush size-triggered (1000 chars) or
  timer-triggered (400ms, 32-char floor), so row counts follow flush timing
  (worst case ~750 tiny rows), not the char cap. Neither bounds whole-run
  persistence.
- Measurement discipline used here and in 007: SQL statement counts are
  exact (code + test-asserted); idle `rows_written = 0` is D1-meta measured
  on run/all/batch results (`.first()` returns no meta); all other row
  figures are ESTIMATES with stated index assumptions, never a universal
  multiplier. Real per-operation `rows_read`/`rows_written` must come from
  the D1 dashboard after deploy, not from this doc.

## Decision 1 — consolidate dispatch through the actor (per-flush RPC rejected)

Worst-case caller RPC/query count for a 60s/20-round turn with continuous
output, counted from `agent/streamPublish.ts` constants (EXACT caps, not
estimates): text publishes ≤ 32 per round (640 max) + thinking publishes
timer-driven (~140 realistic; 32-char-floor pathological ≈ 750 max) + end
receipts ≈ 800–1,400 publish calls per turn. As one actor-stub RPC each, a
single dispatch invocation would issue ~800+ subrequests. Per the cited
Workers limits page, Free allows 50 general subrequests (1,000 internal
services): per-flush RPC exceeds the general ceiling on its face, threatens
even the internal ceiling pathologically with zero margin, and each call
would additionally need attempt/fence validation. Local workerd passing
proves nothing about deployed limits. Per-flush streaming RPC therefore
does NOT fit; the earlier "low hundreds" justification is withdrawn.

Chosen instead: consolidate the queue consumer and scheduled sweep through
the existing actor (`dispatch`/`recover` stub actions instead of direct
`dispatchWorkspace` calls). The SAME dispatch/recovery code runs inside the
actor under the SAME leases, fencing, budgets, and slice/continuation
discipline (slices stay bounded exactly as today — no 60s actor method is
introduced). The run's publisher then fans out from actor memory: 0 RPC
and 0 D1 per preview; attempt/fence/expiry checks compare against the
in-memory claim the executing actor already holds; D1 writes happen only
at existing commit boundaries. Pre-implementation verification required
(not assumed): DO method-duration ceilings for bounded slices, cron→actor
and queue→actor hop latency against the dispatch-promptness bar, and alarm
behavior. No second agent loop, no topology change beyond the venue.

## Decision 2 — one endpoint, binding scope, concrete envelopes

- One native WebSocket endpoint for subscribed tabs (upgrade path under
  the existing activity route family); existing HTTP input paths and the
  JSON catch-up page stay unchanged. No RPC per delta.
- Binding scope is explicit: callers derive stubs ONLY via
  `env.WORKSPACE_ACTOR.idFromName(workspaceId)`; the actor accepts a body
  claim only when `idFromName(body.workspace_id).toString()` equals
  `state.id.toString()`, else 403 and close. Immutable scope persisted
  once in actor storage; per-connection socket attachments carry
  `{user_id, workspace_id, chat_id, role, validated_at, expires_at}`.
  The subscribed chat must resolve to the bound workspace.
- Envelopes (exact fields):
  - `preview-delta`: `{v: 1, kind: 'text-delta' | 'thinking-delta',
    run_id, attempt_id, fence, preview_sequence, mode: 'append', text?,
    block_id?}`. Applies only when `(attempt_id, fence)` equals the run
    generation from durable `run_started` facts AND `preview_sequence` is
    exactly last + 1; otherwise drop and wait for reset. Dedupe key is
    `(run_id, attempt_id, fence, preview_sequence)`.
  - `preview-reset` (server): `{v: 1, kind: 'preview-reset', run_id,
    attempt_id, fence, preview_sequence, text, blocks?}` with text bounded
    by the existing `TEXT_MAX_CHUNKS × TEXT_CHUNK_CHARS` (65,536 chars).
  - `preview-snapshot-request` (client): `{v: 1,
    kind: 'preview-snapshot-request', run_id, attempt_id, fence,
    after_sequence}`; answered with `preview-reset` (or empty). A replace
    with a stale `(attempt_id, fence)` is dropped, never applied.
- Delta versus full snapshot: deltas are ephemeral diffs against the last
  applied sequence; snapshots are bounded full replacements that restart
  the sequence. No fabricated equivalence between preview sequences and
  durable cursors — different namespaces, never compared.
- Reconnect ordering (fixed): (1) establish subscription and start
  buffering (synchronization boundary); (2) fetch durable catch-up by the
  last applied durable cursor; (3) apply buffered ephemeral with
  dedupe/ordering; (4) explicit reset on any gap — never suffix on a
  missing prefix.
- Concrete bounds (proposal parameters, reviewer-adjustable): per-socket
  buffer ≤ `MAX_CATCHUP_PAGE` (200) events, then drop-slowest with reset;
  reset text ≤ 64KiB as above; at most 50 sockets per chat subscription
  set (tabs legitimately number < 10); slow consumers are closed and
  catch up via durable cursor plus reset.

## Decision 3 — live preview authority (no borrowed renewal claims)

Dispatch exposes attempt and fence but NOT lease expiry, and
`renewWorkspaceLease` runs after the handler — never claim existing
renewal validates streaming. Specified instead: the executing context
carries `{attempt_id, fence, lease_expires_at}` captured at claim time,
and every emission batch gates on attempt match + `now < lease_expires_at`
+ no observed Stop/removal/takeover, all in memory, zero D1 per delta.
Control routes reach the actor through single scoped RPCs (`Stop`,
`invalidate(scope)` on member removal/logout/expiry) — one RPC per
control action, never per delta — with the alarm pass below as the
bounded repair for a missed invalidation. The decisive race test
(publish attempted after a successful Stop/removal) must emit nothing:
existing fence semantics plus the in-memory observed flags. Every durable
mutation retains transactional D1 authority; ephemeral preview is not
business authority. Explicitly forbidden: `blockConcurrencyWhile` around
provider I/O (would serialize subscriptions and controls behind
streaming).

## Decision 4 — lost-final-notification trigger and bounded revocation

A gap detector alone cannot repair a lost FINAL broadcast — no later event
exists to reveal it. Specified trigger: one batched alarm pass per actor
checking both subscription authority and subscribed durable chat cursors
against last broadcast, firing only while sockets are attached (scheduled
on first subscribe, cancelled when the last detaches; alarms allow
hibernation between firings). Fixed interval 60s; each pass costs at most
`2 × distinct users + subscribed chats + 1` D1 reads (well under the
invocation ceiling), zero writes — alarm passes never write. Arithmetic:
1 tab/1 chat ≈ 3 reads/pass (1,440 passes/day while attached ≈ 4.3k
reads/day); 10 tabs across 3 users/4 chats ≈ 10 reads/pass (≈ 14k
reads/day while attached). No new per-preview table, no 500ms polling.
Happy path needs no alarm: commits fan out synchronously in-actor;
the alarm is the backstop for crash-between-commit-and-broadcast,
restarts, and missed invalidations.
- Revocation for connected idle viewers: in-memory attachment expiry per
  push (zero D1; idle viewers cost nothing), event-driven `invalidate` on
  the logout/remove-member/expiry paths (primary, immediate), the 60s
  alarm as backstop. Acks/cursors from clients are untrusted: a reported
  cursor ahead of the durable cursor forces resync, never advances server
  state.
- Sockets and attachments are restored across hibernation BEFORE any alarm
  bookkeeping runs, per the cited Hibernation API best practices.
- Hibernation limits stated plainly: no universal zero-cost, sub-10ms, or
  disconnect-resilience guarantee; active provider fetches/handlers/timers
  can keep the actor awake.

## Decision 5 — thinking reset/history and outside-dispatch notifications

- Preview reset carries bounded text AND block-preserving public Thinking
  state per round/block: `{blocks: [{block_id, round_index, state,
  mode, text}]}` with states/modes/truncation, not one bare string.
- Completed historical record: constructed at ≤ 16,000 chars so the
  existing `safePayload` 16k bound passes it through unaltered, with the
  existing `truncated` receipt semantics when the 24k run budget overflows
  it. Per-run accounting reuses the publisher's published/buffered char
  counters, extended per block; per-delta text stays ≤ 1,000 chars. The
  24k display budget and the 16k record bound are never silently
  conflated. Final-answer integrity never depends on previews (authoritative
  reply persists via `answer_saved` + `chat_messages`).
- Outside-dispatch notifications: logout, member removal/leave, Stop,
  command-applied state, accepted input, final reply, and clarification
  notifications commit OUTSIDE dispatch — consolidating queue/cron alone
  does not deliver their cursors. Specified: each committing route issues
  one scoped actor `notify` RPC (workspace/chat/cursor) post-commit —
  `routes/auth.ts` (logout), `routes/members.ts` (remove/leave),
  `routes/runs.ts` (stop), `routes/commands.ts` (command-applied),
  `routes/chats.ts` (accepted input), `routes/clarifications.ts`
  (resolve), plus in-dispatch completion. One RPC per committed action
  fits all invocation budgets. Preserved through the change: author
  identity, preview attempt rejection, UUID retry, steering, pending
  question slot release, offline outbox, approved UI.

## Call-site owners that must change (reviewer verifies each first)

1. `agent/handler.ts:600-618` (publisher + 100ms timer): emit preview
   envelopes in-actor instead of D1 batches; zero preview D1 writes.
   Proof: 20-round run writes zero preview rows (D1 meta), answer intact,
   timer cleaned on lease loss.
2. `agent/activity.ts:5-13` (new `publishScoped` owner): split transient
   (in-actor fanout envelope) from facts (existing fenced D1 batch,
   byte-identical rows). Proof: fenced publish still rejects stale
   writes; idempotent record keys unchanged.
3. `chat/stream.ts` + `chat/activity.ts` + `hooks/useActivityStream.ts`:
   envelopes, subscribe-buffer-catch-up ordering, preview reset, extended
   dedupe keys, gap rule. Proofs: replay, revocation close, superseded
   resync, dropped-push reset, stale-attempt replace dropped,
   suffix-on-missing-prefix impossible.
4. `actor/dispatch.ts` commit paths: fact rows only. Proofs: existing
   promptness/idempotency tests unchanged.
5. `index.ts` WorkspaceActor + queue/scheduled callers +
   `apps/worker/src/dispatchHint.ts`: stub/body binding rejection, fanout
   to attached sockets, entrypoint consolidation, 60s alarm with the
   stated bound, control/invalidate/notify RPCs. Proofs: invalid scope
   denied; removal/logout/expiry enforced across hibernation; dispatch
   latency bar held; cron stays backstop; no listener-owned runs.
6. Docs/tests/clients: AGENTS invariant 8, `architecture.md`,
   `docs/contracts.md` updated to the transient/durable split; contract
   tests pin envelope fields, the no-durable-cursor rule, and the
   binding-rejection rule.

## Required acceptance evidence

1. 1/2/10 idle subscribed tabs: zero D1 row writes and no steady 500ms D1
   polling; state bounded auth checks and recovery-cron cost separately.
2. 60-second and 20-round synthetic runs: zero D1 writes for intermediate
   preview emission; actual durable totals including indexes measured from
   D1 metadata (not estimated).
3. Two-member fanout; invalid Origin/session/workspace/chat denied;
   removal/logout/expiry enforcement survives actor hibernation.
4. Disconnect during work, reconnect during work, reload after completion:
   no duplicate text, missing-prefix append, repeated tool effect, or
   cross-chat content.
5. Event between catch-up and subscription; commit-before-broadcast crash
   (incl. lost final notification with no later activity);
   actor restart; stale lease/attempt takeover; stop race (no publish
   after successful Stop); clarification releases the slot.
6. Slow consumer and preview overflow bounded; ordered streamed content and
   authoritative completion with no layout changes.

Post-acceptance native-browser comparison follows the 007 item-9
conventions (real session, no Playwright); unit/integration evidence above
is local proof, not browser proof.

## Explicitly out of scope

Paid D1 upgrade, weaker auth, poll-cadence changes without product signoff,
any new state framework, and any migration step before the reviewer checks
the six owners above against their failure proofs.

