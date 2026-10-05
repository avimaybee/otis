# Otis usefulness audit — Sol

Started 2026-10-05, Asia/Calcutta. Baseline: `main`, HEAD `e2071bc`, plus the existing dirty working tree. This is a living, read-only audit of application code. Findings are added when their cited implementation is inspected; implementation and release are not authorized by this report. Concurrent edits can invalidate line numbers and findings: recheck before acting.

## Scope and status

Find additional essential fixes that make Otis useful to a nontechnical person. The other agent already owns chat naming/rename/delete, workspace CRUD/member management, model picker/default/thinking, Working detail, reference structure, and Telegram linking. Do not duplicate those assignments. Check their integration boundaries where they affect unrelated capture/recovery/security.

Initial audit pass complete: 29 numbered observations (SOL-17 has a concurrent-source qualification), plus four already-owned feature gaps. This remains the living report for revalidation as implementation changes arrive. Source inspection is not live-provider or production acceptance. No application code changed. Subagents were stopped on the user's instruction; subsequent work is solo. Findings below are verified by source unless stronger reproduction is explicitly recorded.

Effort: S = hours, M = about a day, L = multiple days including tests. Priority reflects immediate usefulness/data integrity, not a mandate to build every feature. Confidence HIGH means the cited code establishes the behavior; runtime frequency remains unmeasured.

## Verified findings

### SOL-01 — Explicit Retry stops working after automatic retries run out

- Priority: P1. Confidence HIGH. Effort S. Fix risk LOW/MED: preserve message ordering and stable UUID.
- Evidence: `apps/web/src/api/flush.ts:24` caps attempts at 8; `flush.ts:376` skips entries at the cap; `apps/web/src/api/outbox.ts:565–570` manual Retry sets `sending` and increments that same counter. `ConversationScreen.tsx:511–513` routes Retry through this selector.
- User impact: a note that exhausted retries changes to Sending after clicking Retry but cannot issue another POST. The visible recovery control strands the note even when connectivity returns.
- Smallest fix: separate bounded automatic retries from an explicit manual attempt, or reset the automatic budget on deliberate Retry while retaining the same client UUID, payload, scope and chronological ordering. Do not add another queue.
- Acceptance: exhaust eight attempts, restore the transport, click Retry, observe exactly one same-UUID delivery and durable acceptance; repeated clicks must not create duplicate effects.

### SOL-02 — Negated or quoted “sent” text can authorize a sent record

- Priority: P1. Confidence HIGH. Effort M. Fix risk MED: language-sensitive intent boundary.
- Evidence: `packages/agent/src/policy.ts:78–87` accepts any match of `sent`, `emailed`, `trimis`, etc.; `apps/worker/src/agent/repository.ts:770–780` uses that result to guard `mark_message_sent`.
- User impact: “I have not sent it” contains the accepted keyword. If the model proposes the sent tool, the supposedly deterministic safety boundary allows a false contact/sent record. Questions and quoted statements have the same weakness. This does not itself send a message externally.
- Smallest fix: require affirmative, member-attributed completed-send confirmation; fail closed on negation, future intent, questions, quoted/forwarded text and ambiguous references. Preserve conversational confirmation rather than adding a form.
- Acceptance: positive and negative English/Romanian/Hungarian fixtures through the actual tool boundary; negative/question/quoted cases cannot produce sent events, while a clear affirmative statement produces one replay-safe event.

### SOL-03 — Editing only a draft recipient throws; editing text loses recipient metadata

- Priority: P1. Confidence HIGH. Effort M. Fix risk MED: shared ledger/event semantics.
- Evidence: `packages/agent/src/tools.ts:664–685` accepts content OR recipient and optional revision. `apps/worker/src/agent/repository.ts:753–766` forwards optional content as `content_text` and omits channel/entity/revision. `packages/ledger/src/commands/recordDraft.ts:23` calls `.trim()` unconditionally; its payload replaces recipient with null when omitted (`:37–45`).
- User impact: “Use this phone number instead” can fail the run; “Make the offer shorter” can erase its existing recipient. The advertised draft revision flow is unreliable, and stale edits have no forwarded revision guard.
- Smallest fix: load the existing scoped draft, merge only supplied fields, preserve entity/channel/recipient, reject a missing draft, and enforce supplied revision at the committing boundary. Keep event-backed history and one draft command path.
- Acceptance: recipient-only/content-only patches, missing draft, stale revision, concurrent update and lost-response replay; assert retained fields and exact events, not only response wording.

### SOL-04 — Combined task edits silently apply only the status transition

- Priority: P2. Confidence HIGH. Effort S/M. Fix risk MED: versioned event/reducer behavior.
- Evidence: `packages/agent/src/tools.ts:585–624` permits a multi-field task patch. `packages/ledger/src/commands/tasks.ts:126–150` returns after `task_done`; the cancelled branch follows the same early-return pattern. Additional title/due/snooze fields never reach the generic patch.
- User impact: “Mark this done and correct its title/date” reports applied while dropping part of the instruction. Complete instructions must either apply completely or explicitly identify an unsupported combination.
- Smallest fix: validate the full patch first, then emit the required versioned events atomically, or reject the combination clearly before any effect. Prefer the existing command/reducer boundaries.
- Acceptance: status+title, status+due and status+snooze combinations; assert full resulting projection, event history, revision behavior and replay idempotency.

### SOL-05 — Failed initial conversation load has no working in-place recovery

- Priority: P1/P2. Confidence HIGH. Effort S. Fix risk LOW.
- Evidence: `apps/web/src/api/queries.ts:31–38` disables automatic retry, focus and reconnect refetch; `ConversationScreen.tsx:196–200` sets the snapshot error. At `:723`, Reload conversation appears only when a snapshot already exists; at `:724`, a persisted chat without a snapshot keeps the composer disabled with “Opening conversation…”.
- User impact: the first transient fetch failure leaves a disabled composer and “Try again” wording without a retry action. Browser reload or navigating away is the only practical escape.
- Smallest fix: expose an in-place retry for the failed initial snapshot, clear the stale error after successful recovery, and show failed/loading states distinctly. Keep access-denied handling separate and the same scoped query owner.
- Acceptance: initial snapshot fails once then succeeds on Retry; no new chat or message is created, composer becomes usable, error disappears; denied scope still closes private content.

### SOL-06 — Sign out does not consistently revoke the session or remove private recordings

- Priority: P1. Confidence HIGH. Effort S/M. Fix risk MED: account cleanup must fence in-flight writes.
- Evidence: `apps/web/src/App.tsx:150–153` no-workspace Sign out calls Firebase only, while Otis authenticates API access through its own session cookie. The normal path (`:160–174`) calls DELETE but does not check the response and does not call `deleteVoiceSessionsForUser`, which already exists at `api/voiceSessions.ts:396`. Access-loss cleanup in `ConversationScreen.tsx:141–148` does purge voice sessions.
- User impact: a user can see signed-out UI while retaining a valid Otis session; normal logout can leave private recorded drafts recoverable on the device. Shared-device and changed-account behavior need the same cleanup as access loss.
- Smallest fix: one existing-owner logout path shared by every entry state, revoke the Worker session, explicitly handle failed revocation, and fence/await cleanup of draft/outbox/voice storage. Avoid a new auth framework.
- Acceptance: no-workspace logout followed by `/api/me` is unauthorized; normal logout removes user-scoped recording metadata/chunks; delayed recorder writes cannot resurrect them; failed server logout is reported honestly.

### SOL-07 — Dashboard Groq credentials do not reach upload availability/verification

- Priority: P1 for zero-setup voice. Confidence HIGH. Effort S/M. Fix risk LOW/MED: credential precedence must stay consistent.
- Evidence: `apps/worker/src/routes/commands.ts:73–76` builds model/voice availability with platform keys. `apps/worker/src/media/routes.ts:103–117` omits platform keys when resolving both model and voice route and recognizes only workspace credential metadata for verification samples. `providers/service.ts:416–423` already accepts platform keys. Upload creation rejects unavailable routes at `media/routes.ts:180–181`; format verification at `:529–554` also requires workspace credentials. The transcription processor itself supports a platform key.
- User impact: a dashboard-key installation can advertise voice availability but reject the upload or never acquire exact-format verification, forcing a technical BYOK setup the product promises is optional.
- Smallest fix: thread `extractPlatformKeys(env)` through the existing upload/finalize/verification resolver and use the same precedence as model availability/transcription. Preserve actual-format verification; a key alone must not certify a codec.
- Acceptance: platform-only key, BYOK override, invalid BYOK and no-key cases through real local Worker upload/finalize/format verification; synthetic provider for determinism, separate real device/endpoint evidence before capability claims.

### SOL-08 — A new chat cannot begin with a voice note

- Priority: P1 for the field-use path. Confidence HIGH. Effort M. Fix risk MED: chat creation and upload identity must reconcile safely.
- Evidence: `apps/web/src/ConversationScreen.tsx:215` requires an existing active chat before exposing voice. `components/Composer.tsx:93` hides the microphone when unavailable. The recorder session contract already allows `chatId: null`.
- User impact: someone who opens New chat to record a visit must first discover that they need to send text. This blocks the primary phone use case at its first action.
- Smallest fix: allow scoped recording before chat persistence, then reuse one stable client chat/message identity when Send provisions the chat and upload. Keep Stop → Review → Send and local recovery; do not create empty chats merely from typing or opening the screen.
- Acceptance: fresh chat → Record → Stop → Review → Send → transcript → completed response; lost creation/upload acknowledgement reuses identities, and Cancel does not leave an unwanted conversation.

### SOL-09 — Accepted voice notes have no original-audio playback or expiry state in the transcript

- Priority: P2, required before voice acceptance. Confidence HIGH. Effort M. Fix risk MED: authenticated media access.
- Evidence: `apps/web/src/components/Transcript.tsx:281` renders accepted member content or the literal “Voice note”; no media player/read flow is attached. `apps/worker/src/media/routes.ts` implements private media reads, while the sign-in disclosure promises retained voice-note history. The local review player is a different, pre-send function.
- User impact: after sending, a member cannot listen back to verify a misheard name/amount, and a teammate cannot inspect the original voice evidence. Missing transcript/expired audio are indistinguishable in the message UI.
- Smallest fix: a compact production voice message with transcript plus explicit authorized playback and truthful processing/expired/unavailable states. Reuse the media Worker route; never create public R2 URLs or waveform ornamentation without actual evidence.
- Acceptance: own/team playback, transcription pending/failure, expired audio with retained transcript, removed-member denial, scope change during audio load and no private service-worker cache.

### SOL-10 — Disputed-price draft protection reads values that are always null

- Priority: P1. Confidence HIGH. Effort M. Fix risk MED: avoid unnecessarily blocking unrelated draft content.
- Evidence: `packages/ledger/src/reducers/fields.ts:139–146` deliberately clears current values when disputed and retains candidate event IDs. `apps/worker/src/agent/repository.ts:714–734` checks disputed `value_text/value_json`, then only blocks when that nonexistent value appears in draft text. The `update_draft` branch also has no equivalent check.
- User impact: a model-proposed offer containing one side of a disputed price passes the purported code guard. This undermines the specific product promise that unresolved competing facts are not presented as settled in outward drafts.
- Smallest fix: inspect canonical candidate/provenance data through the existing ledger/query boundary and validate factual dependencies of create AND update. Do not rely on null current values or raw string matching as the authority. Keep unrelated uncontested draft work possible.
- Acceptance: two competing prices create disputed state; proposed drafts using either price cannot commit without resolution; a revision cannot bypass the guard; an unrelated draft remains possible. Exercise actual Worker tool + ledger path with a deterministic provider proposal.

### SOL-11 — Network requests can leave controls pending indefinitely

- Priority: P1/P2. Confidence HIGH. Effort M. Fix risk MED: timeout means unknown acceptance, not guaranteed rejection.
- Evidence: `apps/web/src/api/client.ts:59–77` has unbounded fetch and body reads. `api/voice.ts:98–129` and upload byte transport use the same unbounded pattern. `ConversationScreen.tsx` holds delivery identity while awaiting POST, and voice review disables Send/Cancel during upload. No shared request timeout/cancellation is passed through these transports.
- User impact: a stalled connection can trap Sending, settings, upload or initial loading despite normal connectivity indicators. The note may be retained locally, but the user cannot reach a truthful recoverable state.
- Smallest fix: bounded fetch/body timeout and scoped cancellation in existing transport functions; retain stable operation identity and reconcile a potentially committed result on retry. Show an in-control recovery action rather than a global spinner. Abort on explicit scope/logout transitions where appropriate.
- Acceptance: stalled headers, stalled body, lost response after commit, route/account change, voice upload timeout; pending ends within the configured bound, same-ID recovery creates no duplicate write, and late responses cannot overwrite another scope.

### SOL-12 — One missing chat can erase unsent work in every workspace

- Priority: P1. Confidence HIGH. Effort M. Fix risk MED: preserve privacy while narrowing destructive local cleanup.
- Evidence: `apps/web/src/ConversationScreen.tsx:83` treats every 404 as an authentication error. `:196–200` routes failed snapshot access into `loseAccess`; `:141–148` clears the entire user's query cache, outbox, text drafts and voice sessions. A chat-not-found response is legitimate when opening a stale/deleted chat link and does not establish account-wide revocation.
- User impact: opening one missing conversation can discard recoverable unsent notes in other accessible workspaces. A resource lookup failure is escalated into account-wide local data deletion.
- Smallest fix: distinguish session loss, verified workspace membership loss, and missing/inaccessible resource using the existing server error contract. Close the unavailable resource immediately; only purge the scope that has actually lost authority. Keep account-wide cleanup for logout/account replacement.
- Acceptance: unsent text/voice in two workspaces, then open a deleted chat in one; unrelated authorized entries remain recoverable and never reroute. Actual removed membership purges only that workspace; expired/replaced account cannot send stale content.

### SOL-13 — Source/change inspection recovery controls are incomplete

- Priority: P2. Confidence HIGH. Effort S. Fix risk LOW.
- Evidence: `apps/web/src/components/SourcePane.tsx:13–15` maps every non-auth request failure to possibly-unretained source content with no Retry. `components/DetailPane.tsx:20` fetches the action only on workspace/action change; `:37` Refresh preview changes only the preview effect's refresh dependency (`:21`), leaving a failed action-detail request unfetched.
- User impact: a transient network failure is described as missing evidence; Refresh preview can leave the saved change stuck in Loading with no detail. Inspection is essential for trustworthy correction/undo.
- Smallest fix: explicit loading/network-error/not-retained states, Retry for the actual failed read, clear stale error/detail when selecting a different resource, and refresh action plus preview when required. Reuse existing scoped API functions.
- Acceptance: fail each read once, click its recovery action, receive the same scoped resource without mutation; expired/forgotten source remains honestly unavailable; access loss still closes content.

### SOL-14 — The agent cannot directly read the current business fields it writes

- Priority: P1 for reliable retrieval. Confidence HIGH on missing read capability; actual model-answer failure rate unmeasured. Effort M. Fix risk LOW/MED: add a bounded scoped read, not a second memory store.
- Evidence: `apps/worker/src/agent/repository.ts:194–222` entity query selects ID/name/kind/status/assignment/timestamps only. `find_entities` (`:160–184`) returns name matches. `agent/context.ts` reads disputed field names but does not provide clear `entity_state` values. The query schema supports only entities/tasks/events/drafts; there is no current-field detail tool. `set_fields` writes these current projections.
- User impact: after saving a phone, price or other business field, later retrieval must infer current truth from notes or page through raw events. Corrections/disputes/undo require deterministic projection reads; asking the model to reconstruct the ledger is unreliable.
- Smallest fix: expose current scoped fields with revision, clear/disputed state and safe provenance via the existing entity query/detail boundary. Include canonical candidate references for disputed values. Reuse the same read for the already-planned read-only inspection surface; no new dashboard, CRM or vector service.
- Acceptance: save field → separate chat retrieval → correction → retrieval → undo → retrieval, all with canonical values/source links; disputed fields never become confident answers; other-workspace and removed-member access denied.

### SOL-15 — A snoozed follow-up cannot be unsnoozed conversationally

- Priority: P2. Confidence HIGH. Effort S. Fix risk LOW/MED: distinguish omitted versus explicitly cleared fields.
- Evidence: `packages/agent/src/tools.ts:158–159` allows `snooze_until?: string | null`, but its validator (`:610`) converts null to undefined, causing recipient-style missing-patch rejection for an unsnooze-only request. The provider declaration (`:1242`) advertises only string. `packages/ledger/src/reducers/tasks.ts:48–50` already supports explicit null to clear the snooze. Update due similarly needs schema support for an explicit no-deadline value.
- User impact: “Bring that follow-up back now” cannot use the intended clear-snooze contract, and postponed work may remain excluded from due-work selection. The backend capability exists but is unreachable through its tool boundary.
- Smallest fix: align provider schema, runtime validator and ledger patch semantics for nullable clears; validate non-null snooze instants in code. Do not add another task editor.
- Acceptance: snooze → unsnooze-only tool request produces one event and reappears in due work; omission preserves snooze, invalid instant is rejected, due/title unchanged.

### SOL-16 — A stale account tab can deliver its pending new-chat note under a different signed-in member

- Priority: P1. Confidence HIGH on the missing boundary; production reproduction not attempted. Effort M. Fix risk MED: cross-tab identity must fail closed without deleting unrelated work.
- Evidence: `apps/web/src/App.tsx:103–127` captures identity when loading the session; no account-change subscription or foreground identity recheck is installed. `ConversationScreen.tsx:331–411` scopes an outbox entry by its stored user but `api.createChat`/`sendMessage` requests use only the ambient same-origin cookie (`api/client.ts:70`) and send no expected-account assertion. Server scope derives the current cookie identity. A fresh-chat creation can therefore succeed as the new member, unlike an old authored chat which is protected by authorship.
- User impact: account A has a pending new-chat note, another tab changes the shared cookie to account B, and both have access to that workspace. A's old tab can create B's chat and submit A's private pending text as B. Workspace membership alone does not establish the original input owner's consent.
- Smallest fix: existing API acceptance boundary verifies the caller's expected session/account against the authenticated session as a rejection precondition; cross-tab logout/account-change notification and foreground revalidation promptly detach old UI/flush owners. Client IDs remain non-authoritative: a match never grants access.
- Acceptance: two local authenticated sessions sharing a workspace, held A new-chat outbox, cookie replaced by B, then flush; no A content is accepted or shown as B, same-account reconnect still works, existing-chat author denial remains intact.

### SOL-17 — Routine SSE rotation causes full transcript/run reloads

- Concurrent-source update: the other implementation now adds a production in-memory stream branch. The old 15-query rotation remains in the explicitly injected polling/test branch; do not treat it as the current production loop. The client still resyncs the full snapshot on connection error/maximum-duration closure. Revalidate current transport before assigning this historic observation; SOL-27/28 describe newly inspected production blockers.
- Priority: P2 runtime/cost blocker. Confidence HIGH. Effort M. Fix risk MED: reconnect cursor and revocation safety. Existing owner: 007 economics/014 handoff; do not create competing transport architecture.
- Evidence: `apps/worker/src/chat/stream.ts:29` limits each stream to 15 internal reads and intentionally closes normally for cheap rotation. `apps/web/src/hooks/useActivityStream.ts:94–101` treats every error/close as snapshot resync; `ConversationScreen.tsx:315` calls `resyncChat`; `api/snapshot.ts:38–45` loads four base resources plus one request per visible run. Each reconnect also resumes DB polling.
- User impact: leaving a chat open repeatedly reloads historical run data and costs queries even without useful activity; mobile reconnect churn and older chats amplify cost. A query cap on one connection does not prove the whole idle session is economical.
- Smallest fix: execute the existing bounded transport checkpoint; distinguish cursor-preserving reconnect from actual snapshot gaps, measure idle/reconnect query counts, and preserve membership checks. Direct live provider streaming remains the current mandate, not a claim about this implementation.
- Acceptance: instrument a quiet chat and an active chat with many prior runs; routine connection rotation does not issue full snapshots, real missing cursor does, removed membership closes content, no DB poll per token.

### SOL-18 — Missing member timezone is silently represented as UTC

- Priority: P1 for trustworthy deadlines. Confidence HIGH on the fallback; live model interpretation frequency unmeasured. Effort S/M. Fix risk MED: shared date/preferences contract.
- Evidence: `apps/worker/src/agent/context.ts:354–355` uses the member's brief timezone or literal UTC, then supplies it as `currentTimezone` to the prompt. New members can have a null timezone. `packages/agent/src/prompt.ts:56–57` presents it as the current date/time without marking it unknown. `/today` instead asks the member to set a timezone when absent.
- User impact: “Tomorrow at 10” can be interpreted using a timezone the person never chose. Users near a date boundary can get the wrong day as well as the wrong instant. A valid UTC date does not establish their intent.
- Smallest fix: represent unknown timezone honestly and ask only when local/relative date resolution needs it; persist an explicitly confirmed member timezone through the existing preference path. If suggesting the browser zone, treat it as a suggestion to confirm. Setting a date timezone must not enable a brief or invent its schedule/channel.
- Acceptance: new member with no timezone, relative deadline, explicit absolute instant, and two members in different zones; ambiguous local times ask, explicit instants remain usable, no implicit brief schedule appears.

### SOL-19 — Tool deadline validation accepts impossible dates and nonexistent timezones

- Priority: P1. Confidence HIGH. Effort S/M. Fix risk MED: date normalization and DST semantics.
- Evidence: `packages/agent/src/tools.ts:498–528` validates date-only values using a digits pattern and timezones only as nonempty strings. Instant validation uses `Date.parse` rather than requiring a complete offset-bearing ISO instant. `packages/ledger/src/commands/tasks.ts:36–37` accepts the supplied due object without further calendar validation. The agent repository forwards the validated tool arguments to that command.
- User impact: values such as `2026-02-31` or `Mars/Olympus` can become persisted deadlines. Locale-dependent/date-only strings can pass the instant branch. Later ranking or scheduling cannot reliably use the saved value, despite the write being reported successful.
- Smallest fix: one shared deterministic date validator at the mutation boundary: real calendar date, supported IANA zone, explicit instant offset and defined DST ambiguity handling. Reuse existing date utilities where present; no date-parsing service or model-only validation.
- Acceptance: leap/nonleap February, invalid month/day/zone, offset-free instant, DST gap/overlap, valid date and valid offset-bearing instant through the actual tool/ledger path; rejected values create no event.

### SOL-20 — Ordinary task creation bypasses the acting-member assignment default

- Priority: P1/P2. Confidence HIGH, reproduced through the real validator and handler. Effort S. Fix risk LOW/MED: omission versus explicit unassigned work.
- Evidence: `packages/agent/src/tools.ts:567–570` normalizes omitted `assignee_user_id` to null. `packages/ledger/src/commands/tasks.ts:53–56` applies the acting-member default only when the argument is undefined. The agent repository passes that normalized object directly. `apps/worker/src/brief/read.ts:241` includes unassigned work for every member.
- User impact: “Remind me to follow up” becomes unassigned team work even when no other assignee is requested. Teammates may all receive the same task in their personal brief; the member's ownership is lost.
- Smallest fix: preserve omission through the tool boundary, keep explicit unassigned semantics distinct if supported, and apply the current scoped actor default at the committing boundary. Recheck explicit assignee membership before writing.
- Acceptance: ordinary member-created task belongs to that member, deliberate team/unassigned task remains unassigned, valid teammate assignment works, removed/cross-workspace assignees fail, brief selection reflects the saved owner.

### SOL-21 — A workspace cannot remove its optional provider key and return to platform usage

- Priority: P2, after the model/default work already assigned elsewhere. Confidence HIGH. Effort S/M. Fix risk MED: encrypted credential invalidation and in-flight requests.
- Evidence: `apps/web/src/components/ProviderConnection.tsx` offers Connect/Replace and saves/verifies a key, but no remove operation. The credential route in `apps/worker/src/index.ts:613–634` handles GET/PUT only. `apps/worker/src/providers/service.ts` prefers decrypted workspace credentials over platform keys.
- User impact: someone who tries BYOK cannot return to zero-setup platform usage through Settings. A stale/revoked optional key may continue to own the provider path. Asking a nontechnical workspace owner to edit D1 is not a usable recovery flow.
- Smallest fix: one membership/role-checked credential deletion route and an in-place Remove workspace key action. Invalidate the existing capability/status cache and show the resulting platform/BYOK source truthfully. Clear ciphertext/version references without exposing a key or inventing key export.
- Acceptance: add → verify → remove → use platform fallback; repeat deletion safely; no platform key produces an honest unavailable state; another workspace/member without credential-management authority cannot remove it; concurrent replacement is guarded.

### SOL-22 — Routine reads and writes scale with the whole workspace

- Priority: P2 economics gate; can block useful growth. Confidence HIGH on unbounded work; actual Worker CPU/D1 limit breach unmeasured. Effort M. Fix risk MED/HIGH if transaction behavior changes. Owning checkpoint 007/014.
- Evidence: `apps/worker/src/agent/repository.ts:160–184, 538–557` loads all entities and aliases for each find/upsert before fuzzy ranking. `packages/ledger/src/repository/executor.ts:819` loads the full workspace projection for each command; `repository/queries.ts:153–364` reads all entities, aliases, fields, tasks, drafts, memory and suppressions. A multi-field update invokes that command boundary separately per field. Similarity scoring builds a Levenshtein matrix per candidate.
- User impact: a simple phone correction becomes slower/more expensive as retained business memory grows. Returning only a few results does not bound the rows read or CPU work that selected them. This is directly relevant to the user's strict free-tier invariants.
- Smallest fix: measure seeded realistic workspace sizes under actual local Workers/D1, then bound indexed candidate retrieval and load only command-required projections while retaining the existing atomic preconditions/receipts. Reuse the existing runtime cost checkpoint; no ORM, vector DB, cache-as-authority or distributed coordination redesign.
- Acceptance: record rows read/written, CPU and request counts for common capture/read/correction/undo flows at expected workspace sizes; fail the gate on unbounded growth; retain ambiguity detection, deterministic replay and late-batch rollback coverage.

### SOL-23 — Chat search reports no matches before searching older history

- Priority: P2. Confidence HIGH. Effort S/M. Fix risk LOW/MED: scope and pagination.
- Evidence: `apps/web/src/components/HistoryNav.tsx:35,74` filters only the passed, already-loaded chat arrays and says “No matching chat titles” if they contain no match. The API defaults to 25 chats per page (`apps/worker/src/routes/chats.ts:102`), and has no title-query parameter. Load more remains a separate manual control during search.
- User impact: a business conversation from last month can be present and accessible while Search says there is no match. A user must repeatedly load older pages before their query works, making retained memory difficult to find.
- Smallest fix: a bounded workspace-scoped title search on the existing chat list/read boundary, with pagination and correct empty/error states; alternatively explicitly label the control as a filter of loaded conversations until that search exists. No full-text search service or vector system is needed for title lookup.
- Acceptance: matching chat beyond the first page is found, genuinely absent title shows no match only after the scoped search finishes, access-revoked/team boundaries remain enforced, request count remains bounded.

### SOL-24 — Reply language incorrectly changes the language of English interface text

- Priority: P2 accessibility. Confidence HIGH on metadata mismatch; real screen-reader pronunciation not tested. Effort S. Fix risk LOW.
- Evidence: `apps/web/src/components/SettingsPane.tsx:75–81` sets the document language to the saved reply language when Settings mounts. The setting is labeled “Reply language” and visible controls remain English. `design.md` distinguishes interface and reply language.
- User impact: choosing Romanian or Hungarian replies tells assistive technology to pronounce English navigation and controls in that language. Opening Settings changes global language metadata even though the interface itself does not translate.
- Smallest fix: keep document language tied to the actual interface language, independently of response preference; add per-message language only when reliable metadata exists. This does not require building a translation framework as part of this fix.
- Acceptance: changing reply preference leaves English UI metadata correct, response preference persists, multilingual response metadata follows the actual content where available, screen-reader spot check recorded.

### SOL-25 — Lead-status guard treats questions and conditional mentions as explicit status commands

- Priority: P1. Confidence HIGH, pure-policy reproduction included. Effort M. Fix risk MED: multilingual intent and target attribution.
- Evidence: `packages/agent/src/policy.ts:36–51` accepts the keyword “signed” as won and “lost” as lost without checking question/conditional/quoted context or the affected entity. `apps/worker/src/agent/repository.ts:111–126` runs this check on the entire source text for every proposed status field.
- User impact: “Has Bistro signed?” or “If we signed, would it count as won?” passes the guard if the model proposes a won write. A keyword about one business can also bless a proposed change to another business. The code boundary fails to preserve the requirement that inferred status changes ask first.
- Smallest fix: unify the narrow affirmative-intent/attribution checks with SOL-02, including questions, hypotheticals, quotes and the selected entity. Retain direct writes for complete explicit instructions; supported Romanian/Hungarian commands need fixtures rather than an English-only keyword shortcut. Do not build a second interpreter service.
- Acceptance: question, conditional, reported quote, mixed entities and direct commands through the actual tool boundary; ambiguous/inferred cases ask without mutation; explicit scoped commands apply once.

### SOL-26 — Existing local visual review entrypoints no longer mount the production route correctly

- Priority: P2 verification blocker, not an observed production-user outage. Confidence HIGH for review route/CSS; Storybook blank-page cause remains unconfirmed. Effort S for review wrappers. Fix risk LOW.
- Evidence: native browser at `ui-review.html?scenario=short` shows Not Found. `apps/web/src/review/Review.tsx` and `src/ux-preview.tsx` initialize memory history from their HTML filename while the production router defines `/`. Review also imports `index.css` without the production `main.tsx` font/globals/controls imports. The audit wrapper under `plans/qa/` restores route and styles without changing application source and renders the existing fixture/production components.
- User impact: UI changes can be called reviewed against broken or unstyled fixtures; the current structural redesign particularly needs an actually mounted production renderer. Fixture coverage counts do not prove rendered fidelity.
- Smallest fix: fix the development wrappers to enter the production route and share its style imports, then repair/verify the Storybook runtime separately. Keep one production component implementation; do not create another chat UI or loosen token rules.
- Acceptance: both dev entrypoints and actual Storybook stories render; short exchange compared at all five mandated widths; production styles/Inter load; checker and actual browser evidence recorded independently.

### SOL-27 — New live stream bus is isolate-local and cannot guarantee agent-to-client delivery

- Priority: P1 release blocker for the concurrent realtime work, already owned by the other agent. Confidence HIGH on deployment boundary; deployed multi-isolate reproduction not attempted. Effort M. Fix risk MED/HIGH: transport ownership.
- Evidence: newly added `apps/worker/src/chat/liveBus.ts:60` exports a module-global singleton. The ordinary Worker stream subscribes to it (`chat/stream.ts:229`); agent activity publishes to it (`agent/activity.ts:26`). There is no routing that ensures the Worker stream and the existing Durable Object/queue executor run in the same isolate. Cloudflare explicitly states requests are not guaranteed to use the same Worker instance: [Workers runtime model](https://developers.cloudflare.com/workers/reference/how-workers-works/).
- User impact: a local/same-isolate demo can stream while deployed requests silently miss live activity, only catching up after reconnection. The promise of detailed realtime Working cannot rely on this global map.
- Smallest fix: route production subscriptions/publication through the existing scoped execution/stream owner so the same actor owns live subscribers, with bounded durable catch-up on reconnect. Keep D1 as durable truth and direct in-memory token delivery; no second distributed pub/sub service or DB polling loop.
- Acceptance: actual Workers/DO separation with subscriber and executor in distinct contexts, restart/reconnect and two clients; every persisted public event reaches authorized listeners in order, no duplicate effects or per-token database polling. Tests must exercise the production branch, not only `pollIntervalMs` injection.

### SOL-28 — New production stream stops rechecking membership/session after opening

- Priority: P1 access-boundary blocker for the same concurrent stream change. Confidence HIGH by source and actual local Workers/D1 reproduction. Effort S/M alongside SOL-27. Fix risk MED: revocation/cost balance.
- Evidence: production branch `apps/worker/src/chat/stream.ts:190–283` checks membership/session once at opening, then subscribes to broadcasts. Its heartbeat explicitly performs zero D1 queries; broadcasts enqueue without another authority check. The old injected polling branch still revalidates, so those integration tests can pass while production behaves differently.
- User impact: a workspace member removed after opening the stream can continue to receive new private activity until the connection expires (default five minutes in `packages/contracts/src/chat.ts:124`). Server logout/revoked session has the same stale authorization window. This conflicts with current trusted-scope and revocation requirements. The audit test removes membership in real local D1 and confirms a subsequent synthetic producer broadcast reaches that open default-branch stream; it does not prove deployed cross-isolate publication.
- Smallest fix: restore bounded revocation enforcement through the existing scoped stream owner using current membership/session and deliberate invalidation/expiry. A checks-at-open-only stream cannot claim the old periodic revocation semantics. Combine with the existing transport repair; no heartbeat writes or generic authorization cache service.
- Acceptance: open the actual default production branch, remove member/revoke session, then publish new activity; removed subscriber receives no post-revocation private event and closes with the correct signal. Retained members continue, scope is checked on reconnect, row-read budget is recorded.

### SOL-29 — New live publication sends cursor zero instead of the persisted activity cursor

- Priority: P1 for the concurrent realtime change, already owned by the other agent. Confidence HIGH. Effort S/M. Fix risk MED: replay ordering and publication authority.
- Evidence: `apps/worker/src/agent/activity.ts:16–37` increments/persists a chat cursor but broadcasts an envelope with literal `cursor: 0` and no SSE event ID. The client's activity admission/reconnect protocol uses positive monotonically increasing persisted cursors. The broadcaster does not return/reuse the committed row and can rebroadcast an existing ID after an idempotent no-op.
- User impact: the first zero-cursor event can enter the client, but subsequent distinct events also have zero and are discarded as duplicate cursor data by `mergeActivity`. The reconnect cursor does not advance. Database catch-up can later show the events, obscuring the broken live path.
- Smallest fix: publish the actual committed authorized row/ID/cursor from the existing activity owner; idempotent replay must preserve that identity and avoid duplicate publication effects. Keep append-before-publish/fence checks, stable ordering and current authority. Do not synthesize a cursor or bypass the existing durable owner.
- Acceptance: initial snapshot cursor > 0, new default-path publication reaches the browser with the next persisted cursor and SSE ID, duplicate key/restart does not add another event, lost response catches up without duplicate text, stale executor cannot publish new public content.

## Essential feature gaps already owned by existing gates

These are unfinished journeys, not newly discovered implementations to duplicate. Prioritize after the capture/integrity defects above. Recheck concurrent work before assigning them.

### GAP-A — Chosen schedules do not yet produce briefs through the production entrypoint

- Evidence: `apps/worker/src/brief/service.ts:144` implements `generateDailyBrief`; its index explicitly leaves cron/command linking to the coordinator. `apps/worker/src/index.ts:794–883` scheduled handler never invokes it. `/today` (`routes/commands.ts:458–464`) uses its own SQL rather than `buildTodayBrief`, and includes up to 25 titles rather than the sourced ranked kernel output. `brief_items` is written by the service but has no agent read path to resolve “I did the second one.”
- User impact: a saved enabled schedule can look configured while delivering nothing. Brief tests that call the service directly do not prove cron integration. An ordinal follow-up lacks canonical selected-item IDs at the agent boundary.
- Priority/effort/risk/confidence: P1 for brief acceptance; M/L; MED; HIGH source evidence. Owning plan 011.
- Lean completion: one bounded due-schedule scan in existing cron, inject the existing kernel, reuse canonical web/outbox delivery, reuse the ranked reader for `/today`, and resolve replies against saved item positions. Show saved schedule/off state plainly; keep default disabled and no implicit channel/time.
- Acceptance: actual scheduled entrypoint tick at two members' chosen times yields one canonical brief each; duplicate tick/restart yields no duplicate; disabled/empty schedules remain silent; “second one” targets the original saved task after other work changes.

### GAP-B — Explicit reminders need an honest supported flow

- Evidence: no dedicated one-off reminder job/tool exists in current migrations, Worker or tool registry; `create_task` persists a deadline, and `update_preference` controls recurring briefs. These are different operations in plan 011 and product.md.
- User impact: “Remind me tomorrow at 10” can become a task but cannot substantiate a promise to notify at 10. A closed web app has no implemented push delivery.
- Priority/effort/risk/confidence: P2 after chosen briefs; M/L; MED; HIGH missing capability. Owning plan 011.
- Lean completion: use the existing job/outbox/scheduling infrastructure for a deliberately chosen one-off time/zone/channel. Until implemented, keep replies truthful about saved task versus actual notification; no proactive nudge engine, default morning time or paid service.
- Acceptance: one explicit reminder fires once, across restart/repeated cron and DST cases, with clear in-app-only versus connected Telegram behavior; no promised closed-browser push.

### GAP-C — Draft → copy/open WhatsApp → explicit sent confirmation is incomplete

- Evidence: draft tools/ledger exist, but current web source contains no draft-specific detail/handoff or `wa.me` action. Generic message Copy copies the full agent answer. `packages/sheet/src/index.ts` contains types only and `/sheet` remains explicitly unavailable in `packages/commands/src/registry.ts:69`.
- User impact: preparing an offer does not give a clean inspectable current draft, recipient or one-action handoff. The requested useful workbook is still absent; that is a later release gap, not a reason to add a CRM.
- Priority/effort/risk/confidence: draft handoff P2; export P3 after useful capture/retrieval; M then L; MED; HIGH missing capability. Owning plan 012.
- Lean completion: first repair SOL-02/03/10, then render the existing draft record with copy body, optional valid E.164 WhatsApp link and explicit sent action. Implement the bounded private snapshot export under its existing plan separately. Never record sent from opening/copying.
- Acceptance: missing phone still permits copy; revised draft preserves recipient; URL-encoded handoff stays draft; explicit confirmation records once; future workbook uses one snapshot and membership-checked expiry.

### GAP-D — Accepted failed work lacks an intentional recovery journey

- Evidence: `apps/web/src/components/Transcript.tsx:43–46,139` says the message is saved and the request could not finish. Retry is rendered only for local delivery failures (`:291–297`). Run routes expose read/stop, not an authorized execution recovery action. `apps/worker/src/agent/handler.ts:688–695` terminates on provider-stream error; actor cron recovery handles orphaned attempts, not a user-requested terminal-run continuation.
- User impact: when input was accepted but the provider failed, Retry delivery is no longer the answer. “Use as draft” creates a fresh message and can repeat instructions after some writes already committed. Users need a safe, understandable way to finish the unfinished part.
- Priority/effort/risk/confidence: P2 after reliable capture and receipt inspection; M; HIGH replay risk; HIGH source evidence. Existing owners 006/007/009; contracts explicitly prohibit inventing a client execution-retry endpoint.
- Lean completion: owner-defined server recovery using saved logical steps/receipts and current state, with an attached Continue/Retry control only when that boundary is implemented. Show partial writes and their undo controls; do not re-post the original instruction as automatic recovery.
- Acceptance: provider fails before writes and after one committed write; controlled recovery completes once without repeating that write, handles changed facts/membership, and distinguishes Stop from Undo.

## Reproduction evidence

`pnpm exec vitest run --config plans/qa/sol-audit-2026-10-05.config.ts`: **16/16 defect reproductions passed**, 1 file, 947 ms on the latest run. These intentionally assert existing incorrect behavior; green is evidence of defects, NOT acceptance of the product. Covers SOL-01, SOL-02 (negation/question/quotation), SOL-03 (recipient-only exception/content-only data loss), SOL-04 (combined status/title patch), SOL-15 (null unsnooze), SOL-19 (invalid/underspecified deadlines), SOL-20 (omitted assignee), SOL-25 (status questions/conditionals/quotes), and SOL-29 (zero-cursor collision).

`pnpm exec vitest run --config plans/qa/sol-audit-worker.config.ts`: **1/1 defect reproduction passed**, actual local Workers/D1, 3.22 seconds. Covers SOL-28 through the default production stream branch with actual migrations, scoped session and membership removal. The subsequent producer broadcast is synthetic, deliberately testing subscription authorization independently of producer persistence/actor fencing. Provider keys are explicitly blank in the test config; no remote provider or production-data operation is performed.

All audit configs/tests/fixture wrappers/screenshots are confined to `plans/qa/`; no production source or existing tests modified. Convert these reproductions into desired-behavior regressions in the owning suites during repair; do not make production verification depend on accepting bad behavior.

## Browser and source-check evidence

- `pnpm check:design`: passed, 87 source files scanned. This does not establish semantic layout compliance.
- `pnpm check:stories`: passed, 92 required fixture IDs across 16 story files. This does not establish that Storybook renders.
- `pnpm exec eslint plans/qa/sol-audit-2026-10-05.config.ts plans/qa/sol-audit-2026-10-05.repro.test.ts plans/qa/sol-audit-worker.config.ts plans/qa/sol-audit-worker.repro.test.ts plans/qa/sol-audit-ui.ts`: passed. This is the audit-artifact lint check, not the application's full lint command.
- `git diff --check`: passed. All five report screenshot links resolve; all seven audit text artifacts checked for trailing whitespace. Existing application changes are preserved.
- Native Codex browser, audit-only wrapper around the existing synthetic Review fixture and production components. Verified Working expansion, action detail/undo-preview opening, Escape dismissal with focus return, source disclosure and navigation to a teammate's read-only chat. No mutating Undo, real account, microphone or external-provider action exercised.
- Short synthetic conversation captured and visually inspected at [360 × 800](qa/sol-audit-short-360.jpg), [390 × 844](qa/sol-audit-short-390.jpg), [900 × 900](qa/sol-audit-short-900.jpg), [1280 × 900](qa/sol-audit-short-1280.jpg), and [1440 × 900](qa/sol-audit-short-1440.jpg). These are actual resized browser viewports, not touch-device/soft-keyboard or screen-reader evidence. Viewport override restored afterward.
- Comparison used `design-tokens.md` section 12 and `docs/design/approved-reference.png`. Short text wraps within captured views; desktop has scoped sidebar/chat and source/action inspection uses the existing surfaces. Current composition visibly adds a model selector row inside the composer and substantial gaps around Working. The former conflicts with the currently approved no-toolbar recipe; structural resolution belongs to the other agent's already-assigned reference/model work. Checker green does not resolve that contract mismatch. No full visual acceptance claimed.
- Original `ui-review.html` route fails (SOL-26); original Storybook iframe remained blank on localhost in both native Chrome and the in-app browser. Hostname warning was resolved by using localhost; the remaining blank-page cause is unconfirmed. No Storybook build claimed.

## Recommended implementation order

This is an order of repair, not authorization to implement everything or start new architectural gates.

1. **Block incorrect or unauthorized work:** SOL-27/28/29 in the existing realtime assignment; SOL-02/25 intent; SOL-10 disputed drafts; SOL-06/12/16 account/scope cleanup and acceptance. Handle transport regression within its current owner rather than starting a competing stream implementation.
2. **Make capture/recovery reliable:** SOL-01/05/11. Keep submitted payloads and UUIDs immutable, preserve unknown acceptance, and make visible Retry actually retry the failed operation.
3. **Make ordinary corrections complete:** SOL-03/04/15/18/19/20. Prefer shared validators and existing ledger commands, with targeted fixtures and actual D1 atomic/replay checks where committing behavior changes.
4. **Make memory useful after capture:** SOL-14 current canonical fields, SOL-13 evidence recovery, SOL-23 old chat lookup. A bounded read of existing projections provides more value than a new dashboard.
5. **Complete the existing voice and follow-up journeys:** SOL-07/08/09, then GAP-A and draft handoff in GAP-C. Follow existing dependencies; do not promise one-off reminders/export/failed-run continuation until GAP-B/C/D owning boundaries exist.
6. **Prove affordability and fidelity:** SOL-17 revalidated against concurrent source, SOL-22 actual runtime measurements, SOL-24 language semantics and SOL-26 working review wrappers. Run the owning application's required checks when implementing; no gate is completed by this report.

## Coverage and boundaries

| Journey / controls | Inspected evidence | Outstanding acceptance |
|---|---|---|
| Sign in, unavailable state, logout and account switching | App/SignIn/Unavailable source, session and scoped cleanup paths | Actual authenticated multi-tab and server-revocation browser flow |
| New/own/team chats, history, source navigation, workspace selection | Production router/history/snapshot source; native drawer/source/read-only navigation | Concurrent CRUD/member work and full paginated search |
| Composer Send/Retry/discard, draft reuse, offline delivery | Production composer/outbox/flush/transport source; defect reproductions | Actual browser storage eviction, network failure and cross-tab flush |
| Working, thinking, Stop, inspect/undo | Source/actor/activity inspection; native disclosure/detail/focus; local Workers stream repro | Correct production publication/revocation, real stop/undo D1 flow and live provider capability |
| Task/status/price/draft capture and correction | Tool validators, policy, adapter, pure handlers/reducers; focused reproductions | Actual committing-boundary regressions and multilingual interpretation |
| Voice record/review/retry/recovery/playback | Recorder/session/panel/upload/server routes inspected | Actual Android/iPhone/Telegram codec evidence, microphone and retention playback |
| Settings, credentials, language/timezone and Telegram | Production settings/connections/commands/source; official Telegram deep-link documentation reviewed | Credential removal, actual linked-account usability and schedule integration |
| Briefs, explicit reminders, outward draft handoff, exports | Source/migrations/contracts and owning plans cross-checked | GAP-A/B/C/D remain implementation work, not feature acceptance |
| Affordability, responsive UI and accessibility | Source scans, runtime ownership inspection, five native viewport screenshots | Actual CPU/rows measurement, Storybook rendering, touch keyboard and assistive-technology checks |

Considered and not promoted into extra work: no CRM/dashboard, speculative vector search, new notification engine or second queue; projection reducers' shallow map copies alone are not a proved persistence defect because the executor snapshots fingerprints before handlers; existing multi-field bulk confirmation is enforced by the handler and should not be reported missing merely because the pure round collector does not call it. Keep these checks tied to real paths rather than adding speculative refactors.

## Evidence limitations and next audit passes

- Root typecheck/lint/test/build have not been rerun for this report.
- Original development wrappers are broken; browser evidence above comes from the explicitly documented audit wrapper. No authenticated production flow has been tested.
- No real provider, Telegram send, microphone/device codec, deployed multi-isolate stream or export action verified. No Cloudflare limit breach claimed without measurement.
- Concurrent changes are still in progress. Revalidate the affected finding before repair; preserve the user's unrelated dirty work. No commit, push, PR, deploy, new gate or canonical plan-status update was performed.
- Audit-created Vite and Storybook processes stopped after collecting evidence. Native viewport override reset; screenshots and local fixtures remain available under `plans/qa/` for review.
- Next eligible work follows the ranked repair groups above and the existing dependency gates. This report completes the discovery pass; implementation acceptance remains with each owning gate.
