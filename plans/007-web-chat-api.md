# Plan 007: Chat APIs, honest streaming and shared commands

Planned against a3bd462, revised 2026-09-29. Status: TODO. Depends on 003B, 004A/004B and 006. **Chat/source/run tables already belong to 004A: extend them, do not create a second schema.**

## Outcome and reading

The browser can list/read/send, inspect Working, reconnect, answer pending questions and undo entirely through documented API responses. Teammates read history without impersonation. Web and Telegram share command grammar/authorization. Read architecture.md sections 4/9/10/12 and docs/contracts.md sections 7–10; design.md describes the consuming states.

## Scope/files

apps/worker/src/routes/{chats,activity,actions,commands}.ts, chat/{repository,stream}.ts, packages/contracts/src/chat.ts, new packages/commands/src/{registry,parse,execute}.ts, Workers API tests and necessary additive migrations. No full UI, raw audio capture or general dashboard API.

## Implementation steps

1. Freeze runtime DTO schemas for routes in contracts. Implement paginated chat/transcript reads and member/author enforcement with stable cursors. Resource lookup includes workspace; rejected IDs do not leak other workspace existence.
2. Reuse 004A message acceptance and stable client UUID. Expose 202 message/run IDs; retry returns same receipt only for identical scoped payload. Do not introduce another dedupe path in the web router.
3. Persist public activity before SSE delivery with a per-chat cursor. Coalesce text chunks, replay after disconnect, handle expired cursor with explicit resync, and fetch authoritative final message/status. High-frequency token events must not create unbounded D1 writes.
4. Revalidate long-lived stream membership/session and close invalid subscribers. Read-only teammate streams contain public activity, not hidden prompts, secret fields or opaque protocol continuation.
5. Add action detail, from_here/single undo preview and atomic commit. Preview includes exact affected IDs/effects/dependencies/revision. A stale preview is revalidated, not blindly committed. Attribute teammate-requested undo from the requester's own chat.
6. Add run stop/status and pending clarification shortcut. Normal POST messages remains sufficient for answering. A new unrelated message must not accidentally satisfy an older clarification.
7. Implement shared registry/parser/dispatch for /model, /workspace, /today, /undo, /help and feature-gated /sheet. First-token exact recognition, Telegram @thisbot suffix, // escape, unknown-command help; no LLM required for parsing.
8. /model lists handpicked configured keys, sets/clears only the author's chat override and reports voice support. Accepted command order determines future run selection; in-flight model snapshot remains fixed. Missing key/unavailable/retired model asks for another selection, never silent substitution.
9. /workspace switches surface selection without moving historical messages or affecting Telegram from web. /today works with no schedule and does not generate duplicate notification. All commands are attributed durable turns with command-kind execution.
10. Add memory source links, partial-failure DTO and consistent safe errors. Nothing in UI needs to infer saved state from prose.

## Required tests

Two users reading pre-join/team history; send denied to teammate; wrong-workspace IDs; removed member on transcript/stream/action; UUID collision; pagination boundaries; cursor disconnect/resume; duplicate event suppression; stale undo preview; group dependency; provider error after one committed step.

Command tests: no-arg /model, unique key/default, unconfigured/retired key, literal //, wrong bot suffix, unknown command, repeat input, channel-isolated /workspace, schedule-free /today and hidden /sheet. Verify no provider call for deterministic commands and independent models for separate members/chats.

## Evidence and boundaries

Run pnpm typecheck, pnpm lint, pnpm test, pnpm build and targeted actual Worker routes. API contracts must let plan 008 render every state without inventing a second state store. Browser visual acceptance belongs to 008, not this API test.

Stop for missing durable stream reconstruction, impossible attribution or an unsafe cross-workspace read. Fix routine integration mismatches within this scope; surface material contract changes with their consumers.
