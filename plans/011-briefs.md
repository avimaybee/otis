# Plan 011: Produce one useful morning brief per member and local day

> Executor: plans 002, 007 and 009 must pass. Read product.md sections 5.5, 7, 10, 12.4 and the time/DST rule. Selection is plain code; the model may phrase selected items but may not choose them. Check drift before work.

## Status

- Priority P1; effort M; risk medium; category scheduling/reliability; depends on 002, 007, 009.
- Planned at unversioned document snapshot, 2026-09-29.

## Why and current state

The product's daily habit depends on a short, actionable brief: due work, promised deliverables and stale warm leads. It must not send noise, duplicate across web and Telegram, rely on disputed facts, or fire twice at a daylight-saving change. The ledger and chat channels exist after dependencies; scheduler behavior does not.

## Scope

Modify brief/stale-sweep migrations and services, scheduled Worker entrypoint, web chat/Telegram delivery adapters, configuration and tests. Do not build a dashboard, push notification system, email, new proactive triggers, or autonomous lead messaging. Keep v1 kind morning only.

## Selection contract

Every five minutes, find member schedules whose local time reached brief_time (default 09:00) using workspace_users.timezone or workspace timezone, both IANA. Store instants UTC. For nonexistent local time on spring-forward day choose next valid local instant; on repeated fall-back time choose first occurrence. Generate at most one row for (workspace,user,local_date,morning) using a unique constraint and stable derived idempotency key. Build the candidate set: promised deliverables with explicit due date/reason_key=promise; other open tasks due/overdue for that member; warm/hot leads whose confirmed last contact is older than a workspace stale-day threshold that starts at four and can be changed conversationally and have no equivalent open follow-up. Skip snoozed tasks until snoozed_until, completed/cancelled tasks, and facts needed for a candidate when disputed. Unassigned system task must be clarified rather than notified to everyone; member-created task defaults to its creator. Rank promised work first, then due tasks, then stale leads, with stable ties and at most five distinct items. If none qualifies, store no outward notification; web may answer “Nothing due today.”

Persist the canonical brief and show it as a message in that member's web chat. workspace_users.brief_delivery chooses one outward channel: web default, Telegram only when linked and explicitly selected, or none. Web viewing the same brief is not another push. Store delivery status and provider message ID. A known failure retries with the same brief ID. Telegram send timeout with unknown outcome must be marked uncertain and investigated/reconciled; never blindly send another copy. A member can respond “I did the first one” and the agent maps that reference to the saved brief item.

The nightly stale sweep checks for an existing open task by (workspace,entity,reason_key) before creating a task. It must not create a new reminder each night for an already-open reason; a changed due date or later contact is handled through ledger events, not duplicate inserts.

## Proposed file map and verification commands

These paths are targets to create or extend; the repository has no source files at planning time. In scope: migrations/0006_briefs.sql; apps/worker/src/jobs/brief.ts, staleSweep.ts; packages/brief/src/select.ts, time.ts, delivery.ts; packages/brief/test/select.test.ts, time.test.ts; apps/worker/test/brief.integration.test.ts. Add packages/brief to the workspace manifest.

Verification after plan 001 establishes the scripts: pnpm typecheck; pnpm lint; pnpm test; pnpm build. Run timezone/DST and duplicate-cron integration cases with injected clock. Do not report a command as passed if it has not run. If a proposed path conflicts with the scaffold, preserve the module boundary and document the exact mapping before editing. Do not push or open a PR unless the operator asks.

## Steps and verification

1. Implement pure local-date and candidate-selection functions with injected clock. Test multiple timezones, midnight, spring-forward, fall-back, null brief time, snoozed tasks, disputed value, and identical rank ties. Verify pnpm test.
2. Add unique brief persistence and due-member scheduler. Execute the same cron tick twice and from two simulated instances; verify one stored brief per key and zero notifications when no items.
3. Add web/Telegram delivery state machine and reply reference mapping. Verify web default, Telegram selected, no double-send across channels, known failure retry, unknown Telegram outcome quarantine, and “first one” targeting the exact saved item.
4. Add stale-sweep dedupe and integration tests with two members changing the same lead; rebuild ledger state and verify one open task for a reason. Run root typecheck, lint, tests, build.

## Done criteria

The brief is deterministic from ledger state and never includes more than five distinct items. Cron repetition and DST do not duplicate it. A disputed current fact cannot silently affect a recommendation. The only model responsibility is concise wording for already-selected items. A user's brief reply resolves against the saved brief, not a fresh query.

## STOP conditions and maintenance

Stop if delivery code cannot distinguish known failure from unknown outcome, if a provider send is marked successful before an ID is recorded, or if selected items cannot be explained from specific events/tasks. Future proactive triggers require a new kind and new selection tests; do not overload morning.
