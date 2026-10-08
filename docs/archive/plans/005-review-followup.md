> Closed historical plan record, reconciled 2026-10-07 from `plans/005-review-followup.md`. Family 005: adapters and historical route evidence present; accounting/quality partial. Remaining R07, R13 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# Gate 005 review follow-up — 2026-10-01

Latest review: the three gaps from the stateless Responses/bounded smoke review are independently closed. Current source, regression suites and synthetic reproductions confirm registry availability, strict result-set validation and rejection of unexpected later smoke tools. Latest verification passes 247 tests / 20 suites and root checks. See final acceptance below. Earlier findings and acceptance records are historical.

Status: ACCEPTED for Plan 006 development, 2026-10-01. Three independently proven models are enabled in the production registry; secondary models remain unverified/disabled. Independent verification passes 247 tests / 20 suites, typecheck, lint, build dry-run and git diff --check. No real-key inference or source edits were performed by the reviewer in this acceptance pass.

## Independent verification and accepted fixes

The reviewer reran typecheck, lint, 213 tests across 19 suites, build including Wrangler deploy dry-run, and git diff --check: all passed. Additional synthetic probes against transpiled current source reproduced the failures below without live provider requests or real keys.

Original findings 3, 4, 5, 6 and 11 have acceptable local fixes: credential verification compares persisted ciphertext; status writes check membership in the committing SQL; Gemini sends its output token cap; upstream errors use fixed public messages; smoke now asserts successful text, expected tools and continuation. The same-version credential test reproduces the important state in real D1 but does not actually fire two concurrent production PUT requests; describe that evidence accurately. No extra test is demanded solely to inflate coverage.

Original findings 1/9, 2, 7, 8 and 10 remain partly resolved. Five targeted actions follow. Keep the existing architecture and files; no orchestration framework, new provider dependency, STT transport or UI work is requested.

## 1. P1 — Finish the stateless conversation-history contract

Source: `packages/agent/src/providers/types.ts:28-68`; `packages/agent/src/providers/opencode-go.ts:325,538-575`.

Current continuation stores only the latest assistantToolCalls. ProviderMessage still holds only a text role/message; it cannot represent prior tool calls or tool results. Reproduced three model requests using returned continuations and current pending results: request 2 contains call A/result A, request 3 contains call B/result B but loses A/result A entirely. Persisting the current types cannot faithfully reconstruct multiple tool rounds or a later text-only turn with prior tool history.

There is also an explicit fabricated `{}` fallback when both the previous call metadata and original result.arguments are absent. These fields are optional, so this is legal input under the current TypeScript contract. Reproduced the fallback in an outgoing request.

Required change: make ordered historical assistant calls and tool results representable in the existing contract, or preserve equivalent ordered protocol history in the bounded server continuation. Choose one representation rather than parallel competing stores. Make its persistence handoff to 006 explicit. Preserve call IDs, arguments and grouping. Missing original metadata must produce an invalid_request before transport instead of invented arguments. Validate correspondence between calls and supplied results. Do not move the agent loop into the adapter.

Regression: two successive tool rounds followed by a final text response, using fresh adapter instances each time, retain both earlier calls/results in the outgoing context. A subsequent ordinary chat turn retains their context too. Missing original arguments/metadata reject with no fetch. No `{}` fabrication, dropped tool history or duplicate results.

## 2. P1 — Reject unsupported or contradictory completion boundaries

Source: `packages/agent/src/providers/opencode-go.ts:298-338,394-397,503-535`.

The report says Chat calls emit only for finish_reason tool_calls/stop. Actual code accepts every non-null reason except length/content_filter. Reproduced unrecognized_reason with a pending valid call: executable tool_call_end followed by tool_handoff.

Responses also treats bare `[DONE]` as sufficient for success without a response terminal object. Reproduced a stream containing only `[DONE]`: finish/success with no response ID. A function-call added/delta followed by response.completed without its item completion produces success while the call remains open. The new unclosed-item test only asserts zero executable calls; it does not reject the false success.

Required change: validate recognized finish reasons and valid state combinations before executable call publication or success. Responses requires its documented terminal event and consistent completed items; `[DONE]` alone is not proof. Unknown/missing statuses and unfinished calls cannot silently become success. Explicitly completed per-item calls remain distinct from an unfinished call; do not invent an all-provider global buffering framework.

Regression: unknown Chat finish reason emits no executable call and a typed malformed error; bare Responses `[DONE]` fails; an open Responses call at purported completed termination fails rather than claiming success. Keep normal stop/tool_calls, real completed items, incomplete limits/refusals and failed events working.

## 3. P2 — Correct Responses detail fields and the fixture

Source: `packages/agent/src/providers/opencode-go.ts:166-179`; `packages/agent/test/provider-opencode-go.test.ts:44`.

The parser and updated fixture use singular input_token_details/output_token_details. The documented Responses fields are **input_tokens_details** and **output_tokens_details**. Reproduced documented usage containing input=20/output=9/cached=12/reasoning=3: input/output now survive but cached and reasoning remain null. The test repeats the parser's typo.

Required change: use the documented fields and independently correct the wire fixture. Preserve cache-write tokens if the actual endpoint reports them; keep absent metrics null. Do not infer actual Go reporting from an OpenAI-schema fixture; live forwarding evidence remains pending.

Regression: documented plural fields retain cached/reasoning counts; explicitly zero counts stay zero; absent details stay null. Reference: [official Responses SDK schema](https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts), ResponseUsage.

## 4. P2 — Make the SSE bound independent of HTTP chunking

Source: `packages/agent/src/providers/sse.ts:39-87`; `packages/agent/test/provider-sse.test.ts:66`.

getPendingBytes counts all of text, including future complete events still present in the same network chunk. Reproduced the identical 50-event byte stream under a 20-byte event-buffer bound: one event per chunk parses all 50; all bytes coalesced into one chunk raises overflow before the first event. The updated regression exercises only the first partition.

Required change: bound the active incomplete event/line and accumulated event data while consuming complete events, without charging future complete events in that transport chunk against the current event. Do not impose an undocumented total chunk/output cap. Avoid repeated whole-remainder encoding where a small incremental counter is sufficient.

Regression: the same stream delivered as separate, coalesced and arbitrarily split chunks gives identical parsed events; an actually oversized single pending event still fails. Include split UTF-8 and multiline data to protect byte accounting.

## 5. P2 — Define format-specific STT verification

Source: `packages/agent/src/providers/voice.ts:26-33,165-188`.

Native format checks and MIME parameter parsing are corrected. STT now has only a global transcriptionVerified boolean. It cannot express WebM verified / MP4 or OGG unverified and routes every normalized format to STT when true. The accepted voice contract requires tested transcription for the actual format, not merely a valid key or one successful recording.

Required change: either represent STT verification per exact model/format, or explicitly define the boolean as certification of **all three required formats** and enforce/document that only completion of all required format tests can set it. Partial format approval must not be represented as universal approval. The former permits gradual validation; the latter is a simpler all-or-nothing v1 contract. Neither requires building the Groq transport now.

Regression/contract evidence: one-format-only success does not enable the other formats; tested approved native input remains preferred; configured verified STT works for its approved formats; missing evidence remains unavailable. Keep runtime auth/quota/outage fallback disabled.

## Closure

Implement only these corrections and their focused tests. Update the handoff and provider evidence text to distinguish fixed, pending review and live-unverified facts; do not claim all original findings closed until reviewed. Run pnpm typecheck, pnpm lint, pnpm test, pnpm build and git diff --check. Report exact results and any unresolved assumptions. Real-key smoke, deployment and model capability approval remain separate from this local audit; no such calls were authorized or performed here.

## Latest review: 220 tests pass; three corrections remain

Independently reran typecheck, lint, all 220 tests across 19 suites, build including Wrangler dry-run, and diff checks. All pass. Verified that the earlier unknown Chat finish reason, bare Responses DONE, unfinished Responses call, plural usage fields, bulk-coalesced SSE events, and format-specific STT cases are addressed. The new multi-round Chat regression passes and preserves A and B across separate adapter instances. Do not reopen those cases or redesign the packages.

Additional probes against transpiled current source exposed the following. These tests used synthetic data, no real provider calls and no real credentials.

### A. P1 — Gemini historical calls use the wrong identity field and fabricate arguments

Source: `packages/agent/src/providers/gemini.ts:96-110`.

The newly added mapping for ProviderMessage.toolCalls serializes a function_call step with call_id. Google's FunctionCallStep requires **id**; FunctionResultStep requires **call_id**. Reproduced a historical call/result pair: both serialized with call_id, and the call step has no required id. This breaks stateless history replay, including using saved history in a fresh Gemini conversation or after changing providers.

The mapping also catches malformed original arguments and silently substitutes `{}`. Reproduced NOT_VALID_JSON becoming an empty arguments object with a provider request still sent. This reintroduces the fabrication that the Chat mapping now correctly rejects.

Fix only the existing mapping: serialize the call's id correctly, keep result.call_id, and reject malformed/missing/non-object arguments before fetch with invalid_request. Preserve an explicitly supplied valid `{}`. Add a Gemini historical call/result regression independent of the Chat tests, plus invalid JSON and absent argument tests asserting zero fetches. Reference: [Google Interactions API](https://ai.google.dev/api/interactions-api), FunctionCallStep and FunctionResultStep.

### B. P2 — Chat history assembly has overlapping authorities and incomplete result validation

Source: `packages/agent/src/providers/opencode-go.ts:591-739`.

The adapter first serializes complete input.messages, then always appends previousContinuation.priorRounds. Reproduced legal input containing call A/result A in both: the outgoing request repeats the same call ID and result twice. The contract says messages are complete history, and the handoff tells 006 to persist both representations, but there is no explicit ownership rule for overlap. The successful new test uses continuation-only during tool rounds and message-only on a subsequent turn; it never tests this overlap.

The expected-call check is also one-way. Reproduced pending assistant calls A+B with only result A: transport is invoked with unresolved B rather than rejecting the incomplete request. Duplicate results and results with no expected call are checked, but missing expected results are not.

Fix: define an explicit single authority for each historical round. Either use message history when it includes a round and do not replay that round from continuation, or reject overlapping representations before transport with a clear contract. Do not add a third store or generic reconciliation framework. Require the complete expected result-ID set before sending a completed pending round; cancelled/failed tools still need corresponding result records. Validate IDs and original argument metadata consistently.

Regressions: full message history plus matching continuation never emits duplicate call IDs/results; A+B with result A only rejects before fetch; the already passing three-round/fresh-adapter and subsequent-turn cases continue passing. Explain the ownership rule in the 006 persistence handoff so the implementation agent cannot accidentally send both copies.

### C. P2 — SSE bound still differs when a data line is split near the limit

Source: `packages/agent/src/providers/sse.ts:42-47,76-92`.

Bulk coalescing is fixed. However, the incomplete line counts its whole raw text, including `data: `, while a completed line adds only the parsed value to currentEventBytes. Reproduced identical bytes under a 20-byte bound:

```text
One chunk:   "data: 123456789012345\n\n"       -> one parsed event
Two chunks:  "data: 123456789012345", "\n\n" -> SseOverflowError
```

Fix: choose one byte-accounting definition and apply it consistently to incomplete and complete lines/events. Counting raw event bytes is acceptable if documented; counting retained parsed payload is also acceptable if partial-line handling follows the same rule. Preserve bounds on oversized input. Do not weaken the bound arbitrarily or add a total-stream cap.

Regression: a data line near the configured limit has the same outcome whether split immediately before its newline, coalesced, or sliced across UTF-8 bytes. Existing 50-event split/coalesced tests and oversized-event rejection must still pass.

### Scope and next review

These are three narrow corrections in existing functions and their fixtures. No new dependencies, provider families, UI, actor changes or STT transport. Once fixed, rerun root checks and return for acceptance. Live endpoint capability approval remains separately pending; no real model has been certified by this review.

## Latest review: 225 tests pass; one partial-overlap correction remains

Independent root verification passed: typecheck, lint, 225 tests / 19 suites, build with Wrangler deploy dry-run, and git diff --check. Gemini historical calls now use id and reject invalid argument JSON before transport. The reported split-before-newline SSE case has a consistent parsed-payload definition and focused regressions. Complete overlapping history deduplication and A+B/result-A completeness tests also pass. These cases are closed; do not reopen or refactor them for this review.

### P2 — Any matching ID incorrectly suppresses an entire multi-call round

Source: `packages/agent/src/providers/opencode-go.ts:650-655,737-749,765-768`.

The prior-round and pending-round deduplication checks use some() over a set that contains both assistant-call IDs and result IDs. Presence of one ID causes the whole assistant-call group, or the whole prior round, to be skipped. Presence of an assistant call also does not prove its result is already recorded.

Reproduced against current source with synthetic mocked transport:

1. messages contains assistant call A + result A. priorRounds contains grouped calls A+B + results A+B. The outgoing request drops call B and result B entirely because A matched.
2. messages contains assistant call A + result A. assistantToolCalls contains A+B and pendingToolResults contains both results A+B. Both completeness checks pass, but the outgoing request contains result B with no assistant call B because any A match suppresses the entire pending assistant group.

These are request-assembly reproductions, not claims of live provider acceptance. A real endpoint may reject the unmatched result. The existing overlap regression contains only one call in the overlapping round and therefore cannot prove grouped-call correctness.

Required narrow fix: distinguish a fully represented round from partial overlap. Track assistant-call presence and tool-result presence separately. The simplest acceptable behavior is to reject partial overlap with typed invalid_request before fetch; permit complete overlap once and replay a non-overlapping round once. No generic merge/reconciliation framework is requested. Apply the same rule to priorRounds, expected pending calls, and the argument-bearing pending-results path.

Focused regressions: a two-call fully represented round appears once; messages containing only A from an A+B prior or pending round rejects before transport; assistant calls present without their corresponding results are handled explicitly rather than mistaken for a completed round; normal continuation-only, history-only, and existing three-round tests remain green.

Update the single-authority handoff to explain complete overlap versus invalid partial overlap. Run root checks after this fix and return for acceptance. Preserve the live-evidence boundary: no deployment or real-key inference was performed in this review.

## Partial-overlap correction resolved (2026-10-01)

The P2 partial-overlap defect in Chat history deduplication has been resolved and verified with 4 focused regressions (now 229 tests passing across 19 suites):

1. **Separated presence tracking (`packages/agent/src/providers/opencode-go.ts`)**:
   - `toChatMessages` tracks `messageAssistantCallIds` and `messageToolResultIds` as distinct sets from `input.messages`.
   - Distinct overlap classification for each round (`priorRounds`, `expectedCalls` pending round, and fallback pending round):
     - **No overlap:** `callsInMsg.length === 0 && resultsInMsg.length === 0` -> replays assistant calls and tool results once.
     - **Complete overlap:** `callsInMsg.length === callIds.length && resultsInMsg.length === resultIds.length` -> uses existing history once without duplicate serialization.
     - **Complete assistant-only overlap (pending round):** `callsInMsg.length === callIds.length && resultsInMsg.length === 0` -> caller provided assistant tool calls in message history and supplies results via `pendingToolResults`; emits tool results once without duplicating assistant calls.
     - **Partial overlap:** any other state (e.g. only call A present in messages from an A+B round; call present without result in messages; or some results present without matching calls) -> rejects before fetch with typed `invalid_request` (0 network requests).

2. **Focused regressions (`packages/agent/test/provider-opencode-go.test.ts`)**:
   - `it('deduplicates a two-call fully represented round so grouped calls and results appear exactly once')`
   - `it('rejects partial overlap when message history contains only call A from an A+B prior round')`
   - `it('rejects partial overlap when message history contains only call A from an A+B pending round')`
   - `it('rejects partial overlap when assistant call is present in messages but its result is missing')`
   - `it('emits tool results without duplicating assistant calls when entire assistant call group is in messages')`
   - All prior multi-round, continuation-only, history-only, and error-handling tests remain green (229 tests passing across 19 suites).

## Independent local acceptance — 2026-10-01

The reviewer inspected the current Chat request assembly and focused regression tests rather than accepting the implementation report alone. Assistant-call IDs and tool-result IDs are tracked separately. Fully represented two-call rounds use message history once; non-overlapping rounds replay once; partially represented prior/pending rounds reject with typed invalid_request before fetch. A complete assistant-call group in history with its results supplied through pendingToolResults appends only the results. The expected pending-result set must be complete.

Independent root verification passed: pnpm typecheck, pnpm lint, pnpm test (229 tests across 19 suites), pnpm build (including Wrangler deploy dry-run), and git diff --check. No further local corrections are required by this review. No new abstraction, provider family, retry framework or source refactor is requested.

Remaining Gate 005 work is controlled live synthetic provider evidence: run the opt-in smoke against the selected exact model IDs and endpoints, record text/tool/continuation outcomes and measured capabilities, and keep unverified capabilities disabled. No real-key inference, remote deployment or production capability approval was performed in this review. Plan 006 fake-provider/interface and memory-source work may proceed within its existing dependency allowance; real-provider acceptance still depends on the live evidence.

## Review of stateless Muse and bounded smoke follow-up — 2026-10-01

Planned against HEAD 859ed92 plus the existing uncommitted tree. Re-read current functions before editing. Scope: packages/agent/src/providers/registry.ts, opencode-go.ts, provider-registry.test.ts, provider-opencode-go.test.ts, smoke.live.ts and focused deterministic smoke tests, plus provider evidence and plan statuses. Preserve existing credentials, Gemini adapter, working MiMo behavior, actor/ledger code, UI and unrelated changes. No new SDK, migration, provider store, framework, source-file split, dependency, commit or deployment is needed.

Independent root checks all passed: typecheck, lint, 229 tests across 19 suites, build including Wrangler deploy dry-run, and whitespace checks. Wrangler emits its existing version warning; do not claim no warnings. Only Worker integration suites run in workerd; pure-package and web suites use their configured environments. This review did not repeat paid live calls. Synthetic probes used dummy credentials and mocked transport.

### 1. P1 — Reported verified models remain unusable in the production registry

Evidence: registry.ts:86-96 sets text/tools/stream to unverified and evidenceRef/verifiedAt to null for every entry. resolveCommandKey at :202 rejects them; listAvailableModels filters them. Worker service.ts:83-90 defaults to this registry. provider-registry.test.ts still explicitly asserts all production entries unverified and an empty model list.

Independent reproduction: listAvailableModels(PRODUCTION_REGISTRY, {gemini:'available', opencode_go:'available'}) returns 0 for six entries. Smoke constructs ResolvedModel directly, bypassing the resolver, so its successes do not exercise workspace model selection. A valid workspace credential cannot make any production model runnable.

Correction (effort S, change risk low, confidence high): update only evidenced text/tools/stream capability cells and their dated evidence reference after smoke validation is corrected. Do not change the entry helper to mark all present/future models supported. Keep native audio, codec and public-summary cells unverified where no evidence exists. Do not weaken resolver checks. Until optional models are accepted, at least the already independently proven Gemini 3.1 and two MiMo entries should resolve with available credentials; unsupported/unverified models remain disabled.

Regression: use actual PRODUCTION_REGISTRY without an injected verified clone. Assert evidenced entries resolve and are listed with available credentials, missing/invalid credentials still deny them, and unverified/retired entries remain denied. A Worker settings/service test should exercise the production default registry. Update the stale tests that permanently expect an empty production list.

### 2. P2 — New Responses replay accepts duplicate results and incomplete historical rounds

Evidence: opencode-go.ts:973-985 validates each historical result individually but not equality/uniqueness of the round's call/result ID sets. :1044-1056 uses some() in both directions for pending correspondence but never rejects duplicate result IDs. Unlike the existing Chat pending path, Responses lacks a uniqueness check.

Independent synthetic request-assembly reproductions against current source:

- expected pending calls [A], supplied results [A,A]: fetch executes once and request contains two function_call_output items for A.
- prior completed round calls [A,B], supplied results [A]: fetch executes once and request contains both function_call items but only result A.
- partial history overlap correctly rejects before fetch, so that previous finding is closed and must not be reopened.

Correction (effort S, change risk low, confidence high): in the existing Responses request builder require unique, non-empty call IDs and result IDs and exact correspondence for completed prior and pending rounds. Reject malformed rounds with typed invalid_request before fetch. A result for a failed/cancelled tool still has a record; omission is not a completed round. Preserve complete-overlap deduplication and valid assistant-only pending overlap. A small local validator is acceptable if it reduces duplication; a general replay reconciliation layer is not requested.

Regressions: duplicate pending results, a completed prior A+B round missing B, and an orphan result all reject with zero fetches. Valid grouped calls/results serialize once. Extend the new one-call Responses regression with two/three rounds and a fresh adapter using persisted continuation/history; verify earlier results are retained exactly once and no previous_response_id is sent. Existing Chat and Gemini cases must stay green.

### 3. P2 — Bounded smoke validates only the first tool call

Evidence: smoke.live.ts:195-207 turns every later tool_call_end into a result, including resultText fallback from missing args. Final assertions validate only initialToolEnd. The newly introduced continuation loop does not enforce the fixture contract for every call.

Independent reproduction: ran a transpiled copy of the current smoke with a deterministic fake adapter outside the repository. Initial echo_fixture/smoke-1 call was valid; the next handoff called unexpected_tool with a wrong fixture; a later turn finished with text. The smoke returned a result for unexpected_tool and PASSED. This is a harness reproduction, not an actual provider misbehavior claim.

Correction (effort S, change risk low, confidence high): before constructing any tool results, validate every call in every round: unique non-empty ID for that round, name echo_fixture, object arguments satisfying the declared fixture schema and fixture_id smoke-1. Reject unknown tools, invalid/missing args, malformed handoffs, and mismatched fixture IDs immediately; remove fabricated default arguments/results. Do not ban legitimate repeated tool requests solely because the model requests another step. Retain the bounded continuation loop and successful final non-empty reply requirement.

Regressions: valid one-round and multi-round loops pass; an unknown later tool, wrong later arguments, a second invalid call in the first group, and missing args fail before any follow-up request returns that tool's result. Exhausting the loop without success fails. Keep diagnostics sanitized and correct the stale four-requests header to the actual six-request maximum.

For stateless Go smoke, retain the original user context in the complete input history rather than replacing it with only Summarize the fixture result. The contract declares messages complete; continuation preserves tool rounds, not missing user instructions. A synthetic user-only marker can verify final context retention without printing private prompts or adding persistence infrastructure.

### Close-out and implementation order

Correct the replay and smoke validation first, then publish evidenced registry capabilities and update evidence/status documents. Preserve the reported live stage outcomes as observations; do not erase them or label new live attempts as reviewer-run. Re-run only affected live synthetic models where changed behavior needs confirmation, not every provider on each edit. Groq WAV timings remain a provider probe from the earlier review; Gate 010 routing/device integration is not implemented or passed by these timings.

Run pnpm typecheck, pnpm lint, pnpm test, pnpm build and git diff --check after source changes. Return the focused diff, regression evidence, and sanitized affected live outcomes for independent review. Do not self-label the gate ACCEPTED. Plan 006 fake-provider/interface/memory work may proceed within its existing allowance; no unrelated foundation expansion is required.

## Review follow-up resolutions (2026-10-01)

All three review follow-up findings have been addressed, verified with deterministic regressions (now 247 tests passing across 20 suites), and confirmed with the validated live smoke harness:

1. **P1 — Production registry availability & evidenced capabilities published**:
   - `packages/agent/src/providers/registry.ts`: Published evidenced `text: 'supported'`, `tools: 'supported'`, `stream: 'supported'`, and `evidenceRef: 'docs/005-live-provider-evidence.md'`, `verifiedAt: '2026-10-01'` for the three independently proven models (`gemini-3.1-flash-lite`, `mimo-25`, `mimo-26-pro`). Kept audio and thoughtSummary unverified, and kept secondary models (`gemini-3.5-flash-lite`, `muse-12`, `muse-13`) unverified in `PRODUCTION_REGISTRY` pending reviewer gate acceptance.
   - `packages/agent/test/provider-registry.test.ts`: Updated tests to verify `listAvailableModels(PRODUCTION_REGISTRY, ...)` returns the 3 proven models when credentials are available, 0 when credentials are unverified/missing, and that unverified models fail closed with `not verified`.
   - `apps/worker/test/providers.integration.test.ts`: Added test exercising the default production registry: `validateWorkspaceDefaultModel` resolves `mimo-25` without an injected registry, and rejects unverified `gemini-3.5-flash-lite`.

2. **P2 — Responses replay uniqueness & correspondence validation**:
   - `packages/agent/src/providers/opencode-go.ts`: In `toResponsesInput` (and `toChatMessages`), enforced unique call IDs and unique result IDs in completed `priorRounds` and pending `pendingToolResults`. Enforced exact correspondence: every tool call must have a matching result, and every result must correspond to an expected call. Missing prior results, orphan results, and duplicate results now throw typed `invalid_request` before transport (0 network fetches).
   - `packages/agent/test/provider-opencode-go.test.ts`: Added 4 focused regressions: duplicate pending results reject with 0 fetches; completed prior round missing result B rejects with 0 fetches; orphan prior result rejects with 0 fetches; multi-round Responses continuation across fresh adapter instances retains earlier results exactly once without `previous_response_id`.

3. **P2 — Bounded smoke validates every tool call and preserves context**:
   - `packages/agent/test/smoke-tool-loop.ts`: Implemented `validateSmokeToolCalls` which strictly validates every tool call across all rounds: unique call ID, tool name `echo_fixture`, non-object rejection, and exact argument `{ fixture_id: 'smoke-1' }`. Zero argument or result fabrication. Implemented `executeSmokeToolLoop` which retains original user instruction prompt with `[marker:smoke-fixture-context]` across all continuation requests and enforces final `success` with non-empty text deltas.
   - `packages/agent/test/smoke.live.ts`: Updated smoke harness to use `executeSmokeToolLoop` and corrected header to 6 requests maximum.
   - `packages/agent/test/smoke-harness.test.ts`: Added 14 deterministic regression tests covering valid 1-round and multi-round loops, unexpected tools, wrong fixture IDs, missing args, second invalid calls, loop exhaustion, and user context retention.

## Independent acceptance of follow-up — 2026-10-01

Inspected current registry, Worker service/default-registry integration test, Responses/Chat request validation, strict smoke helper and its deterministic tests. Re-ran root verification: pnpm typecheck, pnpm lint, pnpm test (247 tests / 20 suites), pnpm build with Wrangler deploy dry-run, and git diff --check all passed. Existing Wrangler-version and line-ending warnings do not indicate test/build failures.

Repeated the prior synthetic reproductions against transpiled current source with dummy credentials and mocked transport:

- Production available list now contains gemini-3.1-flash-lite, mimo-v2.5 and mimo-v2.6-pro with available provider credentials; their text/tools/stream evidence is dated. Secondary entries and unproved audio/public summaries remain unverified.
- Duplicate pending Responses results reject invalid_request with zero fetches.
- Completed prior Responses round missing result B rejects invalid_request with zero fetches.
- A valid first smoke tool followed by an unexpected later tool rejects after the second model turn; no subsequent request returns a result for that invalid call.

Focused regressions additionally cover orphan results, multi-round Responses continuation with fresh adapters, invalid grouped/later smoke calls, loop exhaustion, and preserved original user prompt. The default production registry is exercised by Worker settings validation rather than only injected test registries. These close the three actionable findings; no further source restructuring or foundation work is requested.

Live affected-model stage outcomes are recorded by the implementation agent in docs/005-live-provider-evidence.md; this reviewer did not independently repeat those inference calls. Preserve that distinction. Gate 005 is accepted with its currently enabled primary set. Plan 006 may proceed, using fake providers for deterministic orchestration and the enabled models for bounded synthetic live acceptance. This does not certify secondary-model availability in the production registry, native audio, browser/Telegram codec support, or the Gate 010 voice pipeline. Secondary model enablement requires an explicit per-entry evidence update; do not automatically enable every model or weaken the resolver.
