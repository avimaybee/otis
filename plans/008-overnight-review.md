# Overnight independent review, 2026-10-04

Reviewer: Codex. Avi explicitly authorized monitoring and prompting the existing OpenCode implementation session, independent code review and browser verification. No commit, push or deployment. Preserve the dirty working tree. This record is evidence and actionable review, not acceptance of a gate.

## Connection and verified live work

- Existing OpenCode desktop background service is accessible through its authenticated local API; credentials are read locally and never reproduced here.
- Implementation session: `ses_f03ab0129ffeAosuk1THki88Ha`, title `implementation`, project `D:/vs code/Otis`. Existing model/settings retained.
- Authoritative session-message rows advance while the agent works on 008B. A user-authored 008C instruction is already queued. Do not create another implementation session or duplicate that assignment.
- Current Windows Computer Use skill requires `node_repl`, which is not exposed to this reviewer session. Browser/screen interaction is not yet verified. The local API enables monitoring/steering without pretending to have clicked the desktop.

## Confirmed review findings

### R1: Story inventory passes against a stale manually copied list

`apps/web/test/story-inventory.test.ts` compares story names only against `apps/web/src/stories/inventory.ts`. The actual design.md section 13 requires 92 fixture IDs; the copied list has 81. Missing: eight `work/thinking-*` states, `undo/mobile-scope-sheet`, `voice/recording-during-work`, `voice/amount-confirmation`. A passing test cannot establish full spec coverage.

Fix narrowly: derive/check expected IDs against design.md's fixture table and compare them with exported stories. Add real production stories for implemented states and explicitly contract-only stories for future voice states. Fail on omitted required IDs. Do not simply update another unverified hardcoded count.

### R2: Design checker misses integer spacing utilities and later declarations

Read-only execution of the actual checkFile function in a VM, with virtual fixture input and no filesystem mutation, confirmed both samples return zero failures:

```tsx
<div className="p-10 gap-5" />
```

```css
.sample { padding: 16px; gap: 10px; }
```

The first introduces spacing outside the approved inventory; the second has an off-grid gap in a later declaration. The utility check currently targets fractional values; authored CSS uses only the first spacing match on a line.

Fix narrowly: validate integer spacing utilities against the actual approved scale/exceptions, and inspect all matching CSS declarations on each line. Add persistent negative regression cases that execute the real checker logic. Keep runtime geometry distinguishable from visual literals. No broad component exemptions or new lint framework.

### R3: Canonical token store is exempt without checking its approved contents

`scripts/check-design.mjs` exempts globals.css from literal-color/type rules and does not validate its definitions against the immutable supplied token baseline. Current globals.css appears aligned; this finding concerns enforcement, not a claim of current palette drift.

Fix narrowly: verify the approved token definitions/recipe baseline against the corresponding supplied section, tolerating only documented imports/structural necessities. Add a negative test for changing an approved color/type/radius in the definition store. Preserve design-tokens.md's original hash. No parallel visual-value store or generalized CSS compiler.

## Existing limitations to keep explicit

- 008A REVIEW.md reports 447 tests, design checker and Storybook builds, but has no actual browser screenshots, computed-font checks or device evidence. Independently executed `pnpm check:design` passes; the above reproductions show why that result is insufficient for full enforcement.
- Message delivery stories currently reuse saved bubbles rather than showing actual sending/failed/Retry behavior; 008B must replace these with genuine stateful production fixtures before claiming lifecycle coverage.
- Overlay.tsx still implements native dialog/popstate behavior alongside generated shadcn Dialog/Sheet components. Verify actual ownership/focus/backdrop behavior during 008C; do not claim the full shadcn adoption is established by dependency installation.

## Review sequence

Continue 008B's send/accept/execute/reconcile path first. Repair these small verification gaps before relying on 008A/008B green status to enter 008C. Inspect actual new code and rerun owning checks. Then review the queued 008C implementation. Browser evidence remains a separate unproven requirement until real rendered evidence exists.


## R4 — rendered Tailwind compilation failure

New independently rendered P1 finding (R4): apps/web/storybook-static chat--short at 390x844 is visibly serif/unstyled. Chrome computed assistant paragraph font is Times New Roman, body Times New Roman, approved --font-sans absent; screenshot apps/web/storybook-static/review-chat-390.png. Compiled iframe CSS still contains literal @theme and @apply directives. apps/web/vite.config.ts only has react(), and .storybook/main.ts no Tailwind hook. Root Vite may compile app correctly; check BOTH actual app and Storybook pipelines. Narrow fix: wire existing @tailwindcss/vite into the pipeline(s) actually used, share existing config where appropriate. Rebuild stories and web, then verify computed Inter, 16px/24px message type, token foreground/background and emitted utilities in a real rendered browser. Do not merely add font inline or hide fixture failure. I have isolated native Chrome headless serving synthetic Storybook at port5488, no Playwright. This is real browser evidence, not physical-phone evidence. Keep 008A review pending until corrected. Continue B primary flow, integrate this narrow baseline fix.


## R5 — outbox persistence failure does not reach UI

R5, narrowly reproduced against current outbox.ts through TypeScript transpile + VM injection of failing idb-keyval (no source mutation): createOutboxEntry followed by async idbSet rejection returns outboxDurable=false but entry.durable=true and only creation notification; failure doesn't notify subscribers. Therefore deriveTranscript still advertises durable=true for the affected bubble and storage loss can remain invisible. Fix using one truthful durability owner or synchronizing entry flags + notifying on failure/recovery, avoiding new storage abstraction. Existing persistence test merely calls rehydrateOutbox and checks an entry exists; it doesn't force a rejected write or prove reload. Add controlled IDB rejection/recovery and actual reload/unknown-acceptance tests. Ensure logout/new-chat mapping cleanup is scoped and sensitive content is removed durably. No need to expand into full 008D cross-tab machinery.


## R6 — streaming remainder silently dropped

R6 concrete StreamPublisher data loss: independently transpiled current streamPublish.ts in VM, injected successful async publish, pushThinking one append of 5000 chars (below 24000 cap), await close('complete'). Result: only 2000 chars published, states streaming+complete; 3000 silently lost. close flushes only one batch, while size-trigger started only one batch. Drain authorized remainder fully before terminal metadata. Also existing void flushText/flushBlock aren't represented by this.ticking, so close doesn't await outstanding size-trigger persistence; prove async delayed/rejected publishes cannot produce terminal-before-delta or unhandled rejection. Use one small serial flush path, not a framework. Regression: large single delta and 200 small deltas, slow publish while close, interruption and cap preserve all authorized text and exactly one truncation marker. Cap doc says per-run while publisher constructed per-round; verify genuine per-run accounting or document/implement agreed bound correctly. Primary send flow still first; this is its stream reliability boundary.


### R4 verification and R6 follow-up

R6 follow-up from current serial-chain implementation: large delta drain is repaired, but cap terminal receipt collides. I pushed 30 x 1000-character deltas, awaited tick after each, then close('complete'), with publish recording first-write-wins keys as real activity receipts do. It attempted r0_think_b0_end state=complete then SAME KEY state=truncated. Durable record remains complete; truncation disappears. Choose terminal state once (truncated takes precedence) or unique noncolliding marker; no duplicate end receipt. Regression must use idempotent keyed publication, not only calls array, to prove exactly one durable truncation. Also test final flush rejection explicitly: close currently catches/returns success and is permanently closed, unlike earlier tick retries. Keep failure behavior honest and don't claim drained if publishing final remainder failed. Browser R4 independently now verified at 390x844: Inter loaded, message16px/24px foreground243, canvas24, no overflow. Evidence screenshot review-chat-390-fixed.png. Specific R4 closed; full 008A visual acceptance still pending.


## R7 — unlayered reset overrides button contrast

R7 P1 rendered controls unreadable: built 008A Storybook composer--short at390 shows Send foreground rgb(243,243,243) on highlight rgb(226,216,107), should foreground token rgb24. composer--follow-up Stop foreground243 ON background243, square invisible. settings--personal Save timezone also foreground243/background243 (disabled opacity dims both, still no label contrast). Actual cause: apps/web/src/index.css unlayered button/input/textarea/select reset with font:inherit;color:inherit beats layered Tailwind/shadcn utilities. Fix cascade narrowly (appropriate base layer/remove redundant reset) so token utility colors/type prevail; no inline palette patches. Verify computed active Send/Stop/default/destructive/neutral button colors and label sizes in real browser, including enabled & disabled save state. Screenshots + raw metrics saved plans/008-browser-evidence/rendered-baseline.json and *.png. No source edits by reviewer. Separate fixture issue: command--model-long-names renders Composer at y0; menu above viewport entirely invisible despite6buttons inDOM. Frame command/Composer stories at realistic bottom in shared production shell (or small Storybook-only decorator), so visual tests can actually inspect menus/long names. Don't count nonexistent-on-screen popup as passed. Follow-up dual buttons are current old B integration, ensure final agreed single slot + reachable overflow Stop.


## Independent recheck, 01:02 local runtime

- R4 specific compile failure closed: real rendered Chrome confirms Inter loaded, body canvas rgb(24,24,24), assistant foreground rgb(243,243,243), message 16px/24px. Long Hungarian chat fits 360/390/900/1280/1440 without horizontal document overflow. These are isolated component stories, not complete app/device acceptance.
- Captured baseline screens/metrics under plans/008-browser-evidence; metadata names Chrome version, compiled CSS hash and synthetic-only verification scope.
- R6 original 5000-char loss reproduction now publishes all 5000. First-write-wins cap reproduction retains exactly one durable truncated terminal and 24000 chars. This closes those reproduced paths; final whole-turn integration remains pending.
- Independently ran pnpm exec vitest run apps/worker/test/stream-publish.test.ts apps/web/test/outbox.test.ts apps/web/test/thinking.test.ts with TEMP/TMP D:/wtmp: 3 files, 32 tests passed. No acceptance of full gate from this focused suite.
- R5 source now uses global durability passed to transcript and notifies on failure/recovery; scoped new-chat mapping cleanup added. Persistence rejection/reload and UI integration evidence still required.
- R7 actual contrast failure and offscreen command fixture sent to existing implementation session. R1–R3 enforcement findings still require reviewed fixes. Agent remains working on 008B; 008C stays queued. No source edits, commit, push or deploy by reviewer.


## R8 — new-chat setup blocks sending and invalidates its own operation

R8 P1 new-chat blockers in freshly written ConversationScreen.tsx (not an acceptance claim): (1) useModels(..., readOnly || accessLost || !snapshot) disables model reads when activeChatId=null. A new chat has no snapshot forever until first send, while Composer modelReady requires available is_current model and disables Send. Chicken-and-egg; new chat must load scoped workspace model without requiring existing snapshot. (2) deliverEntry captures epoch then internally navigate(workspaceId,createdChatId) increments epoch. If subsequent send fails, catch generation!==epoch returns false before markOutboxFailed, leaving this input 'sending' indefinitely; if accepted, returns early before refresh logic. (3) applyCommand also internally navigates after creating chat, then its own generation guard returns before authoritative model/detail refresh and control result/reset. Treat self-created navigation as same operation, with explicit account/workspace/chat target fencing; don't drop or cross-route operation. Decisive real component tests: fresh new chat resolves model and sends; delayed create + POST reject shows its exact failed bubble and same-UUID Retry; lost ack after creation reload dedupe; /model or /thinking from empty chat updates server-confirmed UI with no transcript control bubble. Finish primary flow before more fixture work; fixes remain narrow, no backend redesign.


### R8 full production-client browser reproduction

R8 browser follow-up: reviewer now ran production App in native Chrome390x844 with synthetic API (not Worker/provider acceptance). Reproduction persisted plans/008-browser-evidence/synthetic-app-probe.mjs/.json and app-failed-delivery-390.png. Held GET /chats?filter=mine after POST chat creation. At60ms optimistic echo was absent; at560ms message POST hadn't begun. Trace create at241.8ms, sidebar GET268.4ms, actual POST messages only846.2ms AFTER explicitly releasing sidebar GET. Root: updateOutboxChatId moves pending entry away from null selection before navigation; await invalidateQueries waits unrelated nav network before navigate/submit. Never await sidebar refetch on primary send/command path. Keep local entry visible across self-created chat mapping/navigation, then kick nav refresh independently. Failure bubble now appears once submit rejects, so don't undo repaired self-navigation fencing. Extend real component tests with delayed sidebar refetch and fast chat creation, assert visible echo <=100ms + POST starts before releasing sidebar GET. Also final Composer must clear/snapshot accepted-local draft without waiting HTTP so two rapid messages can submit (current await deliverEntry keeps sendingRef locked until ack); delegate delivery to existing local outbox, no new framework/service.


## R9 — critical Retry hidden with secondary hover actions

R9 P1 actual failed-message UX: browser probe now verifies echo=true at60ms, POST starts before held sidebar GET, failure produces same-UUID Retry and one bubble after retry. These R8 paths are repaired. BUT failure status+Retry live inside .otis-turn__actions, whose opacity=0 on hover/fine pointer hides both unless hovered. Screenshot app-failed-delivery-390.png visibly has NO Retry, despiteDOMexists/our clickscriptfindingit. Failure/delivery feedback must be visible beside its message regardless of hover; secondary copy/edit may remain hover-only. Also deliverEntry sets global error+Reload conversation for a send failure and Composer onSend false duplicates error; remove unrelated global/Composer error for a correctly stored failed entry. Keep errors attached to immutable message Retry; retain scope/auth/snapshot error handling separately. Another pending-send gap: releasing sendingRef in Composer isn't enough while button disabled includes sending until HTTP resolves. Test TWO real button clicks (or mobile tap) while first POST gate remains pending; keyboard-only test can bypass disabledbutton and falsely pass. Leave Send usable for newer nonempty draft and avoid stale ack/errors touching newer composer. All narrow fixes on current owners; no new queue/framework.


## Full production-client probe progress

Native Chrome on local Vite5490, synthetic API only: rerun now proves optimistic echo present at60ms, input POST starts before releasing delayed sidebar refetch, Retry available inDOM, same UUID reused, one bubble after retry. R8's reproduced paths closed. Full source remains mid-implementation; this is not actual Worker/provider/queue acceptance. Probe uses a clearly labeled synthetic EventSource after the original unmocked native EventSource caused expected reconnect notice; that notice is not a reported app defect. R9 remains: Retry was opacity-hidden in secondary actions and send failures created an unrelated global Reload-conversation panel. Reviewer handed off exact browser evidence, no application source edits.

Review infrastructure: isolated Chrome profile relocated to D:/wtmp/otis-headless-review; local Vite process47764 at5490 and Storybook static server83441 at5488. Automatic approval review rejected removal of generated old storybook-static/review-profile directory ('blocked by policy'); directory left intact, Chrome closed before launching outside repo. No alternative delete attempted. Profile/browser/site storage are synthetic review-only.


### R5 delayed hydration overwrites freshly created input

R5 pending persistence/reload edge independently reproduced: App fire-and-forgets rehydrateOutbox alongside loadSession, so can expose send before hydration completes. In VM on current actual outbox.ts, idbGet deferred; start rehydrateOutbox; createOutboxEntry; resolve valid stored snapshot {schemaVersion:1,entries:[],newChats:{}}; await rehydrate. New entry disappeared (created=true, retainedAfterRestore=false), because restore clears memory map. Fix narrowly: one hydration boundary before interactive send OR merge restoring entries without overwriting local operations created since restore began. Keep UX honest on rejected storage and don't lose memory-only input. Add meaningful IDB rejection/recovery + delayed hydration + reload unknown-acceptance tests, not only asserting entry exists after generic rehydrate. R8 browser paths now verified repaired; R9 current visual failure remains the owning UI finding. Finish B flow + these exact tests, then full checks and report, leaving review pending.


## R5/R8/R9 independent reproduced-path closure

Reviewer rechecks now pass the reproduced R5/R8/R9 paths: delayed restore retains newly created entry; real production-App Chrome probe newchat echoes at60ms, sends before held sidebar GET, same-UUID Retry leaves one bubble; existing-chat probe performs TWO real Send button clicks while first POST still pending with distinct submission IDs, then first-message retry reuses its ID. Failure/Retry are now visibly attached to the bubble and unrelated global Reload-conversation error gone. Evidence plans/008-browser-evidence/{synthetic-app-probe.json,two-send-probe.json,app-failed-delivery-390.png}. These specific reproduced failures closed, not full 008B acceptance or server/provider evidence. Please continue remaining B requirements: genuine grouped Thinking, functional cmdk controls and authoritative effort state; close R1–R3 checker/inventory regressions; full owning checks, Storybook rebuild, real local accept-to-answer with existing fake provider/Worker fixtures (no cron required). Keep gate review pending and preserve queued008C. Don't redesign runtime or expand dependencies.

## Thirty-minute review — resumed after provider error

Authoritative OpenCode active-session API returned empty; latest assistant record seq13021 ended provider.invalid-request HTTP400. This is an interrupted implementation, not checkpoint completion. Sent continuation to same existing session (msg_10376d1ca001d36VUosCg1JHPr); did not restart service or switch model. Inbox was empty, so requested factual queued008C boundary report rather than duplicating its original prompt.

Independent checks on current tree: check-design self-test passed10 cases; focused Vitest4files22tests passed (outbox-durability, thinking, controls, dispatch-promptness). R2/R3 original enforcement holes now addressed by integer scale scanning, later CSS declaration checks, canonical globals comparison against immutable section9 and pinned token hash. This supports those narrow regressions, not full gate acceptance. Inventory includes previously missing fixture IDs, but test still only compares copied inventory with stories: requested separate exact design.md table assertion. ThinkingDisclosure now wired to Transcript via reduceThinking; rendered behavior remains to verify.

Two bounded review follow-ups: literal // excluded by Composer picker but submit still interprets any leading slash as command; require consistent literal handling and test. New dispatch-promptness test manually calls dispatchWorkspace after acceptWebMessage, proving dispatcher execution, not production HTTP acceptance wake-up/queue consumer. Requested owning route/queue fake-provider proof without cron. No application source edits, commits, pushes or deployment by reviewer.

## Independent full checks and supported session recovery

Independent current-tree checks: pnpm test500passed/39files, pnpm typecheck0, pnpm lint0, pnpm build0 (Vite + TypeScript + Wrangler dry-run; no deploy), native synthetic production-App browser send/retry probe passed again. Full tests emitted localhost3000 ECONNREFUSED noise despite exit0; this is recorded rather than suppressed or interpreted as provider success. Bundle size warning remains a performance follow-up, not reason for broad architecture changes.

Continuation hit same provider.invalid-request400 atseq13044; no checkpoint report. Discovered actual OpenCode /openapi.json documented POST /api/session/{sessionID}/compact, admitting durable compaction with delivery steer. Requested supported compaction on existing session, keeping model and working tree unchanged. No guessing undocumented mutation endpoints, changing credentials, editing its DB/history, or service restart.

## 008B follow-up report and 008C continuation

OpenCode completed a public report atseq13531 (finish stop; noerror), confirms queued008C only scaffolding occurred. Independent focused rerun27tests/3files passed: inventory exact design-table set, Composer/conversation literal handling, workerd promptness. New route test proves production handleCreateMessage auth/CSRF202 and dispatch hint published, followed by direct dispatchWorkspace(fakeprovider) to reply. It does not invoke exported queue consumer or deployed queue; evidence must retain that limitation.

Reviewer nativeChrome Storybook sampled25cases at360/390/900/1280/1440 height844. Artifact storybook-review.json +screenshots. Verified sampled Send foreground24 onhighlight226, Inter; nohorizontaloverflow; longmodelpicker on-screen and wraps; live/truncatedThinking one nestedtrigger andpublicsummary/terminalcopy. These are synthetic renderedcomponentfixtures, not fullappdevice orauthenticatedprovideracceptance. Visual inspection command--model-long-names390 andwork--thinking-truncated390 confirms actualrender. R7contrast reproduction closed. No allfixtureorallinteractionclaim.

Continued original user-authorized008C scope on same implementation session after its report, referencing existing handoffsection6 and requiring factualscope/checks. Requested narrow Stop-menu action semantics fix while implementing accessibility. 008A/B remain review-pending for broader evidence; progressingC does not fabricateBdeployedacceptance. No sourceimplementationbyreviewer, no commit/push/deploy.

## 008C R10 — late acknowledgement overrides released reading position

Independent nativeChrome production-App reproduction with synthetic80message existingchat: first POST held, send, scroll reader to200, then resolve202; after500ms scrollTop10561 (max11264), preservedfalse. Artifact delayed-ack-scroll.mjs/json. Current deliverEntry advances followSignal only after HTTPack, while local send only creates outboxentry. This steals reading position after explicit userrelease. Requested follow on localacceptance only and no lateack/retry force-follow. No sourceimplementationbyreviewer.

Related source-audit follow-up sent: browserBack/Forward changes routeprops withoutincrementepoch; olddeliverEntry catch checks epoch then callsloseAccess on authfailure, so potentiallateoldroutefailure closingcurrentroute. Requested owningpausedsendA/externalrouteB/A403test and targetedoperationfence, preserving self-creatednavigation invariants. This second concern is sourceaudit pendingtest, not browser-confirmedfailure. OpenCode session remainedliveworking008C duringreview.

## 008C report review — scope incomplete, R10 repaired

OpenCode terminal report seq16326 (finish stop, no error). It reports530tests/40files and labels008C implemented-reviewpending, but explicitly defers shadcn/vaul drawer migration, per-message language/workspace display timezone and bounded entity-history contract. Reviewer has NOT accepted008C.

Independent focused3files45tests passed (scroll-route, full-e2e-flows, controls), with localhost3000 ECONNREFUSED noise recorded. NativeChrome delayed-ack production-client syntheticprobe now before562/after562, preservedtrue: specificR10closed. Reading reached562 beforeack due initialsettling; equality proves no lateackyank, not exactanchor200 or universalfollowacceptance.

Sent follow-up requiring approved shadcn drawer owner, mounted-composer observation/published geometry (stable RefObject effect misses readOnly->own/elementreplacement; measuredreturn currentlydiscarded), honest scope status, exact additive language/timezone/history contract gaps instead of claiming fullimplementation. Also requested completed-message announcements while prependquietwindow overlaps completion. These are review concerns needing targetedproof, not allbrowser-reproduced failures. OriginalCscope remainsactive, noPWA/voice/runtimeexpansion. No sourceimplementationbyreviewer, no commit/push/deploy.

## 008C R11 — Vaul drawer layering, independently rendered

Latest implementation report seq17158 explicitly marks008C PARTIAL and supplies concrete contract proposals. Viewport callback-ref+CSSvariables and Vaul shared history/focus source now present. Independent focused2files45tests passed (scroll-route/full-e2e; localhost3000noise remains recorded). No fullCacceptance.

Native Chrome production-App synthetic drawer/back/focus probe: drawer opensone dialog, focusClosehistory, Back closesdialog, focusreturnOpenhistory andsameURL withtextarea retained. Artifact drawer-review.mjs/json. Screenshot drawer-390-review.png exposes conversationtopbar/title/options/newchat painting OVER drawer/scrim. R11 actualrenderedfailure sent: modal Vaul portal lacks above-headerstacking; nestedContent+nav duplicate otis-drawer absoluteinset surfaces. Requested approved shared overlaylayer andone positioned drawer surface, preservegoodBack/focus. No sourceimplementationbyreviewer.

Contract proposal D3 memberparity already establishedbyuser; told implementation not to ask redundant authorization. Genuinelynew visualcontrols withoutrecipes remainexplicitproposed, userasleep; ongoingverification/fixescontinue independently. No commit/push/deploy.

## R11 rendered closure; independent008D dispatched

OpenCode terminal report seq17384 confirms R11 narrow layering/surface fix. Reviewer reran nativeChrome production-App synthetic drawer390: one surface, one dialog, initialClosehistory focus, Back closesandreturnsOpenhistory, samechatURL. Screenshot visually confirmsheaderbehinddrawer; specificR11closed. Shared existingoverlaylayer10, notnewtoken. Ccontract/devicegapsremainexplicitPARTIAL, notacceptedfullC.

Dispatched existing008Dscope fromhandoffsection7 on sameimplementation session: shared durableoutbox/drafts, scoped singleflush andcross-tabcoordination, boundedretry/RetryAfter/permanentfailures, staticonlyPWA/cache/update, authrevocationfences, requiredtestmatrix. This is independent of unresolvedCnewcontrol decisions. Preserve repairedowners, no voice/STT/services/commit/push/deploy. Reviewer goalcontinues; no projectcompletionclaim.

## 008D first review — scope, atomicity, ordering, rate limits, update activation

OpenCode stillliveimplementingD. Source audit P0: flush selects entriesForUser acrossworkspaces, deliverEntry uses currentworkspaceId APIpath instead of immutableentryworkspaceId; newchatA flushedonviewB canwriteB. Sent exacttestrequest; sourceconfirmed, browserwrite notperformed.

Independent actualtranspiledflush.ts twoVMtab modules/sharedIDB reproduction: B initialemptyget held, Aclaim+workheld, releaseBget -> Bset/read/work alsoenterswhileAactive. Output AStillWorkingtrue/BEnteredWhileAWorkingtrue. Non-atomicget/set/get fallbackdoesnotproveexclusiveclaim. Requestedatomictransaction/tokenrelease/expiryhandling. Independent RetryAfter600000ms returns300000ms; serverlowerboundshortened. Requestedhonoringserverinstant.

Further concrete source findings: duefilterpermitsnewersamechatinputsovertakeoldernotdue; immediatesend bypassesflushowner. UpdatePrompt lacksupdateServiceWorker activation andjustreloads waitingworker; draftsremain sessionStorage ratherthanrequiredIndexedDB. Sent boundedfix/testinstructions preservingoptimisticecho andsingleowner/simplemodules. NoDacceptance fromcurrenttests, no sourceimplementationbyreviewer/commit/push/deploy.

## 008D follow-up — transaction completion and one acceptance owner

Currentsource now has atomicclaim transaction helpers and RetryAfter600s independentlyreturns600000ms. Specificnumericrate-limitfailureclosed. Reviewer actualtranspiledacquireFlushClaim with discriminatingabort-after-put-successIDBfactory: reportsacquiredtrueandDBclosedbeforelatertransactionabort. runClaimTransaction resolvesfromrequestsuccesspromise beforetx.oncomplete; requestedresultresolveonlyoncommit,abortreject, testsacquire/renew/release.

Renewaltimer ignoresfalse/errors, holdercontinuesafterlease loss. ImmediateSend/Retry explicitlybypassflushowner despiteone-owner/perchatrequirements. Sent correction distinguishing instantaneousLOCALfollow-upsubmission fromorderedHTTPacceptance: bothUUIDbubbles/draftclearimmediate; secondHTTPmaywaitfirst202butneverfirstMODELcompletion. OldBparallelPOSTprobewasincidentalmechanism, notuserrequirement; mustupdateproofscopewithoutblockingfollowupswhileagentworks. Preserveacceptedrunconcurrency/optimisticechoandscroll. No sourceimplementationbyreviewer, no commit/push/deploy.

## 008D independent data-loss/purge reproductions after report

OpenCode terminalreportseq21408 claims564tests/41files. Independentfocusedoffline-flush/outbox-durability38tests/2files pass, butactualtranspiledmodules reveal missingcoverage:
1. saveDraft(new,'Unsent correction'), moveDraft(new,created,differentsenttext), loadcreated=null. Sameuserrecord overwrittenby stale source afterdestwrite.
2. pause saveDraft initialget, deleteDraftsForUser, releaseget -> private draft restoredafterpurge.
3. twoVMoutbox modules/sharedIDB bothhydrateempty; ApersistunsentA thenBpersistunsentB -> persistedIds[B-1], lostAtrue. Wholelocalsnapshot idbSet overwritesother-tabentries. Flushclaims do notguardpersistence.

Sent narrowatomicdraftmove, purgegeneration/transaction, cross-taboutboxentrypersistence/removal tests andfixinstructions. No union-onlymerge that resurrectsremovedcontent. No sourceimplementationbyreviewer, commit/push/deploy. Dstillunaccepted, actualdatareproductionsoutweighgreenfocusedchecks.


## 008D owner purge and fresh hydration follow-up

Reviewer reproduced logout trailing-save resurrection against actual draft module, and audited unknown cross-tab rows retained by whole-record outbox merge. OpenCode fixed with persisted owner generation after interrupted provider400 session recovery. Independent focused46tests passed, then reviewer reproduced fresh-module generation1 draft returned but rejected by Composer mount guard. Source showed first deferred outbox restore could delete freshly submitted entries. Sent owning-flow regression requests; implementation added first-observation distinction and deferred-restore production-screen test.

Independent latest pnpm exec vitest run --project web:151tests/11files exit0; localhost3000 ECONNREFUSED log noise remains. Native Chrome production-App synthetic API probe passed new-chat immediate echo, POST before held sidebar GET, visible attached Retry, same UUID retry, one bubble. Updated reviewer two-send diagnostic to assert required instant LOCAL follow-up rather than incidental parallel HTTP posts: both local bubbles before first acknowledgement, postsBeforeFirstAck1, original UUID retry then second distinct UUID delivered in order, both bubbles preserved. Artifacts synthetic-app-probe.json/two-send-probe.json. This is browser/client evidence only, not provider/deployed/physical-device acceptance.

OpenCode reports latest full-suite attempt blocked by C drive SQLITE_FULL; latest independently verified full current-tree worker suite remains older, so do not carry it forward as fresh. No deletion to manufacture space, no source implementation by reviewer, no commit/push/deploy. 008D remains review pending for broader offline-shell and checklist evidence; 008C contract/device gaps remain explicit.


## Built offline shell native-browser evidence and update drain boundary

Served existing production build on isolated localhost5492 (Python static server handle23438). Native Chrome isolated new target with synthetic online identity registered actual built service worker; subsequent offline navigation loaded cached unavailable entry. Observed caches contain only indexHTML, hashedJS/CSS and fonts, no/api entries. Artifacts offline-shell.mjs/json/png. This proves static shell after initial online cache under browser offline emulation, not installability/privatehistory/device/weaknetwork/provider acceptance. Manifest remains disabled pending approved assets.

Requested update action drain pending IndexedDB drafts and precise offline copy. OpenCode reportseq24365 implements flushUserDraftSaves and153webtests. Independent actual-module held-write repro after debounce timer fires: writeStartedtrue, flushReportsSafetrue, committedBeforeActivationfalse. pendingSaves entry disappears before write settles; update drain overlooks in-flight writes. Sent narrow owner write-drain + dirtyfailure + post-await unsentrecheck regressions. No source edits by reviewer, commit/push/deploy. Review stays pending.


## Latest independent update drain and five-width conversation check

Actual drafts-module held timer recheck after seq24666: writeStartedtrue, drainSettledBeforeCommitfalse, safeAfterCommittrue, storedTextlastword. Specific running-write blind spot closed. Latest independent web156test run155pass1failure: R8 wall-clock React.act measurement127msvs100 under parallel load; focused same test passes. Requested deterministic local-acceptance proof plus browser quantitative measurement (not weakening100ms productrequirement), and final synchronous draft-safe check after bounded update re-drain.

Updated reviewer nativeChrome synthetic production-App diagnostic for five widths360x800,390x844,900/1280/1440x844. Initial probes incorrectly focused textarea while disabled during existing-chat loading; diagnostic inputempty/focusBODY identified harnessissue. Waitingforenabledtextarea fixed this without appsourcechanges. Isolated fresh target per probe avoids accumulated injections; closes only its own headless target. Allfive widths pass immediateEcho,secondLocalSendBeforeFirstAck,sameUuidOnRetry,bubblesAfterRetry1,distinctSubmissionIds, pageOverflowfalse. Artifacts two-send-probe-<width>.json and app-failed-delivery-<width>.png. Scope: send/retry/optimisticfollowups nativebrowser withsyntheticAPI; NOT complete keyboard/scroll/stream/device/provideracceptance. No sourceimplementation/commit/push/deploy.

## Reviewer verification 2026-10-04T05:59:09.563Z

- Independently reran containment + chat API: 58/58 tests passed in local workerd.
- Independently reran current full suite: 586/586 tests across 42 files passed (55.84s). Root typecheck/lint pass; git diff --check passes with existing LF/CRLF warnings. Localhost:3000 connection-refused noise remains in test output; not treated as provider/deployed evidence.
- Source review confirms pure-read verifySession, idle cursor fast path, counted SSE query rotation with clean close. This is local containment, not deployment or replacement of D1 streaming.
- Plan 014 remains proposal/review pending. Initial and first amended drafts retained contradictory persisted-preview caps and ambiguous routing. Second draft now chooses scoped publication RPC and separate preview sequences; still needs request-budget arithmetic, hibernation/auth enforcement details and race-safe active-terminal repair. No transport source implementation approved yet.

## Architecture followup and assigned implementation

- Source-confirmed nine-finding audit recorded in plans/015-foundation-efficiency-review.md; unconditional projection rewrites are stronger than attached load-all diagnosis. Generic Undo-replay rewrite rejected: existing dependency guard + deterministic sequence replay verified.
- Assigned OpenCode explicit 015A.1 changed-only projection persistence with before/after real D1 metadata, immutable pre-handler persisted-value snapshots and preservation of guard/revision/FK/replay/Undo/FTS invariants. Full-state reads remain for this bounded task; guard storage/transport/concurrency unassigned for source changes.
- Native Chrome 390px production App synthetic transport rerun: immediate optimistic echo, sendable second local message before first acknowledgment, ordered HTTP acceptance, same UUID Retry, one bubble per input, no horizontal overflow all passed. This is browser/client synthetic API evidence, not deployed provider proof.
- Current root build passed (dry-run only). 014 five-choice revision chooses consolidated actor execution; lost final broadcast with no later event still requires an actual repair trigger, not only a gap rule. Review pending.

## 2026-10-04 follow-up: 015A.1 test review during implementation
- Main OpenCode session confirmed running via /api/session/active; no ledger source diff at first inspection, new ledger-footprint integration fixture in progress.
- Reviewer sent narrow corrections: exclude verification reads from operation counters; filter projection writes by verb; isolate custom handlers whose note events cannot replay their projection mutation; use real Undo/memory supersession/revert behavior; unavailable failed-batch metadata is not measured zero cost.
- Product-gap attachment source-checked and captured in 013-dogfood-loop-review.md, with actual multilingual status-policy probe artifact. Context only sent to implementation agent; current 015A.1 source scope remains unchanged.
- 014 remains a proposal: final-notification loss with no subsequent event still needs a bounded repair trigger; live expiry/stop/membership invalidation cannot be replaced by comparing an unchanged in-memory fence.
