# Otis questions: Codex-style answer panel

Status: SPECIFIED, not implemented by this audit. Priority P1. Effort M for text; voice integration M with actual Workers/media evidence. Risk medium: the target determines which paused business operation resumes. Source reviewed through `06ee63c`, 2026-10-07. No new application dependency, schema or provider service is needed for the text path.

## Intended behavior and authority

The user explicitly selected the Codex question UI shown in [their reference](qa/2026-10-07-codex-question-reference.png): a panel above the ordinary composer, a question, numbered suggested choices, a free-text answer field, Send, Skip and close. **This is a clarification interface. Do not introduce generic quoted-message replies.** The [interactive layout study](qa/otis-compact-question-preview.html) demonstrates composition and separate answer/chat inputs using fictional content and no API calls. It is not production component or backend verification.

Otis remains a conversational business memory. An uncertain name, amount, deadline or status must not become a write through a guessed answer. Questions already release the workspace execution slot. Ordinary chat, other members' work and the user's next message remain possible while a question waits.

## Current source and failure

- `apps/web/src/ConversationScreen.tsx:414` selects a pending question and assigns it to `activeClarification`; the ordinary `send` callback then puts its ID into text outbox entries. This happens without a question-specific Submit action.
- `apps/web/src/components/Composer.tsx:323` renders a one-line “Replying to Otis” banner; candidate buttons replace the ordinary chat draft. Main chat and answer drafts are the same input.
- `apps/web/src/components/Transcript.tsx:199` provides “Answer below” using only the clarification ID; it does not focus a distinct answer input.
- The server entry `apps/worker/src/routes/chats.ts:318` dispatches `clarification_id` before commands. `routes/clarifications.ts:135` validates owner/chat, accepts an answer using a stable client UUID, resolves the named clarification and resumes its original run.
- `api/snapshot.ts` now uses `selectPendingQuestion` and a cumulative dismissal list (`95551ee`). That fixes the old two-question alternation locally. The automatic main-composer routing remains.
- `ConversationScreen.tsx` voice entries omit the question ID. `06ee63c` now hides the mic in reply mode, preventing the misleading local affordance. The clarification route still requires text or resolved fields and does not handle media. `media/transcription.ts` transcript commit currently requires a queued associated run, so attaching an awaiting-input run ID alone cannot implement voice answers. Keep the answer-panel mic absent until targeted voice submission is implemented and verified.

Use the existing `Button`, `Textarea`, disclosure conventions, Lucide icons, outbox and scoped query keys. Add one small production `QuestionPanel` component; reuse it in application and stories. If a radio primitive is needed, use the existing Radix/shadcn stack, not a second library. Keep the existing API/error and receipt patterns in `api/client.ts`, `api/outbox.ts` and `routes/clarifications.ts`.

## Scope

Text: `ConversationScreen.tsx`, `components/Composer.tsx`, `components/Transcript.tsx`, new `components/QuestionPanel.tsx`, related CSS, `api/outbox.ts` only if required for the existing delivery contract, tests/stories and behavior/design documentation. Preserve server membership, chat ownership, date validation, resume and idempotency behavior.

Voice, when wired: `routes/clarifications.ts`, `inbox/repository.ts`, `media/transcription.ts`, shared request validation/contracts and the existing recorder/upload interfaces. No new background service or parallel voice pipeline. Leave ledger internals, model adapters, actor scheduling and unrelated visual changes alone.

## Implementation order

1. **Separate intent at local acceptance.** Remove automatic `clarificationId` from main `send`. Add an answer callback receiving an immutable `{questionId, workspaceId, chatId, text, clientMessageId}`. It creates the existing outbox entry with `clarificationId`. Only the QuestionPanel submit supplies that ID. Capture target and text before clearing local state; retry uses the same UUID and exact payload. Main `/commands` retain normal dispatch.

2. **Render the reference composition.** Put QuestionPanel above Composer inside the existing measured composer dock, so the viewport hook sees the complete dock. Show the question, bounded server-supplied choices, a free-text field and Send/Skip. Choosing an option selects it; submitting is explicit. Typed text overrides the choice. Do not invent dates, choices, entity IDs or confidence. Put longer questions on multiple lines. Show the operation/source reference quietly and provide “View question” when reopened from history.

3. **Keep one active panel, with scoped drafts.** Key answer state by user/workspace/chat/question. Main-chat drafts retain their existing key. A new question can open its panel; closing a panel must not automatically cycle through older questions. Multiple pending questions remain reachable from their original transcript callouts; “Answer question” opens the exact ID and focuses its input. Switching questions restores that question's draft, not another question's answer.

4. **Define Skip and close safely.** In this Otis plan, Skip defers the operation, closes the panel and leaves an inspectable pending callout. Close hides the panel without submitting. Neither resolves a question, cancels another run, guesses a deadline, or writes a business field. They do not reopen another old panel automatically. This follows Otis's need for explicit business details while matching the reference's interaction composition. No backend Skip command is needed for deferral.

5. **Own pending/error state in the panel.** Echo the submitted answer locally within 100ms; show submission state inside the affected panel/control beyond 300ms. Keep ordinary chat usable. A failed answer remains attached to its question with same-payload Retry and editable recovery; a closed/superseded question disables stale submission and offers recovery without rerouting. Late acknowledgement must clear only the matching submitted question, never a newer panel/draft. Resume revalidates current facts and never repeats receipts.

6. **Wire actual voice answers if exposing the mic.** Reuse Otis's recorded-note capture, not browser live dictation or a simulated waveform. Carry the exact question target through upload, acceptance, validated transcription and resume. Keep the old operation waiting until its answer is available; don't start a generic business run for the answer and don't try to commit STT against the current queued-run-only guard. Use the existing media/job records and a guarded transition appropriate to an answer job. Transcript failure/retry preserves the target and UUID. If this requires a shared contract change, update validation, HTTP contract, outbox and both clients together. A cosmetic mic is not completion.

## Verification

Write screen-level tests alongside `apps/web/test/conversation.test.tsx` or the existing full-flow fixtures; use their React act/query/outbox patterns but mount the actual screen/controller for routing assertions. Required cases:

- Two pending questions; close/Skip leaves normal chat usable without rotating the panel.
- Main text, `/model` and voice do not inherit a question ID while a panel is open.
- Choice and free-text submit target the selected question; text overrides choice.
- Drafts survive switching questions and navigation without crossing account/workspace/chat scope.
- Rapid answer followed by normal chat; late acceptance after opening a second question.
- Same UUID retry, offline answer, already-resolved question and lost membership.
- “Answer question” focuses its field; Enter sends, Shift+Enter adds a line; number shortcuts do not intercept editable text.
- Voice success/failure/restart keeps target identity; the original run resumes once. Use actual local Workers/D1 and the existing transcription/clarification fixtures.

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm check:design`, `pnpm check:stories`, `pnpm --filter @otis/web build-storybook`. UI checks must render production components at 360×800, 390×844, 900, 1280 and 1440px using native browser controls, plus keyboard/reduced-motion/a11y checks. Use actual Android/iPhone recordings for voice capability claims. A passing callback mock does not verify the dismissal or routing flow.

Done: the main composer never accidentally resumes a paused task; the displayed question, submitted target and answer agree through every recovery path; the reference composition works at the five widths; all applicable checks pass with recorded build/browser evidence. Update the plan index. Do not commit, push or deploy without task authorization. If live source drifts from the excerpts, re-inspect the affected flow before editing; do not replay stale line numbers.

Maintain: any future new answer transport must use this explicit target contract. Keep absence of `clarification_id` meaningful as normal chat; never infer it from the latest pending database row.
