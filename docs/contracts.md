# Shared contracts

This file owns semantic boundaries. Executable types/validators in [packages/contracts/src](../packages/contracts/src) and tool declarations in [packages/agent/src/tools.ts](../packages/agent/src/tools.ts) own exact wire shapes. Inspect those files before changing a schema; do not copy a historical interface sketch into runtime code.

[Product](../product.md) owns intended behavior. [Status](status.md) marks partial/missing contracts and unverified acceptance. The old specification listed export routes as though they existed; they do not exist at the audited baseline.

## 1. Canonical owners

| Boundary | Source |
|---|---|
| Identity, workspace/member settings, business records, events, states, activity and acceptance | [index.ts](../packages/contracts/src/index.ts) |
| Chat route validators/DTOs, run/action/undo/question views | [chat.ts](../packages/contracts/src/chat.ts) |
| Media claim/upload/finalize and attachment bounds | [media.ts](../packages/contracts/src/media.ts) |
| Voice formats, routes, STT settings and bounds | [voice.ts](../packages/contracts/src/voice.ts) |
| Tool allowlists, arguments and provider-visible schemas | [tools.ts](../packages/agent/src/tools.ts) |
| Provider input/output/continuation | [provider types](../packages/agent/src/providers/types.ts) |
| Shared slash commands | [registry](../packages/commands/src/registry.ts), [parser](../packages/commands/src/parse.ts) |
| Actual HTTP routes and handlers | [Worker index](../apps/worker/src/index.ts), [routes](../apps/worker/src/routes) |
| Table/read projection | [agent repository](../apps/worker/src/agent/repository.ts), [lead overview](../apps/worker/src/agent/leadOverview.ts) |

## 2. Trusted scope and results

Server-created identity/workspace/source/actor/run/step/attempt context controls authority. Tool/client arguments provide permitted domain values only. Every workspace resource read/write checks scope and relevant live membership; opaque IDs alone confer no access.

Logical mutation results distinguish applied, replayed, clarification, conflict, rejection and retryable failure. A successful action includes stable receipt/resource/event/revision information. HTTP 200 is not synonymous with a completed business write; an accepted message is not a finished run.

Public errors use the existing safe error envelope/status codes. Never serialize SQL, upstream provider bodies, keys or another workspace's records. Use the implemented typed error to decide whether a retry is safe.

## 3. Identity, ordering and retry

- A web message UUID is created once per Send. Delivery retries preserve author/workspace/chat, exact payload and question/media linkage; payload reuse with different content conflicts.
- Telegram deduplication includes installation and update identity, not display name.
- Run, step and action identify logical work; attempt/fence identify current execution authority.
- Business sequence orders committed workspace events; activity cursor orders committed chat activity. Random UUID/time equality cannot define that order.
- Events keep versioned payload, actor/channel/source and stated/inferred provenance. Exactly one valid member-message/system-job source is attributable.
- Late/lost acknowledgment reconciles original IDs. A new edited message is a new operation; completed effects cannot be retried by blindly replaying its text.

## 4. Dates, disputes and memory

`TaskDue` distinguishes a local calendar date plus IANA timezone from an offset-bearing instant plus interpretation timezone, or explicit no deadline. Stored timestamps are UTC; a date-only due does not fabricate a timed notification. Missing/ambiguous deadlines/timezone ask, while clear independent facts can save.

Snooze preserves original due unless rescheduling was requested. Calendar/instant validity and permission are deterministic boundaries, not prompt promises. Runtime/schema/date validation mismatch remains open in [status](status.md).

Disputed current fields preserve candidates/history and do not present last-confirmed as current. Quotes preserve minor-unit amount/currency and offered-versus-expected role. Memory retains scope, subject, provenance/source, observation and active/forgotten/superseded status. Summary revision/suppression rules remain enforceable at every read/write.

## 5. Implemented route families

All workspace paths are under `/api/workspaces/:workspaceId`; use the source handlers for exact methods, bounds and payloads.

| Family | Implemented contract |
|---|---|
| Auth/me/workspaces/members/settings/credentials | Server identity, membership/lifecycle, typed settings, secret-safe metadata |
| Chats/messages | Author/read-only detail, bounded message pages, durable UUID acceptance, archived/title controls |
| Chat activity | Cursor pages and SSE; superseded cursor requests authoritative resync |
| Runs / batched runs | Authoritative status, steps/actions/activity and pending question; bounded batch detail avoids one request per old run |
| Run Stop | Author-scoped durable stop and best-effort actor abort; committed actions remain |
| Run Retry | Chat-author retry of a terminal failed/partial run; receipts and steps survive so the fresh attempt resumes instead of repeating |
| Actions/undo | Detail/source plus revision/dependency-checked suffix or single-action preview/commit |
| Clarifications | Scoped pending questions and explicit targeted answer acceptance |
| Commands/models/thinking | Shared supported registry, configured selection, verified effort and server confirmation |
| Media/voice | Private claim/upload/finalize, retained attachment access, transcript/STT configuration and validation |
| Telegram | Webhook/linking/scoped selection and replay-safe channel delivery |
| Export | Member-scoped JSON document and spreadsheet snapshot downloads; secrets never enter either format; unknown formats rejected |
| Workspace erasure | Owner-only audited cross-store erasure with R2 byte removal and a content-free tombstone; person-scoped rows survive with workspace pointers nulled |

Terminal failed-run Continue is not an implemented route contract. One-off reminder delivery is also not supplied by a task due date.

## 6. Composer and question answers

Ordinary messages omit `clarification_id`; that absence means ordinary conversation, even if a task is parked. A question answer includes the exact target and preserves it through all retry/reload paths. Main-composer follow-ups may steer authorized active work but cannot implicitly answer the latest pending question.

The panel submits its own draft/options against that target. Skip defers the panel; it does not resolve/cancel the durable question. A closed/stale/other-chat target fails visibly and never reroutes to another task.

Delivery state (sending/accepted/failed) is separate from run state. HTTP acceptance and activity may arrive in either order; reconcile one stable bubble. Commands that only change configuration omit ordinary chat/model-context bubbles.

## 7. Activity and provider output

Activity retains version, identity, chat/workspace/run, cursor, creation time, closed type and validated safe payload. Committed activity must persist before publication and enforce current authority. Transient `text_preview` frames are non-authoritative, replace by round/sequence and do not become a second durable transcript.

Thinking carries actual allowlisted provider text and block/round/mode/state metadata. Append versus snapshot semantics follow the adapter, not string overlap. Keep one nested disclosure, honest interrupted/truncated state and bounded retained/pending content. Unknown legacy payloads remain identifiable; never expose provider protocol/signatures or invent a trace.

Exact call IDs/arguments/results and original relevant messages survive every tool round/restart. Linked Gemini continuation and stateless Go replay differ; selected image sources must survive both correctly. Provider cache/continuation IDs do not replace canonical context.

Current publication/revocation/catch-up gaps are recorded in status rather than silently declared implemented by this target contract.

## 8. General read/table contract

Tables are ordinary flexible Markdown output from saved, supplied or conversational information. No fixed columns are imposed across domains. Reads stay scoped and bounded; use kind/entity/status/assignee/date/text/attachment filters supported by the actual resource.

`lead_overview` is an efficient lead-specific read with full-filtered counts, paged rows and a cursor. It does not define the general table capability or supply every requested business field. Supplement it from other reads; distinguish page coverage, unknowns/disputes and recommendations. Copy uses actual rendered cells.

## 9. Compatibility and change

The selected [editable-information plan](../plans/editable-records.md) proposes records references/typed values, list/page reads, immutable Save chunks, actor-bound receipt groups and persisted draft-aware agent patches. These are **not implemented contracts** at this planning baseline. Add their canonical shared types, routes, forward migration/replay and compatibility tests together; existing core record/source/authority/date/dispute/Undo semantics continue to apply.

Append forward migrations; never edit an applied migration. Change types, validators, public serializers, tests and affected clients together. Version changed event meaning/provider checkpoints; a legacy checkpoint resumes faithfully or fails before new effects.

At every mutation/recovery boundary, verify membership, source, revision and current attempt in the same atomic batch. Zero affected rows do not establish rollback. Test actual D1 failures and receipt replay; don't duplicate authority in the browser.

No new schema/service is implied by this documentation cleanup. Open fields such as per-message language, richer entity timeline and reminder/export ownership require their own coherent implementation and evidence.
