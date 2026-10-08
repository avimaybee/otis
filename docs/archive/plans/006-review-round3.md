> Closed historical plan record, reconciled 2026-10-07 from `plans/006-review-round3.md`. Family 006: core loop/memory present; grounding/recovery/quality partial. Remaining R02, R03, R04, R13 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# Gate 006 repair review — round 3 (independent, 2026-10-02)

Reviewed `859ed92` plus the current uncommitted tree in `D:\vs code\Otis`.
No commits, no source edits, no deployments, no live provider calls.
Only this review document was added under `plans/`.

**Verdict: NOT ACCEPTED.** Gate 006 remains `IMPLEMENTED; review fixes required`.
Do not treat Gate 007 as eligible.

This round re-checked the seven round-2 blockers (R2-01–R2-07) plus the
R2-08 source-verified gaps against live source, and re-executed the seven
bad-behavior probes. All seven probes still pass, meaning all seven defects
are still reproduced on the current tree. The passing root suite does not
override them.

## Commands actually executed and observed outcomes

All from `D:\vs code\Otis` with `$env:TEMP='D:\wtmp'; $env:TMP='D:\wtmp'`:

- `pnpm typecheck`: exit 0.
- `pnpm lint`: exit 0.
- `pnpm test`: 313 passed across 25 files.
- `pnpm eval:agent`: 1 passed (still the pure scripted validator evaluation,
  not composed-agent acceptance; see R2-07).
- `pnpm exec vitest run --config plans/review-evidence/006-review.config.ts plans/review-evidence/006-repair-agent.repro.test.ts plans/review-evidence/006-repair-memory.repro.test.ts`:
  2 files, **7 passed**. Passing here confirms defective behavior is present;
  these are not acceptance tests.

The historical fourteen first-round probes were not run as an aggregate;
repaired narrow symptoms may make some of them fail, which is expected.

## Findings, each independently traced and executed

### R2-01 — P1, F11: refresh publication still completes before selecting (UNRESOLVED)

- File: `apps/worker/src/agent/memory.ts:303-346`.
- Statement 1 (`UPDATE memory_refresh_jobs SET state='completed'`) runs before
  statement 2 (`INSERT ... SELECT FROM memory_refresh_jobs WHERE
  state='running' AND claim_token=? ...`).
- The second statement therefore selects zero rows in the same batch.
- Executed: pending job `repair-publication` returns `completed: 1`, durable
  state is `completed`, but no `memory_summaries` row exists.
- Related gaps still present: no current-revision equality guard at
  publication (only a `built_from_revision <=` upsert guard), no terminal
  handling for an expired `running` job already at `max_attempts` (discovery
  at line 229-233 filters `attempts < max_attempts`, so it stays invisible),
  and success is counted from the completion update, not verified publication.
- Smallest repair: publish-while-guarded first (ownership/expiry/unchanged
  revision), then complete, in one guarded batch with zero-row treated as
  failure; retain/requeue on revision change; add exhausted-state handling.
- Regression needed: published text/manifest/revision on success; failure
  rolls back both; stale-worker publish changes zero rows; revision change
  during extract; expired-at-max-attempts terminal state.

### R2-02 — P1, F07: daily/run budgets still not implemented (UNRESOLVED)

- Files: `apps/worker/src/agent/handler.ts:46-48,305,562-576`,
  `apps/worker/src/index.ts:69-87`,
  `packages/ledger/src/repository/executor.ts` (no `workspace_daily_actions`
  write), `packages/identity/src/settings.ts` (no daily counting).
- `maxRoundsPerRun` is declared and never read; the slice loop uses only
  `maxRoundsPerSlice` (default 2).
- The daily check is a read-before-commit (`SELECT action_count ... >= limit`
  returns a failure), not atomic counting at the ledger/settings commit
  boundary. No insert/update of `workspace_daily_actions` exists in either
  committing owner.
- `createWorkerAgentHandler` supplies no `limits`; missing required production
  configuration still allows inference and completion.
- Executed: `{maxDailyActions: 1, maxRoundsPerRun: 1}` with two entity
  mutations commits both, completes, and leaves zero daily-counter rows.
  A second probe confirms missing config still completes.
- Do not invent numeric production defaults; tests use small explicit values
  and production config must be validated as required.
- Smallest repair: validated required operator limits wired through the real
  composition root, durable reservation/accounting across restart, and
  atomic counting inside the same committing transaction as each applied
  logical action (UTC-day scope, reads/replays zero, compound/memory/settings
  per the existing counting contract).

### R2-03 — P1, F06/F08: bulk confirmation still loses the proposal (UNRESOLVED)

- File: `apps/worker/src/agent/handler.ts:473-499`.
- The greater-than-three check parks the run before persisting `currentRound`,
  ordered calls, or an approval contract. The `needs_input` outcome carries no
  `pendingOperation`, so `dispatch.ts:waitForInput` stores
  `operation_payload_json = NULL`.
- Resume takes the non-ledger path, advances to `provider_pending`, and the
  next identical proposal triggers the same question again.
- Executed: four businesses proposed, explicit confirmation of those exact
  four, resume returns `resumed: true`, redispatch asks the same question
  again, zero applied receipts, saved payload null.
- Smallest repair: persist the exact proposal/scope before asking, bind
  approval to its question and exact targets, resume the saved operation once,
  disallow added targets, count scope across calls/rounds.

### R2-04 — P1, F06: control clarification still saves the wrong payload (UNRESOLVED)

- Files: `apps/worker/src/agent/repository.ts:405-425`,
  `apps/worker/src/agent/handler.ts:642-667,236-302`,
  `apps/worker/src/actor/dispatch.ts:1379-1461`.
- The repository returns the typed operation at
  `result.clarification.pending_operation` (`version: 1`, `command_name`,
  `action_id`, `args`, `source_revision`).
- The handler reads `(result)['pending_operation']` (wrong nesting) and falls
  back to `{command: call.name, params: call.args}` — an unversioned
  `request_clarification` wrapper the ledger resumer rejects.
- Executed: control question for a missing-deadline `create_task` saves
  `command: request_clarification` with no version; an authenticated
  no-deadline answer returns `resumed: false`.
- Also still present: the handler reconciles via `ORDER BY created_at DESC
  LIMIT 1` over the whole run (line 237-244) rather than the receipt tied to
  this clarification/call/action.
- Smallest repair: pass through the canonical typed payload at its real
  nesting with original args/revision, preserve clarification/call/action IDs,
  and resolve exactly that receipt; never consume a call from latest-receipt.

### R2-05 — P1, F04: actual Gemini wire payload still duplicates results (UNRESOLVED)

- Files: `apps/worker/src/agent/handler.ts:369-415`,
  `packages/agent/src/providers/gemini.ts:80-154`.
- The handler puts every completed round (including the latest) into
  `messages` as assistant/tool blocks and also puts the latest round's
  results into `pendingToolResults`.
- The adapter serializes historical tool messages (line 88-94) and appends
  pending results again (line 142-149).
- Historical tool messages carry no `name`, so the duplicate has an empty name.
- Executed with mocked HTTP, no real provider request: outgoing
  `wireBody.input` contains two `function_result` blocks for the same
  `call_id === 'wire1'`.
- Smallest repair: give one owner to serializing the pending group so the wire
  boundary carries exactly one result per call while retaining full history,
  continuation, names/args/order, and protocol metadata.

### R2-06 — P1, F09: undo-forget still leaves FTS inconsistent (UNRESOLVED)

- Files: `packages/ledger/src/repository/executor.ts:1066-1145`,
  `apps/worker/src/agent/memory.ts:378-516`.
- The executor updates `memory_entries` for `revert` events but its FTS
  maintenance only handles `memory_note` (insert) and `memory_forgotten`
  (delete). Undo emits `revert` and never reinserts the restored note.
- Executed: remember → forget → explicit single undo of the forget leaves the
  note `active`, suppressions zero (that narrow part is correctly fixed), but
  FTS zero entries; full `replayWorkspaceMemory` produces one FTS entry, so
  online projection and replay differ.
- The `getTurnContext` active-note read still finds the note (it joins the
  projection, not FTS), which is why the narrow retrieval symptom is masked.
- Smallest repair: reconcile FTS from the resulting active projection for
  affected notes inside the same guarded command batch (forget and
  supersession undo included); guard operator replay against concurrent source
  commits.

### R2-07 — P1, F12: evaluator still simulates success (UNRESOLVED)

- File: `eval/runner.ts:156-199,272`.
- Applied writes are hypothetical increments after validator/policy checks;
  source-link correctness is `nonempty text && nonempty user` counting;
  the runner never executes the composed handler or real D1 effects.
- Only `memory_promotion_accuracy` changed to `null`; the pipeline gap is
  unchanged.
- `pnpm eval:agent` passing (1/1) therefore still does not establish zero
  wrong writes, correct sourcing, isolation, undo, or memory lifecycle.
- Smallest repair: keep pure helper tests labeled honestly and add
  deterministic composed fixtures (fake inference + real migrated D1)
  asserting actual targets/values/events/receipts/questions/sources and
  forbidden effects; leave unmeasured metrics null.

### R2-08 — other original contract gaps (STILL OPEN, source-verified)

- Stale clock: handler-entry `nowIso` (line 82) is still passed to
  `persistStep`/`completeStep` (lines 606, 633). `saveProgress` uses a fresh
  clock, steps do not. Progress/snapshot guards also lack the full
  live-membership/workspace-fence equality of the accepted owner.
- Trust/policy at the real boundary: production `executeAgentTool` call
  (lines 612-626) still omits `sourceTrust`, so the repository defaults to
  `member`. The pure helper's blocked-tool list does not secure the forwarded/
  stored path. Draft/sent confirmation and disputed-field reliance checks are
  still absent from actual execution; status intent still checks only the first
  status field and matches global text without target/source-span binding.
- Context: still lacks authoritative typed disputed fields, original pending
  operation, source/applicability rendering, and suppression of historical
  source excerpts. The transcript filter (context.ts:149-154) drops all old
  messages whose text equals the current input instead of excluding only the
  current source by identity. Dates still use wall clock/brief timezone rather
  than a pinned member-local decision context.
- Reads: `query(entities)` ignores `entity_id` and other documented filters;
  invalid event cursors silently broaden; FTS fallback can swallow
  authorization/storage failures. Membership recheck after paused inference
  needs verification.
- Undo targeting: bare `undo` (repository.ts:678-692) still filters workspace
  actions by author only, with no current-chat scope through run/source
  relationships.

## What is actually fixed (narrow, not group closure)

The round-2 list of narrow improvements still stands on this tree: completed-
phase spin handling, running/lease-checked progress publication with row-count
checks, contiguous fresh tool/checkpoint indexing, real-branch pinned registry
key use, transcript messages reaching requests, cancelled/incomplete rejection,
explicit undo target acceptance, reverted-note deletion with full causal replay,
workspace-summary member-note exclusion with a member-scope branch, expired
`running` refresh discovery, and the null unmeasured metric. Each is a real
improvement, but the complete-flow tests above show their groups are not closed.

## Limitations of this review

- Local workerd/D1, fake providers, and mocked HTTP only. No deployed
  service, browser/device, live-model, cost/latency, or dependency audit.
- Source scope was the changed runner/context/repository/memory path and its
  immediate ledger/identity/provider/actor integration, plus tests/evaluator.
- Secrets were not read or reproduced; transport reproductions used the
  synthetic key `synthetic-review-key`.
- No files outside `plans/` were added or modified by the reviewer.

## Next bounded implementation instruction

Preserve all existing uncommitted changes. Keep Gate 006 `IMPLEMENTED; review
fixes required`. Correct any documentation that still implies F01–F13 are
fully repaired or that atomic daily counting exists.

Work in small verified batches in this order:

1. Refresh publication ordering plus revision/exhaustion guards, and FTS
   reconciliation inside the guarded memory command batch.
2. Exact clarification/approval payloads (control and bulk) with receipt-bound
   resumption, plus single-owner Gemini/Go wire serialization.
3. Durable configured limits with atomic commit-boundary counting and actual
   trust/context boundaries (sourceTrust wiring, disputed/draft/sent checks,
   transcript identity filter, read-filter strictness, chat-scoped bare undo).
4. Real composed-pipeline acceptance evidence (fake inference + migrated D1)
   for every Appendix A and 006A–006D behavior, with final DB/wire assertions.

Each batch must report modified files, regression scenarios with final-state
assertions, and unresolved finding IDs. Final root checks must pass, but root
green alone is not acceptance. A new migration uses the next unused number;
never rewrite applied migrations.
