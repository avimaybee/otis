# Operations

Use the live config/source and [implementation status](status.md). This replaces the dated deployment/preflight runbooks; their accounts, migration counts and pass totals are historical. No deployment, remote mutation, secret rotation or real outreach is authorized by a sample command here.

## Local setup

Use `pnpm install` and `pnpm dev` from the repository root. Wrangler runs on 8787; Vite on 5173 proxies `/api`. [package.json](../package.json), [vite.config.ts](../vite.config.ts) and [wrangler.jsonc](../wrangler.jsonc) own scripts/assets/bindings.

Use the placeholder [.env.example](../.env.example) only as a starting reference. Vite needs public Firebase web settings; Worker secrets belong in local Wrangler `.dev.vars` or Cloudflare runtime secrets. A root Vite env file is not proof a secret reaches Wrangler. Never prefix provider/encryption/bot keys with `VITE_` or commit real local env files.

| Runtime configuration | Purpose |
|---|---|
| `FIREBASE_PROJECT_ID` | Verified Firebase issuer/project |
| `CREDENTIALS_KEY` | Workspace credential encryption; preserve access for existing ciphertext |
| `GEMINI_API_KEY`, `OPENCODE_GO_API_KEY`/`OPENCODE_API_KEY`, `GROQ_API_KEY` | Platform conversation/STT credentials |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | Server bot transport and webhook authentication |
| `TELEGRAM_BOT_INSTALLATION_ID`, `TELEGRAM_BOT_USERNAME` | Installation dedupe identity and public link/command addressing |
| `AGENT_MAX_DAILY_ACTIONS`, `AGENT_MAX_ROUNDS_PER_RUN` | Explicit bounded inference/action budget, currently config-owned |
| Optional `BOOTSTRAP_*` | Operator-controlled initial setup; never hardcoded business authorization |

[Env](../apps/worker/src/index.ts) owns exact optional/required uses. Do not enable echo/test-auth/test transport overrides in production. Credentials and exact-route capability checks are in [providers](providers.md).

## Check a candidate

Inspect git status/history and preserve unrelated changes. Run [verification](verification.md) for the affected implementation. `pnpm build` generates `apps/web/dist`/PWA and a Worker dry-run bundle; it does not publish, apply D1 migrations, verify remote secrets or enable Images on the account.

Record candidate commit/tree, artifact/config/binding identity and current source evidence. A prior runbook's “deployed” statement cannot establish today's version.

## Remote inspection and deployment

Before a remote command, verify the selected Cloudflare account/environment and configured resources. Do not copy a historical personal/client account ID. Use `pnpm exec wrangler whoami` and the intended environment rather than guess.

Read-only checks can include `wrangler d1 migrations list otis-db --remote`, deployment/version metadata and secret names/statuses. Never print secret values or business transcripts. Inspect actual pending migrations; don't demand “only 0009” from an old report. Account-specific commands still require the correct selected target.

Applying migrations, deployment, pushes that trigger auto-deploy, destructive operations and external messages follow the user's authorization. Prepare/test the concrete candidate first. Inspect the forward [migration sequence](../migrations); do not edit an applied migration or assume a rollback bundle is compatible with a newer schema.

After an authorized deployment, confirm the exact release/bindings/schema and test signed-out access plus synthetic capture → actual reply → later retrieval. Include question/Undo/reconnect/media/chosen-brief paths and current membership loss. A dry run is not this acceptance.

## Recovery

D1 accepted input, logical steps/receipts, outbox and source records survive lost actor/Queue hints. Cron is the recovery backstop, not the normal turn start. Observe run/delivery/transcription error classes and due work using scoped safe metadata. Retrying delivery must preserve UUID/payload and existing receipts.

Provider failures can leave committed actions. Stop does not roll them back, and terminal failed-run continuation remains absent. Inspect the recorded outcome before suggesting a repeat. Telegram `outcome_unknown` is not permission to duplicate outward delivery.

Keep error visibility local and truthful. Account revocation, workspace membership loss and missing chat are different scopes. Record known purge/logout limitations in status rather than promise completed server revocation from client sign-out.

## Limits, retention and release evidence

The current [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) retain Free CPU/row bounds. Measure actual Worker/actor CPU and D1 row metadata before making an affordability claim; scans/index changes matter. [Images Free pricing](https://developers.cloudflare.com/images/pricing/) caps unique transforms; the current image loader reuses renditions and falls back to originals on failure. Images account enablement/quota and representative payload cost remain unverified in this audit.

Media cleanup code does not establish complete workspace erasure, export or backup purge. Workbook/JSON export and audited cross-store erasure remain open. A restore/rebuild drill and configured data location/backup lifecycle need actual resource evidence. R2's configured EU jurisdiction does not prove every provider/log/backup data flow is EU-only.

The documentation audit performs no remote schema/data changes, no live paid probes and no deployment. Current local results and the full list of remaining release evidence are maintained once in [status](status.md).
