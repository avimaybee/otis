# 008A review record: approved visual baseline, enforcement, Storybook

- Date: 2026-10-04. Baseline commit: `663f0b3`. Working diff: uncommitted 008A change set (reviewable, not pushed).
- Token authority: design-tokens.md untouched (SHA-256 `72764AFF…F058C`, matches the 008 handoff record).
- 2026-10-04 approval: the four recipe gaps are resolved as approved additions in `docs/design/approved-additions-2026-10-04.md` and decisions D38–D41. No interim values remain.
- Environment: Windows 11, Node via pnpm, no Codex/Antigravity browser controls available in this session, no bash (Windows). Portable Node runner used; `scripts/check-design.sh` is the CI/Linux entry (not executed here).
- Synthetic data only in stories and tests. No workspace content, credentials, provider calls or authentication.

## Executed checks (exact results)

| Check | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm lint` (incl. new jsx-a11y scope for `apps/web/src`) | exit 0 |
| `pnpm test` (full suite) | 34 files, 447 tests passed |
| `pnpm build` (web bundle + `tsc --build` + worker dry-run) | exit 0 |
| `pnpm check:design` | ok, 64 files scanned, no violations |
| Checker negative proof (temporary `__drift__.tsx`/`.css`) | 24 violations across every rule category, exit 1 |
| Checker recipe-exception proof (temporary `__recipe__.tsx`) | pass; samples removed afterward |
| Checker missing-path proof (temporarily moved `packages/design/src`) | `FAIL: missing source paths`, exit 1; restored, green |
| Storybook build (`storybook build -o storybook-static`) | success, 12.31 s |
| Web a11y tests (vitest-axe, 7 settled-state checks) | pass |
| Story inventory test (81 fixture IDs) | pass |
| `git diff --check` | clean (run at report time) |

## Inter loading (build-level evidence)

- `@fontsource-variable/inter` replaces Geist in `apps/web/package.json`; imported once in `preview.tsx` and `main.tsx`.
- Production bundle emits `inter-latin-ext-wght-normal` (85.07 kB) and `inter-latin-wght-normal` (48.26 kB) woff2; built CSS contains `Inter Variable` and the latin-ext unicode-range `U+0100-02BA`, which covers ș (U+0219), ț (U+021B), ő (U+0151), ű (U+0171).
- Computed-font and diacritic rendering in a real browser: UNVERIFIED (no browser tooling in this session).

## What 008A implements

- `apps/web/src/globals.css`: verbatim token section 9, sole literal-value store, imported once via `main.tsx`. `components.json` aligned (`new-york`, `css: src/globals.css`, neutral, cssVariables, lucide).
- `packages/design` competing store retired: `tokens.css` is an empty shim, `index.ts` exposes no palette.
- Recipes applied: canvas assistant text; user bubble (`ml-auto w-fit max-w-[85%] rounded-2xl bg-card px-4 py-2`, `nav:max-w-[80%]`); full-bleed sidebar rows with the 2 px highlight bar; highlight only in its five uses (new `StatusPill` for warm/hot); composer is one textarea plus the Send/Stop slot with no toolbar (model/thinking relocated to the `ChatOverflow` top-bar menu plus slash commands, same command endpoint); no mic/attachment placeholders; neutral visible focus from the token base; reduced-motion kill-switch; blur/shadow/pulse/shimmer/gradient/card treatments removed.
- `scripts/check-design.mjs` + `scripts/check-design.sh` + `pnpm check:design`: path-correct (repo-resolved `apps/web/src`, `packages/design/src`), fail-closed on missing paths and zero-file scans, covering utility classes, authored CSS values (grid, radius, border, type, shadows, motion), inline styles, arbitrary values (documented recipe exceptions only), retired stores and removed machinery.
- Storybook 10 (`@storybook/react-vite`, `@storybook/addon-a11y`) with `.storybook/main.ts` + `preview.tsx` (dark, canvas background, Inter, token CSS). Dev: `pnpm --filter @otis/web storybook`. Build: `pnpm --filter @otis/web build-storybook`.
- 15 story files cover all 81 design.md fixture IDs with production components; voice/brief/offline/entity-timeline IDs are labeled contract-only with owning checkpoints. New `ChatOverflow` and `StatusPill` are production components used by both app and stories. One message, one composer, one Working implementation throughout.
- Approval follow-up stories: `command/model-long-names` (long names wrap in the 360 px picker) and `detail/action-long-content` (long dialog content scrolls in the 600 px dialog).
- Approval corrections applied: source inspection is a neutral ghost-button action (highlight underline reserved for true links); jump-to-latest uses the icon-button treatment with a 44 px hit area; nested modals reuse the outer scrim via `Overlay` open-count tracking (`.otis-overlay--nested`).
- Accessibility: jsx-a11y lint scope, addon-a11y panel, 7 targeted vitest-axe checks (color-contrast excluded in happy-dom with token-ratio + browser-review coverage noted).

## Story inventory (file → fixture IDs)

Entry.stories: entry/sign-in, entry/pending, entry/failure, entry/invite, entry/revoked (production App with stubbed session checks). Chat.stories: chat/empty, chat/short, chat/long-ro, chat/long-hu, chat/long-url. Message.stories: message/sending, message/saved, message/failed, message/retry, message/unknown-acceptance, message/local-durable, message/filed, message/partial-filed (delivery-state IDs share the production bubble pending 008B milestone UI; filed/partial-filed use real run states). Stream.stories: stream/live, stream/unfinished-markdown, stream/replay, stream/disconnected. Work.stories: work/running, work/finished, work/expanded, work/failed, work/partial, work/stopped (plus one extra reference story, work/status-pills). Question.stories: question/deadline, question/status, question/entity, question/dispute, question/multiple (plain conversational text, no badge). Undo.stories: undo/single, undo/from-here, undo/dependency, undo/teammate-preserved (production DetailPane with stubbed receipts). Scroll.stories: scroll/follow, scroll/released, scroll/prepend, scroll/prepend-while-streaming (bounded frame; follow mechanics owned by 008C). Composer.stories: composer/empty, composer/short, composer/multiline, composer/max-lines, composer/ime, composer/follow-up. Command.stories: command/root, command/filter, command/model, command/thinking, command/pending, command/failed, command/literal-slash (plus extra command/model-long-names). Nav.stories: nav/drawer, nav/sidebar, nav/long-title, nav/read-only, detail/source, detail/action, detail/entity-timeline (last is contract-only, 008C; plus extra detail/action-long-content). Settings.stories: settings/personal, settings/workspace, settings/connection, settings/model-unavailable (stubbed reads). Brief/Offline/Voice stories: contract-only with owning gates.

## Token section 12 review: UNVERIFIED in a real browser

No Codex/Antigravity browser controls exist in this environment, and Playwright is forbidden. All five widths (360×800, 390×844, 900, 1280, 1440), diacritic rendering, touch targets, keyboard focus, hover/touch actions, reduced motion and Send/Stop readability are explicitly unverified. happy-dom geometry and the passing suites are not layout proof. No screenshots are attached for this reason.

## R7 cascade fix (applied during 008B, reviewer to verify rendered)

Unlayered `button/input/textarea/select` resets in `index.css` beat layered utilities and rendered Send/Stop/disabled labels unreadable. Moved the generic resets into `@layer base` so token utilities prevail; component classes stay unlayered by design. Composer now enforces the single slot (empty active draft shows Stop, valid follow-up shows Send, Stop reachable in overflow). Command/Composer stories dock at a realistic bottom (`.sb-composer-dock`) so the picker renders on-screen. Rebuilt Storybook for reviewer verification of computed colors, label sizes, enabled/disabled states and the docked picker.

## R6 follow-up (closed during 008B)

Repro showed the terminal receipt colliding: an overflowed block published `r0_think_b0_end` twice (complete, then truncated) and first-write-wins kept `complete`. Fixed to one terminal state per block (truncation takes precedence, no duplicate end receipt) with an idempotent-keyed regression test. `close()` now reports drain honesty (boolean): a rejected final publish returns false through `onFlushError` instead of claiming drained, with buffer retained and no unhandled rejection. Thinking cap verified genuinely per run via a budget object shared across round publishers.

## R4 pipeline fix (verified at build level during 008B)

Independent review found Storybook rendering unstyled (Times fallback): `.storybook/main.ts` had no Tailwind hook and `apps/web/vite.config.ts` lacked the plugin, so `@theme`/`@apply` shipped literally. Fixed by wiring the existing `@tailwindcss/vite` plugin into both (root app config already had it). Rebuilt iframe CSS (63,413 bytes) contains zero `@apply`/`@theme` literals, emits `.bg-background`/`.text-base`, references Inter Variable 9 times and carries the approved `#181818` canvas. Rendered computed-style verification belongs to the reviewer with browser tooling.

## Behavior defects found (owning checkpoints, not concealed)

1. `command/literal-slash`: the client picker opens on a `//` draft, which the contract reserves as literal text. Left as-is with a captioned story; owner 008B (client command parsing).
2. Composer popup announcements: `aria-expanded`/`aria-activedescendant` are invalid on a `textbox` (proven by axe), so the hand-rolled picker uses `aria-haspopup`/`aria-controls`/`aria-autocomplete` only. Full popup semantics arrive with the 008B cmdk picker.
3. Toasts still carry some failure feedback (`toast.error` on copy/command failures); token restricts toasts to copy confirmations. Owner 008B (failure attachment).
4. `streamStatus === 'resyncing'` notice and queue-state surfacing stay as-is; owner 008B/repair track.

## Missing approved recipes (resolved 2026-10-04)

The four gaps were approved with exact scope in `docs/design/approved-additions-2026-10-04.md` (decisions D38–D41): dialog/entry widths, picker width, scrim, neutral affordances with the button/action versus link/navigation distinction. The checker asserts each exact value (section 18 of `scripts/check-design.mjs`). Remaining viewport review of long dialog content, long model names, long command lists and constrained heights is explicitly unverified (no browser tooling).
