# Plan 012: Create editable outward drafts and a trustworthy XLSX view

> Executor: plans 002, 007 and 009 must pass. Read product.md sections 3.6, 5.1, 8.1, 9.1, 11 and 12.4. Otis drafts outward messages; it does not send them to leads. The XLSX is a generated view, not a source of truth. Check drift before work.

## Status

- Priority P1; effort M; risk medium; category workflow/export; depends on 002, 007, 009.
- Planned against scaffold revision `a3bd462` (2026-09-29); inspect current source/routes and migrations before implementation.

## Why and current state

A1 should record a task to send an offer, but no draft is created until requested. When asked, Otis can write and revise a message and open a prefilled WhatsApp handoff; opening the link does not prove delivery. A generated workbook lets the team inspect/filter business memory without maintaining another database. No draft or sheet generator exists after the core plans.

## Scope

Field-use quality addition (2026-10-03): drafts use the lead's known language, confirmed facts and useful concise phrasing. Revision is conversational; opening/copying WhatsApp never marks sent. Learn durable phrasing preferences only from explicit reusable guidance or a clearly durable confirmed correction through existing sourced workspace/member memory. A one-time wording edit, inferred personality or another member's style cannot silently become workspace policy. Keep unsent/draft-versus-confirmed-sent attribution distinct; disputed prices/dates require resolution before relying on them. Test repeated edit/undo, language mismatch, missing recipient details and memory scope; no fine-tuning service or automatic outreach.

Modify packages/ledger draft commands, packages/agent draft tool binding, packages/sheet, Worker authenticated export/download routes, R2 object lifecycle, Telegram /sheet integration, and tests. Do not implement WhatsApp Business Platform, send a third-party message, accept XLSX edits back into ledger, or add Google Sheets sync (Phase 2).

## Draft contract

`draft_message` requires an entity, intent and language resolved from explicit user request, then lead preferred language, then workspace default. Store body, author, source event and status `draft`. `update_draft` appends an attributed revision; do not overwrite prior history. The draft detail is visible in chat and can be revised conversationally. Construct a `wa.me` link only when an E.164-normalized usable phone number is present, with URL-encoded text. Otherwise the draft remains copyable; ask for a number only when the user requests WhatsApp handoff. Create drafts only when asked, never automatically for a note or brief. `mark_message_sent` requires the member's explicit confirmation and stores its source/time; opening/copying the link does not establish sending. No tool posts to a lead.

## Workbook contract

Build a new workbook from one consistent workspace snapshot: Leads rows with stable hidden entity ID, fixed name/status/next step/due/last contact/assigned member projections and later custom fields; Tasks with open items; Log newest first with event actor/time/source/provenance. Data from disputed fields must say disputed, never substitute last-confirmed as current. Use readable headers, frozen header/name, dates and money formatted clearly, no macros/links that execute code, and formula-injection protection for user-controlled cells. XLSX must survive sorting/filtering without losing entity mapping. `/sheet` produces a fresh R2 object and authenticated Worker download route. Enforce current membership on every request; a 15-minute ticket may narrow the download but does not replace membership checks. Do not return raw R2 presigned bearer URLs. Snapshot is not sync and has no edit-back in v1. Delete generated workbooks after the documented 24-hour retention window unless an explicit operational export policy specifies otherwise.

## Proposed file map and verification commands

Suggested implementation areas to map to live source: ledger-owned draft commands, pure sheet projection/workbook, authenticated Worker exports/downloads, retention job and integration tests. Plan 002 owns ledger semantics; this plan adds no second write path for drafts. Inspect installed spreadsheet packages and existing migrations before choosing libraries/paths.

Verification after plan 001 establishes the scripts: pnpm typecheck; pnpm lint; pnpm test; pnpm build. Parse the generated XLSX with an independent reader in tests and manually open one fixture file. Do not report a command as passed if it has not run. If a proposed path conflicts with the scaffold, preserve the module boundary and document the exact mapping before editing. Do not push or open a PR unless the operator asks.

## Steps and verification

1. Implement draft create/revise/confirm ledger operations and tool schemas. Test A1 no-draft-until-asked, language fallback, missing phone, encoded WhatsApp URL, explicit send confirmation, duplicate confirmation, and actor attribution. Verify no HTTP client sends to a lead.
2. Implement pure workbook projection from fixture ledger state. Verify fixed columns, hidden stable ID, Tasks and Log sheets, date/currency formatting, provenance/disputed markers, and malicious leading-formula text treated as text. Open generated workbook with a reader library in tests; do not only snapshot XML strings.
3. Add R2 generation/download and `/sheet` command/web link. Verify a wrong workspace, removed member and expired ticket cannot access the file; authorization is checked on every Worker download request; two concurrent exports do not leak rows; storage cleanup works. Check a real workbook in a spreadsheet viewer manually.
4. Run root typecheck, lint, tests, build and a browser/Telegram handoff smoke. Verify the web draft detail is conversation-adjacent and does not become a lead-edit form.

## Done criteria

The agent can create/revise a draft and record a member-confirmed send, but cannot send outward itself. Missing phone never produces a broken wa.me action. The workbook reflects ledger state, includes no other workspace's rows, and remains correct after sorting. A downloaded workbook is explicitly a snapshot.

## STOP conditions and maintenance

Stop if the spreadsheet library does not protect formula-like user text, if URL security cannot enforce membership/expiry, or if draft status is inferred from WhatsApp opening. Future Google Sheets edit sync needs its own provenance and conflict tests; do not smuggle it into this export plan.
