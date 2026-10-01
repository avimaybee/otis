# Design Otis

Otis is a conversation with a capable colleague. A person reports what happened, answers a precise question, and gets back to work. The conversation owns the screen. Working activity explains real actions and becomes quiet when finished. Every surface and control needs a reason to exist.

This is the visual and interaction guide. Read [product.md](product.md) for behavior, [architecture.md](architecture.md) for implementation, and [roadmap.md](roadmap.md) for delivery order. Decisions below are the v1 baseline, not options for each agent to reinterpret. Revised 2026-09-30. A passing build or a dark background does not establish design fidelity; compare the rendered screen with this guide at real viewport sizes.

## 1. Intended feel

Use the composition of ChatGPT's mobile conversation and Codex's desktop chat: a calm transcript, restrained user bubbles, assistant text directly on the page, an anchored composer, familiar history navigation, and inspectable work. Use Otis's own name and content. Do not reproduce unrelated controls from reference screenshots. These references define the spatial relationship and interaction rhythm, not their branding, color or complete feature sets.

The user chose **neutral charcoal, off-white text and monochrome controls**, with color reserved for meaningful status. The scaffold's blue-gray palette is superseded. This document changes the target; it does not claim the scaffold already implements it.

Precision comes from alignment, proportion, typography, immediate feedback and honest state. No card around every paragraph, glowing borders, dashboard widgets, decorative metrics, separate icon rail, or introduction explaining that AI is revolutionary. The interface should feel quiet when idle and specific when working. A large empty canvas with a small generic card in the middle is not the intended conversation screen.

Priorities, in order:

1. The latest useful message and place to reply are obvious.
2. The member understands what is saved, what is running and what needs an answer.
3. The interface works one-handed with a mobile keyboard and weak signal.
4. Type, spacing and placement explain hierarchy before color or containers.
5. Details stay consistent through empty, long, failed and interrupted states.

## 2. Screen inventory

| Surface | Job | Navigation |
|---|---|---|
| Sign-in / invite acceptance | Identity and team-visibility disclosure | Google sign-in, then workspace chat |
| Conversation | All normal capture, questions, corrections, tasks and drafts | Home and history |
| History | Return to a chat or inspect a teammate's chat | Desktop sidebar; mobile drawer |
| Detail | Inspect a selected action, source, draft or file | Inline reference; Close restores conversation |
| Settings | Membership, providers and explicit configuration | One quiet navigation entry |
| Access/error state | Explain expiry, revocation or unavailable workspace | Clear next action, recover input where allowed |

No dashboard, kanban, lead editor, task-management screen or required daily checklist. A task list or brief can appear in an answer; it does not become another application inside a card.

The app's first screen depends on actual state. A signed-out person sees a focused sign-in view. A signed-in person lands in the last accessible workspace chat, or a composer-led empty chat. Do not show a technical welcome panel, Firebase UID, workspace role diagnostic, or placeholder dashboard after authentication. During partial implementation, name the screen as a shell in documentation and preview evidence; do not present it as the finished Otis UI.

Business search is conversational: 'What happened with Bistro?' History search finds chats/messages and opens the source. Distinguish these jobs. Mobile history search is inside the drawer, not a permanent field above the transcript.

Workspace and chat are explicit route state. Refresh/deep links restore that view. Workspace switching restores its last own chat or opens an empty chat. Teammate chats are read-only. A source reference cannot silently switch workspaces.

## 3. Mobile composition

```text
┌──────────────────────────────┐
│ Menu  Kerning / chat     New  │
│                              │
│                   Your note  │
│                              │
│ Working…                     │
│ Otis's question or answer │
│                              │
│                 Latest ↓     │
│ ┌──────────────────────────┐ │
│ │ Message Otis          │ │
│ │                   Mic  ↑ │ │
│ └──────────────────────────┘ │
└──────────────────────────────┘
```

Start at 360 CSS px. Use 16 px transcript gutters and a roughly 52 px top bar, plus safe-area inset as needed. The workspace/chat label truncates to one line; its accessible name preserves the title. Menu and New chat stay at stable ends with 44 px hit areas. Do not crowd every action into the header.

The transcript is the main vertical scroller. Avoid a second competing page scroll. The composer sits in layout above the safe area and keyboard. Use dynamic viewport sizing; test the visual viewport on iOS. Fixed `100vh` must not hide the composer. Keep a single source of truth for composer height and available transcript height.

The left drawer contains workspace selection, New chat, history search, own chats, team chats and Settings. Target `min(320px, 86vw)`, leaving a dimmed strip of the conversation. Close by backdrop, Close, Escape and appropriate browser Back behavior. Trap focus while open, then restore focus and scroll. Do not stack drawers.

The mobile reference is a full-screen chat, not a centered desktop panel reduced to phone width. The header, transcript and composer form one continuous vertical layout. Keep the header quiet; the transcript, latest question and reply field carry the hierarchy. The history drawer appears only when summoned. If there is no history yet, keep the drawer simple instead of filling it with suggestions. The Plus control from the reference is not required: show it only when Otis has an attachment action that actually works.

Detail becomes a full-width temporary screen or sheet with Back/Close. Return to the same transcript position. Inspecting an action must not require horizontal scrolling.

## 4. Desktop and intermediate widths

```text
┌─────────────────┬──────────────────────────────┬──────────────────┐
│ Kerning         │ Chat title                   │ Action / source  │
│ New chat        │                              │ only when opened │
│ Search history  │       Conversation           │                  │
│ Your chats      │       Working                │                  │
│ Team chats      │       Answer                 │                  │
│ Settings        │       Composer               │                  │
└─────────────────┴──────────────────────────────┴──────────────────┘
```

Use one 280 px sidebar, adaptable within 260–300 px. Center the chat in its available region with maximum content width 760 px. Composer and transcript align. Extra width stays breathing room instead of stretching prose.

Detail targets 384 px, adaptable within 360–440 px. Show it beside the chat only if the chat keeps at least 600 px. Otherwise overlay or temporarily replace the content. No editor tabs or permanent inspector.

Initial breakpoint rules: drawer below 900 px; persistent sidebar at 900 px and above; side-by-side detail only when all minimum widths fit, normally around 1280 px or above. Change these only with recorded content evidence. Sidebar width is not a viewport breakpoint.

History scrolls independently where needed; account/settings stays reachable. Selected chat earns one subtle row fill. Unselected entries do not each get a card or border. Long titles truncate.

The desktop reference is one left history rail, one centered conversation column and an optional right detail area. The sidebar is structural navigation, not a second dashboard. Do not put the sign-in card, chat, settings and detail inside the same generic centered container. At desktop widths, the conversation remains readable rather than spanning the viewport; at intermediate widths, collapse the sidebar before squeezing the chat. The inspector is closed until the person asks to inspect something.

## 4A. Entry, sign-in and access states

Sign-in is a short threshold into the conversation, not a separate dashboard. Use the same charcoal canvas and typography as the app. On desktop, center a narrow content column with deliberate vertical placement and generous breathing room; on mobile, give it the full available width with 24 px side padding. Avoid a permanent app header above a disconnected sign-in card, a card-within-card treatment, a decorative illustration or an unnecessary tagline. One clear title, one Google action and any essential disclosure are enough. The action must remain unmistakable at 360 px and 200% zoom.

Show Google sign-in as one primary, full-width control with a visible keyboard focus state and a pending state that prevents duplicate submissions. Do not show a browser-connected or server-connected badge on this screen: health is not authentication. After sign-in, open the conversation or an honest no-workspace/access state. Do not greet the member with their Firebase UID or raw role fields.

An authentication failure sits next to the action and explains the next useful step in plain language. Distinguish a cancelled popup, expired session, unavailable service, denied membership and setup/configuration failure. Preserve the sign-in action when retry is safe. Do not print a raw Firebase verifier exception, token audience, project ID, stack trace or internal route name into the normal UI. Operators need those details in protected diagnostics, with a request ID when available. A broken deployment must say that Otis sign-in is unavailable and needs configuration; it must not imply that the person's Google account is wrong.

Invite acceptance states who invited the person, which workspace they will join and that members can read historical chats and retained voice audio. Keep that disclosure legible before acceptance. If the invitation is expired or already used, show the problem and a clear way to obtain a new one. Access revocation replaces private content immediately with an access state; it never leaves a previous transcript visible behind an overlay.

## 5. Semantic visual tokens

Implement once in `packages/design` as CSS custom properties. Components use semantic names rather than repeated hex literals or a parallel TypeScript palette. These approved starting values still need measured contrast in the rendered UI. The existing scaffold colors (`#0f1115`, `#161920`, blue accent) are not the target. A component that imports an old token object has not met this section merely because it uses a shared constant.

| Token | Dark value | Purpose |
|---|---|---|
| `canvas` | `#181818` | Conversation/background |
| `sidebar` | `#141414` | Navigation region |
| `surface` | `#242424` | Composer, restrained user bubble |
| `surface-hover` | `#2C2C2C` | Hover/active navigation |
| `surface-raised` | `#303030` | Popover requiring separation |
| `border` | `#383838` | Necessary separators |
| `text-primary` | `#F3F3F3` | Main content |
| `text-secondary` | `#B3B3B3` | Supporting copy |
| `text-muted` | `#929292` | Compact metadata; contrast tested |
| `action-bg` / `action-fg` | `#F3F3F3` / `#181818` | Send and rare primary action |
| `focus-ring` | `#D8D8D8` | Visible offset focus ring |
| `danger` | `#FF9C9C` | Failure/destructive text plus label |
| `warning` | `#EBC67C` | Attention plus icon/text |
| `success` | `#9DCCAF` | Confirmed outcome when useful |

No bright brand accent in routine chat. Links need a visible underline or unmistakable treatment. Color is never the only state cue. Avoid low-contrast gray for important content.

Surfaces have distinct jobs. `canvas` is the uninterrupted conversation ground; `sidebar` separates navigation; `surface` is for the composer and user messages; `surface-raised` is for transient menus or detail that truly needs elevation. An ordinary assistant reply uses the canvas. A sign-in form may group its content through width and spacing alone; it does not need a bordered rectangle by default. Use borders for a necessary edge or focus state, not to prove that every block is a component.

Typography: one sans-serif family, preferably self-hosted Inter with system fallback. Validate Romanian `ș ț` and Hungarian `ő ű`. Body/composer 16 px / 24 px; UI 14 px / 20 px; compact metadata 13 px / 18 px; rare screen title 20 px / 26 px. Weights 400 prose, 500 labels, 600 emphasis. Prose measure around 60–70 characters. No monospaced business prose, tracked uppercase labels or display-size headings in normal answers.

Spacing: 4, 8, 12, 16, 24, 32, 48 px. Author-to-content 4–8; paragraph gap 12; message-group gap 24; section gap 32. One parent owns each gap. Radius: 8 px small controls, 12 px menus, 20 px composer/user bubble. Avoid indiscriminate pills. Minimum hit area 44 × 44 px for a typically 20 px icon. Use one consistent line-icon family.

Motion: 120–180 ms where opening/completion needs explanation; honor reduced motion. No bounce, decorative shimmer, glow, glass, gradient or simulated typewriter effect over actual streamed text.

## 6. Messages and copy

User turns align right in one restrained fill, about 85% maximum width on phones and 80% on desktop. Assistant text aligns left directly on the transcript surface. Wrap long words/URLs safely and preserve meaningful newlines.

Show compact attribution when needed, particularly team history and system briefs. Do not repeat a large avatar for every paragraph. Timestamps are secondary; date separators mark actual date changes.

Final answers use ordinary prose, usually short. Lists/tables are appropriate for actual comparisons. Avoid automatic headings, 'Actions taken', praise, forced jokes, apologies for normal work, and a receipt after every simple save.

Examples, not rigid scripts:

- 'When should the offer be ready?'
- 'Thai Shop or Thai Garden?'
- 'Friday at 3. I’ve moved it.'
- 'The visit is saved. I couldn’t finish the draft—try again?'
- 'You said 3,500 RON; Hunor recorded 3,600. Which is current?'

Never say 'I'll remind you' until a reminder/schedule is committed. Never pretend the agent has real-world experience or is a human. Be candid and useful without manufacturing personality.

Source references stay next to the supported claim and open the source detail. Labels such as 'Hunor · Tuesday visit' are better than raw IDs. Missing/erased source content is described honestly.

## 7. Working activity

Working belongs to a run, before its answer in reading order. While active, show current real activity and a compact expandable list of previous steps. 'Searching Kerning', 'Saving the visit' and 'Waiting for a date' are useful; invented introspection is not.

When finished, collapse to a quiet disclosure such as 'Worked for …'. Preserve underlying chronology on expansion. Respect a user's manual expansion; do not repeatedly collapse it against their intent. Keep the relevant question or error visible while waiting/failed.

Step states: queued, running, succeeded, failed, skipped, undone. Only successful writes expose Undo. Render server receipts, never a green check inferred from model text. Long tool output has a concise summary and inspectable details; JSON is optional technical detail, not the business-facing default.

Provider reasoning summaries, if actually supplied for display, have their own accurate label. They are separate from tool calls and results. Missing summaries are absent. Hidden prompts, opaque signatures and secrets never enter Working. No simulated thought trace.

## 8. Undo

Primary action: **Undo from here**, meaning the selected successful write plus later successful changes in the same run. Secondary option: **Undo only this action**. If only one action qualifies, the short label 'Undo' is sufficient.

For multiple changes, explain the actual set: 'Undo the price change and the follow-up created after it?' The user can confirm in ordinary language. Avoid an abstract danger modal. Reads, thoughts, conversation text and other runs are not part of this rollback.

If later work depends on a selected action, explain the dependency and ask. Never automatically include a teammate's changes. Stop a running run before freezing the rollback set. Undone actions stay in history with requester/time and a link to the revert.

Undoing a 'sent' record corrects Otis's record; it cannot unsend a real message. A teammate-history Undo is authored from the viewer's own chat. No editable composer appears in somebody else's chat.

## 9. Composer and commands

Use a quiet filled boundary with 12–16 px internal padding. Start at one text line and grow to about six before internal scrolling. Placeholder: 'Message Otis'. Keep control positions stable.

Desktop: Enter sends, Shift+Enter adds a line, except during IME composition. Mobile: Enter inserts a newline; explicit Send submits. Preserve multilingual composition events. Send is enabled only for valid non-empty content.

While a run works, expose labeled Stop. The composer remains usable for a queued follow-up/correction, with server ordering and an honest queued state. Stop is not Undo. Avoid confusing accessible names when Send and Stop share a visual slot.

The microphone records a voice note, not a live call. Do not copy a live-voice waveform button. No Plus menu until a supported attachment action exists. V1 photo, camera, file ingestion, image generation and location controls must not appear as dead placeholders.

Typing `/` at the start opens a compact list above the composer. Selecting inserts editable text; Send executes. Support arrows, Enter/Tab, Escape and touch; do not consume unfinished draft text. `//` sends literal slash-prefixed text.

Commands come from the server registry: `/model`, `/workspace`, `/today`, `/undo`, `/help`, and `/sheet` only after implementation. `/model ` suggests approved configured keys with current/default markers and voice capability. Switches are chat-specific and conversationally acknowledged. Do not expose the provider catalog automatically.

Model choice may be a quiet composer label/menu on desktop and a compact overflow option on mobile. It is always reachable through `/model`. No permanent technical toolbar for token counts and provider parameters.

## 10. Voice-note states

| State | Visible content | Actions |
|---|---|---|
| Ready | Composer/mic | Record or type |
| Permission | Browser prompt; explanation only if needed | Browser allow/deny |
| Recording | Elapsed time; real measured level if available | Stop, Cancel |
| Review | Playable local recording and duration | Play, Discard, Send |
| Uploading | Local voice bubble and real status | Retry on failure |
| Accepted/transcribing | Saved input; 'Transcribing' | Inspect status |
| Transcript/working | Audio plus transcript disclosure; Working | Correct by conversation |
| Finished | Text reply by default | Play retained audio, inspect transcript |
| Expired audio | 'Audio expired'; readable transcript | Read source |

Stop finishes capture into Review; it does not send. Cancel discards. At three minutes, stop into Review and explain the limit. Do not keep recording beyond server limits.

Warn before deliberate navigation discards a recording. Recover stored local drafts where browser storage permits; never label local persistence as accepted by the server. Do not promise background capture or survival of OS termination. Logout removes local private drafts on shared devices.

If voice is already known to be unavailable for the model/transcription configuration, explain before recording and offer text or `/model`. Never record three minutes just to reveal a known capability gap.

'I heard …' appears only for a concrete uncertainty in names, amounts or dates. Do not prepend a transcript receipt to every answer. Test real Android and iPhone capture, interruption, permission and supported formats; width emulation alone does not prove them.

## 11. Scroll and keyboard

Auto-follow only while near the bottom. When the user scrolls away, preserve position through new tokens and activity. Offer one Jump to latest control with unread indication. Loading older pages preserves the visible anchor.

Return from detail/drawer to the same message. Restore per-chat scroll where feasible. A workspace switch must not briefly render another workspace's optimistic draft. Keyboard opening and multiline growth must keep the composer and question reachable, with no arbitrary jump. Working collapse and status controls should not shift the layout unexpectedly.

## 12. State presentation

| State | Required behavior |
|---|---|
| Empty chat | Composer-led, one short invitation at most; no suggestion-card grid |
| First use | Workspace and visibility clear; optional conversational brief setup |
| Offline/local | Preserve input and show local/waiting state |
| Accepted/queued | Distinct from completed work |
| Clarification | One narrow question; normal reply resumes |
| Provider failure | Explain and retry with preserved input |
| Partial write | Name what saved and what did not; keep Undo |
| Budget limit | Reset/next action visible; history and Undo remain reachable |
| Revocation | Stop rendering private data; no old transcript behind error overlay |
| Missing key | Direct configuration path; no fabricated answer |
| Retired model | History readable; select another model for new work |
| Empty brief | Quiet unless requested |
| Schedule disabled | No scheduled brief; `/today` still works |
| Delivery unknown | Web answer saved; do not claim Telegram delivery |

Do not toast every success. Important failures remain attached to their message/action. A copy acknowledgment may be transient; a business mutation cannot exist only in a toast.

## 13. Settings

Use labeled rows and sections, not dashboard cards. Scope is explicit: account, your Kerning preferences, or shared Kerning settings. Minimum controls cover identity, membership/owner, linked Telegram, masked provider status, shared default model, your locale and brief schedule/timezone/delivery. No roles, billing, experiments or generic config editor in dogfood.

No pre-enabled 09:00 brief. Each person chooses when they want it and can change it by conversation. Direct controls here are optional convenience; normal work never requires a form.

Provider key entry is password-like and write-only; saved state exposes status only. Shared default changes explain their scope. Invite acceptance clearly discloses current members' access to all historical chats and retained audio.

## 14. Telegram

Use Telegram's native layout. Preserve meaning instead of simulating web with a wall of buttons. Give concise real progress when useful, then the natural answer. Detailed Working may link to web, but clarification and undo must work within Telegram.

Only relevant Undo/Change/Done/Draft actions appear. Snooze asks for a time if absent. Native command menu and typed commands share the web registry. Split long output at readable boundaries within verified limits and escape member content for parse mode.

## 15. Design acceptance

Fixture inventory: empty; short exchange; long Romanian transcript; long Hungarian name; multi-step Working; pending deadline; inferred-status question; ambiguity; dispute; partial failure; offline retry; undo group/dependency; teammate history; configured/disabled brief; unavailable model; drawer/detail; commands; recording/review/upload; audio expired.

Review signed-out, signed-in empty-chat and active-chat states at 360 × 800, 390 × 844, intermediate around 900, desktop 1280 and 1440 CSS px; include 200% zoom, enlarged text, keyboard-only navigation, focus return, reduced motion, measured contrast and screen-reader labels. No page-level horizontal overflow; wide technical content scrolls inside its detail. A desktop screenshot of sign-in does not verify mobile chat composition or the Codex-like desktop layout.

Use Codex or Antigravity native browser controls. Do not install Playwright. Record browser/OS, viewport, commit, fixtures, screenshots and defects in `docs/browser-review.md`. A simulated-DOM `scrollWidth` assertion is not proof of actual layout. If browser controls are unavailable, mark visual checks unverified.

Acceptance questions: Is the next action obvious? Can the person keep talking instead of managing fields? Is each container necessary? Is every status true? Can they inspect and undo a change? Is the speaking member unmistakable? Is the composer comfortable with the keyboard open? These determine whether the UI is ready.

Review the rendered result against the approved composition, not only against component tests. Reject a page that still reads as a scaffold: an app-wide health label above a centered login card, a technical welcome panel after sign-in, blue-gray tokens, a stretched empty transcript, a dashboard-like grid, or a detached composer. Record the mismatch and fix it before calling the relevant UI gate done. Do not defer visible sign-in defects merely because the full conversation gate has not started; entry is part of the experience people actually see.
