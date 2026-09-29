# Daybook implementation handoff

Prepared 2026-09-29 from the pre-build repository. The repository contains only product.md and design.md as source documents; it has no Git HEAD, package manifest, tests, or deploy configuration. After the handpicked-model and shared slash-command decisions, including `/model`, the source-document snapshot is SHA-256 product.md 0D6508D7262B982C5D4BC7F25DFDD481E46FF6BD82B22028606199C3BBD9B29B and design.md 3D258F56B5895D1E28416CAE6E06D83803B80E026F1E74D5A29AF7F0813D1B09. Before plan 001, compare those files with this snapshot. Plan 001 intentionally updates them with later user decisions and initializes Git; subsequent plans compare live docs and Git diffs against their assumptions. Do not treat a mismatch as permission to improvise.

Read the selected plan in full and the relevant sections of product.md and design.md. The plans are self-contained but the two root documents remain the product and visual source of truth. An implementation agent should complete one plan at a time, update this table, and give a reviewable change with the prescribed checks. Later plans assume the command baseline created in plan 001: pnpm typecheck, pnpm lint, pnpm test, and pnpm build. Web interaction and responsive layout are reviewed hands-on in a Codex or Antigravity browser session; do not install a browser automation framework for this project.

The user chose the Cloudflare Workers + Durable Objects + D1 + R2 stack, workspace-shared provider credentials (one per connected provider), text replies to voice notes by default, and a dark default theme with Daybook's own palette. The product operator handpicks offered models; provider catalog discovery never auto-publishes a model. A shared default model applies to new chats, and `/model` selects an approved model for the member's current chat without changing a teammate's chat. The agent must retain clearly durable context and personal communication preferences within each workspace only; no preference follows a user into another workspace. Both Avi and Hunor have Google accounts for web sign-in. Phase 1 is the Kerning dogfood release for Avi and Hunor; self-serve onboarding is later. When a member is added, they may read the full workspace chat history, including chats from before they joined, and both retained voice audio and transcripts; disclose this clearly in the invite flow. Shared slash-command shortcuts appear in both the web composer and Telegram's native command menu, while plain language remains the main interface. Google Sheets sync, photos/location parsing, autonomous third-party messaging, live voice, and WhatsApp bot access are outside this sequence. The user wants OpenCode Go connected for private dogfood; plan 005 documents its published coding-traffic guidance and requires a fresh review before commercial reliance rather than blocking the private adapter.

## Execution order

| Plan | Result | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| 001 | Repository, tooling, local runtime, and verification baseline | P0 | M | — | DONE |
| 002 | Event ledger, deterministic state, tasks, disputes, and undo | P0 | L | 001 | TODO |
| 003 | Google identity, membership, workspace and provider settings | P0 | L | 001, 002 schema conventions | TODO |
| 004 | Durable inbound routing and per-workspace processing | P0 | L | 002, 003 | TODO |
| 005 | Provider capability and permitted-use spike | P0 | M | 001, 003 | TODO |
| 006 | Bounded agent, sourced workspace memory and evaluation harness | P0 | L | 002, 004, 005 | TODO |
| 007 | Web chat API, transcript, stream, shared slash commands and action API | P0 | L | 003, 004, 006 | TODO |
| 008 | Mobile-first and desktop web conversation UI | P0 | L | 007 | TODO |
| 009 | Telegram bot, linking, native command menu, callbacks and delivery | P0 | L | 003, 004, 006, 007 | TODO |
| 010 | Web and Telegram voice notes | P1 | M | 007, 008, 009 | TODO |
| 011 | Deterministic morning brief and stale sweep | P1 | M | 002, 007, 009 | TODO |
| 012 | Outward drafts, WhatsApp handoff, and generated XLSX | P1 | M | 002, 007, 009 | TODO |
| 013 | Security, recovery, dogfood acceptance, and release operations | P0 | L | 001–012 | TODO |

Product.md Appendix C is a terse first-day sketch; this dependency order is the executable sequence. It places identity and ledger guarantees before a functional webhook, while plan 004 still builds the intended plain echo before model wiring.

For the memory portion of plan 006, use [Workspace memory on Cloudflare](workspace-memory-cloudflare.md) as the detailed execution contract. It specifies D1 tables and source revisions, the Durable Object request path, Queue refresh and Cron recovery, scoped retrieval, correction/forget behavior, and failure tests. It is part of plan 006, not an additional dependency or migration number.

The critical path is 001 → 002/003 → 004/005 → 006 → 007 → 008/009 → 010/011/012 → 013. Plans 002 and 003 can progress independently after 001, but their migrations must be reconciled before 004. Plan 005 can run alongside 004. UI shell work can be prototyped while 007 runs, but its integration and completion gate depend on 007.

## Review and release gates

Every plan requires the relevant unit/integration checks plus the repository-wide typecheck, lint, tests, and build. Do not claim a passing command that does not yet exist; plan 001 must create it first. Keep production credentials out of source, fixtures, logs, transcript exports, and screenshots. No plan authorizes deploying to production or messaging real third parties. Deployment and real-user dogfood use require the final operational review in plan 013.

Status values: TODO, IN PROGRESS, DONE, BLOCKED with reason, or REJECTED with reason. Do not mark DONE until its done criteria and tests pass. If a plan encounters a STOP condition, keep work reviewable, mark BLOCKED, and report the precise unresolved fact.

## Decisions deliberately left measurable

Match score/margin and action/token caps are named configuration, calibrated by fixtures and provider measurements. They are not arbitrary product promises. The default theme is dark; plan 008 must choose Daybook-specific dark tokens through prototypes. Light/system support is optional. Memory entries and summaries are sourced database records/projections, not a mutable memory.md file; plan 006 defines them and plan 007 links them to chat history. Export/erasure policy and provider processing-region claims require review in plan 013 before outside customers; EU storage jurisdiction alone is not an end-to-end residency guarantee.

## Sources checked for platform assumptions

- Cloudflare Workers static assets and Vite plugin: https://developers.cloudflare.com/workers/static-assets/
- Cloudflare Workers Vitest integration: https://developers.cloudflare.com/workers/testing/vitest-integration/
- Cloudflare D1 and R2 jurisdiction rules: https://developers.cloudflare.com/d1/configuration/data-location/ and https://developers.cloudflare.com/r2/reference/data-location/
- Cloudflare Queues at-least-once delivery: https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- Cloudflare D1 FTS5 and atomic batch transactions: https://developers.cloudflare.com/d1/sql-api/sql-statements/ and https://developers.cloudflare.com/d1/worker-api/d1-database/
- Cloudflare Durable Object alarms: https://developers.cloudflare.com/durable-objects/api/alarms/
- Durable Object concurrency guidance: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Google OpenID Connect token validation: https://developers.google.com/identity/openid-connect/openid-connect
- Telegram Bot API and deep links: https://core.telegram.org/bots/api and https://core.telegram.org/api/links
- Gemini tool calling and audio: https://ai.google.dev/gemini-api/docs/function-calling and https://ai.google.dev/gemini-api/docs/audio
- OpenCode Go usage and endpoint documentation: https://dev.opencode.ai/docs/go/
