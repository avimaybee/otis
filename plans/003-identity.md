# Plan 003: Identity, equal membership and shared configuration

Planned against a3bd462, revised 2026-09-29. Status: 003A DONE; 003B DONE (2026-09-30). Execute **003A before 004A/002**, then complete 003B after the shared storage contracts are integrated. This replaces the old ledger-before-identity migration assumption.

### 003B Verification Evidence (2026-09-30)

Implemented: `packages/identity` lifecycle (`removeMember`/`leaveWorkspace`/`transferOwnership` with `lifecycle_guards` CHECK batches), AES-256-GCM workspace credentials (fresh nonce, workspace/provider/version AAD, status-only reads, package-level operator rotation preserving status), shared default-model and member settings (brief stays disabled until an explicitly chosen time/timezone/weekdays/channel), `settings_audit`, migration `0004_lifecycle_settings.sql`, worker routes (invites, members, leave, transfer, settings, credentials — no rotation route), and contract DTOs. `MemberSettings.brief_weekdays` is numeric 0-6 (was an unimplemented `string[]` guess).

Root checks (after the acceptance follow-up below): `pnpm typecheck` 0, `pnpm lint` 0, `pnpm test` 117 passed / 11 files (new `lifecycle.integration.test.ts`: 15 tests covering invite issue/accept/reuse/mismatch, removal with revision/audit/Telegram deselection, removed-member 404s, in-flight write guards with zero partial commit, owner/last-member guards, single transfer + lost transfer power, concurrent double-remove serialization, write-only credentials, unknown-provider/misconfigured-key errors, package-level rotation with status preservation + AAD isolation, brief gating including explicit channel, shared model, second-workspace isolation), `pnpm build` clean dry-run. Note: C: disk full in this environment; workerd tests ran with TEMP redirected to D: (log-write ENOSPC noise only, no test impact).

### 003B acceptance follow-up (code inspection, 2026-09-30)

Three findings, all addressed in the working tree and covered by the rerun suite (now 117 passed / 11 files):

1. **Rotation was a member API route (release-blocking, fixed).** `POST /credentials/:provider/rotate` accepted old/new wrapping keys from any member and re-encrypted without coordinating with the Worker's `CREDENTIALS_KEY` secret, risking undecryptable credentials. The route and its registration are removed; `rotateCredentialWrappingKey` remains a package-level operator procedure (documented coordination: rotate D1, deploy the secret, confirm decrypt before retiring the old key). Tests now assert the route is 404 and exercise rotation at package level.
2. **Removal vs in-flight writes (fixed).** `setMemberSettings`, `setWorkspaceSettings`, `setWorkspaceCredential`, and `createInvite` now open their committing batches with a `lifecycle_guards` membership recheck; a removal landing after the route check aborts the write with `not_member` (404). Tests prove no partial commit for a removed actor.
3. **Brief channel choice (fixed).** Enabling a brief now requires all four schedule fields explicitly in the enabling request, including `brief_channel`; a carried `web` default no longer counts as a choice. Test covers schedule-minus-channel rejection.

Not re-verified here: real-browser sign-in acceptance (`docs/browser-review.md` still open) and remote deployment of these fixes.

## Outcome and context

Avi and Hunor sign in with Google via Firebase and are always attributed by stable Firebase UID. They are equal members of Kerning, can read its full history and retained audio, and cannot impersonate each other. Owner is only a protected lifecycle marker. Keys are shared per workspace/provider but never readable back.

Read product.md sections 4/12, architecture.md sections 4–5, docs/contracts.md sections 1/6, and roadmap gates I/I2. Existing apps/worker/src/index.ts has a health route and optional stub bindings; no production authentication exists.

## Scope and files

Create packages/identity with firebase.ts, session.ts, workspace.ts, membership.ts, credentials.ts and settings.ts as needed. Extend packages/contracts. Add next-unused identity migration(s), apps/worker/src/routes/auth.ts and workspaces.ts, actual middleware, a minimal web sign-in/access screen, and Workers tests. Update workspace/TypeScript references when adding a package.

Exclude self-serve workspace creation, role tiers, billing, full chat UI and provider calls beyond separately authorized validation. Bootstrap Kerning and invited accounts from secure operator configuration, not real emails in source. Do not send invitation email unless the task explicitly authorizes it; a copyable invite link is sufficient for dogfood.

## 003A: identity foundation

1. Create users, workspaces, workspace_users, membership audit, pending invites, hashed sessions/link codes, provider-setting records and the workspace revision/lease foundation. Solve initial owner-reference creation with a tested FK-safe transaction. Do not disable foreign keys.
2. Verify Firebase ID token signature/algorithm/key ID/project issuer/audience/subject/expiry. Cache public verification keys with bounded refresh. First invite acceptance uses verified email; subsequent identity uses firebase_uid. Test forged, wrong-project, expired, revoked/invalid and repeated acceptance paths.
3. Exchange token for an opaque server session; hash it in D1, enforce expiry/revocation, HttpOnly/Secure/SameSite production cookie, Origin/CSRF checks and logout. Record named lifetime configuration. No client-only authorization.
4. Introduce trusted WorkspaceContext and parameterized workspace repositories. Validate resource ownership and current membership server-side. A cached session identity is not cached permission.
5. Add minimal Google sign-in/access handling. Configure Vite envDir deliberately for public VITE_FIREBASE_* values; root .env is not automatically client-visible with apps/web as root. Never prefix private keys with VITE_.
6. Seed two synthetic workspaces/two users for tests. Local dev identity injection, if needed, must be absent from production entrypoints.

Verify 003A using actual Worker routes and D1. A valid test identity signs in once; wrong identity cannot access a workspace; logout/expiry revoke the Otis D1 session (note: Otis session revocation invalidates the server session record, not the external Google/Firebase token). Invite acceptance strictly requires a verified email and `claims.signInProvider === 'google.com'`, rejecting omitted or non-Google sign-in methods with 403. Run root checks. Record 003A completion separately so 004A and 002 can proceed.

## 003B: lifecycle and settings

1. Implement invite/accept/remove/leave/transfer with transactional guards against concurrent member changes. Others cannot remove owner; only owner initiates transfer; last member cannot disappear. Removal invalidates active Telegram workspace and denies subsequent reads/writes/files.
2. Disclose full historical chats/transcripts/retained audio to invitees. Only chat author appends; shared-state corrections from another member occur in their own chat.
3. Encrypt one credential per workspace/provider with versioned AES-GCM wrapping key in Worker secrets, fresh nonce and workspace/provider AAD. Mask status only. Test wrong-workspace decrypt, no secret in serializers/logs, rotation/re-encryption and replacement.
4. Implement shared default model and typed personal/workspace settings using contracts. Empty/unverified operator allowlist means no usable model yet, not an invented default. Chat override is later /model behavior.
5. Personal communication preferences are scoped to member/workspace. Brief starts disabled; local time must be chosen, with timezone/days/channel. No 09:00 fallback.
6. All settings/lifecycle changes have attributed audit records; these are separate from business ledger projections. Conversational tools later call these services, but cannot change credentials/membership.

## Tests and completion

Run pnpm typecheck, pnpm lint, pnpm test, pnpm build and targeted identity Worker tests. Required evidence: token rejection, UID stability, invite reuse, two-workspace access, session expiry/logout, concurrency-safe owner rules, read-only teammate boundary, removed-member denial and encrypted-key rotation/masking.

Both subgates must pass before plan 003 is DONE. Do not call actual Google/browser sign-in verified without live browser evidence. Mocked cryptographic claims alone are not a substitute for testing the verifier.

Stop and explain if the verifier/SDK requires unsupported Node facilities, keys would be stored plaintext, or lifecycle checks cannot be atomic. Routine schema/file choices are yours; no extra permission needed. Official reference: https://firebase.google.com/docs/auth/admin/verify-id-tokens
