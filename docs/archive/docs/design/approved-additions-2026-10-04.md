> Historical record, archived 2026-10-07 from `docs/design/approved-additions-2026-10-04.md`. Its claims apply to the original baseline. Use [current implementation status](../../../status.md) for active work; old proposals and DONE labels are not current authority.

# Approved visual additions, 2026-10-04

Owner: Avi. Status: approved additions to the 008A baseline, not undocumented
interim values. design-tokens.md stays verbatim; these four recipes live in
`apps/web/src/index.css`, `apps/web/src/components/ui/controls.css` and the
components named below. The design checker asserts each exact value.

## 1. Dialog and entry widths

Settings, command-result and source dialogs:

- Maximum width 600 CSS px with a 16 px minimum gutter on each side:
  `width: min(600px, calc(100vw - 32px))`.
- A maximum-width rule, not a mandatory 600 px width.
- Content stays reachable under constrained height: the close action remains
  accessible and scrolling lives in the content region.
- Mobile keeps its full-screen sheet/drawer behavior; the desktop inline
  detail pane is not subject to this constraint.

Entry screens:

- Content maximum width 384 CSS px with a 16 px minimum horizontal gutter
  and no horizontal overflow at phone widths.
- No card, border, shadow or decorative entry treatment.

## 2. Slash-command picker

- Maximum width 360 CSS px, constrained by composer/viewport space with a
  16 px minimum gutter: `width: min(360px, 100%)`.
- Anchored to the composer with internal scrolling for long lists; it never
  pushes the composer or transcript around.
- Long model names wrap in full rather than hiding behind aliases.
- Popover tokens only. The full cmdk popup pattern (with screen-reader
  option announcements) arrives with the 008B command picker.

## 3. Dialog and drawer scrim

- The background token at 80% opacity, applied to the scrim background
  itself (never an ancestor): `.otis-overlay::backdrop`.
- No backdrop blur. The scrim is a modal treatment, not a wash for chat
  content. Nested modals reuse the outer scrim
  (`.otis-overlay--nested::backdrop` is transparent) instead of stacking
  darker.

## 4. Reused neutral affordances

- Jump to latest: neutral icon-button treatment with an accessible name and
  a minimum 44 px hit area (a count extension may widen it, never shrink it).
- Clarification candidates: neutral compact buttons for server-provided
  answer shortcuts only, never a new chip design.
- Working Undo: neutral compact action, attached only to an eligible
  successful write.
- Source inspection opens an internal view, so it is a neutral compact
  action (ghost button). True links keep the approved highlight underline;
  no neutral-link variant exists. Buttons act, links navigate.
