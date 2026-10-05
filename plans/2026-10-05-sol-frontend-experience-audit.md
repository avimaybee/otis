# Otis frontend and experience audit

**Sol created** · 2026-10-05 · Completed audit and improvement proposal

Baseline: `608d9fc` on `main`, with existing uncommitted work present. No subagents used. This report and synthetic browser screenshots are the audit's changes. Production source, tokens, contracts, migrations, gate status, and deployment were not changed by this audit.

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

[SettingsPane](../apps/web/src/components/SettingsPane.tsx#L140) discards the token and says `Invite sent to …`. [Member route](../apps/worker/src/routes/members.ts#L65) creates/returns a token, sends no email. Share produces `/?invite=…`, but [SignInView](../apps/web/src/components/SignInView.tsx#L28) submits only `id_token`, and [router](../apps/web/src/router.tsx#L37) has no invitation flow. [Accept API](../apps/web/src/api/client.ts#L272) has no frontend caller. [Auth route](../apps/worker/src/routes/auth.ts#L120) already supports the token.

**Proposal:** complete create/share/redeem together. Show `Invite link ready`, eligibility and expiry; carry the token through signed-out and already-signed-in entry. Cover used/expired/wrong-email/revoked invites. Do not add mail just to justify a label.

**Done when:** both entry states join the intended workspace; errors grant no access and explain recovery; `sent` requires actual transport confirmation.

### FE-02 — Timezone copy contradicts the schedule it changes

**P1 · Impact: reminder timing · Effort: M · Risk: high, date/schedule contract · Confidence: high**

[SettingsPane](../apps/web/src/components/SettingsPane.tsx#L180) says dates/reminders and `Your brief stays on its existing schedule`. [Save](../apps/web/src/components/SettingsPane.tsx#L89) changes `brief_timezone`; [identity](../packages/identity/src/settings.ts#L198) persists it; [brief reader](../apps/worker/src/brief/read.ts#L47) uses it as schedule zone. Changing it can change UTC delivery time. It does not establish a general interpretation timezone.

**Proposal:** accurately label the existing brief zone or first implement the intended separate setting. Present chosen local time/days/zone together when supported. Keep date-only deadlines distinct from appointments; no 09:00 fallback.

**Done when:** copy/server schedule agree including DST; unrelated interpretation is not promised without its contract.

### FE-03 — Paused clarification looks active and repeats the question

**P1 · Impact: uncertainty/waiting · Effort: M · Risk: medium, reconciliation · Confidence: high, browser/source**

[Transcript](../apps/web/src/components/Transcript.tsx#L100) treats waiting_for_input as active unfinished work. Expanded disclosure can say `Saving follow-up…`. [RunWork](../apps/web/src/components/Transcript.tsx#L128) renders the question while the saved assistant message repeats it. The 360 px fixture shows both; composer says only `Replying to Otis`.

**Proposal:** explicit waiting state, one canonical question, reply context naming it. Completed steps remain inspectable without running indicators. Choices come only from actual clarification data.

**Done when:** live/persisted transitions show one question, waiting is visibly paused, refresh preserves pending work, follow-ups target/revalidate the correct clarification.

### FE-04 — Acceptance is hard to distinguish from completed work

**P1 · Impact: duplicate input/false confidence · Effort: M · Risk: high, outbox/run semantics · Confidence: high**

[Delivery rendering](../apps/web/src/components/Transcript.tsx#L284) hides local state when saved; reconciliation removes the marker. Accepted input is hard to inspect while queued/delayed/waiting. Permanent disclaimer does not explain it.

**Proposal:** actual milestones: stored on device, received by Otis, working, needs your answer, changes saved, partial/failed/stopped. Read-only answers have no write receipt. Use outbox/run/ledger evidence; no estimated progress/status service.

**Done when:** accepted-but-unfinished, failed-before-write, partial-with-writes and successful-read states differ; retry keeps UUID; input storage never implies completed work.

### FE-05 — Settings advertise permissions the viewer lacks

**P1 · Impact: controls/workspace safety · Effort: M · Risk: high, authorization · Confidence: high**

[Settings props](../apps/web/src/components/SettingsPane.tsx#L25) lack viewer capabilities. Name/delete appear to everyone although [rename](../packages/identity/src/workspace.ts#L353)/[delete](../packages/identity/src/workspace.ts#L381) require owner. Remove depends on target role, not viewer, and [acts immediately](../apps/web/src/components/SettingsPane.tsx#L158). Workspace deletion uses adjacent Confirm delete without named impact review.

**Proposal:** represent trusted capabilities while retaining server checks. Explain roles; confirm exact member/workspace/consequence with accessible focus; destructive emphasis belongs to final action.

**Done when:** owner/member views agree with server; revocation rechecked; cancellation returns focus; repeated clicks cannot repeat mutations.

### FE-06 — Deletion copy exceeds lifecycle evidence

**P1 · Impact: retention/provenance · Effort: L · Risk: high, erasure · Confidence: high mismatch; integration unverified**

[Copy](../apps/web/src/components/SettingsPane.tsx#L277) promises chats and all memory. [Workspace batch](../packages/identity/src/workspace.ts#L384) enumerates selected identity/conversation tables without explicit ledger/memory/private-R2 coverage. [Chat deletion](../apps/worker/src/inbox/repository.ts#L182) directly removes input/messages/activity/runs. Reconcile with audited-erasure and durable-provenance requirements. No destructive operation or final cascade outcome tested here.

**Proposal:** settle lifecycle before dialog claims. Distinguish conversation removal, source erasure, business-memory deletion; audited procedure where required; no ordinary Undo promise for permanent deletion.

**Done when:** local Workers/D1/R2 proves scope; contracts/copy agree; receipts/sources predictable; unrelated teammate work preserved. FE-05 cross-layer dependency.

### FE-07 — Voice is incomplete before and after submission

**P1 · Impact: field capture · Effort: L · Risk: high, media/device evidence · Confidence: high UI gaps; devices unverified**

At observation time, [ConversationScreen](../apps/web/src/ConversationScreen.tsx#L218) required existing chat for voice; the final recheck above records a concurrent repair. [Transcript](../apps/web/src/components/Transcript.tsx#L281) still renders text or Voice note without retained playback. [Capture panel](../apps/web/src/components/VoiceCapturePanel.tsx#L104) supports pre-send playback. [Private Worker route](../apps/worker/src/media/routes.ts#L672) supports authorized retrieval/expiry.

**Proposal:** first-input recording with stable chat/media identity, preview/explicit send; compact retained player with duration when known, transcript state, expired/unavailable treatment. Membership-checked access.

**Done when:** actual Android/iPhone permission/interrupt/retry/refresh/transcription failure/playback are evidenced; no untested-format claims; text reply stays default.

### FE-08 — Mutations lack local pending and recovery feedback

**P1 · Impact: repeated clicks/unknown result · Effort: M · Risk: medium/high, idempotency · Confidence: high missing state; duplicate effects unproven**

[Rename](../apps/web/src/ConversationScreen.tsx#L627), [chat delete](../apps/web/src/ConversationScreen.tsx#L646), [workspace create](../apps/web/src/ConversationScreen.tsx#L661) lack operation pending guards; feedback follows request. [Overflow Stop](../apps/web/src/components/ChatOverflow.tsx#L50) discards promise without local handling, unlike Composer. Settings uses broad busy/global footer result.

**Proposal:** local acknowledgement <100 ms, pending in control after 300 ms, repeat prevention/contextual retry, stable IDs where unknown responses duplicate creation. Configuration/permissions remain server-confirmed.

**Done when:** delayed/rejected/unknown/retry cases covered; safe independent controls usable; both Stop entries consistent.

### FE-09 — Configuration consumes too much of the phone composer

**P2 · Impact: capture/reading space · Effort: M · Risk: medium · Confidence: high, measured**

[Composer](../apps/web/src/components/Composer.tsx#L191) stacks input above model/effort; [overflow](../apps/web/src/components/ChatOverflow.tsx#L32) duplicates settings. Field measured 96 px; complete composer region 136 px before keyboard, 17% of an 800 px viewport. This judgment is independent of old design compliance.

**Proposal:** compact growing capture surface, microphone/Send/Stop reachable, configuration in one quiet place. Optional confirmed-model summary rather than another menu row. Commands remain helpers.

**Done when:** capture needs no configuration tour; keyboard leaves useful context; follow-up/Stop/voice cases work and model reflects confirmation.

### FE-10 — Spacing detaches work from its answer

**P2 · Impact: coherence/maturity · Effort: S/M · Risk: low/medium · Confidence: high, DOM/CSS**

[CSS](../apps/web/src/index.css#L57) stacks 24 px transcript/group gaps, run/disclosure margins and hit areas. In desktop short fixture, 32 px work control ends y=232; answer starts y=272, another 40 px gap. At 1440 px reading text starts x=504 versus composer x=492 despite matching 760 px container widths.

**Proposal:** one spacing owner per relationship; deliberate inter-turn gap, tight intra-turn work/result/source/outcome; align meaningful reading/input edges. Preserve touch targets without stacked invisible margins.

**Done when:** collapsed/expanded/waiting/partial turns remain coherent at five widths; long content/inspection maintain alignment and reading space.

### FE-11 — Receipts repeat activity rather than emphasize results

**P2 · Impact: understanding saved work · Effort: M · Risk: medium, receipt/undo · Confidence: high**

[stepsFromRun](../apps/web/src/components/Transcript.tsx#L397) places receipt summary in generated label and summary; browser repeats follow-up title. Inspect / Undo mixes inspection and destruction; [message action](../apps/web/src/components/Transcript.tsx#L321) opens first receipt with unclear scope. Step counts are not business value.

**Proposal:** committed outcome such as Follow-up saved · Fri, 9 Oct, with View changes; individual receipts and actual From here/single preview in detail. Real work/Thinking subordinate, provenance supports answer.

**Done when:** one/multiple/no/partial writes have accurate outcomes, no duplicated text, inspection never means immediate undo, dependency safety retained.

### FE-12 — Entry and empty states do not explain the job

**P2 · Impact: activation/confidence · Effort: S/M · Risk: low · Confidence: high**

[Empty chat](../apps/web/src/components/Transcript.tsx#L261) only asks What's happening; [sign-in](../apps/web/src/components/SignInView.tsx) has name/privacy with little proposition; [NoWorkspaceView](../apps/web/src/App.tsx#L26) describes generic remembering/organizing/chatting.

**Proposal:** Keep track of visits, promises, and follow-ups. First empty chat gets two/three realistic capture/recall/correction examples inserting editable text, never autoexecuting. Privacy readable; returning users avoid repeated onboarding.

**Done when:** new users know what to enter/what follows; examples work; no dead future buttons/generic illustration blocks.

### FE-13 — Multiline notes lose structure

**P2 · Impact: lists/offers/notes · Effort: S · Risk: low · Confidence: high**

[User bubble](../apps/web/src/components/Transcript.tsx#L281) renders text without preserving newlines although Composer accepts multiline input. Long fixture collapses line structure.

**Proposal:** preserve line breaks, wrap safely, avoid aggressive ordinary-word breaking. Verify Romanian/Hungarian glyphs, names, amounts, lists, URLs.

**Done when:** sent note retains structure, copying stays exact, narrow/increased-text layouts do not overflow.

### FE-14 — Search only filters loaded titles

**P2 · Impact: memory retrieval · Effort: S honest filter; M actual search · Risk: medium, scope/read cost · Confidence: high**

[HistoryNav](../apps/web/src/components/HistoryNav.tsx#L35) filters loaded titles. Search chats implies broader retrieval while older chats need Load more. Long titles truncate/compete with author, options are [hover/focus-only](../apps/web/src/components/HistoryNav.tsx#L42), navigation rows are buttons.

**Proposal:** honest loaded-title filter now; bounded workspace-scoped server search over supported index when implemented. Recognizable titles/author, touch-visible options and real navigation links.

**Done when:** unloaded chats/supported facts findable, no-match scope clear, touch/middle-click/copy-link work, no fetch-all client memory.

### FE-15 — Errors mask causes or retry the wrong request

**P1 · Impact: recovery/trust · Effort: M · Risk: medium, access distinction · Confidence: high**

[Model query](../apps/web/src/ConversationScreen.tsx#L209) errors are unsurfaced, composer says choose a model. At observation time [SourcePane](../apps/web/src/components/SourcePane.tsx#L15) treated generic failures as possible retention loss without retry and [DetailPane](../apps/web/src/components/DetailPane.tsx#L20) refreshed only preview. Those source/detail issues now have concurrent repairs recorded above; remaining behavior must be verified.

**Proposal:** separate unavailable configuration, transient read, missing/expired source and revoked access; retry failed request in place, preserve draft/context, support IDs behind disclosure.

**Done when:** recovery retries correct request; 401/403 authority holds; 404 objects do not strand entire workspace. Concurrent initial-chat retry repair excluded.

### FE-16 — Accessibility gaps lie outside tested surfaces

**P1 · Impact: keyboard/screen-reader/mobile · Effort: M · Risk: medium · Confidence: high markup; assistive devices unverified**

[No-workspace](../apps/web/src/App.tsx#L54), [invite email](../apps/web/src/components/SettingsPane.tsx#L203), [new workspace](../apps/web/src/components/SettingsPane.tsx#L260) rely on placeholders. Native settings tree confirms unnamed email. [Suggestions](../apps/web/src/components/Composer.tsx#L203) lack complete focused-input/active-option/expanded relationships. No app skip link found. [A11y tests](../apps/web/test/a11y.test.tsx#L26) disable contrast and omit key settings/entry journeys.

**Proposal:** durable labels/errors/descriptions, main bypass, coherent suggestion announcements, tested overlay/detail focus entry/return. Preserve multiline semantics; physically check hit areas instead of overlapping pseudo-element padding.

**Done when:** keyboard journeys work, actual screen reader announces labels/options/state/context, browser contrast/large text cover failure/disabled states.

### FE-17 — Reply language changes the English UI's document language

**P2 · Impact: pronunciation/locale · Effort: M · Risk: medium · Confidence: high**

At observation time [Settings](../apps/web/src/components/SettingsPane.tsx#L80) set HTML lang from reply language although UI stayed English. Final recheck shows this changed to English; the original defect is addressed in source, pending verification. Display helpers still need a clear UI/reply/date policy.

**Proposal:** separate UI locale, requested reply language, reliable content-language metadata and schedule zone. English controls stay marked English until translated; deadlines unambiguous.

**Done when:** initial/settings metadata agree; multilingual content and English controls read correctly; date-only/timed distinct; contracts/fixtures coordinated.

### FE-18 — Provider status hides included access and overstates verification

**P2 · Impact: zero-setup confidence · Effort: M · Risk: high, credentials · Confidence: high**

[Status route](../apps/worker/src/routes/credentials.ts#L144) synthesizes available platform credentials with fresh last_verified_at without checking provider that request. [Connection UI](../apps/web/src/components/ProviderConnection.tsx#L20) maps availability to Connected and hides platform/override distinction. Removal was absent at observation; concurrent edits add it, with fallback labeling needing verification as recorded above.

**Proposal:** included access default; optional advanced own key; truthful configured/verified/effective-source states; remove override to restore platform priority. Voice evidence separate.

**Done when:** platform/valid-unverified-invalid BYOK/removal/load failure clear; secrets absent from bundles/logs/prompts/exports.

### FE-19 — Startup ships a large single feature bundle

**P2 · Impact: field cold load · Effort: M · Risk: medium · Confidence: high size/imports; device latency unmeasured**

Build entry is **1,056.66 kB JS / 313.54 kB gzip**. Rare settings/detail/auth eagerly reachable through [App](../apps/web/src/App.tsx#L9)/[router](../apps/web/src/router.tsx#L18). [Inter import](../apps/web/src/main.tsx#L5) emits seven font assets; static precache ~1.3 MiB. Unicode ranges mean not all fonts necessarily download before paint.

**Proposal:** measure mobile cold start; split nonessential surfaces; audit unused imports/font variants; retain latin-ext/offline essentials. No framework/library migration.

**Done when:** measured mobile load/interaction improves, essential capture has no lazy dead end, chunks/precache reflect intended boundaries.

### FE-20 — Hydration waits for every historical run

**P2 · Impact: opening/streaming · Effort: M · Risk: high, scoped hydration · Confidence: high pattern; medium measured severity**

[Snapshot](../apps/web/src/api/snapshot.ts#L35) has four reads then waits for a run request per distinct run. [Older load](../apps/web/src/ConversationScreen.tsx#L600) repeats it. One slow/failed run delays available messages. [Transcript](../apps/web/src/components/Transcript.tsx#L265) repeatedly filters activities/messages and joins tokens through history.

**Proposal:** bounded scoped batch or independent nonessential detail after authority; index relationships once; isolate active turn where profiling supports it. Preserve reading position; no DB streaming poll/heartbeat writes.

**Done when:** slow run does not blank authorized chat, access fails closed, 200+ message live-answer profiling usable, requests bounded, older anchors intact.

### FE-21 — Responsive layout is not complete phone delivery

**P2 · Impact: install/resume/offline/capture · Effort: L · Risk: medium/high · Confidence: high source; devices unverified**

[PWA](../apps/web/src/pwa.ts#L19) has no installability manifest. [UpdatePrompt](../apps/web/src/components/UpdatePrompt.tsx#L35) protects unsent/text drafts without explicit active-recorder guard. [Offline copy](../apps/web/src/components/UnavailableScreen.tsx#L16) says nothing was sent, too certain for unknown acknowledgements.

**Proposal:** complete icons/manifest/display as supported capability; actual-phone auth/keyboard/safe-area/resume; hold update during recording/finalization; truthful durable offline/unknown retry. No closed-page delivery promise without transport.

**Done when:** phone return/capture works, reload cannot interrupt unprotected recording, unknown response retries same identity without asserting no server receipt.

### FE-22 — Checks pass while journeys remain broken

**P1 · Impact: completion evidence · Effort: M · Risk: low/medium · Confidence: high**

[Design checker](../scripts/check-design.mjs#L213) bans named toolbar classes, unnamed stack passes. [Story checker](../scripts/check-stories.mjs#L56) counts strings. [Invite story](../apps/web/src/stories/Entry.stories.tsx#L54) shows no-workspace state, not redemption. Mock/contract stories are not feature proof. full-e2e is mocked happy-dom, not browser/Worker integration. Review HTML failed; wrapper needed. Fresh Storybook itself rendered.

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

Codex in-app Chromium on Windows, no Playwright. Conversation fixtures use existing [audit wrapper](qa/sol-audit-ui.html), production React/CSS and synthetic APIs. This does not prove authenticated Worker/provider behavior. Storybook was freshly built. CSS widths inspected through read-only DOM geometry; final representative captures use matching viewport clips.

| Width | Evidence | Observation |
|---|---|---|
| 360 × 800 | [Clarification](qa/sol-frontend-question-360.jpg), [long text](qa/sol-frontend-long-360.jpg) | Repeated question/receipt, paused work appears active; multilingual content inspected |
| 390 × 844 | [Partial](qa/sol-frontend-partial-390.jpg), [settings](qa/sol-frontend-settings-390.jpg); short reviewed | Partial truth exists; spacing/composer dominate; settings journeys need work |
| 900 × 900 | [Conversation](qa/sol-frontend-short-900.jpg) | Sidebar meaningful share; stacked composer/detached work |
| 1280 × 900 | [Inspection](qa/sol-frontend-detail-1280.jpg) | Valuable undo preview; repeated work/result hierarchy issues |
| 1440 × 900 | [Conversation](qa/sol-frontend-short-1440.jpg) | Gap/inset mismatch despite serviceable materials |

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
