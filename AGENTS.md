# Working on Otis

Otis is a mobile-first conversational business memory. Execute the user's assigned task; do not invent a CRM, dashboard or general browser assistant. Latest explicit user instructions take precedence over old plans. Preserve unrelated changes. Do not invoke subagents when the user has prohibited them.

## Before work

Read [README](README.md), inspect git status/history and live source, then read only the relevant [product](product.md), [architecture](architecture.md) and [contract](docs/contracts.md) sections. [Status](docs/status.md) records current evidence; [plans/README](plans/README.md) records current backlog. Historical documents in [docs/archive](docs/archive/README.md) describe their original baseline and do not authorize work.

For UI/copy work, read [design-tokens](design-tokens.md) and [design](design.md). The current approved token file and `docs/design/approved-reference.png` are visual authority, with the latest explicit approved/user change resolving older recipes. Fonts come from that authority; do not copy an obsolete Inter requirement from an archived handoff. Use the existing production components and shadcn primitives. Do not edit approved tokens to excuse styling drift.

Resolve routine decomposition, naming and reversible choices yourself. Ask only for a material unresolved product, data, authority or external-action decision. Do not reopen settled [decisions](docs/decisions.md). Finish authorized preparatory work before any necessary final approval.

## Product rules

- Ordinary work is conversational. Commands, settings and inspection are optional helpers.
- Clear, complete instructions save directly. Save unrelated clear facts while asking narrowly for missing deadlines or uncertain details. Inferred changes to an existing lead status ask before mutation.
- Response detail follows the request. Tables are general: leads are one example, not a fixed reporting template. Choose useful columns, retrieve needed facts, disclose partial coverage and never invent cells.
- Use the Codex-style question panel: a question has its own options/free-text answer, Skip and Send. Main-composer follow-ups do not implicitly answer a paused question.
- Every business query/write is workspace-scoped with trusted identity. No hardcoded emails, member or tenant IDs in business logic.
- Platform Gemini/OpenCode/Groq keys live in Worker secrets; encrypted workspace BYOK takes priority. Secrets stay server-side.
- Voice notes receive text replies by default. Android/iPhone/Telegram formats need actual evidence.
- Briefs start disabled and use each member's chosen time/days/timezone/channel; no 09:00 fallback. Additional unsolicited proactivity remains unresolved.
- Default Undo from here reverts the selected write and later writes of that run; single-action is secondary. Preserve unrelated teammate work.
- Durable memory/preferences stay per workspace. No canonical mutable `memory.md`.
- Outward messages are drafts in v1. Copying/opening WhatsApp is not evidence of sending.

## Lean implementation and budgets

Cloudflare Free limits are design constraints: ordinary Worker CPU under 10 ms/request, D1 writes under 100,000/day and reads under 5,000,000/day. Check current official limits and measure the actual venue/usage before claiming compliance; network waiting is not CPU. No chatty roundtrips, heartbeat database polling for provider tokens or write multiplication.

Use direct TypeScript and prepared SQL. No speculative ORM, vector database, service split, report engine or new orchestration framework. Do not simulate distributed consensus on SQLite/D1. Prefer atomic conditional SQL; a failed precondition must actually abort the transaction. Existing stale-attempt checks protect external async work and must not be removed on the assumption that D1 serialization makes stale data impossible. Measure and reduce guard storage without adding guard layers.

Stream provider previews directly in memory and batch durable completion/receipts. D1 catch-up is for recovery, not a live token transport. Known remaining heartbeat/publication costs are open work in status, not an exemption or a verified zero-polling claim.

Use shadcn primitives customized to approved tokens; keep state local, scoped, optimistic and simple. Add a package only for behavior being implemented now.

## Durable correctness

1. Business writes go through ledger commands. Events are append-only in ordinary operation; only a separate audited erasure procedure may remove/anonymize history.
2. Versioned events deterministically rebuild projections. Identity/conversation/transport are separate durable stores.
3. Recheck current membership and source ownership. Model/client IDs cannot grant authority.
4. Failed membership/revision/attempt preconditions abort the batch; a zero-row UPDATE is not rollback.
5. Persist accepted input/outbox, logical tool steps and receipts. Queue retries/restarts cannot repeat business effects.
6. Human clarification releases the execution slot and retains the pending operation. Revalidate before continuing.
7. Permission, validation, date validity, ranking and scheduling are code; the model proposes interpretation.
8. Committed public activity is persisted before publication. Actual provider-supplied displayable reasoning may appear in one nested Thinking disclosure inside Working. Transient text previews are explicitly non-authoritative; no fake thoughts/counts or hidden protocol.
9. Private media/exports require Worker membership checks. Secrets never enter client bundles, prompts, logs or exports.
10. Provider IDs/caches, actor RAM and summaries are not the sole business/conversation source.

## UI execution

Use one production message/composer implementation in stories and app. Every design.md fixture has a story; future capability fixtures are labeled unimplemented. Give local feedback within 100 ms and keep pending beyond 300 ms in its affected control. Echo a sent message immediately with one stable UUID reused for retry; accepted input is not completed agent work.

Commands apply actual scoped operations without config bubbles. Model/effort values reflect server confirmation. Follow-ups remain sendable during work: empty composer shows Stop; a valid draft shows Send, with Stop reachable in overflow. Question answers preserve their explicit target and immutable retry payload.

Run the implemented design/story checkers. Compare token section 12 at 360, 390, 900, 1280 and 1440 px before claiming UI completion. Use native Codex/Antigravity browser controls, no Playwright. DOM geometry and synthetic screenshots are not physical device/provider proof.

## Verification and documentation

Implementation changes run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` and meaningful targeted behavior checks. Transactions/bindings use actual local Workers/D1. UI changes also run design/story checks, Storybook build, scoped behavior/a11y tests and a native-browser comparison. Fake providers prove orchestration, not live capability or answer quality.

Documentation-only changes require link, consistency and diff checks; report application commands only if actually run. Record implemented behavior, affected files/contracts/migrations, exact checks/evidence and remaining limitations in the task handoff. Update existing status/backlog; do not create a new audit/handoff/status document for every round. Archive a finished task's detailed record only when it adds evidence unavailable elsewhere.

The actual next task is selected by the user/backlog, not obsolete numeric gate order. Schema dependencies still matter: identity/conversation sources precede ledger references, then integration/providers/agent/APIs/clients. Inspect migration numbering and never edit an applied migration. Commit, push, PR and deployment require task authorization. Never send real lead messages, expose secrets or execute destructive remote operations because an archived sample plan says so.
