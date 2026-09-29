# Plan 004: Accept each inbound message once and route it to one workspace

> Executor: plans 002 and 003 must pass. Read product.md sections 6.1, 7, 9.1, 12.1 and 12.4. This plan builds transport and durable sequencing, not natural-language interpretation. Check source-document hashes from plans/README.md and inspect live migrations before work.

## Status

- Priority P0; effort L; risk high; category correctness/reliability; depends on 002, 003.
- Planned at unversioned document snapshot, 2026-09-29.

## Why and current state

Web retries and Telegram webhook retries must not duplicate a note, task, or answer. The product requires globally unique (channel, external_id), a nullable workspace until routing, and one serial workspace actor. Cloudflare Queues are at-least-once, not exactly-once; Durable Object requests can interleave around external I/O. A webhook must acknowledge only after a durable inbox write or queue handoff. No transport code exists yet.

## Scope

Modify messages_in migration and repository, packages/contracts normalized input types, apps/worker web and Telegram receive endpoints, queue consumer, WorkspaceActor, and integration tests. Do not call an LLM, transcribe audio, or produce a business write. A temporary deterministic echo handler is allowed for transport tests, then removed by plan 006. Do not store unsupported photo/location payloads.

## Contract

Normalized input includes channel, external ID, authenticated or verified external actor ID, kind, source timestamp, text or media metadata, and optional web chat/workspace ID. Web external ID is a UUID generated once by the client and reused on retry; Telegram external ID is the update ID. The D1 inbox has unique (channel, external_id), status unrouted/queued/processed/unsupported/failed as in product.md, nullable user/workspace until routing, a separate short processing lease/attempt count, timestamps, and a bounded error code. Do not put raw provider keys or full voice data in the inbox. Routing validates the verified identity, active Telegram workspace membership or authenticated web route/chat membership, and message author. With multiple memberships and no valid Telegram active workspace, save unrouted, send one workspace-choice question, and make no agent call. One membership can auto-select. A web workspace switch never changes Telegram's active workspace.

After durable insert, enqueue or signal the workspace actor. Add a scheduled reconciliation pass for queued/failed-retryable inbox rows, because a crash after insert but before handoff must not strand messages. The actor claims the next message in deterministic receive/ID order, records progress in agent_runs/activity, and makes the handler idempotent by source message/action IDs. Use a short local claim/transaction; do not hold a Durable Object concurrency block across model/network calls. A restart replays uncompleted inbox rows, with no duplicate business event. Poison messages move to failed with an inspectable reason and bounded retry/backoff. If a Telegram callback or unsupported attachment arrives, normalize and route it through the same dedupe/auth boundary.

## Proposed file map and verification commands

These paths are targets to create or extend; the repository has no source files at planning time. In scope: migrations/0003_inbox.sql; apps/worker/src/routes/inbound.ts; apps/worker/src/inbox/repository.ts, normalize.ts, reconcile.ts; apps/worker/src/actor/WorkspaceActor.ts; apps/worker/test/inbound.integration.test.ts and actor.integration.test.ts.

Verification after plan 001 establishes the scripts: pnpm typecheck; pnpm lint; pnpm test; pnpm build. A fault-injection integration test must cover crash after D1 insert and before actor signal. Do not report a command as passed if it has not run. If a proposed path conflicts with the scaffold, preserve the module boundary and document the exact mapping before editing. Do not push or open a PR unless the operator asks.

## Steps and verification

1. Add inbox schema and pure normalization/routing functions. Verify pnpm test runs cases for duplicate Telegram update, duplicate web UUID, unknown identity, removed member, one versus two workspaces, and invalid active workspace.
2. Add receive endpoints. Verify a valid web submission and a verified Telegram webhook return acceptance only after durable storage; invalid Telegram secret is rejected; repeated external IDs return the existing message ID. Use Worker integration tests with mocked bindings.
3. Add queue/actor dispatch and recovery scanner. Simulate failure after inbox insert, actor restart, out-of-order queue delivery, duplicate queue delivery, and two members writing concurrently; verify each message reaches the echo handler once in per-workspace order and no workspace leaks data to another.
4. Add status queries for clients and structured logs keyed by message/run ID with redacted content. Verify retry counts and processing status are inspectable without exposing message bodies or keys in logs. Run root typecheck, lint, tests, build.

## Done criteria

No inbound request can reach an agent or ledger before identity and workspace membership resolution. Acknowledged messages survive restart and are eventually processed or visibly failed. Unique (channel, external_id) is enforced in D1. Unsupported photo/location input is metadata-only and gets an honest unsupported reply. The web and Telegram paths share dedupe semantics without sharing active-workspace state.

## STOP conditions and maintenance

Stop if a chosen queue/actor design can acknowledge then lose a message, if D1 and actor status cannot recover after a crash, or if serial order requires blocking an actor over long external I/O without a durable retry plan. Document and test the chosen recovery invariant. Review Cloudflare's at-least-once and DO concurrency guidance before finalizing implementation: https://developers.cloudflare.com/queues/reference/delivery-guarantees/ and https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
