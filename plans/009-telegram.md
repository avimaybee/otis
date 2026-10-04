# Plan 009: Make Telegram a complete conversational capture channel

> Executor: plans 003, 004, 006 and 007 must pass. Read product.md sections 9, 12 and design.md's Telegram translation. Telegram is a separate client of the same workspace ledger, run history and shared slash-command dispatcher, not a second source of truth. Check document drift before work.

## Status

- Priority P0; effort L; risk high; category channel/integration; depends on 003, 004, 006, 007.
- Planned against scaffold revision `a3bd462` (2026-09-29); map proposed routes to the live Worker before coding.

## Why and current state

Hunor may capture from Telegram while walking. The bot must identify him through a linked Telegram account, select the correct workspace, accept text/voice, show concise progress and reply, and let him clarify or undo without opening web. Telegram retries webhooks and callbacks; the transport layer already dedupes. The web has detailed Working, but Telegram needs enough information to understand which writes occurred.

## Scope

Field-capture acknowledgment addition (2026-10-03): distinguish durable receipt from processed work. If the current Bot API and private-chat permissions support it, evaluate a native reaction acknowledgment **only after inbound D1 acceptance**; it is transport feedback, not agent prose or proof of filing. Verify current official API behavior and supported reaction choice before enabling. Reaction failure must not lose accepted input, block model dispatch or cause duplicate runs. Provide a concise truthful progress fallback when necessary, not a second full acknowledgment after every step. Final reply and inspectable action receipts communicate filing/partial/question outcomes. Test duplicate webhook, acceptance failure, reaction failure and revoked identity separately. No unsupported reaction promise is part of core acceptance.

Modify packages/channels/telegram, Worker webhook and send adapters, link-code endpoints from plan 003, callback/action tables if needed, and integration tests. Do not build a WhatsApp bot, monitor personal chats, or send messages to leads. Use private bot chats for v1; do not assume group messages are trusted member instructions.

## Required behavior

Verify Telegram's secret token header before processing. Normalize update ID and callback query ID for dedupe. The web app generates a 32-character base64url one-time code, stores only its hash bound to the signed-in user, expires after 10 minutes, consumes atomically on /start, and reports expired/reused links without revealing identity. The channel identity maps Telegram user ID to one Otis user. Store per-identity active_workspace_id. One membership auto-selects; several with no valid choice prompts a workspace selection before writing. /workspace can view and switch; a web switch does not reroute Telegram.

Persist one active Otis chat ID per `(linked Telegram identity, workspace_id)` for v1, creating that user's chat on first message in the workspace and reusing it on return. Resolve this chat after workspace routing and before command dispatch or agent invocation. `/model` changes this chat's override only; another member's chat and chats in other workspaces are untouched. The Telegram chat is visible in web history with the same source messages and attribution. If the mapped chat was removed or its author no longer has membership, invalidate the mapping and follow the normal access rule rather than silently writing into another chat.

Register `/model`, `/workspace`, `/today`, `/undo` and `/help` through Telegram's native bot command menu, with `/sheet` added only after plan 012 works and `/start` reserved for linking. Generate names/descriptions from plan 007's shared registry; refresh Telegram's advertised list when a feature becomes available. The bot also accepts typed commands, including Telegram's `/name@<this bot>` form, through the same parser/dispatcher and authorization as web. `/model` without an argument shows the current chat model and available handpicked keys; `/model <key>` changes only the sender's current Otis chat; `/model default` clears its override. Callback model choices carry an opaque server-side ID and revalidate membership/availability; typed form remains available. Commands are optional shortcuts: `/today` reads saved brief/current due work without creating another scheduled brief; `/sheet` is an authenticated download after plan 012; `/undo` follows shared contracts, defaulting to the selected successful action and later successful writes in that same run, with “Undo only this action” as the alternative. A dependency conflict asks before commit. `/help` explains natural-language examples. Every command/callback can be expressed as ordinary conversation. Inline Undo/Done/Draft actions use opaque server IDs, verify current identity/workspace/action scope/replay status, and answerCallbackQuery promptly. Snooze/Change ask for a date or value instead of choosing tomorrow. Each successful write explains what changed and exposes Undo. Escape user content for Telegram HTML. Long work gets a truthful concise status. Unsupported photo/location retains metadata only; do not download or claim it was processed.

## Proposed file map and verification commands

Suggested implementation areas to map to the live source: Telegram private webhook/adapter, formatting, callback/command/link handling, Worker routes and integration tests. Do not duplicate shared command parsing or inbox/source schemas from plans 004A/007. Inspect actual paths before editing.

Verification after plan 001 establishes the scripts: pnpm typecheck; pnpm lint; pnpm test; pnpm build. Mocked Telegram API tests include duplicate webhook and callback replay; live private-bot smoke is separate. Do not report a command as passed if it has not run. If a proposed path conflicts with the scaffold, preserve the module boundary and document the exact mapping before editing. Do not push or open a PR unless the operator asks.

## Steps and verification

1. Implement link code generation/consume and private-chat identity binding. Verify tests for two users, expired code, reused code, forged code, repeated /start, revoked member and workspace selection.
2. Implement text receive/send and connect Telegram's native command menu and typed commands to the shared inbox/command dispatcher from plan 007. Verify a command chosen from Telegram's menu or typed manually yields the same authorized result as web, with no provider call; `/start` remains linking-only. Verify `/model` lists only credentialed approved choices, changes only the sender's active Otis chat, and does not alter another member's chat or a running turn. Duplicate webhook delivery must create one accepted input, one run and one set of ledger effects. Outbound `sendMessage` may have an unknown outcome after a lost response; represent that state and do not claim exactly-once delivery or blindly resend. A linked account's action is attributed to the right Otis user. Use mocked Telegram HTTP calls in CI.
3. Implement callback registration, validation and actions. Verify callback replay cannot double-undo/complete a task; wrong member/workspace is denied; missing date enters clarification; callbacks are acknowledged while long work is queued.
4. Add formatting and failure handling: long answer splitting within current Telegram limits, HTML escaping, send failure retry/backoff, no duplicate outward brief, and links to detailed web run where useful. Verify root checks and a live private-bot smoke with synthetic data after webhook secrets are configured.

## Done criteria

Text capture, query, clarification, correction, task update and undo work fully from Telegram. No implicit cross-workspace write. Duplicate updates/callbacks do not duplicate events. A user without a linked identity sees only linking guidance. Bot output never claims a WhatsApp draft was sent.

## STOP conditions and maintenance

Stop if linking cannot reliably bind the Telegram user ID to the intended Google account, if private-chat filtering is unclear, or if Telegram send failures could silently mark a brief delivered. Recheck API limits at implementation time. Official references: https://core.telegram.org/bots/api ; https://core.telegram.org/api/links
