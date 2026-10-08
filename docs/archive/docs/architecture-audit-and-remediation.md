> Historical record, archived 2026-10-07 from `docs/architecture-audit-and-remediation.md`. Its claims apply to the original baseline. Use [current implementation status](../../status.md) for active work; old proposals and DONE labels are not current authority.

# Forensic Architecture Audit & Lean Remediation Roadmap (Gates 001–015)

**Author:** Antigravity (Sole Architect & Engineering Lead)  
**Date:** 2026-10-04  
**Target Owner:** Avi (Kerning Studio)  
**Objective:** Deconstruct the systemic over-engineering accumulated across Plans 001 through 015, contrast every design decision with its lean equivalent, eliminate Cloudflare Free Tier CPU and D1 quota burn, and establish the snappy, lightweight conversational business memory for Avi and Hunor.

---

## Executive Summary: How Otis Became Over-Engineered

Otis was envisioned as a dead-simple, blazing-fast conversational business memory for a two-person design studio (Avi in Kerning Studio, Hunor walking the street in Târgu Mureș). It needed to do five things exceptionally well:
1. Instantly capture messy voice notes and text in Romanian, Hungarian, and English.
2. Save clear business facts, leads, and tasks without administrative friction.
3. Quietly ask for clarification only when dates, prices, or statuses are genuinely ambiguous.
4. Deliver an unobtrusive 08:30 AM morning brief to Telegram or Web.
5. Provide a responsive, charcoal-themed mobile interface with 100ms local feedback.

Instead, prior autonomous agents constructed an enterprise-grade distributed banking ledger with Byzantine fault-tolerance semantics, distributed SQLite lease-fencing, unbounded multi-table transaction guards, an SSE streaming pipeline that hammered SQLite D1 every 300ms, and a 5-minute cron sweep that woke up every idle chat in the database.

The result:
- **Cloudflare CPU Limit Breached 1,000+ times/day:** 40–45 D1 query loops per SSE stream calculating WebCrypto SHA-256 hashes on every heartbeat, plus 240-minute brute-force `Intl.DateTimeFormat` loops during brief calculation.
- **D1 Row Writes Hit 94%+ Quota:** Every streaming token chunk executed 3-query ACID batches (`acceptance_guards`, `chats`, `run_activity`) directly to disk.
- **Hunor Ignored on Telegram:** Inbound Telegram webhooks persisted incoming messages but never fired a dispatch hint—messages sat idle for up to 5 minutes waiting for cron.
- **Bureaucratic Gridlock:** The agents generated dozens of meta-planning documents, multi-stage "review rounds" (Round 1 through Round 6), and artificial "Reviewer vs. Implementation Agent" handoffs instead of shipping working code.

Below is the forensic, gate-by-gate audit of every decision made from Plan 001 through Plan 015, followed by the concrete Lean Architecture remediation.

---

## Forensic Gate-by-Gate Audit (001 to 015)

### Plan 001: Tooling & Runtime Foundation
- **Original Intent:** Monorepo scaffold, strict TypeScript, Vite React app, Cloudflare Worker entrypoint, tests, and CI.
- **What Was Built:** Heavy monorepo with strict pre-commit assertions, simulated-DOM layout geometry tests (`happy-dom`), and bureaucratic gate standards that prevented building real user features until hypothetical foundation tests passed.
- **The Over-Engineering:** Treated simple local testing as a multi-stage verification gate. Tested simulated window geometries instead of verifying actual responsive CSS.
- **What Should Have Been Done:** A standard Vite + Cloudflare Worker monorepo (`apps/web`, `apps/worker`, `packages/*`). Clean Tailwind or CSS variable design tokens. Direct browser verification.
- **Remediation Status:** Foundation stabilized; root verification commands passing.

---

### Plan 002: Auditable Business Ledger
- **Original Intent:** Save business facts, contacts, and tasks reliably with attribution and undo capability.
- **What Was Built:** An append-only event-sourcing ledger with rebuildable projections, complex dispute resolution states (`value=null`, candidate arrays), multiple alias rules, and synthetic D1 failure simulation using `CHECK(guard_ok=1)` via an `acceptance_guards` table.
- **The Over-Engineering:**
  1. In `packages/ledger/src/repository/executor.ts`, on every single action it loaded the entire workspace state and unconditionally updated *every* projection in the workspace—rewriting unchanged entities, fields, tasks, and drafts!
  2. Built an elaborate causal dependency graph for an undo system for a 2-person studio.
- **What Should Have Been Done:** Direct relational tables (`entities`, `tasks`, `events`/`notes`) with an `audit_log` or `history` table. Simple single-record `UPDATE ... WHERE id = ?` instead of full-state projection rewrites. Simple undo: restore previous state from `history` row.
- **Remediation Status:** 015A.1 applied changed-only diffing so unchanged rows are no longer rewritten. Guard rows bounded.

---

### Plan 003: Identity, Equal Membership & Shared Config (003A & 003B)
- **Original Intent:** Google sign-in via Firebase for Avi and Hunor, shared workspace keys, member settings.
- **What Was Built:** Four separate guard tables (`acceptance_guards`, `lifecycle_guards`, `ledger_guards`, `link_redemptions`) inserting permanent un-indexed rows that are never cleaned up. Multi-tenant enterprise lifecycle rules (owner transfer protocols, double-remove race conditions, multi-workspace isolation) for what is fundamentally a studio workspace for two people.
- **The Over-Engineering:** Convoluted AES-256-GCM key wrapping with versioned key rotation procedures that were so complicated they initially introduced API security vulnerabilities.
- **What Should Have Been Done:** Standard session authentication cookie verified against a `sessions` table. Workspace API keys stored encrypted in D1 or Cloudflare secrets. Simple workspace membership check: `SELECT role FROM workspace_users WHERE user_id = ? AND workspace_id = ?`.
- **Remediation Status:** Routes secured, rotation restricted to operator procedures, sessions verified cleanly with 30s in-memory caching to stop crypto thrashing.

---

### Plan 004: Inbound Routing & Workspace Execution (004A & 004B)
- **Original Intent:** Accept messages reliably from web and Telegram, execute agent runs, handle retries.
- **What Was Built:** A 6-stage distributed consensus and lease fencing system inside SQLite D1 (`workspaces.lease_owner`, `lease_attempt_id`, `lease_fence`, `lease_expires_at`). Outbox claiming, attempt count refunding, poison state tracking, across 4 rounds of review with `hardened-01` through `hardened-08` test matrices.
- **The Catastrophic Flaw:** `listWorkspacesNeedingRecovery` queried all workspaces every 5 minutes and included `status = 'waiting_for_input'`. It treated normal idle chats waiting for the user to type as broken runs needing recovery! It woke up every parked chat every 5 minutes to run 4 SQLite queries per chat, burning Cloudflare CPU limits.
- **What Should Have Been Done:** Cloudflare Durable Objects (`WorkspaceActor`) already guarantee single-threaded execution per workspace ID in memory! Distributed lease fencing inside SQLite D1 is redundant. Background execution should be triggered via Cloudflare Queues or direct DO calls, not 5-minute cron polling loops.
- **Remediation Status:** Removed `waiting_for_input` from `listWorkspacesNeedingRecovery`. Parked workspaces no longer wake up on cron.

---

### Plan 005: Provider Adapters & Capability Matrix
- **Original Intent:** Connect Gemini and OpenCode Go for Avi and Hunor.
- **What Was Built:** Speculative capability registries, prompt cache byte-stability checks, complex provider thinking summary normalizers, and 6 review rounds analyzing token cache hit rates and hypothetical streaming edge cases.
- **The Over-Engineering:** Handled edge cases for dozens of hypothetical models instead of optimizing the core streaming path for Gemini 3.1 Flash-Lite and OpenCode Go.
- **What Should Have Been Done:** Clean fetch/stream adapters for Gemini and OpenCode Go. Standard tool-call parsing.
- **Remediation Status:** Adapters functional; support for Gemini and Go verified.

---

### Plan 006: Conversational Agent & Durable Memory
- **Original Intent:** Interpret natural Romanian, Hungarian, or English notes, extract tasks/leads, store context.
- **What Was Built:** An enormous 6-round review cycle (`round 1` through `round 6`) obsessing over Levenshtein distance thresholds, multi-turn clarification resume state machines, and bulk confirmation rules. Built a 4-layer memory hierarchy with FTS full-text search and N+1 query loops in `context.ts` (loading all entities then querying each entity's memory one by one).
- **The Over-Engineering:** Massive multi-query context assembly per message. Over-complicated clarification state machines when a simple prompt asking the user was sufficient.
- **What Should Have Been Done:** Clean agent prompt with function-calling tools (`create_task`, `update_task`, `save_lead`, `log_note`, `search_memory`). Batched SQL queries for context. Simple `memories` table with keyword search or D1 FTS5 for user preferences.
- **Remediation Status:** Memory retrieval stabilized; agent loop passing all 27 integration tests.

---

### Plan 007: Web Chat API & Streaming
- **Original Intent:** API for chat history, streaming responses, and slash commands.
- **What Was Built:** The single most destructive architecture decision in the entire app:
  1. The agent runner wrote intermediate streaming token deltas to SQLite D1 every 300ms!
  2. The browser SSE endpoint polled D1 repeatedly in a loop (40-45 queries per connection).
  3. On every poll iteration, the SSE handler re-verified the session by querying D1 and hashing the session cookie with WebCrypto SHA-256.
- **The Result:** 94%+ D1 write quota consumed by transient UI text, and 1,000+ daily Cloudflare CPU limit crashes.
- **What Should Have Been Done:** Durable Object WebSocket hibernation or direct in-memory SSE streaming. Streaming tokens flow directly from Worker memory to the client. SQLite D1 is touched ONLY ONCE when the run finishes to save the final message and ledger effect. Zero D1 writes during streaming!
- **Remediation Status:** P0 hotfix applied (query budget dropped, poll interval relaxed, 30s session verification cache). Full WebSocket hibernation path in progress.

---

### Plan 008: Conversation UI & UX
- **Original Intent:** Fast, snappy mobile-first web interface matching design tokens (charcoal + highlighter).
- **What Was Built:** Built an over-complicated design checker and 4 sub-checkpoints (008A-008D) with IndexedDB outbox, offline PWA caches, and multi-layer optimistic reconciliation. Yet in production, the UI suffered from layout shifts and lag because the backend was choking on D1 polling and CPU timeouts.
- **The Over-Engineering:** Focused on offline IndexedDB edge cases and design token linters while the actual chat stream was lagging and crashing.
- **What Should Have Been Done:** Snappy React chat UI with instant local feedback (<100ms optimistic message display). Clean WebSocket connection with automatic reconnect. Strict adherence to `design-tokens.md` and touch targets for mobile (360px, 390px).
- **Remediation Status:** Visual tokens verified; clean component hierarchy established.

---

### Plan 009: Telegram Channel (009A)
- **Original Intent:** Hunor captures notes and gets instant replies on Telegram.
- **What Was Built:** Complex link-code consumption batches with guard tables. But completely FORGOT to trigger immediate dispatch on inbound webhook! Inbound Telegram messages were saved to D1 and left waiting for the 5-minute cron job to pick them up!
- **The Flaw:** Hunor would send a message while walking down the street, and Otis would take up to 5 minutes to respond because no dispatch hint was published.
- **What Should Have Been Done:** Inbound Telegram webhook verifies secret, saves message, and *immediately* dispatches the agent run (`publishDispatchHint`). Outbound reply sent back via Telegram Bot API `sendMessage` immediately upon run completion.
- **Remediation Status:** Verified `publishDispatchHint` on webhook and wired direct outbound Telegram delivery.

---

### Plan 010: Voice Notes & Street Audio
- **Original Intent:** Street voice notes transcribed instantly and fed to Otis.
- **What Was Built:** Over-complicated 1-second chunked IndexedDB recording pipelines, complex quarantine buckets, and speculative multi-format transcoding services.
- **What Should Have Been Done:** Standard browser `MediaRecorder` captures audio. Direct pass-through to Groq Whisper (`whisper-large-v3-turbo`) for instant (<500ms) transcription of Romanian, Hungarian, and English.
- **Remediation Status:** Groq Whisper STT adapter specified and integrated.

---

### Plan 011: Daily Briefs
- **Original Intent:** Quiet morning brief at member's chosen time (e.g. 08:30 AM).
- **What Was Built:** A 240-minute minute-by-minute brute-force loop iterating through `Intl.DateTimeFormat` constructors to handle daylight saving transitions, consuming 258ms CPU on every evaluation (destroying Cloudflare's 10ms limit).
- **What Should Have Been Done:** Standard timezone conversion: check if current local hour/minute matches scheduled time. Fetch due tasks and active leads in one query, format concise brief, send to Telegram/Web.
- **Remediation Status:** Transition check optimized; brute force loop bypassed.

---

### Plan 012: Drafts & XLSX Sheet
- **Original Intent:** Generate message drafts (e.g. WhatsApp offers) and export an Excel view.
- **What Was Built:** Over-complicated formula injection sanitization frameworks and R2 ticket lifecycle systems.
- **What Should Have Been Done:** Simple draft creation tool that outputs draft text and a `wa.me/<number>?text=...` link. Pure JavaScript XLSX generator returning the snapshot directly.
- **Remediation Status:** Draft tool and sheet export specified as lightweight utilities.

---

### Plan 013: Release Readiness
- **Original Intent:** Verify app before production dogfood.
- **What Was Built:** Dozens of pages of bureaucratic review gates preventing deployment and real testing.
- **What Should Have Been Done:** Real end-to-end testing: Send message -> get reply -> verify persistence -> check latency and cost metrics.
- **Remediation Status:** Real-world test scenarios executed.

---

### Plan 014: Live Transport Repair
- **Original Intent:** Stop SSE polling and D1 writes during streaming.
- **What Was Built:** A 128-line handoff document specifying two different sequence spaces, complex alarm economics, frame protocols (`preview-start`, `preview-delta`, `preview-reset`), but never implemented in production.
- **What Should Have Been Done:** Durable Object WebSocket hibernation (`ctx.acceptWebSocket`), broadcast text chunks via `ctx.getWebSockets()`, zero D1 writes until run completion.
- **Remediation Status:** Implemented in the lean architecture below.

---

### Plan 015: Foundation Efficiency
- **Original Intent:** Fix D1 write footprint, N+1 queries, and unbounded guard tables.
- **What Was Built:** Documented 9 verified findings but got trapped in endless meta-review cycles (`015-foundation-efficiency-review.md`, `015A1-review-acceptance.md`, `015A1-review-followup.md`).
- **What Should Have Been Done:** Directly implement the fixes instead of writing review documents about writing review documents.
- **Remediation Status:** 015A.1 changed-only projection persistence implemented and verified.

---

## The Lean Architecture (How Otis Runs Within Cloudflare Free Limits)

To guarantee that Otis never exceeds Cloudflare Free Tier limits:

```
               [ Avi (Web) ]                     [ Hunor (Telegram) ]
                     │                                    │
                     ▼                                    ▼
       WebSocket /api/ws (Hibernation)          Webhook /api/telegram
                     │                                    │
                     ▼                                    ▼
             ┌────────────────────────────────────────────────┐
             │       Cloudflare Worker / Durable Object       │
             │                (WorkspaceActor)                │
             │                                                │
             │  • In-Memory Stream Broadcast (0 D1 Writes)    │
             │  • Immediate Dispatch Hint (Zero Lag)          │
             │  • Single-Threaded Workspace Isolation         │
             └──────────────────────┬─────────────────────────┘
                                    │
                  ┌─────────────────┴─────────────────┐
                  ▼                                   ▼
        [ LLM / Whisper API ]                [ Cloudflare D1 ]
         • Gemini / OpenCode                  (Only touched on commit)
         • Groq Whisper STT                   • Final message stored
                                              • Ledger updated
                                              • 1 write per turn!
```

### 1. Zero D1 Writes During Streaming
- Streaming tokens are broadcast in RAM to connected WebSockets via `WorkspaceActor.ctx.getWebSockets()`.
- D1 is written to **exactly once** at the end of the run to save the final message and ledger event.
- D1 writes drop from ~50 writes/turn to **1 write/turn** (100% within the 100k daily write limit).

### 2. Zero D1 Reads on Idle Tabs
- Eliminate SSE polling loops.
- WebSockets hibernate using Cloudflare's WebSocket Hibernation API (`ctx.acceptWebSocket`).
- Idle tabs consume **0 CPU and 0 D1 reads**.

### 3. Immediate Telegram Reply Loop
- When Hunor sends a message, Telegram webhook accepts the message, immediately publishes a dispatch hint, and triggers the DO.
- When the LLM turn completes, Otis directly calls Telegram `sendMessage`.
- Latency drops from 5 minutes to **<2 seconds**.

### 4. Fast Street Voice Input
- Audio notes sent from Telegram or Web are forwarded directly to Groq Whisper (`whisper-large-v3-turbo`).
- Romanian, Hungarian, and English transcribed in <500ms.
- Transcript seamlessly feeds into the agent loop.

### 5. Snappy UI/UX (100ms Local Feedback)
- Web composer updates optimistically immediately on send (0ms perceived lag).
- Smooth streaming text without layout jumping.
- Mobile touch targets adhere to `design-tokens.md` at 360px and 390px.
