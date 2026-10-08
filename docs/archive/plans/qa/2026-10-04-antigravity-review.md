> Historical record, archived 2026-10-07 from `plans/qa/2026-10-04-antigravity-review.md`. Its claims apply to the original baseline. Use [current implementation status](../../../status.md) for active work; old proposals and DONE labels are not current authority.

# Antigravity deployed QA — reviewer adjudication

Reviewed 2026-10-04. Inputs: two user-supplied Antigravity transcripts and `qa_screenshots/01_initial_state.png`, `02_message_and_reply.png`, `03_saved_fact_and_inspect_pane.png`. The user's attached screenshot independently shows the partial outcome. Browser interactions were performed by Antigravity, not this reviewer.

## Supported findings

- Deployed sign-in/session exchange succeeded according to the browser transcript.
- A real Gemini 3.1 Flash-Lite greeting completed. Reviewer read-only D1 inspection confirms run `run_5083dd28-53fb-446b-b8ae-bf75332c491a` succeeded, accepted10:22:15Z and updated10:22:29Z. This is one successful turn, not general reliability or a precise first-token latency measurement.
- **P1: tool-following completion failed.** Synthetic memory run `run_a90d1968-168a-4506-99b0-7f2ddf0b132f` is `partial`, `error_code=provider_stream_error`; persisted diagnostic says one action committed before Gemini HTTP400. Progress is `provider_pending`, round1. The store-to-conversational-confirmation journey is broken. Downgrade neither to cosmetic nor to PASS. Preserve the committed effect; do not relabel partial as succeeded.
- **P2: fresh chat looks stuck opening.** Current local ConversationScreen computes `snapshotQuery.isPending && !snapshot` without requiring a persisted chat. The disabled snapshot query for a fresh chat can therefore display a loading state. Source and reported browser behavior agree; a narrow fix is assigned in `../QA-first-runtime-repair-handoff.md`.

## Claims not established by this report

- Seeing a Stop button does not prove cancellation, stopping later writes or follow-up responsiveness.
- Model/thinking API entries do not prove selection persists, changes the next run or updates UI correctly.
- Command enumeration/picker navigation does not prove command execution and transcript behavior.
- Clicking Inspect proves the drawer opens; it does not prove Undo commits the intended scope or preserves unrelated work.
- Memory tool execution does not prove later retrieval, reload persistence or cross-chat knowledge. Retrieval was not completed before browser connection loss.
- All mobile viewports, offline recovery, retry, accessibility, scroll retention, quota safety and deployment version remain unverified.

The browser MCP disconnected. Reviewer independently observed C: free space0, but that does not prove disk exhaustion caused the MCP failure. Do not kill browser processes, delete user profiles or undertake disk cleanup based only on the pasted troubleshooting suggestions.

## Next action

## Continued browser QA adjudication

The two later user-supplied reports add 17 screenshots under `qa_screenshots/` and actual model/effort changes, a `/today` result, reload, search and viewport checks. These replace the earlier statement that retrieval was not attempted: retrieval was attempted and failed to produce an answer. Reviewer personally inspected `04_retrieval_tool_attempt.png` and `08_stopped_execution_and_followup.png`.

- **Retrieval is FAILED, not PASS.** Screenshot04 shows the question followed by a partial-failure notice, with no supplier/account/manager answer. A tool executing is insufficient end-user acceptance.
- Save remains an applied effect followed by failed completion. The P1 priority is unchanged.
- Reload evidence supports preservation of the captured history, not general offline or duplicate-effect guarantees.
- Model and thinking API overrides were observed; successful use on a completed next response remains unproven.
- Stop screenshot08 contains assistant text beneath the stopped notice that does not fit the immediately preceding playbook request. Verify run attribution and timing before claiming cancellation or a regression; the screenshot alone does not establish which run produced it.
- Settings were inspected, not proven saved. Five viewport captures do not prove mobile keyboard, recording, offline or scroll behavior.

Local repair review found a new concrete issue: `DurableAgentProgress.answerSent` is a run-global boolean. After a first answer is sent, a second distinct clarification answer can be omitted from stateful `continuationInput`. Existing OpenCode session received a bounded correction on2026-10-04: track the trusted answer message identity and regress two successive clarifications across restart, preserving exactly-once effects.

The synthetic live echo-tool continuation passed according to the implementation report. This is not deployed save/recall acceptance. `D:/wtmp/qa-root-test.log` contains cross-Durable-Object I/O and environment teardown errors without a reviewed successful final summary. Root verification is not accepted; OpenCode must inspect its authoritative process/tool result before retrying or making a green claim. No commit, push or deploy performed.

## Stop attribution resolved with read-only production evidence

Scoped SELECTs on the synthetic QA chat confirmed retrieval run `run_f1db6844-b9ed-420a-bb4f-dad95cbacb7a` is partial/provider_stream_error after Gemini400. They also confirmed playbook and compensation follow-up are both member messages on run `run_3b976bee-e19f-464b-bdec-3cebfaa2960d`. That run is cancelled/stopped at10:49:35.306Z. Its only inspected text chunk was recorded at10:49:20.907Z, before cancellation; no saved system answer or later text chunk appears. All three diagnostic SELECT result metadata show rows_written0.

The visible sentence beneath the stopped notice is retained preview text, not proof of a post-Stop backend reply. Current `Transcript.tsx` renders historical text chunks under `noAnswerYet` regardless of terminal status, without identifying the text as unfinished. Existing implementation session received the narrow UX correction: preserve useful partial text with explicit unfinished/stopped labeling and coherent terminal ordering; test transition, reload and succeeded-answer replacement. No backend cancellation redesign justified by this evidence. Full no-later-business-effect verification is not claimed from these text/run SELECTs.

## Answer identity repair verification

Current source replaces the run-global boolean with `sentAnswerMessageId`, comparing the trusted `TurnContext.answerMessageId`. The added handler regression parks Q1, resumes persisted answer A, commits an intermediate effect and parks Q2, then resumes distinct answer B through a fresh handler. Its strict transport requires the correct continuation/call-result group and B as new user input, without resending A as new input. Assertions verify task dates, exactly one intermediate entity and no duplicated action receipt IDs. Implementation log `D:/wtmp/qa-answer3.log` records27/27 agent integration tests passing after correcting overly narrow fake-endpoint assertions.

Reviewer independently ran `pnpm exec vitest run packages/agent/test/provider-gemini.test.ts` with TEMP/TMP onD: at16:38 local:24/24 passed, exit0. This closes the observed answer-identity bug at source/targeted-test scope; the unfinished-preview follow-up, stable full-suite verification and deployed browser acceptance remain pending. No broader gate acceptance inferred.

## Subsequent verification and preview review

`qa-root-test2.log` contains a terminal45-files/641-tests-passed summary. After the three preview regressions were added, `qa-root-test3.log` contains44 files passed/1 failed and643 tests passed/1 failed: the chat API Undo replay test received undefined `status` instead of `already_applied`. The subsequent isolated chat API suite records52/52 passed. Neither the previous green root run nor isolation explains the root-only failure; do not erase it from the report. Reviewer inspected `callJson`: it throws only for HTTP500+, so a4xx error body could account for the missing status. Implementation session was told to obtain a bounded status/error-code diagnostic if recurring, without weakening assertions or speculative production changes.

Preview source now labels retained terminal-run text as unfinished; tests cover running→cancelled, historical reload and persisted final-answer replacement. Targeted implementation report42/42 passed. Reviewer requested short user copy (`Partial response — stopped.` / `Partial response — Otis could not finish.`) instead of storage jargon about not being sent as a saved reply. Copy completion and final source-state checks remain pending. Production acceptance remains unavailable until an authorized release and real-browser retest.

## Current preview and Undo follow-up

Final copy is present in source. Reviewer independently ran `pnpm exec vitest run apps/web/test/conversation.test.tsx` at16:45 local:24/24 passed, exit0. Stop presentation correction is accepted at source/targeted behavior scope, with real-browser layout/retest still required.

Reviewer found a concrete Undo retry routing hazard in `apps/worker/src/routes/actions.ts`: omitted `chat_id` selects the member's most recent conversation before checking the recorded operation. `ensureCommandSourceMessage` in `chat/commandTurn.ts` requires that conversation to equal the original source chat. A different chat becoming more recent can therefore reject an otherwise identical retry before receipt replay. Root3 logs show background dispatch while the failing retry test runs; this is a lead, not proof of the original HTTP error. Existing session assigned a deterministic reproduction (first implicit undo, make another own chat strictly newer, retry same operation) and narrow correction if reproduced. Preserve explicit-chat mismatch and actor/workspace/action/mode/payload guards. No broad infrastructure work or weakened test assertions.

## Final bounded local verdict

**Source and targeted behavior accepted locally; deployed acceptance pending.** Deterministic pre-fix regression `qa-repro1.log` proves identical implicit-chat Undo retry returns HTTP409/operation_conflict after another own chat becomes more recent. Current route derives the command run identity first, reuses its recorded chat when `chat_id` is omitted and rechecks current ownership. Fresh operations retain the existing recent-chat default. Existing source-fingerprint/action/mode checks remain in place; no schema/framework added. `qa-repro2.log` records53/53 passing after this correction. The reproduction explains the same failure mechanism; the original root3 HTTP body was not captured, so exact attribution of that particular event remains inferred.

Final `qa-root-test5.log`, at16:49 local on the complete repair tree, contains45 files/645 tests passed,55.87s. Implementation reports exit0 plus clean typecheck/lint/build dry-run. Reviewer personally inspected that terminal summary, reviewed the affected source and regressions, independently reran Gemini adapter24/24, transcript24/24 and chat API53/53 (16:51 local, exit0). Whole-tree diff check passes apart from line-ending notices. No full-goal or whole-product acceptance follows from these bounded results.

Existing implementation session is idle after its final report. Local repairs: fresh-chat loading; Gemini stateful continuation shape; distinct clarification answer identity; terminal preview labeling; stable implicit-chat Undo retry attribution. Exact original Gemini400 body remains unknown; deterministic boundary reproduction and bounded live synthetic continuation support the fix, but actual deployed save→confirmation→retrieval→reload must still pass. Use `runtime-repair-browser-retest.md` for Antigravity after an authorized release or on an identified local preview. No commit/push/deploy/migration/Telegram send performed.

Existing OpenCode session receives one bounded repair: correct fresh-chat loading and investigate/fix the Gemini tool-continuation HTTP400 with production-shaped request evidence. Local root633 checks predate this repair. Antigravity must subsequently re-run save → confirmation → retrieval → reload in the actual deployed fixed build. No deployment, synthetic effect reversal or external send is authorized by this review.
