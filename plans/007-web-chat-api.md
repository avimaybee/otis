# Plan 007: Chat APIs, honest streaming and shared commands

Planned against a3bd462, revised 2026-09-29. Status: TODO. Depends on 003B, 004A/004B and 006. **Chat/source/run tables already belong to 004A: extend them, do not create a second schema.**

## Status

- **Status:** DONE; independently accepted 2026-10-03 ([round 3 review](007-review-round3.md)); local evidence only. Visual acceptance explicitly deferred to Gate 008.
- **Implemented:** documented chat/activity/run/action/undo/clarification/command/model routes with the
  shared deterministic command grammar, plus the first conversation UI foundation in `apps/web`
  (design tokens, mobile conversation shell, history drawer/sidebar, composer with command picker,
  detail pane). See [implementation notes](#implementation-notes) for what is deliberately deferred.

## Outcome and reading

The browser can list/read/send, inspect Working, reconnect, answer pending questions and undo entirely through documented API responses. Teammates read history without impersonation. Web and Telegram share command grammar/authorization. Read architecture.md sections 4/9/10/12 and docs/contracts.md sections 7–10; design.md describes the consuming states.

## Scope/files

`apps/worker/src/routes/{chats,chat,activity,actions,clarifications,commands,runs}.ts`, `apps/worker/src/chat/{activity,stream,commandTurn}.ts`, `packages/contracts/src/chat.ts`, `packages/commands/src/{registry,parse,help}.ts`, `apps/web/src/{api,components,hooks}`, `packages/design/src/tokens.css`. No raw audio capture, media or export endpoints (plans 010/012), and no general dashboard API.

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

## Implementation notes

Delivered routes, all workspace-scoped with live membership recheck and CSRF on mutations:

| Route | Behaviour |
|---|---|
| `GET /api/workspaces/:id/chats/:chatId` | Chat detail plus `is_author`, which is what makes a teammate transcript read-only |
| `GET .../chats/:chatId/messages` | Ascending page with `next_before_sequence`; a malformed cursor is rejected rather than broadened |
| `GET .../chats/:chatId/activity?after=` | Catch-up page over the same persisted rows the stream reads; a cursor ahead of the chat returns `409 cursor_superseded` with `latest_cursor` |
| `GET .../chats/:chatId/activity?stream=sse&after=` | Long-lived stream of persisted rows, revalidating session and membership between polls and closing on revocation; heartbeats carry no business meaning |
| `GET /api/workspaces/:id/runs/:runId` | Authoritative run, steps, action receipts, run activity and pending clarification |
| `GET /api/workspaces/:id/actions/:actionId` | Receipt, events, revert state and attributed source message |
| `POST .../actions/:actionId/undo-preview` | Concrete affected set, dependencies and current revision |
| `POST .../actions/:actionId/undo` | Guarded ledger commit; the undo identity comes from `client_operation_id`, so a retry replays the receipt instead of reverting twice |
| `GET .../chats/:chatId/clarifications`, `GET .../clarifications/:id` | Pending questions with `answerable_by_caller` |
| `POST .../clarifications/:id/reply` | Accepts the answer as an ordinary message, then resumes the saved typed operation |
| `GET /api/commands?surface=` | One registry for both channels; `/start` is Telegram-only and `/sheet` is listed but unavailable |
| `GET /api/workspaces/:id/models?chat_id=` | Registry entries with current/default markers and honest availability |
| `POST .../chats/:chatId/commands` | Deterministic command turn: attributed member message, system reply, `command` run and public activity, with no provider call |

Design decisions worth keeping:

- A web undo is an attributed command turn in the requester's own chat, so it has a real inbound
  message and a `command` run. When `chat_id` is omitted, the requester's most recent conversation is
  used rather than writing an unattributed business event.
- `/today` and `/sheet` are parsed and acknowledged but not answered locally; they belong to the agent
  run path, so this gate does not fake their output.

Deferred to their owning gates: media upload/private streaming, exports, scheduled briefs, Telegram
command execution, and browser visual acceptance. The UI foundation in `apps/web` is deliberately the
first slice of plan 008's scope — tokens, mobile conversation composition, history navigation,
composer and detail — not the finished conversation UI; `docs/browser-review.md` stays unverified.
