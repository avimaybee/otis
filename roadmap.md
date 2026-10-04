# Otis delivery roadmap

Revised 2026-09-30 against scaffold commit `a3bd462`. This roadmap describes the intended application, the sequence that gets there, and the evidence required to call each part complete. It is deliberately longer than a backlog. It should let an implementation agent begin with the repository and its assigned gate, without needing the planning conversation.

**Current reality:** React/Vite shell, Cloudflare Worker health route and placeholder actor, shared package stubs, local development, lint/typecheck, Vitest and dry-run Worker build exist. Real authentication, ledger, agent, memory, chat, Telegram, voice, scheduling and exports are still to be built. The existing happy-dom width test is not a recorded real-browser acceptance test.

## 1. The product we are protecting

Avi and Hunor work in Kerning. Each talks to Otis in their own chats. They can inspect each other's history and the source of every business change. Otis retains business context across chats, channels and process restarts. The user reports what happened instead of maintaining fields and task boards.

The first product is useful when Hunor can send a rough field note, answer a small question if needed, trust that the work was saved, and later get a useful brief at a time he chose. Avi can ask what happened, inspect disagreements, revise an offer, and understand exactly what the agent changed.

### Confirmed decisions

- Cloudflare Workers, one WorkspaceActor per workspace, D1 and private R2; Queues/Cron when the owning milestones need them.
- React/Vite web app, Firebase Google sign-in, shared workspace keys for Gemini and OpenCode Go.
- Kerning dogfood first; broad research/browser-agent features remain outside v1.
- One user identity; equal members; owner is a lifecycle marker with transfer protection.
- Full workspace history and retained audio are visible to all current members, including pre-join history.
- Individual authored chats; teammates read them and make corrections from their own chats.
- Entire ordinary business workflow is conversational. Commands and controls are shortcuts and inspection aids.
- Mobile composition follows ChatGPT; desktop follows Codex's sidebar/chat/optional detail pattern.
- Approved charcoal + muted Highlighter reference and exact design-tokens.md recipes; no composer toolbar or box-in-box dashboard aesthetic.
- Voice notes first, text replies by default; real Android and iPhone compatibility required.
- Models are handpicked by the operator, not auto-published from a provider catalog. `/model` works on web and Telegram and affects the current chat only.
- Clear complete instructions can be saved directly. Missing deadlines, ambiguous facts and inferred status changes require clarification. No invented 'today' deadline.
- Default step rollback undoes the selected write and later writes from that run; single-action undo remains secondary. Preserve unrelated teammate work.
- Scheduled briefs are opt-in at each member's chosen time, timezone and days. No hardcoded 09:00 delivery. `/today` works on demand.
- Durable preferences and memory stay within their original workspace. No canonical runtime `memory.md` file.
- External messages remain drafts. WhatsApp handoff is a prefilled link, not a WhatsApp bot or proof of sending.
- Native browser review by Codex/Antigravity; no Playwright installation.

## 2. How the documents fit together

| Document | Answers |
|---|---|
| [product.md](product.md) | What users can do, who can do it, and what v1 excludes |
| [design-tokens.md](design-tokens.md) | Exact approved visual values, recipes and reference-scale rules |
| [design.md](design.md) | Interaction, layout logic, copy constraints and required story/state inventory |
| [architecture.md](architecture.md) | How state, transactions, identity, execution and recovery work |
| [docs/contracts.md](docs/contracts.md) | Shared schemas, enums, dates, APIs, tools and defaults |
| This roadmap | Why each gate exists, its dependencies, journey and completion evidence |
| [plans/README.md](plans/README.md) | Current execution order and status, linked work packages |
| [docs/verification.md](docs/verification.md) | Test/evaluation/browser/release evidence requirements |
| [docs/agent-handoff.md](docs/agent-handoff.md) | Small reproducible prompts and reports for implementation agents |

Do not duplicate a technical choice differently in several places. Product intent governs technical choices; design-tokens.md governs visual values/recipes and design.md governs interactions; contracts/architecture govern interfaces and correctness. If a plan's example is older than these contracts, update that example before implementing it. A conflict involving security, data meaning or user experience must be surfaced; routine file naming is the implementer's job.

## 3. Execution order and dependency repair

The old sequence put ledger before its identity sources, and agent memory before durable chat storage. Use explicit subgates to remove those cycles. Plan numbers remain stable so existing references work.

```text
001 foundation / browser acceptance
  → 003A identity and workspace schema/services
  → 004A chats, source messages, run/inbox/outbox schema
  → 002 ledger and deterministic state
  → 003B shared settings/lifecycle integration
  → 004B actor dispatch, leases and durable recovery
  → 005 provider capability evidence (may start mocked work earlier)
  → 006 agent + workspace memory
  → 007 web API + shared commands + replayable activity
  → 008 web UI and 009 Telegram (independent after contracts)
  → 010 voice, 011 brief/reminders, 012 drafts/XLSX
  → 013 integrated release and two-week dogfood
```

Pure ledger reducer work and fake provider adapters can be developed early in isolation. Integration gates cannot claim success before dependencies exist. One person owns migration numbering at a time. Never have two agents independently create a different `0004_*.sql` and assume filename order fixes it.

When working in parallel, agree on `packages/contracts` first, assign disjoint file ownership, and integrate one gate at a time. No agent replaces another agent's local changes because a plan assumes an earlier snapshot. User authorization is required to create additional tasks; these documents do not independently authorize messaging people, publishing, or spawning UI tasks.

## 4. Gate F — finish the foundation (plan 001)

**Outcome:** every later agent can run the repo, test actual Worker behavior, and understand what is and is not implemented.

Keep the existing package boundaries and command names. Confirm a fresh frozen-lockfile install, strict typecheck, lint, tests and web/Worker build. Worker tests must execute in the Workers runtime and use configured local bindings. The development command must run Vite and Wrangler and proxy API requests under the web origin.

Close remaining visual evidence with a real browser at 360 px and desktop width. Check title, health-linked shell, no horizontal overflow, zoom enabled, and current changes appearing in development. A simulated DOM test can check rendering but cannot supply visual sign-off. Do not mark this gate complete from `scrollWidth=0` in a DOM that performs no layout.

Record runtime/dependency versions and the actual browser result in the review record. Update the outdated Wrangler major only as a controlled compatibility task with these checks; the warning is not permission for an unreviewed dependency sweep. Document package purposes and a clear environment setup. Keep real resource IDs/credentials out of example-only instructions where they could encourage accidental production use.

**Exit evidence:** four root checks, local API result, browser record, clean source diff and explicit remaining limitations. No new product features.

## 5. Gate I — know who is speaking (003A)

**User journey:** Avi signs in through Google, lands in Kerning, and sees his identity. Hunor signs in separately and is recognized as Hunor. The app does not ask a model to guess the speaker.

Create identity/workspace/membership/session/invite/provider-setting foundations first. Bootstrap one Kerning workspace idempotently through operator configuration; bind verified invited email to Firebase UID on first sign-in. Do not embed real emails or provider keys in migrations or fixtures. Add a second synthetic workspace for isolation tests even though self-serve creation is later.

Verify Firebase tokens on the Worker, issue opaque server sessions, implement CSRF/origin checks and logout. Public Firebase client configuration is distinct from private credentials. Do not rely on the browser SDK's sign-in state as server authorization.

Each service gets a trusted workspace context. Test two users and two workspaces, revoked session, wrong issuer/project/signature, unverified invite email, reused invite and an out-of-scope ID. Sessions and link tokens are hashed at rest. Decide their lifetimes in named configuration and record the values.

Build the minimum sign-in/access screen; avoid designing the full chat UI in this gate. Local seeded authentication may help testing but must be impossible to activate in a deployed entrypoint.

**Exit evidence:** authenticated actual Worker route tests; UID-based attribution; idempotent bootstrap; denied cross-workspace request; session expiration/logout; no raw token in logs. `003A` can pass without claiming all of plan 003 is done.

## 6. Gate C — store the conversation before the agent (004A)

**User journey:** a text message is accepted once and survives refresh, even though the handler is still a deterministic echo.

Create chats, messages, inbox, jobs, execution records, checkpoints, public activity, pending questions and transactional outbox. Establish schemas before the ledger uses their source references. Give workspace messages a deterministic acceptance sequence and chat activity a replay cursor.

Web acceptance atomically stores the member message/inbox/run/outbox. Client UUID retry returns the same receipt only for the same owner/chat/payload. Different payload with the same key is a conflict. Never acknowledge before durability.

Telegram ingestion at this stage verifies/normalizes metadata; full linking and presentation arrive later. Keep unrouted messages from entering a workspace actor. Model provider calls and business writes are forbidden in the temporary echo path.

Define chat author/read semantics now. Team reading shares the transcript; sending checks author server-side. Account removal must deny access on the next request. Source IDs and workspace ownership must be testable before plan 002.

**Exit evidence:** message acceptance/duplicate/collision tests, refresh reconstruction, transcript pagination, same-user two-workspace isolation and source attribution. Mark `004A` complete, not the whole dispatch plan.

## 7. Gate L — business changes have one trustworthy path (002)

**User journey:** a deterministic command saves a visit and price, another command corrects it, and replay produces the same current record. No LLM yet.

Start with pure event schemas/reducers and canonical fixtures. Entity creation, alias changes, fields, quote amounts/currency, tasks, drafts and memory-note extension points must have explicit event meaning. Status and task enums come from contracts. Dates distinguish local date from precise instant. Never turn an availability statement into a promise.

Implement a single ledger command boundary with action receipts, source/workspace validation, live membership, revision and fence guards. An invalid transaction guard must throw within the D1 batch, not produce zero changed rows while later statements commit. Force late-batch failure to prove atomicity.

Add dispute resolution and explicit causal references. Opposing current reports create a dispute; clear updates/corrections can supersede known sources. Uncertain temporal interpretation asks rather than guessing. Current disputed values remain null, with history accessible.

Implement undo preview, `from_here` and `single`, stable operation IDs and atomic grouped compensation. Replay selected original actions out while retaining independent later changes. Detect dependencies across runs; a teammate's later change cannot be pulled into a rollback without a specific decision. Business read calls have no undo.

Important fixtures: A says 3500, B says 3600, a resolution selects 3600, then an earlier report is undone; later independent deadline edit survives. An undo of entity creation with later tasks/notes returns dependency conflict. A duplicate undo creates no extra revert. A stopped run retains applied actions.

**Exit evidence:** real D1 atomicity/race tests, deterministic rebuild equality, cross-workspace denial, duplicate action protection, zero unguarded business writes outside the ledger. This gate is a hard dependency for model tools.

## 8. Gate I2 — shared settings and team lifecycle (003B)

**User journey:** members understand who can see history, connect workspace providers, set their own language/timezone, and change a shared default without exposing a key.

Finish invites, removal and owner transfer with concurrent lifecycle tests. Equal membership does not permit impersonating another author or altering their personal preference without their explicit instruction. All members can change shared business records/settings as specified; only owner transfer has the lifecycle restriction.

Configure one encrypted credential per provider. Use write-only replacement, masked status and a tested key-rotation procedure. Validate model selection against the operator registry and configured provider. New/default-following chats inherit the shared default; explicit chat overrides remain independent.

Create typed member preference services, including initially disabled brief schedule. Setting time/timezone/days is an explicit request, not a hidden default. Audit changes so a future agent tool can call these services safely.

**Exit evidence:** full-history disclosure, current-member reads, revoked-member denial, owner/last-member concurrency, wrong-workspace ciphertext rejection, no raw key in response/log, auditable preferences. Complete plan 003 only after both subgates.

## 9. Gate R — durable execution without duplicates (004B)

**User journey:** two members submit reports; each is handled in order. A crash or repeated webhook does not create two tasks. A question waiting for Hunor does not block Avi.

Implement WorkspaceActor claims with persisted lease owner/fence/expiry and bounded execution slices. Queue messages are wake-up hints. D1 inbox/outbox/checkpoints remain authoritative. A per-object in-memory guard cannot be the only control across external awaits.

Persist step identity before execution. Recover receipts after commit-before-result crashes. Re-check membership/fence in every mutation. Release the slot on clarification and save enough operation context to resume without restating the original request. Cancellation stops future steps and reports prior writes.

Cron recovers accepted-but-undispatched work and expired leases. Queue consumer retries are bounded with visible failure/dead-letter reason. Do not promise exactly-once provider calls or Telegram sends; prove no duplicate business effects.

**Exit evidence:** fault matrix covers insert-before-publish crash, duplicate/out-of-order wake-up, provider response after lease loss, restart after committed action, canceled run, poison message and teammate work during clarification. Complete plan 004 only after both subgates.

## 10. Gate P — measure providers before promising capabilities (005)

**User journey:** `/model` will offer only exact models the operator selected and the workspace can actually use. Voice support shown in the UI is based on real endpoint tests.

Implement provider-neutral normalized streams and deterministic fake providers first. Then Gemini and OpenCode Go adapters for the exact endpoint families required by chosen models. Do not implement every provider protocol or expose every catalog entry speculatively.

Record exact model ID, command key, endpoint, tested text/tool/stream behavior, displayable summary support, audio formats/transcript quality, usage/cache reporting, model context limits and verification date. Discovery checks a handpicked ID; it does not approve it. Empty cells mean unverified, never false claims of support.

Preserve protocol continuation artifacts separately from public summaries. Test two tool calls, malformed tool data, cancellation, 401, 429, usage caps, timeouts and partial stream. A fake provider must reproduce these without a real key.

Measure repeated static-prefix requests and normal conversations for caching; record reported token usage and unknowns. Avoid larger prompts just to qualify for cache. Establish per-run/day budget defaults from these measurements. Keep explicit provider caches off until a demonstrated cost benefit and invalidation policy exist.

For voice, test actual Android WebM/Opus, iPhone MP4/AAC and Telegram OGG/Opus, not a model family's marketing description. A usable transcript is required. If a handpicked model cannot ingest audio, either the workspace explicitly chooses a separate transcription route or that model's chat uses text.

The user authorized private OpenCode Go integration. Preserve that scope and do not repeatedly block adapter work on the already answered preference. Document current provider guidance and actual failures; obtain a commercial decision before external-customer reliance. Do not claim permission the provider has not given.

**Exit evidence:** mocked adapter suite, synthetic live model/tool report, real-format voice matrix or explicit capability gap, chosen budget values, cache report, no secrets in fixtures. Unknown model choices remain operator input, not something an agent fills in from memory.

## 11. Gate A — a conversational agent that can finish and remember (006)

**User journey:** Hunor reports a visit, Otis retains clear facts, asks for a missing deadline, and completes the intended task after the answer. A fresh chat remembers a durable Kerning preference with its source.

Implement versioned tool schemas and trigger-based policy before the language loop. The model interprets and proposes; code validates scope, provenance, required details and transaction preconditions. Clear complete instructions execute directly. An inferred lead-status change asks; the model cannot set it just by marking provenance inferred.

Context protects current member/workspace, latest request, pending question, typed current state and policy. Then add bounded recent history and sourced memory. Old transcript prose cannot outrank a later correction/dispute. Do not silently truncate the latest user request or a critical source to fit budget.

Memory promotion separates durable preferences from one-off phrasing. Store source-backed entries through the ledger; FTS and summaries are rebuildable projections. Forgetting suppresses active retrieval and prevents the same forgotten preference being re-promoted from historical chat excerpts. Personal preferences remain per-workspace and per-member subject.

Asynchronous summary refresh has an outbox marker and source-revision publication guard. Begin with deterministic extractive summaries. Queue/provider failure falls back to direct records. No Vectorize or mutable runtime memory file is required.

Run outcome comes from receipts and persisted state. The final prose must agree with applied actions. A provider failure after saving a visit says the visit saved and the remaining work did not. Questions release the actor slot; answers resume durable pending work.

**Exit evidence:** multilingual/ambiguity/injection/correction/forget fixtures, a new-chat continuity test, restart continuation, no cross-workspace recall, no speculative deadline/status mutation, and accurate partial outcomes. Evaluate behavior deltas rather than exact answer wording.

## 12. Gate W — one web API and shared command language (007)

**User journey:** the browser can list chats, display messages, send once, watch Working, reconnect and inspect/undo changes entirely from documented API responses.

Implement scoped routes and DTO serializers against the storage already created in 004A. Do not create a second chat schema. Persist public activity before SSE publication; use chat cursors, replay and resync semantics. Coalesce text chunks; no D1 write per token. Session/membership revocation must eventually terminate existing streams, not only reject new ones.

Implement one command registry/parser for web and Telegram. Commands are optional shortcuts with durable attributed audit/receipts and generally do not call the model. Web control commands apply silently outside normal chat/model context; Telegram keeps concise native acknowledgments. `/model` handles listing, explicit approved key, default reset, missing credentials and in-flight ordering. `/workspace` changes only that surface's selection. `/today` works without schedule. Hide `/sheet` until implemented.

Add action detail/undo preview/group commit, clarification shortcut, status and stop routes. A teammate can read and request attributed shared-state undo from their own chat, but cannot send as the original author.

**Exit evidence:** cursor disconnect/replay, no duplicate optimistic message, ID tampering, author denial, private serializer tests, all command parity tests and checkpoint/answer durability. This is the stable integration contract for the UI and bot.

## 13. Gate U — the actual interface (008)

The 2026-10-03 [detailed UI handoff](plans/008-ui-implementation-handoff.md) supersedes scaffold-era UI instructions: 008A visual enforcement/stories, 008B optimistic conversation/state, 008C scroll/keyboard/a11y/routes, 008D local outbox/PWA. These are checkpoints within this gate, not more application layers. Prior UI commits are partial implementation; new baseline acceptance requires actual evidence.

**User journey:** on a phone, the person sees their conversation and can reply without navigating a management interface. On desktop, history is readily available and selected details open without dominating the chat.

Implement the exact design-tokens.md baseline and reference first, with the path-correct enforcement and Storybook setup in plans/008-ui-implementation-handoff.md. Build the 360 px composition with realistic fixture content; then drawer, desktop sidebar and optional detail. Do not first construct a dashboard and remove pieces to make it mobile.

Implement one composer with multiline/IME safety, mobile Enter/newline, desktop send shortcut, keyboard/safe-area position and stable Send/Stop slot. Allow active-run follow-ups as explicitly confirmed in design.md. Slash/model/effort controls apply real settings without chat pollution; quiet overflow is outside the composer. Voice entry ships only with its working route. No unsupported Plus menu, image button or live-call icon.

Integrate optimistic send/acceptance/replay and honest queued/running/saved/partial states. Working shows server actions live, folds after completion, and remains inspectable. Default Undo from here has a concrete preview; single-action undo is secondary. If a user reads old history, preserve their anchor and offer Jump to latest.

History presents own/team chats and clear read-only attribution. Settings distinguish personal preferences from shared workspace configuration. Brief setup starts disabled, asks for chosen time and channel, and is also changeable through conversation. Provider keys never render back.

Review every fixture in design.md, including failures and long multilingual content. Real browser geometry, keyboard behavior, focus, zoom and contrast are mandatory. Capture representative screenshots with synthetic data; record observed failures rather than checking a box based on expected behavior.

**Exit evidence:** native-browser review at 360/390/intermediate/1280/1440 widths, keyboard and 200% zoom, no unnecessary containers, no dead control, API integration and root checks. A visually attractive static mock is not completion.

## 14. Gate T — Telegram is a full channel (009)

**User journey:** Hunor links his identity once, sends a report in Telegram, answers questions, changes models, corrects an amount and undoes a run without opening web.

Use private bot chats. Link codes are random 32-character base64url strings, hashed, ten-minute, one-use, bound to signed-in user. Consume atomically with channel binding; a reused/expired code cannot rebind someone. Store active workspace and active authored chat per linked identity/workspace.

Native command menu comes from the same registry as web. Validate every callback's current identity/membership/resource scope and replay status. Opaque server IDs fit the current Telegram callback limit; do not trust a callback's embedded price or entity name.

Persist outbound reply intent before send. Known failure can retry; unknown send outcome is held for deliberate handling. Do not fake exactly-once delivery by reusing an internal ID that Telegram never accepts as idempotency. Keep web's canonical answer accessible.

Format concise truthful progress and answers; preserve per-action/group undo and plain-language clarification. Escape HTML. Split long content without breaking links/entities or repeating the business write. Unsupported photo/location inputs stay metadata-only.

**Exit evidence:** private-bot synthetic smoke, shared command parity, link-code races, duplicate webhooks/callbacks, revoked user, multi-workspace selection and unknown delivery. No third-party outreach messages sent by the agent.

## 15. Gate V — reliable voice notes (010)

**User journey:** record, stop, listen, send; see uploading, transcription and Working; receive text. Correct a misheard number without erasing the original evidence.

Follow plans/010-voice-ux-handoff.md alongside the STT handoff. Recorder uses capability detection, 1 s ordered IndexedDB chunks and real measured audio level if a waveform is shown. Stops at three minutes into review. Distinct Cancel/Stop/Send actions prevent accidental submission. Local IndexedDB recovery is best-effort and labeled honestly; logout removes private local drafts.

Upload claims are scoped and bounded. Reject known-invalid metadata early. For unknown duration, inspect bytes in bounded private quarantine before transcription/accepted media. Clean failed/orphaned uploads. Stream bytes where possible; avoid giant Worker buffers.

Use only the approved transcript route and disclose cross-provider transcription. A completed transcript becomes the attributed input to the normal agent. Uncertain names, dates and amounts ask narrow questions before dependent writes. Do not invent numeric confidence if the provider offers none.

Serve retained audio through authenticated Worker reads with membership checks. Fourteen-day expiry leaves the transcript and an honest audio-expired state. A user removed from the workspace cannot use an old URL to retrieve it.

**Exit evidence:** actual Android/iPhone recordings and Telegram OGG path; deny/cancel/interruption; duration/MIME/size validation; repeated upload; uncertain transcript; 14-day deletion; revoked-member read. Browser width simulation cannot replace device evidence.

## 16. Gate B — briefs and explicit reminders (011)

**User journey:** Avi says 'Give me a brief on weekdays at 8:30 in my timezone'; Otis saves the exact schedule and delivery choice. Hunor can choose a different time. `/today` remains usable by either at any moment.

Default schedules are disabled. Conversation resolves time, days, timezone and channel, asking only what is missing. No fallback 09:00 send. A web-only schedule produces an in-app message; do not imply a closed browser receives push when push is not implemented.

Implement deterministic candidate selection and stable item references. Due promises, due tasks, explicitly undated actions and stale leads have defined ranking, deduplication and evidence. Pending incomplete task requests are not fabricated scheduled work. Inferred lead-status changes cannot enter brief selection until confirmed.

Cron and outbox use unique scheduled_daily keys. Test DST, midnight, a changed schedule, repeated cron, no items and two members with different timezones. A brief viewed on web and notified on Telegram remains one canonical record. 'I did the second one' uses its original selected IDs.

Explicit one-off reminder jobs are distinct from daily briefs. Keep opportunistic check-ins, missed-logging nudges and weekly coaching disabled unless the unresolved D17 product decision opts in. No automatic overnight draft generation; make a draft when requested.

**Exit evidence:** disabled schedule sends nothing, chosen schedule fires once, no invented time, DST suite, saved-item response mapping, known/unknown Telegram delivery, and accurate in-app-only wording.

## 17. Gate D — draft handoff and useful workbook (012)

**User journey:** ask for an offer, revise it conversationally, copy/open WhatsApp, then explicitly say it was sent. Ask `/sheet` and receive an accurate snapshot.

Draft creation/revision is event-backed and grounded in clear facts. Missing phone leaves copy available; ask for a number only when WhatsApp handoff is requested. Encode an E.164 number and text correctly. Opening/copying never marks sent. Explicit confirmation creates the contact record once.

XLSX uses one consistent workspace snapshot/revision: Leads, Tasks and Log, stable hidden entity IDs, dates/currency, actor/source and disputed markers. Formula-like text must remain text. No macros or executable user-controlled links. Sorting/filtering cannot break row identity.

Generate privately in R2. Download ticket lasts 15 minutes and still requires a current session/membership. Telegram links may require web sign-in; explain this instead of exposing a non-revocable bearer link. Export object default cleanup is 24 hours. XLSX edits do not sync back in v1.

**Exit evidence:** no implicit sent confirmation, language fallback, missing phone, duplicate confirmation, independently parsed workbook, cross-workspace/revoked-member/expired download, consistent snapshot and manual spreadsheet review.

## 18. Gate O — operations before real reliance (013)

Create a concrete staging environment inventory with resource IDs, jurisdiction evidence, secrets references, provider matrix and deploy commit. Do not put secret values in docs. Run a clean database migration and rebuild, backup restore drill, scoped export and erasure drill. Recovery must not send historical Telegram messages or recreate forgotten memory accidentally.

Prepare runbooks for failed inbox/lease, source-revision mismatch, unknown Telegram send, provider outage/cap, credential rotation, lost R2 file, stuck export, migration failure and removing a member. A runbook must distinguish safe retry from potential duplicate external delivery.

Verify every ID-bearing route, stream and file access against removed members and another workspace. Confirm actual privacy/data-flow statements, source retention, audio cleanup and backup lifecycle. Do not claim legal compliance from cloud flags alone; obtain appropriate review before outside customers.

Run the entire synthetic two-person journey: sign-in → text capture → deadline question → confirmed status proposal → voice → conflict → resolution → group undo preserving independent work → model switch → cross-chat memory → forget → scheduled brief → draft confirmation → sheet. Repeat with disconnect, actor restart and provider failure. No real lead outreach in these tests.

Use a go/no-go packet identifying executed commands, tests, browser/device evidence, known limitations, costs and rollback procedure. Deployment approval, if not already granted, happens on that concrete packet, not before doing ordinary preparatory work.

**Exit evidence:** no unresolved cross-workspace access, lost accepted message, repeated business action, uninspected wrong write, raw key leak or false delivery. The build may be ready for dogfood; it has not yet proved the two-week habit outcome.

## 19. Two-week Kerning dogfood

Do not measure success by feature count. Observe whether Hunor logs naturally without Avi chasing him, whether dates/status questions are useful rather than exhausting, and whether the brief leads to action.

Record: active logging days; accepted-to-first-status/answer latency; clarification rate and repeated questions; wrong entity/amount/date/status writes; corrections and undo use; voice transcript correction by language; memory recall/source correctness; brief acted-on rate; provider cost/cap consumption per completed task; unknown delivery and recovery frequency.

Targets from the product remain: logging at least five of seven days for two weeks, >=95% entity matching on a held-out fixture set, no unauthorized/cross-workspace writes, and at least half of actionable brief items acted on. Text under five seconds and voice under twelve seconds median are measured targets, not claims until observed. Report sample sizes, abstention and failure rates alongside percentages.

Weekly review asks: Which questions should the agent have asked earlier? Which confirmations were redundant? Which information was hard to recover? Which UI control was unnecessary? Which provider actually worked reliably? Change one policy/prompt family at a time and rerun its evals.

## 20. After dogfood: ordered expansion candidates

These are roadmap options, not permission to build them during v1.

### E1. Self-serve workspace lifecycle

Create workspace, invite/accept, leave/transfer, connect providers and make visibility unmistakable. Prove multi-workspace isolation and billing ownership without turning owner into an unrequested role hierarchy. Onboarding should lead to a first useful conversation, not a long configuration wizard.

### E2. Read-only MCP access

If Avi wants Claude or another external assistant to retrieve Otis context, expose a remote authenticated MCP surface over the existing scoped query/memory services. Start read-only, with workspace consent, narrow scopes, revocation, pagination and source links. Tool invocation identity must map to a real authorized member/application grant. Never expose a shared superuser API key. Verify the chosen client's current connector/auth support before promising compatibility.

Write-capable MCP follows only after external action attribution, confirmation semantics and the same idempotent ledger boundary are tested. MCP is a public adapter, not a replacement for the internal typed services.

### E3. One outside-customer wedge

Select five to ten reachable teams with repeated follow-up needs based on Kerning evidence. Reassess provider permitted use, export/erasure, operational cost and support capacity before relying on subscription traffic for a commercial service. Avoid regulated sensitive-data use cases until their requirements are deliberately handled.

### E4. Fields by conversation

Add custom field definitions only when real customers need them. Field creation, rename, type conversion and deletion require versioned events, migration/rollback semantics and conversational clarification. Do not mistake XLSX projection columns for custom fields.

### E5. Google Sheets synchronization

Prototype least-scope access and actual edit attribution. Polling/diff does not automatically identify the human editor or prove Otis workspace membership. Until attribution is reliable, imported edits need a validated confirmation path. Ledger remains authoritative; conflict/source/replay tests precede automatic sync.

### E6. Broader initiative and voice

Choose additional proactive triggers from observed missed work and user-configured quiet hours/frequency limits. A daily brief is not blanket permission to interrupt. Consider spoken replies/live voice only after transcript/tool quality and latency support it; preserve interruption, partial-work and consent semantics.

### E7. WhatsApp bot

Treat WhatsApp Business Platform access as a new channel feasibility project, separate from `wa.me` draft handoff. Recheck current terms, templates, initiation windows, provider approvals and cost. Do not automate a personal WhatsApp account as a shortcut.

## 21. Decision boundaries for implementation agents

Field-use addition (2026-10-03): product.md's capture/memory/resurfacing/action principles and docs/verification.md's metric definitions guide core quality work. Reliable local capture, truthful filing state, scoped confirmed aliases, precise date/amount replies, useful sourced briefs and read-only entity inspection are applicable now within their owning gates. They do not authorize new cloud services or another data model.

Deferred candidates from the supplied field-use narrative: installed-PWA Record note shortcut, validated Web Share Target, timestamped audio word seeking, requested spoken brief, opt-in end-of-day/weekly wrap, photo extraction, opt-in nearby context and calendar out-sync. Implement only after core capture/resurfacing acceptance and an explicit bounded assignment. Shortcut/share permission and identity/routing/validation still apply; device/platform capabilities need evidence. No instant recording from a locked phone guarantee. Existing read-only MCP expansion stays ordered after dogfood. Auto-send voice and unsolicited nudges require separate product decisions, not interpretation of the narrative.

Proceed autonomously with reversible implementation details: file decomposition, helper names, query indexes, error propagation, accessible component composition and targeted tests. Ask when a choice changes user visibility, automatic write authority, retained data, external costs, provider routing, third-party messaging or a release promise.

Do not repeatedly ask about settled decisions in section 1. Remaining measurements include exact handpicked model IDs, verified audio routes, cost/token budgets, production jurisdiction and real browser/device behavior. Record them with evidence as they become available. A measurement gap is not permission to invent a successful result.

Every completed gate provides: commit/diff, implemented scope, exact verification results, screenshots/live-provider evidence when relevant, contract/migration changes, remaining limitations and next eligible gate. See the handoff template. Do not call the application built when only its documentation or a shell exists.
