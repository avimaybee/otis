> Historical record, archived 2026-10-07 from `plans/2026-10-07-compact-ui-plan.md`. Its claims apply to the original baseline. Use [current implementation status](../../status.md) for active work; old proposals and DONE labels are not current authority.

# Compact Otis conversation UI

Status: SPECIFIED, not implemented by this audit. Priority P1. Effort M. Risk low to medium: spacing changes can disturb scrolling, touch targets and keyboard focus. Source reviewed through `06ee63c`, 2026-10-07. Depends on the [question-panel behavior](2026-10-07-codex-style-questions-plan.md) for the final dock; density work elsewhere can proceed independently.

## Intent

The user asks for a cohesive, tighter Codex/Claude-style interface with Otis's own identity and rejects visually inflated 44px controls. That direction supersedes the old large visual recipes. Preserve the actual charcoal surfaces, muted Highlighter accents, current installed font system and conversation-first product. Use the [layout study](../../../plans/qa/otis-compact-question-preview.html) as a concrete proposal and the [Codex question screenshot](../../../plans/qa/2026-10-07-codex-question-reference.png) as interaction authority. The study is fictional HTML, not an alternative app foundation.

Otis's character should come from concise, specific language: what it understood, what actually changed, and the one detail it needs. Warmth/energy belongs to meaningful confirmed outcomes. Avoid a persistent “executive assistant” sales pitch, generic headings, raw tool/UUID receipts, decorative panels and repeated status bars. Keep sources, changes and Undo inspectable rather than making the message visually carry every detail.

## Current evidence

At the inspected desktop viewport (1526×686 CSS px, DPR 1.25), a one-line agent response is 60px high: 24px text + 4px gap + 32px invisible actions. A one-line member bubble is 76px before the 24px group gap. `index.css:58` and `:64` each own a 24px gap; `Transcript.tsx` repeats `gap-6` on the outer column. `WorkingDisclosure` contributes a separate height and the same group gap before the answer. The empty composer surface is 96px; an old reply banner plus footer makes its dock 168px. Existing Button primitives already offer 32/36px sizes.

The 360/390/900/1280/1440-width probes showed no horizontal document overflow in the inspected state. They are desktop-browser width simulations, not phone/keyboard evidence. Token/story inventory scripts pass while these density and interaction issues remain. `Transcript.tsx` also displays ledger summaries whose templates expose raw entity IDs (`packages/ledger/src/commands/logEvent.ts:142`).

## Proposed density recipes

These are proposed target values for this user-directed redesign, not claims about the old approval or current production.

| Element | Current observed/source | Proposed starting point |
|---|---|---|
| Desktop sidebar | 280px; 40px chat rows; several 44px actions | 244–248px; 32px rows/actions; 12px outer organization |
| Header | 52px | 48px; title 14px, quiet workspace label |
| Desktop icon/control visuals | 32/36px, several independent 44px CSS rules | 28/32px; primary send 32/36px |
| Between turns | 24px plus hidden 32px action row | One 16px group gap; no invisible action row footprint |
| Working to answer | Parent 24px gap plus disclosure height | One 8px gap; 24px compact disclosure |
| Message text | Current 16px body | Keep readable 16px initially; 13px navigation, 12px metadata |
| Member bubble | 8/16px padding | 8/12px; keep comfortable line height and bounded width |
| Idle composer | 96px surface with a controls row | About 56px desktop; about 76px narrow mobile with a compact wrap |
| Question panel | Truncated reply banner + separate callout | Reference-style grouped panel, roughly 220–300px for common short questions; bounded internal scroll for long content |

Keep one shared horizontal column calculation for transcript, question panel and composer. Current transcript inner padding and scrollbar center differ from composer edges; align text/composer inset intentionally rather than adding scattered compensating margins. The conversation column can remain max 760px. A narrower sidebar and clearer spacing do more here than widening every text line.

Smaller visuals need usable pointer areas, visible keyboard focus and nonoverlapping targets. A universal 44px visual square is not an accessibility requirement: WCAG 2.2 AA [Target Size Minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum) specifies 24×24 CSS px with defined exceptions; [44px enhanced sizing](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced) is a separate criterion. Keep generous touch reach where it helps, through layout/hit areas rather than visually enlarging all controls. Real coarse-pointer tests must verify those hit areas do not overlap.

## Scope and order

1. Update the affected density recipes in `design-tokens.md` and their actual owners in `globals.css`, `index.css`, `components/ui/controls.css`, `components/Composer.tsx`, `components/Transcript.tsx`, `components/HistoryNav.tsx` and `components/ui/button.tsx` only where needed. User direction authorizes the new density; do not simply patch CSS over unchanged recipes or loosen the design checker to accept anything. Remove duplicate owners rather than stacking overrides. Leave color/palette foundations and backend scheduling alone.

2. Fix transcript composition first. Make one parent own between-turn spacing and give Working its intentional 8px connection to the answer. Desktop Copy/inspect actions must not reserve a full invisible row per message; place a compact hover/focus toolbar without text overlap or layout jumps, and provide a usable touch/menu equivalent. Keep source chips and receipt links visually secondary. Do not blanket-hide actions from keyboard users or make mouse hover the only access.

3. Tighten the sidebar/header. Combine workspace identity and selector into one compact row, group New chat/search/history coherently, and reduce heading padding. Keep selected-chat accent and existing real operations. “Filter loaded chats” should communicate its actual limited search scope; don't label it global Search until it searches the intended set. No CRM navigation, dashboard or decorative dead controls.

4. Simplify the composer dock. Use the existing autosize textarea and one viewport/scroll owner. Keep model/effort selection available through the actual server-confirmed controls, but give long labels a bounded width/truncation so send/voice actions remain reachable. Wrap quietly at narrow widths; don't hide working model state. Avoid fixed blank rows for inactive errors/status. Put [QuestionPanel](2026-10-07-codex-style-questions-plan.md) in the measured dock with its own input/submission. Preserve follow-up sending and actual Stop while work runs.

5. Clean receipt presentation without another data fetch per receipt. Keep durable ledger summaries intact; derive a concise display such as “Quote saved” from existing receipt/action data, or use a human entity label already returned in the run data. Never print a raw `ent_…` ID as the normal confirmation. Do not claim a field/status changed unless its receipt proves it. Detailed IDs remain in inspection. Match the current `formatOutcomeSummary`/receipt flow rather than adding a presentation service.

## Checks and completion

Use the production components in Storybook for idle, long-answer, active stream, question/options/free text, two pending questions, error, offline/retry, source/receipt, voice review and keyboard states. Add meaningful routing/focus tests for the question flow, not pixel assertions in happy-dom. Changes to harmless spacing do not need implementation-mirroring unit tests.

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm check:design`, `pnpm check:stories`, `pnpm --filter @otis/web build-storybook`. In native browser review at 360×800, 390×844, 900, 1280 and 1440px, record: same-content before/after screenshots; measured hidden-row footprint; actual group/disclosure/composer heights; no text/control clipping; one page scroll owner; preserved reading position/follow; keyboard focus and nonoverlapping touch reach. Verify keyboard-open behavior on real iPhone/Android before claiming mobile completion.

Done: ordinary short turns no longer contain invisible action-height inflation; the idle composer meets the compact recipe; the reference-style question panel is integrated with explicit targeting; existing actions/models/voice/Undo remain functional; checker/story/browser evidence agrees with the updated recipes. Update the plan index. No new UI framework, custom state-machine library, build-foundation rewrite or deployment is part of this plan.

Maintain: future controls need a compact visual recipe and a separately checked hit region. New transcript additions must declare their gap owner. Keep actual business outcomes concise and truthful; personality is not permission to invent progress or success.
