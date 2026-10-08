# Decisions

Latest explicit user instructions resolve older conflicts. This register records choices, not implementation proof; [status](status.md) owns evidence and [product](../product.md) owns behavior. Historical context is preserved in the [baseline register](archive/baseline-2026-10-07/docs/decisions.md).

## Settled choices

| ID | Current choice |
|---|---|
| D01 | Conversational business memory first; no general research/browser agent in v1 |
| D02 | Web and Telegram share complete conversation/business ownership |
| D03 | Mobile chat composition and Codex-style desktop sidebar/chat/detail; no dashboard |
| D04 | Current approved charcoal/Highlighter tokens supersede earlier visuals |
| D05 | One identity, shared memberships and protected workspace owner transfer |
| D06 | Members see workspace history, including pre-join retained chat/audio with disclosure |
| D07 | Platform runtime provider keys; encrypted workspace BYOK takes priority; chat override stays personal to that chat |
| D08 | Gemini/OpenCode Go dogfood integration is approved; commercial reliance is separate |
| D09 | Voice notes, text replies by default; real Android/iPhone evidence required |
| D10 | Durable scoped D1 memory; no canonical mutable memory.md |
| D11 | Clear complete instructions save; uncertain details ask narrowly |
| D12 | Missing deadline asks; never invent today |
| D13 | Inferred existing lead status asks before mutation |
| D14 | Default suffix Undo from here; single-action secondary, unrelated work preserved |
| D15 | Member chooses brief time |
| D16 | Brief disabled initially; chosen days/timezone/channel, at most one scheduled daily brief |
| D18 | Outward draft-only; sent requires explicit completed-send confirmation |
| D19 | Native browser review, no Playwright |
| D20 | Direct TypeScript/prepared SQL; no speculative ORM/vector service |
| D21 | Private downloads use live Worker membership checks |
| D22 | Identity/conversation-source dependencies precede ledger references; one migration sequence |
| D23 | Verified selected-model native transcription for actual format; otherwise configured verified Groq |
| D24 | No automatic extra paid inference/fallback or quota evasion for dogfood |
| D25 | Approved token recipes/reference are visual authority; never edit tokens to excuse styling drift |
| D26 | Quiet real commands/settings; no composer toolbar/configuration chat bubbles |
| D27 | Active empty input shows Stop; valid follow-up shows Send, Stop remains in overflow |
| D28 | Feedback within 100 ms, in-control pending after 300 ms, stable retry UUID |
| D29 | Scoped IndexedDB drafts/outbox and static PWA shell; no private service-worker caches |
| D30 | Production component per fixture, Storybook coverage and five-width native review |
| D31 | Reuse installed frontend owners and shadcn primitives; don't install a proposed library stack |
| D32 | Detected voice format, ordered chunks, actual meter and explicit interruption |
| D33 | Capture → memory → useful resurfacing → action is the quality loop |
| D34 | Sourced confirmed corrections/aliases improve recall; no training service or absolute never-ask-again promise |
| D35 | Bounded entity timeline may use existing inspection. The previous exclusion of direct editing is superseded by D47; no dashboard is selected. |
| D36 | Actual provider-exposed displayable reasoning in one nested Thinking disclosure; no invented traces |
| D37 | Supplemental references establish composition; current approved tokens own visual values |
| D38 | Approved entry/dialog sizing is owned by tokens/design, not repeated constants here |
| D39 | Slash picker supports full names, anchoring and bounded internal scroll |
| D40 | Token scrim, no blur or stacked darker nested scrims |
| D41 | Neutral control recipes; internal inspection acts as a button, links navigate |

## User corrections incorporated 2026-10-07

| ID | Choice and implication |
|---|---|
| D42 | Questions follow the supplied Codex interface: separate options/free-text input, Skip and Send; main composer stays ordinary conversation. No implicit latest-question reply. |
| D43 | Current compact tokens and approved fonts govern. Old Inter and expanded composer/sidebar instructions are superseded. |
| D44 | Comprehensive tables are a general response ability. Leads were an example; a lead-specific read helper cannot stand in for flexible useful tables across topics. |
| D45 | Improve response quality and native-like latency practically. Avoiding overengineering does not mean reducing answer usefulness, context or recovery. |
| D46 | Consolidate docs; maintain one implementation status and one backlog. Archive historical evidence rather than keep competing current handoffs/audits. |
| D47 | User selected direct editing of Otis's authoritative information: desktop spreadsheet, convenient mobile forms, flexible sparse columns and simple lists for nontechnical users. [R16 plan](../plans/editable-records.md); implementation remains open. |
| D48 | Manual cell/row/column edits collect in a recoverable draft until explicit Save. Local Undo differs from saved ledger Undo; current information and original history remain recoverable. |
| D49 | Otis applies authorized saved-information cleanup immediately with history/Undo. With an unsaved manual draft, it tidies the draft and the member still clicks Save. This target must be enforced by the server, including legacy write tools. |
| D50 | Calculations and organization can be requested conversationally. Reuse suitable existing fields, preserve distinctive facts, and retain original values/sources through synthesis or cleanup. |
| D51 | User selected plans for single-entry correction/removal, a complete client-file experience, richer contacts/lossless merging, linked retained photos/documents/audio, cross-chat search, recurring/conditional follow-ups and actor attribution. Prioritize corrections and the client file; verify existing capabilities before adding replacements. [Capability plan](../plans/business-memory-capabilities.md). |
| D52 | The user clarified that they had not requested a private-note feature. Restricted-visibility notes are outside active scope. The earlier author-and-workspace-owner answer is a conditional design preference if this is selected later, not implementation authorization. Keep existing shared business records and personal preference scope; do not add a private composer/audience schema under attribution work. |

## Unresolved or deferred

D17 remains open: unsolicited high-confidence outreach/check-ins beyond a chosen brief or explicit reminder. Keep those triggers disabled; don't use a supplied proposal as consent.

Broader services (connected Sheets, read-only MCP, WhatsApp bot, live calls/billing) require separate user-selected work. Flexible fields/direct editing are now selected in D47–D50. Real device/provider measurements, provisioned data location and outside-customer arrangements are evidence/launch work, not settled facts. Routine file naming/decomposition does not need a decision entry.
