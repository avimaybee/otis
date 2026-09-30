# Plan 004: Durable conversations, message routing and workspace execution

Planned against a3bd462, revised 2026-09-30. Status: 004A DONE; 004B TODO. **004A requires 003A and precedes 002. 004B requires 004A, 002 and 003B.** Read architecture.md sections 5–9/12/15, docs/contracts.md states/IDs/activity and roadmap gates C/R.

## Outcome

Accepted messages survive restart and retries. An identity resolves to exactly one explicit workspace before any agent/ledger work. Messages retain deterministic acceptance order. Human clarification releases the workspace slot without losing the operation. The initial handler is a deterministic echo; this plan does not call a model.

Current Worker has a placeholder WorkspaceActor returning active and a health endpoint. Extend it deliberately rather than treating its presence as a working queue.

## Scope

apps/worker/src/inbox/{repository,normalize,reconcile}.ts, actor/WorkspaceActor.ts, routes/inbound.ts, conversation repositories/checkpoints/outbox, contracts and next migrations, Worker tests. Add Queue/Cron bindings only when their handlers exist. No transcription, general agent logic, business writes in the echo handler or unsupported-media download.

## 004A: source and conversation storage

1. Create chats, chat_messages, messages_in, system_jobs, agent_runs, run_steps, run_activity, pending_clarifications and outbox. Use states and ownership from contracts. Sources precede ledger references; plan 007 reuses this storage.
2. Assign a monotonic workspace acceptance sequence and chat activity cursor atomically. Random IDs/timestamps are not ordering primitives.
3. Implement web durable acceptance with explicit authenticated workspace/chat and author. In one transaction persist input/message/execution/outbox, then return 202 stable IDs. Retried UUID with equal owner/chat/fingerprint returns those IDs; conflicting reuse returns 409 without data leakage.
4. Normalize Telegram update ID with bot installation scope; validate webhook secret/private-chat input before admission. Unlinked or ambiguous identities stay unrouted. One membership may auto-select; web selection never alters Telegram routing.
5. Add minimal source/history repositories and echo test harness. Chat author restriction and full-member read visibility already apply. Source IDs must be verifiable by the future ledger.
6. Unsupported photo/location stores metadata only. Attached text needs explicit text-only confirmation; no partial silent processing.

Verify acceptance, same UUID retry, differing UUID payload/actor, source scope, pagination, two users/workspaces and no acknowledged input loss. Run root checks. Record 004A complete; plan 002 can now reference real source tables.

### 004A Verification Evidence (Hardened & Re-verified 2026-09-30)

- **Migration**: `migrations/0002_conversations_sources.sql` applied locally via Wrangler and verified in `cloudflare:test` workerd pool directly from disk. Includes transaction guard tables `acceptance_guards` and `link_redemptions`, and pagination index `idx_chats_pagination`.
- **Contracts**: All conversation, message, inbound, run, step, activity, clarification, outbox, and Telegram link models implemented and exported in `@otis/contracts`.
- **Channel Normalization**: `@otis/channels` tested across 7 unit tests (webhook secret fail-closed validation, private-chat gating, `/start <code>` extraction, unsupported media classification, and attached text confirmation tagging).
- **Hardened Inbound & Storage Guarantees**:
  1. *Fail-Closed Telegram Webhook*: Endpoint disables with HTTP 503 `service_unavailable` if `TELEGRAM_WEBHOOK_SECRET` is unset or empty.
  2. *Live Membership & Authorship Check for Telegram*: Inbound Telegram verifies active `workspace_users` membership and chat author; removed members are safely categorized as `unrouted` (`not_an_active_member`) with zero message or run mutations.
  3. *Atomic Single-Use Link Codes*: Enforced via `link_redemptions` table with `PRIMARY KEY (link_code_id)` and `CHECK (guard_ok = 1)` inside the atomic D1 consumption batch. Tested with simultaneous competing redemption requests via `Promise.all` backed by database primary key and check constraints; at most one transaction commits and the losing transaction fails constraints and is rejected.
  4. *Start Command Isolation & Redacted Link Code Persistence*: `/start` and `/start <code>` are processed as administrative signals prior to conversation routing regardless of whether the account is unlinked or already linked. Plaintext link codes never enter `chat_messages`, `run_activity`, or `messages_in.raw_payload` across linked, unlinked, valid, or invalid submissions.
  5. *Unambiguous Workspace Selection*: If a user has exactly one active workspace, it is auto-selected; if a user has multiple active memberships, routing does not guess—the message is stored as `unrouted` (`Multiple workspaces available; please select a workspace first`).
  6. *Storage Failure Propagation to HTTP 500*: Clean-message and link-redemption batches distinguish verified guard rejections from unexpected database/storage errors. D1 infrastructure failures rethrow so the webhook route returns HTTP 500 (`internal_error`), instructing Telegram to retry delivery rather than acknowledging an unpersisted update.
  7. *Voice Note Isolation*: Inbound voice notes are stored as `status: 'unsupported'` with retained metadata, without appending empty text turns or queuing agent runs until Gate 010.
  8. *Web Acceptance Transaction Guard*: Batches include `INSERT INTO acceptance_guards` validating active membership and chat author within SQLite; late writes after removal fail the transaction atomically.
  9. *Retry-Safe Echo Harness*: Re-checks queued status, returns recorded reply idempotently if already succeeded, guards against concurrent execution, and updates outbox rows by exact primary key (`json_extract`).
  10. *Stable Monotonic Sequence Receipts*: Web acceptance returns the exact committed `acceptance_sequence` from `messages_in`.
  11. *Lossless Composite Pagination*: Encodes `(last_activity_at, id)` from the last returned item, breaking timestamp ties with `id DESC` without dropping chats.
- **Root Checks**:
  - `pnpm typecheck`: Exit code 0.
  - `pnpm lint`: Exit code 0 (0 problems).
  - `pnpm test`: 9 test files, 66 passed tests across pure, web, and workerd integration test suites.
  - `pnpm build`: Vite production bundle + declarations + Wrangler deploy dry-run passed cleanly.

## 004B: actor and durable recovery

1. Claim the oldest eligible message using persisted lease owner/attempt/fence/expiry. Claim/renew atomically. One mutating agent turn per workspace; local processing flag is optional optimization only.
2. Add bounded execution slices/checkpoints and durable continuation outbox. Do not hold blockConcurrencyWhile across network calls or human answers. Do not rely on waitUntil alone for durability.
3. Persist logical step IDs before invoking handlers. A replay finds the receipt/checkpoint and returns it. Stale attempts/fences cannot commit business effects once model integration lands.
4. Questions store requester/chat/source/pending typed operation/missing fields/candidates/source revision, mark waiting, and release the slot. Another member can proceed. Answers revalidate state and continue without repeating completed steps.
5. Queue payloads contain scoped IDs only. Queue wake-up order is not business order. Cron recovers unsent outbox rows and expired leases. Bound retries and poison-message failures.
6. Stop cancels future steps/continuation, not prior business actions. Run and input status distinguish queued, running, waiting, partial, failure and cancellation.
7. Keep explicit outbound delivery intent/status; future Telegram cannot rely on an internal key as sendMessage idempotency. Avoid claiming exactly-once network delivery.

## Tests and completion

Use real local Workers/D1/DO integration with injected clock and deterministic handler. Fault cases: crash after acceptance before publish; duplicate/out-of-order Queue; concurrent members; actor restart; expired lease; old handler result after new fence; waiting human while teammate proceeds; canceled continuation; poison input; revoked membership.

Assert eventual processed or visible failed state and **no duplicate logical effect**, not that an at-least-once worker function was called only once. Check same source/action IDs persist across retry. Run pnpm typecheck/lint/test/build.

DONE requires both 004A and 004B evidence. Stop if the design can acknowledge input then lose it or commit after lease loss. Do not solve that by keeping an unbounded in-memory lock.

References: https://developers.cloudflare.com/queues/reference/delivery-guarantees/ ; https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
