# Plan 001: Establish a runnable Cloudflare and React workspace

> Executor: this repository currently has no code or Git history. Read product.md sections 0, 6, 7, 15 and Appendix B plus design.md before work. Do not invent product features while scaffolding. Initialize Git as part of the foundation, preserve the existing documents, and record the first reviewed baseline commit when this plan passes.

## Status

- Status: DONE.
- Priority P0; effort M; risk medium; category foundation/DX; depends on none.
- Planned at unversioned document snapshot, 2026-09-29. Drift check: Get-FileHash product.md,design.md -Algorithm SHA256 and compare with plans/README.md. Stop on material specification drift.

## Why and current state

Only product.md and design.md exist. There is no build, test, lint, typecheck, migration, or local Worker command. Node v24.16.0 and pnpm v11.10.0 were available on the planning host, but the executor must verify its own runtime. Product.md Appendix B suggests a worker, web app, and packages; design.md requires one responsive conversation, not a dashboard. Cloudflare documents a Vite/React SPA with an API Worker and static assets as a supported path.

## Scope and decisions

Create only root tool configuration, apps/worker, apps/web, packages/contracts, packages/ledger, packages/agent, packages/channels, packages/sheet, packages/design, migrations, README.md, AGENTS.md, .gitignore, .env.example, CI configuration, and narrow decision updates to product.md/design.md. Empty packages should contain a small typed entrypoint and purpose, not speculative domain logic. Do not add a second web framework, mobile app, browser automation framework, ORM-specific business schema, Google Sheets adapter, or provider keys. Use TypeScript strict mode, pnpm workspaces, React + Vite on the client, one Cloudflare Worker that serves assets and /api routes, and Wrangler bindings for D1, R2, and a SQLite-backed WorkspaceActor Durable Object. Leave real resource IDs as environment-specific placeholders.

Create root scripts with exact names: pnpm typecheck, pnpm lint, pnpm test, pnpm build, pnpm dev. Use Vitest for pure packages and Cloudflare's Workers Vitest integration for Worker integration tests. Create one meaningful pure test and one Worker route health test. Pin dependencies and commit the lockfile. Document each dependency's purpose briefly in README.md. Web UI acceptance is a hands-on review in a browser controlled by Codex or Antigravity; do not add Playwright or a test:e2e script. A production environment must use EU jurisdiction D1/R2 resources from creation; local dev uses local bindings. Do not claim that EU storage controls model-provider processing.

## Proposed file map and verification commands

These paths are targets to create or extend; the repository has no source files at planning time. In scope: Root package.json, pnpm-workspace.yaml, tsconfig.base.json, eslint.config.js, .gitignore, .env.example, wrangler.jsonc, vite.config.ts; apps/worker/src/index.ts; apps/web/src/main.tsx; packages/*/src/index.ts; README.md; AGENTS.md. If the current Cloudflare Vite template produces different config names, document the mapping in README.md.

Verification after plan 001 establishes the scripts: pnpm install --frozen-lockfile; pnpm typecheck; pnpm lint; pnpm test; pnpm build. Every command exits 0; dev and /api/health are checked separately. Then open the running app in Codex or Antigravity's browser and confirm the shell renders at mobile and desktop widths. Do not report a command as passed if it has not run. If a proposed path conflicts with the scaffold, preserve the module boundary and document the exact mapping before editing. Do not push or open a PR unless the operator asks.

## Steps and verification

1. Initialize Git, then add package manifests, pnpm workspace, TypeScript project references or equivalent strict configs, lint config, Vite/Cloudflare plugin and Wrangler config. Verify with pnpm install --frozen-lockfile after generating the lockfile, then pnpm typecheck and pnpm lint; all exit 0. No production secret is required.
2. Add a Worker /api/health endpoint returning a typed JSON object with status ok and no internal binding details. Add a React shell that renders a plain Daybook title and no invented navigation. Verify pnpm dev starts and a local GET /api/health returns 200; pnpm build exits 0.
3. Add minimal pure and Worker integration tests, root pnpm test, and CI running install/typecheck/lint/test/build. Verify all checks exit 0 locally and CI config names them.
4. Add README.md with setup, local D1 migrations, environment variable names but no values, test commands, Worker binding diagram, and links to product.md/design.md. Add AGENTS.md instructing future agents to read the plans and source docs, use workspace-scoped repositories, and run the checks. Make narrow updates to product.md/design.md for any user decisions not yet recorded there: dark default theme with Daybook-specific palette, Google sign-in for both dogfood members, workspace-shared credentials per connected provider, a workspace default model plus `/model` chat override, text reply to voice by default, full historical chat plus retained audio/transcript visibility to every current member, and durable workspace-only memory for clearly lasting preferences and context. Preserve the already documented shared slash commands and do not rewrite unrelated sections. Verify rg --files lists the created files, those decisions appear in the source docs, and no .env containing credentials is tracked.

## Test plan

The health test asserts the JSON shape and no secret leakage. The pure test proves test discovery. One browser smoke test renders the shell at 360 px without horizontal overflow.

## Done criteria

All root commands above pass. The Worker bundle build resolves static assets and API routes. There are no placeholder test scripts returning success without running tests. Git is initialized with a reviewed baseline commit; later plans use that commit and current diffs for drift checks.

## STOP conditions and maintenance

Stop if the installed Cloudflare Vite plugin cannot serve the SPA and Worker routes under one origin, if the selected runtime cannot run the Workers Vitest integration, or if creating a real Cloudflare resource is required just to pass local tests. Report the incompatibility and smallest alternative; do not add a second hosting stack silently. Future plans may add packages only for implemented behavior; do not grow an empty abstraction tree.

Official references: https://developers.cloudflare.com/workers/static-assets/ ; https://developers.cloudflare.com/workers/testing/vitest-integration/ ; https://developers.cloudflare.com/workers/wrangler/configuration/
