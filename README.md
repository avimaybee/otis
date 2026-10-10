# Otis

Otis is a mobile-first conversational business memory: record what happened, retrieve what the team knows, correct it, and act on a useful follow-up. Web and Telegram share workspace records. It is built for Kerning today without hardcoded customer or member identities.

The app includes a durable workspace ledger, conversational capture and recall, a sourced client file, cross-chat search, retained photos/PDFs, explicit follow-ups, JSON/XLSX export and owner-controlled workspace erasure. Otis can compose general tables; wide tables can use the available transcript width and copy as tab-separated data. Some work remains incomplete: the Records page's manual Save path still needs ledger-backed repair, and live browser/device and production-cost acceptance is separate. [Implementation status](docs/status.md) is the maintained record of what exists, what was tested and what remains open. Package names, old DONE labels and fake-provider replies are not release evidence.

## Read only what the task needs

Start with [AGENTS.md](AGENTS.md), the assigned task and the relevant document below. Do not load the historical plan stack for ordinary work.

| Document | Owns |
|---|---|
| [product.md](product.md) | Product intent, behavior and boundaries |
| [architecture.md](architecture.md) | Runtime flow and technical ownership |
| [docs/contracts.md](docs/contracts.md) | Contract semantics and links to canonical code |
| [design.md](design.md) | Interaction behavior and current UI acceptance |
| [design-tokens.md](design-tokens.md) | Approved visual values and recipes |
| [docs/decisions.md](docs/decisions.md) | Settled choices and unresolved product decisions |
| [docs/verification.md](docs/verification.md) | Checks and the evidence needed for acceptance |
| [docs/providers.md](docs/providers.md) | Provider configuration, capability evidence and routing |
| [docs/operations.md](docs/operations.md) | Local setup, deployment and recovery |
| [docs/status.md](docs/status.md) | Current implementation/evidence/open gaps |
| [plans/README.md](plans/README.md) | Ordered current backlog; no duplicated status reports |

[Historical documentation](docs/archive/README.md) preserves old plans, audits, reviews and baseline specs with their original context. It is read-only evidence, not another active instruction set. The response-quality [case corpus](plans/qa/2026-10-07-agent-response-cases.md) remains a reusable acceptance input.

## Development

Use the repository package scripts from the root:

```powershell
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Development uses Vite on port 5173 and Wrangler on 8787. Build generates the web/PWA assets, checks TypeScript and bundles the Worker with `wrangler deploy --dry-run`; it does not deploy. Local Workers tests exercise real D1/DO/R2 bindings. See [operations](docs/operations.md) for runtime configuration.

`pnpm check:design` checks real source paths against the approved token file. Storybook and the `check:stories` script are not present on the current branch. The design check does not prove native-browser/device acceptance.

## Source ownership

- `apps/worker/src/index.ts`: HTTP composition, workspace actor, Queue and cron entry points.
- `apps/worker/src/inbox`, `actor`, `agent`, `chat`, `media`, `brief`: durable input, execution, context/tools, live activity, attachments/transcripts and schedules.
- `apps/web/src`: production React conversation, shadcn primitives, scoped query/router state, drafts/outbox, recording and PWA.
- `packages/contracts`, `identity`, `ledger`, `agent`, `commands`, `channels`, `brief`: shared types and domain owners.
- `migrations`: one forward SQL sequence; inspect the actual files and remote state before applying changes.
- `packages/sheet`: zero-dependency XLSX workbook generation used by the authenticated workspace export route.

Use direct functions and prepared SQL, the existing actor/Queue and shadcn components. Keep interaction feedback immediate, provider previews in memory and durable effects replay-safe. The Cloudflare Free budgets and known deviations are recorded in [architecture](architecture.md) and [status](docs/status.md); a statement count or successful build is not proof of CPU compliance.
