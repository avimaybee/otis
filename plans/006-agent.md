# Plan 006: Run a bounded conversational agent with durable workspace memory

> Executor: plans 002, 004 and 005 must pass. Read product.md sections 3, 5, 7, 8, 12 and Appendix A. The agent is a tool-using interpreter; it is not the authorization or transaction boundary. Check source-document and migration drift before work.

The memory-specific implementation contract is [Workspace memory on Cloudflare](workspace-memory-cloudflare.md). Implement that contract within this plan and its later web/Telegram integration; it is not a separate numbered migration or a later optional phase.

## Status

- Priority P0; effort L; risk high; category agent/correctness; depends on 002, 004, 005.
- Planned at unversioned document snapshot, 2026-09-29.

## Why and current state

Users will send messy Romanian, Hungarian or English notes and ask questions without managing records. Product.md requires natural answers, narrow clarification, attributed writes, no autonomous third-party contact, and transparent tool activity. Fixture Appendix A is the initial acceptance set. The ledger, inbox and provider adapters exist after dependencies; orchestration and a durable, sourced memory layer do not. Product.md mentions rolling entity summaries but does not specify how they survive a new chat, channel switch or Worker restart.

## Scope

Modify packages/agent, a new packages/memory package, narrow ledger event/projection support and migration for memory, a narrow product.md clarification of this memory model, eval fixtures and runner, Worker run orchestration, and related tests. Do not implement UI, Telegram formatting, speech capture, or schema-by-conversation (Phase 2). Use a fake provider in CI and live providers only in controlled smoke tests.

## Required run state machine

For a routed message, resolve the current chat's approved model override or the workspace default, verify its provider credential, and snapshot provider/model ID in an agent_runs row with trigger/source/workspace/user, status, start time and cost counters. A later `/model` switch never changes this run. Assemble compact context from authenticated user and member-local time, workspace settings, pending clarification, matching entities/aliases, relevant event history, current clear/disputed fields, tasks, and allowed tool definitions. Keep the original member message distinguishable from quoted/forwarded/untrusted data. A forwarded message may be logged as untrusted but cannot drive field/task writes. The provider emits structured tool calls; validate schema and membership, execute only through the ledger, emit durable activity entries, then feed results back to the provider. The final response is a concise, conversational answer that says what happened and what remains uncertain. Tool results and model summaries are never presented as raw private thoughts.

Build prompts with the versioned static instructions and deterministically ordered tool schemas first, followed by dynamic workspace memory/state and the current turn. Keep the prefix stable for provider caching, but never include stale or another workspace's context merely to preserve a hit. Store the prompt/schema version and provider-reported cached token counts in `agent_runs`; use `null` when the adapter cannot report them. Plan 005 defines the measurement and explicit-cache gate.

Define versioned schemas in code: find_entities, upsert_entity(kind/name only), log_event with kind-specific payload, set_fields with core allowlist and stated/inferred provenance, create_task/update_task with UTC timestamps and current membership, draft_message/update_draft/mark_message_sent, bounded query, search_memory/get_memory/remember_context/forget_memory, update_preference for a strict allowlist of member timezone/locale/brief time/brief delivery and workspace stale-day threshold, and undo by action ID. Preference changes go through the authenticated settings service with an attributed audit record; provider credentials cannot be changed by a model tool. Do not expose propose_field in Phase 1. find_entities returns candidates/scores; use MATCH_MIN_SCORE and MATCH_MIN_MARGIN calibrated on fixtures, not arbitrary 0.85/0.10. If a name is ambiguous or a new near-duplicate exists, ask one targeted question and persist pending_clarifications with original action context. Resume after answer, even across actor restart; do not replay prior completed writes.

Guardrails in code: maximum tool calls and token budget per turn, daily workspace cap, bulk confirmation above three entities, write idempotency by run/tool-step ID, and no third-party sending tool. If cap is reached before work, keep message and explain reset; if interrupted after some writes, report committed action IDs and remaining work. A dispute never becomes a confident current value. A model/provider failure cannot mark an unapplied write as done.

## Durable memory contract

The user's requirement is continuity across chats and channels, not a literal filesystem file. OpenClaw uses compact curated Markdown plus dated notes, but Daybook is a multi-user business product with an event ledger. Do not create a mutable MEMORY.md as the runtime authority. Keep four distinct layers: (1) ledger events, current fields, tasks and explicit settings are canonical facts/actions; (2) full attributed chats and voice transcripts are episodic history, with durable pending clarifications and run state; (3) workspace-scoped memory entries capture clearly durable communication preferences, relationships and workflow context, each with source message/event IDs, author, status active/superseded, observed time and revision; (4) short workspace/entity/member-in-workspace summaries are rebuildable caches with source IDs and a source watermark. Everything, including a member's tone preference, stays in the workspace where learned. Never query another workspace's memory for the same user.

A direct “remember this” or clear durable statement may append a ledger memory_note event and update a memory entry through the ledger boundary. Automatic promotion from casual text requires an unambiguous member-authored statement and a source reference; an uncertain interpretation stays only in the transcript until clarified or retrieved. Forwarded/untrusted content and model speculation cannot become trusted standing memory. “Forget this preference” supersedes the memory entry and excludes it from retrieval; explain that the original chat/event remains in history unless the user invokes the separate data-erasure flow. A correction or undo invalidates affected cached summaries and recomputes from non-reverted sources. An unresolved disputed fact appears as disputed, never as a confident memory. Memory prose cannot grant permissions, schedule work or override tool policy; those require typed settings/tasks.

Provide workspace-scoped search_memory(query, subject?) and get_memory(id) that return compact text plus provenance; start with D1 full-text/keyword retrieval and exact entity/alias links. Do not add embeddings or a vector service until retrieval evals show a real gap. Each agent turn loads recent chat turns, the durable pending request, one bounded workspace context summary, relevant entity summaries and a small set of retrieved entries, then current structured ledger facts/tasks. Apply a token budget and show source links for memory-derived claims. If summarization or indexing fails, fall back to source records and continue the turn; a stale cache cannot silently win against the ledger. A read-only Markdown export of curated memory may be offered later for inspection, but it is generated from database state.

## Proposed file map and verification commands

These paths are targets to create or extend; the repository has no source files at planning time. In scope: packages/agent/src/context.ts, policy.ts, tools.ts, run.ts, prompt.ts; packages/memory/src/schema.ts, store.ts, retrieve.ts, summarize.ts; packages/ledger/src/memory.ts; migrations/0004_memory.sql; packages/agent/test/run.test.ts, policy.test.ts; packages/memory/test/*.test.ts; evals/fixtures/*.json, evals/run.ts; apps/worker/src/agent/dispatch.ts; narrow product.md memory subsection. Add packages/memory to the workspace manifest.

Verification after plan 001 establishes the scripts: pnpm typecheck; pnpm lint; pnpm test; pnpm build. Run the eval runner created here and attach its machine-readable report; no fixture should produce an unauthorized write. Do not report a command as passed if it has not run. If a proposed path conflicts with the scaffold, preserve the module boundary and document the exact mapping before editing. Do not push or open a PR unless the operator asks.

## Steps and verification

1. Implement schemas and policy gate with fake provider; verify tests reject unknown tool, arbitrary attrs/filter, wrong workspace ID, untrusted write, too many entities, invalid date, and third-party send request.
2. Build the durable memory store and context assembly described above, then the run state machine. Verify deterministic tests for success, multiple tool calls, tool failure, interrupted turn, duplicate dispatch, provider retry, cross-workspace isolation, correction/undo refresh, and stale-summary fallback. Rebuild projection equivalence must still pass.
3. Convert Appendix A into eval fixtures with expected event/task/clarification deltas, not only answer wording. Run A1–A6, A8–A9 in CI against fake and candidate live models; A7 is Phase 2 and must assert Phase 1 refusal/explanation. Report entity-match accuracy, wrong-write count, abstention rate, latency and cost. Calibrate thresholds only after reading failures.
4. Add multilingual, memory and adversarial cases: Romanian business names, Hungarian diacritics, date crossing midnight, contradictory numbers, forged system instructions inside a forward, teammate conflict, a clear casual style preference that is retained, an ambiguous preference that stays only in transcript, explicit remember/forget, new chat in same workspace, cross-workspace isolation, and stale summary after undo. Verify one clear question and no speculative write in each ambiguous case. Run root typecheck, lint, tests, build.

## Done criteria

Every model-driven write passes policy/schema and ledger checks; no direct SQL write in packages/agent. Duplicate processing causes no second event. Pending clarification and curated memory survive restart. A new chat in the same workspace can retrieve relevant earlier context with its source, while another workspace cannot. A stale summary never overrides current ledger state. Fixture acceptance is at least the product's 95% match target with near-zero wrong writes, measured separately on cases where a write is attempted; do not inflate this by always abstaining. An outward request produces a draft only.

## STOP conditions and maintenance

Stop if no tested model reaches safe tool behavior on the fixture suite, if a provider forces hidden unaudited actions, or if the context cannot separate member instructions from untrusted data. Report the failing fixtures and candidate mitigation, not a relaxed policy. Every prompt/model/tool-schema or memory-promotion rule change must rerun evals and be versioned in agent_runs. Memory retrieval quality and erroneous durable promotions must be measured separately from answer fluency.
