# Workspace memory on Cloudflare: implementation handoff

Status: TODO; part of plan 006, not a separate product feature. Implement memory projections only after 003A identity, 004A durable sources and 002 ledger ownership are established, then integrate through 004B/006. Plan 007 consumes existing chat/source tables rather than creating them. Read product.md, architecture.md and docs/contracts.md before code. Durable context, including each individual's communication preferences, remains in the workspace where learned. Active workspace members can inspect chats and retained audio, including history from before joining; memory read/write must still scope personal entries correctly.

## Result to deliver

After Avi tells Otis in one Kerning chat, “Keep replies short and direct,” a new Kerning chat, a Worker restart, and a Telegram conversation should all preserve that preference. A different workspace containing Avi must not receive it. If Hunor later disputes a business fact, Otis must show the disagreement and ask for clarification; a cached summary must not present the old fact as settled. “Forget my preference for short replies” must remove that preference from future context while retaining the attributed chat and event history until a separate erase operation is requested.

Memory is four layers with different authority:

| Layer | Canonical? | Cloudflare home | Purpose |
|---|---|---|---|
| Typed ledger events, entity state, tasks, settings | Yes | D1 | Business facts, actions, current status, permissions and executable preferences |
| Chats, transcripts, pending clarification, run/activity log | Yes for conversation history | D1; voice audio in R2 | Episode-level evidence and continuation across turns |
| Curated memory notes | Yes for durable conversational context, with provenance | D1 plus a D1 FTS5 index | Short stable preferences, relationship and workflow context that is not a typed business field |
| Workspace/entity/member summaries | No; rebuildable projection | D1 | Bounded context for a model turn |

Do not put canonical memory in a mutable `memory.md` or Durable Object storage. A Markdown view may be generated read-only from D1 for inspection or export. Do not add Vectorize in the first release: exact entity links and D1 full-text search are enough to measure retrieval quality before introducing embeddings.

## Cloudflare request and refresh path

1. The web or Telegram Worker authenticates the sender and resolves a workspace through plan 004. It inserts the inbound message with a channel-scoped dedupe key, then dispatches the workspace's Durable Object. The Worker never accepts a workspace ID from the model or an unauthenticated client as authority.
2. The Durable Object leases/serializes work for that workspace and starts a persisted `agent_run`. Its in-memory state is disposable; D1 holds the inbox, run state, pending clarification and all memory. Do not keep a lock across provider network calls with `blockConcurrencyWhile`; rely on persisted lease/step IDs and ledger idempotency when calls resume or interleave.
3. Before calling the model, the agent builds a context packet from current typed state, pending clarification, recent chat turns, and relevant sourced memory. It checks workspace membership on every read. A stale summary is omitted or explicitly downgraded in favor of current source records.
4. A model request to `remember_context` is validated by the agent policy gate and committed through the same ledger boundary used for actions. One D1 transaction appends an attributed `memory_note` event, updates the memory projection, and records refresh work for the affected scopes. The turn can read the new note immediately; it does not wait for a summary.
5. The transaction commits before the Worker publishes a small job ID to Cloudflare Queues. A Queue consumer rebuilds summaries later. Queue messages contain IDs and scope only, not full private text. A scheduled reconciliation job finds committed refresh work that was not delivered to the queue. Queue delivery and Durable Object alarms may repeat, so all jobs and writes must be idempotent.
6. The Queue consumer reads eligible sources from D1, builds a source-linked summary, and publishes it only if its starting source revision still matches the current revision. If another member changed a fact during summarization, discard the stale result and retry. Summary failure leaves the direct notes and ledger usable.
7. R2 stores original voice blobs under plan 010's retention rule. A transcript is stored in D1 and can become a cited source; no summary should depend on R2 audio remaining available after deletion.

This yields a fast conversational path: the committed note is available on the next turn, while optional compact summaries catch up asynchronously. The Queue is a latency aid, not a second source of truth.

## Data model and migration

Do not prescribe a migration filename here. Inspect `migrations/` and allocate the next unused migration after 003A identity, 004A conversation/source, and 002 ledger; record the chosen migration and owning gate. Extend the ledger's event/projection model where memory-note events belong instead of creating a second event writer. Names below are logical targets; preserve contracts if scaffold naming differs. Every workspace-owned row has a non-null workspace ID and scoped constraints/indexes. IDs are server-generated; all instants are UTC. Use committed monotonic revisions/sequences, never UUIDs or timestamps as source watermarks.

| Table / extension | Required columns and constraints |
|---|---|
| `events` extension | Add `kind='memory_note'` in the ledger's versioned event schema, actor, `source_message_id`, logical action/step idempotency and content/scope/source. Keep provenance `stated` or `inferred`; once the member confirms a proposal, the committed fact is stated and links both proposal and confirmation. A correction/forget is another attributed ledger event, not history deletion. |
| `memory_entries` | `id`, `workspace_id`, `scope` (`workspace`, `entity`, `member_in_workspace`), nullable `subject_id` only for workspace scope, `category` (`communication_preference`, `relationship_context`, `workflow_context`, `other_context`), compact text, `status` (`active`, `superseded`, `forgotten`), `provenance`, `source_event_id`, `source_message_id`, `author_user_id`, `observed_at`, `created_at`, `superseded_by_event_id`, and `revision`. Unique source event; active entries indexed by workspace/scope/subject/category. The entry is a ledger projection and must be rebuildable. |
| `workspace_memory_revisions` | `workspace_id` primary key and integer `revision`; increment for memory note changes, relevant business state changes, chat corrections/erasure, and disputed-state changes that affect summaries. A per-scope revision table is optional if needed after measurement. |
| `memory_summaries` | Unique `(workspace_id, scope, subject_id)` (use a stable sentinel for workspace scope), summary text, source event/message IDs or a source manifest, `built_from_revision`, `format_version`, `built_at`, and optional `generation_model`. A summary is readable only if its revision is current for the sources it claims and it contains no unresolved disputed claim as a settled value. |
| `memory_refresh_jobs` | Stable job key `(workspace_id, scope, subject_id, target_revision)`, state, attempt count, next attempt, lease expiry, timestamps and error class. Insert with the source transaction. Worker/Queue retries claim by compare-and-swap and cannot publish duplicate summaries. |
| `memory_entries_fts` | FTS5 index of active note text plus an entry ID. Maintain it with tested insert/update/delete triggers or explicit transactional updates. Always join search results back to `memory_entries` and filter by authenticated `workspace_id` and `status='active'`; the FTS index itself is never the tenant boundary. |

Reuse the ledger's guarded atomic command transaction and monotonic source revision where suitable. Memory events/entries must not use an alternate writer that bypasses membership/source/revision/fence checks. Event, entry projection, FTS maintenance and refresh outbox must commit together or fail. Verify local D1 rollback on a deliberately failing late statement. Do not put raw voice bytes or provider keys in a memory table, Queue message or activity log.

## Promotion and authority rules

The agent may propose a note only for information likely to matter beyond this turn. Direct instructions such as “Remember that I prefer concise replies” qualify. A clear durable statement such as “Keep replies short from now on” qualifies as that member's preference in this workspace; store it under `member_in_workspace`, not as a workspace-wide preference. A one-off request (“Answer this one briefly”) stays in the current chat. Ambiguous or inferred preferences require one clarifying question before promotion. Forwarded customer text, quoted instructions, model guesses and tool output never become standing memory by themselves. Test examples, do not rely on prompt prose alone.

Forgetting marks the memory inactive and writes a suppression reference to its source message/event and concept. Context retrieval must not resurrect the preference from an old transcript excerpt or summary. The member is told that the standing memory is forgotten while the original chat remains visible until separate erasure is requested.

Typed state wins over prose. Owner/membership, provider choice, brief time, task due dates and entity fields go through their existing typed tools and audit path. `remember_context` cannot alter permissions, create a task, promise a deliverable, or override model/tool policy. Business facts already represented by entity fields should not be duplicated as free-form memory notes. If the user says “We quoted 3,500, actually 3,600,” update or dispute the ledger field and invalidate relevant summaries; do not leave two competing active memory notes.

All notes have human-readable provenance: who said it, which chat/message or event supports it, when it was observed, and whether it was directly stated or confirmed after clarification. On answer generation, a retrieved note is context, not a higher-priority instruction. The model must be able to answer “Why do you remember that?” with a link to the source message/event. Memory text cannot include secret provider credentials; reject or redact such proposals and keep the original chat subject to the product's normal retention controls.

## Retrieval contract for every turn

Implement `getTurnContext({workspaceId, memberId, chatId, messageId, query, tokenBudget})` in `packages/memory`. Authentication and membership validation happen before this function; it nevertheless requires the resolved workspace and parameterizes every query with it. Return a structured packet with source IDs and revision, not one flattened blob.

Read in this order: current authenticated workspace/member settings; unresolved clarification for this sender; current entity fields, disputes and tasks relevant to the message; the recent bounded transcript of the current chat; a small current workspace summary; exact entity/alias-linked notes and summaries; then FTS5 matches from active notes and, where useful, indexed prior chat excerpts. Exact entity IDs/aliases rank above fuzzy text hits. Use a token/character budget with per-section caps so retrieved history cannot displace the latest user message, the current ledger state, or tool policy. Initially expose constants such as `MAX_RECENT_TURNS`, `MAX_MEMORY_HITS`, `MAX_CONTEXT_TOKENS` and measure them on real Kerning traffic before tuning values.

For search, call a workspace-filtered SQL query that joins FTS rows to active entries. Sanitize FTS query syntax and bound query length/result count; malformed search input falls back to exact alias and recent-history lookup. Keep snippets short and include source IDs. Do not scan another workspace and filter only in JavaScript. A missing FTS index, failed summary job, or unavailable Queue must not block a reply; load direct active notes and relevant typed state from D1. Record which layers were used in `agent_runs` for debugging, without logging full sensitive context.

The context assembler must refuse to surface a summary whose source revision is stale. If a note conflicts with current typed state, the latter wins and the former is excluded or marked historical. If current state is `disputed`, present the competing sources as unresolved and ask; never select the previous confirmed value simply because it appears in old chat or summary. Treat remembered text and retrieved chats as lower-trust data in the provider prompt, with source boundaries that prevent prompt injection from changing tool authority.

## Summary refresh worker

Start with deterministic extractive summaries: current typed entity state plus a few active, source-linked memory notes and recent material events. This is easier to rebuild and audit than unconstrained model prose. A model may later improve wording only if its output remains linked to a validated source manifest and passes the agent evals. Do not invent a fact to make the summary sound smooth. Workspace summary should be a short orientation, entity summary should reflect current fields and recent interactions, and member-in-workspace summary should contain that member's durable interaction preferences and relevant work context, never preferences from another workspace.

The refresh consumer should claim a job, read sources and revision R, produce the summary, then update only if the current revision is still R. If it changed, mark the attempt stale and enqueue the newest target revision. Duplicate Queue delivery should see a published/current summary and exit. Retry transient provider or D1 errors with bounded backoff; move permanent bad-source errors to an inspectable dead-letter state while the agent continues using direct records. A scheduled Worker checks for pending/expired leases, stale summaries and missing queue deliveries. Operators need a replay command for one workspace/scope and a full projection rebuild from ledger events; replay must not send chat messages or create new business events.

Avoid storing full transcripts inside summaries. A source manifest may hold event/message IDs plus a bounded hash/revision; the source remains in D1. Do not create per-message embeddings or store a second copy of every conversation in v1.

## Correction, undo, forgetting and erasure

For an explicit correction, append the appropriate ledger event and recompute the typed projection first, then invalidate affected memory scopes in the same transaction. Undo a memory note by an inverse/forget event targeting its action ID. Undo a business event by ledger recomputation; invalidate summaries that mentioned the affected entity. If a later, independent correction superseded the target, apply the ledger's non-rollback rule rather than restoring an older value. A disputed candidate undone should trigger dispute recomputation. Never edit old chat text to make history appear consistent.

`forget_memory(id)` requires current membership and scope authorization, appends an attributed forget event, marks the note inactive, removes it from active FTS retrieval, and invalidates summaries. The response says the standing memory will not be used again and that the original message remains in chat history. The separate account/workspace erasure path in plan 013 removes or anonymizes source chats, events, derived summaries, FTS rows and retained R2 objects according to the finalized policy. A member removed from a workspace loses access to its memory immediately even if their source messages remain attributed in history.

## API and agent integration

Implement typed `search_memory(query, scope?, subject_id?, limit?)`, `get_memory(id)`, `remember_context(scope, subject_id?, category, content, source_message_id)`, and `forget_memory(id)` tool schemas. Every call receives trusted workspace/member/run IDs from the server context; do not accept these as model arguments. Validate scope/subject existence and active membership. Cap content length, result count, tool calls and total turn tokens. Return concise, source-linked tool results and action IDs so the UI's Working disclosure and per-action undo can show exactly what happened. Do not expose raw chain-of-thought; any provider-supplied reasoning summary must be distinguished from actual tool activity and must respect provider availability.

Persist `agent_runs` and activity rows before/after memory tool execution using idempotent step IDs. When a provider turn fails after a committed note, the next run must report that committed note rather than repeat it. When a member starts a new chat or switches from web to Telegram in the same workspace, the memory lookup uses the workspace ID and retains continuity while the chat transcript remains a separate thread. Telegram active-workspace routing remains governed by plan 004; memory must never guess the workspace from a business name.

## File map and execution order

Suggested modules to map to the real scaffold: memory retrieval/context/summarization, ledger-owned memory commands, agent tool binding, Queue consumer, scheduled reconciliation, eval fixtures, Worker bindings and targeted tests. Allocate migrations in gate order after inspecting the live migration directory. Plan 004A owns chats/messages/runs/clarifications; plan 002 owns business events; plan 006 owns memory projections. Plan 007 and 011 extend those models without assuming filenames.

1. Define schemas, source/revision invariant and event projection. Prove replay from events reconstructs active notes and FTS state.
2. Implement transactional note promotion, supersession, forget and refresh-job insertion. Test rollback, duplicate tool step and wrong-workspace access before connecting a model.
3. Implement bounded D1 retrieval and context packet assembly. Add FTS malformed-query fallback and stale-summary rejection.
4. Wire the Queue producer/consumer and Cron reconciliation. Test duplicate/out-of-order delivery, Worker/DO restart and source revision races.
5. Integrate agent tool schemas and activity/undo. Run the fake-provider evals, then a controlled live model smoke test using a non-production Kerning fixture workspace.
6. Integrate web and Telegram chat APIs. Verify continuity across chats and channels, attribution to the correct member, and no cross-workspace preference leakage.
7. Add export/erasure and operational replay to plan 013, then dogfood with explicit examples of remembering, correction and forgetting.

## Acceptance tests and release gate

Use the Cloudflare Workers Vitest integration or a D1-compatible test harness that exercises real SQL migrations and FTS5 behavior. Root `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` must pass once plan 001 creates them. At minimum verify: clear preference survives new chat/channel/restart; one-off preference is not promoted; ambiguous preference asks once; source link points to the right member/message; identical tool step creates one event; duplicate Queue message creates one summary; a newer write defeats an in-flight older summary; dispute never returns a settled cached claim; correction/undo removes outdated retrieval; forget removes active retrieval but preserves attributed history; member removal revokes access; same user in two workspaces gets isolated preferences; FTS syntax failure and Queue outage still allow a sourced response. Run a projection rebuild on fixtures and compare active entries and summaries, ignoring generated prose formatting.

Measure wrong durable promotions separately from answer quality. Record memory recall hit rate, source-link correctness, stale-summary rejection, wrong-workspace reads (must be zero), queue lag, and context token cost on Kerning fixtures. A model that remembers everything by over-promoting casual text fails the release gate. A model that never writes memory also fails the intended continuity test. Review examples with Avi and Hunor before loosening promotion rules.

## Platform facts to verify during implementation

Cloudflare documents D1's SQLite FTS5 support, atomic `batch()` transactions, at-least-once Queue delivery and at-least-once Durable Object alarms. Recheck the current API and limits before coding, particularly FTS migration syntax, Worker CPU/runtime limits, Queue bindings and consumer retry semantics. Primary references: [D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/), [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [Durable Object concurrency guidance](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/), and [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/).
