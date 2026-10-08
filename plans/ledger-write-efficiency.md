# R09 prerequisite — Targeted ledger reads and atomic field batches

**Implementation and repair commit present; final A–C acceptance remains open.** The original 2026-10-08 review tested `45a4fef` plus then-uncommitted code. Repairs subsequently landed in `7d67719`; the [current acceptance handoff](#11-current-repair-acceptance-2026-10-08) records the seven-pass/one-failure rerun at `929b57e`, with these execution owners unchanged through `32fd9e5`. The user selected this prerequisite **before starting R16**. Improve current conversational writes first; [editable information](editable-records.md) and [business memory capabilities](business-memory-capabilities.md) extend the accepted writer. Section 10 preserves historical findings, not an instruction to reimplement fixes already present. No commit, push, deployment, remote mutation or subagent is authorized by this plan.

## 1. Outcome and scope

A five-field update should load one entity and those five current fields once, then commit their events, changed projections, one action receipt and one business revision together. Updating one phone number must not deserialize the workspace's tasks, drafts, aliases and memory. Save clear facts even when a separate inferred status needs confirmation; the question must retain only that unresolved change.

Keep the existing Worker/D1 ledger owner, prepared SQL, pure handlers/reducers, append-only events, authority guard, run checkpoints and Undo. No new service, ORM, transaction framework or actor projection cache is required. Do not turn this prerequisite into implementation of custom columns, record lists, manual drafts or the grid.

Required before R16: field-command hydration, the new multi-field ledger command, mixed fact/question recovery, legacy retry compatibility, and real D1 correctness/cost evidence. Additional command footprints below are useful follow-on work within R09; they do not extend this prerequisite into a rewrite of every command.

## 2. Verified pre-implementation baseline and owners

This section describes the planning baseline before the uncommitted A–C implementation; it is not a claim that these paths remain unchanged. Section 10 records the implementation review and remaining repairs.

| Source owner | Current behavior and consequence |
|---|---|
| [queries.ts](../packages/ledger/src/repository/queries.ts), `getWorkspaceProjectionState` | Seven workspace-wide projection SELECTs: core five in one `batch()`, memory two in another. The existing batching is useful; returned rows and JS parsing still scale with the workspace. |
| [executor.ts](../packages/ledger/src/repository/executor.ts), `executeLedgerCommand`, approximately line 821 | Loads that full state and fingerprints it before every handler. Existing changed-only persistence already avoids rewriting unchanged rows. |
| [agent repository](../apps/worker/src/agent/repository.ts), approximately lines 130 and 1230 | The status-intent check rejects the whole tool into clarification before clear fields save. The dispatch loop then calls the executor once per field under child IDs, with separate transactions/revisions. |
| [setField.ts](../packages/ledger/src/commands/setField.ts), [field reducer](../packages/ledger/src/reducers/fields.ts) | Old value, provenance, candidate events, confirmed value and revision determine disputes. Status/assignment can also change the entity projection. Omitting these dependencies changes semantics. |
| [tools.ts](../packages/agent/src/tools.ts), `validateSetFieldsArgs` | Validates the whole input's basic shape/types before dispatch. Allows 1–20 items but only five current core field names, and does not reject duplicate field names. |
| [executor.ts](../packages/ledger/src/repository/executor.ts), receipt/clarification branches and `resumePendingClarification` | Receipt replay precedes hydration. The clarification branch persists a question but does not commit handler events. Resume merges requested fields at the top level; it does not interpret status confirmation or rewrite nested batch items. |
| [agent handler](../apps/worker/src/agent/handler.ts), tool completion/clarification | Persists a tool result and parks on public `needs_clarification`. The current activity labels this result skipped, even if a new mixed result includes saved facts. |
| [dispatch.ts](../apps/worker/src/actor/dispatch.ts), question parking/resumption | Reuses an existing pending question for the run; targeted answers use a durable operation when `command_name` is present. Cancellation already has a `cancelled_by_member` handling path. |
| [undo.ts](../packages/ledger/src/commands/undo.ts) | Undo locates the selected action receipt. From-here Undo selects that run's receipts with `result_status='applied'`. |
| [0003 ledger migration](../migrations/0003_ledger.sql) | Existing entity primary key, unique `(workspace_id, entity_id, field_name)` state key, and `(workspace_id, action_id)` receipt key support the proposed reads. Verify their query plans before adding indexes. |

The loop returns a parent action ID even though its receipts/events belong to `_f0`, `_f1`, etc. On replay, `already_applied` children do not advance the loop's current revision; remaining work can then conflict against its own earlier commits. These are source-derived failure paths, not newly reproduced test failures. Existing single-field tool tests do not prove multi-field rollback or mixed fact/question behavior.

For N successful items, today's projection work is N × seven SELECTs plus N full parses/fingerprints, N commit batches, N receipts and N business-revision increments. For five distinct core fields that is 35 projection SELECTs. The proposed field path uses two projection SELECTs in one read batch and one commit batch. Identity/source/receipt/revision reads still exist; this is not a promise that the whole request makes only two database calls or achieves a measured speedup.

## 3. Targeted hydration through the existing executor

### Required field footprint

Add a small internal loader in the existing repository: accept trusted workspace identity, one entity ID and distinct validated field names. Return the normal projection shape plus explicit loaded coverage. Use prepared statements:

```sql
SELECT <current entity columns> FROM entities
WHERE workspace_id = ? AND id = ?;

SELECT <current field columns> FROM entity_state
WHERE workspace_id = ? AND entity_id = ?
  AND field_name IN (?, ...);
```

Send these independent reads in one D1 read batch. An absent requested field is known absent, whereas an unrequested field is untouched. Load full persisted columns for the target rows; do not project away dispute/source/confirmed-value data. Bound parameters to the actual current field set.

Select this footprint inside the executor for trusted `set_field`, new `set_fields` and `resolve_conflict` handlers. Match the actual registered handler identity, not the caller's command-name string alone: existing tests/custom callers can pass another handler under a familiar name. Unknown/custom handlers retain the full loader. HTTP/model payloads cannot choose a hydration mask.

Unloaded collections can remain empty for existing pure handlers, but their coverage must mean untouched. Capture immutable fingerprints **before** invoking/folding reducers; maps share mutable row objects today. Permit writes only to the loaded entity, requested fields and declared new keys. A pure post-handler bounds assertion is enough; this is not another durable guard table or consensus protocol. If a handler needs an undeclared dependency, fix its footprint rather than silently treating that row as absent.

Reuse the existing diff writer on this covered state. Never replace a whole workspace table from a partial map. Deletions apply only to keys that were loaded and explicitly removed. A field update must not emit memory FTS changes, refresh jobs, alias deletion or task/draft writes because those maps were omitted.

Keep receipt lookup, current business revision, source ownership/channel, active membership, run/step ownership, live attempt/fence and expiry checks. Reads occur outside the commit transaction; the existing revision/attempt guard must abort if they became stale. Do not cache projections in actor RAM or bypass the guard because D1 executes statements sequentially. Preserve pre-guard source acceptance and `extrasBeforeGuard` ordering where used.

### Follow-on footprints after the required path is proved

Apply the same small helper only after verifying each handler and reducer against current source:

| Command family | Necessary projection data |
|---|---|
| `log_event` | Scoped entity when present; current quote field only for quote events. Contact/visit/note append operations do not need every projection. |
| `update_task` | The scoped task and any dependency actually checked by its handler/authority path. |
| `record_draft`, `mark_message_sent` | Scoped draft when existing; associated entity/source ownership where required. New IDs have explicit known absence. |
| `rename_entity` / an explicitly trusted alias handler | Target entity plus the normalized desired name/alias collision row. Preserve former aliases by leaving unloaded rows untouched. |
| `remember_context`, `forget_memory` | Subject authority, named current/superseded memory and relevant suppression keys; preserve targeted FTS changes and scope refresh jobs. Prove this separately. |
| `create_entity` | Current fuzzy duplicate matching scans names. A names/necessary-entity footprint can avoid unrelated stores, but do not cap candidates and silently change duplicate detection. Its remaining workspace-name cost needs separate evidence. |
| `delete_entity`, Undo, rebuild, unknown handlers | Keep current full behavior initially. Deletion needs all dependent rows; Undo/rebuild need historical context. Never truncate dependencies to claim bounded cost. |

Record unsupported paths as remaining R09 work. Acceptance of this prerequisite is not a claim that every ledger operation has constant cost.

## 4. One atomic ledger command for a field request

Add a pure `handleSetFields` beside `setField.ts`, register it in the ledger handler map, and adapt the existing `set_fields` tool to call the executor once. Keep the current public tool shape/allowlist and 20-item validation bound; custom fields belong to R16. The current allowlist has only five distinct fields.

1. Validate every item and target before any business effect. Normalize exact repeated items within this request; reject the same field with different values/provenance rather than silently choosing the last. Keep a deterministic canonical payload for receipt hashing. Do not skip a fresh observation just because its value equals the current projection: it may carry new source/provenance/history.
2. Classify status intent per item using the existing trusted source/intent boundary. A model's `provenance` or evidence string cannot grant confirmation. Clear non-status facts remain ready when status is uncertain. Preserve hard policy/authority failures as whole-request failures.
3. Fold ready items through existing field/event reducers in memory, using the parent action ID and consecutive sequences. Use the same hydrated working state so assignment/status interactions see preceding proposed changes. Preserve existing field dispute/correction rules. A hard rejection/conflict in preflight or folding produces no commit, including for earlier ready items.
4. Return all ready events and the final state to the current executor. Commit one authority guard, individual fact events, one parent receipt, one business revision increment, changed projections and the existing public action record in **one** D1 batch. Last event sequence advances by event count. Preserve source/run/step attribution for every event.
5. Include ready fields, event IDs, committed revision and any pending field in the durable result. These facts let recovery and UI distinguish what saved from what awaits an answer.

Preserve the existing configured daily action budget. The current executor increments `workspace_daily_actions.action_count` by one per applied field command. For the new batch derive a trusted cost from its ready field mutations, check `current_count + cost <= limit` in the same aborting guard, and increment once by that cost. Do not count model-provided values as an authoritative cost or derive cost from the reduced receipt count. Other existing commands retain their current unit; question-only/retry writes do not charge new business effects. Update the insufficient-capacity error classification accordingly. A batch exceeding remaining capacity rejects before any field commits, rather than silently weakening the limit.

Keep per-fact events; do not invent an opaque replace-all event. A five-field atomic write does not need a new bulk SQL abstraction. Use the existing prepared inserts/upserts in one transaction first; compact multi-row SQL only where measured statement/parameter budgets require it. Never use `Promise.all()` over child executor writes: it races one revision and still has partial-commit behavior. Several `db.batch()` calls are several transactions, not one atomic group.

## 5. Saved facts and a pending question

Example: a tool contains a stated phone/language plus an inferred warm status. Save phone/language together, retain current status, and ask only whether to mark the lead warm. Item order must not change this outcome.

Use the existing result/receipt/question stores with an explicit distinction between committed business effects and unresolved intent:

- **All ready:** ledger result/receipt are `applied`; no question.
- **Only uncertain:** use the existing `needs_clarification` receipt path; no business revision increment/events.
- **Ready plus uncertain:** ledger result/receipt are `applied`, include the existing optional `clarification` with its pending operation, and commit the ready events **and pending question** together. After commit, the agent adapter exposes `needs_clarification` with the committed revision/events and saved-field details so the run parks normally.

This keeps the stored receipt truthful and visible to current Undo without adding a new status across every client. Extend the applied executor branch to persist an attached pending operation/question using a shared small question-statement helper from the existing clarification path. Preserve deferred run transition: the actor still releases the execution slot and reuses that pending row. Store question/activity before publication; do not emit a second question activity when the actor parks.

Question identity and `source_revision` come from the committed transaction; for mixed writes use the post-commit business revision. Expose the saved fields in step completion/activity rather than labelling the whole result skipped. Do not add per-field activity/receipt rows.

The pending payload contains **only the uncertain status operation**, never the already-saved fields. Keep version-1 `command_name: 'set_field'` compatibility; this format already supports named commands. For a new confirmation, declare a bounded `status_confirmation` answer, retain the proposed entity/value, and keep inference unapproved until the explicit answer is validated.

Add a narrow status-answer normalization in the current resumption owner: an explicitly targeted, persisted member confirmation maps to the original `value` with stated provenance; a decline uses the existing cancellation path; ambiguous answers leave the same question pending. Preserve validation of requested fields and reject supplied entity IDs/unrequested keys. Do not treat arbitrary truthy text as confirmation. Existing version-1 status questions using `status` also need their answer mapped to `SetFieldArgs.value`; top-level merging alone does not do this. Recheck membership, answer ownership, target existence, current revision and run authority before committing the delta under its existing `:resumed` action.

On replay of a mixed receipt, the ledger returns its saved result as `already_applied` with the original clarification metadata. The agent adapter resolves the stored scoped question ID/status: park only if it remains pending; resolved/cancelled questions must not be recreated or re-run. A retry between business commit and actor parking recovers the existing row. A failure before commit leaves neither facts nor question. Undo of the saved action while its question remains pending must cancel that same action's unresolved intent, guarded in the Undo transaction, so a later answer cannot resurrect it; preserve unrelated run/teammate questions.

Do not ask the user to confirm an entire valid batch because one inferred status is uncertain. Do not return public `applied` and let the model silently continue past the question.

## 6. Receipts, legacy work and Undo

New batches use the parent action ID for both receipt and every event. Exact payload retry produces zero new business effects/revision increments; different payload reuse conflicts. Current membership/source/actor authorization is required before returning a scoped receipt to a caller. An action ID is not authority.

Existing in-flight work can already have `_fN` receipts without a parent. Preserve them and old pending operations. Add a bounded compatibility lookup for the validated request's explicit child IDs when no new parent receipt exists. Match workspace, actor/source/run/step as applicable, command and exact old child payload hash. Never infer success from a suffix alone.

Also cover an old question from the pre-dispatch intent check: it can have no child receipt and the actor's fallback `{command, params}` payload rather than ledger version 1. Preserve its current owned actor recovery path; do not misclassify it as a brand-new unapproved tool or overwrite its answer target. A narrow compatibility adapter at that existing resume boundary may normalize the stored `set_fields` intent. It must retain clear unsaved facts, apply only explicitly answered status, exclude verified already-committed children, and retain original fact/answer sources. Never upgrade arbitrary legacy JSON into authority. Test both formats before declaring rollout compatible; no source/answer evidence means leave the original question recoverable and report the limitation.

If matching child receipts exist, route that action through a narrow legacy-completion path rather than reapplying it as a new batch. Replayed children advance the tracked revision from their receipt; revalidate only remaining writes. A revision advance not explained by matching child receipts follows the existing conflict policy: do not silently rebase around teammate writes or stale snapshots. Report prior commits accurately, preserve old pending targets and handle stale source/attempt safely. This exceptional path can finish sequentially; it must not claim the original partial operation was atomic. Fully new requests always take the parent batch path. Do not delete old receipts or rewrite their append-only events.

Current Undo needs no new Save-group abstraction for this core batch: one parent action contains its fact events. Single-action Undo reverts that group; from-here still includes later writes of the run. Test intervening teammate edits/disputes and deterministic rebuild. Leave legacy child Undo targets valid; fixing historical UI aggregation is separate from rewriting history. R16 will later add its larger multi-chunk Save groups on top of this owner.

No schema migration is expected for this prerequisite: existing events, receipt JSON and pending-operation JSON can express it. If source inspection proves a missing constraint/index, justify one forward migration from the **then-current** tip; 0021 is the present tip, not permission to reuse the next number later. Never edit an applied migration.

## 7. Cloudflare architecture and measurements

D1 `batch()` provides the transaction/rollback needed here. A failed conditional UPDATE alone is not an error; retain the existing checked guard statement that actually aborts. This is the reason to extend the current transaction owner. [D1 binding/transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/).

Workflows supports durable multi-step execution, retries and long waits. These repairs are short scoped ledger mutations; they do not need another orchestration boundary. Existing agent steps already own retries/questions. This architectural choice is an inference from the actual write flow and [Workflows capabilities](https://developers.cloudflare.com/workflows/), not a benchmark claiming Workflows is slow.

Current official D1 constraints: 100 bound parameters per statement, 50 queries per Free Worker invocation, and statement limits still apply inside a batch. Count the **whole** invocation, including source/guard/receipt/activity/run work; batching does not permit arbitrarily large SQL. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Free D1 includes 5,000,000 rows read/day and 100,000 rows written/day. Index writes also count; one receipt is not one billed write. Use existing indexes and `EXPLAIN QUERY PLAN`, because few returned rows can still hide a scan. [Pricing](https://developers.cloudflare.com/d1/platform/pricing/), [index guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/).

Profile synthetic workspaces of 100, 1,000 and 10,000 entities with unrelated fields/tasks/drafts/memory. Compare the baseline and repaired current chat path for one field, five distinct fields, a mixed question, exact retry and a stale conflict. Record SQL statements, binding round trips, projection rows/bytes, parsed/fingerprinted rows, transaction/receipt/revision counts, D1 rows read/written and SQL duration. [D1 result metadata](https://developers.cloudflare.com/d1/worker-api/return-object/) exposes scanned/written rows and SQL timing.

Use real local Workers/D1 bindings for behavior and local query profiles. Record the Miniflare version and unsupported metadata; unavailable values remain unknown. Measure actual Worker CPU and end-to-end latency separately at the relevant venue. Free ordinary HTTP requests have 10 ms CPU, excluding network/database waiting; wall time or D1 SQL duration does not prove this budget. Existing actor execution has its own venue, which must be identified rather than assigned the HTTP limit blindly. [Workers limits/CPU measurement](https://developers.cloudflare.com/workers/platform/limits/).

Required cost outcome: field hydration scales with touched rows, not unrelated workspace size; new multi-field calls make one ledger commit/parent receipt/revision increment; retries make no business writes. Report p50/p95 with hardware/venue/sample counts when measured. No speed multiplier, production quota compliance or native-model latency parity is established by this plan. The provider/prompt/stream path remains separate work.

## 8. Execution slices and verification

### A. Targeted field hydration

Owners: ledger queries/executor/types, existing field/conflict handlers and integration tests. Add the trusted footprint and covered diff behavior; preserve full fallback. Prove single-field behavior and dispute/rebuild parity before changing the agent loop. Do not add a projection cache or schema migration without evidence.

### B. Atomic field batch and durable question recovery

Owners: new small ledger field-batch handler, handler registry, agent validator/repository/handler, existing clarification/actor resumption and Undo owners. Add whole-request preflight, one parent commit, mixed result adaptation, explicit status-answer normalization, pending-question cancellation on Undo and legacy receipt compatibility. Keep existing API/tool shape. This is one coherent correctness slice; do not ship a receipt format that Undo or restart cannot understand.

### C. Correctness and cost acceptance, then R16

Run meaningful pure and real-D1 cases below, profile baseline versus repaired paths, and update [status](../docs/status.md) and [backlog](README.md). R16 starts only after A–C satisfy their required checks. Leave broader hydration/retention R09 work visibly open. Optional additional command footprints are a separate measured extension.

| Test boundary | Required behavior |
|---|---|
| Pure batch | Five fields, deterministic event order, duplicate normalization/conflicting duplicate rejection, hard-invalid later item leaves no commit, fresh same-value observation retains its source. |
| Disputes/replay | Old/disputed/absent field, candidate and confirmed value, status/entity assignment coherence, correction event references; normal commit equals replay. |
| Coverage | Large unrelated collections remain untouched; no memory/FTS/refresh writes for field batches; custom handler with familiar name uses full fallback. |
| Atomicity | Fail membership/source/revision/attempt, insufficient daily capacity and a later SQL statement against real D1; no events, projections, receipt, question, counter charge or revision survives the failed transaction. |
| Mixed questions | Clear fields before/after inferred status both save once; status waits; one durable question; answer confirms/declines/ambiguous input; pending payload excludes ready fields. |
| Recovery | Crash/timeout after commit before step completion/parking; exact retry; active versus resolved question; no duplicate activity/question/effect. |
| Compatibility | Old child receipts plus uncommitted fields, all children committed, old pending `set_field`, changed payload/actor/source, action already undone; no invented parent success or reapplication. |
| Undo/concurrency | Batch single/from-here Undo, later same-run writes, unrelated teammate writes, pending question canceled only for reverted intent, answer after target deletion/revocation/conflict. |
| Costs | One versus five fields across fixture sizes; actual query plan, returned/scanned rows, byte/CPU/transaction/guard/receipt counts. Constant unrelated-data cost is proved, not inferred from a LIMIT. |

Existing suites include ledger, agent-tools and actor Workers integration under `apps/worker/test`. Use the root Vitest configuration's Workers project (inspect its current name) and exact targeted files first. Required implementation checks are:

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Report actual commands/exit results and any harness hang; a narrower pass is not a full-suite pass. Do not add UI stories or native layout claims for this backend-only prerequisite. If production UI changes become necessary, apply the repository's full UI verification requirements rather than waiving them. Keep performance instrumentation scoped to tests/measurement; no new analytics service.

## 9. R16 handoff and completion record

The editor's bounded Save extends the accepted footprint/transaction machinery for custom definitions, rows/cells and lifecycle dependencies. It must retain manual source acceptance, granular expected versions, larger chunk limits and Save-group Undo from its own plan. The current chat batch's 20-item input cap/five-field allowlist is not the future spreadsheet's capability limit. Do not create another executor or use the old per-field loop for paste/Save.

Completion requires a recorded source baseline, files/contracts/migrations actually changed, targeted/full checks actually run, before/after profiles, legacy/mixed-question/Undo evidence and explicit limitations. The original research pass changed documentation only. The subsequent implementation added source/tests without a migration; this independent review preserved production source and added local Workers/D1 audit probes. Acceptance remains incomplete for the cases below.

## 10. Review corrections, 2026-10-08

**Historical findings against `45a4fef` plus the initial implementation.** At that baseline, normal pure tests (324 pass / 1 skip) and field-batch plus agent-tools files (28 pass) were green, while the [audit probe](qa/2026-10-08-ledger-write-review.probe.test.ts) reproduced seven behavior failures across six issues; its late-membership rollback control passed. The source has since advanced; section 11 owns current acceptance. Preserve these failure cases and the existing executor, receipt/question stores and answer guard. No new service, schema, cache or guard framework is needed.

### Recovery and authority repairs

| Priority / observation | Owner and correction | Acceptance case |
|---|---|---|
| P1 / 52 | `actor/dispatch.ts`, legacy normalization: construct the normalized operation in memory. Pass it through the existing resume owner and commit operation metadata, guarded answer resolution and business effects in one batch. A failed commit must leave the original pending payload/missing fields intact. Persisted answer input alone is not committed approval. | Inject a real SQL failure at the end of the confirmation batch, then send targeted `cancel`. Status stays unchanged, no rejected approval survives, and the original question remains recoverable until a successful answer. |
| P1 / 51 | `agent/repository.ts`, clarification result adaptation: handle fresh and replayed results using the scoped canonical question's actual status. Applied/already-applied receipts with pending work must still expose `needs_clarification`; resolved/cancelled questions complete without reopening. Cover question-only receipts too. Keep original receipts/effects immutable. | Crash after mixed commit but before step completion/parking, retry exactly, recover one existing question and saved facts. Then confirm/decline and replay both mixed and question-only actions: no new question/activity/effect or blocked run. |
| P1 / 55 | `actor/dispatch.ts`, both legacy and versioned decline: reuse the current aborting answer transition for membership, source author/requester/chat, target pending question and waiting run. Commit cancellation/run transition/outbox/source requeue under that guard. A zero-row UPDATE is not rollback. | Remove membership or race Undo/question cancellation after precheck; no answer resolution, run queueing or continuation survives. Preserve the existing new-parent rollback control. |
| P2 / 53 | Legacy mixed decline: verify remaining clear non-status facts from the original intent/source, exclude exact already-committed children, and commit those facts while cancelling only the uncertain status under the same guarded transition. Preserve original fact/answer attribution. | Stated phone plus inferred status in an old `{command, params}` question: decline saves phone exactly once and retains prior status. Also cover all-facts-already-saved, ambiguous answer and quota/authority failure rollback. |
| P2 / 54 | Legacy child completion: reconstruct expected advances from matching child receipts, including actor/source/run/step and exact hash. Use their committed revisions for original-request replay, and reject unrelated intervening revisions. Do not silently read the live revision and rebase. | Use real child ledger commits, not receipt-only fixtures. Replay the original old expected revision with unsaved fields: only the remainder commits. Changed payload/identity and teammate advances fail honestly; replay after full completion adds no effects. |

Implement normalization and decline repairs together: routing the legacy decline through the guarded owner must also preserve its unsaved facts. Keep all new work on the existing atomic parent-batch path; only historical partial actions need sequential completion. Add focused tests to the existing integration files and convert the audit failures into passing regressions without weakening their assertions.

### Bounded hydration and cost acceptance

Observation 50 (P2): remove the alias SELECT and alias coverage from `getFieldProjectionState`. Trusted field handlers neither read nor mutate aliases. Leave that map unloaded/untouched, as with tasks/drafts/memory. Entity plus requested full field rows are the required two-query footprint; a future alias-changing command must declare its own necessary reads.

The audit populated unrelated aliases and inspected actual local D1 metadata: `rows_read` grew from 10 to 1000 with the workspace alias count, even though both `EXPLAIN` plans reported `SEARCH ... (workspace_id=?)`. Existing `(workspace_id, alias)` indexes cannot bound this read by entity. Constant prepares/batches and a `SEARCH` label are insufficient proof. The simplest repair removes the unused query; no alias index migration is needed.

After repair, populate unrelated aliases, fields, tasks, drafts and memory as well as entities; prove the same field command's projection reads stay bounded and unrelated stores remain untouched. Compare one versus five fields and the old versus new field path on the same fixture/venue. Retain full dispute columns, custom-handler fallback, coverage rejection and transaction-failure tests. Log local `meta.rows_read` where available without presenting it as production billed usage; label wall time separately from Worker CPU.

The implementation's [local cost profile](qa/2026-10-08-field-batch-profile.json) records n=11 smoke samples at 100/1000 entities, with 13 prepares and 2 batches for a single-field write. Its full-load `create_entity` comparator is a different command, not before/after field latency evidence. Production billing, ordinary-Worker CPU and end-to-end latency remain unmeasured. Missing venue measurements must remain explicit rather than being replaced by a statement-count claim.

Re-run the audit config with `pnpm exec vitest run --config plans/qa/2026-10-08-ledger-write-review.vitest.config.ts --reporter=dot`, the meaningful ledger/agent/actor regressions and the required implementation checks in section 8. Update the existing status/backlog with exact source/check results and remaining limitations; do not add another handoff document. A–C are accepted only when recovery/authority/cost cases pass and uncovered dispute/rebuild/Undo/FTS evidence is supplied. Follow-on broad command hydration stays separate R09 work.

## 11. Current repair acceptance, 2026-10-08

### Verified refresh and limits

The original eight-case audit was rerun after repair commit `7d67719`, at `929b57e`: **7 pass, 1 fails**, exit 1, 6.38 seconds. [Actual output](qa/2026-10-08-ledger-write-plan-refresh-tests.txt). The inspected executor, queries, agent repository and dispatch owners did not change through `32fd9e5`. This refresh did not rerun the whole application suite or prove production CPU/billing. Do not replace the historical red evidence or cite another session's green report as independent acceptance.

| Original observation | Current source/probe result | Remaining acceptance |
|---|---|---|
| 52, approval metadata | Normalization remains in memory; its sync and answer/effects share the guarded batch. Fault-then-decline probe passes. | Exercise ambiguous answer, repeated confirmation, conflict/quota/attempt failures and restart after actual commit. No failed approval may survive. |
| 51, mixed replay | Pending mixed receipt re-parks the existing question; probe passes. Closed question-only now returns `rejected` with `already_resolved`, and does not recreate the question. | The old assertion expects `already_applied` and still fails. Verify standing cancelled/resolved semantics through the actual handler/actor continuation before accepting or changing that expectation. |
| 55, answer authority | Guarded legacy decline rejects late membership removal; parent rollback control also passes. | Cover versioned decline, requester/source mismatch, answer versus Undo, stale attempt and removed-owner races. |
| 53, independent facts | Legacy decline now saves phone while retaining prior status; probe passes. | Verify original fact versus answer attribution, all-facts-already-saved and quota/SQL rollback. |
| 54, partial legacy revision | Real child revision 0 → 1 replay finishes the remaining field; probe passes. | Changed actor/source/run/step/hash and unrelated teammate revision must never be treated as owned prior work. Test full and interrupted completion. |
| 50, target-only hydration | Alias SELECT and its coverage were removed. | The old probe reads batch result slot 1, which is now a fields result, while its alias EXPLAIN is unused SQL. Its pass is not a current billed-row comparison. Refresh measurement by actual statement identity. |

### Slice D — Finish standing-result and recovery acceptance

Owners: `apps/worker/src/agent/repository.ts`, `agent/handler.ts`, `actor/dispatch.ts`, ledger receipt/resume owner, existing `field-batch.integration.test.ts`, `actor.integration.test.ts` and `agent-tools.integration.test.ts`.

1. Preserve immutable receipts and completed business effects. A closed question-only decline has no applied field to invent. A truthful standing cancellation may use the existing result contract; an `already_resolved` result is acceptable only if consumers complete recovery without re-asking, retrying effects or leaving the run blocked. Include canonical question status/standing outcome where consumers need it, rather than disguising a decline as a fresh successful mutation.
2. Construct real source/run/step rows and inject interruption after the field batch commits but before tool completion/parking. Recover through the actual execution owner. For mixed work, show saved facts once and one pending question. Then explicitly confirm/decline and recover again. Repeat for question-only work and an ambiguous answer. Assert durable step/run state, question count/status, activity, receipts, events, revision and quota.
3. Put SQL faults and authority races at commit boundaries, including versioned and legacy answers. Persisted accepted answer text must not imply committed approval. Revoke membership, change source/requester, race Undo, and invalidate the attempt after precheck. Failed transitions must leave no cancellation, run wake, partial metadata sync or effect.
4. Add realistic legacy child fixtures from ledger commands. Match owned actor/source/run/step and exact payload before including their committed revisions in the resume floor. The current compatibility loop explicitly checks command/hash; test the identity boundaries supported by existing receipt metadata and reject mismatch if they are not enforced elsewhere. Do not infer ownership from an `_fN` suffix or silently rebase onto live teammate work. Historical missing metadata needs a narrowly justified compatibility rule, not unconditional acceptance.
5. Keep the original red output. Once standing semantics are proved, update the current probe assertion to the agreed truthful outcome and add the consumer-level regression; do not weaken it merely to turn exit 1 green. New requests must stay on one atomic parent batch; only verified historical partial children use sequential completion.

Done: crash/retry/closed-answer/ambiguous/authority cases pass through actual local Workers/D1 plus handler/actor continuation, and output/action status accurately distinguishes saved facts, declined status and pending work. No new question, business effect or quota charge occurs on exact completed replay.

### Slice E — Bounded cost and reducer acceptance

Owners: `getFieldProjectionState`, footprint/executor tests, `field-batch-profile.integration.test.ts`, ledger migrations/rebuild/Undo and memory FTS tests.

1. Capture executed SQL and result metadata by statement identity. Assert that the field read batch contains entity and requested full field rows, with no aliases/tasks/drafts/memory SELECT. Populate unrelated aliases, fields, tasks, drafts and memory at increasing workspace sizes, and a target with disputed field history. Constant prepares alone is insufficient; record scanned rows/returned rows/bytes where exposed.
2. Compare one field and five fields on identical before/after fixtures and venue. Use the old field command path as the baseline, not `create_entity`. Include exact replay, mixed question, question-only, stale revision, quota exact limit and forced rollback. Record all invocation SQL/guard/event/index writes and receipt/revision counts. Unavailable local metadata stays unknown; measured SQL/wall time does not establish Worker CPU.
3. Verify full current/candidate/confirmed provenance, field disputes and status/assignment entity changes against full-hydration semantics. Preserve custom-handler full fallback and bounds rejection; a partial loader must never clear unloaded stores. Run event replay/rebuild, single/from-here Undo, question cancellation with Undo, FTS and action-inspection checks with unrelated teammate writes.
4. Run meaningful affected suites, then implementation commands from section 8. Current focused command example:

```text
pnpm exec vitest run --project worker apps/worker/test/field-batch.integration.test.ts apps/worker/test/ledger-footprint.integration.test.ts apps/worker/test/agent-tools.integration.test.ts apps/worker/test/actor.integration.test.ts
pnpm exec vitest run --project worker apps/worker/test/ledger.integration.test.ts apps/worker/test/ledger-migrations.integration.test.ts apps/worker/test/memory.integration.test.ts
pnpm exec vitest run --config plans/qa/2026-10-08-ledger-write-review.vitest.config.ts --reporter=dot
```

Report actual failures/hangs and narrower evidence honestly. Accept the R09 prerequisite only after slices D/E supply the missing proofs, recording one current verdict in status/backlog. Later broad command footprints, startup/cache work and production latency profiling remain separate carried work; none require reintroducing aliases to this field footprint or adding a new transaction framework.
