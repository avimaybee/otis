# Gate 007 review — round 2 (independent, 2026-10-03)

Reviewed HEAD `89fb4d8` plus the current uncommitted tree in `D:\vs code\Otis`.
No commits, pushes, deployments, live inference, or source edits.
Added: this document. (My round-1 probe file was removed from the tree during
this review cycle — by the implementing side's cleanup, consistent with the
earlier pattern. Its evidence is preserved in `D:\wtmp\r7b-gaps*.log` and in
the round-1 report; all four of its defects are now fixed, so retirement was
due regardless.)

**Verdict: NOT ACCEPTED — narrowly.** Every round-1 product defect is
repaired and was executed end to end by this reviewer. What remains is
durable proof: five executed scenarios have no owning-suite regressions, so a
future edit could silently re-break headline commands. Port the five specs
below, re-run serially, and this gate is done. No new product behavior is
being asked for.

## Commands actually executed and observed outcomes

From `D:\vs code\Otis` with `$env:TEMP='D:\wtmp'` and `$env:TMP='D:\wtmp'`:

- `pnpm typecheck`: exit 0. `pnpm lint`: exit 0, 0 warnings.
- `pnpm test` (twice, stable): **29 files, 394 passed**, exit 0.
- `pnpm eval:agent`: exit 0. `pnpm build`: exit 0 (dry-run, not a deployment).
- `git diff --check`: exit 0.
- Round-1 probe re-run: text-only shortcut now 202, bulk shortcut now 202
  (both fixed); `/model`-with-credential and `/workspace` needed re-probing
  (see below).
- Temporary acceptance probe (3 tests, since retired): **3 passed** —
  text-only shortcut commits a `due_kind = NULL` task; `/model mimo-25`
  persists + `/model default` clears + unknown key asks without persisting;
  `/workspace` records the target effect and `/undo` executes exactly once
  with the entity removed.
- No browser/device review available to this reviewer either; static CSS and
  the 12 screenshots in `docs/reviews/2026-10-03-007/` were inspected
  directly (details below).

## Round-1 findings: all verified closed

- **007-01 commands**: `executeCommand` now emits `set_chat_model`
  (validated key + `default` clears; unknown/retired/uncredentialed keys
  ask), `set_active_workspace`, and `request_undo`; the route applies all
  three (undo delegates to preview/commit with idempotency + staleness
  guards); normal composer messages route through the same path
  (`chats.ts:239-243`), including clarification replies with chat scoping.
  `/today` answers deterministically from due tasks. Executed end to end.
- **007-02 shortcut**: rewritten onto the actor's `resumeRun`
  (`clarifications.ts:213-217`) with text-derived date interpretation
  (`dispatch.ts:1425-1430`, conservative `resolveDateAnswer`) and bulk
  routing to the non-ledger path. Text-only and bulk approvals execute;
  teammate answers refused; duplicates 409 without second effects.
- **007-03 teammate composer**: `readOnly` now derives from the server
  `is_author` flag with a read-only hint and own-chat redirect; server still
  403s non-author appends (`inbox/repository.ts:366`).
- **007-04 controls**: real `switchWorkspace` consumed from command effects,
  real `SettingsPane`, working title search — no more noop wiring.
- **007-05 disclosure/Escape**: `manual ?? !finished` with a working toggle;
  Escape dismisses picker/card without touching the draft
  (`Composer.tsx:508-512`).
- **007-06 detail/mobile/focus**: detail renders in a full-screen dialog
  below 1280px (`DetailPane` + `useMediaQuery`), sidebar/drawer breakpoints
  per design, jump-to-latest with away-tracking, focus-trap Overlay.
  SSE now checks membership every poll (`stream.ts:68`) with usable
  request IDs.
- Also verified along the way: percent-encoded IDs, ahead-cursor resync,
  removed-member denial, duplicate suppression, stale-preview revalidation,
  teammate undo attribution, idempotent command retries, CSRF/auth/error
  envelope consistency.

## Remaining: five owning-suite pins (the only blockers)

Behavior is proven by independent execution, but none of these live in the
normal suites, where the next refactor could regress them silently:

1. Text-only clarification reply resumes and commits exactly one task
   (`due_kind NULL` for "No deadline needed").
2. Bulk approval via shortcut resumes and executes the exact scope once.
3. `/model <key>` persists the override with a credential; `/model default`
   clears; unknown key asks and persists nothing.
4. `/workspace <name>` records the target effect (client navigates).
5. `/undo` via the command endpoint executes exactly once (entity removed,
   receipt-backed).
   Exact executable shapes are in `D:\wtmp\r7b-verify.log` (3 passing tests)
   and `D:\wtmp\r7b-gaps*.log`. Port them into `chat-api.integration.test.ts`;
   do not copy bad-behavior assertions.

## Non-blocking notes

- `maxStreamMs` still resets per pull, so the "hard bound" never binds a
  continuously-read stream. One-line scope if touched; not worth a gate.
- No mic affordance in the composer; the `+` menu exposes working commands
  only, which is defensible, but record the voice-capture gap against 010
  rather than letting `+` imply attachments.
- `docs/reviews/2026-10-03-007/` holds 12 real rendered screenshots at
  360/900/1440 (chat, history, detail, composer states, slash, tools) with
  correct charcoal composition, collapsed Working, source links, and undo
  scope controls — matching the ref images' spatial language. But they have
  no recorded browser/OS/commit/viewport provenance, and
  `docs/browser-review.md` still (correctly) marks every visual row
  unverified. Do not present them as browser acceptance; record provenance
  before 008 claims layout.
- Review ran while the implementation agent edited the tree (test count moved
  368 → 394 mid-review on identical files); final numbers above are two
  consecutive stable runs on a quiet tree. Run verification serially.

## Next bounded instruction

Keep 007 `IMPLEMENTED; review fixes required`. Add the five pinning tests,
record screenshot provenance (or explicitly defer visual acceptance to 008),
then serial typecheck/lint/test/build. No new packages, no schema beyond
additive migrations, no Playwright. On green, 007 is acceptable and 008 can
proceed against a pinned API.
