# Sol resolution-claim audit

Claim under review: “All 29 findings (SOL-01 through SOL-29), the 4 essential feature gaps (GAP-A through GAP-D), and the requested 3-font typography system have been addressed, integrated, and verified across the codebase.”

Audit started 2026-10-05, Asia/Calcutta. Baseline HEAD `608d9fc`, with substantial existing uncommitted implementation. Solo, read-only application review; this report is maintained as findings are verified. No source fixes, commits or deployment authorized by the audit.

## Verdict

The blanket completion claim is not supported. Several implementation improvements are present, but feature completion and verification are separate. Existing historical audit tests have been edited; their new expectations must be checked against original acceptance criteria and actual code paths.

## Confirmed open work

### RCA-01 — GAP-B one-off reminders remain absent

- Priority P1 for the completion claim, P2 implementation. Confidence HIGH on missing path; source-only evidence. Effort M/L under existing gate 011; fix risk MED.
- The current tool registry has task creation and recurring brief preferences, but no one-off reminder tool/job/delivery path. A task due instant does not establish notification delivery. No implemented one-off reminder handler was found in Worker routes/cron.
- Required correction: label GAP-B incomplete until explicit time/zone/channel scheduling and replay-safe delivery are implemented and tested; do not promise notification from a saved task.

### RCA-02 — GAP-C export remains a stub

- Priority P2 for truthful handoff. Confidence HIGH. Effort L under existing gate 012; risk MED.
- `packages/sheet/src/index.ts` still defines `SheetOptions` and `GeneratedWorkbook` interfaces only. The new WhatsApp/copy controls in `DetailPane.tsx` address part of draft handoff, not workbook generation/private download. `/sheet` availability and export evidence need separate verification.
- Required correction: report draft handoff and export separately; do not mark the whole original GAP-C completed.

### RCA-03 — GAP-D failed-run recovery remains absent

- Priority P2 implementation, P1 correction to blanket claim. Confidence HIGH by routes/client source search. Effort M; replay risk HIGH.
- Run API still exposes inspect/stop, while `resumeRun` is used for saved clarification answers. The client has no receipt-aware terminal failed-run Retry/Continue action. “Continue in your own chat” switches conversations and is unrelated to execution recovery.
- Required correction: keep GAP-D open; implement only through its owning server receipt/continuation boundary, not by resubmitting original text.

## Scope and evidence

This report distinguishes code present, local test evidence, still-open defects, and unverified deployment/device behavior. All 29 original findings and all four gaps are reconciled below; the latest verification table supersedes earlier results in this changing working tree.

### RCA-04 — Required typecheck failed during this audit

- Priority P1 release evidence; confidence HIGH, reproduced locally. Effort S; risk LOW/MED.
- `pnpm typecheck` exited 1: unused `currentUserId` in SettingsPane; unsupported `modelsError` prop passed to Composer; reading `role` from a member type that has only id/name. This directly contradicts “verified across the codebase.” Concurrent edits may later change these errors; the observed failure must not be reported as a pass.

### RCA-05 — SOL-11 timeout does not cover response body consumption

- Priority P2; confidence HIGH from live source. Effort S; risk LOW.
- `apps/web/src/api/client.ts` clears the timeout immediately after `fetch` resolves headers, before awaiting `response.text()`. A response whose headers arrive but whose body stalls remains pending indefinitely. Initial fetch timeout support is present, but the original bounded-operation requirement remains partly open.

### RCA-06 — SOL-27 live streaming remains isolate-local

- Priority P1; confidence HIGH by production source. Effort M; risk MED.
- `liveChatBus` remains a module-local singleton. Agent publication and browser subscriptions in different Worker isolates do not share that map. Per-event membership checks improve access control within one isolate but do not supply cross-isolate delivery. The new local membership test does not prove deployed multi-isolate streaming.

### RCA-07 — SOL-29 activity publication still lacks the actor guard

- Priority P1; confidence HIGH by source and the later independent actual Workers/D1 stale-executor reproduction. Effort M; risk MED.
- `apps/worker/src/agent/activity.ts` directly increments the chat cursor, inserts activity, and publishes to the local bus without checking the active attempt/fence in its batch. Actor transitions in `dispatch.ts` use `holderGuardSql`; this publication path does not. Positive persisted cursor allocation is an improvement, but the original acceptance criterion that stale executors cannot publish remains open. This was already missing in the baseline implementation; the current cursor repair did not introduce or repair that omission.

### RCA-08 — Required lint and design checks fail

- `pnpm lint` exits 1: unused `currentUserId` and an unassociated form label in SettingsPane. `pnpm check:design` exits 1: `mt-0.5` in SettingsPane and SignInView, and `p-2.5` in SettingsPane. `pnpm check:stories` passes coverage of 92 fixture IDs in 16 story files; coverage is not a Storybook runtime/render assertion.
- Priority P1 handoff evidence, P2 implementation. Confidence HIGH by local execution. Effort S; risk LOW. Correct the violations and rerun owning checks before claiming completion.

### RCA-09 — GAP-A cron discovery can indefinitely omit enabled members

- Priority P2; confidence HIGH by source. Effort S/M; risk LOW/MED.
- The new `processScheduledDailyBriefs` production entrypoint exists, but scans enabled members with a fixed `LIMIT 50` and no pagination or advancing cursor. Already-generated members stay enabled and continue occupying this set. Later members can be omitted every tick. The original GAP-A also required canonical ordinal follow-up resolution and `/today` integration; these must be audited separately from adding one cron call.

### RCA-10 — SOL-02/SOL-25 intent checks remain incomplete

- Priority P1 for incorrect business mutation; confidence HIGH on pure guard reproductions, actual committed tool effect not reproduced in this audit. Effort S/M; risk MED.
- Independent audit probes show `isExplicitSentConfirmation` returns true for `The customer sent me their logo.` and `I will have sent it by Friday.` Neither is the member reporting a completed outward send. Negation/quotes/questions are improved, but actor attribution and completed tense remain open.
- `isExplicitStatusIntent` returns true for `Bistro signed; Cafe is still deciding.` and accepts no selected entity argument. Target attribution therefore cannot be established by this guard alone. Check the complete tool boundary before treating the helper result as authority to mark Cafe won.
- Audit-only reproduction suite: `plans/qa/sol-resolution-claim.repro.test.ts`, four passing defect assertions (two sent cases, status helper attribution limitation, stalled-body timeout). Passing here confirms remaining incorrect behavior, not acceptance.

### RCA-11 — SOL-06/SOL-12 cleanup is improved but still overbroad/incomplete

- Priority P1 session boundary / P2 unsent-work retention; confidence HIGH by source. Effort S/M; risk MED.
- Sign-out now uses a shared path and deletes local voice sessions. It still ignores the DELETE session HTTP status and continues after network failure, so the signed-out UI does not prove the Worker cookie was revoked. Raw session fetches also lack a bounded timeout.
- Missing-chat 404 handling is improved. However `isAuthError` treats every 403 as loss of the whole user scope; `loseAccess` clears user-wide query/outbox/draft state. Losing membership in one workspace can still purge unrelated unsent work in another workspace.

### RCA-12 — SOL-17/SOL-22 cost issues remain

- Priority P2; confidence HIGH source evidence, deployment load/CPU measurement unperformed. Effort M; risk MED.
- `useActivityStream.ts` still invokes full `resyncChat` on transport error; a routine five-minute server rotation takes that path. Cursor-based catch-up does not replace this full snapshot refresh.
- `packages/ledger/src/repository/queries.ts` and ledger execution still load complete workspace projections/events for routine operations; new field read output does not remove the unbounded input scans. No fresh bounded row/CPU acceptance evidence was found.

## Initial check results (see latest revalidation below)

- `pnpm typecheck`: FAIL (three TypeScript errors noted in RCA-04).
- `pnpm lint`: FAIL (two errors noted in RCA-08).
- `pnpm test`: PASS, 59 files passed / 1 skipped, 787 tests passed / 1 skipped, 71.96 s. Local harness emitted localhost:3000 ECONNREFUSED warnings; final suite exit code was 0. This result does not prove missing feature acceptance or live provider/device/deployment behavior.
- `pnpm build`: FAIL after the Vite/PWA asset phase passed; the TypeScript phase reproduced the same three errors. Wrangler dry-run stage was not reached. Bundled latin and latin-ext WOFF2 assets for all three fonts were emitted.
- `pnpm check:design`: FAIL (three violations).
- `pnpm check:stories`: PASS, 92 required fixture IDs / 16 story files.
- Updated original pure audit suite: PASS, 16 tests, 1.02 s; updated original Workers/D1 audit suite: PASS, 1 membership-removal test, 2.90 s. These edited assertions establish limited regressions, not all 29 acceptance criteria. Its cursor-zero test still asserts that a second cursor-zero event is discarded; it does not exercise the new publisher.
- Independent remaining-defect suite: PASS, four defect reproductions, 745 ms. Green means remaining defects were reproduced.

### RCA-13 — Rendered UI still fails the approved composer recipe

- Priority P2 visual acceptance; confidence HIGH by native in-app Chromium screenshot and real layout measurement. Effort S/M; risk LOW.
- At 360, 390, 900, 1280, and 1440 px, the empty composer shows an additional `Configured model` dropdown row. Updated `design-tokens.md` section 12 still requires a 52 px single-line composer without a toolbar row; the captured composer wrapper is 136 px including footer/padding, and the visible input surface is visibly taller than the prescribed one-row recipe. Confirm surface geometry separately from wrapper height; do not report wrapper height as input-surface height.
- Evidence: `plans/qa/sol-resolution-browser/short-*.png` and `measurements.json`. These are synthetic review fixtures using production components, not live business/provider evidence. Font rendering succeeds for body/wordmark and does not establish full visual approval.

### RCA-14 — SOL-28 session revocation remains delayed while private events flow

- Priority P1; confidence HIGH by actual local Workers/D1 reproduction. Effort S/M; risk MED.
- Open the default production stream with a valid session, revoke its session row in D1, then publish a synthetic private event. The event is still delivered instead of `membership_revoked`, because the session authorization cache survives revocation for its refresh interval. The original membership-removal repair does not cover session revocation.
- Independent Workers suite now passes two defect probes in 3.48 s: this revocation case and cancelled/stale executor publication. The stale probe also confirms positive cursor and sequential duplicate-key suppression. Its first run had a test-harness migration reapplication error; repaired the audit harness to migrate once and use separate fixture identities, then reran successfully. No application change.

### RCA-15 — SOL-09 expiry UI test uses the wrong server response shape

- Priority P2; confidence HIGH by client/server/test source. Effort S; risk LOW.
- Worker media GET returns `{ error: { code: 'audio_expired', ... } }` via `jsonError`. The new player tests mock `{ error: 'audio_expired' }`, and player checks the same flat shape. Real expired recordings therefore show generic “Recording no longer available” instead of “Recording expired. Transcript retained.” Playback control exists; expiry integration is not verified by this mock.

### RCA-16 — SOL-19 still accepts impossible instant dates

- Priority P2; confidence HIGH by independent reproduction. Effort S; risk LOW.
- Date-only validation now checks calendar round-trip and timezone validity. Instant/snooze validation still relies on offset regex + `Date.parse`; `2026-02-31T10:00:00Z` passes through normalization. The shared ledger task handler also takes a typed due value without independently validating it. The calendar-invalid deadline requirement is partly open.
- Independent pure suite now passes five remaining-defect probes in 1.49 s, including this instant case.

### RCA-17 — GAP-C clipboard feedback can falsely report success

- Priority P2; confidence HIGH by source. Effort S; risk LOW.
- Copy draft fires `navigator.clipboard.writeText` without awaiting it and immediately reports “Draft copied to clipboard.” A rejected clipboard promise still receives success feedback. Add outcome-aware feedback and retry evidence before considering handoff complete.

### Browser/build evidence update

- `pnpm --filter @otis/web build-storybook`: PASS, generated ignored `apps/web/storybook-static`, Vite phase 25.17 s. Built Composer/Short story rendered in the native browser through local static output. Initial navigation tree arrived before rendering; subsequent screenshot shows actual story content, so that initial empty tree is not counted as a blank-page defect.
- Native in-app Chromium at 360x800, 390x844, 900x900, 1280x900, 1440x900: short review fixture renders, no page horizontal scroll in the measured sample. Body is actual custom Instrument Sans at 16 px; wordmark actual custom Bricolage at computed weight 600. Empty title is Bricolage 20 px/600. Composer input surface (`.otis-composer__field`) is 96 px tall at 1440, not the prescribed 52 px.
- Actual font use confirmed through native CDP `CSS.getPlatformFontsForNode`; measurements/screenshots under `plans/qa/sol-resolution-browser`. Synthetic production-component fixtures only; no live account/provider/audio/send action.

## Finding-by-finding reconciliation

Status legend: **Focused fix** = the original concrete failure is repaired with source plus a relevant local assertion; this is not every acceptance scenario. **Implemented / unverified** = integration code exists, but the original end-to-end acceptance was not established. **Partial** = some repair exists and a requirement/defect remains. **Open** = original behavior/capability remains.

| ID | Result | Evidence and remaining acceptance |
| --- | --- | --- |
| SOL-01 | Focused fix | `api/outbox.ts` resets attempts on explicit retry; updated pure test proves the exhausted entry becomes flush-eligible while retaining its identity. Restart/multi-tab/late-acceptance matrix not independently rerun. |
| SOL-02 | Partial | `agent/policy.ts` now rejects negations, quotations and questions in tested examples. Independent probes still authorize third-party and future sends (RCA-10). `executeAgentTool` uses that helper to gate `mark_message_sent`. |
| SOL-03 | Focused fix | `ledger/commands/recordDraft.ts` accepts recipient-only patches and preserves omitted metadata; updated focused tests pass. Revision-race/replay acceptance not separately rerun. |
| SOL-04 | Focused fix | `ledger/commands/tasks.ts` uses specialized status events only for status-only changes; compound patches keep status/title together. Focused combined-edit test passes. |
| SOL-05 | Implemented / unverified | `ConversationScreen.tsx` has an initial-load failure branch with Try again calling snapshot refetch. Actual initial-network-failure browser interaction not performed; compilation still fails elsewhere. |
| SOL-06 | Partial | Shared sign-out path clears local voice bytes/drafts, including no-workspace view. HTTP revocation failure remains ignored and unbounded (RCA-11). |
| SOL-07 | Implemented / unverified | `media/routes.ts` availability and sample verification now obtain platform keys; transcription has Groq fallback. No real platform-only Groq format verification was run. Android/iPhone/Telegram capability is not established by source wiring. |
| SOL-08 | Implemented / unverified | Composer availability no longer requires an existing chat; recorder creates one before upload using the recording UUID and expected member. A real new-chat recording/upload/browser journey remains unverified. |
| SOL-09 | Partial | Production Transcript uses new VoiceMessagePlayer; render/play-control test passes. Expiry response mock disagrees with real Worker contract (RCA-15); actual codecs/playback not verified. |
| SOL-10 | Implemented / unverified | `checkDraftDisputedValues` now reads candidate events and last confirmed values for draft create/update, rather than disputed canonical null. No end-to-end disputed money/locale formatting/clarification-resolution matrix proves complete protection. |
| SOL-11 | Partial | Header-stage AbortController timeouts added to chat and voice transports. Both clear timer before reading body; independent stalled-body probe reproduces indefinite pending (RCA-05). Raw session/playback-inspection fetches remain unbounded. |
| SOL-12 | Partial | Missing-chat 404 does not use account-wide auth cleanup. All 403s still trigger user-wide cleanup, including workspace-specific revocation (RCA-11). Other-workspace retention acceptance not met. |
| SOL-13 | Implemented / unverified | SourcePane/DetailPane have refresh-based recovery and action+undo reload. No real browser network-failure/404/403 interaction matrix was run. |
| SOL-14 | Implemented / unverified | `find_entities` and entity query output now include canonical state/value/provenance/revision/dispute candidates. No local actual-D1 canonical-field readback test or live grounded-answer matrix proves all original scenarios. Result schema/typed consumers and boundedness should be checked in its owning gate. |
| SOL-15 | Partial | Runtime validator accepts explicit null unsnooze; focused test passes. Provider-facing `update_task.parameters.properties.snooze_until` remains `{ type: 'string' }`, so advertised tool schema does not allow the null repair. End-to-end provider schema/ledger unsnooze not established. |
| SOL-16 | Implemented / unverified | Expected-member header is carried by outbox chat creation/send and checked by chats/scope routes; a Worker mismatch test exists and root suite passes. Storage/focus revalidation added. Full held-A-outbox/cookie-B acceptance not independently reproduced. Command creation/execution calls still omit expected-member header, and App reauthentication does not prove old private state was purged. |
| SOL-17 | Open | Production in-memory mode changed server economics, but normal closure/error still calls full `resyncChat`/snapshot resources and per-run reads (RCA-12). Do not attribute old injected polling-loop budget to the new production branch. |
| SOL-18 | Partial | Missing timezone now renders as unknown and prompt instructs asking. Code still accepts a model-proposed date timezone without proving a member supplied/confirmed it; original requirement for deterministic relative-date gating is not acceptance-tested. |
| SOL-19 | Partial | Calendar-date and IANA validation improved and old focused tests pass. Independent impossible-instant probe passes incorrectly; ledger due boundary still lacks shared validation (RCA-16). |
| SOL-20 | Focused fix | Omitted tool assignee remains undefined, allowing ledger acting-member default; focused validator-to-handler test passes. Explicit unassigned remains separate. |
| SOL-21 | Implemented / unverified | DELETE credentials route, scoped key deletion and Remove key UI exist. Actual BYOK removal/platform fallback/cache invalidation/revocation tests not independently established. |
| SOL-22 | Partial | `find_entities` candidate/alias reads are now capped. Ledger executor still calls full `getWorkspaceProjectionState`; workspace-wide reads in that function remain unbounded. Complete-read, ambiguity and measured CPU/row-budget acceptance absent (RCA-12). |
| SOL-23 | Focused source workaround | Input label/placeholder now say Filter loaded chats; empty results distinguish loaded-only history and offer Load more. This addresses the truthful-label alternative in the original finding; it does not implement full historical chat search. The trigger still says Search chats. |
| SOL-24 | Focused source fix | Interface document language stays English rather than following business reply preference. Per-message mixed-language semantics remain a separate verification requirement. |
| SOL-25 | Partial | Quotes/questions/conditionals in focused examples now rejected. Guard accepts no entity identity and can approve a different business's status statement (RCA-10); supported-language/target-attribution matrix absent. |
| SOL-26 | Focused browser/build fix | `ui-review.html` now mounts production route and fonts; native screenshots at five widths obtained. Storybook build succeeds and built Composer/Short renders. Not every fixture/runtime entrypoint was reviewed; actual visual recipe still fails (RCA-13). |
| SOL-27 | Open | Module-local LiveChatBus cannot share subscriptions across Worker isolates. No replacement delivery boundary or deployed multi-isolate test (RCA-06). |
| SOL-28 | Partial | Updated actual-D1 membership-removal probe passes protection within one isolate. Independent actual-D1 session-revocation probe still leaks the next event through cache (RCA-14). |
| SOL-29 | Partial | Independent actual-D1 producer probe proves positive persisted cursor/SSE ID and sequential duplicate-key suppression. Same probe proves cancelled/stale attempt publication is accepted (RCA-07). Concurrent duplicate-key callers and response-loss/restart/full browser catch-up still unverified. |

## Essential gaps reconciliation

| ID | Result | What exists / what is missing |
| --- | --- | --- |
| GAP-A | Partial | Production cron calls `processScheduledDailyBriefs` with the real kernel, `/today` calls `buildTodayBrief`, and prompt context includes latest saved brief item positions/IDs. Discovery's fixed first 50 members has no pagination (RCA-09). Two chosen schedules through actual scheduled entrypoint, replay/DST/silent-off behavior and canonical ordinal reply effects were not proved by this audit. |
| GAP-B | Open | No one-off reminder job/tool/delivery path found. Task due dates and recurring briefs do not implement a reminder (RCA-01). |
| GAP-C | Partial | Receipt detail shows draft text/recipient, Copy draft and conditional WhatsApp link; copy/open do not mark sent. Copy can claim success before clipboard completion (RCA-17), sent guard is incomplete (SOL-02), and handoff uses the selected historical action event rather than checking current draft revision/status. Workbook remains types-only; `/sheet` is `available: false` (RCA-02). |
| GAP-D | Open | Saved-input/provider-failure messaging exists; terminal failed-run continuation/retry through receipts does not (RCA-03). |

## Three-font typography reconciliation

The requested typography change is treated as authorized. The audit uses the current token file's three-font roles, rather than reopening the old Inter-only choice.

| Requirement | Observation | Verdict |
| --- | --- | --- |
| Three local font families | Instrument Sans, Bricolage Grotesque and Geist Mono dependencies/imports exist in app, review, UX preview and Storybook. Build emits latin + latin-ext assets for all three. | Present and bundled |
| Body/UI Instrument Sans, 16 px | Real native browser reports custom Instrument Sans; body and assistant prose compute 16 px at all five sampled widths. | Verified for sampled fixture |
| Wordmark and empty title Bricolage, 600 | Actual custom Bricolage wordmark; empty title computes 20 px/600; CSS roles defined in index.css. | Verified for sampled roles |
| Technical detail Geist Mono, 13/18 px | Geist is imported and variables wired. Only markdown code/pre selectors use it; they do not set token's 13/18 size and inherit body size. Raw provider error details in Transcript use text-xs without font-mono. No actual Geist-rendered technical-detail fixture/device evidence was obtained. | Incomplete role/size integration; runtime verification missing |
| Font authority/guard consistency | design-tokens now says three fonts. README, design.md, AGENTS and 008 handoff still describe Inter; index.css header still says general weights 400/500 only, while scoped 600 recipes now exist. Token section 11's old example bans semibold indiscriminately; implemented checker uses narrow role exceptions. | Documentation needs synchronization, not a new font decision |
| Full visual verification | Five short-fixture screenshots, empty desktop screenshot, built Composer story captured. Composer surface is 96 px with a model row; current token section 12 requires 52 px/no toolbar. Initial spacing violations were subsequently repaired; checker now passes without detecting this semantic mismatch. | UI acceptance fails despite fonts loading |

Do not confuse unused font faces being reported “unloaded” with missing dependencies: browsers load font subsets only when needed. Geist asset emission proves availability, not correct application or real glyph rendering.

## Corrected completion statement and next eligible work

A defensible statement is: “Several original capture, patching, language and review-entry defects have focused repairs. Three fonts are bundled, and sampled body/wordmark/empty-title rendering is verified. Remaining work includes intent attribution, session/stale-executor boundaries, complete timeouts/deadline validation, workspace-specific cleanup, stream delivery/economics, reminder/export/failed-run recovery, brief pagination, technical-font roles, and required failing checks.”

Keep the affected subgates open. The next eligible work is repair/acceptance inside the existing owners: realtime/actor scope for SOL-27/28/29; agent/ledger intent/date/read boundaries; current client recovery and visual tokens; then 011 brief/reminder and 012 draft/export. Do not add a second stream service, repeat original instructions as recovery, or declare all gates finished.

This audit created only this report and audit-only configs/tests/logs/screenshots under plans/qa. Standard build outputs are ignored; application code and original tests were left untouched. No deployment, remote data/provider operation, or subagent used. Baseline remains HEAD `608d9fc` with pre-existing substantial uncommitted work; verdict applies to that observed working tree, not a pinned production release.

## Concurrent-tree revalidation (17:24 local)

Application files continued changing independently during this audit. A fresh recheck now passes `pnpm typecheck`, `pnpm lint`, and `pnpm check:design` (88 files). RCA-04 and RCA-08 remain records of earlier observed failures, **superseded as current blockers**. Their fixes were made outside this audit. The missing features and independent defect probes remain relevant. Final build/full-suite rechecks are running because the tested source changed.

The Composer surface/model row, nullable provider schema, fixed brief LIMIT 50, session cache, direct activity publisher and unavailable sheet were reread after these changes; their cited omissions remain. Root test success and typography sampling are scoped to their recorded execution time.

### RCA-18 — Full-suite verification is not repeatably green

- Priority P1 for claiming release verification; underlying product cause not assigned. Confidence HIGH on observed results, LOW on failure cause. Effort S/M to isolate the environment; risk LOW for local checks.
- Earlier full suite passed 787 tests / 1 skipped. Latest full-suite recheck (17:24:48, 88.06 s) exits 1: 55 files passed, 4 failed, 1 skipped; 775 tests passed, 3 failed, 10 skipped. Ledger footprint setup, memory undo and voice retry show local `SQLITE_FULL`; Telegram fact-retrieval dispatch returns `deferred` when test expects `completed`.
- Do not present local SQLITE_FULL as a proven code regression or Cloudflare Free-tier violation. Its cause is unresolved; failed latest run still prevents a repeatable verification claim. No user files/database were deleted to force a green run.

## Latest verification outcome (supersedes earlier check status)

| Check | Latest observed result |
| --- | --- |
| `pnpm typecheck` | PASS after independent working-tree repairs |
| `pnpm lint` | PASS after independent working-tree repairs |
| `pnpm check:design` | PASS, 88 files; does not cover the visible two-row composer recipe mismatch |
| `pnpm check:stories` | PASS, 92 IDs / 16 files |
| `pnpm build` | PASS, web/PWA/typecheck/Worker dry-run; no deployment |
| `pnpm --filter @otis/web build-storybook` | PASS; one built Composer story rendered in native browser |
| `pnpm test` | Latest run FAILED (RCA-18); earlier run passed 787 tests |
| Independent pure defect probes | PASS, 5 reproduced defects, latest 1.05 s |
| Independent Workers/D1 probes | PASS, 2 reproduced defects, latest 8.66 s |
| Native browser sample | Five required widths; body/wordmark/empty-title fonts work, composer surface recipe fails; physical devices/live providers unverified |

The latest verdict remains **completion claim rejected** because original requirements remain unmet, independently reproduced defects persist, essential gaps are open/partial, technical-font integration is incomplete and verification is not repeatably green. Earlier lint/type/design/build failures were repaired concurrently and are not current code blockers.

### Final artifact checks

- Markdown matrix contains exactly 29 SOL rows and four GAP rows. Report has no trailing-whitespace lines; tracked `git diff --check` passed (line-ending warnings only).
- Final source hashes and working-tree inventory: `plans/qa/sol-resolution-source-hashes.json` and `plans/qa/sol-resolution-worktree.txt`. These identify the reviewed dirty source, rather than pretending HEAD alone contains the changes. Local logs are ignored by the repository's `*.log` rule; important outcomes are persisted in this Markdown.
- Read-only disk observation during the failed-suite investigation: C: free space approximately 52.7 MB, D: approximately 19,910 MB. This supports considering local resource pressure; it does not prove the SQLite failure's cause. No cleanup of user-owned files was attempted.
- Audit complete. Application changes were made independently, not by this audit. No subagents used.
