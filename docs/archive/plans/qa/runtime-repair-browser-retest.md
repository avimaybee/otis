> Historical record, archived 2026-10-07 from `plans/qa/runtime-repair-browser-retest.md`. Its claims apply to the original baseline. Use [current implementation status](../../../status.md) for active work; old proposals and DONE labels are not current authority.

# Browser retest: conversation runtime repairs

Reviewer-owned instructions for Antigravity, written2026-10-04 against HEAD663f0b3 plus the dirty working tree. These instructions do not authorize release, production schema changes, credential edits, Telegram sends, deletion of existing data or changes to shared members/settings. The user chose Antigravity for browser QA. Use native browser interaction; no Playwright. Source/test success is not browser acceptance.

## Establish what is being tested

Record URL, date, browser, viewport and available build/deployment identifier. State explicitly whether the browser uses the unpublished local build or a deployed build containing the reviewed repairs. If the deployed build does not contain the repair, record a version mismatch; do not repeatedly test the old defect and infer the new patch failed. Sign in normally; do not export cookies or tokens. If human authentication is required, report it without bypassing it.

Create one clearly titled synthetic QA chat if creation is available. Use a unique suffix in facts so no real business memory is accidentally changed. Record operation/run identifiers only where safely available; omit provider interaction IDs, keys, cookies and private protocol bodies.

## Decisive scenarios

1. **Fresh chat readiness.** Click New chat. Before sending anything, observe the approved empty state and usable composer. An indefinite Opening conversation indicator fails. Type, edit and submit a greeting. Distinguish immediate local echo, durable acceptance, first visible response and completed answer; measure observed times rather than claiming a fixed provider SLA.
2. **Save and finish.** With Gemini3.1Flash-Lite selected, ask to remember a synthetic supplier/account/contact fact. Expect a real tool effect and a natural completed confirmation. A saved tool step followed by partial failure is FAILED overall, even if storage succeeded. Inspect the change without executing Undo during this scenario.
3. **Retrieve and answer.** Ask for all three saved fields. Require a completed answer containing the correct supplier, account and contact. A retrieval tool merely running is insufficient. Record the actual answer. Reload and repeat retrieval; check no duplicate chat bubbles or duplicate memory writes. If cross-chat memory is tested, create a separate own QA chat and record its distinct scope.
4. **Successive clarifications.** Give a task instruction with a missing date, answer the first question explicitly, and then exercise a second distinct missing detail if the conversation naturally asks it. Verify the second answer affects the completed result. Do not force invented tool behavior, change the prompt to hide a failure, or mark not-exercised branches PASS. Deterministic two-question orchestration remains separately covered by integration tests.
5. **Follow-up and Stop.** Start a sufficiently long response, send a relevant correction while it works, and verify it stays attached to the intended run/conversation. In a separate turn click Stop after visible text appears. Expect the stopped state and retained text labeled Partial response — stopped. It must not look like a newly completed response after the stop notice. Reload to verify that labeling. Capture timing and attribution before claiming backend work continued; retained pre-Stop text alone is not evidence of later execution.
6. **Final-answer replacement.** Let a streamed response finish. Require exactly one final answer, with no duplicated preview or lingering partial label. Review a previous failed/partial response: any retained preview is clearly identified as partial, while committed actions remain inspectable.
7. **Control state.** Change model/effort through the actual controls and verify visible state, reload persistence and the next run's effective configuration where observable. Restore reversible own-chat overrides. Execute `/today`; require its actual result, not merely a picker entry. Settings inspection is distinct from saving settings.

## Practical interaction checks

At360 and390 CSS pixels check composer visibility, drawer, long content and horizontal overflow. At900/1280/1440 inspect the same production composition. Use a real device for keyboard/microphone claims; viewport emulation alone is insufficient. Scroll away while text streams, then return using Jump to latest; verify reading position is not pulled down. Do not alter the user's active browser network state to test offline behavior.

## Evidence and verdict

Keep screenshots and a concise result table under plans/qa with tested URL/build/date. Each row must be PASS, FAIL, BLOCKED or NOT TESTED, with an observed outcome. If a journey fails midway, later parts are untested rather than assumed to work. Include pending or failed messages in screenshots instead of cropping them away. Never write comprehensive/all-working solely from these bounded checks.

Any reproduced failure goes to the reviewer with steps, expected/actual behavior and evidence. The reviewer writes the next bounded OpenCode assignment. No deployment or external messaging is implied by completing this checklist.
