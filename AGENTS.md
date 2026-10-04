# Working on Otis

Otis is a mobile-first conversational business memory for Kerning. Execute the assigned gate; do not invent a CRM or general browser assistant.

## Read before implementing

Read README.md and your assigned plan, then the relevant product.md, architecture.md and docs/contracts.md sections. UI/copy work requires design-tokens.md, design.md and plans/008-ui-implementation-handoff.md. The token file and docs/design/approved-reference.png are mandatory visual authority; do not reinterpret or improve them. roadmap.md explains dependencies; plans/README.md records status. docs/agent-handoff.md gives a portable start/completion template.

Inspect git status/history and live source. Plans describe targets, not proof that dependencies already exist. Preserve unrelated changes. Resolve routine file decomposition, naming and reversible implementation choices yourself. Ask only about material unresolved product, data, authority or external-action decisions; do not reopen settled choices in docs/decisions.md.

## Product decisions to preserve

- Ordinary work is conversational. Commands, settings and inspection controls are optional helpers.
- Clear complete instructions save directly. Missing deadlines and uncertain details ask. Inferred lead-status changes ask before mutation.
- Approved charcoal + muted Highlighter visual baseline in design-tokens.md; ChatGPT-like mobile composition, Codex-like desktop sidebar/chat/detail. Exact token recipes, Inter latin-ext, no composer toolbar, no dashboard/dead controls. Highlight has exactly the five approved uses.
- One user identity, equal workspace members, protected owner lifecycle. Teammates read all historical chats and retained audio; only the author appends.
- Gemini and OpenCode Go shared workspace credentials; handpicked model registry; /model changes the current chat.
- Recorded voice notes, text reply default; Android/iPhone/Telegram formats need actual evidence.
- Briefs start disabled and run at each member's chosen time/days/timezone. No 09:00 fallback.
- Default Undo from here reverts the selected write and later writes of that run; single-action is secondary. Preserve unrelated teammate work.
- All durable memory/preferences stay per workspace. No canonical mutable memory.md runtime file.
- V1 outward messages are drafts; opening WhatsApp is not proof of sending.

## UI execution rules

- Use one production message/composer implementation in both stories and application. Every design.md fixture is a Storybook story, including failure, pending and long content; future-feature contract stories are labeled unimplemented.
- Every action gives local feedback within 100 ms; pending beyond 300 ms stays inside the affected control. Messages echo immediately with one stable UUID reused for delivery retry; saved input is not completed agent work.
- Commands apply real scoped operations without config chat bubbles. Model/effort state reflects server-confirmed values; follow-ups/corrections remain sendable during active work under design.md's explicit Send/Stop clarification.
- Implement the path-correct fail-closed design checker from the 008 handoff. Run it and compare token section 12 at 360, 390, 900, 1280 and 1440 px before claiming UI completion. Until tooling is built, record it as missing, not passing.
- Missing visual token/recipe: ask Avi with the exact gap. Known token mismatch: fix it. Do not modify the approved token file to excuse old styling. Do not install all proposed libraries or rewrite backend foundations for a UI task.

## Architecture invariants

1. Business writes go through ledger commands. Events are append-only in ordinary operation; only the separate audited erasure procedure may remove/anonymize history.
2. Projections rebuild deterministically from versioned events. Conversation/identity/transport are separate durable stores, not all ledger projections.
3. Workspace-owned reads and writes require trusted scoped context. Recheck current membership and source ownership; model/client IDs cannot grant authority.
4. Failed D1 preconditions must abort the transaction. A zero-row UPDATE is not rollback. Test membership, revision, fence and late-batch failure.
5. Persist accepted input/outbox, logical tool steps and receipts. Queue retries and actor restart cannot repeat business effects.
6. Human clarification releases the workspace execution slot but preserves the pending operation. Revalidate before continuing.
7. Permission, schema validation, date validity, ranking and scheduling are code. The model proposes interpretation and tools; it is not a security boundary.
8. Public activity is persisted before publication. Display only provider-supplied public summaries, never fabricated thoughts or hidden prompts/protocol artifacts.
   Provider-exposed reasoning text is also permitted when verified and safely normalized. Render it in one nested Thinking disclosure inside Working under design.md and the 008B handoff; no synthetic traces, per-delta panels, fake step counts or new thinking service.
9. Private audio/exports use membership-checked Worker access. Secrets never enter client bundles, prompts, logs or exported data.
10. Provider caches/IDs, DO memory and summaries are not the sole source of business or conversation state.

## Work order and scope

Use the dependency gates, not numeric filename order: 003A identity → 004A conversation/source storage → 002 ledger → 003B/004B integration → providers → agent/memory → API/commands → clients → voice/brief/export → release. Do not duplicate schemas in later plans. One coordinated migration sequence owns numbering.

Introduce packages/dependencies only when required for implemented behavior. Use prepared SQL for v1; no speculative ORM/vector service. Shared schema changes update contracts, fixtures and affected clients together. Provider/cloud APIs must be checked against current official documentation when implementing them.

## Verification and handoff

For implementation changes run:
```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Add targeted behavior tests from docs/verification.md. UI implementation additionally requires the implemented design checker, Storybook build, scoped behavior/a11y tests and recorded browser comparison; consult the 008 handoff for planned tooling and commands. Use actual local Workers/D1 integration for transactions/bindings. Fake providers are for reproducible orchestration tests, not live capability claims.

Use Codex/Antigravity native browser controls for UI review; no Playwright. happy-dom geometry is not layout proof. Record real viewport/browser/device evidence or explicitly leave it unverified. Documentation-only changes require link/consistency/diff checks; do not claim application tests were rerun if they were not.

Completion report: implemented behavior, files/contracts/migrations, exact checks, evidence, unresolved limitations and next eligible gate. Mark a subgate complete only with its evidence. Do not label stubs or documentation as built features.

Task authorization governs commits, pushes, PRs and deployment. Do preparatory reversible work before any genuinely necessary final approval. Never send real lead messages, publish secrets or run a destructive remote operation because a sample plan mentions it.
