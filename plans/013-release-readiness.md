# Plan 013: Prove Otis is safe and useful for Kerning dogfood

> Executor: plans 001–012 must be DONE. Read product.md sections 15–19, design.md's full review, and every open STOP/decision note in plans/README.md. This is a gate, not a license to widen scope. Check document and code drift first.

## Status

- Priority P0; effort L; risk high; category security/operations/acceptance; depends on 001–012.
- Planned against scaffold revision `a3bd462` (2026-09-29); inspect current source/config/resource state when entering release work.

## Why and current state

A working demo can still lose messages, cross workspace boundaries, expose provider keys, send duplicate briefs, misread voice notes or look polished only in the default state. The first release is for Avi and Hunor to rely on during real outreach. The product's success criterion is Hunor logging at least five of seven days for two weeks without being chased. This plan verifies the integrated system and documents operational recovery before production use.

## Scope

Modify evals, CI, deployment configuration, operational docs, privacy/export/erase code and tests where needed, the browser review record, and narrow bug fixes within owning packages. Do not add Playwright or another browser automation framework. Do not add Phase 2 features, self-serve billing, WhatsApp bot, live voice or a generic admin dashboard. Any large architecture change becomes a new plan.

## Security and privacy gates

Audit route authorization for every ID-bearing API including chats, activity, actions, R2 audio, workbook exports and provider settings. Test removed members and new members with full historical access, with clear join disclosure. Check webhook verification, link-code expiry/one-use, CSRF/session settings, content escaping, spreadsheet formula safety, forwarded-message prompt injection, logs without PII/keys, secret rotation and backups. Create EU-jurisdiction D1 and R2 at resource creation if using real Romanian business data; Cloudflare says jurisdiction cannot be added afterward. This controls Cloudflare storage location, not automatically the geography of provider inference, support access, logs, or backups. Record actual data flows and subprocessors; get a privacy/legal review before selling to outside EU customers rather than declaring compliance from infrastructure flags alone.

Define and implement workspace export as machine-readable JSON for chats/transcripts, events, projections, tasks, drafts, sourced memory and suppression records, safe settings and membership history, plus the generated XLSX. Exclude session/link tokens and raw provider keys. Define a reviewed erasure procedure for D1, R2, credentials, memory index/summary and scheduled jobs with auditable completion/failures and a documented backup lifecycle; do not assert an unverified instant backup purge. Confirm 14-day raw audio cleanup and that every current member can access retained audio/history, while a removed member cannot. A new teammate receives the workspace's full historical chat visibility after a clear join disclosure.

## Operational and quality gates

The 2026-10-03 UI baseline adds explicit release evidence: design-tokens.md section 12 fidelity, production-component Storybook inventory, executed path-correct design checker, instantaneous optimistic echo/reconciliation, active-run follow-ups, stable scroll/keyboard behavior, account-scoped IndexedDB recovery and safe static PWA caching. See 008-ui-implementation-handoff.md. Existing source/test/screenshot acceptance does not establish this newer baseline. Storybook/axe passes do not replace the integrated native-browser journey, physical Android/iPhone checks or screen-reader announcement review.

Use staging with synthetic workspaces for a two-member journey: Avi signs in and seeds Kerning; Hunor links Telegram; both send text and voice; ambiguous identity asks once; inferred status and missing deadline are clarified before any write; conflict is visibly disputed; correction and both undo modes preserve unrelated later work; an explicitly enabled chosen-time brief arrives once; draft opens WhatsApp without claiming sent; `/sheet` yields the correct private workbook; teammate sees other's full history/audio; `/model` changes only current chat; new chat recalls relevant sourced workspace preference; second workspace cannot retrieve it; correction, undo and forget update retrieval; provider outage reports partial work. Repeat after Worker/actor restart and client offline/reconnect. Use production-like D1/R2/DO bindings but no real lead messages in automated tests.

Instrument run latency, acceptance-to-first-status, retries, duplicate suppression, wrong-write/undo rate, transcription corrections, model usage/cost per workspace and brief engagement. Measure the 5-second median text and 12-second median voice targets as targets, not promises; log network/model breakdown. Run Appendix A evaluation with a held-out multilingual set and report entity match >=95%, near-zero wrong writes, abstention rate, and exact failing examples without secrets. Do not tune only to seed fixtures.

## Proposed file map and verification commands

Suggested release artifacts, mapped to the live scaffold when this gate starts: eval reports, operational runbook, data-flow map, release checklist, actual browser-review record, CI workflow and narrowly owned defect fixes. Foundation CI exists; extend existing workflows instead of duplicating them. Do not mark this gate complete until the concrete staging journey and recovery procedures are evidenced.

Verification after plan 001 establishes the scripts: pnpm typecheck; pnpm lint; pnpm test; pnpm build. Record commands, versions, pass/fail counts, latency/cost report, staging journey evidence, and hands-on browser review screenshots/issues in the go/no-go packet. Do not represent browser review as an automated test. Do not report a command as passed if it has not run. If a proposed path conflicts with the scaffold, preserve the module boundary and document the exact mapping before editing. Do not push or open a PR unless the operator asks.

## Steps and verification

1. Run all root checks and a clean local migration/rebuild from empty state. Verify pnpm typecheck, lint, test and build exit 0; record versions and results.
2. Run the authorization, retry/restart, data export/delete and retention tests above. Verify no failed or skipped security test and no cross-workspace data in any response.
3. Deploy a staging build after the owner approves the concrete environment and resource configuration. Use Codex or Antigravity's native browser to run the full two-member synthetic journey on phone and desktop, including 360/390 px, keyboard open, long Romanian/Hungarian text, Working live/collapsed and accessibility checks. Record observed screenshots and issues in browser-review.md without real business data.
4. Produce docs/operations/runbook.md: migrations and rollback, secret rotation, webhook re-registration, queue/inbox recovery, failed brief reconciliation, provider switch, export/delete, cost alarm, on-call failure symptoms, and staging-to-production checklist. Verify every command against staging rather than copying untested commands.
5. Obtain a dogfood go/no-go review. Record outstanding provider-use/privacy questions. Only then connect the real Kerning workspace and begin the two-week usage observation. Do not mark product acceptance from a one-day smoke.

## Done criteria

All automated gates pass, the full synthetic journey is recorded, no P0 security/correctness bug remains, production secrets stay outside source, recovery/export/delete runbooks are tested, and the owner has a concrete go/no-go packet. The two-week habit metric and brief action rate are measured after real dogfood, not assumed at deploy time.

## STOP conditions and maintenance

Stop release if any cross-workspace read/write, duplicate ledger event after retry, lost accepted message, inaccessible undo history, untranscribed voice treated as fact, unreviewed provider credential exposure, or falsely reported delivery occurs. Stop outside-customer launch if export/erase or provider data-processing claims remain unresolved. Do not convert a STOP condition into a hidden feature flag without documenting the user-visible limitation.

Platform references: https://developers.cloudflare.com/d1/configuration/data-location/ ; https://developers.cloudflare.com/r2/reference/data-location/ ; https://developers.cloudflare.com/queues/reference/delivery-guarantees/
