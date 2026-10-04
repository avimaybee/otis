# Plan 008: Enforce the approved Otis interface and conversation behavior

Revised 2026-10-03. **IMPLEMENTED IN PART; new visual/behavior baseline NOT ACCEPTED.** Existing web UI and prior passing tests do not close this gate.

Read [the detailed implementation handoff](008-ui-implementation-handoff.md) in full. It replaces this plan's scaffold-era implementation instructions. Work remains inside gate 008; there is no new application rewrite or new gate sequence.

## Required reading

1. [AGENTS.md](../AGENTS.md), current Git status/history and live code.
2. [design-tokens.md](../design-tokens.md), verbatim approved visual baseline.
3. [design.md](../design.md), interaction contract, active-run follow-up clarification and Storybook fixture inventory.
4. [architecture.md](../architecture.md), especially sections 6–7, 12 and 17; [contracts](../docs/contracts.md).
5. [008 handoff](008-ui-implementation-handoff.md), [verification](../docs/verification.md), [browser record](../docs/browser-review.md).

## Outcome

A precise mobile-first conversation using the approved reference, immediate local feedback, optimistic messages with safe retry, live stable streaming, reliable reading position/keyboard behavior, scoped offline recovery, accessible completed-message announcements, and functional optional commands. One implementation per message/composer; no design improvisation.

## Dependencies and boundaries

Reuse gate 007 acceptance/command/stream APIs, gate 004B execution and gate 002 receipts. The [conversation repair](007-conversation-repair.md) still owns real immediate dispatch and provider delivery. UI labels cannot hide an unproved runtime failure. Gate 010 owns microphone capture, STT, retained audio and device evidence. Gate 008 provides the shared local-storage/review integration without shipping dead voice controls. Complete web text work need not wait for the Telegram bot or future voice release.

## Execution checkpoints

| Checkpoint | Scope | Evidence |
|---|---|---|
| 008A | Token authority, enforcement, Inter, shared recipes, Storybook, reference composition | Checker rejects deliberate drift; representative production stories at five widths |
| 008B | Optimistic send, query ownership, reconciliation, silent commands, active-run follow-ups, stable streaming | Lost-ack/replay/failure/race tests and actual send-to-reply browser journey |
| 008C | Scroll, older pages, keyboard/viewport, locale/a11y, typed routes | Browser reading-position tests, screen-reader review, Android/iPhone keyboard evidence |
| 008D | IndexedDB drafts/outbox, offline static PWA shell, integration/release evidence | Offline reload/reconnect/auth-revocation tests and complete owned fixture matrix |

Do one checkpoint at a time, with a reviewable report. These are checkpoints inside 008, not independent frameworks or permission to install every dependency at once. Voice stories can remain explicitly contract-only until 010; brief/export stories until their owning gates. Unimplemented feature fixtures never count as completed integrated journeys.

## Completion

Run root implementation checks plus the implemented design checker, Storybook build and targeted a11y/behavior checks. Record real screenshots and interactions at the required widths, with commit and scenario. Unperformed device, provider, deployed or feature checks stay unverified. Preserve unrelated source and historical review evidence. No commit, push, deploy, real lead messaging or task delegation is authorized by this plan alone.
