# 014 implementation handoff — reviewer-authored live transport repair

Author: Codex reviewer, 2026-10-04. Source baseline: current uncommitted Otis tree on `663f0b3`. This document supersedes implementation-agent drafts in `014-live-transport.md`. It is an implementation specification, NOT evidence that code exists and NOT permission to begin before the reviewer explicitly assigns a checkpoint.

## 1. Outcome and boundaries

An open chat receives pushed activity and incremental answer/public Thinking previews. Merely leaving it open performs zero D1 writes and no 500ms database polling. Intermediate provider output performs zero D1 writes. Accepted input, logical actions, questions, completed answers, terminal states and bounded completed public Thinking remain durable. Reconnect and missed final notification recover actual committed facts. No fabricated Working steps or hidden model prompts/reasoning.

Keep existing Cloudflare Worker, SQLite-backed WorkspaceActor, D1, Queue and R2. No Redis/KV event log, new service, agent framework, ORM, paid fallback, new roles, dashboard, visual redesign, dependency upgrade or concurrency rewrite. Workspace lease policy remains in force for this transport task. Preserve all unrelated dirty files. No commit/push/deploy or real external messages.

## 2. Actual current source facts — do not assume draft claims

- `apps/worker/src/index.ts`: WorkspaceActor exists but production queue/cron call dispatch/recovery directly. Actor currently trusts body.workspace_id without checking stub identity.
- `apps/worker/src/dispatchHint.ts`: actual immediate wake helper location. Queue is a hint; accepted work is durable before send.
- `apps/worker/src/agent/activity.ts`: every published preview currently performs a guard/cursor/activity batch.
- `apps/worker/src/agent/handler.ts` + `streamPublish.ts`: text and public Thinking buffer/flush during provider iteration. Default maxRoundsPerSlice is 2, not a guarantee of a particular wall time. Lease TTL is 120 seconds; renewal occurs after handler completion, not a streaming heartbeat.
- `routes/activity.ts`, `chat/stream.ts`, `chat/activity.ts`: current SSE polls D1, plus existing authenticated JSON catch-up.
- `apps/web/src/hooks/useActivityStream.ts`, `api/snapshot.ts`, `api/transcript.ts`, `ConversationScreen.tsx`: existing durable merge/snapshot/render owners. Keep a single production message/composer.
- PublicActivityType includes run_started, but current source does not publish that type at dispatch pin. Do not bootstrap preview generation from a nonexistent emitted event.
- `completeRun` persists an authoritative final text_chunk plus run_finished and chat_messages in its guarded batch. Preserve compatibility; do not assume answer_saved is actually the current completion implementation.

Read these owners, contracts and the relevant tests before editing. Routine function/file decomposition is implementation work; architectural choices below are fixed.

## 3. Execution and publication ownership

All production dispatch/recovery calls go through the named workspace actor. Queue and cron invoke one bounded actor action per existing workspace slice; retain the current dispatch functions, receipts, checkpoints, source ownership, lease claims/fencing and recovery semantics. Test-only direct calls remain supported without pretending they provide live transport.

Bind every actor request: namespace.idFromName(workspaceId).toString() must equal state.id.toString(). Reject mismatch before any D1 operation. Persist validated workspace identity once in actor storage, never allow a later request to change it. Use the existing class; extract small live-feed helpers if useful.

Add a narrow optional live-output sink to the existing dispatch/TurnContext boundary. Actor supplies it; production previews without this actor sink are skipped (never silently fall back to preview D1 persistence). Durable publication still uses existing fenced committing boundaries. Claim/start supplies run_id, chat_id, attempt_id, fence, and actual lease_expires_at. Clear preview ownership on failed pin, terminal outcome, checkpoint, clarification, lease expiry, recovery and Stop. Provider I/O must not be wrapped in blockConcurrencyWhile: subscriptions and control requests must interleave while it waits.

Every preview batch checks actual local ownership, attempt/fence, current time before claim expiry, and the cancellation/member gate. No D1/RPC per token or preview batch. Do not invent renewal or extend a lease only in memory. Business effects still require the original transactional D1 checks.

## 4. Subscription endpoint and identity

Add GET `/api/workspaces/:workspaceId/chats/:chatId/live` for native WebSocket upgrades. Keep authenticated JSON activity and snapshot routes. Production frontend moves to this endpoint; it must not also keep an SSE subscription/poll loop alive.

Worker validates exact same Origin as request origin, valid websocket upgrade, existing HttpOnly session, current workspace membership and chat-in-workspace. Missing/mismatched Origin is denied for this browser endpoint. Do not put tokens in URLs. Rebuild internal actor request fields from verified server values; ignore/remove client-supplied identity headers. No public arbitrary actor-action proxy.

Use state.acceptWebSocket and socket attachments, not socket.accept. Attach only `{session_id, user_id, workspace_id, chat_id, session_expires_at}` plus bounded delivery bookkeeping. No raw token, token hash, API key, credential ciphertext or provider request. Reconstruct attachments through getWebSockets on every wake; malformed/out-of-scope/expired attachments close before content delivery. Author and teammate can subscribe to allowed workspace chats; existing author-only append restrictions remain.

## 5. Fixed bounds and alarm economics

Named constants for dogfood:
- MAX_WORKSPACE_SOCKETS = 64.
- MAX_SUBSCRIBED_CHATS = 32.
- MAX_PREVIEW_TEXT_CHARS = 65_536 per current attempt; final answer is separately authoritative and must not be truncated by this display bound.
- MAX_PREVIEW_THINKING_CHARS = 24_000 across the logical run; MAX_THINKING_BLOCKS = 32. Preserve/reconstruct consumed budget across slice checkpoints; do not reset the logical-run cap on each slice. Overflow gets an honest truncated state.
- MAX_WIRE_FRAME_BYTES = 256 KiB UTF-8; reject malformed/oversized inbound frames before parsing expensive bodies. Outbound reset fits this bound or splits through explicit bounded frames, never truncates arbitrary JSON.
- MAX_SYNC_BUFFER_EVENTS = 200; MAX_SYNC_BUFFER_BYTES = 512 KiB. Either overflow discards the attempt to merge and requests a fresh sync. No unbounded array.
- AUTH_REPAIR_ALARM_MS = 60_000, only while at least one socket is attached. No perpetual setInterval for idle tabs/actor. Delete alarm when last socket closes. DO alarm/storage cost is separate from D1 and is not claimed zero.

Alarm uses at most TWO batched D1 reads per pass: (1) sessions joined with workspace membership for at most 64 distinct attached session IDs, validating returned user identity/expiry/revocation; (2) scoped chats for at most 32 distinct chat IDs and durable activity cursors. Prepared IN parameter lists stay below D1 bind limits. No per-socket/per-user queries, no session touching. Actual D1 rows read depend on indexes; measure them.

One subscribed actor's alarm SQL statement bound is 2 * 1,440 = 2,880/day if continuously connected; 1/2/10 tabs in that actor share this pass. This is a STATEMENT bound, not row or monetary measurement. No alarm/D1 work when zero sockets. Test the exact counts with a controlled clock. Alarm is also the lost-final-notification repair trigger, not just authentication.

Track each socket's last NOTIFIED durable cursor in its attachment (not a client-controlled authority value). When alarm sees a newer durable cursor, send a durable-changed frame even if no new user activity ever arrives. If hibernation reset/lost bookkeeping is uncertain, send a bounded sync-required frame. This repairs final-commit-before-broadcast crashes within one scheduled pass. Healthy normal commits notify immediately; the alarm is a failure backstop.

## 6. Protocol — two different sequence spaces

Add explicit discriminated DTOs in the existing contracts package and a small validating decoder. Every frame has v:1 and chat_id. Only native server socket messages can initialize/advance run generations.

Server frames:
- `ready`: chat_id and current durable_cursor. No claim that this is a caught-up frontend.
- `durable-changed`: chat_id, durable_cursor. Notification only; client fetches authenticated durable pages. May coalesce to the greatest cursor; never per-token durable activity.
- `preview-start`: run_id, attempt_id, fence, lease_expires_at, preview_sequence:0. Emitted only after live claim/pin and required durable step receipt. This is ephemeral generation initialization, not a durable activity cursor.
- `preview-delta`: same generation, increasing preview_sequence, round_index, kind (`text` or `thinking`), mode (`append` or provider-verified `snapshot`), text, and block_id/provider/content_kind/state for Thinking as appropriate. Include snapshot mode honestly; do not turn provider replacements into appends.
- `preview-reset`: same generation, sequence at which full snapshot was captured, bounded current text and ordered Thinking blocks `{block_id, round_index, provider, content_kind, text, state}`. Includes overflow/truncated state. Replace exactly; never concatenate reset with missing-prefix content.
- `preview-unavailable`: run_id and current known generation, or null generation; tells client to discard that transient view and rely on durable state. Do not fabricate empty complete reasoning on actor restart.
- `access-lost`/`sync-required`: small typed reason, then close if access lost.

Client frames: `preview-snapshot-request` with chat/run and last known generation/sequence; no mutation/action tools over the socket. Rate-limit snapshot requests to 1/sec/socket in actor memory; invalid frames close. No durable cursor accepted as server authority. A client cursor ahead of server requires full resync.

Client accepts a generation only from actor start/reset or current authenticated run snapshot. Ignore lower fences/older attempts; same fence plus conflicting attempt is a protocol error requiring sync. Delta requires exactly next sequence. On any gap request reset once, bound buffering and stop suffix appends. Reset does not restart the server sequence; it replaces state at its stated sequence. Final committed answer replaces preview without duplicate text. Terminal/clarification/checkpoint clears that generation.

## 7. Subscribe/catch-up ordering and completed Thinking

Establish socket and buffer FIRST. On ready, fetch bounded durable activity pages from the last APPLIED cursor, using existing authenticated routes. Apply every returned row, advancing applied cursor only to actually applied rows; latest_cursor is a watermark, not proof that all pages were applied. Drain buffered notifications, catching up to the greatest watermark. Then request/reset the active preview. On buffer overflow/resync, use authoritative snapshot; never append a suffix to a missing prefix. Cleanly close old subscriptions and cancel stale callbacks on route/workspace/logout changes.

Thinking remains one nested disclosure inside Working. During work it is ephemeral. At a slice/round boundary retain bounded completed public blocks in existing agent progress, within a logical-run combined 16,000-character historical text budget and 32-block bound; include truncated/interrupted state. At terminal/question/checkpoint persist only newly completed historical blocks in existing run_activity using stable run/round/block keys and fenced publication, before discarding buffers. No every-token record. An actor crash may lose uncheckpointed previews; committed Thinking remains reloadable. Do not promise reconstruction of output never committed.

Preserve provider normalization policy. Neither prompt text, tool protocol envelopes, keys, nor fabricated hidden thoughts enter these records. Keep 24k live versus16k history limits explicit; apply truncation deliberately before safePayload, not accidentally afterward.

## 8. Controls and outside-dispatch writes

Stop and member removal/leave must execute through scoped actor control actions calling the SAME existing stopRun/lifecycle functions. Worker routes keep authentication/CSRF; actor action rechecks existing authorization and then pauses affected preview/socket gates before awaiting the committing function. After success, cancel author run previews as applicable and close removed member sockets; after a definite rejected operation restore gates only after confirming still authorized. On an uncertain failure fail closed and require reconnect. Unauthorized Stop must not interfere with another author's run. Do not rewrite lifecycle SQL or add a second business mutation path.

Logout: revoke the session using the existing identity function, invalidate that session's attached sockets in each known workspace actor, and return success only after awaited invalidation attempts succeed. If an actor is unavailable, return honest retryable failure, clear the cookie as appropriate, and rely on the bounded alarm to close old sockets; do not claim immediate success. Other sessions of the same user remain valid. Catch-up HTTP always revalidates D1, regardless of socket cache.

Membership/Stop controls must stay responsive while provider I/O waits. Test no preview/content after a SUCCESSFUL control response, including paused provider races and actor restart. Alarm revalidation covers missed operator-side changes; document its <=60s scheduled pass bound separately.

Accepted messages, config commands, Undo and clarification resolution may still commit outside dispatch. After successful commit issue one scoped actor notify(chat_id) call; actor reads the real cursor, never trusts a client-provided payload. Use existing request context for best-effort post-commit notification; failed hint does not turn an already-saved input into loss. Alarm repairs a missed notification. Log sanitized failures. Durable in-dispatch publications notify through the local sink immediately after their batch. Never broadcast an uncommitted question/action/final reply.

Queue hints stay immediate and retry-safe; cron stays recovery backstop. Queue consumer calls actor dispatch; cron calls actor recover+dispatch. Preserve continuation wake and follow-up steering; zero listeners must not prevent runs from completing.

## 9. Staged implementation commands and proof

014A — actor venue/scope/control seam only:
- Validate actor identity; consolidate production queue/cron entrypoints; pass claim expiry and optional live sink; establish Stop/member control routing without changing guard SQL.
- Tests: scope mismatch no writes, queue/cron invoke proper actor, duplicate dispatch/lease races unchanged, Stop and clarification behavior, dispatch promptness, no-listener completion. Keep existing transport functional during this local checkpoint.
- STOP for independent review. Do not implement 014B from filename order alone.

014B — server live feed and transient/durable split:
- Endpoint/hibernation/attachments, bounded alarm, protocol, actor fanout, preview authority, completed Thinking and outside-dispatch notifications; no preview D1 fallback.
- Real workerd tests: Origin/auth/workspace/chat rejection; two-member fanout; hibernation reconstitution; logout/removal/expiry; lost FINAL notification with no later activity; stale takeover/expired claim/Stop no output; zero intermediate-preview writes over 60s and20-round simulations; 1/2/10 idle tabs zero writes and exact alarm query bound; overflow and malformedframes. Inject clocks without actual minute-long test sleeps.
- STOP for independent review. Do not call server-only work a usable web feature.

014C — production client integration:
- Replace EventSource with native WebSocket; integrate bounded sync/preview reducer into existing snapshot/render owners; no second Composer/Transcript.
- Tests: between-subscribe-and-catchup event, multiple catch-up pages, final loss repair, partial preview reconnect/reset, older attempt dropped, Thinking snapshots replace, final no duplicates, old route callbacks ignored, send/follow-up/commands/Retry/offline behavior unchanged.
- Native browser verify approved layout and stream behavior at360/390/900/1280/1440. No Playwright. Synthetic API evidence distinguished from actual Worker/socket evidence. Device claims require devices.

For each assigned checkpoint run targeted tests then `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` (dry-run only), `git diff --check`. TEMP/TMP=D:\wtmp if necessary. Inspect actual exit codes, report correct test counts. Measure D1 metadata for successful operations; .first() read metadata unavailable; thrown batch cost unavailable. Include all durable/index overhead in scenario totals. No universal $0, sub10ms, or local-tests-prove-production claim.

## 10. Platform references and stopping conditions

Primary documentation verified2026-10-04:
- https://developers.cloudflare.com/workers/platform/limits/ — Free general external subrequests50 versus internal services1,000; not a single interchangeable limit.
- https://developers.cloudflare.com/d1/platform/limits/ — D1-specific invocation/query limits are separate. Count actual queries and preserve continuation margin; no perflush RPC design.
- https://developers.cloudflare.com/durable-objects/platform/limits/ — CPU versus network wait/wall time, Free SQLite support.
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/ — hibernating API and attachment restoration.

Before implementation map scenario request/query counts. If the existing two-round slice exceeds platform budgets even without previews, report measured call counts and the narrow checkpoint change required; do not silently redesign the ledger or lower functionality. If runtime lacks necessary hibernating API, report exact diagnostic; no dependency/cloud migration without reviewer command. If any rule cannot be met within this boundary, show the failing source/test and stop that checkpoint for reviewer decision. Do not ask the user to settle routine code organization.

## Responsibility

Reviewer owns architecture, priorities, handoff instructions and acceptance. Implementation agent owns assigned code/tests and a factual completion report. It may identify a contradiction or suggest a local change, but cannot replace the plan, mark its own work independently accepted, or start another checkpoint without reviewer command.
