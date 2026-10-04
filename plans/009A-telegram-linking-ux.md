# 009A addition: linking Telegram without technical steps

Reviewer: Codex, 2026-10-04. Direct user requirement: make Telegram linking extremely easy for a nontechnical person. This extends the assigned 009A checkpoint; it supersedes its minimal connection-row instructions where needed. The reviewer owns this flow/specification. Implementation agent implements it without starting another checkpoint or redesigning settings.

## The user's experience

**Connect Telegram -> Open Telegram -> tap Start -> Connected.**

No copied codes, Telegram IDs, bot-token entry, developer console, curl, special slash-command arguments, or configuration instructions for ordinary members. The operator configures the bot once; every member gets the same simple connection flow for their own account. Use the existing Settings > You area and approved Button/Alert/link/status recipes; no new page, modal, onboarding wizard or styling values.

### Disconnected

Show a personal connection row:
- Heading: Telegram.
- Supporting text: “Message Otis from Telegram. Your messages are saved in {workspaceName}.”
- Button: “Connect Telegram”.

Clicking Connect gives local feedback immediately. During the issuer request only that button changes to “Preparing link…” and disables repeat clicks. No full-screen spinner, changed composer geometry or blocked settings form.

### Link ready

Replace the same row's contents with:
- “Open Telegram, then tap Start to connect your account.”
- Primary approved button/link: “Open Telegram”. This is the returned validated t.me link, not a raw code.
- Secondary approved button: “I’ve tapped Start”. It performs a read-only status refresh, never links or marks connected itself.
- Supporting text: “This link expires in 10 minutes.” No live per-second countdown, token display or technical identifiers.

Opening the app happens on the second user gesture, after the link exists; do not wait for a network request and then call window.open, which risks a blocked popup. Use a normal explicit anchor with safe rel/target behavior for the returned deep link. Mobile can navigate to Telegram; desktop may open the native app or Telegram's normal web flow. Do not claim to detect whether the Telegram app is installed. Preserve a visible link when launching cannot be confirmed.

The open action is an external-app navigation authorized by that click, not permission for the agent to send real test messages.

### In Telegram

The generated deep link supplies /start automatically; the person taps Telegram's native Start button. Successful redemption replies concisely:

“Connected to {Otis member display name} in {workspaceName}. Send me a note whenever you’re ready.”

Use the trusted user display name and validated selected workspace, not a guessed Telegram identity. Never echo code, key, email or UID. This bot confirmation is the immediate success signal; the person can begin using the bot without returning to web.

If multiple memberships exist, this link carries the workspace the member chose on web. Store requested_workspace_id with the hashed link record (nullable for legacy records). Recheck current membership at redemption and select that exact workspace; creating the link never grants membership. Preserve legacy no-intent behavior for existing codes: one membership may auto-select, several require /workspace. Do not silently take the first workspace. The link is user-owned even though it carries routing intent; no other member can redeem it on their behalf without possession of the bearer link.

### Back in Otis

On foreground/focus or “I’ve tapped Start”, refresh connection status. On verified success show in the same row:
- “Connected to Telegram”.
- “Messages go to {actual selected workspace name}.” Do not show the currently viewed workspace as if it were the Telegram selection when they differ.
- Where safely available, show Telegram's display name/username as a display hint, not an authentication proof or clickable untrusted URL.
- Secondary button: “Disconnect”.

Do not make web refresh mandatory. Do not show Connected because the link opened, the Start button was clicked locally, or the user claimed they finished. Only the current server identity binding proves it. On later settings opens, display current binding from a read-only status request; do not generate another link.

## Failure states and exact behavior

- Link creation request fails: “Couldn’t prepare the Telegram link. Try again.” Keep the row and a Retry button. No private API details or deleted settings.
- Status check fails after opening: “Couldn’t check the connection. You can still finish in Telegram, then try again.” Retain the current valid link and “Check connection” action; do not incorrectly reset to disconnected.
- User taps check before Start: “Not connected yet. Open Telegram and tap Start.” Keep Open Telegram available; never blame the user or claim an error.
- Link expires: “This link expired. Get a new link to continue.” Button “Get a new link”. Expired /start reply: “That link expired. Return to Otis and tap Connect Telegram again.” No manual token repair.
- Existing same-user connection: show Connected immediately; a repeat /start may give the same concise confirmation without another binding or message flood on identical webhook delivery.
- Telegram account bound to a different Otis user: no silent reassignment. “This Telegram account is connected to another Otis account. Disconnect it there first, then try again.” Do not reveal that other user's name/email/workspaces. Existing current code's ON CONFLICT reassignment is not acceptable for this new guided flow; add the binding predicate to the atomic redemption guard and return a truthful conflict. Do not consume a code in a rolled-back conflicting redemption.
- Person already has a connection and wants another: existing connected row offers Disconnect and reconnect. Do not silently discard an existing connection during issuance. Do not introduce a new unique constraint or multi-account management product as part of this task; handle legacy multiple bindings explicitly if present in tests, never falsely report one disappeared.
- Bot provisioning is absent: “Telegram isn’t available yet.” Ordinary members never see secret names or fields for tokens/webhook URLs. Operator completion report identifies missing config separately. Do not leave an active Connect button that cannot work.
- Membership revoked or requested workspace gone before redemption: do not link to that workspace or disclose its data. Explain that the workspace is no longer available and ask them to reopen Otis. Do not silently reroute the code to a different business.

## Small API additions and authority

Keep `POST /api/workspaces/:workspaceId/telegram/link` from the main handoff. Its trusted workspace supplies requested_workspace_id, not a caller user ID. Mint only on explicit action. 32-char urlsafe random code, hash-only storage, single use, ten-minute expiry, no-store response. Invalidate prior unused codes for that user when explicitly generating a replacement, in the same guarded issuance batch. Never mutate codes on a GET. If adding requested_workspace_id needs a migration, inspect the current highest unapplied migration first; do not reuse someone else's number or edit an applied shared migration.

Add authenticated `GET /api/workspaces/:workspaceId/telegram/connection` using existing scope checks. Return availability, connection state and actual Telegram routing workspace name when the caller still has membership there, plus safe display labels if stored. Never return numeric Telegram IDs, link code/hash, token, another user's binding, or a workspace name the caller can no longer access. `connected` and `routing_ready` are distinct: a linked identity without a valid workspace remains linked and explains that workspace selection is needed. Do not hide it as Disconnected.

The normal case is a single binding. If existing source permits multiple own bindings, the DTO may return a bounded list of own connections and the UI may say “Telegram connected”; do not choose one arbitrary destination and claim it represents all of them. Keep implementation simple and report this legacy condition rather than inventing a new account-management screen.

Add CSRF-protected `DELETE /api/workspaces/:workspaceId/telegram/connection` for the current session user only. Connection is personal to that user's Otis account; copy must make that scope clear. Delete only that user's Telegram bindings, invalidate their unused link codes, and cancel their not-yet-started Telegram delivery rows in one guarded batch. Keep already delivered and outcome_unknown receipts/history; never delete workspace data/chats or change other members. Current membership/session checks plus server-derived user identity; owner label grants no permission to unlink someone else. Removal of an identity must be caught by the delivery-time binding checks from 009A. A send already in flight has the external boundary documented in the main handoff.

Disconnect is reversible by reconnecting, so no confirmation dialog. In-place “Disconnecting…” then “Disconnected. You can reconnect anytime.” On failure keep the verified prior state and allow retry. Do not optimistically claim server disconnection. Repeated DELETE is idempotent. Returning through an old deep link after a successful disconnect cannot relink because unused codes were invalidated.

New status/issuer/disconnect DTOs and source contract types are implementation work. Reviewer maintains architecture/plans. Safe Telegram display labels may be stored as bounded nullable metadata if needed; they never grant authority. Do not add extra metadata columns just to show a username if existing authoritative source provides none; generic Connected works.

## Bounded status refresh: avoid recreating the D1 incident

- One read on opening the personal settings connection row.
- While a just-generated link is awaiting completion and the row is visible, at most one status refresh every five seconds for at most two minutes wall-clock, maximum 24 automatic checks. Stop on connection, expiry, disconnect, unmount, sign-out or workspace change.
- Pause while the page is hidden; returning to foreground performs one coalesced refresh. No background intervals or service-worker polling.
- Manual check refreshes immediately but coalesces with an in-flight request; no concurrent focus/visibility/manual requests. Suppress stale results with the row's current workspace/request generation.
- After the two-minute automatic window, keep the valid Open Telegram and Check connection controls; do not spin again indefinitely. Focus/manual refresh stays available. Link expiry is ten minutes, not the automatic polling duration.
- Connected/disconnected idle states have no repeating timer. GET is read-only, including session verification: zero last_seen/link-code/status writes. No D1 per-second countdown.
- Deep link stays in component memory only, not localStorage/IndexedDB, URL query of Otis, analytics, screenshots or logs. No automatic code regeneration on rerender/focus/expiry.

This bounded explicit setup flow is not a reason to block the web push transport task; do not implement WebSockets or another subscription protocol solely for connection status.

## Proof for this addition

Use real workerd/D1 for issuer, status and redemption; fake Telegram HTTP for confirmations. UI tests exercise preparing/ready/waiting/connected/expired/retry/unavailable/disconnect. Link belongs to Avi while Hunor's own session/status remains independent. Two-workspace code selects its intended valid workspace. Conflicting Telegram binding cannot reassign user or consume code. Removed membership, legacy multi-bindings, stale focus responses and old code after disconnect are tested.

Use fake timers to prove bounded refresh/count, zero checks while hidden, no permanent connected polling, one focus refresh and no overlap. Count D1 writes in repeated GET status tests and require zero. Real status response is needed for Connected; opening a link or manual claim alone cannot change it.

Native-browser review at 390 and 1280 px: reachable Settings > You > Telegram, readable clear copy, approved buttons, in-place progress, focus/accessibility and no overflow. Clicking the real external link is not part of this automated/native-browser check; intercept navigation and use synthetic t.me code in fixtures. Compare against existing approved recipes; no new visual invention. Record simulated Telegram confirmation separately from real-device/live acceptance, which is still unverified until explicitly performed.

Keep all other 009A deliverables. This is an in-scope user correction, not permission to replace text reply/retrieval with a linking-only feature.
