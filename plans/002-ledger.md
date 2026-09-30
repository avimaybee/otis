# Plan 002: Build the auditable business ledger

> Purpose: make every business fact and task change reproducible, attributed, workspace-scoped and undoable. Read [architecture sections 5, 8–10](../architecture.md), [shared contracts](../docs/contracts.md) and [verification cases](../docs/verification.md) before changing schema or reducers.

## Status and dependencies

This gate is DONE (2026-09-30). Schema migration `0003_ledger.sql`, pure domain reducers, typed commands, D1 guarded atomic batch executor, pure tests, and workerd D1 integration tests have been implemented and verified. All 4 root verification checks pass. Next eligible gates are 003B and 004B.

## Outcome

Implement a ledger command boundary that is the sole writer of business state: entities, aliases, business events, current fields, tasks, draft history and durable memory-note events. A command appends versioned attributed events and updates rebuildable projections atomically. The system can explain what changed, who said it, when it was recorded, which input supports it, and how to undo it.

The ledger is not the owner of authentication/session state, chat text, channel routing, provider settings, delivery state or export files. It receives a trusted source and actor context from those owners. It must reject a model/client-supplied identity, workspace, source, fence or authority field.

## Decisions the implementation must preserve

- Existing lead status values are `new`, `cold`, `warm`, `hot`, `won`, `lost`, `deprioritized`. `new` is a neutral initial value for a genuinely new lead. An inferred change to an existing lead's status always asks the member before writing. A stated explicit status can be saved directly. “Closed” is ambiguous between won and lost and asks.
- Task state is `open`, `done`, `cancelled`; snooze is a notification-until instant and does not change due date. Due is a typed date-only, instant or explicit no-deadline value. If a new intended task has no date and no explicit no-deadline instruction, preserve the request as pending clarification; never assign today.
- Disputed current fields have `value=null` and retain candidate event IDs. The prior confirmed value remains historical only. No tool, draft, summary or brief may rely on it as current.
- Undo defaults to the selected action and later successful business writes in the same run. The user can choose “Undo only this action.” Reads, chat turns, other runs and unrelated teammate work are not in the group. Preview effects and dependencies; atomically apply or ask.
- All ordinary durable business changes have one member or named system-job actor, one workspace, exactly one source message or source job, an idempotent action ID, event sequence and committed business revision.
- Quotes retain integer minor units and ISO currency. Distinct offered/expected meanings are not merged. Never order or sum different currencies without an explicit conversion rule.

## Storage and event model

Extend the shared schema established by 003A and 004A. Suggested ledger tables are `entities`, workspace-scoped `entity_aliases`, append-only `events`, `action_receipts`, `entity_state`, `tasks`, a draft projection if needed by 012, `field_defs` reserved without custom-field creation, and a monotonic workspace business revision. Name and allocate the migration after inspecting the repository. Use composite workspace keys or equivalent checks for every referenced record.

An event includes at least: event ID, committed workspace sequence, workspace, entity where applicable, actor kind/user or system job, closed event kind, schema version, validated typed payload, `occurred_at`, server `recorded_at`, exactly one `source_message_id`/`source_job_id`, logical action ID, optional causal/supersedes/reverts references, and trust/provenance. Keep business time (`occurred_at`) distinct from receipt time. Do not use UUID order or wall-clock timestamps to resolve concurrent events.

Initial event kinds and payloads come from [contracts section 5](../docs/contracts.md). Reducers must exhaustively handle every kind/version. New payload semantics require a versioned migration/replay plan. Chat/message and source rows are already owned by 004A; do not recreate them. Every event source must resolve to the same workspace and permitted author/system job at commit time.

`entity_state` is a projection, not the history. It contains one row per current field with state `clear|disputed`, nullable value, provenance, source/candidate event IDs, and revision. Store last-confirmed values only as explicitly historical metadata; they cannot leak into current reads. `tasks` project task title/entity/assignee, typed due, status, snooze-until, source event and revision. Draft status/revisions are owned by the ledger; outward delivery channel outcomes are not.

## Command boundary

Expose typed commands, not arbitrary row patches:

| Command | Valid behavior |
|---|---|
| `create_entity` | Create from a clear member instruction; perform duplicate search first; near-duplicate ambiguity asks; use neutral `new` status |
| `rename_entity` / `add_alias` | Preserve former names as aliases and sources; reject collisions within the workspace |
| `log_event` | Only closed note/contact/visit/quote kinds and validated per-kind fields |
| `set_field` | Core field allowlist; save clear explicitly stated values; for inferred existing-lead status return `needs_clarification` before mutation |
| `create_task` | Persist a clear title; a member-authored task defaults to that member unless explicitly assigned. An unclear system-suggested assignee asks. If due date is missing, keep durable pending clarification, not a task due today |
| `update_task` | Explicit completion, cancellation, due change or snooze with expected revision; snooze never overwrites due |
| `resolve_conflict` | Append a sourced resolution that identifies all candidates and the member's explicit resolution |
| `record_draft` / revision | Attributed draft event only after user asks; no provider-facing send operation |
| `undo_preview` / `undo_commit` | Preview from-here/single effects and dependencies, then revision-check and append revert events atomically |
| `rebuild` | Pure deterministic projection from retained non-suppressed ledger events; no side-effecting messages/jobs |

Each command gets trusted server-injected context: workspace, actor, current membership revision, source, run/step, fence, request/action ID and expected business revision. Validate the workspace/source/membership within the committing transaction, not just before model generation. A lost response retried with the same action ID and identical payload returns the original receipt; a different payload is a conflict.

Return discriminated results as in contracts: `applied`, `already_applied`, `needs_clarification`, `conflict`, `rejected`, `retryable_failure`. Successful receipts include effects, event IDs, committed revision and safe before/after summaries. An HTTP success or a model statement does not establish that a write committed.

## Atomic D1 write protocol

1. Validate typed arguments and trusted context; compute a proposed projection using pure reducers.
2. In a single D1 transaction/batch, create a guard that **throws/fails** when current membership, source ownership, run fence, idempotency payload or expected business revision is stale. Cloudflare D1 does not treat a zero-row `UPDATE` as an error. A tested `CHECK(guard_ok=1)` row derived from transactional `EXISTS` checks is one acceptable technique.
3. In the same transaction append the receipt and events, update projections and workspace sequence/revision, and insert durable public activity/refresh outbox rows owned by this action.
4. Return the result only after commit. If a guard fails, leave no event, projection, cursor or outbox change; reload and re-evaluate instead of replaying stale interpretation.

Use actual local Cloudflare D1/Worker integration to prove a deliberately late batch failure rolls back everything. Include same-revision concurrent writers, duplicate action/payload, reused ID with altered payload, removed member, wrong-workspace source, expired actor fence, and stale source revision. Do not rely only on a mocked repository to establish SQLite transaction behavior.

## Projection and conflict rules

Reducers sort by committed workspace sequence, apply schema-version migrations explicitly and exclude reverted effects through recorded causal references. A rebuild must reproduce current fields, task state, draft revision and memory-entry projection from the event log plus declared system records. It must not rewrite chat text, messages or delivery outcomes.

Distinguish an explicit correction, a temporal update and a competing claim. When two incompatible current claims exist and the member has not resolved which is current, set the field disputed and null. Record candidate IDs and why they conflict. An explicit “actually, the quote is 3,600” may supersede a prior stated value when entity, currency and meaning agree; a teammate's independent contradictory claim may require clarification. The model proposes this interpretation, but ambiguous cases do not write until a member resolves them.

For lead status, “they sounded interested” does not mean `warm`. Present the proposed status in a natural, narrow question. Only the answer commits the status event. Do not mutate first and ask afterward. Same for missing deadlines: preserve the original task intent and ask which date or whether there is no deadline; only a valid answer releases the task write.

## Undo behavior

Create a preview against a specific current workspace revision. `from_here` selects the referenced successful business action and later successful business actions in the same run; `single` selects only the referenced action. Display human-readable affected values/tasks/drafts and any causal dependencies. Read-only activity is skipped. If undoing a prior selected event would invalidate an unrelated later teammate write or a later run, report the exact conflict and ask rather than overwriting it.

Commit the entire selected set or none. Append revert events with requester/source, target IDs, mode, expected revision and group operation ID. Rebuild affected projections deterministically while preserving later independent writes. Undoing one disputed candidate recomputes the dispute from remaining valid candidates; it may resolve only when the surviving state is unambiguous under the recorded causal rules. Undo of a sent-message record changes Otis's record only; it cannot unsend the real message.

## Suggested module map

Adapt to existing conventions; do not create this exact layout if the repo has a better owner boundary:

- `packages/contracts`: closed versioned event/command/result schemas.
- `packages/ledger`: `events`, `reducers`, `commands`, `repository`, `undo`, `rebuild`.
- migrations: next unused migration after 003A/004A; ledger tables only.
- tests: pure reducer fixtures, D1/Worker integration, undo/dependency cases.

Do not add an ORM, vector DB, generic CRM fields or agent/channel dependency to the ledger. `field_defs` remains reserved until a separate future plan explicitly defines custom fields.

## Verification and acceptance

Use [verification.md](../docs/verification.md) cases `LEDGER`, `UNDO`, `IDENTITY`, `INBOUND` plus the current product acceptance fixtures. Required outcomes include:

- Same event stream always rebuilds the same projection; sequence controls order.
- Dispute returns null current value and candidate sources; old value cannot be used as current.
- Inferred lead sentiment asks; explicit status saves directly.
- “Send Bistro the offer” without a due date remains durably pending; it never becomes due today.
- Source message/job XOR, workspace matching, actor and event ownership are enforced.
- Failed atomic batch leaves no partial side effect.
- From-here and single undo select the expected actions; unrelated teammate/run work survives; dependent work triggers clarification.
- Retried commands have one effect, and edits against stale revision return conflict/refresh.
- Build/test commands are run and recorded per the root handoff. Do not claim browser or provider evidence for this ledger-only gate.

### Verification Record (2026-09-30)

1. **Pure Reducer & Invariant Suite (`packages/ledger/test/pure.test.ts` - 20 passing tests):**
   - Event invariants: enforces single workspace, exact source XOR (`source_message_id` vs `source_job_id`), channel matching, actor attribution.
   - `create_entity`: detects exact and near-duplicates via Levenshtein edit distance, returns `needs_clarification` on ambiguous duplicates, sets neutral `new` status.
   - `rename_entity` & `add_alias`: preserves past names as aliases, rejects workspace collisions.
   - `log_event`: strictly enforces closed kinds (`note`, `visit`, `contact`, `quote`), verifies quotes have integer minor units and ISO currency code.
   - `set_field`: strictly requires `needs_clarification` on inferred sentiment or ambiguous "closed" status before mutation; explicit status values save directly.
   - Tasks: missing deadline returns `needs_clarification` and never defaults to today; supports typed date/instant and explicit no-deadline; snooze preserves due date and updates `snooze_until`.
   - Disputes & Reducers: competing claims set `state = 'disputed'`, `value = null`, preserve candidate event IDs, preventing old value from leaking into current reads.
   - Conflict Resolution Validation: `handleResolveConflict` validates entity existence (`not_found`), field existence (`field_not_found`), disputed state (`field_not_disputed`), and exact candidate event IDs match (`candidate_mismatch` / `invalid_candidates`). Resolving valid conflict restores `state = 'clear'` with chosen value.
   - Deterministic Replay: `rebuildProjections` reconstructs identical projections from sequence-ordered events; excludes reverted events causally.
   - Undo: supports `from_here` (same run suffix) and `single` undo; detects dependent subsequent actions and requests clarification instead of silently corrupting state; active-target detection ignores already-reverted events.

2. **D1 Local Transaction & Isolation Suite (`apps/worker/test/ledger.integration.test.ts` - 16 passing tests in `workerd`):**
   - `TX-01`: Guard failure in atomic D1 batch rolls back all operations with zero partial state.
   - `TX-02`: Stale `expected_business_revision` aborts with `revision_conflict`.
   - `TX-04`: Retrying exact same `action_id` and payload returns original receipt (`already_applied`); altered payload returns `conflict`.
   - Authority & Fencing: Rejects removed workspace member (`forbidden`), rejects wrong-workspace source message (`source_conflict`), rejects member citing another member's message in the *same* workspace (`guard_conflict`), rejects stale execution fence (`fence_conflict`).
   - Lease Fence with Sub-Day Normalization: `unixepoch(w.lease_expires_at) > unixepoch('now')` guards against expired same-day ISO timestamps where string comparison would fail due to `'T' > ' '`. Verified with an expiry earlier today (rejected with `fence_conflict`) and a valid expiry later today (`applied`).
   - Run & Step Validation: Guard rejects non-existent run (`run_conflict`), inactive/cancelled run (`run_inactive`), trigger message mismatch (`run_source_mismatch`), and permits active runs including `waiting_for_input` when resuming clarifications.
   - Projection Synchronization on Undo: Proves `executeLedgerCommand` with `undo_commit` physically deletes undone entities, tasks, and state fields from D1 tables; complete D1 database matches pure `rebuildProjections` replay exactly (0 remaining rows).
   - Repeated Undo: A repeated undo targeting the same action with a new `action_id` returns `already_applied`, appends 0 new events, and leaves workspace revision unchanged.
   - Durable Clarification Retention & Resumption: Missing-deadline task creation commits an `action_receipts` row (`needs_clarification`) and records a `pending_clarifications` entry with a versioned, typed `PendingOperationPayload` (persisting command name and validated original arguments). `resumePendingClarification` successfully resumes after actor restart with fresh context, unblocking the run and atomically committing the final task with both original title and clarified due date.
   - Conflict Resolution Lifecycle in D1: Verifies competing quotes produce `disputed` state with candidate IDs in SQLite, rejects resolutions targeting clear fields (`field_not_disputed`) or invalid candidate IDs (`candidate_mismatch`), and atomically applies valid resolution to restore `clear` state.
   - System Jobs & Channel Attribution: Validates system jobs require active status and matching job kind; inbound Telegram source messages record events with `channel = 'telegram'`.
   - Immutability Triggers: Database-level SQLite triggers prevent any `DELETE` or `UPDATE` on `events`, and prevent `DELETE` on `action_receipts`. Provenance foreign keys use `ON DELETE RESTRICT`.
   - True Concurrent Writers: Two racing commands from the identical snapshot revision running simultaneously via `Promise.all` result in exactly one succeeding (`applied`) and one failing with `revision_conflict`.

3. **Four Root Checks:**
   - `pnpm typecheck`: Exit 0 (all 10 workspace projects build cleanly).
   - `pnpm lint`: Exit 0 (all ESLint rules satisfied, 0 warnings).
   - `pnpm test`: Exit 0 (101 passing tests across 10 test files).
   - `pnpm build`: Exit 0 (Vite client bundle, TypeScript build, Wrangler deploy dry-run pass).

## STOP conditions

Stop this gate if the committed D1 transaction cannot guard membership, source, revision and fence atomically; if an event cannot be replayed without hidden state; or if undo cannot safely identify its effects/dependencies. Report the smallest concrete counterexample and revise the contract before adding agent tools.

