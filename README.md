# Otis

Otis is a mobile-first conversational business memory: record what happened, retrieve what the team knows, correct it, and act on a useful follow-up. Web and Telegram share workspace records. It is built for Kerning today without hardcoded customer or member identities.

The app includes conversational capture/recall, a sourced client dossier with individual-entry correction, multiple contact methods and reversible duplicate merging, workspace-wide search, retained photos/PDFs/audio, and explicit one-off/weekly/after-quote follow-ups. General tables adapt to available transcript width and copy as tab-separated data. Failed/partial runs expose Retry while retaining completed work. Settings provides JSON/XLSX downloads and owner-controlled workspace deletion.

Some work remains incomplete: Records manual Save needs ledger-backed repair; erasure inventory and failed media cleanup need completion; local ordering/Telegram/provider-retry work is uncommitted. Current browser/device, deployment and production-cost acceptance remain separate. [Implementation status](docs/status.md) records source presence, dated checks and open work. Package names, old DONE labels and fake-provider replies are not release evidence.

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
