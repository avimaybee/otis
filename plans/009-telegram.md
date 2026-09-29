# Plan 009: Make Telegram a complete conversational capture channel

> Executor: plans 003, 004, 006 and 007 must pass. Read product.md sections 9, 12 and design.md's Telegram translation. Telegram is a separate client of the same workspace ledger, run history and shared slash-command dispatcher, not a second source of truth. Check document drift before work.

## Status

- Priority P0; effort L; risk high; category channel/integration; depends on 003, 004, 006, 007.
- Planned at unversioned document snapshot, 2026-09-29.

## Why and current state

Hunor may capture from Telegram while walking. The bot must identify him through a linked Telegram account, select the correct workspace, accept text/voice, show concise progress and reply, and let him clarify or undo without opening web. Telegram retries webhooks and callbacks; the transport layer already dedupes. The web has detailed Working, but Telegram needs enough information to understand which writes occurred.

## Scope

Modify packages/channels/telegram, Worker webhook and send adapters, link-code endpoints from plan 003, callback/action tables if needed, and integration tests. Do not build a WhatsApp bot, monitor personal chats, or send messages to leads. Use private bot chats for v1; do not assume group messages are trusted member instructions.

## Required behavior

Verify Telegram's secret token header before processing. Normalize update ID and callback query ID for dedupe. The web app generates a 32-character base64url one-time code, stores only its hash bound to the signed-in user, expires after 10 minutes, consumes atomically on /start, and reports expired/reused links without revealing identity. The channel identity maps Telegram user ID to one Daybook user. Store per-identity active_workspace_id. One membership auto-selects; several with no valid choice prompts a workspace selection before writing. /workspace can view and switch; a web switch does not reroute Telegram.

Persist one active Daybook chat ID per `(linked Telegram identity, workspace_id)` for v1, creating that user's chat on first message in the workspace and reusing it on return. Resolve this chat after workspace routing and before command dispatch or agent invocation. `/model` changes this chat's override only; another member's chat and chats in other workspaces are untouched. The Telegram chat is visible in web history with the same source messages and attribution. If the mapped chat was removed or its author no longer has membership, invalidate the mapping and follow the normal access rule rather than silently writing into another chat.

Register `/model`, `/workspace`, `/today`, `/undo`, and `/help` through Telegram's native bot command menu, with `/sheet` added only after plan 012 works and `/start` reserved for linking. Generate names and short descriptions from plan 007's shared registry; refresh Telegram's advertised list when a feature becomes available. The bot must also accept manually typed commands, including Telegram's `/name@<this bot>` form, and use the same server parser/dispatcher and authorization as web. `/model` without an argument replies with the current Telegram chat model and available handpicked model keys; `/model <key>` changes only that member's current Daybook chat in the active workspace, and `/model default` returns it to the workspace default. If listing choices as Telegram buttons, callbacks carry an opaque server-side choice ID and revalidate current membership and availability before changing; the typed form must still work. Commands are optional shortcuts: /today reads today's saved brief/current due items without creating a second brief; /sheet is wired to a short-lived workbook URL; /undo without target chooses the latest reversible write in that member's current chat, asking if dependent later changes exist; /help explains plain-language examples. Every shortcut and callback action must also be expressible as an ordinary message. Inline Undo/Done/Draft actions carry opaque server-side IDs, not client-supplied entity values; verify identity, workspace, action scope and replay status on every callback, and answerCallbackQuery promptly. Snooze/Change ask for a date or value rather than silently choosing tomorrow. Each successful write summary says the change and exposes Undo. Escape user content for Telegram HTML parse mode. If a provider run takes time, send a truthful concise status without spamming. A photo/location update gets a plain unsupported explanation and metadata-only inbox record.

## Proposed file map and verification commands

These paths are targets to create or extend; the repository has no source files at planning time. In scope: packages/channels/src/telegram/adapter.ts, formatting.ts, callbacks.ts, commands.ts, linking.ts; apps/worker/src/routes/telegram.ts; apps/worker/test/telegram.integration.test.ts.

Verification after plan 001 establishes the scripts: pnpm typecheck; pnpm lint; pnpm test; pnpm build. Mocked Telegram API tests include duplicate webhook and callback replay; live private-bot smoke is separate. Do not report a command as passed if it has not run. If a proposed path conflicts with the scaffold, preserve the module boundary and document the exact mapping before editing. Do not push or open a PR unless the operator asks.

## Steps and verification

1. Implement link code generation/consume and private-chat identity binding. Verify tests for two users, expired code, reused code, forged code, repeated /start, revoked member and workspace selection.
2. Implement text receive/send and connect Telegram's native command menu and typed commands to the shared inbox/command dispatcher from plan 007. Verify a command chosen from Telegram's menu or typed manually yields the same authorized result as web, with no provider call; `/start` remains linking-only. Verify `/model` lists only credentialed approved choices, changes only the sender's active Daybook chat, and does not alter another member's chat or a running turn. Verify one Telegram update produces one run and one reply despite two deliveries; a linked account's action is attributed to the right Daybook user. Use mocked Telegram HTTP calls in CI.
3. Implement callback registration, validation and actions. Verify callback replay cannot double-undo/complete a task; wrong member/workspace is denied; missing date enters clarification; callbacks are acknowledged while long work is queued.
4. Add formatting and failure handling: long answer splitting within current Telegram limits, HTML escaping, send failure retry/backoff, no duplicate outward brief, and links to detailed web run where useful. Verify root checks and a live private-bot smoke with synthetic data after webhook secrets are configured.

## Done criteria

Text capture, query, clarification, correction, task update and undo work fully from Telegram. No implicit cross-workspace write. Duplicate updates/callbacks do not duplicate events. A user without a linked identity sees only linking guidance. Bot output never claims a WhatsApp draft was sent.

## STOP conditions and maintenance

Stop if linking cannot reliably bind the Telegram user ID to the intended Google account, if private-chat filtering is unclear, or if Telegram send failures could silently mark a brief delivered. Recheck API limits at implementation time. Official references: https://core.telegram.org/bots/api ; https://core.telegram.org/api/links
