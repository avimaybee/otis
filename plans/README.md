# Otis implementation gates

Revised 2026-10-03. UI documentation was inspected against commit `663f0b3`; earlier gate baselines are historical evidence. [roadmap.md](../roadmap.md) is the full delivery guide; [architecture.md](../architecture.md) and [contracts](../docs/contracts.md) are the technical agreements. Earlier pre-build document hashes and fixed migration numbers are retired. Inspect current Git state and dependencies before implementing.

## Order and current status

**2026-10-04 runtime repair:** fresh-chat readiness, Gemini stateful tool continuation, clarification answer identity, unfinished preview labeling and implicit-chat Undo retry are locally reviewed. Final implementation suite645/45; reviewer targeted adapter24, transcript24 and chat API53 passed. See [QA adjudication](qa/2026-10-04-antigravity-review.md) for exact evidence and prior failures. No release performed. Next acceptance step is the [identified-build browser retest](qa/runtime-repair-browser-retest.md); production remains unaccepted until save→confirmation→retrieval→reload works on the released repair. Preserve the queued008C and unrelated dirty tree; do not infer authority to deploy or start another feature from this note.

**Current priority — prove the useful conversation:** the reviewer-authored [dogfood execution order](013-dogfood-execution-order.md) supersedes older foundation-first sequencing. Independently close the current 015A.1 patch, then assign one text-only Telegram capture → actual reply → later retrieval journey under 009. Add voice to that path, then the member-chosen brief. Repair demonstrated runtime/cost blockers, not every proposed foundation improvement. [007-conversation-repair.md](007-conversation-repair.md) remains the existing defect record. Earlier DONE rows describe local evidence, not deployed conversational acceptance.

| Gate / plan | Outcome | Depends on | Status |
|---|---|---|---|
| [001](001-foundation.md) | Tooling/runtime foundation and browser acceptance | — | IMPLEMENTED; actual browser evidence pending |
| [003A](003-identity.md) | Identity/workspace/session foundations | 001 technical checks | DONE |
| [004A](004-inbound-routing.md) | Durable conversation, sources, runs, inbox/outbox schema | 003A | DONE |
| [002](002-ledger.md) | Guarded ledger, projections, dispute and grouped undo | 003A, 004A | DONE |
| [003B](003-identity.md) | Complete shared settings/lifecycle/provider configuration | 003A, 002 where integration needs it | DONE |
| [004B](004-inbound-routing.md) | Actor leases, dispatch and recovery | 004A, 002, 003B | DONE; independently reviewed 2026-10-01; local evidence only |
| [005](005-provider-spike.md) | Exact provider/model capability and budget evidence | 003B; fake work may start earlier | DONE; [independently accepted 2026-10-01](005-review-followup.md); three primary models enabled, secondary/audio capabilities remain gated |
| [006](006-agent.md) | Bounded agent and durable sourced workspace memory | 002, 004B, 005 | DONE; [independently accepted 2026-10-02](006-review-round6.md); local evidence only |
| [007](007-web-chat-api.md) | Chat APIs, replay stream and shared commands | 006, 003B, 004A | DONE; [independently accepted 2026-10-03](007-review-round3.md); local evidence only |
| [008](008-conversation-ui.md) | Exact approved visuals + reliable conversation behavior | 007; see 008A–008D in [UI handoff](008-ui-implementation-handoff.md) | 008A IMPLEMENTED UNVERIFIED (tooling + stories done, real-browser review pending; see `docs/reviews/2026-10-04-008/REVIEW.md`); 008B IMPLEMENTED — REVIEW PENDING (evidence `docs/reviews/2026-10-04-008/008B.md`); 008C PARTIAL — REVIEW PENDING (implemented scope plus exact contract-blocked scope with proposals in `docs/reviews/2026-10-04-008/008C.md` and `plans/008C-contract-proposals.md`); 008D IMPLEMENTED — REVIEW PENDING (evidence `docs/reviews/2026-10-04-008/008D.md`) |
| [009](009-telegram.md) | Complete linked private Telegram channel; current scoped implementation: [009A text loop](009A-text-loop-handoff.md) | 007, 004B; accepted 015A.1 | 009A ACCEPTED locally ([independent review](009A-review-acceptance.md), 633 tests / 45 files); remainder TODO |
| [010](010-voice.md) | Voice notes and authenticated retained audio | 005, 008, 009 | TODO |
| [011](011-briefs.md) | Member-chosen brief schedule and explicit reminders | 002, 007, 009 | TODO |
| [012](012-drafts-sheet.md) | Requested drafts and private XLSX | 002, 007, 009 | TODO |
| [013](013-release-readiness.md) | Integrated recovery/security/device/release gate | 001–012 accepted | TODO |
| [014](014-implementation-handoff.md) | Reviewer-authored web live-transport/D1 separation; old agent draft superseded; execute only explicitly assigned 014A–014C checkpoint | 007 economics containment; independent per-checkpoint review | SPECIFIED; NOT ASSIGNED; not a Telegram-text prerequisite |
| [015](015-foundation-efficiency.md) | 015A.1 changed-only persistence [independently accepted](015A1-review-acceptance.md); other proposed efficiency tasks remain unassigned | Existing ledger; no dependency on completing 014 for 015A.1 | 015A.1 ACCEPTED locally; remaining tasks PROPOSED |

Numbers are stable work-package identifiers, not execution or migration order. 003A/004A exist to avoid building ledger/agent references to tables that do not yet exist. Plan 007 extends the chat storage from 004A instead of recreating it. Status vocabulary: TODO, IN PROGRESS, IMPLEMENTED (code present, acceptance incomplete), DONE (required evidence complete), BLOCKED (specific unmet external prerequisite), or DEFERRED (explicit product choice).

## Required reading and decision authority

Read assigned plan and relevant source docs; use [agent-handoff.md](../docs/agent-handoff.md). Product governs intent; design-tokens.md and its approved reference govern visual values/recipes, design.md governs interaction; architecture/contracts govern implementation. Never silently follow an old example that contradicts a confirmed current decision.

Settled: Kerning scope, equal members/full history, charcoal + approved Highlighter UI, private Go+Gemini, handpicked models, shared provider keys, /model chat overrides, workspace-only memory, text replies to voice, Android/iPhone, explicit missing-date/inferred-status clarification, same-run suffix undo, and chosen-time briefs without a default schedule. See [decision register](../docs/decisions.md).

## Current UI assignment

Read [008-conversation-ui.md](008-conversation-ui.md) and the detailed [008 UI handoff](008-ui-implementation-handoff.md). Execute 008A first: one token store, enforcement, Inter, production-component stories and reference fidelity. Then 008B send/state/commands, 008C scroll/viewport/a11y/routes, 008D offline durability. These stay inside the existing gate. Real conversation/provider/dispatch repair proceeds under 007 where needed; styling does not close runtime failures.

[010-voice-ux-handoff.md](010-voice-ux-handoff.md) adds recording/interruption/local recovery/device evidence to the existing voice plan; it does not duplicate the STT service. No new feature is marked implemented by these docs.

## Engineering simplicity

Gate 005 has a detailed [implementation-agent handoff](005-implementation-handoff.md), supplementing its original plan without changing gate order.

The user-requested [thinking-controls handoff](005-thinking-controls-handoff.md) is IMPLEMENTED: verified per-model effort options, `/thinking` on both surfaces, an optional model-adjacent selector now superseded on web by the approved slash/quiet-overflow placement (no composer chips), conversational `set_chat_thinking` tool, and immutable accepted-run configuration. It extends 005–009 without adding a new gate or changing prior acceptance. Provider default remains available while adjustable options operate on verified endpoint evidence.

Gate 006 has a detailed [agent/memory execution contract](006-implementation-handoff.md): current source baseline, typed tool ownership, checkpoints 006A–006D, pinned models, durable loop/receipt recovery, memory projections and exact acceptance tests. The checkpoints stay within 006; they are not new roadmap gates. Implemented work remains review pending until independently accepted.

Gate 010 has a detailed [native-audio/Groq STT handoff](010-groq-stt-handoff.md). Gate 005 defines the capability/resolver boundary; gate 010 implements recording, transcription and encrypted Groq credentials. No new gate or parallel STT infrastructure is required. Dogfood adds no paid inference beyond the existing Go subscription.

Keep Otis simple, modular and easy to maintain without weakening its working guarantees. Prefer a small set of explicit code paths and existing services. Add an abstraction only when it removes demonstrated duplication or owns a concrete responsibility; do not create generic frameworks, speculative extension points, or infrastructure for later phases.

Durable acceptance, workspace isolation, authorization, idempotency, lease fencing and recovery are required correctness mechanisms. Enforce them at shared committing boundaries rather than duplicating prechecks in each caller. Test meaningful failure and concurrency scenarios; avoid tests that merely repeat implementation details. Split large modules by an existing responsibility when that makes ownership clearer, not to meet an arbitrary line count. Reviews must distinguish defects that can lose or corrupt data from optional cleanup, and must not turn optional cleanup into another release gate.

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

## Reviewer and implementation-agent responsibility (2026-10-04)

The reviewer writes architecture decisions, implementation handoffs and scoped commands, and independently accepts work. The implementation agent executes the assigned command, writes code/tests and reports evidence. It may report contradictions but does not own architecture planning or start subsequent checkpoints unassigned. The user corrected this division explicitly.

For live transport, `014-live-transport.md` is a superseded implementation-agent draft; [014-implementation-handoff.md](014-implementation-handoff.md) is the reviewer-authored authority with checkpoints014A–014C. No checkpoint is started by this index. 015A.1 is independently accepted in [review evidence](015A1-review-acceptance.md); [009A](009A-text-loop-handoff.md) was explicitly assigned to the existing OpenCode session on 2026-10-04. 009A is now locally accepted in [independent review](009A-review-acceptance.md); the next checkpoint requires its own explicit reviewer handoff. No live bot/deployment acceptance is implied.
