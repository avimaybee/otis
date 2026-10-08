> Closed historical plan record, reconciled 2026-10-07 from `plans/007-review-round3.md`. Family 007: APIs/commands/wake present; streaming authority/recovery partial. Remaining R02, R04, R05, R14 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# Gate 007 review — round 3 (independent, 2026-10-03)

Reviewed HEAD `89fb4d8` plus the current uncommitted tree in `D:\vs code\Otis`.
No commits, pushes, deployments, live inference, or source edits.
Added: this document.

**Verdict: ACCEPTED for the stated bounded scope.** The five required
owning-suite pins are present with final-state assertions, the full battery
is green on the final tree, and screenshot provenance is recorded with visual
acceptance explicitly deferred to Gate 008 (where it belongs per the plan).
Gate 008 is now eligible.

## Commands actually executed and observed outcomes

From `D:\vs code\Otis` with `$env:TEMP='D:\wtmp'` and `$env:TMP='D:\wtmp'`:

- `pnpm typecheck`: exit 0. `pnpm lint`: exit 0, 0 warnings.
- `pnpm test`: **29 files, 402 passed**, exit 0.
- `pnpm eval:agent`: exit 0. `pnpm build`: exit 0 (dry-run, not a deployment).
- `git diff --check`: exit 0.

## The five pins: verified present and substantive

In `apps/worker/test/chat-api.integration.test.ts:1043-1202`
(`007 round 2 owning-suite pins`), each asserts durable end state:

1. Text-only shortcut reply → 202 `resumed`, clarification `resolved`,
   exactly one task with `due_kind NULL`; same-ID retry stays consistent.
2. Bulk approval via shortcut → 202 `resumed`, clarification `resolved`,
   run re-queued (execution itself covered by the 006 bulk tests).
3. `/model <key>` persists `model_override` (with configured credential);
   `/model default` clears to NULL; unknown key asks and persists nothing.
4. `/workspace <name>` returns the target effect ID, leaves message history
   untouched (client navigates; membership guarded server-side).
5. `/undo` via command endpoint removes the entity, records exactly one
   revert event against the target, and idempotent retry adds none.

These match the executable shapes from independent verification
(`D:\wtmp\r7b-verify.log`, 3 passing temp probes, since retired per
convention). No bad-behavior assertions were copied into acceptance tests.

## Standing of all round-1/round-2 findings

- Command effects, shortcut text/bulk resumption, teammate read-only,
  Settings/workspace/search honesty, disclosure collapse, Escape behavior,
  detail mobile dialog, focus handling, SSE per-poll membership checks:
  verified in round 2 by source trace plus end-to-end execution; pins above
  lock the command/shortcut paths.
- `docs/browser-review.md` now records the 12 static captures (360/900/1280/
  1440, Windows 11, fixture harness) and explicitly defers visual acceptance
  to 008 with all visual rows still red. Honest and sufficient for this gate.
- Residual notes (not blockers): `maxStreamMs` resets per pull; no mic
  affordance yet (010 owns capture); `+` menu is commands-only (acceptable,
  recorded). Carry into 008/010 hardening.

## Out of scope, noted

- `plans/005-thinking-controls-handoff.md` is a new user-requested TODO
  handoff (Avi, 2026-10-03) with no implementation claimed. Not part of this
  gate; its future command work must reuse the 007 registry/executor.
- Review ran alongside ongoing implementation edits; final numbers above are
  from a quiet tree. Keep verification serial.

## Next

Gate 007 is DONE (local evidence only). Gate 008 may proceed against the
pinned API; its browser/device acceptance remains the real visual gate.
