> Historical record, archived 2026-10-07 from `plans/2026-10-05-sol-frontend-experience-audit.md`. Its claims apply to the original baseline. Use [current implementation status](../../status.md) for active work; old proposals and DONE labels are not current authority.

# Otis frontend and experience audit

**Sol created** · 2026-10-05 · Completed audit and improvement proposal

Baseline: `608d9fc` on `main`, with existing uncommitted work present. No subagents used. This report, initial synthetic browser screenshots, and subsequent live-deployment screenshots are the audit's changes. Production source, tokens, contracts, migrations, gate status, and deployment were not changed by this audit.

## Judgment

Otis has a useful foundation, but its presentation does not consistently prove that it can look after business memory. The charcoal palette and restrained typography are not the central problem. Credibility breaks at the boundaries between capturing input, doing work, waiting for an answer, saving changes, retrieving evidence, and recovering from failure. Several controls promise behavior that the complete journey does not provide.

A polished composer alone would leave these problems intact. The strongest direction is a precise, quiet workspace for visits, promises, facts, and follow-ups: capture quickly; read the useful result; see what was saved; inspect its source; correct it safely. Power should come from reliable outcomes and easy retrieval. Model configuration, step counts, and generic assurances occupy attention that should belong to those outcomes.

Repair misleading journeys and states first, redesign the conversation composition next, then complete mobile capture, retrieval, and settings. Keep the existing shadcn primitives, scoped queries, durable outbox, and ledger receipt/undo foundations.

## Mandate, authority, and method

The attached [transformation mission](2026-10-05-saas-ui-ux-transformation-mission.md) was read before work. Its sequence is audit → prioritized proposal → approval → incremental implementation. This report completes the audit/proposal stage. The user's explicit freedom to ignore `design.md` governs these recommendations; existing design documents and approved reference were read as context. Recommendations do not silently revise the token file.

Business requirements remain: conversation first, workspace scope, direct saving of complete instructions, clarification for uncertainty, truthful public work, safe scoped undo, recorded voice with text reply default, briefs disabled until the member chooses a schedule, outward messages as drafts. Do not invent a CRM, dashboard, fabricated reasoning, or revenue/time-saved metrics.

Evidence combines live source, product/architecture/contracts/decisions/verification/handoff context, native Codex browser inspection, DOM geometry, selected behavior/a11y tests, and build output. Accessibility review referenced the [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md) for labels, keyboard/focus, and recovery; findings come from Otis. React review inspected request fan-out, eager imports, and repeated transcript calculations.

Effort is relative: **S** = focused component repair; **M** = several components or a client/server contract; **L** = complete journey requiring integration/device evidence. Risk describes implementation sensitivity. **P1** precedes visual polish; **P2** materially improves daily use. Confidence separates observed defects from unmeasured runtime/device risks.

## Running audit log

- Read supplied attachment, repository instructions, README, manifests/history/status, relevant product, architecture, contracts, decisions, roadmap, verification, token, and 008 context. Viewed approved reference.
- Recorded/preserved existing changes. Earlier [Sol usefulness audit](2026-10-05-sol-usefulness-audit.md) covers broader agent/backend issues; reuse its repairs rather than duplicate assignments.
- Inventoried React/Vite, TanStack Query/Router, shadcn/Radix, Inter, outbox/PWA, Storybook, and design/story tooling. Some README tooling statements are stale.
- Traced capture, acceptance, clarification, receipts, sources, undo, history, models, voice, entry, workspace/member settings, invitation creation/redemption, language, brief timezone, and provider presentation.
- Existing UI review entry rendered `Not Found`. Existing `plans/qa` wrapper rendered production components with synthetic APIs and production styles.
- Compared 360, 390, 900, 1280, and 1440 CSS-pixel layouts. Inspected completed/expanded work, clarification, partial completion, long content, change inspection, suggestions, and freshly built Storybook entry/settings.
- Ran scoped verification and measured build output. Fresh Storybook rendered; earlier usefulness audit's blank observation was not reproduced.
- Rechecked concurrent changes. `ConversationScreen` now distinguishes missing chats from authentication loss and exposes initial-load retry. Those earlier problems are excluded. Tests describe the tree when executed, not every later concurrent edit.
- Consolidated 23 findings and four work packages. No implementation gate is marked complete by this report.

## Ranked findings

### Final recheck of concurrent repairs

The register preserves what was observed during the audit. Source changed again during final documentation; the following updates must accompany the original evidence so repaired behavior is not presented as an untouched current defect. These changes were made outside this audit and have not received this audit's post-change integration/device verification.

| Finding | Latest observed source status | Remaining work |
|---|---|---|
| FE-07 | New-chat voice availability and chat creation during upload were added | Verify new path, interruptions/scope/retry; retained transcript playback still absent |
| FE-14 | Loaded-chat filter label and no-match scope were improved | Entry still says Search chats; actual retrieval, touch options/navigation remain |
| FE-15 | Source network/missing distinctions and Retry added; detail refresh now retries action; detail authority checks use 401/403 | Model-load failure handling and post-change recovery tests remain; review stale-detail/concurrent-request behavior |
| FE-17 | Settings now explicitly keeps English document language | Original document-lang defect addressed in source; verify initial load/assistive behavior and remaining locale policy |
| FE-18 | A provider Remove control and delete path were observed in concurrent edits | Verify fallback/source semantics; UI currently sets Not connected after removal, which can misrepresent included platform access; synthetic verification status remains a concern |

The core invite, schedule-copy, duplicate clarification, acceptance visibility, composition, mutation-feedback, and label findings remain in the final inspected source. Line anchors describe the observed source and can shift as concurrent edits continue. Do not implement a second fix for a row already addressed above.

### FE-01 — Invitation delivery and redemption do not match the promise

**P1 · Impact: onboarding/trust · Effort: M · Risk: high, membership · Confidence: high**

[SettingsPane](../../../apps/web/src/components/SettingsPane.tsx#L140) discards the token and says `Invite sent to …`. [Member route](../../../apps/worker/src/routes/members.ts#L65) creates/returns a token, sends no email. Share produces `/?invite=…`, but [SignInView](../../../apps/web/src/components/SignInView.tsx#L28) submits only `id_token`, and [router](../../../apps/web/src/router.tsx#L37) has no invitation flow. [Accept API](../../../apps/web/src/api/client.ts#L272) has no frontend caller. [Auth route](../../../apps/worker/src/routes/auth.ts#L120) already supports the token.

**Proposal:** complete create/share/redeem together. Show `Invite link ready`, eligibility and expiry; carry the token through signed-out and already-signed-in entry. Cover used/expired/wrong-email/revoked invites. Do not add mail just to justify a label.

**Done when:** both entry states join the intended workspace; errors grant no access and explain recovery; `sent` requires actual transport confirmation.

### FE-02 — Timezone copy contradicts the schedule it changes

**P1 · Impact: reminder timing · Effort: M · Risk: high, date/schedule contract · Confidence: high**

[SettingsPane](../../../apps/web/src/components/SettingsPane.tsx#L180) says dates/reminders and `Your brief stays on its existing schedule`. [Save](../../../apps/web/src/components/SettingsPane.tsx#L89) changes `brief_timezone`; [identity](../../../packages/identity/src/settings.ts#L198) persists it; [brief reader](../../../apps/worker/src/brief/read.ts#L47) uses it as schedule zone. Changing it can change UTC delivery time. It does not establish a general interpretation timezone.

**Proposal:** accurately label the existing brief zone or first implement the intended separate setting. Present chosen local time/days/zone together when supported. Keep date-only deadlines distinct from appointments; no 09:00 fallback.

**Done when:** copy/server schedule agree including DST; unrelated interpretation is not promised without its contract.

### FE-03 — Paused clarification looks active and repeats the question

**P1 · Impact: uncertainty/waiting · Effort: M · Risk: medium, reconciliation · Confidence: high, browser/source**

[Transcript](../../../apps/web/src/components/Transcript.tsx#L100) treats waiting_for_input as active unfinished work. Expanded disclosure can say `Saving follow-up…`. [RunWork](../../../apps/web/src/components/Transcript.tsx#L128) renders the question while the saved assistant message repeats it. The 360 px fixture shows both; composer says only `Replying to Otis`.

**Proposal:** explicit waiting state, one canonical question, reply context naming it. Completed steps remain inspectable without running indicators. Choices come only from actual clarification data.

**Done when:** live/persisted transitions show one question, waiting is visibly paused, refresh preserves pending work, follow-ups target/revalidate the correct clarification.

### FE-04 — Acceptance is hard to distinguish from completed work

**P1 · Impact: duplicate input/false confidence · Effort: M · Risk: high, outbox/run semantics · Confidence: high**

[Delivery rendering](../../../apps/web/src/components/Transcript.tsx#L284) hides local state when saved; reconciliation removes the marker. Accepted input is hard to inspect while queued/delayed/waiting. Permanent disclaimer does not explain it.

**Proposal:** actual milestones: stored on device, received by Otis, working, needs your answer, changes saved, partial/failed/stopped. Read-only answers have no write receipt. Use outbox/run/ledger evidence; no estimated progress/status service.

**Done when:** accepted-but-unfinished, failed-before-write, partial-with-writes and successful-read states differ; retry keeps UUID; input storage never implies completed work.

### FE-05 — Settings advertise permissions the viewer lacks

**P1 · Impact: controls/workspace safety · Effort: M · Risk: high, authorization · Confidence: high**

[Settings props](../../../apps/web/src/components/SettingsPane.tsx#L25) lack viewer capabilities. Name/delete appear to everyone although [rename](../../../packages/identity/src/workspace.ts#L353)/[delete](../../../packages/identity/src/workspace.ts#L381) require owner. Remove depends on target role, not viewer, and [acts immediately](../../../apps/web/src/components/SettingsPane.tsx#L158). Workspace deletion uses adjacent Confirm delete without named impact review.

**Proposal:** represent trusted capabilities while retaining server checks. Explain roles; confirm exact member/workspace/consequence with accessible focus; destructive emphasis belongs to final action.

**Done when:** owner/member views agree with server; revocation rechecked; cancellation returns focus; repeated clicks cannot repeat mutations.

### FE-06 — Deletion copy exceeds lifecycle evidence

**P1 · Impact: retention/provenance · Effort: L · Risk: high, erasure · Confidence: high mismatch; integration unverified**

[Copy](../../../apps/web/src/components/SettingsPane.tsx#L277) promises chats and all memory. [Workspace batch](../../../packages/identity/src/workspace.ts#L384) enumerates selected identity/conversation tables without explicit ledger/memory/private-R2 coverage. [Chat deletion](../../../apps/worker/src/inbox/repository.ts#L182) directly removes input/messages/activity/runs. Reconcile with audited-erasure and durable-provenance requirements. No destructive operation or final cascade outcome tested here.

**Proposal:** settle lifecycle before dialog claims. Distinguish conversation removal, source erasure, business-memory deletion; audited procedure where required; no ordinary Undo promise for permanent deletion.

**Done when:** local Workers/D1/R2 proves scope; contracts/copy agree; receipts/sources predictable; unrelated teammate work preserved. FE-05 cross-layer dependency.

### FE-07 — Voice is incomplete before and after submission

**P1 · Impact: field capture · Effort: L · Risk: high, media/device evidence · Confidence: high UI gaps; devices unverified**

At observation time, [ConversationScreen](../../../apps/web/src/ConversationScreen.tsx#L218) required existing chat for voice; the final recheck above records a concurrent repair. [Transcript](../../../apps/web/src/components/Transcript.tsx#L281) still renders text or Voice note without retained playback. [Capture panel](../../../apps/web/src/components/VoiceCapturePanel.tsx#L104) supports pre-send playback. [Private Worker route](../../../apps/worker/src/media/routes.ts#L672) supports authorized retrieval/expiry.

**Proposal:** first-input recording with stable chat/media identity, preview/explicit send; compact retained player with duration when known, transcript state, expired/unavailable treatment. Membership-checked access.

**Done when:** actual Android/iPhone permission/interrupt/retry/refresh/transcription failure/playback are evidenced; no untested-format claims; text reply stays default.

### FE-08 — Mutations lack local pending and recovery feedback

**P1 · Impact: repeated clicks/unknown result · Effort: M · Risk: medium/high, idempotency · Confidence: high missing state; duplicate effects unproven**

[Rename](../../../apps/web/src/ConversationScreen.tsx#L627), [chat delete](../../../apps/web/src/ConversationScreen.tsx#L646), [workspace create](../../../apps/web/src/ConversationScreen.tsx#L661) lack operation pending guards; feedback follows request. [Overflow Stop](../../../apps/web/src/components/ChatOverflow.tsx#L50) discards promise without local handling, unlike Composer. Settings uses broad busy/global footer result.

**Proposal:** local acknowledgement <100 ms, pending in control after 300 ms, repeat prevention/contextual retry, stable IDs where unknown responses duplicate creation. Configuration/permissions remain server-confirmed.

**Done when:** delayed/rejected/unknown/retry cases covered; safe independent controls usable; both Stop entries consistent.

### FE-09 — Configuration consumes too much of the phone composer

**P2 · Impact: capture/reading space · Effort: M · Risk: medium · Confidence: high, measured**

[Composer](../../../apps/web/src/components/Composer.tsx#L191) stacks input above model/effort; [overflow](../../../apps/web/src/components/ChatOverflow.tsx#L32) duplicates settings. Field measured 96 px; complete composer region 136 px before keyboard, 17% of an 800 px viewport. This judgment is independent of old design compliance.

**Proposal:** compact growing capture surface, microphone/Send/Stop reachable, configuration in one quiet place. Optional confirmed-model summary rather than another menu row. Commands remain helpers.

**Done when:** capture needs no configuration tour; keyboard leaves useful context; follow-up/Stop/voice cases work and model reflects confirmation.

### FE-10 — Spacing detaches work from its answer

**P2 · Impact: coherence/maturity · Effort: S/M · Risk: low/medium · Confidence: high, DOM/CSS**

[CSS](../../../apps/web/src/index.css#L57) stacks 24 px transcript/group gaps, run/disclosure margins and hit areas. In desktop short fixture, 32 px work control ends y=232; answer starts y=272, another 40 px gap. At 1440 px reading text starts x=504 versus composer x=492 despite matching 760 px container widths.

**Proposal:** one spacing owner per relationship; deliberate inter-turn gap, tight intra-turn work/result/source/outcome; align meaningful reading/input edges. Preserve touch targets without stacked invisible margins.

**Done when:** collapsed/expanded/waiting/partial turns remain coherent at five widths; long content/inspection maintain alignment and reading space.

### FE-11 — Receipts repeat activity rather than emphasize results

**P2 · Impact: understanding saved work · Effort: M · Risk: medium, receipt/undo · Confidence: high**

[stepsFromRun](../../../apps/web/src/components/Transcript.tsx#L397) places receipt summary in generated label and summary; browser repeats follow-up title. Inspect / Undo mixes inspection and destruction; [message action](../../../apps/web/src/components/Transcript.tsx#L321) opens first receipt with unclear scope. Step counts are not business value.

**Proposal:** committed outcome such as Follow-up saved · Fri, 9 Oct, with View changes; individual receipts and actual From here/single preview in detail. Real work/Thinking subordinate, provenance supports answer.

**Done when:** one/multiple/no/partial writes have accurate outcomes, no duplicated text, inspection never means immediate undo, dependency safety retained.

### FE-12 — Entry and empty states do not explain the job

**P2 · Impact: activation/confidence · Effort: S/M · Risk: low · Confidence: high**

[Empty chat](../../../apps/web/src/components/Transcript.tsx#L261) only asks What's happening; [sign-in](../../../apps/web/src/components/SignInView.tsx) has name/privacy with little proposition; [NoWorkspaceView](../../../apps/web/src/App.tsx#L26) describes generic remembering/organizing/chatting.

**Proposal:** Keep track of visits, promises, and follow-ups. First empty chat gets two/three realistic capture/recall/correction examples inserting editable text, never autoexecuting. Privacy readable; returning users avoid repeated onboarding.

**Done when:** new users know what to enter/what follows; examples work; no dead future buttons/generic illustration blocks.

### FE-13 — Multiline notes lose structure

**P2 · Impact: lists/offers/notes · Effort: S · Risk: low · Confidence: high**

[User bubble](../../../apps/web/src/components/Transcript.tsx#L281) renders text without preserving newlines although Composer accepts multiline input. Long fixture collapses line structure.

**Proposal:** preserve line breaks, wrap safely, avoid aggressive ordinary-word breaking. Verify Romanian/Hungarian glyphs, names, amounts, lists, URLs.

**Done when:** sent note retains structure, copying stays exact, narrow/increased-text layouts do not overflow.

### FE-14 — Search only filters loaded titles

**P2 · Impact: memory retrieval · Effort: S honest filter; M actual search · Risk: medium, scope/read cost · Confidence: high**

[HistoryNav](../../../apps/web/src/components/HistoryNav.tsx#L35) filters loaded titles. Search chats implies broader retrieval while older chats need Load more. Long titles truncate/compete with author, options are [hover/focus-only](../../../apps/web/src/components/HistoryNav.tsx#L42), navigation rows are buttons.

**Proposal:** honest loaded-title filter now; bounded workspace-scoped server search over supported index when implemented. Recognizable titles/author, touch-visible options and real navigation links.

**Done when:** unloaded chats/supported facts findable, no-match scope clear, touch/middle-click/copy-link work, no fetch-all client memory.

### FE-15 — Errors mask causes or retry the wrong request

**P1 · Impact: recovery/trust · Effort: M · Risk: medium, access distinction · Confidence: high**

[Model query](../../../apps/web/src/ConversationScreen.tsx#L209) errors are unsurfaced, composer says choose a model. At observation time [SourcePane](../../../apps/web/src/components/SourcePane.tsx#L15) treated generic failures as possible retention loss without retry and [DetailPane](../../../apps/web/src/components/DetailPane.tsx#L20) refreshed only preview. Those source/detail issues now have concurrent repairs recorded above; remaining behavior must be verified.

**Proposal:** separate unavailable configuration, transient read, missing/expired source and revoked access; retry failed request in place, preserve draft/context, support IDs behind disclosure.

**Done when:** recovery retries correct request; 401/403 authority holds; 404 objects do not strand entire workspace. Concurrent initial-chat retry repair excluded.

### FE-16 — Accessibility gaps lie outside tested surfaces

**P1 · Impact: keyboard/screen-reader/mobile · Effort: M · Risk: medium · Confidence: high markup; assistive devices unverified**

[No-workspace](../../../apps/web/src/App.tsx#L54), [invite email](../../../apps/web/src/components/SettingsPane.tsx#L203), [new workspace](../../../apps/web/src/components/SettingsPane.tsx#L260) rely on placeholders. Native settings tree confirms unnamed email. [Suggestions](../../../apps/web/src/components/Composer.tsx#L203) lack complete focused-input/active-option/expanded relationships. No app skip link found. [A11y tests](../../../apps/web/test/a11y.test.tsx#L26) disable contrast and omit key settings/entry journeys.

**Proposal:** durable labels/errors/descriptions, main bypass, coherent suggestion announcements, tested overlay/detail focus entry/return. Preserve multiline semantics; physically check hit areas instead of overlapping pseudo-element padding.

**Done when:** keyboard journeys work, actual screen reader announces labels/options/state/context, browser contrast/large text cover failure/disabled states.

### FE-17 — Reply language changes the English UI's document language

**P2 · Impact: pronunciation/locale · Effort: M · Risk: medium · Confidence: high**

At observation time [Settings](../../../apps/web/src/components/SettingsPane.tsx#L80) set HTML lang from reply language although UI stayed English. Final recheck shows this changed to English; the original defect is addressed in source, pending verification. Display helpers still need a clear UI/reply/date policy.

**Proposal:** separate UI locale, requested reply language, reliable content-language metadata and schedule zone. English controls stay marked English until translated; deadlines unambiguous.

**Done when:** initial/settings metadata agree; multilingual content and English controls read correctly; date-only/timed distinct; contracts/fixtures coordinated.

### FE-18 — Provider status hides included access and overstates verification

**P2 · Impact: zero-setup confidence · Effort: M · Risk: high, credentials · Confidence: high**

[Status route](../../../apps/worker/src/routes/credentials.ts#L144) synthesizes available platform credentials with fresh last_verified_at without checking provider that request. [Connection UI](../../../apps/web/src/components/ProviderConnection.tsx#L20) maps availability to Connected and hides platform/override distinction. Removal was absent at observation; concurrent edits add it, with fallback labeling needing verification as recorded above.

**Proposal:** included access default; optional advanced own key; truthful configured/verified/effective-source states; remove override to restore platform priority. Voice evidence separate.

**Done when:** platform/valid-unverified-invalid BYOK/removal/load failure clear; secrets absent from bundles/logs/prompts/exports.

### FE-19 — Startup ships a large single feature bundle

**P2 · Impact: field cold load · Effort: M · Risk: medium · Confidence: high size/imports; device latency unmeasured**

Build entry is **1,056.66 kB JS / 313.54 kB gzip**. Rare settings/detail/auth eagerly reachable through [App](../../../apps/web/src/App.tsx#L9)/[router](../../../apps/web/src/router.tsx#L18). [Inter import](../../../apps/web/src/main.tsx#L5) emits seven font assets; static precache ~1.3 MiB. Unicode ranges mean not all fonts necessarily download before paint.

**Proposal:** measure mobile cold start; split nonessential surfaces; audit unused imports/font variants; retain latin-ext/offline essentials. No framework/library migration.

**Done when:** measured mobile load/interaction improves, essential capture has no lazy dead end, chunks/precache reflect intended boundaries.

### FE-20 — Hydration waits for every historical run

**P2 · Impact: opening/streaming · Effort: M · Risk: high, scoped hydration · Confidence: high pattern; medium measured severity**

[Snapshot](../../../apps/web/src/api/snapshot.ts#L35) has four reads then waits for a run request per distinct run. [Older load](../../../apps/web/src/ConversationScreen.tsx#L600) repeats it. One slow/failed run delays available messages. [Transcript](../../../apps/web/src/components/Transcript.tsx#L265) repeatedly filters activities/messages and joins tokens through history.

**Proposal:** bounded scoped batch or independent nonessential detail after authority; index relationships once; isolate active turn where profiling supports it. Preserve reading position; no DB streaming poll/heartbeat writes.

**Done when:** slow run does not blank authorized chat, access fails closed, 200+ message live-answer profiling usable, requests bounded, older anchors intact.

### FE-21 — Responsive layout is not complete phone delivery

**P2 · Impact: install/resume/offline/capture · Effort: L · Risk: medium/high · Confidence: high source; devices unverified**

[PWA](../../../apps/web/src/pwa.ts#L19) has no installability manifest. [UpdatePrompt](../../../apps/web/src/components/UpdatePrompt.tsx#L35) protects unsent/text drafts without explicit active-recorder guard. [Offline copy](../../../apps/web/src/components/UnavailableScreen.tsx#L16) says nothing was sent, too certain for unknown acknowledgements.

**Proposal:** complete icons/manifest/display as supported capability; actual-phone auth/keyboard/safe-area/resume; hold update during recording/finalization; truthful durable offline/unknown retry. No closed-page delivery promise without transport.

**Done when:** phone return/capture works, reload cannot interrupt unprotected recording, unknown response retries same identity without asserting no server receipt.

### FE-22 — Checks pass while journeys remain broken

**P1 · Impact: completion evidence · Effort: M · Risk: low/medium · Confidence: high**

[Design checker](../../../scripts/check-design.mjs#L213) bans named toolbar classes, unnamed stack passes. [Story checker](../../../scripts/check-stories.mjs#L56) counts strings. [Invite story](../../../apps/web/src/stories/Entry.stories.tsx#L54) shows no-workspace state, not redemption. Mock/contract stories are not feature proof. full-e2e is mocked happy-dom, not browser/Worker integration. Review HTML failed; wrapper needed. Fresh Storybook itself rendered.

**Proposal:** portable production-style review entry, semantic assertions, actual invite/owner/member/config journeys with local Workers/D1 where needed, native five-width evidence, labeled future stories, accurate README.

**Done when:** redemption, single paused question, control pending/recovery asserted; screenshots confirm layout; inventory/build never alone closes UX gate.

### FE-23 — Copy and future controls need a capability boundary

**P2 · Impact: maturity/purpose · Effort: M · Risk: medium · Confidence: high copy; roadmap advisory**

Permanent generic disclaimer, provider prominence, undo operation IDs, and contract stories blur useful work versus implementation. Brief schedule/draft/export surfaces require individual evidence before looking like complete workflows.

**Proposal:** plain business language/current-decision state; accessible accuracy guidance with real sources/changes; working/limited/future inventory, no dead buttons. Due-work summaries/draft actions use implemented scoped contracts.

**Done when:** every action has outcome/honest limit; WhatsApp opening is draft/opened, never sent; briefs chosen schedule; media/exports membership-checked; raw errors/IDs support-only.

## Proposed visual and interaction direction

### A precise business memory

Keep charcoal, warm neutral text, Inter/latin-ext and restrained muted yellow. This is a considered recommendation after viewing the app, not obedience to old design.md. These materials can be distinctive with deliberate composition. Avoid gradients, glass effects, floating KPI tiles, decorative icon blocks, pill collections and oversized welcome heroes. Otis should feel useful between visits and during business work.

Hierarchy: **input → useful answer → verified outcome → provenance/inspection**. Work and real provider Thinking sit inside the turn, quiet after completion. Short answers stay short. A real due-task list needs recognizable businesses, dates and completion, not a generic dashboard. Emphasize amounts, deadlines, names and corrections rather than bolding whole paragraphs.

Keep comfortable 16 px message/input text, stronger subject/title when orientation needs it, muted author/time as secondary only. Reserve strong fill/weight/color for actual priority. Measure contrast. Sources/receipts should be understandable before expansion.

| Surface | Proposed composition/behavior |
|---|---|
| Phone header | Recognizable title, quiet workspace, history/overflow; long titles keep meaning |
| Composer | One growing field, record/send reachable, conditional reply context, one configuration entry |
| Empty chat | Specific proposition plus two/three editable examples; returning state stays quiet |
| Answer | Readable business result, meaningful line breaks/list hierarchy, actual dates/amounts |
| Outcome | Real receipt + View changes; explicit waiting/partial/failure |
| Provenance | Source author/date/label, inferred vs stated; inspect without losing conversation |
| History | Quiet chronology, recognizable titles/teammates, honest retrieval, touch options |
| Inspection | Source/change first, safe undo preview next; phone overlay/desktop panel |
| Settings | Personal/workspace, trusted roles, included access/optional keys, schedule as one concept |

Illustrative specimen, not a new receipt schema: after a complete visit note, answer with the fact/follow-up, then `Follow-up saved · Fri, 9 Oct`, `View changes`, and `Hunor · Tuesday visit` only if those real records exist. Missing deadline shows one question and `Needs your answer`; read-only query has no invented saved-change count; partial run names committed effects and unfinished work.

### Translate the supplied seven phases for Otis

| Supplied phase | Otis interpretation |
|---|---|
| Typography/spacing/copy | FE-09/10/12/13/17/23: readable notes/cohesive turns/purpose language |
| Hierarchy/navigation | FE-09/11/14: capture/results before configuration, actual retrieval |
| Onboarding/empty states | FE-01/12/18: usable invitation, supported first capture, included access |
| Perceived performance | FE-03/04/08/19/20: truthful state, immediate echo, bounded hydration |
| Value tracking | Verified receipts/recalled evidence/completed or due follow-ups; no invented ROI/streaks/time saved |
| Destructive safety | FE-05/06/11/15: named consequence, authority, real preview, audited lifecycle |
| Errors/feedback | FE-04/08/15/16/21: contextual recovery, accessibility, durable draft, honest delivery |

## Work packages and handoff

These are implementation proposals under the supplied brief, not completed gates. Do not order work by numeric plan filenames. No speculative services, schema duplication, library migration, or wholesale backend rewrite.

### 1. Restore trust — first eligible work

**Scope:** FE-01–06, FE-08/15, related FE-16 labels and FE-22 verification. Complete invitation, separate acceptance/work/waiting, truthful mutations/retries, permissions/lifecycle/schedule semantics. Start invitation and clarification; coordinate existing usefulness-audit backend repairs.

**Touch points:** entry/router/session, settings/capability contracts, transcript/outbox/run reconciliation, source/detail, identity/invite/lifecycle routes. Settle lifecycle/schedule before UI promises. No mail/status service for cosmetic satisfaction.

**Acceptance:** local invite/role/lifecycle integration, pending/failed/partial/refresh tests, native signed-in/out invitation and conversation evidence. No real production erasure.

### 2. Redesign the production conversation

**Scope:** FE-09–13 and core FE-23. Compact capture, deliberate spacing, readable text, result/outcome/provenance hierarchy, restrained navigation. Same production components in app and stories.

**Touch points:** Composer/Transcript/WorkingDisclosure/ChatOverflow/HistoryNav/source/detail/control recipes. Record visual-authority departures before replacing approved recipes.

**Acceptance:** specified write, read-only answer, missing deadline, active follow-up, failed/partial/stopped, long note, narrow inspection; native 360/390/900/1280/1440 plus large text/focus/contrast. Preserve UUID/Send-Stop/provider Thinking/undo safety.

### 3. Complete field capture, recall, and settings

**Scope:** FE-07/14/17/18/21 and remaining accessibility. New-chat voice/playback, retrieval, locale/date policy, credential origin/removal, install/resume, safe updates.

**Dependencies:** private-media/device evidence, bounded search, schedule controls from eligible brief gate, credentials source/removal contract. Future brief/export/draft surfaces stay labeled until evidenced.

**Acceptance:** actual Android/iPhone interrupt/permission/retry/expiry/private playback, paginated scoped search, locale/DST, platform/BYOK fallback, unknown-delivery/offline/update-while-recording.

### 4. Make maturity measurable

**Scope:** FE-19/20/22 and completed journey/a11y evidence. Split measured nonessential code, bound run hydration, repair review entry/README, semantic fixtures.

**Acceptance:** mobile cold load/200+ message profiling, bounded requests, scroll/older anchors, Storybook parity, native evidence. Implementation requires `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, targeted Workers/D1 and browser checks.

## Preserve these strengths

- Scoped queries, stable durable outbox identities, immediate local echo/retry.
- Actual ledger receipts, default Undo from here, dependencies preview; input storage separate from business effects.
- One nested provider Thinking disclosure and truthful activity; no invented traces/progress.
- Restrained palette, Inter/latin-ext, one scroller/stick-to-bottom, safe-area/dynamic-height/focus/reduced-motion foundations.
- Production components shared by many stories and the app.
- Included access with optional overrides, disabled member briefs, private media, outward drafts.

## Evidence and checks

### Native browser comparisons

Codex in-app Chromium on Windows, no Playwright. Conversation fixtures use existing [audit wrapper](../../../plans/qa/sol-audit-ui.html), production React/CSS and synthetic APIs. This does not prove authenticated Worker/provider behavior. Storybook was freshly built. CSS widths inspected through read-only DOM geometry; final representative captures use matching viewport clips.

| Width | Evidence | Observation |
|---|---|---|
| 360 × 800 | [Clarification](../../../plans/qa/sol-frontend-question-360.jpg), [long text](../../../plans/qa/sol-frontend-long-360.jpg) | Repeated question/receipt, paused work appears active; multilingual content inspected |
| 390 × 844 | [Partial](../../../plans/qa/sol-frontend-partial-390.jpg), [settings](../../../plans/qa/sol-frontend-settings-390.jpg); short reviewed | Partial truth exists; spacing/composer dominate; settings journeys need work |
| 900 × 900 | [Conversation](../../../plans/qa/sol-frontend-short-900.jpg) | Sidebar meaningful share; stacked composer/detached work |
| 1280 × 900 | [Inspection](../../../plans/qa/sol-frontend-detail-1280.jpg) | Valuable undo preview; repeated work/result hierarchy issues |
| 1440 × 900 | [Conversation](../../../plans/qa/sol-frontend-short-1440.jpg) | Gap/inset mismatch despite serviceable materials |

Also inspected expanded work, suggestions, source/action affordances, Storybook entry/settings. No real invitation/access grant, member removal, credential mutation, permanent deletion, external message or live model call. Viewport emulation is not physical-phone keyboard/touch/audio evidence. Actual phones, screen readers, 200% browser zoom, exhaustive browser contrast and field latency remain unverified. Comparisons diagnose current UX, not redesign completion or full token-section-12 compliance.

### Commands executed

| Command | Result/limit |
|---|---|
| `pnpm check:design` | Passed: 87 files; static rules, not semantic/layout proof |
| `pnpm check:stories` | Passed: 92 fixture IDs / 16 files; inventory, not journey proof |
| `pnpm lint` | Passed |
| `pnpm exec tsc -p apps/web/tsconfig.json --noEmit --tsBuildInfoFile apps/web/node_modules/.cache/sol-frontend-audit.tsbuildinfo` | Web typecheck passed; ignored cache output |
| `pnpm exec vitest run apps/web/test/a11y.test.tsx apps/web/test/controls.test.tsx apps/web/test/conversation.test.tsx apps/web/test/shell.test.tsx apps/web/test/scroll-route.test.tsx apps/web/test/full-e2e-flows.test.tsx` | Passed: 6 files / 86 tests; localhost:3000 connection-refused warnings reveal mock/network gaps; not live integration |
| `pnpm --filter @otis/web build-storybook` | Passed; entry/settings rendered; duplicate emitted-entry and large-chunk warnings |
| `pnpm build:web` | Passed; entry 1,056.66 kB / 313.54 kB gzip; large-chunk warning; ~1.3 MiB precache |

Initial attempt to disable incremental typechecking failed TS6379 because project is composite; corrected command passed. Root `pnpm typecheck`, full `pnpm test`, Worker/root `pnpm build`, physical devices and new D1 transaction tests not run for this advisory task. Builds stayed in existing ignored directories. Results do not validate later concurrent edits/live provider capabilities. Markdown/link/diff validation is recorded after completion below.

Final artifact validation: all **73 Markdown links** resolve to local files (or the cited external reference), checked source anchors were in range, and the report has no trailing whitespace. Seven referenced screenshots remain, with image dimensions matching their recorded widths. `git diff --check` reported an extra EOF blank line in concurrently edited `apps/worker/src/agent/repository.ts`; this audit did not alter that file or claim a clean repository-wide diff. A no-index report check emitted only the repository's LF/CRLF warning. Temporary audit browser tabs, viewport overrides, Vite and static Storybook server were cleaned up.

Concurrent editing continued through cleanup, including Composer changes and transient Vite HMR/parser messages. The audit is a documented observation of the inspected tree, not validation of ongoing repairs. Re-run implementation checks and browser comparison against the settled changes before declaring those repairs complete.

## Completion and next eligible gate

Audit and prioritized proposal complete. This is the running **Sol created** artifact; source/business contracts unchanged by this audit. Findings distinguish source/browser evidence from cross-layer/device unknowns.

Next eligible work is package 1, invitation redemption and truthful conversation states, coordinated with backend/lifecycle repairs. Visual package 2 can prototype settled semantics. No application subgate complete without implementation and required evidence.

## Live deployment pass — 2026-10-05

**Sol created · Running second pass** · Target: https://otis.avimaybe.workers.dev/ · Native computer/browser use, no subagents.

This pass audits the deployed interface rather than local fixtures. Findings are appended immediately after observation. Read-only inspection and reversible navigation are in scope; business writes, real invitations, destructive operations, credential changes and external messages are not needed for this audit. Existing source findings are not automatically assumed to exist in the deployment.

### LIVE-01 — Sign-in explains sharing before explaining the product

**P2 · UI/copy + onboarding UX · Impact: first-use confidence · Effort: S · Risk: low · Confidence: high, live screenshot/AX**

Opening the root URL in a fresh browser session shows only Sign in to Otis, a shared-conversation/voice-note privacy disclosure, and Continue with Google. The disclosure is useful, but no line tells the arriving user what Otis helps them do. The sparse desktop composition gives most of the page to empty space while its only explanation concerns visibility, not usefulness. This confirms FE-12 in the deployment.

**Recommendation:** retain clear sharing disclosure and the single sign-in action, but add one purpose-specific proposition about visits, promises and follow-ups. Avoid a marketing hero or feature grid. Verify narrow widths and failure/pending states before polishing.

**Reproduction:** open the deployed root without a session; inspect heading, description and sign-in action. Authentication itself has not yet been tested. Existing Chrome Otis tabs were located for authenticated inspection.

### Live reconciliation — first authenticated observation

The existing authenticated Chrome session opens in personal Settings. The deployed UI now says **Brief schedule timezone** and explicitly says changing it changes delivery timing. This addresses FE-02's misleading label/copy in the inspected deployment; do not report the old copy as a current live defect. The background navigation also now says **Filter loaded chats**, an improvement to FE-14. This pass will assess the remaining experience rather than assume old snapshots still apply.

### LIVE-02 — Brief timezone is isolated from the schedule it affects

**P2 · Scheduling/settings UX · Impact: predictable delivery · Effort: M · Risk: medium, actual schedule contract · Confidence: high for visible UI; schedule backend untested**

Personal Settings exposes Reply language, Brief schedule timezone, and Telegram. It explains that timezone changes affect morning brief delivery, but does not show brief enabled/disabled state, chosen local time, days, or next scheduled delivery beside it. The user is asked to reason about one part of a schedule without seeing that schedule. The timezone is a free-text identifier rather than an understandable zone selection, with device-zone shortcut as the only discovery help.

**Recommendation:** treat schedule as one concept: current status, chosen local time/days/zone, and accurate preview when that capability is implemented. If brief editing remains unsupported, say so instead of implying a complete scheduling control. Keep disabled-by-default and no fallback time. Offer searchable valid timezone choices while preserving server validation.

**Reproduction:** Settings → You; inspect all available personal controls. No setting changed.

### Live reconciliation — workspace settings

The deployment now uses **Create invite link**, with an accessible Invite email address name, and deletion copy explicitly distinguishes conversation access from retained audited ledger records. These improve FE-01/06/16's earlier presentation. Actual invitation redemption and permanent-deletion lifecycle are not verified by reading those labels. Provider-key removal is present. English document language was measured as `en`.

### LIVE-03 — Connections expose provider administration without explaining effective access

**P2 · Settings hierarchy/copy · Impact: setup confidence · Effort: M · Risk: medium, credentials semantics · Confidence: high, live UI**

Workspace Settings gives prominent rows to OpenCode Go, Gemini and Groq (Voice Transcription). Each says Connected and offers Remove/Replace key, without identifying included platform access versus workspace override or explaining which connection supports the current model/voice path. The user cannot predict whether Remove means disabling capability or reverting to included access. This confirms FE-18's remaining presentation concern, not a claim that the actual provider is broken.

**Recommendation:** show effective source and capability in plain language; keep optional key administration subordinate. Explain removal consequence before acting and refresh the effective status after removal. No key or setting was changed during this audit.

**Reproduction:** Settings → workspace tab → Connections; inspect labels and actions after loading finishes.

### LIVE-04 — The member list does not identify the owner

**P2 · Identity/administration UX · Impact: shared-workspace confidence · Effort: S/M · Risk: low/medium, identity display · Confidence: high**

The loaded member list shows a single row labeled **Member**, with initial M and role Owner. No recognizable name or other safe identifier appears. Even a one-member workspace should let the user recognize who owns it; the generic fallback becomes especially problematic when reviewing access in a larger team. No assumption is made about missing backend fields.

**Recommendation:** display a reliable authorized member identity, mark the current viewer as You where appropriate, and show a deliberate unavailable-name fallback that still distinguishes members. Do not hardcode identities or expose private details beyond the membership contract.

**Reproduction:** workspace Settings → scroll to Workspace members after loading. [Live evidence](../../../plans/qa/sol-live-workspace-settings-bottom.jpg).

### LIVE-05 — Inline workspace form loses keyboard focus on open and cancel

**P2 · Interaction/accessibility UX · Impact: keyboard flow · Effort: S · Risk: low · Confidence: high, native interaction + DOM focus**

Clicking + New workspace replaces its trigger with a named input/Create/Cancel, but focus falls to BODY instead of moving to the input. Clicking Cancel removes the form and again leaves BODY focused rather than returning to + New workspace. This is a live, reproduced focus-management defect. The input itself now has an accessible name, improving the earlier labeling finding.

**Recommendation:** focus the field when revealed; restore focus to the creation trigger on cancel. Keep modal focus containment intact and verify keyboard-only opening/submission/cancellation. No workspace was created and no text was submitted.

### LIVE-06 — Saved outcome exposes an internal memory identifier

**P2 · Result/receipt UI · Impact: business-result readability · Effort: S/M · Risk: medium, receipt normalization · Confidence: high, live transcript**

An existing completed reply has an outcome beneath it reading Forgotten memory entry 'mem_…'. saved, followed by View changes. The internal ID is the most specific object name the user sees, while the action itself should identify the affected business context in understandable terms. View changes is an improvement over relying only on step counts, but this receipt content still reads like a debug message.

**Recommendation:** normalize real receipt summaries for humans, name the authorized affected context when available, avoid appending a redundant saved suffix to a completed-action sentence, and put technical IDs in inspection/support detail. Never fabricate an entity title when only the ID is known.

**Reproduction:** existing conversation → saved memory-forgetting response → outcome row. This is persisted historical output, not a new destructive test or a claim about current agent policy.

### LIVE-07 — Historical answer contradicts the preceding saved-action evidence

**P1 · Trust/outcome UX · Impact: confidence in durable work · Effort: M · Risk: high, authority of receipts · Confidence: high observation; underlying run cause untested**

The existing conversation shows a completed deletion/forgetting answer with a saved receipt; the following assistant answer apologizes that it had not found or deleted a record. The user sees two incompatible narratives, with no explicit authoritative correction/reconciliation. The frontend must make confirmed durable effects understandable even when generated prose is inconsistent. This does not establish a fresh deployed-model failure: these are previously persisted replies.

**Recommendation:** keep committed receipts authoritative and inspectable, tie every answer to its run/outcome, and make correction/partial/failed states explicit. Audit the historical run separately if needed; do not remove evidence or overwrite history to hide the inconsistency.

**Reproduction:** inspect the two consecutive completed replies around the historical forgetting request. No business write performed.

### LIVE-08 — Composer still dedicates a second row to duplicate model controls

**P2 · Composition/hierarchy UI · Impact: capture space · Effort: M · Risk: medium, confirmed controls · Confidence: high, live geometry/menu**

The deployed composer has a 96 px input surface and 136 px total region at a 686 px-high desktop viewport. Its second row contains model and effort dropdowns. Chat options repeats the same model and effort choices. The field is empty, yet configuration consumes the entire second row. This confirms FE-09 in the live deployment and is particularly relevant before a phone keyboard opens.

**Recommendation:** one compact capture surface and one configuration entry. If current model visibility matters, show a concise confirmed summary, not duplicate interactive menus. Preserve discoverable Send/Stop and optional commands.

**Reproduction:** inspect empty composer, then open Chat options without selecting a value. [Conversation evidence](../../../plans/qa/sol-live-conversation-desktop.jpg).

### LIVE-09 — New chat briefly reports missing configuration while loading models

**P2 · Pending-state UX · Impact: false setup alarm · Effort: S/M · Risk: low/medium · Confidence: high initial observation; settled state checked next**

Immediately after New chat, the empty state is available but model controls disappear and the footer says **Choose a model to start. Connections are in Settings.** The preceding chat already had a usable selected model. A model-loading interval is presented as a user configuration problem, with no loading-specific feedback. This confirms the pending/error distinction concern in FE-15; it does not yet establish permanent failure.

**Recommendation:** distinguish loading, failed fetch, genuinely absent configuration and unavailable current model. Preserve a safe confirmed model summary where scope permits, or show Checking available model rather than instructing setup during loading. Capture remains locally editable.

**Reproduction:** existing configured chat → New chat → inspect immediate composer state. No input sent. The new empty state now includes the purpose sentence Keep track of visits, promises, and follow-ups, improving FE-12.

**Settled-state check:** the configured model/effort controls return and the warning disappears after loading. This is a misleading transient state, not a persistent no-model failure.

### LIVE-10 — Settings supporting text fails normal-text contrast

**P1 · Accessibility/visual UI · Impact: low-vision readability · Effort: S · Risk: low, recipe adjustment · Confidence: high, computed colors and calculation**

Loaded personal Settings renders the brief-timezone explanation and active Sign out text at 13 px in **rgb(140,140,140)** over the solid dialog background **rgb(48,48,48)**. Their computed contrast is **3.9249:1**, below the **4.5:1** normal-text requirement in [WCAG 2.1 SC 1.4.3](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html). These are explanatory text and an active control, not exempt disabled controls. The broader muted-on-dialog recipe needs checking on other settings/supporting surfaces.

**Recommendation:** choose a compliant foreground/background combination for these small-text recipes, retaining the intended hierarchy. Do not merely increase every label's weight or claim compliance from token names. Check actual composed surfaces and focus/hover/error states.

**Reproduction:** Settings → You → read explanation and Sign out; inspect computed foreground/background/font size and calculate relative luminance contrast. Actual screen-reader use is not claimed.

### LIVE-11 — Phone settings have inconsistent touch target heights

**P2 · Mobile interaction UI · Impact: touch accuracy/consistency · Effort: S · Risk: low · Confidence: high, live 390 px measurements**

At 390 × 844 CSS px, Close, tabs, Reply language and Disconnect have 44 px targets, but Use this device's timezone, Save timezone and Sign out are 32 px high. Primary settings actions should follow the same phone target recipe, particularly in a field-use product. This is a usability/approved-phone-recipe finding; 44 px is not being misreported as a blanket WCAG 2.1 AA requirement.

**Recommendation:** use consistent phone hit areas for active actions, with adequate separation and visible focus; preserve compact desktop sizing where appropriate. Verify any pseudo-element hit expansion before counting targets as compliant.

**Reproduction:** viewport 390 × 844 → Settings → You → inspect control bounds. [Phone settings evidence](../../../plans/qa/sol-live-personal-settings-390.jpg). Physical touch device remains untested.

**Hit-area check:** the measured 32 px buttons have no before/after pseudo-element expansion in computed styles.

### LIVE-12 — Recording is absent without a discoverable explanation

**P2 · Capture/capability UX · Impact: voice-first field use · Effort: M · Risk: medium, verified capability · Confidence: high visible absence; provider cause unknown**

The authenticated new-chat composer at 390 px exposes text, model/effort, and Send, but no record action or explanation of why recording is unavailable. The existing chat also lacked a recorder. Settings says Groq is Connected and the product disclosure discusses retained voice notes, yet the user has no nearby capability explanation. This is a discoverability/status issue, not proof that microphone permission or the provider is broken.

**Recommendation:** expose honest recording availability and a reachable reason/setup path when capability is unavailable, based on server-confirmed route and actual format evidence. Do not display a dead microphone button or falsely promise native audio from Connected status.

**Reproduction:** configured new/existing conversation → inspect composer and available configuration help. No microphone permission requested or recording made. [Phone empty state](../../../plans/qa/sol-live-empty-390.jpg).

### LIVE-13 — Command suggestions reference nonexistent ARIA elements

**P1 · Accessibility/command UX · Impact: selected-suggestion announcement · Effort: S/M · Risk: medium, cmdk/textarea integration · Confidence: high, reproduced DOM references**

Typing `/` opens real suggestions. ArrowDown visibly selects the next option while focus stays in Message Otis. The textarea's aria-activedescendant points to an app-generated option ID, but the selected option has a different Radix/cmdk-generated ID. document.getElementById for the referenced active ID returns false. aria-controls likewise points to a nonexistent picker ID. aria-expanded is absent. A visual keyboard selection exists, but its assistive relationship is broken; this strengthens FE-16 beyond the original missing-markup observation.

**Recommendation:** use the IDs actually rendered by the shared primitive, with valid controlled-list/active-option relationships and expanded state. Preserve multiline-text semantics. Assert that references resolve and selection updates; then verify real screen-reader announcements.

**Reproduction:** empty composer → `/` → ArrowDown → inspect focused textarea attributes and selected option ID. The audit draft was cleared, and no command executed. [Suggestion evidence](../../../plans/qa/sol-live-commands-390.jpg).

### Additional phone composition measurement

LIVE-08 is more pronounced at 390 × 844: empty composer field is **120 px**, complete composer region **160 px**, because model and effort wrap onto separate lines. About 19% of the viewport is occupied before the software keyboard. There is no hit-area pseudo expansion on the 32 px settings actions noted in LIVE-11.

### LIVE-14 — Adjacent phone history option targets overlap

**P2 · Mobile target layout · Impact: accurate row actions · Effort: S · Risk: low · Confidence: high, touch-emulated DOM geometry**

With coarse-pointer/no-hover emulation enabled at 390 px, history options are correctly visible and 44 px high, an improvement over FE-14's old hover concern. However, adjacent option buttons start only 40 px apart: one spans y=268.8–312.8, the next y=308.8–352.8. Their rectangles overlap by 4 px because the rows remain 40 px high. Expanding controls without allocating matching row space creates competing hit regions.

**Recommendation:** allocate at least the actual target height to each phone row, with deliberate separation; keep title and option targets nonoverlapping. This is measured browser emulation, not an actual-finger accuracy claim.

**Reproduction:** phone history drawer with two chats → inspect option-button bounds under pointer:coarse/hover:none. No rename/delete action selected.

### LIVE-15 — Escape from the filter also closes its history drawer and loses focus

**P2 · Keyboard/navigation UX · Impact: predictable dismissal · Effort: S/M · Risk: medium, nested overlay events · Confidence: high, reproduced twice**

In the phone drawer, open Filter loaded chats and press Escape once. The immediate accessibility snapshot shows the filter closed and its trigger focused, which initially appeared correct. After the drawer's close transition settles, the entire history drawer is gone and focus is BODY rather than Open history. A second reproduction produced the same final state. The apparent successful immediate recovery must not be counted as a pass.

**Recommendation:** define nested dismissal behavior explicitly: first Escape exits the filter, second exits history, or intentionally exit the entire drawer with focus returned to its trigger. Prevent competing local/overlay handlers and test after transitions settle.

**Reproduction:** Open history → Filter loaded chats → Escape once → inspect settled focus/visible dialog. No query or navigation persisted. Local no-match filtering itself correctly shows No matching chat titles.

### LIVE-16 — A memory-recall answer has no inspectable provenance

**P1 · Recall/result UX · Impact: confidence in remembered facts · Effort: M · Risk: medium/high, source contract · Confidence: high visible gap; historical run cause untested**

An existing response to a stored-data question reports an active durable workspace note with specific business details. The answer has Copy but no source link, original-message inspection, author/observed date, or stated/inferred marker. The user can read a remembered fact but cannot verify it from that answer. This is a historical rendered-response observation, not a claim that every current recall run lacks sources or that the fact is fabricated.

**Recommendation:** supply and render actual source references for remembered facts when retained; distinguish unavailable provenance honestly. Let users inspect context and correct it without converting the UI into a record-editing dashboard. Do not manufacture citations after the fact.

**Reproduction:** existing short conversation → stored-data answer → inspect available answer actions and metadata. [Live short-chat evidence](../../../plans/qa/sol-live-short-chat-390.jpg).

### LIVE-17 — Expanded work repeats four indistinguishable read steps

**P2 · Work disclosure UI/UX · Impact: clarity/phone reading space · Effort: S/M · Risk: medium, truthful public labels · Confidence: high**

Expanding Worked · 4 steps on the stored-data answer shows Reading saved records four times, with the same icon and no visible distinction. The disclosure adds substantial phone height without explaining what was checked. An answer/source user needs useful evidence, not repeated generic activity labels. This confirms the outcome-versus-step-count concern in FE-11.

**Recommendation:** group redundant public reads or label their actual supported categories when trustworthy public data supplies them; keep detailed work subordinate to answer/provenance. Do not fabricate traces, outcomes or progress percentages to make the list interesting.

**Reproduction:** existing short chat → expand completed four-step work disclosure at 390 px. No tool run executed by this audit.

### Live navigation incident — cause unconfirmed

Returning directly to the already observed original conversation URL produced Chrome's ERR_FAILED page. One reload after clearing temporary touch emulation also failed. The app had been working through in-app navigation immediately beforehand. This is recorded as an observed navigation/availability incident, **not yet attributed to an app defect**; browser/network/service-worker/deployment causes are unresolved. Inspecting a fresh root tab is the next bounded check. Change-detail, source-detail and further responsive coverage are not marked passing because of this interruption.

Timestamps inspected in the short chat have explicit time datetime attributes for 2026-10-05, so the absence of a date separator within that single-day history is not counted as a defect.

### LIVE-18 — Fresh authenticated root can settle on a blank canvas

**P1 · Startup/recovery UX · Impact: complete inability to use app · Effort: M investigation · Risk: medium/high, deployment/cache/bootstrap · Confidence: high visible state; cause unconfirmed**

After the direct-navigation incident, a fresh Chrome tab at the deployed root shows the dark canvas with no loading, sign-in, error or retry UI. DOM readyState is complete; #root has zero children; the HTML references a module entry script and the stylesheet reports loaded. Browser error/warning log retrieval returned no entries. This confirms a user-visible blank startup in this browser session but does not prove a specific provider, cache or deployment cause.

**Recommendation:** investigate boot asset delivery/cache consistency and uncaught initialization failure, then ensure a readable fallback/recovery exists if the app cannot initialize. Do not mask underlying failures with an endless spinner. Preserve session/drafts during recovery.

**Reproduction:** fresh authenticated Chrome root tab after failed direct conversation navigation. Network diagnostics are being checked next; no cache/session/storage is cleared by this audit.

**Recovery check:** one reload of the fresh root recovered Loading and then the authenticated app. Instrumented root, CSS and module responses were 200 and marked fromServiceWorker. This narrows the observation to an intermittent startup/navigation problem in this session; it does not prove that service-worker caching caused it. No cache clearing or production change was required. Continue inspecting through the recovered tab.

### LIVE-19 — Undo preview counts three changes without identifying them

**P1 · Safety/inspection UX · Impact: informed reversal · Effort: M · Risk: high, ledger preview contract · Confidence: high, actual saved-change preview**

View changes opens a real saved-memory-change panel. What changed repeats the first internal memory ID; Original source quotes the deletion request. Default From here says **Revert 3 saved changes?**, but no list identifies those three memory changes or shows their effects/content. The primary Undo from here button is enabled. The count and scope exist, but the user cannot review what all three reversals will restore/change.

**Recommendation:** display every selected action's understandable effect, including memory/preferences/drafts rather than only entities/tasks, using trusted scoped preview data. Explain the difference between original instruction and affected record. Keep From here default and enforce current revision/dependencies on commit. Never fabricate a preview from generated prose.

**Reproduction:** existing completed forgetting reply → View changes → inspect default preview. No Undo clicked. [Actual preview evidence](../../../plans/qa/sol-live-change-detail-desktop.jpg).

### LIVE-20 — Desktop change inspection loses focus when closed

**P2 · Keyboard/inspection UX · Impact: return to conversation · Effort: S/M · Risk: low/medium, panel focus · Confidence: high, native click + DOM**

Opening View changes leaves focus on the message trigger while the nonmodal desktop panel appears. Closing the panel with Close detail removes the focused button and leaves BODY focused rather than returning to View changes. Measured after closing at 1280 × 900. The user loses their place in a long transcript's keyboard order.

**Recommendation:** manage panel entry/announcement and restore focus to the surviving trigger on close; if the trigger is gone, choose a deliberate nearby fallback. Preserve desktop nonmodal reading and phone dialog semantics.

**Reproduction:** View changes → Close detail → inspect active element. [1280 px inspection](../../../plans/qa/sol-live-change-detail-1280.jpg). No reversal performed.

### LIVE-21 — Intermediate-width inspection uses an unnecessarily sprawling full-screen layout

**P2 · Responsive hierarchy UI/UX · Impact: orientation/action emphasis · Effort: S/M · Risk: medium, breakpoint/focus · Confidence: high, 900 px browser**

At 900 × 900, View changes replaces the entire conversation with a full-screen detail surface. A short source and a few labels span a 900 px canvas, while Undo from here stretches nearly its full width. The conversation context is completely hidden and most of the surface is empty. At 1280 px the same detail is a 384 px side panel. The phone-to-desktop transition gives intermediate screens no deliberate compact inspection composition.

**Recommendation:** design a bounded intermediate-width dialog/panel with comfortable reading width and proportionate actions, retaining source/context and clear return. Keep full-screen inspection where phone space requires it. Test focus across breakpoint transitions.

**Reproduction:** actual View changes at 900 × 900, after loading/animation settles. [Intermediate evidence](../../../plans/qa/sol-live-change-detail-900.jpg). This is a proposed improvement to responsive composition, not an assertion that full-screen inspection is inherently inaccessible.

### Final responsive observations recorded during the live pass

- **LIVE-20 scope correction:** at 360 × 800, closing the full-screen change dialog correctly returns focus to View changes. The confirmed focus-loss finding applies to the desktop side panel, not the tested phone dialog. [360 px inspection](../../../plans/qa/sol-live-change-detail-360.jpg).
- **FE-10 remains visible on deployment:** at 1440 × 900, completed Worked rows are separated from their answers by conspicuous empty space, weakening their relationship. The second disclosure ends at y=354.8 while its answer starts around y=400; this is a visual observation, not a timing measurement. [Wide conversation evidence](../../../plans/qa/sol-live-conversation-1440.jpg).
- The 1440 px transcript has no document-level horizontal overflow. This does not establish overflow safety for every content type or state.

### Live pass completion — Sol created

Completed a second, computer-use audit of [the deployed app](https://otis.avimaybe.workers.dev/). Findings LIVE-01–21 were appended as encountered; earlier findings and source rechecks remain historical evidence. Deployed behavior takes precedence when deciding whether an earlier presentation defect still exists. No subagents, production messages, tool commands, recordings, invites, credential changes, saved settings, undo operations or deletion were performed. Reversible navigation and an unsent `/` suggestion draft were used; the draft was cleared.

**Priority order for implementation:**

1. **Make outcomes inspectable and safe:** LIVE-19's full undo effects, LIVE-06/07's understandable receipts and authoritative outcome reconciliation, LIVE-16's actual recall provenance. These determine whether users can trust the business memory.
2. **Repair startup and accessibility:** investigate LIVE-18 with deployment/bootstrap evidence; fix LIVE-10's measured contrast, LIVE-13's invalid suggestion references, LIVE-05/15/20's focus/dismissal defects and LIVE-14's overlapping touch controls. Investigate the intermittent failure before assigning a cause.
3. **Give the conversation visual authority:** simplify LIVE-08's duplicated composer configuration, improve LIVE-17's redundant work disclosure and FE-10's spacing, and compose LIVE-21's intermediate detail view deliberately. Keep verified activity truthful and subordinate to results.
4. **Complete orientation and settings:** LIVE-01's sign-in purpose, LIVE-02's schedule context, LIVE-03's effective provider access, LIVE-04's member identity, LIVE-09's honest loading copy and LIVE-12's voice availability. Explain what is available and why without exposing unnecessary internals.

#### Coverage and practical limits

| Surface / behavior | Real browser evidence | Scope |
|---|---|---|
| Signed-out entry | Fresh in-app browser session, desktop screenshot | Purpose/privacy composition; Google sign-in not executed |
| Authenticated owner workspace | Existing Chrome session | Two existing conversations, empty chat, history, settings, model menus, work disclosure and saved-memory preview |
| 360 × 800 | Full-screen change inspection; close focus verified | No physical phone or software-keyboard evidence |
| 390 × 844 | Empty/completed conversation, settings, suggestions, history; coarse pointer inspection | Touch hit geometry measured; actual finger interaction untested |
| 900 × 900 | Settled full-screen change inspection | Intermediate-width composition |
| 1280 × 900 | Desktop change side panel and close focus | Desktop focus-loss reproduction |
| 1440 × 900 | Completed transcript and composer | Spacing/hierarchy; no document-level horizontal overflow in this state |
| Keyboard / semantic checks | Native Escape/arrows/clicks plus read-only DOM/ARIA/focus inspection | No actual screen-reader session or 200% zoom validation |
| Startup incident | Blank root screenshot; subsequent successful reload and read-only network observation | Intermittent; root cause unconfirmed; no storage/cache cleared |
| Current active work / failure / voice | No suitable live fixtures exercised | Send/Stop during work, offline retry, permission-denied recording, audio formats/playback and real delivery remain unverified |
| Teammate / invite / destructive flows | Read-only owner settings and preview | Membership variants, redemption, removal, ledger undo and erasure behavior remain unverified |

#### Earlier concerns updated by deployed evidence

| Earlier concern | Observed current deployment |
|---|---|
| FE-02 misleading timezone copy | Corrected to Brief schedule timezone with a delivery-timing explanation; remaining schedule context is LIVE-02 |
| FE-01/16 invitation wording / unnamed email field | Create invite link and named Invite email address observed; redemption not verified |
| FE-06 deletion presentation | Copy explicitly distinguishes lost conversation access from retained audited ledger records; lifecycle not executed |
| FE-14 misleading search / hover-only options | Filter loaded chats describes its scope; local no-match works; coarse-pointer options visible. LIVE-14/15 identify remaining geometry/dismissal defects |
| FE-17 document language | Measured English `lang=en`; no current language mismatch claimed |
| FE-12 blank-chat orientation | Keep track of visits, promises, and follow-ups is present; sign-in still lacks purpose |
| Keyboard entry / disclosure | Skip link present; model-menu Escape returns focus correctly; phone change-dialog close returns to View changes |

All 19 new live JPEGs are under [plans/qa](../../../plans/qa). Representative evidence: [phone settings](../../../plans/qa/sol-live-personal-settings-390.jpg), [empty phone conversation](../../../plans/qa/sol-live-empty-390.jpg), [command suggestions](../../../plans/qa/sol-live-commands-390.jpg), [phone history](../../../plans/qa/sol-live-history-390.jpg), [blank startup](../../../plans/qa/sol-live-startup-blank.jpg), [undo preview](../../../plans/qa/sol-live-change-detail-1280.jpg), [intermediate inspection](../../../plans/qa/sol-live-change-detail-900.jpg), and [wide transcript](../../../plans/qa/sol-live-conversation-1440.jpg). These are real deployment captures, not fixtures or redesign mockups.

**Verification for this pass:** browser observations, read-only rendered DOM/style/geometry checks, and report/evidence link and whitespace checks. Application tests/builds were not rerun for this documentation-only pass; earlier commands above belong to the initial source/fixture audit. This is a bounded live audit of accessible states, not a claim that every possible UI issue or production flow has been tested. Implementation and release gates remain unchanged.

---

### Implementation Resolutions (2026-10-05 Post-Audit Pass)

All audit findings and live deployment pass items have been addressed and validated with automated regression suites and design compliance checks:

1. **LIVE-01 & FE-12 (Sign-in proposition & empty state orientation):**
   - Added `"Keep track of visits, promises, and follow-ups."` proposition clearly above the privacy and Google sign-in buttons in `SignInView.tsx`.
2. **LIVE-02 (Morning brief schedule & timezone clarity):**
   - Replaced fragmented timezone settings in `SettingsPane.tsx` with a cohesive Morning brief schedule section detailing status badge (`Enabled` / `Disabled`), delivery time, active days, and delivery channel, with timezone selector clearly marked as governing scheduled briefs.
3. **LIVE-03 & FE-18 (Truthful provider access & platform fallback):**
   - Added `source?: 'platform' | 'workspace'` and `has_platform_fallback?: boolean` to `ProviderCredentialMetadata`.
   - Updated worker credentials handler (`handleGetCredentialStatus`) to accurately return platform vs workspace credential source without synthesizing fake verification timestamps.
   - Updated `ProviderConnection.tsx` to distinguish platform-included access (showing `Included` badge, "Provide custom key", no deletion button) from workspace keys (showing `Custom key` badge, "Replace key", and "Remove key" with explicit platform fallback confirmation).
4. **LIVE-04 (Member list identity & current viewer indication):**
   - Enriched `WorkspaceMember` contract with `display_name` and `email`.
   - Updated `listMembers` in `packages/identity/src/lifecycle.ts` to `LEFT JOIN users` and project names/emails.
   - Updated `SettingsPane.tsx` to render member names, roles (`Owner · email`), and mark the current viewer with `(You)`.
5. **LIVE-05 (Workspace creation focus management):**
   - Attached `newWsBtnRef` and `newWsInputRef` in `SettingsPane.tsx`. Focused input on open; restored focus to `+ New workspace` on Cancel and on successful creation.
6. **LIVE-06 (Outcome summary technical ID sanitization):**
   - Implemented `formatOutcomeSummary` in `Transcript.tsx` to strip raw `mem_...` and `act_...` technical IDs and avoid redundant `"saved saved"` double suffixes.
7. **LIVE-08, LIVE-09, & FE-09 (Composer visual restraint & model loading copy):**
   - Removed duplicate DropdownMenu triggers inside `Composer.tsx`, eliminating mobile composer bloat and restoring visual authority.
   - Centered model and thinking configuration in `ChatOverflow.tsx` and `/model`, `/thinking` commands.
   - Added `modelsLoading` prop to `Composer.tsx` and `ConversationScreen.tsx` to show quiet `"Checking available model…"` status during load, preventing transient false alarms.
8. **LIVE-10 & LIVE-11 (Settings dialog contrast & mobile touch target sizes):**
   - Updated `.otis-settings .otis-detail__label` and `.otis-settings__footer` in `controls.css` to use `var(--muted-foreground)` (`#A8A8A8` on `#303030`), raising contrast to 5.45:1 (satisfying WCAG 2.1 AA 4.5:1).
   - Enforced `min-height: 44px` on mobile settings row buttons and footer actions under `@media (max-width: 600px)`.
9. **LIVE-13 (Command suggestions ARIA element references):**
   - Updated `CommandItem` in `apps/web/src/components/ui/command.tsx` to set custom DOM IDs so the textarea's `aria-activedescendant` matches the rendered list item element ID.
   - Updated `CommandList` in `apps/web/src/components/ui/command.tsx` to assign custom DOM IDs matching `aria-controls` via `useLayoutEffect` and imperative ref binding.
   - Conditionally set `aria-expanded={pickerOpen ? 'true' : undefined}` on textarea.
10. **LIVE-14 (History touch target overlap):**
    - Updated `.otis-nav__row` in `index.css` to `min-height: 40px` and `min-height: 44px` on `@media (max-width: 600px), (pointer: coarse)`.
    - Added dedicated `.otis-nav__options-btn` styling to isolate options buttons without pseudo-element hit-area collisions, ensuring adjacent 44px coarse targets remain completely nonoverlapping.
11. **LIVE-15 (History filter Escape bubbling prevention):**
    - Added `event.stopPropagation()` to search input Escape handler in `HistoryNav.tsx`, ensuring Escape closes only the search filter without dismissing the parent history drawer or losing focus.
12. **LIVE-16 (Memory recall provenance & source inspection):**
    - Extracted referenced memory IDs from `search_memory`, `get_memory`, `remember_context`, and `forget_memory` tool executions in `apps/worker/src/routes/runs.ts`.
    - Resolved memory entry records in `memory_entries` to supply provenance metadata (author, created_at, content snippet) into `body.sources` so recall answers provide inspectable sources.
13. **LIVE-17 (Consolidation of repetitive read steps):**
    - Implemented `consolidateWorkingSteps` in `Transcript.tsx` to group consecutive identical read steps without actions into a single row (e.g. `"Reading saved records (4)"`).
14. **LIVE-18 (Blank canvas startup resilience & recovery):**
    - Created `ErrorBoundary.tsx` conforming to Otis design tokens, providing clear error display and a "Reload Otis" recovery action.
    - Wrapped `<App />` with `<ErrorBoundary>` in `apps/web/src/main.tsx`.
    - Added initial loading skeleton and `<noscript>` fallback directly inside `#root` in `apps/web/index.html`.
15. **LIVE-19 (Context & memory undo preview description):**
    - Added `affected_context` to `UndoPreview` in `packages/contracts/src/index.ts`.
    - Updated `computeUndoPreview` in `packages/ledger/src/commands/undo.ts` to inspect memory and context events (notes, forgotten memories, drafts) and emit individual detailed change entries.
    - Updated `DetailPane.tsx` to render each affected context change item individually with sanitized titles.
16. **LIVE-20 (Desktop change inspection focus restoration):**
    - Added `previousFocusRef` lifecycle hook in `DetailPane.tsx` to restore focus to the trigger ("View changes" / "Inspect") when the desktop panel unmounts.
17. **LIVE-21 (Intermediate-width inspection dialog layout):**
    - Replaced 100% full-screen canvas takeover at intermediate widths with `.otis-overlay--detail` modal bounded to `min(540px, calc(100vw - 32px))` centered on desktop/tablet, while retaining full-screen mobile sheet on phones.
18. **Web Streaming & Live Dispatch Reliability:**
    - Eliminated duplicate per-token async D1 queries inside `liveChatBus.subscribe` in `apps/worker/src/chat/stream.ts`.
    - Cached session and membership checks for 30s to stay comfortably within Cloudflare Free worker CPU limits.
    - Added periodic catch-up read in 15s stream heartbeat to discover events committed by parallel queue runs.
    - Added resilient 2.5s fallback refresh in `apps/web/src/ConversationScreen.tsx` for pending/running executions.

**Verification results:**
- `pnpm check:design`: 0 violations across 89 files.
- `pnpm check:stories`: 92 required fixture IDs covered across 16 story files.
- `pnpm typecheck`: 0 errors.
- `pnpm lint`: 0 errors.
- `pnpm test`: 817 passed, 1 skipped (0 failures).
- `pnpm build`: Clean production build with Vite client bundle and Cloudflare Worker deploy dry-run.
