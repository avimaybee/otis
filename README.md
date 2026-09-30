# Otis

A business memory you talk to. Avi and Hunor use conversation to retain Kerning's leads, contacts, promises and follow-ups.

**Current status:** foundation scaffold implemented; product features remain planned. A passing shell/build does not mean the agent, ledger, authentication or voice works yet. The real-browser foundation acceptance record is still open.

## Start here

| Read | Purpose |
|---|---|
| [product.md](product.md) | User behavior and v1 boundaries |
| [design.md](design.md) | Approved mobile/desktop composition, charcoal tokens and interaction states |
| [architecture.md](architecture.md) | Cloudflare responsibilities, state, transactions and recovery |
| [docs/contracts.md](docs/contracts.md) | Shared dates, schemas, APIs, tools and commands |
| [roadmap.md](roadmap.md) | Complete delivery sequence, scenarios and release gates |
| [plans/README.md](plans/README.md) | Assigned implementation packages and current status |
| [docs/verification.md](docs/verification.md) | What evidence each check actually proves |
| [docs/agent-handoff.md](docs/agent-handoff.md) | Start/completion templates for any implementation agent |
| [docs/decisions.md](docs/decisions.md) | Settled decisions and remaining measurements |

## Local development

Planning host: Node 24.16.0 and pnpm 11.10.0. Check the lockfile and CI versions before upgrading. Run from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm dev
```

Build first so Wrangler has the current static assets. Development starts Vite at http://localhost:5173 and Wrangler at http://localhost:8787; the Vite web origin proxies /api to Wrangler. Use the Vite URL for live UI development. The Worker origin serves the last built assets. `pnpm dev:web` and `pnpm dev:worker` are available for independent debugging.

`pnpm build` builds the web client and TypeScript declarations, then performs a Worker deploy **dry run**. It does not deploy. Local development simulates D1/R2/DO; configured remote IDs do not change that. Never run remote migrations/deployments merely to satisfy a local test.

## Packages

Existing: apps/web, apps/worker, packages/contracts, ledger, agent, channels, sheet and design. Most contain stubs. Planned identity, memory, commands and brief packages are created only in their owning gates. Architecture.md records the dependency direction.

D1 is the canonical store for business/conversation/job records. The ledger writes business state. The actor coordinates durable work. R2 stores private audio/files. Queues/Cron are planned, not yet configured features. EU resource location is a provisioning requirement to verify; it is not established by a label in a diagram.

## Secrets and client configuration

Use .env.example as a names/template reference, never as production credentials. Local Worker values may use .env or .dev.vars according to the installed Wrangler version; do not maintain conflicting copies. Private values include session/encryption secrets, Telegram token/webhook secret and provider keys. Workspace credentials will be encrypted server-side when plan 003 implements them.

Firebase client configuration uses explicitly public VITE_FIREBASE_* values. Everything prefixed VITE_ is potentially bundled for the browser. Never give a provider key that prefix. No analytics SDK is wired; only `firebase/app` and `firebase/auth` are used.

Authoritative local convention: the root `.env` (gitignored) is the single local source for web `VITE_FIREBASE_*` values, because the root Vite config sets `envDir` to the repo root. Local Worker vars live only in `.dev.vars` (gitignored), currently `ENVIRONMENT=local` and `FIREBASE_PROJECT_ID=otisauth`. Do not maintain conflicting copies. Production sets `FIREBASE_PROJECT_ID` as a Worker var/secret and bakes `VITE_*` from the build environment.

Server Firebase verification needs FIREBASE_PROJECT_ID. Exact required secrets, defaults and rotation belong in the implemented environment schema and operations report; missing required production configuration must fail explicitly.

## Migrations

There are no business SQL migrations in the foundation. After the owning gates introduce them:

```powershell
pnpm exec wrangler d1 migrations list DB --local
pnpm exec wrangler d1 migrations apply DB --local
```

Identity schema comes first, then conversation/source storage, then ledger. Plan numbers are not migration numbers. Never edit an already-applied shared migration. Remote resource commands require an explicitly chosen environment and task scope.

## Verification and dependencies

- TypeScript: strict package/interface checking.
- ESLint and typescript-eslint: source checks.
- Vite and React plugin: client development/build.
- React and React DOM: conversation UI.
- Vitest: pure and integration test runner.
- Cloudflare Workers Vitest integration: actual local Workers runtime/bindings.
- happy-dom: component DOM behavior; **not** actual browser layout.
- Wrangler: local Cloudflare runtime and Worker bundle/deploy tooling.
- concurrently: runs web and Worker development processes together.

Additional test-runner packages in the lockfile must remain compatible as a set. Pin/upgrade deliberately and explain each new dependency. No Playwright. Native browser/device evidence follows [docs/browser-review.md](docs/browser-review.md).

See [AGENTS.md](AGENTS.md) before changing implementation or shared contracts.
