# Plan 013: Prove Daybook is safe and useful for Kerning dogfood

> Executor: plans 001–012 must be DONE. Read product.md sections 15–19, design.md's full review, and every open STOP/decision note in plans/README.md. This is a gate, not a license to widen scope. Check document and code drift first.

## Status

- Priority P0; effort L; risk high; category security/operations/acceptance; depends on 001–012.
- Planned at unversioned document snapshot, 2026-09-29.

## Why and current state

A working demo can still lose messages, cross workspace boundaries, expose provider keys, send duplicate briefs, misread voice notes or look polished only in the default state. The first release is for Avi and Hunor to rely on during real outreach. The product's success criterion is Hunor logging at least five of seven days for two weeks without being chased. This plan verifies the integrated system and documents operational recovery before production use.

## Scope

Modify evals, CI, deployment configuration, operational docs, privacy/export/erase code and tests where needed, the browser review record, and narrow bug fixes within owning packages. Do not add Playwright or another browser automation framework. Do not add Phase 2 features, self-serve billing, WhatsApp bot, live voice or a generic admin dashboard. Any large architecture change becomes a new plan.

## Security and privacy gates

Audit route authorization for every ID-bearing API including chats, activity, actions, R2 audio, workbook exports and provider settings. Test removed members and new members with full historical access, with clear join disclosure. Check webhook verification, link-code expiry/one-use, CSRF/session settings, content escaping, spreadsheet formula safety, forwarded-message prompt injection, logs without PII/keys, secret rotation and backups. Create EU-jurisdiction D1 and R2 at resource creation if using real Romanian business data; Cloudflare says jurisdiction cannot be added afterward. This controls Cloudflare storage location, not automatically the geography of provider inference, support access, logs, or backups. Record actual data flows and subprocessors; get a privacy/legal review before selling to outside EU customers rather than declaring compliance from infrastructure flags alone.

Define and implement a workspace export that includes machine-readable JSON for chats, transcripts, events, projections, tasks, drafts, sourced memory entries and summary source links, and membership history, plus the generated XLSX. Define a reviewed deletion procedure for D1 records, R2 voice/workbook objects, provider credentials and scheduled jobs, with auditable completion/failures and a documented backup lifecycle. Do not assert an unverified instant backup purge. Confirm 14-day raw audio cleanup and that current members can access retained audio while removed members cannot.

## Operational and quality gates

Use staging with synthetic workspaces to run a two-member journey: Avi signs in and seeds Kerning; Hunor links Telegram; both send text and voice; one ambiguous name asks once; a conflict is visibly disputed; a correction and per-write undo preserve later work; the brief arrives once; a draft opens WhatsApp without claiming sent; /sheet yields a correct workbook; a teammate sees the other's full history; `/model` changes the current chat while leaving the teammate's model unchanged; a new chat recalls a prior workspace preference and relevant lead context with source links; a second workspace cannot retrieve either; correction, undo and forget update recall; provider outage gives accurate partial status. Repeat after Worker/actor restart and client offline/reconnect. Use production-like D1/R2/DO bindings but no real lead messages in automated tests.

Instrument run latency, acceptance-to-first-status, retries, duplicate suppression, wrong-write/undo rate, transcription corrections, model usage/cost per workspace and brief engagement. Measure the 5-second median text and 12-second median voice targets as targets, not promises; log network/model breakdown. Run Appendix A evaluation with a held-out multilingual set and report entity match >=95%, near-zero wrong writes, abstention rate, and exact failing examples without secrets. Do not tune only to seed fixtures.

## Proposed file map and verification commands

These paths are targets to create or extend; the repository has no source files at planning time. In scope: evals/reports/*; docs/operations/runbook.md, data-flow.md, release-checklist.md, browser-review.md; CI workflow files. Narrow defect fixes belong to their owning package and must be listed in the review.

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
