# Otis implementation gates

Revised 2026-09-30; foundation baseline is commit `a3bd462`. [roadmap.md](../roadmap.md) is the full delivery guide; [architecture.md](../architecture.md) and [contracts](../docs/contracts.md) are the technical agreements. Earlier pre-build document hashes and fixed migration numbers are retired. Inspect current Git state and dependencies before implementing.

## Order and current status

| Gate / plan | Outcome | Depends on | Status |
|---|---|---|---|
| [001](001-foundation.md) | Tooling/runtime foundation and browser acceptance | — | IMPLEMENTED; actual browser evidence pending |
| [003A](003-identity.md) | Identity/workspace/session foundations | 001 technical checks | DONE |
| [004A](004-inbound-routing.md) | Durable conversation, sources, runs, inbox/outbox schema | 003A | DONE |
| [002](002-ledger.md) | Guarded ledger, projections, dispute and grouped undo | 003A, 004A | DONE |
| [003B](003-identity.md) | Complete shared settings/lifecycle/provider configuration | 003A, 002 where integration needs it | TODO |
| [004B](004-inbound-routing.md) | Actor leases, dispatch and recovery | 004A, 002, 003B | TODO |
| [005](005-provider-spike.md) | Exact provider/model capability and budget evidence | 003B; fake work may start earlier | TODO |
| [006](006-agent.md) | Bounded agent and durable sourced workspace memory | 002, 004B, 005 | TODO |
| [007](007-web-chat-api.md) | Chat APIs, replay stream and shared commands | 006, 003B, 004A | TODO |
| [008](008-conversation-ui.md) | Precise mobile/desktop conversation | 007; fixture prototypes can start earlier | TODO |
| [009](009-telegram.md) | Complete linked private Telegram channel | 007, 004B | TODO |
| [010](010-voice.md) | Voice notes and authenticated retained audio | 005, 008, 009 | TODO |
| [011](011-briefs.md) | Member-chosen brief schedule and explicit reminders | 002, 007, 009 | TODO |
| [012](012-drafts-sheet.md) | Requested drafts and private XLSX | 002, 007, 009 | TODO |
| [013](013-release-readiness.md) | Integrated recovery/security/device/release gate | 001–012 accepted | TODO |

Numbers are stable work-package identifiers, not execution or migration order. 003A/004A exist to avoid building ledger/agent references to tables that do not yet exist. Plan 007 extends the chat storage from 004A instead of recreating it. Status vocabulary: TODO, IN PROGRESS, IMPLEMENTED (code present, acceptance incomplete), DONE (required evidence complete), BLOCKED (specific unmet external prerequisite), or DEFERRED (explicit product choice).

## Required reading and decision authority

Read assigned plan and relevant source docs; use [agent-handoff.md](../docs/agent-handoff.md). Product governs intent; design governs presentation; architecture/contracts govern implementation. Never silently follow an old example that contradicts a confirmed current decision.

Settled: Kerning scope, equal members/full history, neutral charcoal UI, private Go+Gemini, handpicked models, shared provider keys, /model chat overrides, workspace-only memory, text replies to voice, Android/iPhone, explicit missing-date/inferred-status clarification, same-run suffix undo, and chosen-time briefs without a default schedule. See [decision register](../docs/decisions.md).

## Gate discipline

Each gate ends with actual targeted evidence and the four root implementation checks. UI requires native-browser evidence; voice requires real-device/endpoint evidence. Mark unavailable checks honestly. Keep commands cross-platform for Windows paths containing spaces.

Inspect live schema/migrations before allocating the next SQL file. Do not edit applied shared migrations or introduce foreign keys to sources whose tables are created later. Preserve source history and use one package owner for each write path.

Review/smoke uses synthetic data. Live provider tests are explicit controlled runs, not automatic CI calls. Do not deploy or send real third-party messages merely because a plan describes the eventual workflow. Existing task authorization remains applicable; routine work does not need repeated confirmation.

## Supporting contracts

- [Workspace memory](workspace-memory-cloudflare.md) is part of 006.
- [Verification matrix](../docs/verification.md) supplies cross-cutting failure cases.
- [Browser evidence](../docs/browser-review.md) records actual observations.
- [Provider capability matrix](../docs/decisions/provider-capabilities.md) begins unverified.
- [Roadmap expansion](../roadmap.md#20-after-dogfood-ordered-expansion-candidates) covers future self-serve/MCP/Sheets/WhatsApp, not v1 work authorization.

## Known remaining evidence

Plan 001's technical fixes passed review at 1626124; a3bd462 added simulated-DOM width assertions. A real browser review has not been recorded here. Actual D1 jurisdiction and future provider/audio capabilities remain provisioning/spike evidence, not facts established by source comments.

## Considered and rejected approaches

- Global workspace rewind: would erase unrelated teammate work; use selected same-run actions with dependency checks.
- Auto-assigned today deadline and inferred warm/cold status: contradict confirmed clarification policy.
- Mutable memory.md authority: loses structured provenance, concurrency and workspace enforcement.
- Raw private R2 bearer URLs: incompatible with immediate membership checks.
- Queue exactly-once assumption: use durable leases/receipts/outbox instead.
- Simulated-DOM geometry as browser proof: requires a real browser record.
- Unrequested dashboard/cards/live voice/MCP inside the core: outside the first useful conversational release.
