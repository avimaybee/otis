> Historical record, archived 2026-10-07 from `plans/2026-10-04-release-preflight.md`. Its claims apply to the original baseline. Use [current implementation status](../../status.md) for active work; old proposals and DONE labels are not current authority.

# Current release preflight — reviewed working tree, production unverified

Reviewer-authored 2026-10-04 against HEAD `663f0b3` plus the preserved dirty tree. This supersedes the executable instructions and old state assumptions in `first-deploy-runbook.md`. It prepares a release; it does not authorize commit, push, deployment, secret changes, webhook changes or remote migrations.

## Current evidence

### Update after runtime repair review, 2026-10-04

The final local runtime repair suite records645 tests/45 files passed; reviewer targeted reruns passed adapter24, transcript24 and chat API53. See `qa/2026-10-04-antigravity-review.md` for scope, prior failing runs and current local verdict. This supersedes the older633/45 count below for the current repaired tree, without retroactively accepting every unrelated dirty file.

Read-only production inspection selected personal account275802114da3095a634457ef16168244 and databaseotis-db. `wrangler d1 migrations list otis-db --remote` returned pending `0010_outbox_retry_at.sql` and `0011_link_workspace_intent.sql`. Neither was applied. Public HTML references `index-B5Bs5flU.js`; that fetched bundle does not contain the new Partial response — stopped label, consistent with the repair remaining unpublished. This asset observation is not a verified backend version identifier.

Current tree has173 status entries (modified/deleted/untracked combined), so releasing all changes requires a deliberate combined candidate review; a narrow repair verdict does not authorize staging the entire tree. Browser QA reports and screenshots now exist, but demonstrated deployed memory completion failed. The repaired build needs the specific `qa/runtime-repair-browser-retest.md` acceptance journey after release. Supported interactive browser tools remain unavailable in this reviewer session; Antigravity owns that retest.

009A is accepted locally in `009A-review-acceptance.md`. Independent root verification passed 633 tests / 45 files, typecheck, lint and Wrangler build dry-run. The dirty tree also includes earlier UI, transport containment and ledger-efficiency changes. Do not equate acceptance of 009A with independent acceptance of every file in that larger tree.

The user confirms that pushing the connected branch automatically deploys to Cloudflare. Antigravity is now responsible for hands-on QA of the currently deployed app. Its report and the deployed build identity are not yet available. No current remote migration/configuration state has been verified by this preflight. Historical remote state in the old runbook is not current evidence.

## 1. Freeze the candidate and identify what will ship

Reviewer inspection of the two pending migration files confirms each is a single nullable additive column:0010 adds `outbox.next_retry_at TEXT`;0011 adds `link_codes.requested_workspace_id TEXT`. Current Telegram delivery source selects/updates the former, and current link issuance/redemption source inserts/reads the latter. A combined release therefore must not deploy those code paths before the columns exist. The inspected files have no drop/delete/backfill statement; this does not waive prior-version rollback compatibility checks.

Current ignore rules cover node_modules, dist/dist-client/dist-worker, Storybook output, Wrangler data, `.dev.vars` variants, common `.env` files and logs. Actual untracked status still includes root `qa_screenshot_test.png` and `qa_screenshots/` with17 browser captures. Preserve these artifacts locally, but exclude them from a source release unless the reviewer explicitly selects sanitized evidence for versioning. Do not use `git add .`; new production source imports and migrations must be selected deliberately. No ignored secret values were inspected or copied in this release-boundary check.

- Inspect `git status --short`, `git diff --stat`, tracked diffs and intended untracked source/tests/migrations. A plain diff omits untracked files. Do not stage everything indiscriminately.
- Preserve unrelated user work. Do not silently omit new production imports or migrations needed by the release.
- Review the combined candidate, including root build configuration, package lockfile, worker entrypoints and PWA packaging. Record HEAD and the final release commit if a release is authorized later.
- Keep `.dev.vars`, environment files, raw logs, credentials, generated build directories and private QA data out of commits. Inspect ignore behavior rather than assuming a file is ignored. Screenshots/reports must contain no cookies, API keys, one-time link codes or private customer data.
- Record relevant outstanding browser/contract limitations from 008 and production findings from Antigravity. A passing local suite does not waive them.

## 2. Remote schema — inspect before changing

Only with the correct account established, inspect the actual remote migration list. The old runbook warns this machine may default to a client account; select and verify the intended personal account before any remote command. Do not print authentication tokens.

Candidate migration files now include:

| File | Required local behavior | Change |
| --- | --- | --- |
| `0009_thinking_controls.sql` | Persisted/pinned thinking configuration | Existing migration; inspect actual file and remote applied state |
| `0010_outbox_retry_at.sql` | Telegram flood-control retry eligibility and delivery continuation | Adds nullable `outbox.next_retry_at` |
| `0011_link_workspace_intent.sql` | Guided link redemption into the chosen workspace | Adds nullable `link_codes.requested_workspace_id` |

Do not assume these three are all pending or that earlier migrations are applied. Check every migration through the candidate level against remote state. `pnpm exec wrangler d1 migrations list otis-db --remote` is the existing inspection command; applying migrations is a separate authorized mutation. Do not run apply merely because this document names it.

An authorized release must apply necessary additive schema before code that queries it is deployed. Stop for unexpected migration history, target database/account mismatch or an unreviewed migration. Schema compatibility for rolling back code must be assessed against the actual prior deployed version; 'additive' alone is not proof the whole release rollback is safe.

## 3. Runtime, frontend build and bindings

Inspect deployed configuration without exposing values:

- Runtime Firebase project must match the frontend Firebase build configuration. Vite values belong to the frontend build environment; setting only runtime values does not rebuild the client bundle.
- `CREDENTIALS_KEY` must be the correct existing wrapping key. Never replace it casually: existing encrypted workspace credentials depend on it.
- Bootstrap identity/workspace settings must still target the intended Kerning account. Do not recreate or reset an existing workspace to pass a smoke test.
- `AGENT_MAX_DAILY_ACTIONS=200` and `AGENT_MAX_ROUNDS_PER_RUN=20` currently belong to `wrangler.jsonc`; verify the actual deployed candidate resolves these vars. This records the current source, not a new budget decision.
- Ensure production does not enable `USE_ECHO_HANDLER`, `ENABLE_TEST_AUTH`, `TEST_JWKS` or synthetic transport/handler injection. A mock reply is not a successful production model turn.
- Existing bindings must target the intended D1 database, private R2 storage, `WORKSPACE_ACTOR`, and `DISPATCH_QUEUE` on `otis-dispatch`. Verify that the queue consumer and cron are actually registered, not merely that a producer binding exists. Immediate dispatch/continuation is the normal path; five-minute cron is recovery.

Telegram text additionally needs the correct runtime `TELEGRAM_BOT_TOKEN` secret, `TELEGRAM_WEBHOOK_SECRET` secret, public `TELEGRAM_BOT_USERNAME` and stable installation identity. Source defaults installation identity to `otis_bot`; do not casually change an existing identity because it namespaces inbound deduplication. Never put the bot token in source, a frontend variable, a screenshot or command output.

The inbound endpoint is `/api/inbound/telegram`; the server checks `x-telegram-bot-api-secret-token`. Actual webhook registration and bot metadata must be verified separately, through authorized operations. This plan does not register a webhook, consume a link or send a Telegram message. Provider verification may invoke a real synthetic provider request; do not call it 'no spend' or assume free capacity from a passing mock.

## 4. Local release checks and approval

For a changed release candidate run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` and `git diff --check`. Use TEMP/TMP `D:\wtmp` where necessary. `pnpm build` ends in Wrangler **dry-run**; `pnpm deploy` and a push are different actions.

Do not rerun the entire suite repeatedly when the candidate has not changed. Latest independent 633/45 evidence remains valid only for that reviewed tree. Add browser QA for changed interactions, using the approved visual references and real app behavior. The supported browser control currently unavailable to Codex is not proof QA happened; use Antigravity's actual report and inspect its evidence.

When release is ready, present the concrete candidate scope, schema/configuration readiness, unresolved limitations and rollback path for any required final approval. Do not push to get a convenient preview.

## 5. Post-deploy acceptance — actual app, not fixtures

Record the deployed version from Cloudflare deployment evidence and compare it to the authorized release commit. Current `/api/health` returns only status and timestamp: it proves basic reachability, **not** build identity, database readiness, queue delivery or model availability. No new version service is required just for this checklist.

Run through the existing signed-in browser:

1. Confirm Kerning membership and open a clearly labelled synthetic QA chat.
2. Send an ordinary message and receive a real selected-model reply without waiting for cron. Measure observed latency; do not promise a fixed provider time.
3. Save an explicit synthetic fact, query it in a later turn and reload. Verify correct author/workspace, persistence and no duplicate effects.
4. Change chat model/thinking through the supported controls/commands; verify confirmed state and its effect on the next accepted turn. Restore reversible settings.
5. Check streaming, follow-up during work, Stop, scroll, retry and understandable failure states. Test required mobile widths; emulation does not prove real iPhone recording.
6. Verify sign-out/unauthorized access behaves correctly without leaking workspace existence or private data. Do not expose session values in evidence.
7. If Telegram is explicitly authorized for live QA, test the guided Connect → Open Telegram → Start → confirmed connection and a synthetic private text capture/retrieval. This is a separate external-action test, not implied by local fake transports. Unknown sends must not be blindly resent.
8. Confirm an idle open app produces no read-side D1 write loop. Record actual available usage evidence; no percentage-saving claim from statement counts or a short visual test. Full 014 web push remains unimplemented and must not be advertised as deployed.

An offline shell exists locally, but the current `apps/web/src/pwa.ts` intentionally sets `PWA_MANIFEST=false`. Do not claim installability from the service-worker build. Check update/stale-cache behavior after deployment without clearing private user drafts.

## Exit condition

Production acceptance requires the actual deployed build to complete the above scoped journeys with recorded browser evidence, correct bindings/schema and no unresolved data-loss, privacy or missing-reply blocker. Voice, chosen-time briefs, complete Telegram callbacks and other unfinished plans remain unfinished. No automatic full-project DONE status follows from this preflight.
