# Design Daybook

Use this guide when designing or implementing Daybook's web interface and the presentation of its Telegram messages. Read `product.md` for what the product does, who can do it, and how its data works. This file defines the visual and interaction standard. It is deliberately specific about the interface and deliberately silent about ledger architecture, model providers, pricing, and roadmap.

Daybook should feel like a precise, capable conversation. Use a full-screen chat with an overlay history drawer on mobile, and a persistent history sidebar beside the chat on desktop. The diagrams, dimensions, and states below are the implementation reference; external screenshots are optional inspiration; keep Daybook's own name, copy, and visual identity. The interface earns trust through speed, legibility, honest status, and consistently placed actions. It does not need visual theatrics to seem intelligent.

## Protect these priorities

When design choices compete, decide in this order:

1. The current conversation and the user's next action are obvious at a glance.
2. A user can understand what Daybook is doing, what it changed, and what still needs an answer.
3. The interface works one-handed on a phone, including with the keyboard open and on a weak connection.
4. Type, spacing, alignment, and contrast carry hierarchy before color or containers.
5. Every remaining visual detail feels deliberate and consistent across states.

Do not add a control merely to expose a data object. Use the controls and screens specified by the product. Do not hide a product decision inside a visual convention. If the product document leaves a consequential behavior unresolved, surface that choice rather than designing both versions into the interface.

## App shell and responsive layout

Use the same underlying conversation on every screen size. Change the navigation and detail presentation with available width, not the meaning or order of messages.

### Desktop: sidebar, conversation, optional detail

The left sidebar stays visible and contains the workspace switcher, New chat, search, and chats grouped for quick return. Keep one sidebar; Daybook does not need a separate app-wide icon rail. The center owns the active conversation: compact title bar, scrollable transcript, and composer anchored at its bottom. A right detail pane opens only when the user selects something worth inspecting, such as a tool action, source event, draft, or generated file. Closing it returns that width to the conversation.

```text
┌──────────────────┬──────────────────────────────┬──────────────────────┐
│ Workspace        │ Chat title                    │ Selected detail      │
│ New chat         │                              │ (only when opened)   │
│ Search / history │ Conversation                 │                      │
│ Team chats       │                              │                      │
│ Settings         │ Composer                     │                      │
└──────────────────┴──────────────────────────────┴──────────────────────┘
```

At wide widths, start with a roughly 260–300 px sidebar, a flexible conversation that retains a comfortable reading measure, and a roughly 360–440 px detail pane when open. These are layout targets, not fixed widths that force cramped text. The three regions scroll independently where appropriate. The conversation remains usable while a detail pane is open; detail must never become the only place to answer, clarify, or undo.

At intermediate widths, keep the sidebar only while the conversation has enough room to read and compose. Open details as an overlay or temporary view. Do not squeeze three columns into a laptop-sized viewport. A selected item can open in an optional inspection surface; do not add editor tabs to Daybook.

### Mobile: conversation and drawer

The conversation fills the screen. A compact top bar holds a menu control, the current chat or workspace name, and only the actions used often enough to earn that space. Do not place a persistent desktop sidebar or bottom tab bar beside the chat.

```text
┌───────────────────────────────┐
│ Menu  Current chat     Action  │
│                               │
│ Conversation                  │
│                               │
│                      You      │
│ Daybook                       │
│                               │
│ Composer   Mic          Send   │
└───────────────────────────────┘
```

The menu opens a left drawer over a dimmed conversation. It holds workspace switching, New chat, search, recent chats, teammate chats, and settings in a scannable order. The drawer closes by its close control, Escape, or tapping the backdrop; focus returns to the control that opened it. In a teammate's chat, the header identifies its author and the composer is absent because the view is read-only.

The transcript is a single scrolling column. The composer stays anchored above the device safe area and mobile keyboard. New messages scroll into view when the user is already near the bottom. If they are reading older messages, preserve their position and offer a clear way to jump to the latest turn. History and detail views return to the same place in the conversation.

### Width transitions

Prototype the mobile shell at 360 px first. Around tablet widths, let the sidebar appear only if the conversation keeps adequate width. Use the optional right pane only on genuinely wide screens; otherwise present detail as a temporary layer. Decide breakpoints from the content's minimum usable widths rather than choosing device names first. Test the transitions with a long business name, expanded Working activity, and the keyboard open.

## Design from the conversation outward

Start each screen with its real content and state: a short question, a long voice transcript, a live tool run, a specific correction, a teammate's chat, or a failed send. Put the message, its author, and the next useful action in reading order. Compose the frame around those elements. Do not start with cards, a component library, or a desktop dashboard and shrink it afterward.

The mobile conversation is the primary composition. The top region identifies the workspace and current chat without behaving like a large app banner. The center is a continuous transcript. The composer anchors the bottom. On desktop, keep that same reading order between the persistent sidebar and optional detail pane; do not stretch message lines across the viewport.

The first viewport should make it immediately clear where the user is, what Daybook last said or asked, and where to reply. An unresolved question has priority over older activity. A morning brief reads as a message from Daybook, not a dashboard inserted into chat.

## The visual system

### Type

Use one clear sans-serif family for the interface. Start prototypes with Inter or an equally legible family that renders Romanian and Hungarian correctly, including ș, ț, ő, and ű. Validate the actual font files before committing. Reserve monospaced type for technical identifiers in expanded tool details, never for ordinary business facts.

Use a small, disciplined scale: about 16 px for conversation text, 14 px for secondary interface text, 13 px only for compact metadata, and 20–24 px for rare screen titles. Normal message line height is about 1.5. Give long replies a comfortable reading measure of roughly 60–70 characters. Use weight and spacing to mark structure; avoid display-size headings inside the chat. Numbers and dates should remain easy to distinguish and scan.

Sentence case is the default. Names and message content receive more visual weight than timestamps and interface labels. Do not use tracked all-caps labels or tiny grey text to create a false sense of refinement.

### Spacing and alignment

Build on a compact 4 px rhythm, using 8, 12, 16, 24, and 32 px deliberately. Spacing expresses relationships: the author and message stay close; separate turns get more space; a tool result stays attached to the turn that caused it. Equivalent items align to the same edges and baselines. One element owns each gap; avoid stacking component margins until spacing becomes accidental.

At 360 px width, begin with 16 px horizontal page padding and a single reading column. The composer and activity disclosure must fit without horizontal scrolling. Increase margins at wider widths while keeping the transcript at a readable measure. Compact does not mean crowded: text must breathe, and touch targets should be at least about 44 px in either dimension even when their visible icon is smaller.

### Color, surfaces, and boundaries

Daybook defaults to a dark theme with its own restrained palette (dark neutral background `#0f1115`, surface `#161920`, hairline borders, and primary text `#f0f3f6`) as defined in `@daybook/design`. Start exploration with neutral surfaces, strong primary text, readable secondary text, and one restrained accent for active action or focus. Use separate semantic treatments for error, warning, and success only where the state genuinely matters. Pair every color cue with text or an icon. Do not use bright color as decoration or to make routine agent output feel important. Optional light mode remains a future choice.

The transcript is one continuous surface. An assistant reply sits directly on that surface, while a user's message is right-aligned in one restrained filled bubble. Keep bubble width tied to its content and cap it before text becomes difficult to read. Avoid a large card around every turn. Use spacing first, then a hairline boundary when it clarifies ownership or grouping. A filled surface is earned by an input, selection, or unusually important status. Do not nest panels inside message bubbles.

The composer may be the strongest bounded element because it is the main control. Keep its shape restrained and stable as it grows. Tool steps, citations, timestamps, and ordinary metadata should not each receive their own pill, tile, or background. Shadows, gradients, glass, textures, glows, and ornamental borders have no role in the product interface.

### Icons and controls

Use words where a word is faster to understand. Use familiar icons for compact, repeated actions such as microphone, send, close, back, and search. Keep one stroke style and a consistent optical size. Never put routine icons inside decorative colored circles. An icon-only control needs an accessible name and visible focus.

Primary actions should be obvious, but there should rarely be more than one per local decision. Secondary actions can be text buttons. A destructive action must say what it affects. Use a conventional control when it reduces learning; do not invent a novel control to make the product feel distinctive.

## Conversation components

### Messages and questions

Make the author clear through bubble placement, typography, and a compact label when needed, without repeating a large avatar or name on every line. Give Daybook's unboxed answer room to read like speech, including short paragraphs where useful. Keep transcript metadata and message actions quiet and close to the message they affect. An agent question that blocks progress should be visually clear and close to the reply area. Optional suggested answers can sit underneath it; typing an answer remains the obvious path.

Separate what Daybook knows from what it is uncertain about through explicit language, such as “I have 3,500 RON as an estimate,” not an elaborate ink/pencil color code. If a source or earlier message matters, link it quietly from the relevant statement.

### Working activity

While Daybook works, show the current step and the actual tool and status events as they arrive. The area should feel live without simulated typing, fake thought text, or a pulsing decorative loader. When Daybook answers, collapse the activity under a compact **Working** disclosure in that turn. Reopening it reveals the same chronological sequence.

Distinguish a provider-supplied thought summary, a Daybook tool call, and a network/status event by label and structure, not by three competing colored cards. Never present a thought summary as a verbatim private reasoning trace. A successful write is easy to find in the list and has an **Undo** action next to that step. Read calls do not show Undo. The expanded detail may reveal exact values and timestamps without forcing that information into the first read.

### Composer and voice note

The composer remains accessible above the mobile safe area and keyboard. Use a compact rounded composer: text entry occupies the center, microphone is a clear adjacent action, and Send appears when there is text ready to send. Text input starts compact and grows only to a sensible maximum before scrolling internally. Keep send and microphone controls stable in position as the input grows. Add a leading attachment/menu control only when its menu contains real supported actions; do not reproduce ChatGPT's Camera, Photos, Files, image generation, or live voice controls as dead UI. A sent message appears in the transcript immediately with an honest delivery state.

Typing `/` as the first character opens a small command list attached to the composer, above the mobile keyboard and within the conversation column on desktop. Show a command name and one short description per row; filter as the user types. Arrow keys move the active row, Enter or Tab inserts the selected command, and Escape closes the list without losing the draft. On touch, tapping a row inserts it. Keep the draft editable and require the normal Send action; choosing a row does not execute it. `/model` and `/workspace` may need an argument, so show that need in the row rather than opening a separate command screen. Once `/model ` is in the draft, offer the current chat model and available handpicked model names with a quiet voice-support label; insertion still waits for Send. Hide commands whose feature is unavailable. Do not let the list obscure the latest agent question or leave it clipped by the keyboard. In a teammate's read-only chat, there is no composer or command picker.

Voice recording replaces the text-entry area with an unmistakable recording state, elapsed time, a real level or waveform display when available, and separate Cancel and Send controls. Do not show a decorative fake waveform. Keep those actions separated enough to avoid mistakes while walking. Show upload and transcription as distinct states after sending. A transcript can be opened from the voice message; uncertain words should be easy to notice and correct by replying in the same conversation. The first release uses voice notes, so do not draw an interface that implies a live call.

### Teammate chats

When viewing another user's chat, label whose conversation it is in the header and make the read-only state obvious. Preserve the same message and Working styles so the history can be understood, but do not show an active composer that could suggest the viewer is replying as that person. History can be browsed by person and date without turning the main screen into an inbox dashboard.

## States and motion

Design every important state before polishing the default: empty chat, pending question, recording, uploading, transcribing, live tool run, completed answer, partial failure, weak connection, queued message, correction, undo, and teammate chat. Distinguish “still on this device,” “accepted by Daybook,” and “saved to the workspace.” Never use the same checkmark or color for those different meanings.

Motion should explain a state change or preserve spatial continuity. Keep it brief and quiet. Do not animate every new message, slide in sections, bounce controls, or play sound for routine work. With reduced motion, show the final state immediately. Do not use movement as the only sign that a tool ran or a message sent.

## Telegram translation

Telegram is visually owned by Telegram. Carry Daybook's clarity through concise writing, consistent action names, and honest progress. A Telegram message should remain understandable without web-only styling. Use available formatting sparingly to separate a name, answer, and uncertainty. Do not turn every receipt into a miniature form or a fixed template. The web can show detailed Working activity; Telegram can show a concise summary and a path to the full run without requiring that path for ordinary clarification or undo.

Use Telegram's native slash-command menu for the same available shared shortcuts as the web composer, plus its account-linking `/start`. Keep names and one-line explanations aligned between surfaces. The user can also type a command directly or ask for the same action in ordinary language.

## Reject generated-design reflexes

- A card or shaded box for every message, tool step, statistic, or settings row.
- Cards inside cards, nested rounded panels, or borders added to compensate for weak hierarchy.
- Decorative gradients, glows, blobs, paper textures, glass effects, and ornamental shadows.
- Oversized empty hero space above a working conversation.
- A dashboard, KPI strip, or icon grid added merely because this is business software.
- Pills for ordinary labels, timestamps, and metadata.
- Tracked all-caps headings, tiny muted prose, or arbitrary type sizes.
- Emoji as interface chrome, stock AI illustrations, fake screenshots, and avatar theatrics.
- Loading states that conceal whether a message was actually saved.
- Large animation on every message or tool result.

Avoiding these patterns is not a mandate for a sterile black-and-white template. Daybook's character comes from the conversation, its measured pace, consistent alignment, and the confidence of an interface that shows only what is needed.

## Review before implementation or merge

Render real content, not placeholder lorem ipsum. Inspect at 360 px with the keyboard both open and closed, then at 390 px, tablet width, and desktop width. Include a long Romanian voice transcript, long Hungarian name, a multi-step Working run, a disputed fact, an offline send, and a teammate's chat. On mobile, inspect the closed and open history drawer, attachment menu when one exists, and recording state. On desktop, inspect the conversation with the detail pane both closed and open. Check the first viewport, latest turn, and composer in each case.

Review in this order:

1. **Comprehension:** Can the user tell whose chat this is, what Daybook last did, what remains uncertain, and how to answer?
2. **Hierarchy:** Does the conversation dominate? Are tool details accessible without competing with the answer?
3. **Geometry:** Do peer elements share edges and baselines? Does each gap express one relationship?
4. **Density:** Is the interface tight yet readable with a thumb, large text, and long names?
5. **Trust:** Are sending, saving, failure, provenance, thoughts, and Undo represented honestly?
6. **Access:** Do keyboard focus, screen reader labels, contrast, 200% zoom, reduced motion, and mobile safe areas work?
7. **Restraint:** Remove any box, color, border, icon, animation, label, or sentence that carries no meaning.

Fix the largest systemic issue and render again. Do not treat this checklist as a reason to add UI; its purpose is to make the few visible elements exact.
