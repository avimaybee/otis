> Historical record, archived 2026-10-07 from `docs/agent-handoff.md`. Its claims apply to the original baseline. Use [current implementation status](../../status.md) for active work; old proposals and DONE labels are not current authority.

# Implementation-agent handoff

Use this when assigning a gate to any coding agent. Keep the request concrete and allow routine implementation decisions; do not require the agent to rediscover the product vision from a long chat history.

## Start message template

```text
Implement gate <gate> from roadmap.md and plan <file>.
Read AGENTS.md, product.md, architecture.md and docs/contracts.md sections relevant to this gate.
For UI/copy work read design-tokens.md, design.md and plans/008-ui-implementation-handoff.md;
open docs/design/approved-reference.png and implement its approved production-scale recipes; for verification read docs/verification.md.
Inspect git status/history and the actual code before assuming the plan's current-state notes still apply.
Preserve unrelated work. Build only the assigned gate and its named prerequisites.
Resolve routine implementation details yourself. Ask only when a material product/security/data decision is missing.
Run the gate's targeted tests and the repository verification commands.
Report implemented behavior, exact evidence, remaining limitations and next eligible gate.
Do not claim browser/device/provider checks you did not actually perform.
```

Add explicit deployment/push/PR authorization only when intended. These templates do not authorize real lead messaging, credential disclosure, production erasure or unsolicited task delegation.

## Read map

| Assignment | Additional minimum reading |
|---|---|
| 003 identity | Architecture 4–5; contracts trusted context and table ownership |
| 004 durable sources/dispatch | Architecture 6–9, 12, 15; contract states/activity |
| 002 ledger | Architecture 8–10; contracts dates/events; product seed fixtures |
| 005 providers | Architecture 9/11/13; provider evidence matrix and exact current provider docs |
| 006 agent/memory | Product autonomy; architecture 7–11; memory implementation contract |
| 007 API/commands | Contracts routes/activity/commands; architecture membership/reconnect |
| 008 UI | Entire design-tokens.md and design.md; approved reference; detailed 008 UI handoff; browser review procedure |
| 009 Telegram | Shared command contract, linking/outbox behavior, official current Bot API |
| 010 voice | Token recipes; design voice states; 010 voice UX supplement; shared IndexedDB contract; verified capability matrix |
| 011 schedules | Chosen-time opt-in policy, date union, ranking/delivery contract |
| 012 drafts/export | Explicit sent confirmation, ledger snapshots, authenticated private download |
| 013 release | All open evidence and operations requirements |

## Implementation working notes

Keep gate-local progress notes in a small implementation report under `docs/reviews/` when useful. It should describe decisions/evidence, not duplicate canonical specifications. For long-running work record the next concrete action and unresolved blocker so a replacement agent can continue.

Before changing a shared schema, list its callers. Update both web and Telegram consumers and fixtures together. Before adding a table, inspect current migration numbering. Before adding a dependency, explain its exact job and verify Workers/browser compatibility. Do not use a planning dependency suggestion as permission to add an unused library.

A weaker model should implement smaller verified increments: first pure types/reducer, then a real D1 repository test, then service integration, then channel/UI. Never replace a difficult integration requirement with a fake object that only makes a test pass.

## Completion report template

```text
Gate and reviewed commit/diff:
Behavior now implemented:
Files/contracts/migrations changed:
Targeted verification: command, result, test count or evidence path
Root checks: typecheck / lint / test / build, with actual results
UI checks: executed design checker / Storybook build / covered fixture IDs / token section 12 comparison
Browser/device/provider/staging checks: observed evidence or explicitly unverified
Known limitations and exact user impact:
Product choices made: routine decisions versus unresolved material decisions
Next eligible gate:
```

Do not describe a stub as an implemented service. 'D1 binding exists' is not 'ledger works'; 'received audio bytes' is not 'transcription supported'; 'JSON downloaded' is not 'UI visually verified'; 'tool proposed' is not 'action saved'.

## UI assignments must be bounded

Assign one checkpoint from plans/008-ui-implementation-handoff.md. State its concrete outcome and tests. The token file is the visual authority; do not ask an agent to make it look more polished or more like shadcn. Shadcn supplies primitives; Otis recipes govern them.

Require immediate optimistic echo, truthfully reconciled state and the actual interactions relevant to that checkpoint. A screenshot of the happy path is insufficient. A test called end-to-end is not real-browser proof when it mounts components in simulated DOM. Ask for a per-fixture observed result and exact evidence, not an all-good summary.

Source current-state notes expire when the source changes. Inspect implementation; preserve existing durable acceptance/authorization/receipt boundaries. One query/route/scroll owner replaces the old one rather than layering another implementation over it.

## Review instructions

Review actual code and behavior against the assigned gate. Reproduce high-impact failures. Separate out-of-scope future work from present defects. Preserve useful design decisions instead of expanding features to demonstrate thoroughness. If a check cannot run, identify the concrete limitation and the smallest remaining verification step; do not silently grant acceptance.
