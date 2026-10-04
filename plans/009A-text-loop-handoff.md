# 009A — reviewer-authored Telegram text capture, reply and retrieval

Author: Codex reviewer, 2026-10-04. Baseline: current uncommitted Otis tree on `663f0b3`, including independently accepted 015A.1. This is one checkpoint inside existing plan 009. Read `013-dogfood-execution-order.md`, this file, relevant contracts and actual source before editing. The reviewer assigns this checkpoint explicitly; never start 009B/010/014 automatically after it.

User-requested guided linking: [009A-telegram-linking-ux.md](009A-telegram-linking-ux.md) now governs account connection/disconnection, status and exact easy flow. It replaces the minimal connection-row instructions below where needed. Keep the text reply/retrieval task; do not reduce 009A to linking only.

## 1. The result to build

A linked Avi or Hunor sends a text to the private bot, Otis starts processing from an immediate wake hint and replies in that private chat. Explicit facts are recorded once through the existing ledger. A later text retrieves those facts through the same existing agent/query tools. A missing detail asks one question; Telegram's native Reply targets that question and resumes its saved operation. Commands change real scoped settings rather than going to the model.

Build that path with existing Worker/D1/Queue, shared agent and ledger. Do not build another assistant loop or source store. Keep workspace leases and current guards. Full web WebSocket transport, voice, scheduled briefs, XLSX, reactions, paid broadcasts, extensive callback menus, group bots and a dashboard are outside 009A. Do not add an ORM/framework/service/dependency update. No commit, push, remote migration, deployment or real external messages.

Clear complete instructions save directly. Save a clear fact while a separate missing task date is awaiting clarification. Do not infer warm/cold status or invent a deadline/time. Existing explicit no-deadline behavior remains supported. Text-only acceptance is not full 009 or voice acceptance.

## 2. Verified current source map

- `apps/worker/src/routes/inbound.ts`: authenticates the webhook secret, calls acceptTelegramInbound, returns JSON. No ExecutionContext or publishDispatchHint call currently.
- `apps/worker/src/inbox/telegram.ts`: /start redemption, routing, author chat, text acceptance and workspace_actor outbox. Raw link code is already redacted. Dedupe returns stored inbox status cast to a smaller result union, lacks stable run ID on replay; inspect and correct narrowly. Other slash commands currently become ordinary agent text. No targeted answer branch.
- `packages/channels/src/telegram.ts`: normalizer currently omits canonical destination chat/message IDs and reply-to IDs. Private chat is checked. /start is detected by startsWith, which incorrectly catches longer names.
- `packages/commands/src/parse.ts`: shared parser accepts only the literal Telegram suffix @thisbot. Actual bot username is not supplied. Fix actual configured username matching, preserve existing web/literal-escape behavior and cross-bot rejection.
- `apps/worker/src/dispatchHint.ts`: existing best-effort queue hint after durable acceptance. Reuse it; no cron as normal wake mechanism.
- `apps/worker/src/index.ts`: production queue/cron already invoke existing dispatchWorkspace; keep this topology for this checkpoint. createWorkerAgentHandler owns decrypted credentials and execution budgets.
- `apps/worker/src/actor/dispatch.ts`: completeRun writes final reply plus activity; waitForInput writes/retains pending question and releases slot; failRunTerminal records failure. None enqueues Telegram sends. Existing dispatch scans only destination workspace_actor. Existing recovery must continue ignoring Telegram sends.
- `apps/worker/src/routes/commands.ts`: executeCommand is the shared deterministic interpreter and returns effects. Its HTTP acceptance/Undo adapters are web-specific; do not fake a web session/cookie to invoke them.
- `apps/worker/src/inbox/repository.ts`: reference for current authorized acceptance, command effects and model/thinking pinning. Reuse small helpers if needed; do not replace the web acceptance path wholesale.
- `apps/worker/src/actor/dispatch.ts` resumeRun plus `clarificationFields.ts`: existing answer provenance, typed operation resumption and conservative date interpretation. Web accepts answer messages with answerRunId; Telegram needs its own attributed equivalent, not acceptWebMessage with a made-up channel.
- `migrations/0002_conversations_sources.sql`: outbox already supports destination telegram and statuses pending/sending/delivered/failed_known/outcome_unknown/cancelled. `0007` adds claimed_by. Reuse it. telegram_users currently maps identity, selected_workspace_id and active_chat_id; do not create another identity table.
- Link code consumption exists but no production link-code issuance endpoint was found in current routes. Provide the small authenticated issuer described below.
- Tests: `conversations.integration.test.ts`, `actor.integration.test.ts`, `agent.integration.test.ts`, `agent-tools.integration.test.ts`, `dispatch-promptness.integration.test.ts`; these filenames were checked against the current tree. Match real workerd D1 migration/setup conventions. The actual webhook route is `POST /api/inbound/telegram`; extend it rather than creating a duplicate webhook URL.

Suggested small owners: new Worker Telegram delivery helper, channel HTTP adapter/formatter, route for link issuer, and one Telegram text integration suite. Exact names are routine implementation choices. Scope-limited edits to the mapped owners, contracts, existing SettingsPane/client for linking, migrations only if demonstrated necessary, and affected fixtures are allowed. Preserve all unrelated dirty files, especially ledger/UI/design work.

## 3. Configuration and linking

Add Worker environment fields `TELEGRAM_BOT_TOKEN` (secret) and `TELEGRAM_BOT_USERNAME` (public bot name without @), keeping existing webhook secret and installation ID. Do not put token in VITE vars, logs, persisted payloads, URLs returned to users or reports. Production HTTP is pinned to https://api.telegram.org; test injection is a FetchFn/options seam, never a public arbitrary base-URL setting. Never log a fetched URL or raw network error that contains the token-bearing path. Do not inspect/print .dev.vars values.

Webhook route with missing required bot token must be disabled truthfully before acknowledging new conversational work; pure inbox tests may still test acceptance without transport config. Test fixtures use a clearly synthetic token and fake HTTP, never a real endpoint/key. Do not depend on globally disabling fetch in a way that hides real production wiring.

Implement `POST /api/workspaces/:workspaceId/telegram/link` using requireWorkspaceScope with csrf, current session and membership. Generate 24 random bytes as 32 unpadded base64url characters; store only SHA-256 hash bound to the trusted user, ten-minute UTC expiry and unconsumed state in existing link_codes. Return the one-time deep link `https://t.me/<configured username>?start=<code>` plus expiry; Cache-Control no-store. GET/session reads must not mint codes or write last_seen. Do not accept caller user ID. Existing consume remains atomic and hash-only. Membership changed between issuing and consuming is rechecked by routing; linking does not grant workspace access.

For actual discoverability add only a personal-account connection row to existing SettingsPane, using approved Button/Alert/link recipes: Connect Telegram -> in-place pending -> returned open link, with retryable error. Do not automatically open the external app or call Telegram during browser tests. Keep this separate from workspace-shared provider credentials; do not show another member's identity/link. No new page, styling recipe, dialog or raw code field. Add the corresponding DTO/API method and scoped UI tests/story state if changed.

Private /start confirmation may be a concise administrative response after successful redemption. Unlinked or ambiguous users get generic linking/workspace guidance, no business data. Where no workspace is resolved, the existing outbox cannot represent workspace-less sends: allow one best-effort, bounded administrative reply after persisting the unrouted/start result. No automatic retry, no model invocation, no new global outbox framework. Document this exception; duplicate updates must not repeatedly send it. Never echo the link code. Unknown administrative delivery is not claimed successful.

## 4. Inbound acceptance and commands

Normalize safe numeric update/sender/chat/message IDs, private type, bot installation, text, and optional reply_to_message.message_id. Do not invent destination from a username or selected workspace. Require a normal user sender, not another bot. Store canonical Telegram IDs in redacted raw payload or a bounded explicit metadata object for later routing. Validate before storage/use; IDs are opaque numeric strings, not SQL or arbitrary addresses. Preserve unsupported-media metadata-only handling. Exact /start token matches; /startled is not a link command. Non-message/service/group updates are ignored without model calls or reply spam.

Deduplicate on existing channel/external_id globally, verify fingerprint and recorded identity/context. Same update returns stable original IDs and cannot create another run/effect/reply; conflicting reused key is not treated as a new command. Handle the concurrent duplicate INSERT race by rereading and verifying the persisted record, not by returning 500 indefinitely. Never swallow genuine storage failures as an unrouted 200. Existing transaction guards stay first and throwing.

Ordinary text: resolve linked identity, current memberships and active author chat; one membership may auto-select, several without valid choice must ask. Persist one source/member chat message/run/activity/dispatch intent atomically. Pin effective model key and thinking request as the web acceptance does; a subsequent /model or /thinking must not change an already accepted run. No model call during acceptance. Publish the queue hint only after the commit, including matching replay when a lost earlier hint might need repair. Hint failure never rolls back accepted input.

Commands: parse with actual configured @bot suffix. /model, /thinking, /workspace, /today, /help and /undo use existing shared interpreter/ledger services. A command addressed to another bot is not executed or sent to our agent. /start stays link-only. // escapes remain ordinary text. Unknown command returns help without a provider call; /sheet remains unavailable and unadvertised as working.

Apply model/thinking effects plus command receipt/reply atomically with source acceptance and current membership/author checks. /workspace changes only this Telegram identity's selection, clears stale chat mapping and validates target membership inside the batch. Web selection and teammate chat/model remain unchanged. Before a selected workspace exists, /workspace may list the trusted user's memberships or choose an exact unambiguous one; never require a model or silently select the first.

Undo delegates to existing ledger target/dependency/revision rules with the Telegram source as provenance and a stable action ID derived from inbound ID. Do not call web routes with synthetic authentication or disable confirmation/dependency checks. Factor the shared domain operation if necessary, not a framework. Default targets the author's latest reversible action in this Otis chat and uses existing from_here semantics; repeated delivery replays its receipt. If a dependency is disputed, ask narrowly rather than rewriting teammate history. Commands need no model or active mutation lease, but their committing boundary must still guard membership and affected state.

Persist command answer/delivery as part of that guarded operation. Optional native bot command registration is not a gate blocker and must not call Telegram from CI; leave it for an explicit operator command if not already provisioned. Never advertise a feature as available merely because it is listed in the registry.

## 5. Durable outbound production

Create one small helper that builds Telegram outbox INSERT statements from a trusted inbound source + logical response. Call it inside existing final completion, question parking, command completion and user-visible terminal failure batches. No send occurs until these batches commit. Non-Telegram runs produce no Telegram deliveries.

Use deterministic delivery IDs: source/input ID + response kind/key + part index, with a stored payload version. Final uses run ID; question uses clarification ID (two questions in one run must get distinct keys); command/admin source uses inbox ID. Do not use a newly random ID for every redispatch. INSERT OR IGNORE is acceptable only for this immutable identical delivery key, not for swallowing conflicting source context. Typed payload includes trusted user/workspace/Otis chat, bot installation, private destination ID, run/source IDs, logical kind, text/part index, previous-part ID, and optional clarification ID. No credentials or private thinking payloads.

Resolve the actual pending question ID even when the ledger already persisted it and waitForInput's alreadyPending branch skips insertion. Retain one canonical clarification. Enqueue its question once in the same parking transition. A resumed question must not be resent on successful completion. Final reply text is the same content as saved chat_messages; failure text is concise and says input is retained and, when relevant, which actions actually committed. Never present internal stack traces or token paths.

Plain text is the initial Telegram format: omit parse_mode, so names/content with <>& are safe without half-escaped HTML. Split into ordered parts of at most 4000 UTF-16 code units, preferably at newline/space, never between a surrogate pair. No content truncation or new synthetic business statements. Each part has its own delivery key and previous-part dependency; stop later parts if an earlier part has unknown/failed terminal outcome. The final part of a question uses ForceReply; do not attach it to normal final answers. Do not stream/edit every model token into Telegram for this checkpoint.

## 6. Deliver, retry and recover without another engine

Add one bounded deliverTelegramOutbox helper, called after dispatch slices and from explicit Telegram delivery hints. Queue/cron must also discover pending Telegram deliveries when the run is already terminal; existing listWorkspacesNeedingRecovery only finds actor intents/nonterminal runs and is insufficient by itself. Add a small bounded Telegram-due scan, not a rewrite of recovery. Existing recoverWorkspace must not reset Telegram sending to pending.

Claim a due item with one conditional UPDATE pending -> sending, setting claimed_by, last_attempt_at and attempt_count. Check returned changes; one overlapping consumer wins. Resolve current identity/member/chat/destination again before exposing business content. Do not retarget an old delivery using a newly selected workspace or reused Telegram identity. If revoked/unlinked/mismatched, cancel without HTTP. Membership can change after check while the HTTP request is in flight; record that unavoidable external-send boundary honestly, do not promise transactional revocation of Telegram.

Use one bounded POST sendMessage with JSON, AbortController timeout 10 seconds and no credentials beyond the configured server token. A missing token is known preflight failure, not an ambiguous attempted send. Response body success must be valid, ok true, and contain a matching private chat/message ID. Persist returned bot message ID in that delivery payload for clarification routing. Success update is claim-owner scoped, never overwrites another owner/status. No transaction spans provider/Telegram I/O.

Outcome policy:
- Valid ok:true response + recorded outcome -> delivered.
- Explicit API rejection 400/403 -> failed_known terminal, no automatic resend; store sanitized reason/status. Preserve saved Otis answer.
- Explicit 429 rejection -> pending with next_retry_at respecting retry_after (minimum one second), bounded attempts. Persist retry eligibility in payload; queue wake with delayed delivery where supported, cron remains fallback. Do not hold a long sleeping Worker or spin an immediate queue loop.
- Network exception/timeout, 5xx without a trustworthy rejection, malformed/truncated response, process crash while sending, or success response followed by inability to record success -> outcome_unknown, never automatically pending. Telegram sendMessage has no implemented idempotency key here. Do not claim exactly-once outward delivery.
- Invalid persisted payload -> failed_known without HTTP and no raw payload leak.

Three attempts maximum for known retryable rejection (existing default). Never spend provider calls or replay business tools to resend a recorded answer. Older sending items with no recorded result become outcome_unknown after a bounded stale interval (30 seconds, exceeding HTTP timeout); no takeover-and-resend. A late original sender cannot change the new unknown status unless explicitly recording its own matching still-live claim before recovery has transitioned it. Tests define this behavior. Unknown outcome stays available for inspection; manual resend is a later explicit user action, not automatic recovery.

Bound delivery work to five eligible items per invocation, one private-chat send per second. Long multi-part responses progress by part dependency and delayed hint; no high-frequency D1 scheduler or polling loop. Queue body gets explicit kind telegram_delivery, workspace_id; branches must not feed delivery rows to agent dispatch. Failure to publish a hint leaves the durable row discoverable. Use no new queue/infrastructure unless a demonstrated existing binding limitation is reported first.

Dispatch continuation checkpoints must also publish another immediate hint when work remains rather than relying on cron after budget is exhausted. Avoid endless redispatch of genuine lease contention: delayed retry/backstop, bounded message attempts. Best-effort typing is optional and can be omitted from this checkpoint; no permanent timer, per-token HTTP or D1 writes merely to show typing.

## 7. Targeted clarification answers

The user replies to the delivered bot question using native Telegram Reply/ForceReply. Map that external bot message ID through this identity/workspace's delivered question outbox item to exact clarification ID, then verify current requester, original Otis chat, pending status and membership. Never trust user-supplied run/clarification IDs or the latest pending row across the workspace.

Persist the answer in messages_in and the same author chat with run_id belonging to the waiting run. Do not create a second agent run or mutate business state in acceptance. Store target clarification ID with the source/fingerprint for replay, then use existing resumeRun with explicit clarificationId, persisted messageId and server-derived author. A crash between acceptance and resume must be repaired by replay/recovery using that durable target, not lost or guessed. If resume rejects a date/detail, retain the pending question and answer source and send a concise request for the needed detail; do not mark it resolved. Exactly targeted replay of an already-used answer cannot resolve the next question.

Ordinary non-reply text is a new conversational message, not blanket consent to an old pending operation. ForceReply supplies easy targeting without a custom picker. If it explicitly replies to an obsolete/foreign question, explain that it cannot answer that question; never silently route it to a new one. Multiple pending questions require exact reply targeting. Preserve safe conservative date resolution; ISO date plus existing member timezone is sufficient for initial deterministic tests. Do not expand multilingual intent policy silently in this transport checkpoint; report reproduced limitations separately.

Unsupported media with text retains its existing explicit confirmation policy. Metadata-only unsupported input may get a concise response; no download/transcription. Voice must state it is not supported yet instead of entering a text model as opaque media.

## 8. Decisive tests, not a mock conversation disconnected from production

New real workerd/D1 integration suite, migrations through current last file, synthetic users/workspaces, fake Telegram HTTP. Test actual webhook acceptance and actual delivery entrypoint wiring. Also run a scripted fake ProviderAdapter through the real AgentHandler for tool orchestration: do not prove business memory by an EchoHandler that simply repeats input.

Required journey: linked Hunor sends an explicit synthetic Bistro fact -> immediate hint is observed -> queue/dispatch handler executes a real ledger write -> real completion batch creates delivery -> fake sendMessage sees the saved answer -> later query retrieves the stored value -> no extra events on webhook/queue replay. Keep fake model output tied to expected calls and actual tool result; assertions inspect D1 and outbound text, not just call counts. Echo is acceptable only for isolated entrypoint wiring tests.

Cover these concrete cases (combine fixtures when clearer):
1. Link issuer scope/CSRF, expiry/hash-only/32 chars; private exact /start; replay/conflict; no code/token in persisted/logged output.
2. Duplicate and simultaneous webhook acceptance creates one run/source/effect/delivery; no cron needed for ordinary wake. Storage failure returns retryable non-200, not accepted fiction.
3. Two members/two workspaces: attribution, routing ambiguity, web switch independence, remove member before dispatch/send, no wrong destination leak.
4. /help/model/thinking/workspace/today/undo apply actual operations without provider call; proper real @bot, wrong @bot ignored, /startled not redemption, // literal. Model/effort pinning survives a later command.
5. Question parking releases the slot; another member completes; native reply resumes exact typed pending task once; invalid date/old question/foreign requester/replay retain correct state. Crash after answer acceptance repairs on duplicate/recovery.
6. Durable terminal reply/outbox commits atomically: injected true-tail failure produces neither; commit followed by lost hint/restarted delivery still sends. No subscribers are needed.
7. Concurrent delivery claims cause one fake HTTP call; success ID records; 429 respects time/attempt bound; known 400/403 stops; timeout/5xx/bad JSON/crash-after-send is unknown with no second send. Later part blocked on unknown predecessor. Same persisted answer is delivered without rerunning tools.
8. Bot token missing disables conversational webhook; transport mocks cannot contact real Telegram. Exceptions/logging cannot include token or link code.
9. Long plain text/diacritics/emoji/<>& split intact and ordered, no malformed Unicode, no unapproved parse mode. Normal short reply starts delivery immediately.
10. Repeat existing D1-economics, actor/ledger/memory and web command suites: no new read-side writes, no weakening existing fences, no leaked web command chat bubbles.

Review changed source plus new tests yourself before reporting. Run root typecheck/lint/test/build and diff check once after stable edits. If SettingsPane changes, run design/story checks and scoped native-browser review at affected mobile/desktop widths. This is a small connection row, not permission to redesign settings or repeat every unrelated story/device run.

## 9. Completion report and boundaries

Report which of capture/reply/retrieval/clarification/commands now work, source files/DTOs/migration (none preferred), exact tests/checks and known versus unknown outbound behavior. Local fake provider/Telegram evidence is not deployed/live bot success. Mention configuration names needed for provisioning without printing values. Full 009 remains partial; 010/011/014 remain unassigned.

Stop and report a narrow blocker if current shared command or clarification API cannot provide required authorization/idempotency without broad surgery, if outgoing work cannot be atomically tied to the saved result, or if ordinary operation exceeds the real Worker/D1 invocation limits. Do not paper over it with a cron wait, a fabricated answer, insecure user IDs or another service. Reviewer decides scope changes; implementation agent does not rewrite this plan.

## 10. Current official references checked by reviewer

[Bot API](https://core.telegram.org/bots/api#sendmessage): sendMessage returns Message, text limit 4096 characters after entity parsing. We choose plain text parts <=4000 UTF-16 units as a conservative application limit. [ForceReply](https://core.telegram.org/bots/api#forcereply) provides native question targeting. [ResponseParameters](https://core.telegram.org/bots/api#responseparameters) supplies retry_after on flood control. [Bots FAQ](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this) advises pacing per-chat sends. Recheck these primary references if implementation reveals drift; do not add newer rich-message/ephemeral/streaming features merely because the docs offer them.
