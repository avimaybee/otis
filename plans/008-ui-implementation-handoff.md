# Gate 008 implementation handoff: approved visuals and reliable conversation

Revised 2026-10-04. This is executable work guidance for an implementation agent, not a completion report. The original documentation inspection baseline is commit **663f0b3**; re-read live files and the working diff even when HEAD has not changed. Significant uncommitted shadcn implementation is now present. Do not replay the old scaffold plan or assume the migration already satisfies the new requirements.

## 1. Start here and scope

Read AGENTS.md, design-tokens.md, design.md, architecture sections 6–7/12/17, docs/contracts.md, this handoff and docs/verification.md. The [approved reference](../docs/design/approved-reference.png) must be visible during browser review. All visual values/recipes come from the token file; no guessed improvements. Ask Avi about missing visual recipes, not routine module names.

Also review the supplemental [Working/Undo](../docs/design/working-undo-reference.png) and [voice capture](../docs/design/voice-capture-reference.png) mobile references. They establish compact interaction composition, not replacement token values. Fully embrace the existing shadcn component system with approved overrides; do not leave a second bespoke menu/sheet/disclosure implementation beside it.

Build one checkpoint, verify it, report evidence, then continue to the next assigned checkpoint. Do not rewrite the ledger, provider adapters, Durable Object leases, identity or auth for a styling change. Required contract additions get coordinated types/server/client/tests. Do not add a generic state machine, second API layer, UI platform or speculative dependency abstraction.

## 2. What source inspection actually found

These are observed gaps against the new target, not a fresh runtime audit:

| Current source | Observation | Required change |
|---|---|---|
| apps/web/package.json; src/index.css | Geist dependency/import, old CSS/token entry | Self-host Inter latin + latin-ext; canonical approved variables |
| apps/web/components.json | radix-nova, CSS points at index.css | Approved new-york / neutral / CSS variables / Lucide configuration, with globals.css source |
| packages/design/src/tokens.css | Old --otis palette, 15/23 body, white action color and competing spacing | Remove competing definitions; one approved store, no TS palette |
| Composer.tsx; ModelControls.tsx | Composer toolbar with model/thinking controls | Relocate operations to slash picker and quiet chat overflow |
| ConversationScreen.tsx | Hand-managed routes/state; send waits for HTTP then reloads; pending operation in sessionStorage | Immediate local message, scoped durable outbox, one query/route owner |
| Transcript.tsx | Custom scroll-height/follow logic; log live off; unfinished/final output paths | One follow owner, completed-message announcements, one message renderer |
| index.css | Arbitrary text sizes/spacing, blur/shadows, rounded rows, bordered question treatment | Replace with exact recipes; no compensating CSS overrides |
| apps/web/test/full-e2e-flows.test.tsx | Tests exist at component/integration simulation level | Keep useful tests; the filename is not real-browser/deployed evidence |
| Repository tooling | No Storybook, PWA or design-check script found in inspected file inventory | Add only at their owning checkpoint and prove they run |

Re-read implementation before editing. Do not delete functionality just because its current styling is wrong. Do not erase historical screenshots/reviews or mark old accepted gates failed retroactively. Gate 008's new acceptance is separate.

## 3. Required libraries and concrete ownership

Avi selected these. Adopt deliberately in the owning checkpoint; pin compatible versions and check current official API docs when implementing. This list does not mean they are installed now.

| Library | Ownership / checkpoint |
|---|---|
| shadcn + existing Radix primitives | Token recipes, menus, dialogs, Sheet; 008A |
| @fontsource-variable/inter | Self-hosted latin and latin-ext; 008A |
| lucide-react | One icon family; reuse installed package, recipe sizes; 008A |
| Storybook | Every design.md fixture uses production components; 008A setup, expand throughout |
| @tanstack/react-query | One server-state cache and optimistic reconciliation; 008B |
| cmdk / shadcn Command | One server-driven command/search picker; 008B |
| react-textarea-autosize | One growing composer, no competing field-sizing/scrollHeight implementation; 008B |
| Existing react-markdown + remark-gfm | Reuse as the first streaming renderer; stable block behavior must pass; 008B |
| use-stick-to-bottom | Sole follow/release/Jump owner; 008C |
| @tanstack/router | Typed workspace/chat deep links and lifecycle cleanup; 008C |
| vaul + shadcn Sheet | Mobile drawer/sheet behavior, shared focus/Back ownership; 008C |
| idb-keyval | Scoped local drafts/outbox/recording chunks; 008D, then 010 |
| vite-plugin-pwa | Static offline shell, controlled updates; 008D |
| eslint-plugin-jsx-a11y + vitest-axe | Labels/roles and settled-state accessibility checks; 008A onward |
| Radix Collapsible | Working expand/collapse with CSS only; 008B |

The user's markdown choice permits streamdown, but do not add it alongside the existing renderer speculatively. Replace the renderer only if incomplete-markdown acceptance fails and the replacement demonstrably fixes it. Libraries do not supply Otis's idempotency, authorization, offline policy or live-region semantics automatically. React Query mutation retry/rollback is not exactly-once execution and must not roll back committed server writes. Never preserve two active router or server-cache implementations after migration.

## 4. 008A: visual authority and enforcement

1. Preserve root design-tokens.md unchanged. Its SHA-256 at import is 72764AFF69EBA6809F9F7949F276A6B23F1FDF2D00FB759723A378FC023F058C. Do not rewrite approved values to make an existing component pass.
2. Create apps/web/src/globals.css from token section 9. It is the sole literal-value visual store. Point components.json to it and import it once. Retire palette/type/spacing definitions in index.css and packages/design. If a temporary compatibility variable is needed, it aliases an approved CSS variable, never defines another literal; remove migration-only aliases before acceptance.
3. Replace old rules with section 8 recipes instead of appending more specificity. Audit generated shadcn defaults too: weights, border/radius/shadow and animations may conflict. Dark only, html dark, no theme switcher. Inter must actually load; validate computed font and diacritics.
4. Use one production Message, Composer, Working, History and Overlay implementation. Stories compose those components. Legacy ux-preview/review fixtures may wrap them, but cannot ship another message/composer or retain their own styling.
5. Add scripts/check-design.sh as the required entry, backed by a small portable Node checker if needed for Windows/CI parity. Add pnpm check:design. These commands are planned until actually implemented. Resolve paths relative to the script/repo, not the caller's current directory. Scan real apps/web/src UI and relevant packages/design/generated primitives. Fail nonzero if paths are missing or zero candidate files were examined. The token's sample SRC=src must not silently pass here.
6. Start with the token script's bans, then cover authored CSS numeric values and forbidden visual constructions in this actual codebase. Exempt only the approved globals.css definition store and precise approved recipe values, not whole legacy files. Detect inline styles/arbitrary Tailwind literals, disallowed font weights/sizes, extra palettes, forbidden shadows/blur/motion, toolbar/card/border patterns through source checks and browser review. A regex scan cannot prove every semantic rule; do not claim it does.
7. Verify the checker with deliberate temporary drift samples: a hex color in a component, font-semibold, text-lg, blur, h-screen, unapproved spacing, a TS palette and missing source directory. Assert nonzero; remove samples afterward. Verify valid recipe exceptions do not fail. Do not install a lint framework just for this small checker.
8. The supplied file has explicit exceptions to its general grid rule: typography/icon/pill dimensions, borders, focus, selected-row padding and textarea margin. They are allowed exactly as documented. Missing dimensions, backdrop opacity, layer values or new status recipes require a narrow approval question; do not invent them or weaken the checker.
9. Build Storybook with synthetic data only, no auth/provider credentials or real accounts. Keep story IDs mapped to the complete design.md inventory. Planned voice/brief/export contract stories are clearly labeled, never treated as implemented operations. Render the approved short exchange at all five widths before growing scope.

008A exit: executed checker (including negative cases), Storybook build, loaded Inter, recipe comparison screenshots, useful a11y assertions and root checks. No claim of complete token compliance while old literal stores remain imported.

## 5. 008B: one message lifecycle and state owner

### Canonical state versus local state

Worker/D1 retain authoritative conversations, runs, public activity and receipts. React Query owns scoped server snapshots. IndexedDB owns unsent/local delivery state. Composer owns its editable draft. One merge function derives the visible transcript. No copied message lists in a query cache, ConversationScreen state and a second custom optimistic reducer.

Query keys include user/session boundary, workspace and chat where appropriate. Examples: messages(user,workspace,chat), run(user,workspace,run), models(user,workspace,chat), settings(user,workspace,scope). Cancel and clear scoped caches on logout/revocation; never display old workspace results while the new request loads. A late response cannot restore a previous selected model/thinking value.

### Optimistic send sequence

1. Capture immutable text/media/clarification and create client_message_id once. Generate an ID for new-chat creation as well; persist its mapping so a crash cannot create another chat on retry.
2. Insert a sending bubble synchronously using the production Message renderer. Clear only the submitted draft snapshot; newer typing remains. Record the operation locally before transport when storage permits; explain fallback if persistence fails.
3. Send the existing scoped message endpoint. The active run may accept steering; a pending clarification binds its explicit ID. Use server mode new_run/steer/clarification, not a guessed frontend tool/run transition.
4. On accepted response, save server message/run/sequence mapping and mark saved. Reconcile snapshots/stream by client_message_id even if they arrive before HTTP. The visible key stays stable; do not remount the bubble for a new server ID.
5. On lost acknowledgment, retry original identity/payload and resolve accepted state. Server fingerprints still protect actor/workspace/chat/payload. A duplicate response causes no second bubble/run/effect.
6. Permanent auth/validation failures stay attached to the input. A transport retry cannot invoke an execution retry for an already saved run. A failed run with partial writes keeps truthful committed steps and a receipt-aware recovery path.
7. Allow two quickly submitted messages as distinct operations without blocking the next draft. Network completion order cannot reorder accepted sequence. A delivery whose answer arrived before local acknowledgment reconciles rather than showing a stale failed bubble.

Use the durable outbox contract in section 008D when implemented; do not create a throwaway competing local queue during 008B. A small reusable local persistence interface can support the initial in-memory scenario, clearly unverified for reload until 008D.

### Commands and active runs

Move ModelControls out of Composer to the chat overflow, reuse deterministic command endpoint with presentation control. Complete selection applies once, preserves ordinary draft, refreshes effective state, and never appears as message/answer/model context. Preserve audit/source receipts. Picker lists approved configured choices, current/default state and tested available effort options. Incomplete commands collect arguments; double slash is literal text. Failed control mutation stays local and retryable.

Show Stop in the primary slot for an empty draft during a run; show Send for a valid follow-up. Stop stays accessible through chat overflow. Reuse exact visual recipes. Sending a correction does not blindly restart/stop the active run, change its pinned model or discard its committed steps. Test author-only Stop and actual steering/clarification routing; no fabricated UI success.

### Streaming and Working

Field-use addition: capture is a field-release prerequisite. Integrate the 008D scoped persistence module alongside send work rather than leaving an accepted field-capture experience memory-only. One local delivery module, no temporary second queue. An earlier in-memory prototype remains explicitly unverified for reload/offline recovery.

Latest-note milestones distinguish confirmed local persistence, server acceptance and actual filing; partial/waiting/replied are accurate outcomes, not a generic third success tick. No new tick colors/icons without an approved recipe. Add the corresponding design.md stories/tests. A validated voice transcript appears before filing finishes once gate 010 supplies it.

Append deduplicated ordered text deltas to one active Message renderer. Server snapshot catches up without replacing completed DOM. Remove transient token buffers only once an equivalent final authoritative message exists, avoiding a blank interval. A partial answer/error retains useful content. A disconnect uses cursor replay, not a second model request.

Render actual public step names with truthful labels. Internal turn:agent wrappers are not public useful tool calls. Successful receipts control Undo. Real questions appear as conversational text; reply uses the same composer. No uppercase Question badge, dashed card or duplicate prompt. Working becomes compact after terminal state and preserves manual disclosure state.

### Thinking inside Working

This is an increment inside 008B with narrowly coordinated provider normalization under 005; it is not a new gate or infrastructure project. Implement the existing [activity contract's additive fields](../docs/contracts.md#thinking-stream-target-additive-not-yet-implementation-evidence) and [design behavior](../design.md#6-streaming-working-and-questions). Changing effort and displaying provider text are independent features.

Source inspected 2026-10-04: `types.ts` already has `provider_thought_summary`; `gemini.ts` forwards text `thought_summary` deltas and ignores signatures. The worker's `handler.ts` publishes only the first eight summary events, slicing each to 8,000 characters. `Transcript.tsx` currently renders separate summary disclosures after Working rather than one nested section. The OpenCode adapter has no equivalent reasoning-text forwarding path in this inspection. These are source observations, not a fresh deployed-provider acceptance report. Reinspect before changing them.

Implement in this order:

1. **Verify the wire channel.** Preserve selected models/endpoint families and enabled state. Use current official provider docs plus sanitized existing capability probes to distinguish incremental summaries, cumulative summaries and provider-exposed reasoning. Gemini's [thinking documentation](https://ai.google.dev/gemini-api/docs/thinking) describes Interactions `thinking_summaries: "auto"`, incremental `thought_summary` events and opaque `thought_signature` events. Check exact selected-model support before adding that field; never send another endpoint's option. OpenCode's generic compatibility and effort settings do not prove a reasoning field. Unknown or absent support leaves the section absent. No additional paid probe, fallback model or automatic higher effort is implied.
2. **Normalize at the existing adapter boundary.** Carry safe displayable text, content kind, stable block identity and append/snapshot semantics. Preserve provider round/block boundaries and terminal outcomes. Opaque signatures remain in the existing server continuation path, never public text. Mock actual endpoint event shapes, including split network frames. Do not forward arbitrary JSON or guess a field by a model's branding.
3. **Publish through the existing handler.** Replace the eight-event gate with small bounded buffering and explicit aggregate text limits. Keep named nonvisual constants for flush interval, batch size and maximum display characters. Pick bounded values under existing activity/storage budgets and record them in code; they do not alter visual tokens. A timer must flush received text even when the next provider event is delayed. Serialize timed and size-triggered flushes through one publication owner, clean up timers on every exit, and final-flush authorized buffered text on end/tool boundary/error/Stop. Do not leave unawaited writes. Preserve lease/membership/fencing checks: after authority loss, rely on retained activity plus terminal state instead of making an unauthorized final write. A display cap marks truncation once and continues ordinary answer/tools. No D1 write per token, new queue, new actor or extra model call.
4. **Reduce once in the existing server-state merge.** Apply activity in durable cursor order with record-ID dedupe and stable block keys. Reconnect/snapshots must not duplicate received text, reset manual expansion or launch another inference. Repeated words in distinct deltas remain repeated words. Safely handle legacy payloads without guessing append semantics. Terminal run status resolves unfinished block state after interrupted delivery. Keep reasoning out of completed assistant text, business-memory extraction and logical tool-step counts.
5. **Render one nested shadcn/Radix Collapsible.** Within expanded Working, show one Thinking trigger only after displayable content exists. It begins collapsed and remembers manual choice through chunks/rounds/replay. Display provider attribution/content kind, sequential blocks and truthful interrupted/truncated status in existing secondary recipes. Working can render with zero tools; a completed thinking-only reply says Worked without fake step counts. No card or separate disclosure for each delta. Preserve reading position; no per-token live-region announcements. Tools keep their receipts and Undo; Thinking never gets Undo.
6. **Review the supplied mobile compositions.** The Undo sheet selects from-here versus single-action using actual previews. It is not a new routine confirmation gate. Voice recording during earlier work uses the same composer and capture Stop→Review contract under 010, not an extra recorder in 008. Typed/shortcut clarification replies use real server IDs. Saved/filing labels reflect actual stages. Implement future voice fixtures as clearly labeled contract-only until capture/server routing are built.

Decisive tests: at least 200 small provider deltas below the total cap yield complete displayed text rather than only eight chunks; cumulative snapshots never append duplicate prefixes; identical words from distinct records survive; duplicate replay adds nothing; two rounds preserve block identity/order; thinking before any tool renders; absent public output creates no empty disclosure; tool count excludes reasoning; timer flush during a paused provider; cap emits one truthful truncation indication; Stop/error/revocation/lease loss preserve safe partial content without stale writes or timers; reload reproduces retained text and expansion behavior without inference; no signature/key/raw payload reaches the browser; nested keyboard/focus and released-scroll behavior work. Reuse existing fake transports/integration suites, not a live call in unit tests.

Add every work/thinking fixture in design.md to production-component Storybook, including absent, thinking-only, mixed tools, interrupted, replay and truncation. Run normal owning checks plus browser comparison at all five required widths. Live provider evidence is separate and per exact model/endpoint. Do not claim full private thoughts, universal provider support, actual recording or deployed behavior from stories/mocks. Report explicitly which models have evidenced displayable output and which simply omit Thinking.

008B decisive tests: immediate echo under delayed HTTP; lost ack after D1 commit; HTTP/SSE order inversion; duplicate replay; failed send/retry same UUID; edited failed payload new UUID; two rapid inputs; new-chat crash/retry; newer draft survives; model/effort late-read race; commands produce no chat/LLM turns; active-run correction reaches server steering; Stop does not undo; provider failure after a write is not resend-as-new-run. Verify real local send-to-first-status-to-answer, not only mocks or changes to queue labels.

## 6. 008C: scroll, routes, viewport, language and a11y

Add sourced entity inspection within the existing DetailPane when its bounded scoped read contract is implemented. No editable lead page or second data projection. Show original reports, corrections, author/time/source, pending/disputed facts and relevant tasks/actions with readable provenance. Current projection is distinguishable from historical values. Paginate existing events/source records with stable ordering; preserve occurred-versus-recorded time where material. Revalidate membership/entity/workspace scope and unavailable/erased sources. Coordinate any missing read contract with 007; do not fetch all workspace chats into the browser to assemble a timeline. Timeline styling uses approved recipes or asks Avi about the exact missing element. This is an inspection increment after reliable send, not a prerequisite for token setup.

Replace custom follow logic with one use-stick-to-bottom owner. Near-bottom threshold is a named behavior constant, not a new visual token. Preserve reading position on new tokens, Working expansion and reconnect. Use stable DOM anchors/native overflow-anchor for earlier page insertion; compensate only when the chosen owner requires it. Do not blindly add/subtract scrollHeight in several hooks. Anchor includes message key and offset; test overlapping page requests and streaming during prepend.

Migrate existing workspace/chat URL shape through TanStack Router while preserving shared/deep links. One router replaces manual pushState/popstate ownership. Drawer Back dismissal must not navigate to another workspace or add a useless URL entry. Detail and history return preserve draft/scroll. Cancel stale data requests and detach prior stream on route change. Query cache invalidation does not reopen access after revocation.

Use the exact viewport meta; one visualViewport/ResizeObserver hook publishes viewport and measured composer dimensions, without double keyboard/safe-area subtraction. Use actual MediaQuery/touch conditions for input behavior; do not equate viewport width with physical keyboard availability. Touch targets remain non-overlapping. Verify iPhone Safari/Android Chrome keyboard, long draft, IME, orientation and zoom separately from desktop emulation.

One formatting helper receives viewer locale + workspace timezone. Use Intl for times, day separators and money, including DST boundaries and explicit RON. Source deadline interpretation remains member-timezone based. Add per-message language metadata only through the shared contract/storage/serializers if absent; don't pretend existing ChatMessage already has it. No mandatory model call just to label language.

Keep a stable role=log aria-live=polite container. The changing token subtree is aria-live=off; the log's busy/publication boundary withholds streaming announcements. Publish each newly completed accessible message once after settling, not historical loads/replay or configuration notices. Do not hide completed readable content from accessibility. DOM/axe can catch structure, but manual screen-reader checks must establish once-only announcements. Avoid duplicate announcers or per-token aria-label mutation. Never leave aria-busy stuck after failure/Stop.

008C tests: released/follow mode; Jump to latest; prepend at both positions; stream while prepend resolves; history/detail return; route/back/drawer focus; stale workspace response; IME/mobile Enter; six-line growth; changed language/locale; UTC-midnight and DST day separators; stable log completed-only announcements; keyboard-only/200% zoom/reduced motion; physical keyboard evidence. If device unavailable mark that row unverified.

## 7. 008D: local outbox and offline shell

Use idb-keyval and the existing UUID acceptance boundary. Version the local envelope and schema; scope every draft/outbox/media key by account identity, workspace and chat or stable new-chat operation. Minimum logical fields: client ID, immutable payload/fingerprint, created instant, state, attempt count/next retry instant, optional server mapping and clarification/run reference. Local delivery metadata is not business state or permission.

Keep one flush owner per browser/account, serializing each chat's pending messages. Use a simple shared browser lock where available with a tested fallback, or a small atomic IndexedDB claim; do not introduce a lock service. Same UUID still protects duplicated cross-tab requests, but local duplicate claims must not create storms or corrupt status. idb-keyval single-key operations are not a multi-record transaction guarantee.

Flush on online and visible foreground. Backoff honors Retry-After and separates transient network/rate failures from permanent validation/auth failures. Retries are bounded/configurable with user-visible state; no endless background loop. navigator.onLine is only a hint. A stale clarification or membership error stops and asks the user to review, never reroutes to another chat/workspace. Unsent messages can be discarded locally; that cannot unsend an accepted message.

PWA caches versioned static shell/fonts/assets only by default. Exclude /api, authentication, streams, private R2 audio, provider traffic and credentials. Never persist keys in browser storage. Offline shell explains connectivity; it cannot assert a renewed session/membership or call a model. Show an update prompt when safe; do not auto-reload during send/recording. Clear owner-scoped query/local data on logout, account change and revocation; protect delayed worker/flush callbacks with current generation/identity.

Do not promise local-storage encryption, unlimited capacity, background delivery or recovery after browser eviction. On storage/quota failure retain recoverable in-memory content and explain the limitation. Voice chunk records reuse the same local module in 010; gate 008 does not implement a second recorder or STT client.

008D tests: offline shell after first cache; offline send→reload→foreground→one saved message; multiple queued inputs ordered; cross-tab flush; lost ack; changed account; revoked membership; obsolete clarification; storage exception; app update during draft/send; no private API/audio/key in service-worker cache; no closed-page delivery claim. Test both offline emulation and actual weak-network use where available.

## 8. Evidence and completion

At each checkpoint run pnpm typecheck, pnpm lint, pnpm test and pnpm build. Once introduced also run pnpm check:design and the actual Storybook build script added by 008A; record their real names/results. Do not list planned commands as executed.

Create one record under docs/reviews/<date>-008/ with baseline/new commit or exact working diff, environment, fixture IDs, native browser/device, viewport, screenshots, observations, failed/blocked checks and disposition. Reference token section 12 explicitly. Required widths: 360×800, 390×844, 900, 1280, 1440; record heights for the latter three. Cover pending/failure/long content, not five screenshots of the same empty chat.

Render-story evidence, integrated local-browser evidence and deployed/provider/device evidence are separate. No Playwright. Contract-only future stories stay unimplemented. Update plans/README.md and docs/browser-review.md only for checks actually performed. Do not mark this new baseline DONE based on earlier suites/screenshots. No runtime change, installation, commit, deployment or test execution is claimed by this documentation handoff.
