# Daybook

> A business memory you talk to. Tell it what happened by text or voice note. It keeps the books, keeps your spreadsheet current, and tells you each morning who to contact and why.

- **Product & Business Source of Truth:** [product.md](product.md)
- **Visual & Interaction Design Guide:** [design.md](design.md)
- **Implementation Plans:** [plans/README.md](plans/README.md)

---

## Architecture & Worker Bindings

```text
               ┌───────────────────────────────────────┐
               │    Cloudflare Worker (apps/worker)     │
               │   API router (/api/*) & Static Assets │
               └───────────────────┬───────────────────┘
                                   │
      ┌────────────────────────────┼────────────────────────────┐
      ▼                            ▼                            ▼
┌──────────────┐          ┌─────────────────┐          ┌─────────────────┐
│  D1Database  │          │    R2Bucket     │          │ Durable Object  │
│   binding:   │          │    binding:     │          │    binding:     │
│     "DB"     │          │    "STORAGE"    │          │"WORKSPACE_ACTOR"│
│ (Local / EU) │          │  (Local / EU)   │          │ (Serial Queue)  │
└──────────────┘          └─────────────────┘          └─────────────────┘
*Note: EU jurisdiction for D1 and R2 is a production deployment requirement.
Local development uses local Miniflare/SQLite bindings with placeholder IDs.
```

---

## Workspace Structure

- `apps/worker`: Cloudflare Worker handling `/api` routes and `WorkspaceActor` Durable Object.
- `apps/web`: React + Vite SPA with mobile-first conversational shell.
- `packages/contracts`: Shared TypeScript types, API contracts, and DTOs.
- `packages/ledger`: Append-only event ledger and state projection reducers.
- `packages/agent`: Tool definitions, context assembly, and model provider integrations.
- `packages/channels`: Channel normalization and adapters (Telegram, Web).
- `packages/sheet`: Generated XLSX workbook exporter and future Google Sheets adapter.
- `packages/design`: Design tokens, typography scales, and UI constants.
- `migrations`: Monotonic D1 SQL migrations.

---

## Prerequisites

- **Node.js:** v24.16.0+
- **pnpm:** v11.10.0+
- **Cloudflare Wrangler:** installed via pnpm devDependencies

---

## Setup & Verification

1. **Install dependencies:**
   ```bash
   pnpm install --frozen-lockfile
   ```

2. **Verify type safety:**
   ```bash
   pnpm typecheck
   ```

3. **Verify code quality:**
   ```bash
   pnpm lint
   ```

4. **Run test suite:**
   ```bash
   pnpm test
   ```

5. **Build client and packages:**
   ```bash
   pnpm build
   ```

6. **Start local development server:**
   ```bash
   pnpm dev
   ```

---

## Local D1 Database Migrations

Apply migrations to local development D1:
```bash
npx wrangler d1 migrations apply DB --local
```

List applied migrations:
```bash
npx wrangler d1 migrations list DB --local
```

---

## Environment Variables

Copy `.env.example` to `.env` for local secrets. Never commit production secrets.

- `ENVIRONMENT`: Set to `local` for development or `production` for deployed workers.
- `SESSION_SECRET`: Random secret used to sign session cookies.
- `FIREBASE_PROJECT_ID`: Google Firebase project ID used by the Worker to verify Firebase ID tokens.
- `VITE_FIREBASE_API_KEY`: Client-side Firebase API key for Google sign-in.
- `VITE_FIREBASE_AUTH_DOMAIN`: Client-side Firebase auth domain (e.g. `<project-id>.firebaseapp.com`).
- `VITE_FIREBASE_PROJECT_ID`: Client-side Firebase project ID.
- `VITE_FIREBASE_APP_ID`: Client-side Firebase app ID.
- `TELEGRAM_BOT_TOKEN`: Bot token from @BotFather.
- `TELEGRAM_WEBHOOK_SECRET`: Secret token for verifying Telegram webhook updates.
- `GEMINI_API_KEY`: API key for Google Gemini provider.
- `OPENCODE_GO_API_KEY`: API key for OpenCode Go provider.
