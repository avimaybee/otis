# Plan 008: Build the precise mobile-first conversation interface

> Executor: plan 007 must pass. Read design.md, docs/contracts.md and docs/browser-review.md in full. design.md is self-contained; use the user's screenshots only as summarized there, not as evidence that a built UI has been reviewed. Check source and route drift before work.

## Status

- Priority P0; effort L; risk medium; category UI/accessibility; depends on 007.
- Planned against scaffold revision `a3bd462` (2026-09-29); verify current UI/API before implementation.

## Why and current state

Otis's web app must feel like talking to a capable person. The mobile model is a full-width ChatGPT-like chat with a compact header, overlay history drawer and bottom composer. Desktop uses a Codex-like persistent sidebar, central chat and optional detail pane. Design.md rejects card-in-card, dashboards, ornamental gradients, fake thoughts and dead controls. The foundation scaffold exists; inspect it rather than assuming a component/API behavior exists. This gate delivers the first real conversation UI.

## Scope

Modify apps/web, packages/design, and a browser review checklist. API contract changes require coordination with plan 007 and a reviewed schema change, not local client assumptions. Do not add a lead grid, dashboard, native app, live voice call, image generation, photo/location controls, or Playwright/browser automation. Do not place real business data in review content.

## Screen and state inventory

Implement 360 px mobile shell first: compact top bar with menu, workspace/chat identity and New chat; one scrollable transcript; composer fixed above safe area and keyboard with growing text, mic and send; no bottom tabs. Typing `/` at the beginning of a draft opens a compact command picker fed by plan 007's available-command API; choosing a row inserts the command into the editable draft and does not execute it. Filter by name/description; support touch, arrows, Enter/Tab and Escape. After selecting or typing `/model `, use the available-model API to suggest approved model keys, current/default markers and voice support; choosing one inserts the key, and normal Send performs the switch. The command result states the selected model and applies to this chat only. Position the list above the keyboard without covering the latest agent question; hide it in read-only teammate chats. Drawer overlays and dims transcript; contains workspace switch, New chat, conversational search entry, recent own/team chats, and settings; focus trap, Escape/backdrop close, and focus return. Teammate transcript clearly shows author and no composer. On desktop use 260–300 px left history sidebar, measured central transcript, optional 360–440 px detail pane for source/action/draft/file, never three cramped columns. At intermediate width, collapse sidebar/detailed pane as design.md instructs.

Assistant replies are unboxed on the shared transcript surface. User turns are right-aligned restrained filled bubbles. Working is open and chronological while active, then folds under the final answer; every successful write shows what changed and a nearby Undo, read steps do not. Distinguish a provider-supplied thought summary from a tool call and network status. Missing thought content is simply absent. Present message states separately: local unsent, accepted/queued, processing, saved, failed/partial. When a new turn arrives while reading history, preserve scroll and offer Jump to latest. Offline draft and unsent recording persistence belong to the relevant composer/voice state, not a fake green check.

Build realistic stories/fixtures: empty, short exchange, long Romanian voice transcript, long Hungarian business name, multi-step Working, missing-deadline and inferred-status question, failed send, partial write, grouped Undo preview, dispute, teammate read-only chat, disabled/chosen-time brief, open drawer, detail pane, open/filtered slash picker and submitted command result. Use the locked design.md default: neutral charcoal surfaces, off-white text and monochrome controls, with semantic color for status. Use one legible sans type family, 16 px body/rough 1.5 line-height, 4 px rhythm, 16 px mobile horizontal padding, about 44 px touch targets and clear keyboard focus. Do not sample screenshot pixels. Light/system theme is optional later and must cover every state.

## Proposed file map and verification commands

Suggested implementation areas to map to the live scaffold: apps/web application shell/components/API client and shared design tokens. Reuse existing routing and tooling when present. The names are examples, not proof files are missing or that browser review has occurred; inspect current source and update the browser evidence record.

Verification after plan 001 establishes the scripts: pnpm typecheck; pnpm lint; pnpm test; pnpm build. For browser review, run pnpm dev and use Codex or Antigravity's native browser controls at 360 px, 390 px, tablet and desktop widths. Follow docs/browser-review.md, interact with the actual local build, record observed outcomes and defects, and fix them before completion. Do not add Playwright or make a manual review look like an automated test. Do not report a command as passed if it has not run. If a proposed path conflicts with the scaffold, preserve the module boundary and document the exact mapping before editing. Do not push or open a PR unless the operator asks.

## Steps and verification

1. Create design tokens, typography and primitive controls, then render the 360 px chat with realistic fixture content. Open the local app in a Codex or Antigravity browser, inspect at 360 and 390 px, and check horizontal overflow, latest answer/composer visibility, and focus order. Run pnpm typecheck/lint.
2. Add API-backed transcript, optimistic send with stable UUID, stream/replay, Working disclosure, message actions, clarification and the command picker. Use the native browser to type `/`, filter, select by keyboard and touch, dismiss with Escape, submit literal `//`, edit a selected command, and switch `/model`; verify the same server paths with package/API tests. Inspect accepted → working → answered, disconnect/reconnect, failed send/retry, undo of one write, and reading older messages while new activity arrives.
3. Add mobile drawer/workspace switch/read-only teammate view and desktop sidebar/detail pane. Inspect at 360, 390, tablet and 1280+ px; record screenshots of the drawer and detail pane open and closed. Check long names, 200% zoom, narrow keyboard viewport and mobile safe area.
4. Audit accessibility and restraint. Review keyboard-only traversal, labeled icon buttons, focus return, reduced motion, screen reader live status without every token being announced, and contrast through the browser and accessibility tree. Run root typecheck, lint, tests, and build.

## Done criteria

The first viewport shows where the user is, what Otis last asked/did, and where to reply. No dead controls or generic dashboard surfaces. A teammate cannot see an editable composer in another's chat. The live activity and final collapsed activity show identical underlying steps. The browser review checklist is completed on the actual local build at mobile and desktop widths, with screenshots and observed defects recorded.

## STOP conditions and maintenance

Stop if required stream states are absent from the API, if Undo requires a second source of truth, or if the locked palette fails contrast and legibility review. Report the failed state/token and corrected implementation proposal; the approved palette is settled. Future UI changes must follow design.md with realistic content.
