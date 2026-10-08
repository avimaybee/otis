> Historical record, archived 2026-10-07 from `docs/browser-review.md`. Its claims apply to the original baseline. Use [current implementation status](../../status.md) for active work; old proposals and DONE labels are not current authority.

# Browser review record

Status: **unverified against the new 2026-10-03 token/behavior baseline**.

Read design-tokens.md section 12, design.md sections 13–14 and plans/008-ui-implementation-handoff.md. Prior screenshots/reviews remain evidence for their recorded builds. They do not establish the new Inter/Highlighter/recipe baseline, optimistic/offline/keyboard behavior or complete Storybook inventory. The historical notes below are preserved rather than rewritten as new observations. This is an evidence record, not a completed checklist.

At documentation revision 2026-09-30, the repository has a shell and simulated-DOM tests. Earlier HTTP checks returned the shell and health endpoint, but no durable record proves the required real-browser review at phone and desktop widths. A previous native browser tool attempt failed to initialize. Later DOM overflow assertions do not change that evidence status.

| Check | Required environment | Status | Evidence |
|---|---|---|---|
| Foundation shell / no overflow | Real browser, 360 px | Unverified | Not recorded |
| Foundation desktop shell | Real browser, 1280+ px | Unverified | Not recorded |
| Zoom / text enlargement | Real browser, 200% | Unverified | Not recorded |
| Conversation fixture matrix | Implemented plan 008 | Partially implemented (gate 007 UI foundation) | No real-browser record; simulated-DOM tests only |
| Android voice capture | Actual Android device | Not yet implemented | — |
| iPhone voice capture | Actual iPhone device | Not yet implemented | — |

Gate 007 built the first conversation slice in `apps/web` (design tokens, mobile conversation shell,
history drawer/sidebar, composer with command picker, detail pane). The simulated-DOM tests in
`apps/web/test/` prove structure and overflow bounds in a 360 px container, which is not layout
proof. A built preview was confirmed to serve the compiled stylesheet containing the approved
charcoal tokens.

12 static screenshot captures were recorded during Gate 007 exploration in `docs/reviews/2026-10-03-007/`
at 360px, 900px, 1280px, and 1440px viewports (covering chat, history, detail pane, composer states,
slash picker, and tools drawer) on Windows 11 under static rendering. Because live browser/device
automation is not configured in this CI/worktree environment, visual acceptance is explicitly
deferred to Gate 008 (Conversation UI), where interactive real-device/browser review is owned.
All visual rows above remain unverified for final release purposes.

When performing review, add commit, browser/OS, exact viewport, scenario, observed outcome, defects and screenshot paths. Follow [verification.md](../baseline-2026-10-07/docs/verification.md). Update only checks actually performed. Keep synthetic review data free of real workspace content and credentials.

## 008A tooling record (2026-10-04, uncommitted working tree on `663f0b3`)

Implemented and executed without a real browser: `pnpm check:design` (64 files, exit 0, with negative/missing-path proof), Storybook 10 build (all 81 design.md fixture IDs mapped to production-component stories), 7 vitest-axe settled-state checks, Inter latin-ext bundled in the production build. Evidence: `docs/reviews/2026-10-04-008/REVIEW.md`. All visual rows above remain unverified: no browser controls exist in this environment, so the token section 12 five-width comparison, diacritic rendering, touch, keyboard and reduced-motion checks are explicitly not claimed.
