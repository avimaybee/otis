> Closed historical plan record, reconciled 2026-10-07 from `plans/015-foundation-efficiency.md`. Family 015: 015A.1 and parts of 015B present; reads/guards/retention partial; concurrency optional. Remaining R09, R13 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# 015 — Foundation efficiency followup (plan; no implementation)

> Reviewer update, 2026-10-04: the narrow 015A.1 changed-only persistence patch is [independently accepted](015A1-review-acceptance.md). Remaining 015 proposals are unassigned. Follow [the corrected delivery order](013-dogfood-execution-order.md); no further ledger optimization is a prerequisite for assigned 009A. Historical implementation-agent measurements below are distinguished from verified acceptance evidence in the reviewer record.

Status: PROPOSED 2026-10-04, constrained by
`015-foundation-efficiency-review.md` (reviewer source-checked; this plan
implements its work order, not its own earlier draft). Docs only. No broad
ledger/concurrency rewrite, no source edits (source changes only on an
explicitly assigned narrow task — none assigned here), no new services, no
commit/push/deploy. 014 corrections are finished; reviewer independently
reports full suite 586/42 files green plus typecheck/lint and build
dry-run (correctness checks, not production cost proof).

## Verified findings (read-only source check; reviewer-confirmed)

| # | Claim | Source | Status |
|---|---|---|---|
| 1 | No production `WORKSPACE_ACTOR` invocation | Namespace `Env` binding only (`index.ts:66`); class + tests only; queue consumer and scheduled sweep call `dispatchWorkspace` directly | VERIFIED as topology/documentation drift — not proof fencing is broken. Resolved with 014 transport ownership + invocation budget, not a fencing fix |
| 2 | Guard rows accumulate unboundedly | `acceptance_guards` INSERTed at ~15 sites, plus `ledger_guards` (0003) and `lifecycle_guards` (0004); zero `DELETE`s on any guard table | VERIFIED. Specified direction: one bounded reusable assertion row per scope with every invocation rechecking the predicate — no new permanent row per operation; legacy-row cleanup bounded and separately scoped |
| 3 | Ledger cost is worse than load-all | `packages/ledger/src/repository/executor.ts`: whole-state load (`getWorkspaceProjectionState`, :579) then unconditional upserts over ALL entities (:854), fields (:999), tasks (:1040), drafts (:1082) per action; memory projection loops also need inspection | VERIFIED. Editing one item rewrites unrelated projections. Targeted loading is a SEPARATE step after the write footprint is bounded — not bundled |
| 4 | Context loads all names + N+1 memory queries | `agent/context.ts:238` (`SELECT id, name FROM entities WHERE workspace_id = ?`) then one `memory_entries` query per name-matched entity (:244-256), plus FTS | VERIFIED. Fix with bounded workspace-scoped retrieval and batched entity memory; preserve acting-member scope, suppression semantics, deterministic ranking; no arbitrary LIMIT that silently hides entities. Attachment timings/OOM claims are unmeasured |
| 5 | Telegram inbound has no dispatch wake | `routes/inbound.ts` (webhook router) accepts via `acceptTelegramInbound` (`inbox/telegram.ts`) and returns; no hint/queue/dispatch wiring, unlike web (`routes/chats.ts:258,263`) and clarifications (`routes/clarifications.ts:226`) | VERIFIED — accepted Telegram input waits for the 5-minute cron backstop |
| 6 | Workspace-wide turn lease blocks teammates | Lease/fence design is confirmed INTENTIONAL, not a bug | Preserved in force. Dependents: run/step claims, fencing, scoped context, ledger revision conflicts, Undo, stop, stale-holder behavior. Product outcome for any future design: independent chats respond concurrently while conflicting shared writes stay validated and atomic. Separate deliberate concurrency proposal only |
| 7 | Healthy `waiting_for_input` discovered every cron tick | `actor/dispatch.ts:1673` UNION matches parked clarification runs forever; revisit proven zero changed rows (007 evidence) | VERIFIED, and the attachment overstates it as write thrashing — it is reads-only. Specified change: remove healthy parked work from routine discovery while preserving queued-orphan / running-expired / sending / cancelled recovery — only after proving reactive answer wake and crash recovery first |
| 8 | No session/expiry retention policy | Sessions already expire for auth (`expires_at` enforced in `verifySession`); physical expired rows and completed-outbox retention are separate missing policies; indexes do not auto-degrade with history | Any retention distinguishes durable evidence, dedupe keys, retry recovery, pending/sending/`outcome_unknown`, and terminal rows. No invented deadlines (no delete-everything-delivered-after-7d). Preview growth is corrected by 014, not periodic deletion |
| 9 | Undo replay nondeterminism (generic claim) | `reducers/rebuild.ts` filters by explicit append-only revert events and committed sequence; `commands/undo.ts:86` checks dependencies, `:208` rejects unsafe undo; tests UN-02 (teammate edits preserved) and UN-03 (dependent-task undo rejected) | REJECTED as a generic flaw. Point-in-time replay can use the event prefix. Add tests only for uncovered ACTUAL dependencies if reproduced — no compensating-inverse rewrite |

## Work sequence (reviewer order; each item needs its proofs before the next)

- Keep verified session/SSE containment (007). 014 concrete live-delivery
  proposal first; approve a bounded implementation path after its failure
  cases are specified.
- 015A: measured single-record ledger footprint (scoped D1-meta
  reproduction reusing the economics counting wrapper: seed many unrelated
  records, edit one, record statements + `rows_read`/`rows_written`);
  changed-only persistence honoring the guard rule and §constraints below;
  guard bounded-state proposal (one reusable assertion row per scope,
  predicate rechecked per invocation, legacy cleanup separately scoped).
- 015B: scoped batched context retrieval (per §finding 4 constraints);
  reactive Telegram wake — immediate post-commit wake ONLY for
  dispatchable accepted/replayed durable work (not linked/ignored/
  unrouted/unsupported/confirmation-required input), with queue failure
  never turning successful acceptance into input loss; parked-run
  recovery selection per §finding 7, gated on proven reactive wake +
  crash recovery. Test: production webhook → queue hint → dispatched
  reply with synthetic provider, duplicate update, and failure.
- 015C: lifecycle retention and independent-chat concurrency designs with
  explicit invariants (§findings 6, 8) — designs only, not bundled source
  rewrites.
- Every implementation: targeted integration coverage plus the required
  checks, actual D1-meta measured/estimated distinction, honest completion
  report. Keep existing store/services; no ORM/broker/vector pipeline or
  new agent framework.

## Reusable guard rule (binding on 015A and any future persistence work)

A guard MUST throw a constraint failure on a failed predicate inside the
same batch (`INSERT ... SELECT ... CHECK (guard_ok = 1)` pattern, mapped
by `handleBatchError`). Zero-row `UPDATE` and `INSERT OR IGNORE` are UNSAFE
as guard substitutes: both succeed silently and would commit business
effects the predicate rejected. Any changed-only design carries the guard
first, in-batch, throwing — verified by a failing-predicate test that
asserts zero business rows changed.

## Constraints carried from the findings (rejection criteria, not guidance)

- Changed-only diffing compares persisted VALUES, not Map/object identity
  (reducers shallow-copy and mutate); skips nothing a reducer touched.
- Events stay append-only; projections stay rebuildable from events;
  changed-only writes are a persistence optimization, never a second
  source of truth. Targeted loading waits until the write footprint is
  bounded.
- FTS (`memory_entries_fts`) stays in sync for changed rows; unchanged
  rows are simply not rewritten.
- Unrelated records byte-identical before/after (asserted in the
  reproduction test, not by comment).
- Context ranking deterministic; suppression semantics intact; no LIMIT
  that hides entities.
- No fabricated memory/OOM/timing forecasts anywhere.

## Acceptance

Scoped cost-reproduction test with D1 meta numbers lands first; 015A
design is judged against it plus the guard rule and the rebuild/undo/FTS
invariants; 015B against the webhook→hint→reply test with duplicates and
failure; 015C remains design-only. 014 stays the transport authority;
this plan does not duplicate it. Gates stay partial/review-pending.

## 015A.1 evidence — changed-only projection persistence (implemented, uncommitted)

Implemented 2026-10-04 in `packages/ledger/src/repository/executor.ts`:
pre-handler immutable persisted-column snapshots per collection, value
(never reference) diffing, and commit loops covering only created/changed/
deleted rows. Untouched: full-state loading, handler contracts,
events/receipt/quota/revision/activity writes, guard-first batching, FK
order, idempotency, Undo. Reproducer:
`apps/worker/test/ledger-footprint.integration.test.ts` (9 tests, real
workerd D1 with verb + `rows_read`/`rows_written` counting on
`run`/`all`/`batch` meta; `.first()` returns no meta, so `first()`-based
SELECTs contribute statements but no measured rows, and write coverage is
complete because all writes go through `run`/`batch`).

Measured one-record rename (controlled baseline from the original executor
via temporary stash, same minimal fixture both runs, probe file deleted
after): BEFORE 27 statements / 36 rows read / 27 rows written (SMALL, 6
entities) and 95 / 208 / 61 (LARGE, 40 entities); AFTER 16 / 21 / 22
(SMALL) and 16 / 91 / 22 (LARGE) — identical statements and identical
rows written on both sizes (asserted: 16 statements, 21–22 rows written
per size), while rows read scale with unrelated records (34 vs 139 in the
full fixture; writes flat at 21). Footprint independent of unrelated
counts; state-load reads are the remaining read cost (next step, not this
task). In-place reducer mutation (shared-object status flip) persists via
the snapshot where any post-handler diff would lose it (real
`entity_renamed` path); identical values emit zero projection writes via
the real `log_event` path; new records keep entity-before-events order;
unchanged aliases emit nothing; REAL undo-commit deletions remove only
reverted rows with teammate state intact (custom revert probes removed —
artificial handlers cannot prove replay equality); FTS follows committed
status/content (transitions only, incl. supersede); idempotent replay
costs 1 receipt read; stale revision returns conflict pre-batch; a REAL
stale-fence case (running run, expired lease) returns `fence_conflict`
with zero events/receipts/projections/revision changes; late failure is
positioned by the test-only wrapper at the TRUE batch end (no production
hook) and rolls back revision/receipt/row. Failed batches return no
result metadata, so rollback is proven by durable invariants, never by an
aggregate zero presented as measured cost. Persisted state equals
`rebuildProjections` over the event log. Existing memory Undo cases
(undo-removes-note, undoing-forget-restores-FTS+replay) rerun green.

Remaining full-load READ cost (next step, not this task): state load
still reads every projection row per command (~170 rows at 40
entities) — targeted loading stays explicitly sequenced after this write
bound. Full suite: 43 files / 595 tests green; typecheck/lint/build/diff
clean. Guard bounded-state rows, Telegram wake, context batching,
retention, and concurrency remain PROPOSED only.
