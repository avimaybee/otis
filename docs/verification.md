# Verification and acceptance

This is the evidence contract for every implementation agent. Passing a command proves what that command exercises; it does not prove the whole product. Revised 2026-09-30.

## 1. Baseline commands

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build` after implementation changes. `pnpm build` must include a Worker dry-run bundle as well as the client. A clean-install gate uses `pnpm install --frozen-lockfile` in an appropriate clean environment. Do not install or regenerate a lockfile merely to hide a mismatch.

After documentation-only edits, check links, contract consistency and diff scope; rerun application tests only if a documented command/config/example was changed in executable code. Do not report prior tests as if rerun on the new commit.

Test layers:

| Layer | Proves | Does not prove |
|---|---|---|
| Pure TypeScript fixtures | Reducers, ranking, date interpretation, parsing, serialization | D1 transaction behavior or provider quality |
| Workers integration | Real local D1/DO APIs, bindings, SQL and route enforcement | Production provisioning or browser layout |
| Fake provider run | Policy, retries, continuation and orchestration for defined events | A live model obeys those policies |
| Synthetic live provider smoke | Exact endpoint capability on recorded samples | All languages/recording formats or guaranteed cache hits |
| DOM component test | Rendering, state and events in the chosen DOM | Browser layout, pinch zoom, real keyboard or device recording |
| Native browser inspection | Actual displayed layout and interaction at recorded conditions | Untested browsers/devices or durable backend correctness |
| Real-device voice test | Capture/codec/permission/interruption on that device | Every device in that OS family |
| Staging recovery drill | Actual environment runbook behavior | Legal compliance or unlimited recovery guarantees |

## 2. Foundational correctness matrix

Name test cases by behavior. Assert records and state, not only strings in the response.

| ID | Scenario | Required assertion | Owning gate |
|---|---|---|---|
| ID-01 | Wrong Firebase signature/audience/issuer/expiry | No valid session | 003A |
| ID-02 | Revoked member with old session/file URL | No transcript, action, stream or file access | 003/007/010/012 |
| ID-03 | Concurrent remove/transfer | Owner/last-member invariants hold | 003B |
| IN-01 | Same web UUID twice, lost first response | Same message/run, one effect | 004/007 |
| IN-02 | Same UUID with different chat/actor/body | Conflict without leaking previous content | 004A |
| IN-03 | Duplicate Telegram update/callback | One logical input/action | 009 |
| IN-04 | Crash after acceptance before wake-up | Outbox recovery eventually progresses | 004B |
| TX-01 | Failure late in D1 batch | No receipt/event/projection fragment | 002 |
| TX-02 | Same expected revision concurrent writes | Stale command fails atomically | 002 |
| TX-03 | Provider result arrives after lease loss | Fence rejects write | 004B/006 |
| TX-04 | Lost response after action commit | Receipt replay, no repeated action | 002/006 |
| UN-01 | Group suffix undo | Exact selected action set, atomic reverts | 002/007 |
| UN-02 | Independent later teammate edit | Later edit survives | 002 |
| UN-03 | Later dependent action | Typed conflict/question, no silent broad rollback | 002 |
| CF-01 | Conflicting current reports | Null disputed value, both sources preserved | 002 |
| CF-02 | Resolution and earlier-candidate undo | Deterministic result, no stale current value | 002 |
| CH-01 | Waiting for human, teammate submits | Pending question durable, teammate progresses | 004/006 |
| CH-02 | Reply after restart | Same unfinished request resumes once | 006 |
| ST-01 | SSE disconnect/replay | Ordered durable events, no duplicate UI writes | 007 |
| ST-02 | Access revoked with live stream | Subscriber revalidation closes/private data stops | 007 |

## 3. Agent and memory acceptance

Convert product Appendix A into versioned inputs and expected deltas. Update fixtures for the user's confirmed policy: inferred lead statuses require confirmation and missing deadlines must be asked. An old A1 fixture expecting an automatically warm lead and task due today is wrong.

Minimum language set: English, Romanian and Hungarian with diacritics. Include at least one held-out variation per seed scenario and record sample count; nine known examples are not enough evidence for a 95% general quality claim.

| ID | Case | Required result |
|---|---|---|
| AG-01 | Clear complete instruction | Correct sourced write without unnecessary confirmation |
| AG-02 | 'Send the offer' without date | Known facts saved, deadline asked, no invented due task |
| AG-03 | 'They seemed interested' | Note saved, status proposal asks before mutation |
| AG-04 | 'Mark Bistro warm' | Explicit status writes when entity unambiguous |
| AG-05 | Availability only | No commitment/reminder invented |
| AG-06 | Quoted/forwarded instruction injection | Logged data at most; no unauthorized tool action |
| AG-07 | Malformed tool arguments or other-workspace ID | Rejected before business writes |
| AG-08 | Provider error after a successful tool | Accurate partial answer with inspectable action |
| AG-09 | Token/action cap | No silent truncation/new writes; actual committed work reported |
| ME-01 | Durable preference, new chat/channel/restart | Recall in same workspace with correct source |
| ME-02 | Same user, different workspace | No preference or fact leakage |
| ME-03 | 'Only this answer briefly' | No durable preference promotion |
| ME-04 | Correction during summary generation | Old revision cannot publish |
| ME-05 | Forget then old transcript retrieval | Forgotten preference not re-promoted silently |
| ME-06 | Disputed field in older fluent summary | No confident stale answer |
| ME-07 | Queue/FTS failure | Direct source fallback; honest degraded retrieval |

Record match precision, abstention, wrong-write rate, unsupported assumptions, redundant questions, durable-memory promotion errors, source accuracy, latency and actual/unknown cost. A model that always asks and never works fails usability; a fluent model that guesses deadlines fails correctness. Prompt, model, schema or promotion-rule changes rerun relevant evals.

## 4. Voice, scheduling and file tests

- Record actual Android WebM/Opus, iPhone MP4/AAC and Telegram OGG/Opus samples with consent and no sensitive lead data. Record device/browser, codec, exact provider/model/endpoint and outcome.
- Test permission denied, stop/review/send/cancel, interruption, duration boundary, forged metadata, unsupported codec, byte-size limit, upload retry and orphan cleanup.
- Test no configured voice path, explicit secondary transcription routing and uncertain names/amounts/dates. Missing confidence metadata must not turn into fabricated numeric confidence.
- With a clock fixture, expire audio after 14 days while keeping transcript and source attribution. Deny removed members even with a previously issued link.
- Schedule starts disabled; changing time/days/timezone produces the member's requested behavior, with no 09:00 fallback. Test DST both directions, duplicate cron, schedule edits, no qualifying items and `/today` without schedule.
- The same brief appears on web and may notify Telegram once deliberately. Unknown Telegram send outcome must remain uncertain, not become delivered or trigger blind repeat.
- Parse XLSX independently: hidden IDs, three sheets, current disputed markers, timezone/currency formatting and formula safety. Opening WhatsApp/copying a draft never records sent.

## 5. Browser review procedure

The 2026-10-03 visual authority is design-tokens.md plus docs/design/approved-reference.png. Before claiming UI completion, run the path-correct implemented design checker and Storybook build, map every design.md fixture ID to its production-component story, and record token section 12 results at all five widths. Until these tools exist, mark them missing rather than passed. Exact recipes replace the older monochrome/white-Send directions. Historical screenshots do not prove the new baseline.

Required additional behavior cases: instant echo before delayed HTTP; lost acknowledgment after commit with same-UUID retry; HTTP/stream order inversion; no duplicate bubble/run; two rapid sends with next-draft preservation; active-run correction plus reachable Stop; silent command state reconciliation under a late old response; prepend while streaming; offline reload/foreground flush; revoked/account-changed local outbox; service-worker private-cache exclusion; completed-message-only screen-reader announcements. DOM tests need record assertions for idempotency and actual browser/device tests for geometry/keyboard/speech. Agent-run failure with saved writes is not a message-delivery retry case.

Use a running local/staging app in Codex or Antigravity's browser controls, as the user requested. Do not install Playwright. If browser tooling fails, record the failure and leave affected checks unverified. Screenshots or simulated DOM metrics alone cannot replace interactive inspection.

Review widths: 360, 390, intermediate around 900, desktop 1280 and 1440 CSS px; review 200% zoom/enlarged text. Record both viewport width and whether emulated or physical device. Test actual mobile keyboard and recording separately on Android/iPhone.

Required interactions: send multiline/IME text; slash filtering/selection/Escape; model switch; drawer close/focus return; teammate read-only chat; detail open/return; Working live/collapsed; single/group undo with dependency; reconnect/retry; reading old messages during new output; Stop versus Undo; disabled/configured brief; voice record/review/upload.

Check real overflow, focus order, labels, contrast, reduced motion, live-region verbosity, scroll anchors, safe areas and stable composer position. Use synthetic long Romanian/Hungarian text. The neutral charcoal palette, spacing and alignment must be judged from the rendered interface, not token existence.

## 6. Evidence record

For each review record commit, date, command/environment, exact pass/fail counts, any excluded/skipped cases, browser/device screenshots when relevant, defects and disposition. Never write 'all verified' while listing no evidence for a required layer.

Suggested result table: check ID, tested state, observed result, evidence path, reviewer, status (`passed`, `failed`, `unverified`, `not_applicable` with reason). Store screenshots under `docs/reviews/<date>-<gate>/` only if free of private data.

## 7. Release gates

Block real use for cross-workspace access, lost accepted input, duplicate business effects, unguarded stale writes, invalid source attribution, unreliable undo, secret leakage or false external-delivery claims. UI acceptance includes all required states, not only the happy path. A new API key, model or audio route needs its own capability evidence.

Staging exercises migration, restore/rebuild, export/erasure, retention and secret rotation. Do not treat a dry-run bundle as deployment verification. A successful one-day journey does not establish the two-week habit criterion. Product acceptance is measured during real dogfood after deployment readiness passes.


## 8. Field-use quality measurements (addition 2026-10-03)

Measure capture, memory, resurfacing and action separately. Targets below are planning goals to validate with real devices/providers/networks, not new unmeasured guarantees or permission to lower correctness. Record sample count, p50/p95 where useful, model/route, network/device, offline versus online, and failures. Synthetic UI timing is not deployed end-to-end latency.

| Measure | Definition and interpretation |
|---|---|
| Immediate echo | Send gesture to visible local bubble; target under 100 ms. Local durable receipt appears only after storage succeeds |
| Acceptance | Send to D1 commit/confirmed acknowledgment; candidate online target under 1 s. Separately record late/lost acknowledgments and actual commit time; offline waits are a distinct cohort |
| Voice transcript | From Send/upload stage to validated persisted transcript first displayed; candidate online target about 3–4 s, measure upload and STT separately |
| Finished reply | Existing targets: median text 5 s, voice 12 s; voice 8–12 s is an aspiration, not a promise. Count partial/failed runs separately; do not hide slow failures |
| Capture friction | Measure open→ready and stop→submitted separately from speaking duration. Under-5-second interaction overhead is a candidate; full-note time and locked-phone launch are not equivalent metrics |
| Clarification burden | Unique necessary questions per captured business note, segmented by ambiguity/language/input route. Candidate average below 0.3; never guess a date/status to meet it |
| Repeated resolved question | Duplicate ask for the same resolved operation/context without changed evidence; target zero. New ambiguity, alias collision and stale context are separate legitimate cases |
| Capture loss | Submitted operations/recordings lacking recoverable local data or server acceptance after interruption; investigate every loss and record storage limits without claiming unlimited durability |
| Correction / undo | Count wrong writes, user corrections and action undos, with reason and denominator. Low undo alone does not prove correctness or discoverability |
| Resurfacing usefulness | At least half of actionable brief items acted on; source saved item ID, time window and real Done/Draft/Move/Snooze or conversational result. Opening a link is not a completed external send |
| Habit | Existing two-week criterion: at least 5 of 7 days logged without Avi prompting; one-day demo is insufficient |

Additional evaluated journeys: one-handed weak-signal voice capture; kill/reopen with local data intact; validated transcript before final filing; shorthand corrected then recalled in another same-workspace chat; a later collision triggers a justified question; natural amount/entity correction with original report retained; a disputed field avoided by drafts/briefs; stale brief reply resolved against its saved item; ignored/empty brief causes no invented nudge.

Keep aggregate timings/counters and non-sensitive correlation IDs; raw field notes, provider bodies and audio do not belong in telemetry. Quality checks are owned by existing gates: 008 local capture/receipts, 010 transcript/device, 006 interpretation/aliases, 011 resurfacing, 012 drafts. No new analytics platform is required.
