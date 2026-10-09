# Verification and acceptance

Verification tests the intended behavior, not whether code resembles an old plan. [Status](status.md) owns dated results; [product](../product.md) and [design](../design.md) own intent. Keep historical reproduction probes separate from normal acceptance tests.

## 1. Commands

Implementation changes run from the root:

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

UI changes also run:

```powershell
pnpm check:design
```

Use targeted behavior checks appropriate to the change. `pnpm eval:agent` runs the deterministic eval project; it is separate from the root suite. `pnpm smoke:providers` and explicitly enabled live voice probes use real services; do not call them fake acceptance or run paid inference without the relevant authorization.

Documentation-only work requires local link/consistency/`git diff --check` checks. Record application commands only when actually run. This audit ran the root suite/build and UI tooling despite editing documentation, to reconcile old completion claims.

## 2. Meaningful local acceptance

| Area | Decisive checks |
|---|---|
| Identity/tenant | Two workspaces/members, forged/out-of-scope IDs, current membership loss, expected-member mismatch, author-only append/Stop |
| Lifecycle/secrets | Owner transfer/removal rules; BYOK replacement/removal/platform fallback; no keys in logs/public views; partial DELETE is not full erasure |
| Acceptance | Stable UUID/payload dedupe, changed-payload conflict, acceptance before response, duplicate hints, HTTP/stream inversion, reload/unknown acknowledgment |
| Atomic ledger | Membership/source/revision/attempt failure and late-batch failure roll back all neighboring writes in real D1 |
| Replay/rebuild/Undo | Identical action replay, collision rejection, deterministic versioned rebuild, suffix/single Undo and dependent/teammate work |
| Execution | Lost hints, expired claim, queue replay, actor restart/checkpoint, clarification slot release/revalidation, durable Stop |
| Providers | Exact model route, completed tools only, original argument/result/call identity, multi-round continuation, safe EOF/usage/error limits |
| Memory | Correct subject/scope/source/date, active-only retrieval, forgotten suppression, stale-summary rejection, aliases/ambiguity and old-context recovery |
| Dates/intent | Date-only vs instant/no deadline, actual calendar/timezone validity, unknown timezone, negation/quote/conditional/future/other-entity mutation |
| Activity | Subscribe/catch-up race, all pages, positive cursor/dedupe, stale publisher, live revocation, outside-actor final events, reconnect without missing prefix |
| Voice/images | Actual container bounds, scoped retained bytes, transcript-before-agent, resumed uploads, stateless image replay/history/view, unsupported/expired input honesty |
| Briefs | Disabled schedule, selected zone/days/channel, DST, one daily record, due-member discovery, concrete selection reasons, saved-item resolution and deduped delivery |
| Drafts | Requested-only create/revise, dispute avoidance, language/recipient preservation, actual copy result, normalized phone and explicit completed-send confirmation |
| Export/privacy | Actual XLSX reader/formula-safe cells/private download, complete machine-readable export and audited D1/R2/job erasure; currently missing |
| Client recovery | Real local storage result, immutable retry, two tabs/reload/late acceptance, scoped purge, local failure visibility and no automatic reload over unsent work |

Use actual local Workers/D1/DO/R2 for binding/transaction boundaries. Scripted providers make orchestration reproducible but do not establish a model's judgment, voice/vision support or latency. Test the failure scenario and user-visible result; a green reproduction expecting the bug remains defect evidence.

## 3. Response quality

Use the existing [34-case corpus](../plans/qa/2026-10-07-agent-response-cases.md), covering capture/recall/correction/ordinal references/partial success and varied tables. Ground expected records/tool authority, then assess usefulness, requested detail, scope coverage and necessary clarifications.

Compare fixed provider/model/effort on equivalent synthetic data. Include supplied comparisons, quotes, timelines, multi-owner tasks and arbitrary columns; one lead table is insufficient. Follow-ups must refer to the relevant result, and tables/recommendations must not perform unrequested writes. Record failures and token/round/latency differences, not exact prose snapshots. Live comparison has not been run by this documentation audit.

## 4. Native browser and device review

Use Codex/Antigravity native controls, no Playwright. Exercise production components/routes or clearly label a synthetic production-component fixture. Happy-dom geometry is not layout proof, Storybook build is not browser interaction, and viewport emulation is not a physical phone.

Compare token section 12 at 360, 390, 900, 1280 and 1440 CSS px, enlarged text/200% zoom and reduced motion. Record viewport/browser/build/fixture, observed result and screenshot where useful.

Cover multiline/IME send, question options/free text/Skip/Send/reopen, normal follow-up while a question is paused, several questions, route/reload/slow acknowledgment, commands/model/effort, drawer focus, teammate read-only history, Working/Thinking, wide/multiple/streaming tables/copy, Undo/detail/source failures, scroll anchoring while reading older content, Stop feedback, offline retry/update and record/review/upload/playback.

Check keyboard focus/labels, semantic table headers, page versus local overflow, live-region noise, safe areas and stable composer. Android/iPhone keyboard, interrupted recording, actual codecs and screen-reader announcements require device evidence.

## 5. Performance and usefulness

Measure send → local echo, durable acceptance, dispatch, context ready, provider first useful text, completion and render response separately. Voice measures upload → persisted transcript separately from later filing. Record sample count, p50/p95 when meaningful, model/effort, input/history size, network/device and failures.

Immediate feedback below 100 ms is the UX target. Native-like latency and old text/voice time targets are goals, not guarantees. No speed claim follows from a shorter prompt, passing validators, statement counts or a dry run.

Use actual D1 `rows_read`/`rows_written` and measured Worker/actor CPU; separate venue limits and network waiting. Include idle/hidden/reconnect costs and normal growing-workspace input, not only an empty fixture. Record capture losses, repeated resolved questions, corrections/Undo and whether brief items lead to useful action. Opening WhatsApp is not external-send success.

## 6. Evidence and release

Record baseline/tree/date, exact commands/results/skips, environment, source/test/browser/live/device boundaries and remaining failures. Do not overwrite old failing evidence when a fix/rerun passes.

Deployment validation uses the actual release/resource/schema identity and trusted synthetic accounts, then proves capture → reply → later retrieval, targeted question/Undo, disconnect/reload, media and chosen brief. Operations adds restore/rebuild, retention and key rotation. Dry-run bundle does not verify deployment or a two-week field habit.

Block the affected journey for demonstrated lost accepted input, cross-workspace disclosure, duplicate effects, stale unauthorized writes, secret leakage or false delivery. Keep optional refinements separate; do not require a platform rewrite or fictional exhaustive proof before practical use.

### Latest verification pass (Otis Usage Improvements & Complete Alignment)
- `pnpm typecheck`: Passed (`tsc --build`, 0 errors).
- `pnpm lint`: Passed (`eslint .`, 0 errors).
- `pnpm check:design`: Passed (`node scripts/check-design.mjs`, 94 files scanned, 0 violations).
- `pnpm build`: Passed (`vite build && tsc --build && wrangler deploy --dry-run --outdir dist-worker`, 0 errors).
- `packages/agent/test/tools-and-policy.test.ts`: Passed (40/40 tests).
- `apps/worker/test/records.integration.test.ts`: Passed (7/7 tests).
- `apps/web/test/records.test.tsx`: Passed (8/8 tests).
- `apps/web/test/a11y.test.tsx`: Passed (8/8 tests).
- Invariants preserved: Members list strictly under Workspace Settings; outward messages remain drafts only; internal timing in UTC with automatic local conversion; approved tokens strictly followed.
