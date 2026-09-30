# Plan 001: Foundation acceptance

Status: IMPLEMENTED; actual native-browser acceptance remains open. Current scaffold reference: a3bd462, 2026-09-29. Do not initialize Git again or replace the existing workspace.

## What exists

Strict TypeScript pnpm workspace, React/Vite shell, Worker health and placeholder WorkspaceActor, D1/R2/DO bindings, pure/Workers/component tests, CI, live web+Worker development, and Worker deploy dry-run in build. Most application packages are stubs.

The technical repair review at 1626124 ran typecheck, lint, seven tests, build and local HTTP checks successfully. Later DOM width assertions at a3bd462 are not proof of actual layout. Re-run current checks when changing code; do not reuse old results as new evidence.

## Remaining work

1. Verify a clean frozen-lockfile installation and current four root commands in the review environment.
2. Run pnpm dev; inspect the Vite origin at 360 px and desktop 1280+ using native browser controls. Verify current rendering, no horizontal overflow and zoom behavior. Do not install Playwright.
3. Record browser, viewport, commit, screenshot and observed result in docs/browser-review.md. If tooling is unavailable, leave those checks unverified; other technical work may proceed with the recorded limitation.
4. Keep README commands, dependency purposes and environment setup aligned with the actual scaffold. The latest design tokens are an implementation target for 008, not a reason to build the full UI here.
5. Update this gate only when evidence exists.

## Boundaries and verification

No ledger/auth/provider/Telegram features in this cleanup. No remote resource creation is required to prove local behavior. A configured real database ID is not proof of jurisdiction. pnpm build is a dry run, not deployment.

Commands: pnpm typecheck; pnpm lint; pnpm test; pnpm build; pnpm dev for browser review. Expected: successful commands and recorded observed browser behavior, not a placeholder script or synthetic DOM geometry.

Stop only for an actual incompatible runtime/tooling dependency or unavailable required verification surface; identify the precise limitation. Do not use the historical pre-build version of this plan to rescaffold or downgrade the repository.
