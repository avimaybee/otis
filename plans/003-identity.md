# Plan 003: Authenticate people with Firebase and enforce shared-workspace membership

> Executor: complete after plan 001; align migrations with plan 002 before merge. Read product.md sections 4, 7, 9.1, 12.1 and 12.5. Never infer the speaker from voice or message wording. Check the document hashes in plans/README.md and compare migrations before editing.

## Status

- Priority P0; effort L; risk high; category identity/security; depends on 001 and shared schema conventions from 002.
- Planned at unversioned document snapshot, 2026-09-29.

## Why and current state

The first Kerning workspace must distinguish Avi from Hunor while letting each read workspace chats. All current members have equal daily access. The creator is labelled owner, with one lifecycle exception: only the owner can transfer ownership, and no one removes the last member. Web auth uses Google via Firebase Auth; Telegram linking is later. There is no auth code, session store, or membership schema today.

## Scope

Modify packages/contracts, migrations for users/workspaces/workspace_users/channel_identities/link_codes/provider settings, apps/worker auth routes/middleware, apps/web sign-in and basic workspace selector, and related tests. Do not implement self-serve signup, payment, role tiers, or full conversation UI. Provision Kerning and the two memberships through an idempotent bootstrap invite list held in secure configuration, never hardcoded email addresses or credentials. On first Google sign-in via Firebase Auth, match a verified email claim to a pending invite, then bind the stable Firebase UID (`firebase_uid`); later identity uses `firebase_uid`, not email.

## Required behavior

The web client authenticates with Google through Firebase Auth and provides the Firebase ID token to the Worker. The Worker verifies the Firebase ID token cryptographically using Google's public JWK certs (`https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`) via Web Crypto API (verifying algorithm RS256, expiry, project audience, and issuer `https://securetoken.google.com/<FIREBASE_PROJECT_ID>`). Upon verification, issue a server-managed HttpOnly Secure SameSite session cookie. Store `firebase_uid` as the stable identity key, not display name or email. All API routes re-check membership server-side by workspace ID; chat IDs, action IDs, and R2 refs are resolved inside that scope. Teammate chats, including pre-join history and retained voice audio/transcripts, are readable by every current member; only their author can append. Disclose this at invite/join. All members may create their own chats, correct shared state from them, and see attribution. Owner-only transfer must verify the current owner and recipient membership in one transaction; removal revokes access and clears any now-invalid active Telegram workspace. The last member cannot be removed.

Member preferences (IANA timezone, locale, brief time and brief delivery) and workspace stale-day threshold need authenticated, auditable update services so a later conversational tool can change them. A workspace may store one credential for each connected provider (Gemini and OpenCode Go), shared by its members, plus one approved default model for new chats. Enforce unique `(workspace_id, provider)` credentials. Show provider/model names and masked credential status only; never return a stored raw API key. For dogfood credentials, use a versioned 256-bit AES-GCM key held in a Worker secret, a fresh random 96-bit nonce per encrypted value, authenticated associated data containing workspace ID and provider, and a documented key-rotation/re-encryption path. Do not store plaintext in D1. A member can replace a workspace provider key or shared default model; changes are audited. The later `/model` command sets a chat override, not this shared default. If this cannot be implemented safely within the chosen Cloudflare services, STOP and propose a managed secret store rather than saving plaintext.

## Proposed file map and verification commands

These paths are targets to create or extend; the repository has no source files at planning time. In scope: migrations/0002_identity.sql; packages/identity/src/firebase.ts, session.ts, workspace.ts, credentials.ts; apps/worker/src/routes/auth.ts, workspaces.ts; packages/identity/test/*.test.ts; apps/worker/test/auth.integration.test.ts. Add packages/identity to the workspace manifest if it does not exist.

Verification after plan 001 establishes the scripts: pnpm typecheck; pnpm lint; pnpm test; pnpm build. Worker integration tests must exercise actual middleware, not only pure helper functions. Do not report a command as passed if it has not run. If a proposed path conflicts with the scaffold, preserve the module boundary and document the exact mapping before editing. Do not push or open a PR unless the operator asks.

## Steps and verification

1. Add identity/membership migrations with unique `firebase_uid`, membership pair, Telegram external identity, active workspace membership constraint enforced in code, hashed one-use link code, session record, and owner reference. Verify migrations on a fresh local D1 and pnpm typecheck.
2. Implement Firebase token verification and session middleware, CSRF protection on state-changing web routes, logout and expiry. Verify Worker integration tests reject wrong audience/project, expired token, forged signature, and missing cookie, while a valid mocked identity creates or finds exactly one user.
3. Implement workspace membership and owner-transfer service. Verify tests for Avi/Hunor attribution, teammate read versus reply denial, removed-member denial, owner-transfer authorization, removal of the new former owner, and last-member protection.
4. Add per-provider workspace credential storage, an approved default model and masked reads. Verify Gemini and OpenCode Go keys coexist for one workspace, one member cannot see either raw key, a model without a configured provider key cannot become the default, logs/API JSON never contain a fixture secret, and rotation makes old ciphertext unusable. Run pnpm typecheck, lint, test, build.

## Done criteria

Every authenticated endpoint has an identity and workspace membership test. No UI-only authorization. Both Avi and Hunor can sign in with Google via Firebase Auth. User identity uses `firebase_uid`. Creator owner lifecycle invariants are transactionally enforced. A new member sees pre-join chats and retained audio/transcripts after disclosure; a removed member loses transcript/audio/action/export access immediately on the next request. Provider keys remain server-side and masked.

## STOP conditions and maintenance

Stop if Firebase token verification is only client-side, if an encryption design has no rotation story, or if equal membership rules conflict with an unplanned permission tier. Do not add administrator roles. Before real invitations, the invite flow must explicitly disclose that existing workspace chats are visible according to the user's answer recorded in plans/README.md.

Official references: https://firebase.google.com/docs/auth/admin/verify-id-tokens ; https://developers.cloudflare.com/workers/configuration/secrets/ ; https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
