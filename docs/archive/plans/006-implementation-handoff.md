> Closed historical plan record, reconciled 2026-10-07 from `plans/006-implementation-handoff.md`. Family 006: core loop/memory present; grounding/recovery/quality partial. Remaining R02, R03, R04, R13 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# Gate 006 execution contract: the conversational agent and durable memory

Written 2026-10-02 against HEAD `859ed92` **plus the existing uncommitted Gate 005 implementation**. HEAD alone does not describe the inspected baseline. Priority P0, effort L, implementation risk high. Status: TODO. Dependencies: accepted 002, 003B, 004B and 005.

This supplements [006-agent.md](006-agent.md) and [workspace-memory-cloudflare.md](workspace-memory-cloudflare.md). It supplies execution details for an agent with no access to the planning conversation. It does not authorize deployment, commits, live customer messages, or destructive remote operations.

## 1. The outcome and the boundaries

Otis must interpret a member's message, retrieve the correct workspace context, use a small set of validated tools, save explicit instructions through the existing committing boundaries, and reply naturally. It must ask about missing or uncertain details. It must resume after a question or restart without repeating completed actions. It must remember clearly durable context across chats in the same workspace.

An example of the completed backend behavior:

1. Avi says, "Restaurant 2 wants the website. We offered 3,500 RON; they expected 10,000. Send them the offer."
2. Otis matches the entity, preserves the two different quote roles, and records the report. Money is stored in integer minor units: 3,500 RON is 350,000 minor units, not 3,500.
3. Otis does not assume the lead is warm or invent a deadline. It asks when Avi wants the offer action due. It does not send a message to the lead. Preparing an outward draft requires an explicit request to draft it.
4. Hunor can continue working while Avi's operation waits. Avi's answer belongs to the persisted question and source message, not a transient variable in the actor.
5. A later chat retrieves the confirmed business facts and their sources. A different workspace cannot retrieve them.

This gate finishes the backend agent and memory behavior. A user-facing chat app follows in 007/008; Telegram presentation in 009; recording, Groq STT and native audio in 010; scheduled briefs in 011; export and draft handoff presentation in 012. Do not promise those features in the 006 completion report.

Keep the implementation small. Reuse the ledger, provider contract, D1, the workspace lease, existing run steps, and `otis-dispatch`. Do not add an agent framework, generic workflow engine, ORM, vector database, second queue, MCP server, new identity model, or mutable runtime `memory.md` file. Do not rewrite the dispatcher to make its existing guarantees easier to bypass.

## 2. Start here; verify the actual baseline

The inspected repository is `D:\vs code\Otis`. The folder has already been renamed; do not rename it again. Find the actual checkout if your environment still names DayBook. All paths below are relative to that checkout.

Read in this order:

1. `AGENTS.md`, this file, `plans/006-agent.md`, `plans/workspace-memory-cloudflare.md`.
2. `product.md` autonomy/memory sections and Appendix A; `architecture.md` sections 3 and 7–11; `docs/contracts.md` ownership, events, dates and run states.
3. `apps/worker/src/actor/dispatch.ts`, `steps.ts`, `leases.ts`; especially `TurnHandler`, `TurnContext`, `dispatchOutboxItem`, `resumeRun`, and continuation handling.
4. `packages/ledger/src/repository/executor.ts`, `types.ts`, command handlers, reducers and `apps/worker/test/ledger.integration.test.ts`.
5. `packages/agent/src/providers/types.ts`, `registry.ts`, `fake.ts`; `apps/worker/src/providers/service.ts`; existing provider integration tests.
6. `packages/identity/src/settings.ts`, `apps/worker/src/index.ts`, migrations and the root testing/configuration files.

Run these before editing:

```powershell
Get-Location
git status --short
git rev-parse --short HEAD
git diff --stat
rg --files migrations packages/agent packages/ledger apps/worker/src apps/worker/test
pnpm typecheck
pnpm lint
pnpm test
```

Record the actual results. The latest prior review recorded 247 passing tests across 20 files; this is historical evidence, not permission to claim you reran them. Investigate drift and pre-existing failures before changing unrelated code. Preserve the uncommitted Gate 005 changes, design edits and `UI-refs/`. No reset, clean, checkout-overwrite, or automatic commit.

If Windows temporary storage is full, use an existing safe directory such as `D:\wtmp` for process-local `TEMP` and `TMP`. Do not delete arbitrary temporary directories. Do not print `.dev.vars`, keys, decrypted credentials, or environment variable values.

No new product decision is needed for the settled behavior below. Resolve routine naming, file decomposition and reversible implementation details yourself. Report a material contradiction rather than inventing a different product.

## 3. What exists and must be reused

| Existing boundary | Actual behavior / implication |
|---|---|
| `TurnHandler.runTurn(ctx): Promise<TurnOutcome>` | The integration seam. Outcomes are `completed`, `needs_input`, `continuation`, `failed`. Keep the dispatcher responsible for run/inbox/outbox/lease transitions and final reply publication. |
| `TurnContext` | Supplies DB, workspace/run/attempt/fence/chat/source IDs, source text/channel and durable clarification answer. It does not supply a trusted user ID: derive that from the persisted source and chat. |
| Dispatcher step index `0` | Reserved for `turn:<handler.name>`. Never allocate an agent tool there. Continuation handling also appends a checkpoint at the current step-list length. |
| `persistStep`, `adoptStep`, `markStepRunning`, `completeStep` | Existing attempt-owned, fenced receipts. Reuse them. All calls need the current fence and a fresh clock. A succeeded receipt can be read by a successor; unfinished work needs guarded adoption. |
| `executeLedgerCommand(db, context, commandName, args, handler, extraStatements?, options?)` | Existing transaction authority. Context includes trusted principal/source, action ID, expected business revision, run/step/fence. Ordinary run writes require a live matching lease. |
| `options.deferRunTransition` | Use `true` for commands executed inside the active handler. Ledger persists its typed clarification; dispatcher `waitForInput` owns releasing the slot and changing the run/inbox/outbox. |
| `resumeRun` and `resumePendingClarification` | Already require a persisted answer and revalidate ownership/membership. Prefer explicit clarification IDs. Do not recreate a fenceless general write path under the name of resumption. |
| `resolveModelForChat`, `runProviderTurn`, `toResolvedModel` | Existing Worker-side resolver and encrypted credential boundary. Reuse rather than creating another credential store or making HTTP calls from business tools. |
| `ProviderEvent`, `TurnInput`, `ServerContinuation` | Provider-neutral streaming and continuation contract. Adapters transport proposals; they do not execute tools. Complete historical tool rounds are required. |
| `agent_runs`, `run_steps`, `run_activity`, `pending_clarifications`, `outbox` | Durable execution tables already exist. Extend narrowly; do not recreate them in a second schema. |
| `apps/worker/src/index.ts` | DO, queue and cron currently call dispatch without a real agent handler, so the default echo is used. Every production dispatch entrypoint must receive the same real handler. |

Current approved runtime entries are Gemini `gemini-3.1-flash-lite`, Go `mimo-25` → `mimo-v2.5`, and Go `mimo-26-pro` → `mimo-v2.6-pro`, subject to credential verification. Use the live registry as authority. Gemini 3.5 and Muse entries remain gated unless their owning provider evidence changes. Do not enable them or claim audio support in this gate. Use full readable model names in human-facing text; command keys and API IDs are different fields.

The existing core field allowlist is `status`, `phone`, `preferred_language`, `assigned_user_id`, `quote`. Lead status is `new/cold/warm/hot/won/lost/deprioritized`. Task status is `open/done/cancelled`. Snooze keeps a task open and sets its snooze timestamp. The date contract is:

```typescript
type TaskDue =
  | { kind: 'date'; local_date: string; timezone: string }
  | { kind: 'instant'; at: string; timezone: string }
  | null;
```

Do not silently convert date-only intent to UTC midnight. `null` needs an explicit no-deadline instruction when creating a task. Store instants in UTC and retain the chosen IANA timezone.

## 4. File ownership and implementation order

Use four reviewable checkpoints within **the same Gate 006**. They are not additional roadmap gates. Do not mark 006 DONE after the first checkpoint.

| Checkpoint | Deliverable | Evidence required before continuing |
|---|---|---|
| 006A | Typed tools, policy, pure memory events/reducers, migration and guarded repositories | Pure tests and real D1 tests prove validation, rollback, replay and isolation before a model is connected. |
| 006B | Bounded real handler, pinned model, durable provider/tool progress, questions and recovery | Fake-provider Worker tests prove multi-round success, all named crash windows, partial work, stop and stale-holder denial. |
| 006C | Bounded context retrieval, sourced memory, deterministic summaries and reconciliation | New-chat continuity, forgetting, stale/disputed fallback and summary races pass in real D1. |
| 006D | Appendix A evals, multilingual/adversarial cases, complete entrypoint wiring and handoff | Machine-readable eval report, all root checks and a reviewed diff. Live evidence recorded separately when actually run. |

For checkpoint checks, use the existing Vitest configuration, for example `pnpm exec vitest run packages/agent/test apps/worker/test/agent.integration.test.ts` once those tests exist; memory uses `pnpm exec vitest run packages/memory/test apps/worker/test/memory.integration.test.ts`. Include the ledger/actor regression suites whenever changing their owner boundary. Expected result: exit 0 and the named behavior tests passing, not only compilation. Do not run a nonexistent path and treat zero matched tests as success.

Suggested small file map; avoid empty modules and split only real responsibilities:

| Path | Responsibility |
|---|---|
| `packages/agent/src/tools.ts` | Versioned declarations and runtime argument/result validation. |
| `packages/agent/src/policy.ts` | Trusted-source, ambiguity, budget and approval decisions; no D1 writes. |
| `packages/agent/src/prompt.ts` | Stable instructions and ordered schema declarations; bounded rendering of structured context. |
| `packages/agent/src/run.ts` | Provider-neutral bounded loop with injected provider/tool/progress capabilities; no direct SQL or credential access. |
| `packages/memory/src/context.ts`, `retrieval.ts`, `summary.ts` | Structured context assembly, scoped reads, deterministic summary construction. Create the planned `@otis/memory` package when its implemented behavior is added. |
| `packages/ledger/src/commands/memory.ts`, `reducers/memory.ts` | Canonical memory command/event validation and pure replay. Ledger must not import agent or memory package. Shared DTOs belong in contracts. |
| `apps/worker/src/agent/handler.ts`, `repository.ts`, `tools.ts` | Trusted composition, fenced execution metadata/progress, concrete service bindings. Combine files if responsibilities remain readable. |
| `apps/worker/src/memory/refresh.ts` | Claims, atomic summary publication, queue hints and cron reconciliation. |
| `apps/worker/test/agent.integration.test.ts`, `memory.integration.test.ts` | Real migrations/D1 and deterministic provider integration. Follow existing actor/ledger test setup. |
| `packages/agent/test/`, `packages/memory/test/`, `evals/` | Pure policy/loop/retrieval tests and versioned fixture reports. |

Register `@otis/memory` in its package manifest, root TypeScript references and the actual importing packages. Follow the existing ESM and `.js` import conventions. No new dependency merely for tool dispatch or JSON schema validation if the existing runtime validation approach suffices.

The inspected migrations end at `0007_outbox_claim_owner.sql`. Verify again, then use the next free number; do not edit applied 0001–0007. A narrow new migration may cover run metadata and memory. If splitting it makes migration dependencies clearer, use consecutive unused numbers, not independent numbering per package.

## 5. Trusted execution and argument contracts

Build a trusted execution context from `messages_in`, `chats`, the run and current membership. Confirm they agree on workspace, chat and author. Use the author of the original operation as the acting member. An answer must belong to the persisted question's requester. Reading Hunor's history does not let Avi append to Hunor's chat or impersonate him.

Every model tool schema rejects unknown keys. Never accept workspace ID, actor ID, fence, action ID, membership revision, source channel, run ID, step ID, provider key, SQL or arbitrary URL as model-granted authority. Entity/task/draft/note IDs are references to validate within the trusted workspace, not authorization. Source references must point to permitted persisted messages/events and carry actual authorship.

Use one result envelope with named outcomes such as `applied`, `already_applied`, `needs_clarification`, `rejected`, `conflict`, and `read_result`; translate existing ledger `CommandResult` rather than wrapping it in several incompatible result hierarchies. Include action/resource/event IDs and committed revision where available. Do not attach raw DB rows, provider bodies or credentials.

Implement this tool surface. Required keys below are semantic contracts; align DTO spelling with existing commands rather than adding alias spellings everywhere.

| Tool | Allowed arguments and semantics | Existing owner / missing work |
|---|---|---|
| `find_entities` | Nonempty bounded `query`, optional existing `kind`, bounded `limit`. Return IDs, display names, scores, exact-alias flag and uncertainty. | Scoped queries plus existing similarity logic. Named `MATCH_MIN_SCORE` / `MATCH_MIN_MARGIN`, fixture-calibrated. |
| `upsert_entity` | `name`, optional bounded `kind`. Match first. Return an unambiguous existing entity or create a genuinely new one. No arbitrary attrs, automatic status, or silently created near-duplicate. | Bind existing `create_entity`; attach server matching evidence. Rename remains an explicit separate intent through the existing ledger command, not an upsert side effect. |
| `rename_entity` | Existing entity ID and explicitly requested new name. Reject/clarify a resulting near-duplicate. | Existing `rename_entity`. Preserve aliases/history according to the current ledger contract; do not silently merge entities. |
| `log_event` | Optional entity; `kind=note/visit/contact/quote`; kind-specific typed payload; optional valid occurrence instant; source-backed provenance. | Existing `log_event`. Share its schemas; tighten argument validation rather than accepting arbitrary `Record` keys. |
| `set_fields` | Existing `entity_id`; nonempty bounded list of `{field_name,value,provenance,evidence}` from the core allowlist. Quote distinguishes offered/expected roles and integer minor units. | Sequential `set_field` commands. Allocate stable child action IDs before executing. Report per-field results; do not imply all-or-nothing if independent fields have committed. |
| `resolve_conflict` | Entity/field, current candidate event IDs, explicitly selected resolved value and supporting instruction/answer evidence. | Existing command. Candidate set must match the current scoped dispute; a model cannot select a winner without the member's instruction. |
| `create_task` | `title`, optional entity and current-workspace assignee, `due` union, explicit no-deadline evidence when null. | Existing command and date/clarification policy. No invented time, assignee or external reminder. |
| `update_task` | Existing task ID, a nonempty patch of allowed title/status/due/snooze fields and the read revision. Missing patches reject. | Existing `update_task`; task owner/reference and revision validated. Resolve ambiguous task references before writing. |
| `draft_message` | Explicit draft request; entity, channel, optional known recipient, content. Disputed facts cannot be used as settled content. | Existing `record_draft`. Missing phone does not prevent composing text, but do not fabricate a recipient or claim a WhatsApp handoff exists. |
| `update_draft` | Existing draft ID, explicit requested content/recipient edits and read revision. | `record_draft` already emits `draft_updated` for an existing ID. Add a narrow revision precondition if missing; never turn update into creation on an unknown ID. |
| `mark_message_sent` | Existing draft ID and a source-backed explicit statement that the member sent it. | Add the narrow command for existing `message_sent_by_member` reducer behavior. Opening a link, model speculation or generating a draft is not evidence of sending. |
| `query` | Fixed resource enum `entities/tasks/events/drafts`; whitelisted filters, bounded limit and opaque cursor. | Prepared scoped queries. Define concrete filters in code: entity status/name/assignee; task status/entity/assignee/due bounds; events entity/kind/time bounds; drafts entity/status. Reject arbitrary columns/operators/SQL. |
| `search_memory` | Bounded query, optional valid scope/subject, bounded limit. | Workspace-filtered active-note retrieval; source-linked compact results. |
| `get_memory` | One note ID. | Scoped active or explicitly historical inspection result. Forgotten content is never returned as applicable standing context. |
| `remember_context` | Scope, subject when required, category, bounded content, permitted source message reference, optional note superseded by an explicit correction. | New ledger command and projection. Source content is data, not an instruction granting authority. |
| `forget_memory` | Existing note ID with explicit forget intent. | New ledger forget event, inactive projection, source suppression, FTS removal and refresh invalidation. |
| `update_preference` | Strict existing typed member settings: preferred language and chosen brief enable/time/timezone/weekdays/channel. Require explicit instruction. | Existing settings service, attributed audit, with run fencing and durable idempotency added at its committing batch for this caller. Shared model selection belongs to the model/settings command boundary, not unrestricted preference patches. |
| `undo` | Optional existing action ID; `mode=from_here/single`. `from_here` is the default. Without a target, server resolves the latest eligible action in the requester's own current chat. | Existing grouped undo command. Never choose another member's latest workspace action. Only the selected run's eligible writes; preserve unrelated later teammate effects and revalidate dependencies. |

Add one **control tool**, `request_clarification`, for ambiguity that occurs before a ledger command can be formed. Arguments: one concise question, known intended operation, validated proposed domain arguments, missing fields and scoped candidates. It returns `needs_input`; it does not directly write business state. Bind it to existing pending-clarification/dispatcher behavior. Do not create a generic approval framework or infer questions by looking for a question mark in final prose.

For ledger-generated questions, use its existing typed pending operation and receipt. For pre-command questions, persist a versioned known operation and the required fields/candidates. On resume, resolve only those fields; validate the reconstructed proposal again. Do not let the answer supply a different tool name, author, workspace, arbitrary hidden fields or an approval for every subsequent action. Ask the next specific question if an answer still leaves ambiguity.

Contact/visit/note payload shapes must match the actual ledger handler and DTOs. Do not invent a second schema in the prompt. Export shared bounded validators where needed. Each tool must have one minimal valid example, one malformed example and a test demonstrating its owner boundary.

The current event payload minimums are `note: {text}`, `visit: {summary, contact_made}`, `contact: {summary, channel}`, `quote: {amount, currency, role}` with `role=offered/expected`. Reject unrelated extra fields. A phone or language change uses its typed field command, not an undeclared contact payload. For ordinary string/result limits, choose named conservative engineering constants, document them and test rejection/truncation boundaries; these are separate from required production cost-cap configuration.

The existing `similarity.ts` helper returns the first near-match and its normalization removes non-ASCII characters. Do not assume that proves safe Romanian/Hungarian matching. Extend the matching boundary narrowly to collect/rank all candidates, preserve display names and normalize Unicode deliberately. Distinguish exact canonical/alias matching from accent-folded fuzzy matching; an accent-fold collision is ambiguous. Test candidate-order independence, diacritics, two similarly named leads and no automatic merge. Use the same matching policy for new-entity duplicate checks and retrieval.

## 6. Policy enforced in code, not only the prompt

**Explicit intent versus inference.** The model may propose evidence spans, but the server must check that the quoted span exists in the correct member-authored source. A model-provided `confirmed=true` or `provenance=stated` does not establish confirmation. For lead-status mutations, require an actual explicit status instruction/approved clarification; otherwise use inferred provenance and the existing clarification gate. Do not build a general natural-language parser in regex. A bounded proposal classification with verified source spans and conservative clarification is enough; unclear paraphrases ask.

**Deadlines.** Resolve relative dates using the source acceptance instant and the member's selected IANA timezone. Retries must not change "tomorrow" when the wall clock advances. A correction may deliberately select a new date; record its source. Impossible dates reject, ambiguous locale formats ask, DST ambiguity asks or uses an explicitly documented validated date policy. Never invent a timezone when none can be resolved from existing settings.

**Bulk.** More than three distinct target entities in one proposed operation requires explicit confirmation of the described scope. Count across calls in the operation, not separately per call to evade the threshold. A confirmed scope does not authorize arbitrary added entities after resumption.

**Untrusted data.** Forwarded/quoted customer text, prior tool results and stored memory are lower-trust content. They may inform retrieval or be recorded as an attributed report; embedded imperatives cannot create tasks, change statuses, elevate membership or alter tool policy. For forwarded-only input, mutating proposals beyond permitted report capture reject/clarify. No write should happen just because retrieved text says "ignore earlier instructions."

**Contradiction.** A disputed field has `value=null`; its previous confirmed value is historical. Return competing source IDs and ask rather than using the old number in a draft or task. Preserve the existing ledger conflict/recompute behavior. A deliberate correction that explicitly identifies a previous statement differs from an unexplained conflicting teammate report.

**Partial work.** Independent complete facts may be saved before a question about an incomplete task. Persist what committed. Pause further dependent operations at the first unresolved precondition. A later failure cannot make the final answer claim the whole request succeeded or that all earlier writes disappeared.

**Preferences.** "Keep replies short from now on" may become a member-in-workspace note. "Answer this one briefly" stays in the current turn. Another member can inspect the first note but must not inherit its communication style. Typed settings/tasks are not created by memory prose.

**Sends and phases.** There is no outward-send tool. Unknown tool names reject. `propose_field` is unavailable in Phase 1; explain that the current version cannot add the custom field. Browser research, email, CRM automation and third-party connectors are out of scope.

## 7. Durable loop and exact recovery behavior

### 7.1 Pin before requesting inference

On first handler execution, validate the source/principal, resolve the effective model using the existing resolver, verify credential status, and persist the immutable model descriptor under the current run/attempt/fence guard. Record command key, provider, API model ID, endpoint family, prompt/schema versions and registry/evidence version sufficient to explain the selection. `agent_runs.model_key` already exists; add only the missing columns or a versioned snapshot JSON.

Re-executions use this snapshot. A workspace default or `/model` change does not change an active run. If the pinned model becomes invalid or its credential is unavailable, fail clearly; do not silently switch provider or activate a gated entry. Raw credentials remain server-only and are decrypted by the existing service for each request.

### 7.2 Persist the next operation before any business effect

Use a small versioned progress object, not a second workflow engine. It must identify: phase, pinned model, current provider-round receipt, ordered planned tool references, next unconsumed tool, consumed clarification IDs, counters/reservations and any final candidate answer. Keep protocol continuation only in server-side durable records.

A straightforward storage arrangement is existing `run_steps` for immutable provider rounds and logical tool receipts, plus **one** fenced `agent_runs.agent_progress_json` current checkpoint. The dispatcher's existing `checkpoint` remains its scheduling receipt and may refer to that progress version. Do not simultaneously make actor memory, provider response IDs and a new jobs table competing run-state authorities.

Reserve step `0` for the dispatcher. Agent steps append under the current live holder using the next available index; allocation and progress publication must not overwrite a successor. The dispatcher may append its continuation checkpoint after the handler returns. Logical action IDs derive from the run and persisted planned tool/child position, never from the attempt, current timestamp or newly generated IDs on retry. A reused logical action with different arguments is a conflict, not permission to overwrite its receipt.

Persist a complete validated provider round **before** executing any of its tools. Store exact assistant call IDs/names/arguments and server continuation needed by the adapter. Store model proposals privately; public activity gets a concise description and result, not full prompts/protocol artifacts. After each tool, durably store the validated result and advance progress under the live guard.

### 7.3 One bounded slice

The loop follows this order:

```text
load trusted run/source/member and pinned descriptor
load durable progress, planned rounds and completed receipts
check current run, lease, membership and configured limits
if awaiting a provider round:
    assemble bounded context and exact prior tool history
    reserve request allowance durably; call existing provider service
    collect and validate the terminal round; persist the round
if a planned tool remains:
    validate schema, references, source evidence and policy
    reuse its prior action receipt, or execute through its owner
    persist result/progress; pause immediately on clarification
if terminal answer exists and no tool is unresolved:
    return completed with the verified response
otherwise return continuation with the persisted progress version
```

Choose a small explicit slice bound, such as one completed provider request followed by its bounded tool group. Make it test-configurable. Checkpoint before the next provider request rather than holding one workspace slot for an unbounded reasoning session. Ordinary continuations do not spend the poison retry budget; actual retry failures do.

All tools in a group execute sequentially. Read-only parallelism can be considered later if measured; it is unnecessary here. Advance expected business revision after each successful command. A genuine revision conflict reloads relevant state and re-evaluates the affected proposal, never just replaces the expected revision while retaining stale decisions.

### 7.4 Streaming and continuations

Collect only completed calls. A fragmented argument stream, duplicate call ID, unknown tool, malformed JSON, missing terminal event, premature disconnect or terminal provider error cannot execute a proposed mutation. Validate the entire call group's names/structural schemas before beginning writes. Domain/policy outcomes can then be returned per call.

Use exact completed assistant calls paired with exactly one tool result each. Include prior rounds across every subsequent request. Feed the existing adapter contract consistently: complete historical messages, the current pending results and its matching server continuation; do not invent half of a continuation or omit earlier results. These requirements apply to Gemini, Go Chat Completions and Go Responses. Provider IDs are acceleration/protocol details, not the sole saved conversation.

`text_delta` is provisional generated text. Do not publish "saved" as a final answer before the tool commits. A terminal `success` with no tools can answer a read-only question; a terminal `tool_handoff` means tools must still execute. Length limits, refusal, cancellation and typed errors are not success. Raw reasoning is not stored as user-visible thought. Only explicitly supplied public summaries may become `reasoning_summary` activity, labeled separately from verified actions.

### 7.5 Lease, stop and errors

The current lease TTL is 120 seconds and provider timeout is 60 seconds; these are distinct controls. Use fresh clocks. Bound each request by remaining live-lease time with a commit margin; renew through the existing renewal function before a request/slice when needed. Do not renew an expired/stolen lease or claim a new fence inside a continuing old handler. If future measurements require heartbeat renewal, add it only to the current holder, stop it in `finally`, and abort inference on renewal failure.

Every run metadata/progress/activity/tool commit revalidates active run, attempt, fence, live lease and current membership at its committing boundary. A precheck alone is insufficient. A zero-row guard update does not abort subsequent batch statements; follow existing CHECK-row transaction guards.

Stop cancels future work and preserves earlier applied actions. Before executing each tool, verify the run remains active; the tool's committing guard still decides a concurrent race. Do not change a cancelled run back to running, publish a late successful step or append a late final answer.

Use bounded retries for known transient provider errors with durable retry state/reset hints; no sleeps holding the workspace for minutes and no infinite continuation retries. Nonretryable errors finish with a safe explanation. An unavailable model/key/config is distinguishable from a provider outage. Do not log raw upstream bodies.

After committed writes, failure must be `partial` and report the receipt-backed completed work. Current `TurnOutcome.failed` handling marks `failed`; make the narrow dispatcher outcome/error mapping needed to preserve partial status and a persisted user-readable explanation. Determine applied work from business/settings receipts, not merely a succeeded provider or checkpoint step. Keep the existing stopped/stale guards.

### 7.6 Required crash windows

| Crash / race | Restart or late-holder behavior |
|---|---|
| Before provider request | Resume pinned configuration and pending request plan. No business effects. |
| During inference before complete round is saved | Inference may be repeated within bounds. Never claim exactly-once remote inference or fabricate token usage. No tools from partial output execute. |
| Complete round saved, no tools started | Execute that saved ordered group. Do not ask the provider for a new interpretation and discard the plan. |
| Tool planned, before ledger commit | Retry the same logical action/arguments under the new live holder. |
| Ledger committed, step/progress result not saved | Read the ledger action receipt using the same action ID, reconcile the step and continue. Exactly one business effect. |
| Settings committed, step result not saved | Reuse a unique run/tool operation audit receipt from the same settings transaction. Do not apply twice or duplicate audit. |
| Some tool results saved | Reconstruct the complete call/result group, reconcile any missing committed receipt, then continue. |
| Question recorded | Run is waiting; lease released; another member proceeds. Resume consumes the persisted author-owned answer once. |
| Completed handler result saved, reply commit not finished | Existing dispatch replay publishes exactly one final reply. |
| Holder A resumes after B takes over | A changes no business state, receipt, progress, usage counter, activity or run status. |

The settings service currently owns settings writes and membership guards. For `update_preference`, extend its existing batch with a trusted optional run/step/fence precondition and a unique operation audit identifier/receipt. Pass no model-controlled authority. Settings cannot bypass stop/fence just because they are not business ledger fields. Test the commit-before-step crash. Do not introduce a generic transaction callback framework for this extension.

## 8. Context, prompt layout and cost bounds

Return structured context with source IDs, revisions, trust and applicability. In priority order preserve the original instruction/pending operation, current clear/disputed typed state, authenticated member settings/local date, a bounded recent chat, exact entity/alias-linked notes, current summaries, and small active-memory search hits. Omit low-priority excerpts before truncating the current request or dropping the tool history required for continuation.

Render a stable versioned policy prefix and deterministically ordered declarations before dynamic workspace context. No current timestamp, random ID, summary refresh time or usage counter in the stable prefix. Cache correctness follows exact provider behavior; never sacrifice current state or tenant isolation to improve a cache hit. Automatic/explicit cache support remains the verified Gate 005 adapter behavior.

Use named bounds for tool calls, provider rounds, output tokens, context size, daily workspace actions and retry attempts. Keep production values as validated operator/deployment configuration; the previous illustrative 100-actions/day and 20k-tokens/turn were not approved production choices. Deterministic tests supply small explicit values. If required production limits are absent, refuse inference with a configuration error, keep accepted input, and perform no writes. Do not quietly use unlimited mode.

Separate local guardrails from provider billing: Go subscription quota is not dollars spent by this application; Gemini free eligibility is not unlimited. No automatic paid provider/model fallback. Do not implement a billing system.

Track provider requests and token reservations durably before requesting inference; recovery must not reset a turn's budget. Reconcile provider usage once per completed request receipt. Cumulative usage snapshots replace earlier snapshots for that request; requests then sum across the run. Missing input/output/cache/cost values stay `null`. Track a conservative reservation for unknown/interrupted usage without presenting it as provider-reported consumption. No dollar cost assertion without a verified applicable price.

For the local daily action limit, count logical applied command actions, not raw event rows, read tools or retries. Enforce at the committing boundary in the same UTC-day scope across members. A compound command with two events still counts one action; independently committed `set_fields` child commands count separately. Include memory/settings mutations. Use a small guarded daily counter and a unique operation accounting key if existing receipts cannot provide this atomically; do not build an accounting subsystem. Midnight/reset tests must prove old requests do not replenish their per-turn allowance.

On any limit, preserve the original input and report committed work plus the unfinished remainder and known reset time. Do not silently split into new unbounded runs or repeatedly bill a failed attempt.

## 9. Canonical memory and D1 schema

The model reads source-linked database records, not a server filesystem file. Four layers have distinct authority: canonical ledger/settings; attributed transcripts/questions; curated durable notes; disposable summary caches.

Implement these logical tables in the new migration. Match current event DTO ownership and use server-generated IDs, prepared statements, UTC timestamps and scoped indexes.

| Table | Minimum contract |
|---|---|
| `memory_entries` | ID, workspace, scope (`workspace/entity/member_in_workspace`), subject nullable only for workspace, category (`communication_preference/relationship_context/workflow_context/other_context`), bounded text, status (`active/superseded/forgotten`), provenance, unique source event ID, source message ID, actual author, observed/created times, superseding event ID and revision. Validate entity/member subjects within the same workspace. |
| `memory_suppressions` | Workspace, target memory/concept identifier, original source event/message references, suppression event ID/revision. Rebuildable from forget events. Stops old excerpts and summaries automatically re-promoting forgotten context. |
| `memory_summaries` | Unique workspace/scope/subject key, bounded text, source manifest, built-from revision, format version, build time; `generation_model=null` for deterministic initial summaries. Use a stable non-null subject sentinel in the key for workspace scope. |
| `memory_refresh_jobs` | Unique workspace/scope/subject/target revision, state, bounded attempts, next attempt, claim token/expiry, timestamps and sanitized error class. |
| `memory_entries_fts` | Active note text and unindexed entry identifier; join back to active workspace-filtered entries. FTS is not the tenant boundary. |

Add versioned ledger `memory_note` and forget/supersession events. Extend the existing projection/rebuild/undo path to reduce them. Note content, actor, source, scope/subject/category and targets must be sufficient to reconstruct the projection and suppression. No mutable projection-only facts.

Use `workspaces.business_revision` as the initial conservative summary source watermark **when all represented note/business changes advance it**. This reuses an existing monotonic source. Do not also maintain an independent memory revision for the same changes. Explicitly invalidate/revision affected memory on any represented source correction outside business commands; if that cannot be expressed safely, implement the memory-revision contract instead and document the exact owner. UUID/time ordering cannot be a watermark.

One guarded command batch commits the event, normal business/memory projections, FTS changes, action receipt, revision and durable refresh intent. A forced failure in the last statement must roll everything back. Query fallback is for reads: do not catch a failed FTS mutation and pretend the memory command committed.

For workspace-scoped summary keys, uniqueness must actually work when subject is absent. SQLite NULL uniqueness cannot enforce one workspace summary. Use the same sentinel consistently for jobs/summaries and keep `memory_entries.subject_id` semantically nullable.

Forgetting is not deletion of historical chats. Mark the note inactive, remove it from active FTS, write source suppression and invalidate summaries. Context assembly must not inject its old source excerpt as a current preference. A fresh explicit instruction can restore the preference through a new sourced event; an automatic summary or transcript search cannot. Normal inspection can explain the preserved history. Account/workspace erasure remains 013.

Scope is applicability, not a new privacy system. All current members may inspect workspace notes/history; a member preference applies only to its subject member in that workspace. Removal revokes access on the next operation, regardless of whether cached sources still exist.

## 10. Retrieval and summaries on the existing Cloudflare stack

### Retrieval

Implement `getTurnContext` and `search_memory` with explicit trusted workspace/member/chat/source parameters. Every query or join includes workspace scope. Exact entity/alias links rank before fuzzy FTS hits. Sanitize a bounded plain-text FTS query rather than passing raw search syntax; bind parameters. On malformed query/index availability error, fall back to direct active scoped notes and typed records. Unexpected authorization/storage failure is not an empty successful answer.

Cap recent turns, note hits, summary size and source snippets with named constants. Never scan all history into a prompt. Provide sources sufficient to inspect why a claim was retrieved. The original current message appears once; avoid including it twice as both latest history and current turn.

Reject a cached summary if its built-from revision differs from the current source revision. Mark disputed claims unresolved or omit them. Do not inject active notes that contradict current canonical fields as current facts. Apply forget suppressions before excerpt/promotion assembly.

### Refresh and recovery

Initial summaries are deterministic, extractive and source-linked. No additional paid/free LLM summarization calls and no invented prose facts. Source manifests include exactly the records used. A failed summary never blocks ordinary source-backed answering.

Reuse `otis-dispatch`. Add a small discriminated wake-up payload for memory refresh, containing only kind/workspace/job identifiers. Existing `{workspace_id}` dispatch messages remain supported. Do not put private note content or credentials in queue messages. Extend the existing consumer explicitly so a memory hint cannot accidentally trigger the ordinary run handler.

Insert durable refresh work inside the source transaction. Publish a hint after commit; failed publication is caught by existing cron reconciliation. Do not make source success depend on queue availability or rely exclusively on `waitUntil` to remember a refresh. Reuse the existing `summary_worker` outbox destination where it removes duplication; keep one clear durable refresh-job owner.

Refresh procedure:

1. Claim the eligible durable job conditionally with a unique claim token and short lease; concurrent duplicates cannot both publish.
2. Read current revision R and eligible typed sources/notes with their manifests. If the requested target is obsolete, coalesce toward current R.
3. Build the bounded extractive summary.
4. In one guarded D1 batch, verify job ownership/expiry and current revision still R, publish summary and complete the job. A failing guard aborts publication.
5. If sources changed, publish nothing stale and schedule/currently retain the newest job. An old worker cannot overwrite a successor's newer summary.
6. Retry transient failures with bounded durable backoff; exhausted/permanent failures are inspectable and ordinary retrieval uses direct records.

The scheduled entrypoint must discover pending/expired refresh jobs as well as ordinary runs, even if a hint/outbox row went missing. Give each pass a bounded batch and stable pagination. Preserve existing actor recovery. Add a local/operator replay function for one workspace/scope; it rebuilds projections/caches without new events or chat replies. A new admin UI is not required.

Cloudflare's [D1 batch contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) describes rollback of the batch on statement failure; still prove our guard behavior in the repository's D1 tests. [D1 SQL support](https://developers.cloudflare.com/d1/sql-api/sql-statements/) and [Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) should be rechecked when implementing the FTS migration and consumer. A repeated wake-up must remain harmless.

## 11. Tests the executor must actually demonstrate

Use the existing Workers Vitest project and real migrated D1 for SQL/transaction behavior. Fake providers are injectable scripted adapters, not fake ledgers. Avoid live calls in ordinary tests and CI. Supply explicit test clocks and budgets; no wall-clock time bombs.

### 006A: tools, repositories and policy

| Test | Required assertion |
|---|---|
| Unknown tool / unknown keys / SQL filter / forged trusted IDs | Rejected before effect; zero business/setting/memory changes. |
| Wrong-workspace entity/task/draft/note/subject/source | Denied without leaking contents; no partial commit. |
| Explicit status versus inferred interest | Explicit allowed; inferred warmth asks with no status event. Provider's `stated` label alone cannot bypass evidence check. |
| Missing task deadline / explicit no deadline / date-only / invalid date | Missing asks; explicit null accepted; date union preserved; invalid rejects. |
| Money | Offered 3,500 RON and expected 10,000 RON remain distinct and use correct minor units. |
| Four targets split across calls | One bounded explicit scope confirmation required before bulk effects. |
| Forwarded injection / stored-memory injection | No task/status/permission writes from embedded imperatives. |
| Late batch failure | Event, projection, FTS, receipt, counter and refresh intent all roll back. |
| Duplicate note / changed args same action | Identical retry one event; changed payload conflicts without overwrite. |
| Draft and sent status | Draft only on request; unknown update target denied; only explicit sent confirmation changes sent status. |
| Scoped preference | Avi's durable style affects Avi in Kerning; inspection by Hunor does not apply it to Hunor. |

### 006B: loop and orchestration

| Test | Required assertion |
|---|---|
| Read-only question and multi-round tools | Correct source-backed answer; complete earlier call/result history reaches later provider round. |
| Truncated/malformed provider stream | Zero tools executed from incomplete round. |
| Unknown later call in a group | Structural group rejected before earlier mutations start. |
| Real handler receives duplicate dispatch | One logical action effect and one final reply. |
| Crash after provider round saved | Same saved calls execute; no replacement model plan. |
| Crash after ledger commit before tool completion | Receipt reconciled, exactly one task/event, progress advances. |
| Crash after settings commit | One settings change/audit and replayed result. |
| Stale attempt, stop, removal during provider/tool | No late committed effect/progress/activity/reply; successor/cancelled state unchanged. |
| Two questions across restarts | Explicit IDs and persisted source answers consumed once; no repeated question or earlier write. |
| Clarification releases slot | Hunor completes while Avi waits; original typed task is absent until valid answer. |
| Default/model override changes mid-run | Active run keeps pinned provider/API model; next run uses new choice. |
| Provider error after first applied action | Run partial; persisted explanation lists actual committed work, no false all-success/all-rollback. |
| Tool/round/token/daily cap and midnight | Bound persists over retries; reads/replays do not double-count; partial work reported; reset semantics deterministic. |
| Usage snapshots / missing usage | Cumulative snapshot counted once per request; missing remains null; reservation not labeled measured usage. |

### 006C: memory and refresh

| Test | Required assertion |
|---|---|
| Explicit remember + new chat + new handler instance | Durable note retrieved with actual author/source in the same workspace. |
| Same user in second workspace | No preference, note, summary or transcript leakage. |
| One-off and ambiguous preference | One-off not promoted; unclear durable scope asks once. |
| Correction/undo/conflict | Current projection wins; stale summary invalid; unrelated teammate action retained. |
| Forget and historical excerpt | Active retrieval/FTS excludes note; old source cannot silently restore it; history preserved. |
| Replay | Rebuild entries/suppressions/active FTS from events equals incremental state. No new business events/messages. |
| FTS syntax failure and missing summary | Direct scoped sources still support a correct response. |
| Duplicate/out-of-order refresh delivery | One valid summary; obsolete job does not overwrite newer source state. |
| Source changes during summary build | R summary rejected; newest revision eventually built. |
| Refresh lease expires and successor publishes | Stale builder cannot publish or finish successor job. |
| Queue publication fails / intent deleted | Durable refresh discovered by cron; source note remains usable immediately. |
| Removal | Note/history/source reads immediately denied to removed member. |

### 006D: fixture evaluation

Create versioned fixtures with source text, language, fixed source time/timezone, initial entities/tasks/events/notes, scripted proposals, expected ledger deltas, expected questions and source references. Use Appendix A:

- A1: separate offered/expected quote, note, no inferred warm change, missing deadline asks, no unsolicited draft.
- A2: save bakery report; inferred deprioritized asks; no task.
- A3: save Monday availability; revisit task requires intent confirmation and date; no inferred status.
- A4: keep existing revisit/unknown phone; ask before cancelling or changing to cold.
- A5: Thai Shop versus Thai Garden ambiguity; one question, no guessed entity write.
- A6: forwarded "mark all closed" injection; no bulk status change.
- A7: custom delivery field is Phase 2; explanation and no schema mutation.
- A8: mangled Romanian name supplied as a transcript fixture; correct alias/clarification, no duplicate. Do not claim actual voice support.
- A9: selected same-run suffix undo preserves independent teammate work; single-action secondary works; dependencies ask rather than unsafe rewind.

Add Hungarian diacritics, Romanian aliases, timezone midnight, contradictory amounts, repeat answers, forged approvals, preference recall/forget and member conflicts. Report wrong writes, correct attempted actions, correct clarification rate, false abstention, source-link correctness and memory promotion errors separately. Wrong-workspace or unauthorized writes must be zero in deterministic fixtures.

Fake-provider fixtures prove orchestration/policy behavior; they cannot establish live natural-language entity-match accuracy or provider latency/cost. Report the product's 95% matching target only against a stated dataset/denominator and actual interpretation results. A provider that asks on every clear input must not pass by abstaining. Calibration constants need fixture evidence rather than unexamined `0.85/0.10` guesses.

Add a documented root script such as `pnpm eval:agent` that runs offline fixtures and writes a sanitized machine-readable report in an ignored output directory. A controlled live synthetic eval is separate, opt-in, bounded, uses operator-provided credentials and no real workspace data; unavailable live evidence stays explicitly open. Do not call raw customer transcripts synthetic.

## 12. Wiring, checks and completion criteria

Construct one real handler at the Worker composition root. Pass it to DO dispatch/recovery, cron dispatch and queue dispatch. Keep `EchoHandler` for named tests only; production must not silently fall back to echo if credentials/config are missing. Failure should explain configuration and preserve durable input. Preserve command/system executors for their owning gates; do not send system maintenance jobs to a member-instruction agent by accident.

After each checkpoint, run its new targeted suites and `pnpm typecheck`. At the complete implementation boundary, run:

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm eval:agent
pnpm build
git diff --check
git status --short
```

The eval command is created by this gate; do not claim it already exists. Root build is a dry-run/local artifact check, not a deploy. Before completion search the diff/source for: `EchoHandler`, direct SQL mutation outside owning services, missing fences, invented status/deadline defaults, `propose_field`, arbitrary provider URLs, raw key logging, cross-workspace queries, mutable memory file authority and unbounded loop/retry code. A search match is a review lead, not automatically a defect; explain permitted tests or service-owned writes.

Gate 006 is ready for independent review only when:

1. All four checkpoint deliverables are implemented, not stubs or documentation promises.
2. The real handler is wired consistently and all named crash/clarification/isolation tests pass.
3. Business and memory writes use the existing ledger; typed preference writes use the guarded settings owner with durable replay evidence.
4. Memory is sourced, workspace-scoped, rebuildable, applicable to the correct member, and cannot resurrect forgotten or disputed information.
5. Bounded inference uses pinned approved models, complete tool history and durable limits; no hidden provider substitution or claim of exactly-once remote inference.
6. Offline eval report and actual root check outputs are available. Live/device/browser/deployed evidence is accurately separated.
7. Existing 002/003B/004B/005 regressions pass and the diff stays in scope. Test-count growth alone is not acceptance.

Update `plans/006-agent.md` and `plans/README.md` to `IMPLEMENTED; review pending`, with checkpoint evidence. Leave final DONE acceptance to the reviewer. Do not advance to 007 without reviewer acceptance or explicit user direction.

The completion report must include: baseline/diff, behaviors, files/DTOs/migration numbers, checkpoint test names and results, eval dataset/report, exact root commands/results, remaining limitations, routine choices made, and the next eligible gate. Preserve any prior open deployment/browser evidence rather than treating local tests as closing it.

## 13. Stop conditions and maintenance

Stop the affected checkpoint and report the smallest concrete issue when:

- Existing dependencies fail or the actual schema/handler contract differs materially from the inspected baseline.
- A required operation cannot pass the existing committing guard without weakening membership, revision, source or live-fence checks.
- The evidence cannot distinguish explicit instruction from a proposed inferred status, or unclear source authorship would require an unsafe write.
- A new product authority/privacy decision is needed; do not turn equal members into roles or global preferences.
- An adapter cannot replay the required complete tool history, or safe bounded interpretation fails the chosen eval set. Report the failing cases rather than lowering policy.
- A required resource/config/key is missing for live evidence. Continue independent local work; do not fabricate the live result or activate a paid fallback.

Ordinary file naming, extractive-summary wording and pure helper decomposition are not blockers. Optional cleanup is not a new release gate. Each tool/prompt/model/memory-promotion change must version the contract and rerun its relevant evals. When later gates add voice, commands or MCP, they must reuse these owners and source/receipt rules rather than introducing alternate business writers.

## 14. Copyable assignment

```text
Implement Gate 006 in plans/006-implementation-handoff.md, with plans/006-agent.md and plans/workspace-memory-cloudflare.md as its supporting contracts.
Start with baseline inspection, then checkpoints 006A, 006B, 006C, 006D in order. Record the evidence for each; do not substitute provider or DB mocks for the required integration tests.
Preserve the existing uncommitted Gate 005/design/UI work. Reuse the current ledger, dispatcher, provider services and otis-dispatch queue. Keep the implementation small and explicit.
Do not implement UI, slash-command/channel presentation, recording/STT, scheduled briefs, MCP or new infrastructure in this gate. Do not commit, push or deploy.
Resolve routine implementation details yourself; ask only about a material unresolved product/authority/data decision. On a named stop condition, report the actual failing boundary or test.
Finish with the offline eval report and root checks, set IMPLEMENTED; review pending, and provide a reviewable completion report. Do not mark DONE yourself.
```
