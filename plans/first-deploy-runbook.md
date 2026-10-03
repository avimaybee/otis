# First deploy + dogfood runbook: Otis on real data

Status: TODO. Goal: a usable deployment Avi and Hunor can test with real
Kerning outreach data. This is operations, not a product gate: it changes no
product scope and re-verifies already-accepted behavior on real bindings.

## Verified starting state (2026-10-03, personal account `27580211`)

- Worker `otis` exists; last deploy 2026-09-30 ("Automatic deployment on
  upload") — current code is pre-006/007. Auto-deploy on push to main works.
- `otis-db` exists with migrations 0001–0008 applied. **0009 pending.**
- Secrets present: `CREDENTIALS_KEY`, `FIREBASE_PROJECT_ID`,
  `BOOTSTRAP_WORKSPACE_ID`, `BOOTSTRAP_WORKSPACE_NAME`,
  `BOOTSTRAP_OWNER_UID`. No `TELEGRAM_*` needed yet (gate 009 unbuilt).
- Local tree: Gates 006/007 + thinking work reviewed and green, uncommitted
  on `89fb4d8`. Repo HEAD behind is fine; the tree is what ships.
- This machine's wrangler defaults to the **client** account. Every remote
  command below must run with the personal account selected, or it will fail
  or — worse — touch client resources.

## Phase 0 — Ground rules (every phase)

1. Before any remote command: `$env:CLOUDFLARE_ACCOUNT_ID='275802114da3095a634457ef16168244'`
   and confirm with `pnpm exec wrangler whoami` (expect avimaybe7@gmail.com).
   Never run remote commands from a shell where this is in doubt.
2. Serial verification: run each phase's checks before starting the next.
   Do not batch phases.
3. `TEMP`/`TMP` to `D:\wtmp` for any workerd command (local checks only).
4. Never print secret *values*. Names and statuses only.
5. One-way doors are marked **ONE-WAY**. Everything else is reversible.

## Phase 1 — Remote schema (0009)

Why: deployed thinking/model code selects `thinking_override_json`; without
0009 every agent turn fails remotely.

1. `pnpm exec wrangler d1 migrations list otis-db --remote` — expect only
   `0009_thinking_controls.sql` pending. Stop if anything else is pending.
2. `pnpm exec wrangler d1 migrations apply otis-db --remote` — expect 2
   commands executed, status ✅. **ONE-WAY** (additive `ADD COLUMN` ×2; no
   data touched, nothing to roll back, which is exactly why it's safe).
3. Re-run the list — expect "No migrations to apply!"
4. Sanity: `SELECT name FROM sqlite_master` shows `memory_*`,
   `workspace_daily_actions` (from 0008) — proves both migrations live.

## Phase 2 — Remote configuration (no code yet)

1. Confirm secrets exist (names only): `CREDENTIALS_KEY`,
   `FIREBASE_PROJECT_ID`, `BOOTSTRAP_*`. Add any missing one as a **runtime
   secret**, never a plain variable, never build-time.
2. Set plain vars (non-sensitive, may live in `wrangler.jsonc [vars]` or the
   dashboard — pick one owner and record it here):
   - `AGENT_MAX_DAILY_ACTIONS`, `AGENT_MAX_ROUNDS_PER_RUN` — required; the
     handler refuses all inference without them. Dogfood starters: small
     explicit values (e.g. 50/day, 10/run); they are re-tunable without a
     deploy if set in the dashboard.
3. Forbid list — verify ABSENT remotely: `USE_ECHO_HANDLER=true`,
   `ENABLE_TEST_AUTH`, `TEST_JWKS`. Any of these silently replaces the real
   agent or disables auth. If present, delete before proceeding.
4. Record the Firebase project behind `FIREBASE_PROJECT_ID` and confirm the
   web app's Firebase web config matches it (else sign-in fails closed).

## Phase 3 — Commit and push (triggers auto-deploy)

1. Final local gate: `pnpm typecheck`, `pnpm lint`, `pnpm test`
   (expect 29 files / 414+ passed), `pnpm build`, `git diff --check`.
2. Review `git status`: intended set is Gates 006/007 + thinking work +
   review record. `UI-refs/`, `.dev.vars`, `eval-output/`, `*.log` must stay
   out (all ignored — verify, don't assume).
3. One commit, descriptive message naming gates + migration level. Push to
   main. **ONE-WAY in effect** (auto-deploy ships it): watch the Cloudflare
   deployment feed until the new version is live, and confirm the version
   hash differs from the Sept-30 build.
4. Rollback path: Cloudflare keeps prior worker versions — rollback is a
   dashboard action (or `wrangler rollback`). DB migrations do not roll
   back, but all of ours are additive, so old code + new columns is safe.

## Phase 4 — Post-deploy smoke (no real data yet)

1. `GET /api/health` (or root) responds; worker version is the new build.
2. Sign in as Avi via Google. Expect: workspace auto-provisions from
   `BOOTSTRAP_*` (first sign-in only, UID-gated). Verify the Kerning
   workspace exists and you are owner — via `/api/me`, never by guessing.
3. Negative checks: signed-out transcript/API returns 401; unknown workspace
   returns 404 (not 403 detail); no secret values appear in any response.
4. Stop on any red: do not proceed to real data with auth or version doubt.

## Phase 5 — Keys and Hunor (first real capability)

1. Enter the Gemini workspace key via `PUT .../credentials/gemini`, then
   `POST .../verify` (synthetic probe, no spend). Repeat for `opencode_go`
   (Go subscription key). Status endpoints must read configured/available;
   the keys themselves must never round-trip back.
2. Groq STT: **no credential route exists yet (gate 010 unbuilt). Do not
   improvise storage for the Groq key** — voice notes are not a usable input
   until 010. Text conversation is the dogfood surface.
3. Invite Hunor: generate invite → Hunor signs in with Google → accepts →
   confirm member row + full-history visibility disclosure shown.
4. Set the workspace default model (`/model` list first; pick a verified
   entry). Leave thinking at provider default initially.

## Phase 6 — Dogfood acceptance on real data (2 weeks)

Run the product's own acceptance script, not a feature tour:
- Hunor logs real visits in Romanian/Hungarian, some by voice note typed as
  text for now (recording UI is 010) — messy, real-world wording.
- Clarifications must appear for missing deadlines and inferred statuses;
  answers must resume exactly once (bulk approval commits the exact scope).
- Every applied write inspected and at least one undone per week, including
  one teammate undo from the other chat.
- `/today` checked on demand; no schedule configured yet (gates 011/012).
- Success bar (product.md): Hunor logs 5 of 7 days for two weeks unprompted;
  entity-match errors near zero; no silent wrong writes; median text-answer
  latency noted (5s target is measure-against-real-networks, not a gate).
- Track per-run cost from day one; after two weeks decide caps and the
  universal-fallback + key-entry Settings UI micro-tasks (both block smooth
  multi-workspace use but not this dogfood).

## Explicitly not usable yet (do not test as if built)

Voice-note recording, Telegram (bot + commands), scheduled briefs, `/sheet`
XLSX export, account/workspace erasure, per-workspace BYOK UI. `/sheet`
must stay hidden until 012; voice routing claims stay off until 010 proves
them. Testing these now can only produce misleading negatives.

## Risk register

- Wrong-account commands (client vs personal): mitigated by Phase 0 rule;
  impact otherwise is cross-account mutation.
- `CREDENTIALS_KEY` loss: all stored provider keys become unreadable;
  mitigation is the password-manager copy, recorded at setup.
- Shared Go/Gemini quota exhaustion across workspaces: acceptable in
  dogfood; per-workspace cost visibility (Phase 6) is the tripwire for caps.
- Auto-deploy fires on every main push: keep main green-gated (CI verify
  job), never push half-reviewed work to test "quickly."
