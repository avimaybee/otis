# Shared implementation contracts

Revised 2026-09-30. Implement these as versioned runtime schemas in `packages/contracts`; TypeScript types alone do not validate incoming JSON. [Architecture](../architecture.md) defines enforcement. [Product](../product.md) defines intent. This file names the cross-package agreements so agents do not invent incompatible interfaces.

## 1. Trusted context and result types

Every workspace service accepts a server-created `WorkspaceContext` containing workspace ID, actor kind/user ID, current membership revision, source message/job ID, request ID and, for mutating execution, run/step/fence IDs. Model arguments and client JSON cannot set those fields. Expose no `executeSql` tool or unrestricted patch object.

Results use a discriminated union: `applied`, `already_applied`, `needs_clarification`, `conflict`, `rejected`, `retryable_failure`. Successful mutation results include stable action ID, affected resource IDs, event IDs, committed revision and safe before/after summary. An HTTP 200 alone is not a business success.

HTTP errors have `{error:{code,message,retryable,request_id,details?}}`; safe details may include valid choices and reset time, never keys, SQL or another workspace's existence. Use 401 for no valid session, 403 for known forbidden operation, 404 for out-of-scope resource lookups, 409 for conflicting idempotency/preconditions, 413 for payload limits, 422 for invalid fields and 429 for a typed capacity limit. Authentication endpoints and resource APIs must consistently apply this distinction.

## 2. IDs, ordering and provenance

- IDs are opaque stable strings. Web client message IDs are UUIDs generated once per Send.
- Dedupe transport key: `(channel, external_id)`. Telegram external ID includes bot installation and update ID; web UUID collisions still require owner/chat/payload equality before returning an existing result.
- `action_id` identifies a committed logical command, not a retry attempt. One tool step can produce multiple events under that action.
- `attempt_id` and monotonically increasing `fence` identify the current execution lease. Retries do not create new logical actions for already persisted steps.
- Events have committed per-workspace sequence; activity has committed per-chat cursor. Neither orders by a random UUID.
- All stored instants use UTC ISO 8601 or one documented integer unit consistently; names ending `_at` are instants. Local dates are explicitly named `*_local_date`, formatted YYYY-MM-DD. Never parse locale date strings as database keys.
- Event actor kind is `member` or `system`; a member actor has a real user ID, a system actor has a named job identity. `channel` is always present: `web`, `telegram` or `system` in v1. Exactly one of `source_message_id` / `source_job_id` is non-null; system-originated events use `channel='system'` and a durable job source, never a fake member/chat message.
- Provenance is `stated` or `inferred`; member confirmation of a proposed inference becomes `stated` with a link to proposal and confirmation. Public inference never silently becomes a commitment.

## 3. Canonical states

| Record | State values and meaning |
|---|---|
| Lead status | `new`, `cold`, `warm`, `hot`, `won`, `lost`, `deprioritized`; 'closed' asks won or lost |
| Current field | `clear`, `disputed`; disputed value null, candidates preserved |
| Task status | `open`, `done`, `cancelled`; snooze is an instant on an open task |
| Inbound processing | `unrouted`, `queued`, `processing`, `waiting_for_input`, `processed`, `unsupported`, `failed`, `cancelled` |
| Run status | `queued`, `running`, `waiting_for_input`, `succeeded`, `partial`, `failed`, `cancelled` |
| Run executor kind | `agent`, `command`, `system`; `agent_runs` may retain its historical table name but kind distinguishes non-model work |
| Step | `planned`, `running`, `succeeded`, `failed`, `skipped`; undo is an additional receipt/reference, not erased success history |
| Clarification | `pending`, `resolved`, `cancelled`, `superseded`; no silent expiry that loses a promised request |
| Delivery | `pending`, `sending`, `delivered`, `failed_known`, `outcome_unknown`, `cancelled` |
| Memory entry | `active`, `superseded`, `forgotten`; original history retained except erasure |
| Draft | `draft`, `member_confirmed_sent`, `archived`; revisions remain in events |
| Media | `local` (client only), `quarantine`, `validated`, `transcribing`, `ready`, `rejected`, `expired`, `deleted` |
| Provider availability | `unverified`, `available`, `invalid_credential`, `unavailable`, `retired` |

Do not conflate a local bubble with accepted input, a processed command with a model run, an answer with delivered Telegram output, or a failed run with rolled-back writes.

## 4. Task dates and missing details

Use a typed due value:

```ts
type TaskDue =
  | { kind: 'date'; local_date: string; timezone: string }
  | { kind: 'instant'; at: string; timezone: string }
  | null;
```

'Friday' is a date in the member's timezone, not an invented midnight/noon reminder. 'Friday at 15:00' becomes a verified UTC instant with its interpretation timezone retained. Code resolves explicit relative expressions against source time and validates dates; model interpretation may propose the expression, but cannot bypass validity or timezone rules.

**Missing deadline: ask.** 'Send Bistro the offer' permits retaining the request and known facts, but does not assign today. Keep the proposed action in durable clarification until a date is supplied, or the member explicitly says no deadline. Only explicit no-deadline produces `due=null`. A date-only task can appear in the chosen daily brief; it does not automatically create a timed notification.

'Remind me Friday' also needs enough schedule context. A previously explicit member preference for reminder time can resolve it, with that basis visible in the reply. Otherwise ask what time. 'Later', competing date interpretations, nonexistent local times and missing timezone context require a concise question when they affect the action. For explicitly recurring daily schedules, use the documented DST policy instead of asking every seasonal transition.

Snooze means hide notification until the explicit instant; it preserves the task's original due value unless the member also requests rescheduling. 'Move to Friday' changes due; 'don't remind me until Friday afternoon' changes notification timing, with exact time clarified if needed.

## 5. Business and memory fields

Phase 1 core fields: entity name/kind, status, phone, preferred language and assigned member. Quotes are structured events containing amount in integer minor units, ISO currency, role (`offered` or `expected`) and source; projected price fields must preserve currency and distinct meanings. Availability such as 'manager there Mondays' is sourced context, not a commitment.

Next step and due derive from tasks. Last contact derives from confirmed contact events, member-confirmed sent drafts or visits with `contact_made=true`; ordinary notes/unsent drafts do not advance it. No custom-field creation tool in v1. A new entity may receive the neutral initial status `new`; changing an existing lead's status from inferred sentiment requires confirmation.

Core event kinds: `entity_created`, `entity_renamed`, `alias_added`, `note`, `visit`, `contact`, `quote`, `status_change`, `field_change`, `task_created`, `task_updated`, `task_done`, `task_cancelled`, `draft_created`, `draft_updated`, `message_sent_by_member`, `conflict_resolved`, `memory_note`, `memory_forgotten`, `revert`. Reserve `sheet_edit` for later synchronization, never emit it from an XLSX download. Version every payload; reducer exhaustiveness is tested.

Memory scopes: `workspace`, `entity`, `member_in_workspace`. Categories: communication preference, relationship context, workflow context and other explicitly durable context. Typed business facts must use their typed fields/events. Personal preference has a member subject even though current teammates can inspect its source. Memory cannot change authorization, tool policy or schedules.

## 6. Table ownership and minimal keys

| Owner | Tables / constraints |
|---|---|
| Identity | `users` unique Firebase UID; `workspaces`; `workspace_users` unique pair; `membership_audit`; hashed `sessions`, `invites`, `link_codes`; `provider_credentials` unique workspace/provider; shared/member settings |
| Inbox/conversation | `chats`; `chat_messages`; `messages_in`; `system_jobs`; `agent_runs`; `run_steps`; `run_activity`; `pending_clarifications`; `outbox`; workspace execution lease/order |
| Ledger | `entities`; workspace-scoped `entity_aliases`; `events`; `action_receipts`; `entity_state`; `tasks`; draft projections; `field_defs` reserved but no custom seeds; business revision |
| Memory | `memory_entries` projection written by ledger; FTS and summary projection maintenance; `memory_summaries`; refresh jobs; source/suppression revisions |
| Media/export | Workspace/member/source-linked media metadata, upload claims, export jobs and private object refs |
| Scheduler | `brief_schedules`; `briefs`; brief item references; reminder/delivery jobs, with business task writes via ledger |

Chats minimally contain author, workspace, title, model override, creation and activity timestamps, and optional archive marker. V1 archiving only hides a chat from default navigation; do not implement destructive chat deletion that strands sources. Chat messages contain author kind/user, channel, inbound source, content blocks, accepted time and execution reference. Corrections append a new turn; they do not rewrite history.

Clarifications include requester/chat, original source and run, intended typed operation, missing fields, candidates, source revision and visible question. Multiple questions can exist across chats; match answers to their own chat/request context. A later unrelated message does not automatically answer an older question. If ambiguous, ask which request the answer concerns.

Run checkpoints include provider/model/prompt/schema versions, normalized conversation/tool continuation, next step sequence, committed action references, budget usage and attempt/fence. Protect provider-only protocol blobs from transcript/export exposure.

## 7. HTTP route contract

All paths below are proposed implementation names, frozen when `packages/contracts` ships. Change the shared schema and clients together, never ad hoc in one channel. All `:workspaceId` routes enforce membership and resource ownership.

| Method / route | Contract |
|---|---|
| `GET /api/health` | Safe process health only, no binding/secret data |
| `POST /api/auth/session` | Exchange verified Firebase ID token for session; CSRF/origin rules tested |
| `DELETE /api/auth/session` | Revoke current session and clear cookie |
| `GET /api/me` | Identity and current workspace memberships |
| `GET /api/workspaces/:workspaceId/chats` | Cursor pagination; mine/team filters only, no privilege difference |
| `POST /api/workspaces/:workspaceId/chats` | Create author's chat; idempotent creation key |
| `GET .../chats/:chatId/messages` | Paged content, stable IDs and permissions |
| `POST .../chats/:chatId/messages` | `{client_message_id,text?,media_id?,image_media_ids?}`; 202 stable message/run IDs after durable commit. Text may be empty when media is attached; at most 4 finalized still images per message, each validated, owned and unexpired at commit, linked atomically as receipts |
| `GET .../chats/:chatId/activity?after=` | SSE with chat cursor; same records available as catch-up JSON |
| `GET .../runs/:runId` | Authoritative run/partial result and actions |
| `GET .../runs?ids=a,b` | Same run-detail shapes in request order, unknown ids omitted; at most one transcript page (50). Snapshot and older-page loads use this instead of one request per run |
| `POST .../runs/:runId/stop` | Author-scoped stop request, explicit idempotency key |
| `GET .../actions/:actionId` | Safe detail, original source, undo state |
| `POST .../actions/:actionId/undo-preview` | Mode `from_here` or `single`; selected IDs/effects/dependencies and revision |
| `POST .../actions/:actionId/undo` | Mode, preview revision and client operation ID; revalidate and apply atomically |
| `POST .../clarifications/:id/reply` | Optional choice shortcut; ordinary message replies always work |
| `GET .../commands` | Enabled command registry for that surface/workspace |
| `GET .../models?chat_id=` | Approved configured choices and current/default selection |
| `POST .../media/uploads` / upload / finalize | Bounded claim, bytes, validation; no public R2 object. Voice notes (audio/webm, audio/mp4, audio/ogg) route to transcription; still images (image/jpeg, image/png, image/webp, 5 MiB each) are prompt attachments with no transcription intent. Magic bytes and bounds re-verified server-side; renamed or oversized bytes reject with 422 |
| `GET .../media/:mediaId` | Authenticated private streaming/range access |
| `POST .../exports` | Idempotent consistent snapshot job |
| `GET .../exports/:id/download` | Authenticated membership plus expiring download ticket |
| workspace/member/provider settings routes | Typed schema, lifecycle authorization, CSRF and audit; no arbitrary JSON patch |

The ordinary composer is always the main business input. An action button uses the same authenticated service, not a weaker privileged endpoint. A teammate can undo shared actions but cannot stop/append to another author's conversation as if they were its author; a shared action cancellation requiring intervention goes through their own attributed chat.

## 8. Activity envelope

```ts
type PublicActivity = {
  schema_version: 1;
  id: string;
  cursor: number;
  workspace_id: string;
  chat_id: string;
  run_id: string;
  created_at: string;
  type: string; // closed discriminated union in code
  payload: unknown; // validated per event type
};
```

Allowed event types: `message_accepted`, `queued`, `run_started`, `text_chunk`, `step_started`, `step_finished`, `action_applied`, `reasoning_summary`, `clarification_required`, `partial_failure`, `answer_saved`, `run_finished`, `action_reverted`. Heartbeats are ephemeral and have no business meaning. A reasoning-summary payload records provider attribution and displayable text, never private prompt content.

### Thinking stream target (additive, not yet implementation evidence)

Reuse `reasoning_summary` and the existing authorized public-activity store/SSE/catch-up path. Its historical event name is not proof that every provider's displayable reasoning is a summary. Add typed optional payload fields alongside the existing `provider`, `text` and `round_index`:

| Field | Required meaning for newly emitted Thinking records |
|---|---|
| `block_id` | Stable server/provider-derived identity within a run/round; one block may span many activity records |
| `content_kind` | `summary` or `provider_reasoning`; adapter sets it from the actual documented response channel |
| `mode` | `append` for text deltas, `snapshot` for a provider's cumulative replacement; never guess from overlapping text |
| `state` | `streaming`, `complete`, `interrupted` or `truncated`; terminal status may be a final metadata-only record |

The existing envelope supplies run, chat, workspace, durable cursor and record identity. Do not add a second sequence store, transcript table or provider-payload passthrough. A reducer deduplicates activity records by ID/cursor, applies them in cursor order to `(run_id, round_index, block_id)`, appends deltas or replaces that block's snapshot, and groups blocks into one Thinking disclosure per run. Text equality is not a dedupe key: two distinct deltas may legitimately contain the same words. An old payload lacking block/mode metadata remains a separately identified legacy summary; do not blindly join old summaries when their semantics are unknown. Existing readers continue to accept older activity data; coordinate new types, serializers, handler and web reducer together.

Only allowlisted displayable text and this metadata cross the public boundary. Never expose whole provider events, encrypted signatures, hidden prompts, raw request payloads, keys or tool internals. Bound individual records, aggregate retained characters and pending buffers. Batch small deltas with a bounded latency flush and final flush, not one D1 write per token or a silent fixed event-count cutoff. Persist through the existing fenced publication owner before broadcasting. Stop/lost authority never permits a late stale writer; retained partial content can derive interruption from the durable run terminal state if its final flush was no longer authorized. Hitting the display cap emits a single truncation indication and does not stop the answer/tool loop.

Request public output only using verified parameters for the exact selected model/endpoint and within existing run budgets. Thinking-effort controls and reasoning-token accounting do not establish public-output support. If no displayable stream exists, omit Thinking; no model substitution, higher effort or synthetic summary call. Retention/access/erasure are those of existing public chat activity, including authorized teammate history. Provider output here is inspection text and never a source of business authority or a separate canonical memory.

Google documents incremental `thought_summary` deltas separately from opaque `thought_signature` state; signatures cannot be rendered. This demonstrates an endpoint mechanism, not support for every configured Gemini model. Go adapter mappings need independent endpoint-specific evidence before enabling. See [Google's thinking documentation](https://ai.google.dev/gemini-api/docs/thinking) and the [008B implementation guidance](../plans/008-ui-implementation-handoff.md#thinking-inside-working).

Persist before publishing. Reconnect uses a chat cursor; client duplicate suppression is by ID/cursor, not body text. A superseded cursor receives `resync_required` and authoritative transcript fetch. Redact sensitive tool result fields with an allowlist serializer rather than deleting only known secret key names.

## 9. Shared command grammar

Recognize an exact supported first non-space `/name`, optional Telegram `@thisbot`, followed by arguments. Unknown commands answer help without a model run; a middle-of-sentence slash is plain text; `//` escapes the leading slash. One parser, registry and command executor serve both channels.

| Command | Meaning |
|---|---|
| `/model` | Show current chat/default and approved configured keys |
| `/model <key>` / `default` | Set/clear this chat's override for later ordered runs |
| `/workspace [name]` | Inspect/switch explicit surface-specific selection |
| `/today` | Saved brief/current due work on demand; no schedule needed and no duplicate notification |
| `/undo [target]` | Latest own-chat reversible action or resolved target; same undo contract |
| `/sheet` | Fresh private XLSX snapshot link, available only after plan 012 |
| `/help` | Short commands and natural-language examples |
| `/start <code>` | Telegram-only one-use account link; never web picker |

Commands keep attributed durable acceptance/audit/results. Web configuration operations use the existing command route with control presentation: no ordinary member/assistant chat bubbles and no LLM turn. Telegram may return a concise native acknowledgment. `/model` results describe the effective model and usable voice route; unsupported/missing-key models are not silently substituted. Workspace switching records its origin scope in audit without moving historical messages. Incomplete web picker selections collect arguments; complete selections apply directly. `//` remains literal text through the shared parser. See design.md section 8.

## 10. Agent tools

Tool schemas expose domain fields only. The server injects identity/scope/source/fence. Implement strict schemas with unknown-key rejection, bounded strings/result limits, real enums and UTC/local-date unions. Read and write tools are distinct capabilities; trigger policies determine which are available.

| Tool | Required boundary |
|---|---|
| `find_entities` | Bounded name/alias query, scores with source; no auto-merge |
| `upsert_entity` | kind/name only; confident exact match or explicit create; near duplicate asks |
| `log_event` | Closed allowed kinds and kind-specific data; cannot forge admin/revert events |
| `set_fields` | Core allowlist; explicit values or member-confirmed proposal; no inferred lead-status mutation |
| `create_task` | Title/entity/assignee and typed due; missing due asks unless explicit no deadline |
| `update_task` | Explicit done/cancel/reschedule/snooze with preconditions |
| `draft_message`, `update_draft` | Member-requested draft, grounded facts and language; no send API |
| `mark_message_sent` | Explicit member confirmation, source and idempotency |
| `query` | Whitelisted filters and bounded rows; no SQL or arbitrary where/order clauses |
| `search_memory`, `get_memory` | Workspace-filtered active context plus source IDs |
| `remember_context`, `forget_memory` | Durable stated context; source/scope validation and suppression on forget |
| `update_preference` | Own member settings or explicitly allowed shared settings; no credentials/membership |
| `undo` | Explicit target/mode, receipt-driven dependency preview and commit |
| `request_clarification` | Persist typed pending operation and release processing slot |

Do not expose `propose_field`, outbound send, browser automation, billing, erasure or membership management to the v1 model. General conversation can explain how to open the relevant setting; it cannot smuggle a lifecycle write through memory.

## 11. Schedules and brief selection

Schedule fields: member/workspace, `enabled=false` initially, local time nullable until chosen, IANA timezone, selected weekdays, delivery channel and revision. A null time is unconfigured, never '09:00'. A time-only request like 'every day at 8' needs AM/PM clarification if ambiguous in context. Disable/cancel preserves audit. Changing schedules never produces duplicate already-generated briefs for the same day.

Brief kind before first migration: `scheduled_daily`; on-demand answers do not create another scheduled delivery. Uniqueness `(workspace,user,local_date,kind)`. Spring-forward uses next valid local instant; fall-back first occurrence. A daily schedule may run in the evening; do not label all briefs 'morning'.

Rank groups: explicit promised deliverables due/overdue; other explicit tasks due/overdue; explicitly undated next actions; stale warm/hot leads. Within group use overdue/stale age, then stated value if comparable in the same currency, then stable entity/task ID. Never compare bare numeric deal values across currencies without a stated conversion policy. Cap five distinct items, dedupe promise/task overlap, skip snoozed/completed/cancelled items. A pending clarification is not a scheduled commitment.

Last contact has the typed definition above. Automatic stale suggestions are brief candidates, not silently created member promises; if a rule creates a system task, label its origin and stable reason key and never invent a deadline. A system suggestion that needs assignee/date asks before becoming a member commitment. Drafts are generated only on request; no automatic overnight draft sweep in v1.

## 12. Named bounds and configuration

Initial engineering bounds: text input 16,000 characters; query default 25/max 100 rows; transcript pages 50/max 100; model memory hits max 12; media duration 180 seconds; media upload max 20 MiB or the lower verified channel/provider limit; max 12 tool proposals per execution slice; bounded retries (at most 3 transient attempts before visible failure). These are configurable implementation defaults, not unmeasured performance promises.

Set workspace action/day, input/output token budgets, provider timeout and cost alarms from plan 005 measurements before real dogfood. Missing required production budgets is a startup/config validation failure, not unlimited access. Do not count retry attempts as newly applied business actions.

Status and history retention are explicit deployment policy. Audio 14 days; invalid quarantine cleaned promptly with an hourly orphan sweep; download ticket 15 minutes; generated export object 24 hours unless an operational export was explicitly requested. Do not delete canonical chats/events just to reduce token cost. Source records are paginated/retrieved, not all sent to the model.

## 13. Compatibility and change protocol

Voice route contract (2026-10-01): resolve `native`, `groq_stt`, or `unavailable` using verified exact endpoint/format capability plus current workspace credential/configuration. Keep `native_audio_supported` distinct from effective `voice_available`; `/model` can report voice available through configured STT for a text-only model. Snapshot conversation model, registry version, route kind, transcription provider/model, media identity and language hint on accepted input; revalidate media and authorization before sending bytes. Do not accept client provider URLs or credentials. Persist transcript/provider metadata and a stable logical transcription receipt before publishing readiness or dispatching the agent. Retry must not enqueue a second logical run. Routine errors never authorize a paid or different-provider fallback. Plan 010 owns media schema/credential integration; Plan 005 owns capability types/resolver interfaces. The detailed execution contract is [Groq voice routing](../plans/010-groq-stt-handoff.md).

Change schemas, fixtures, serializers and both channel clients together. Additive wire fields may be backward compatible; removed enums, changed date meaning, renamed payload fields and altered tool authorization require versioned migration and replay tests. Do not repurpose old event kinds with new semantics. An older run checkpoint must either resume with its recorded adapter/schema version or fail visibly before any new write.

Contract tests must include two workspaces, two members, conflicting IDs, duplicate requests, malformed dates, removed membership, stale revisions, lost responses, interrupted runs and provider-specific protocol continuation. No test may pass merely because the fake provider returned the exact expected prose.

Implemented route shapes (2026-10-02, gate 007). DTOs live in `packages/contracts/src/chat.ts`.

- `GET .../chats/:chatId` returns the chat plus `is_author`; `is_author: false` is the single signal a client uses for a read-only teammate transcript.
- `GET .../chats/:chatId/messages` pages ascending with `next_before_sequence`; an unparsable cursor is a 422, never a widened query.
- `GET .../chats/:chatId/activity?after=` returns `{activities, next_cursor, latest_cursor}`. A cursor beyond the chat's activity cursor is `409 cursor_superseded` with `latest_cursor`, which the client answers with an authoritative transcript fetch.
- `GET .../chats/:chatId/activity?stream=sse&after=` emits named events `activity`, `resync_required`, `membership_revoked` and `heartbeat` over the same persisted rows, revalidating session and membership between polls.
- `GET .../runs/:runId` is the authoritative run view: run, steps, action receipts, run activity and the pending clarification.
- `GET .../runs?ids=` batches the same per-run shapes with workspace-scoped `IN` reads (runs, steps, receipts, activities capped at the most recent 200 per run, pending clarifications, sources). Live single-run refreshes keep using the singular route.
- `POST .../actions/:actionId/undo` takes `mode`, `client_operation_id` and `expected_revision`, plus an optional `chat_id`. The undo's own action identity is derived from `client_operation_id`, so a retry replays the recorded receipt instead of reverting twice. An undo without `chat_id` is attributed to the requester's most recent conversation; a requester with no conversation cannot create an unattributed business event.
- `POST .../clarifications/:id/reply` requires `client_message_id` and the requesting member; the answer is durably accepted as an ordinary message before the saved typed operation resumes.
- `GET .../models?chat_id=` reports registry entries, current/default selection, voice capability separately from native audio support, and `thinking: ThinkingOptionDTO` (`state`, `current_choice_id`, `effective_choice_id`, `is_default`, `choices: [{ id, label }]`, `unavailability_reason`).
- `POST .../chats/:chatId/commands` with command `thinking`:
  - `/thinking`: Inspects effective model and returns verified choices without mutating settings.
  - `/thinking <choice>`: Validates supported choice for effective model, updates chat's `thinking_override_json`, returns attributed confirmation.
  - `/thinking default`: Clears chat's thinking override to Provider default.
  - Switching model (`/model <new>`) resets any incompatible thinking override to Provider default and notes it in the command reply.
- Agent tool `set_chat_thinking`: Exposes the same validated settings owner conversationally.
- Accepted runs snapshot `thinking_snapshot_json` at acceptance for immutable run execution across queue delay, tool rounds, crashes, and clarification replies.


## Frontend message/control boundary (2026-10-03)

This specifies required client behavior and coordinated additions, not new fields already implemented. Read live packages/contracts types before changing schemas.

- Existing ChatMessage.client_message_id and AcceptMessageResponse.message_id/run_id/acceptance_sequence reconcile one locally optimistic input. Keep its visible identity stable through HTTP/stream order inversion. Local sending/saved/failed are delivery states, not agent_runs statuses. Saved means known durable acceptance, not tool completion.
- Local outbox/drafts carry account/workspace/chat scope, one client UUID, immutable submitted payload, clarification linkage, local time, retry metadata and authoritative mapping once known. Retry delivery sends exactly that original UUID/payload. Editing submitted failed input is a new UUID. Existing payload fingerprint checks remain mandatory.
- Follow-up sends use the server's accepted mode (new_run, steer or clarification) and actual scope. The UI may not reassign a reply to a different pending question or change an active run's pinned provider configuration.
- Web control commands use the deterministic command route and existing presentation control boundary. Keep audit/attribution/idempotency; omit normal chat/model-context messages. Output commands still return a readable result. Settings mutation success means authoritative commit, not an optimistic selected label.
- Per-message language is a required presentation addition where missing. Current ChatMessage at the inspected baseline has no language field. Add its nullable/source-aware representation through storage, serializers, public types and clients together if necessary; old content uses an honest fallback. Do not leak provider protocol or request another model call solely to manufacture language labels.
- Display formatting receives viewer locale and workspace timezone. Source-member timezone still interprets relative deadlines. Keep stored timestamps UTC. Client day grouping cannot use its host timezone while formatted timestamps use a different workspace zone.
- Query/router/local-storage libraries do not weaken session, membership, author, workspace, revision, fence or receipt checks. Private caches are invalidated/purged on account change, logout and revocation.

Public API changes remain owned by the relevant gate and need tests. Do not invent an execution-retry endpoint on the client, fake saved actions, persist raw credentials locally or modify domain status enums merely to match a visual pill label.
