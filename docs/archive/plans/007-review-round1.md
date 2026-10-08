> Closed historical plan record, reconciled 2026-10-07 from `plans/007-review-round1.md`. Family 007: APIs/commands/wake present; streaming authority/recovery partial. Remaining R02, R04, R05, R14 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# Gate 007 review — round 1 (independent, 2026-10-02)

Reviewed HEAD `89fb4d8` plus the current uncommitted tree in `D:\vs code\Otis`.
No commits, pushes, deployments, live inference, or source edits.
Added: this document and one HTTP-level defect probe
(`plans/review-evidence/007-command-gaps.repro.test.ts`).

**Verdict: NOT ACCEPTED.** Gate 007 stays `IMPLEMENTED; review fixes required`.
Gate 008 must not be treated as unblocked beyond prototype work, and no
dependent acceptance should proceed on this gate's command/UI claims.

The API foundation is genuinely well built — scoped auth, cursor discipline,
idempotent writes, a careful undo API, and an honest browser-review record.
But the gate's headline jobs (answer questions, switch models/workspaces,
deterministic undo-by-command) fail at the routes that own them, and the UI
slice ships dead controls and an editable composer in teammates' chats.

## Commands actually executed and observed outcomes

From `D:\vs code\Otis` with `$env:TEMP='D:\wtmp'` and `$env:TMP='D:\wtmp'`:

- `pnpm typecheck`: exit 0. `pnpm lint`: exit 0. `pnpm eval:agent`: exit 0.
- `pnpm test`: **29 files, 368 passed**, exit 0 (~28 s).
- `pnpm build`: exit 0 (Vite + tsc + Wrangler dry-run; not a deployment).
- `git diff --check`: exit 0.
- New probe `007-command-gaps.repro.test.ts` (SELF.fetch through the real
  worker, migrated D1, real sessions): **4 passed** — each asserts defective
  behavior, so passing confirms the defect. Not an acceptance test.
- No browser/device review performed; none is available to this reviewer
  either. All visual rows stay unverified, consistent with
  `docs/browser-review.md`.

## What is genuinely good (verified, keep)

- Scope/auth plumbing: `requireWorkspaceScope` (401 vs 404, CSRF on
  mutations), percent-decoding at the boundary (`scope.ts:25`), chat-scoped
  reads, 422 on bad cursors/limits/modes, 409 cursor-superseded with
  `latest_cursor`, 404s that don't leak other workspaces.
- Undo API: preview-then-commit with `expected_revision` revalidation at the
  ledger guard, idempotent commit keyed by `client_operation_id`, retry
  replay, teammate attribution via own chat, dependency conflicts surfaced.
  Tests assert final DB state including no-double-revert.
- SSE delivery over persisted rows with catch-up parity, reconnect-from-cursor,
  resync signal, revocation event, and per-poll session/membership recheck.
- Parser/registry: exact first-token grammar, `//` escape, `@thisbot`
  handling, surface-aware listing (`/start` hidden on web), pure tests.
- Honest records: `docs/browser-review.md` marks every visual row unverified;
  `/today`/`/sheet` are deferred in prose rather than faked (with one
  exception below); the built CSS verifiably contains the approved tokens.

## Blocking findings (all executed or line-proven)

### 007-01 — P1: /model never switches; /workspace never switches; /undo never undoes

- `executeCommand` (`routes/commands.ts:134-235`) emits `set_chat_model`
  never, and its only caller applies only that effect type
  (`routes/commands.ts:437-444`). `set_active_workspace` and `request_undo`
  are produced but consumed nowhere; the ordinary message path
  (`inbound.ts`) parses no commands, and the web client has no
  execute-command call at all (`api/client.ts`).
- Executed: `POST .../commands {"text":"/model mimo-25"}` → 200, but
  `chats.model_override` stays NULL. `POST {"text":"/workspace Cmd Two"}`
  → 200 reply "Switched to Cmd Two" with zero durable change — a false
  confirmation, contradicting the report's "acknowledged, not faked".
- Smallest repair: emit `set_chat_model` (validate key, allowlist, `default`
  clears) and apply all three effects in the route (workspace switch to the
  Telegram identity store where meaningful; undo by delegating to the same
  ledger undo path as the action API); wire the web composer/picker to the
  execute endpoint. Required tests: switch persists + `/model` lists current;
  unknown/retired/unconfigured keys ask; workspace reply matches reality;
  `/undo` reverts exactly once with receipt proof.

### 007-02 — P1: the clarification shortcut rejects ordinary-language answers

- `handleReplyToClarification` (`routes/clarifications.ts:223-251`) calls the
  ledger resumer with `resolved_fields ?? {}`. Any question with
  `missing_fields` therefore 422s on a text-only answer
  (`missing_required_field`), while the DTO advertises "the same wording a
  normal composer message would send" and the actor path derives fields from
  text. A normal composer POST creates an unrelated new run; nothing else
  routes answers to waiting runs — so on web, plain-language answers have no
  working path.
- Executed: text-only reply to a `due` question → 422; same for a bulk
  `confirm` approval (which additionally hits `unsupported_command`, the N2
  shape, because this route bypasses `resumeRun`'s bulk routing).
- Smallest repair: derive `resolved_fields` from text as `resumeRun` does,
  and route `bulk_operation` payloads through the non-ledger resumption used
  by the actor. Required tests: text-only answer resumes + commits exactly
  once; teammate answer refused; duplicate answer 409 with no second effect
  (partially covered); bulk approval via shortcut resumes.

### 007-03 — P1 (UI slice): teammate chats render an editable composer

- `ConversationScreen.tsx:48-52`: `activeChat` resolves from `ownChats`
  only, so selecting a team chat yields `readOnly === false` and the full
  `Composer`. Server rejects the send (403, verified in
  `inbox/repository.ts:366`), but 008's explicit criterion — no editable
  composer in another's chat — is violated on screen.
- Smallest repair: resolve the active chat from both lists (or track
  authorship explicitly) and render the read-only hint for non-owned chats.

### 007-04 — P1 (UI slice): Settings signs out; workspace/search controls are dead

- `HistoryNav` renders working Settings, workspace, and search controls, but
  `ConversationScreen.tsx:179-202` wires Settings→`onSignOut`,
  workspace→`undefined`, drawer search→`undefined`. A labeled Settings
  control that signs the user out is worse than a missing one; design.md
  forbids dead controls.
- Smallest repair: back workspace switching with real view state (App owns
  `workspaceId` already), remove or disable search until it exists, and point
  Settings at a real destination or remove the entry for this slice.

### 007-05 — P2: Working disclosure can never collapse; Escape destroys drafts

- `Transcript.tsx:179-187`: `expanded` hardcoded true with a noop toggle —
  the "folds under the final answer" requirement cannot occur.
- `Composer.tsx:116-120`: Escape in the picker clears the entire draft
  instead of dismissing the list, against "do not consume unfinished draft
  text".
- Smallest repair: lift expansion state up (default collapsed when finished,
  manual choice respected); Escape closes picker only.

### 007-06 — P2: detail pane has no mobile behavior; drawer focus churn

- `.otis-detail` is always laid out side-by-side; nothing hides it below
  1280px and nothing applies `.otis-detail--overlay`, so opening an action on
  a phone squeezes the transcript into ~nothing. Design requires overlay or
  replacement below the width threshold.
- `HistoryNav` focus effect depends on the whole `props` object, so every
  parent re-render (e.g., each streamed activity) re-runs cleanup/setup:
  listener churn plus `previous.focus()` stealing focus while the drawer is
  open. Depend on stable values instead.
- Also below the bar, not blocking: member bubble 85% at all widths (80%
  desktop per design), jump button unreachable (`pendingUnread` hardcoded 0),
  nav rows 40px vs 44px targets, mobile hint claims Enter-sends while mobile
  inserts newline, SSE skips membership checks while activity flows
  (`stream.ts:97-99` — a removed member keeps receiving during bursts),
  `maxStreamMs` resets per pull so the "hard bound" never binds, static
  `x-request-id: stream-<chatId>`, `expected_revision` defaulting to current
  (weakens stale-preview detection), double event fetch in action detail,
  `Date.now()` undo idempotency keys per click, EventSource `withCredentials`
  second arg (harmless non-standard).

## Expressly not verified / not required now

- Layout, spacing, typography, contrast, keyboard flow, reduced motion, and
  screen-reader behavior: no browser here; `docs/browser-review.md` stays
  authoritative and correctly red.
- The `/today`+`/sheet` deferral and the missing mic are consistent with
  owning gates (011/012/010) *provided* the UI stops implying they exist;
  `/workspace`'s false "Switched to" is the exception and is filed above.
- No live inference, Telegram execution, media, or exports exercised.

## Note on test quality (fairness)

The 24 chat-API tests + 8 parser tests are high quality: final DB state,
idempotency, refusal, and resync are asserted, and two real bugs were caught
by them (percent-decoding, ahead-cursor resync). The gaps above are missing
scenarios (effect application, text-only answers, teammate-composer
rendering), not weak assertions — except the shortcut test, which supplies
`resolved_fields` explicitly and therefore never exercises the advertised
text-only path.

## Next bounded instruction

Keep 007 `IMPLEMENTED; review fixes required`. In scope order: (1) command
effect emission + application with final-state tests; (2) shortcut
text-derived fields + bulk routing with resume/commit tests; (3) teammate
read-only resolution + Settings/workspace/search honesty; (4) disclosure
collapse, Escape, detail mobile behavior, focus deps. Then serial
typecheck/lint/test/build. No new packages, queues, or schema beyond additive
migrations; browser proof waits for a reviewer with browser controls.
