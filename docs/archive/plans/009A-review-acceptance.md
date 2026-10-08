> Closed historical plan record, reconciled 2026-10-07 from `plans/009A-review-acceptance.md`. Family 009: 009A local slice present; original native menu/callbacks unimplemented. Remaining R14, R15 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# 009A reviewer acceptance — local text loop

Reviewer: Codex, 2026-10-04. Scope: `009A-text-loop-handoff.md` and `009A-telegram-linking-ux.md`. No reviewer subagents. This accepts the implemented local text slice, not the complete Telegram plan or deployed dogfood release.

## Verdict

The identified blocking source findings are closed. The patch is accepted locally for the private Telegram text capture, agent response, stored business fact and later retrieval path, including guided account linking. Preserve the uncommitted tree. No deployment, remote migration or real Telegram message was performed as part of this acceptance.

The reviewer inspected the corrected source boundaries: source-bound delivery authorization; conservative HTTP outcome classification; fresh delivery clocks and atomic pacing/eligibility; delayed delivery continuation; awaited agent checkpoint continuation; composed sourced ledger undo; redemption ownership/workspace membership guards; and generation-owned link status checks. Findings and historical reproductions remain in `009A-first-pass-review.md`.

## Independent verification

- Root `pnpm typecheck`: exit 0.
- Root `pnpm lint`: exit 0.
- Root `pnpm test`: exit 0, **633 tests / 45 files**, start 15:32:48, duration 54.94 seconds. TEMP/TMP pointed to D:/wtmp.
- Root `pnpm build`: exit 0, including Vite, declarations and Wrangler **dry-run only**.
- Synthetic browser review at 390 and 1280 px checked the linking fixtures. The reviewer reproduced the unreadable primary link, inspected its CSS correction and personally viewed the implementation agent's subsequent fixed capture. `telegram-ready-390-fixed.png` and `009A-telegram-contrast-fixed.json` under `008-browser-evidence/` show the corrected link; the older `009A-telegram-browser-review.json` is pre-fix evidence and must not be presented as the corrected contrast result.

The tests exercise real local workerd/D1 with synthetic Telegram/provider transports. They cover capture/reply/retrieval, commands, undo provenance/rollback/replay, clarification, delivery outcomes, continuation and revocation. The UI suite covers bounded polling, expiry and stale asynchronous results. Passing suites do not establish live provider or bot delivery.

## Explicit evidence limits

- The redemption regression checks the production-shaped SQL predicates and revoked-intent behavior. It does **not** pause the actual redemption function between precheck and batch; do not describe it as a fully orchestrated end-to-end race test. The committing production guard and conditional upsert were reviewed directly. Additional testing is warranted if this boundary changes.
- Non-failing localhost:3000 connection noise remains in the test run. Existing bundle-size and Wrangler-version warnings remain in the build. These are not proof of external connectivity and were not changed for this slice.
- Context-free administrative Telegram responses are bounded best-effort sends rather than workspace-backed durable deliveries. Do not claim guaranteed delivery for those responses.
- Unknown Telegram delivery outcomes intentionally do not automatically resend. Exactly-once external delivery is not claimed.

## What remains

Full plan 009 remains incomplete: its remaining callback/menu and live-bot acceptance scope is not closed by this document. Voice, real Android/iPhone recording, user-chosen briefs and full 014 web push transport are not implemented or accepted here.

Next implementation scope should be the reviewer-authored Telegram voice slice of 010, reusing this text path. Do not automatically start the entire old voice plan, add a scheduler or expand into unrelated foundation work. A separate explicit handoff defines that assignment. Deployment and a real private-bot smoke test remain separate actions, with secrets/configuration and remote migrations checked before any release claim.
