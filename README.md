# Otis

A business memory you talk to. Avi and Hunor use conversation to retain Kerning's leads, contacts, promises and follow-ups.

## Current state

Documentation/source inspection baseline: **663f0b3, 2026-10-03**. The repository now contains identity/workspace lifecycle, ledger, durable actor execution, provider adapters, agent/memory, conversation APIs and a web UI with shadcn and mobile interaction work. The old foundation-only description is retired.

Recorded gate acceptance and live readiness are different. See [plans/README.md](plans/README.md) for recorded local evidence and [007 conversation repair](plans/007-conversation-repair.md) for runtime/deployed-path work. This documentation update did not rerun application checks or verify deployment.

**Current UI requirement:** Avi supplied an exact charcoal/Highlighter token baseline and reference. Recent UI commits are partial implementation, not acceptance of that baseline. Start [008A in the detailed UI handoff](plans/008-ui-implementation-handoff.md): visual authority/enforcement/Inter/stories, then optimistic conversation, scroll/keyboard/a11y and offline recovery.

## Read in this order

| Document | Purpose |
|---|---|
| [AGENTS.md](AGENTS.md) | Execution rules and preserved invariants |
| [plans/README.md](plans/README.md) | Gate status and assigned work |
| [product.md](product.md) | User behavior and v1 scope |
| [design-tokens.md](design-tokens.md) | Verbatim visual values/recipes; mandatory for UI |
| [design.md](design.md) | Interaction contract and story inventory; mandatory for UI |
| [Approved reference](docs/design/approved-reference.png) | Required reference, scaled by token section 2 |
| [architecture.md](architecture.md) | Server ownership and frontend/offline boundaries |
| [docs/contracts.md](docs/contracts.md) | Shared types, dates, states, APIs, tools and commands |
| [roadmap.md](roadmap.md) | Delivery dependencies and journeys |
| [docs/verification.md](docs/verification.md) | What evidence layers actually prove |
| [docs/agent-handoff.md](docs/agent-handoff.md) | Assignment/completion templates |
| [docs/decisions.md](docs/decisions.md) | Settled choices; don't reopen them |

Visual precedence is design-tokens.md, then the reference at its documented production scale. Interaction is design.md; business meaning is product.md; correctness is architecture/contracts. Latest user instructions take precedence. Old CSS/historical screenshots do not override the supplied token file.

## Local development

Use the repository's current toolchain and lockfile. Run from the repo root:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm dev
```

Vite serves the live web UI at http://localhost:5173 and proxies /api to local Wrangler at http://localhost:8787. The Worker origin serves the last built assets; build before inspecting it. pnpm dev:web and pnpm dev:worker run separately when needed.

pnpm build builds client/declarations and performs a Worker deployment dry run. It does not deploy. Local simulated resources are distinct from production. Do not run remote migrations/deploy to satisfy a local test.

The design checker, Storybook and PWA/local-outbox tooling in the 008 handoff are requirements to implement, not commands/features established by this update. Once introduced, record their actual scripts and results.

## Storage and modules

D1 is canonical for identity, accepted conversations, business events/projections, memory and durable runs/receipts. Ledger owns business mutations; actor coordinates execution. R2 stores private accepted media/exports. Queue wakeups and cron recovery are distinct from immediate conversational dispatch.

The approved web target uses one query cache, router, scroll owner and scoped IndexedDB drafts/outbox module. Browser state never becomes business authority. Voice gate 010 reuses that storage and composer; no parallel recorder/chat schema.

Inspect current packages/migrations before changing boundaries. Some feature packages may remain stubs. A package/binding's existence is not acceptance. Do not add unused libraries, ORM/vector infrastructure or another framework merely to match a diagram.

## Configuration and API keys

Otis uses a clean dual-tier credential architecture designed for simplicity and zero-configuration hosting on Cloudflare:

1. **Platform Keys (Cloudflare Dashboard)**: Set your provider API keys directly as Worker Secrets / Environment Variables in the Cloudflare Dashboard:
   - `GEMINI_API_KEY`: API key for Google Gemini models.
   - `OPENCODE_API_KEY` or `OPENCODE_GO_API_KEY`: API key for OpenCode Go models.
   - `GROQ_API_KEY`: API key for Groq Whisper STT voice transcription.
   These provide out-of-the-box model access across the platform without requiring complex database encryption keys. For local dev, put these keys in `.dev.vars`.

2. **Workspace BYOK (Bring Your Own Key)**: Workspaces can optionally supply their own encrypted keys in Settings if `CREDENTIALS_KEY` is configured. Workspace-level keys seamlessly take precedence over platform dashboard keys.

3. **Multi-Tenancy**: The application is built for Avi and Hunor today, but engineered cleanly for anyone to sign up with Google and use. No user IDs, names, or emails are hardcoded anywhere in the codebase.

4. **Frontend Configuration**: Root `.env` supplies public `VITE_FIREBASE_*` values for client authentication. Never use `VITE_` prefixes for private server keys.

## Architecture Philosophy & Anti-Overengineering Mandate

- **Cloudflare Free Limits First**: The entire application is architected to operate strictly within Cloudflare Free tier bounds (Worker CPU time < 10ms/req, D1 writes < 100k/day, D1 reads < 5M/day).
- **No Emulated Distributed Consensus**: D1 is an ACID SQLite database. Writes serialize atomically. Do not add artificial lease-fences, multi-phase locking tables, or redundant pre-checks that multiply D1 writes.
- **In-Memory Streaming**: Stream LLM tokens directly in-memory to the client SSE stream; commit the final response and receipts atomically to D1 in a single transaction.
- **shadcn UI with Approved Tokens**: Fast, accessible, lightweight React components tailored to `design-tokens.md` rather than sprawling custom UI frameworks.

## Migrations and verification

Migrations exist. Never edit an applied shared migration; allocate the next number after inspecting the sequence. Local work uses explicit local flags:

```powershell
pnpm exec wrangler d1 migrations list DB --local
pnpm exec wrangler d1 migrations apply DB --local
```

Implementation changes run four root checks plus targeted behavior tests. UI additionally needs implemented token enforcement, production-component stories, a11y checks and native-browser comparison at all five widths. No Playwright. happy-dom or a test named end-to-end is not browser/device proof.

Documentation changes need link, consistency and diff checks. Do not claim earlier application tests were rerun. Record exactly which browser/device/provider/deployed checks were performed and which remain unverified.
