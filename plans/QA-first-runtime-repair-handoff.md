# Assigned repair: deployed QA loading and Gemini tool continuation

Reviewer: Codex, 2026-10-04. Baseline HEAD `663f0b3` plus the current dirty tree. Execute only this repair in the existing OpenCode session. Preserve all 008/009A/015/user changes. No commit, push, deployment, remote migration, live Kerning mutation, Telegram message, browser-process kill or disk cleanup.

## Problem and required outcome

Production can answer a greeting, but after `remember_context` commits one synthetic fact, the next Gemini request returns HTTP400 and the run becomes partial with no normal confirmation. A fresh unsaved chat also displays 'Opening conversation…' indefinitely. Fix the actual paths, not their status wording.

The reviewer read the browser reports and confirmed the production run with read-only D1 inspection:

- workspace `kerning`, chat `new-b6ed665d-2121-490c-962c-710f03ccc7cf`;
- run `run_a90d1968-168a-4506-99b0-7f2ddf0b132f`, Gemini3.1Flash-Lite, partial/provider_stream_error, round1/provider_pending;
- diagnostic: one action committed before Gemini request failed400.

Specific provider rejection reason is not yet known. Do not assert a cause merely from the HTTP status. The real symptom is P1: common save/query/tool turns cannot reliably finish. The empty-state defect is P2.

## Read current ownership

- `apps/web/src/ConversationScreen.tsx`, `api/snapshot.ts`, `components/Transcript.tsx`, existing `apps/web/test/full-e2e-flows.test.tsx`.
- `packages/agent/src/providers/gemini.ts`, `types.ts`, provider-gemini tests.
- `apps/worker/src/agent/handler.ts` provider_pending input construction and completed tool rounds.
- `packages/agent/test/smoke.live.ts` and `smoke-tool-loop.ts`.
- `apps/worker/test/agent.integration.test.ts`, action receipts and existing dispatch partial classification.

Use the Gemini skills and check official current function-calling docs: https://ai.google.dev/gemini-api/docs/function-calling and https://ai.google.dev/gemini-api/docs/interactions-overview. Preserve the pinned endpoint/API revision unless actual evidence requires a correction. Do not silently upgrade models from documentation examples.

## A. Fresh-chat loading

Current `const loading = snapshotQuery.isPending && !snapshot` treats a disabled query as loading. Derive loading from an actual enabled persisted-chat fetch rather than pending status alone. Fresh no-ID chat must immediately show the approved empty composition and allow typing. Existing persisted chat genuinely loading must keep its opening feedback and protect unavailable snapshot-dependent actions. Access-loss/error must not become an endless spinner.

Add one meaningful production-component test for fresh chat with disabled snapshot query: approved empty state present, no Opening conversation status, no snapshot request, composer usable. Cover held persisted-chat snapshot: loading remains until the real result arrives. Do not change tokens/layout or replace TanStack Query. No new library.

## B. Reproduce the exact Gemini continuation boundary

1. Trace actual handler-built `TurnInput`, not only the generic smoke harness. Handler currently supplies complete conversation history, the latest assistant tool calls, latest pendingToolResults and `previousContinuation.interactionId`. Adapter currently serializes all history and calls together with results while also setting `previous_interaction_id`.
2. Official stateful examples link the prior interaction and submit the new function results, while re-specifying interaction-scoped configuration. Inspect call IDs, current pending-call grouping, prior interaction identity, duplicate model calls/results and preserved signatures/revision semantics. Current provider test 'continues tool results with previous interaction id' expects old user input plus results; another historical-call test can encode an invalid replay assumption. Tests must validate the documented wire protocol, not just existing implementation.
3. Generic smoke currently adds a new user instruction alongside tool results but does not reproduce the handler's replayed assistant function_call. Passing that probe is insufficient. Add a controlled transport regression driven by the actual handler or its exact production-shaped input, with a strict fake endpoint rejecting invalid continuation shape. Distinguish initial/stateless requests from stateful continuation; avoid simplistic string matching against only one happy-path fixture.
4. Obtain a bounded synthetic live echo-tool round trip with the exact configured Gemini3.1Flash-Lite endpoint if a designated local key is already available under existing smoke authorization. Use existing smoke secret sources only; never print keys, request bodies, prompts, raw provider reasoning or continuation IDs. Maximum six requests total for this investigation; no indefinite retries, production memory writes or paid fallback. If no key is available, complete the deterministic repair and explicitly leave live evidence missing.
5. For the HTTP400 investigation, use a bounded provider error-body read only for diagnostic validation with explicit allowlisted/redacted status/code/category. Do not dump raw error body to logs/chat/receipt. Provider diagnostics may echo submitted content or credentials. Prefer a concrete structural classification and sanitized fixture; do not add a general telemetry framework.

Do not guess whether the status was due to replay, IDs or another field. Record the actual reproduction/corrected request shape or mark the remaining uncertainty.

## C. Correct the existing boundary without losing user context

Keep one Gemini adapter and one agent loop. Statefully continue with the appropriate newly pending tool results, correct call IDs and same model/configuration. Preserve initial/stateless complete-context serialization where needed. Do not repeatedly send stored assistant calls as newly generated calls on a linked continuation.

Do not blindly discard all user messages: a real follow-up/correction or clarification must still affect the next interpretation. Trace `consumeSteering` and completedRounds handling. If a small explicit distinction for genuinely new continuation input is needed, make it in the existing TurnInput/handler boundary, update callers/tests and document it; no generic session manager. Preserve user intent without inferring 'new' from text equality or losing tool results.

The pending results are outcomes of already committed actions. Do not rerun the memory write to obtain another reply. Retain action IDs, receipts, source attribution, fences and existing partial classification. A failed post-tool provider call must remain honestly partial. Fixing the normal completion does not authorize automatically reopening the historical failed production run.

## Required evidence

- Initial no-tool Gemini turn unchanged.
- One tool call → committed synthetic effect → valid second provider request → normal final answer; exactly one receipt/effect.
- Production-shaped one-tool and multi-round histories do not replay completed calls/results into stateful continuation.
- Multiple parallel pending calls each matched exactly once; missing/mismatched IDs fail clearly rather than fabricating results.
- User steering/clarification survives while previously committed tools are not repeated.
- A real provider400 after committed effect remains partial; no false succeeded classification or invented confirmation.
- Restart/checkpoint replay still does not duplicate effects. Add focused cases in existing suites rather than constructing another harness/framework.
- Fresh-chat and persisted-chat loading cases from A.

Run targeted tests first; then one stable root `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `git diff --check`. Set TEMP/TMP `D:\wtmp`; C: is full. Build is dry-run only. Preserve unrelated findings; don't update dependencies or clean browser profiles.

Report exact cause, files changed, real versus fake evidence, checks/counts, any missing live verification and required Antigravity retest. The reviewer owns acceptance and documentation status. Stop afterwards; no next feature. Production acceptance still requires an authorized release followed by actual-browser save → confirmation → later retrieval → reload testing. The report's Stop/model/command claims are not full acceptance of those interactions.
