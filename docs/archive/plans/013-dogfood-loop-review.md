> Closed historical plan record, reconciled 2026-10-07 from `plans/013-dogfood-loop-review.md`. Family 013: release gate incomplete; export/erasure and actual field proof open. Remaining R11, R13, R14 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# Reviewer: product loop and field-use acceptance

2026-10-04. Assessment of the attached product-gap audit, checked against live source and existing decisions. Complements gates 007–013; does not add a CRM, paid service, new product role or automatic deadline policy. Source changes are not assigned by this document.

## Confirmed incomplete work
- Gate 009 full Telegram receive/commands/callbacks/reply delivery remains TODO. Current inbound acceptance is not full channel support; missing wake plus missing outbound send must be fixed before channel acceptance.
- Gate 010 browser recording, retained playback and integrated native-audio/STT ingestion remains TODO. A provider voice-routing policy exists, so claiming every audio foundation is zero percent built is inaccurate; claiming usable voice today is equally inaccurate.
- Gate 011 chosen-schedule briefs/reminders remains TODO. Settings fields do not constitute a scheduler or completed resurfacing experience.
- Gate 012 private XLSX is unbuilt; packages/sheet contains interfaces. V1 is an export snapshot, not live Google Sheets synchronization.
- Query tools and /today exist; data is not literally unreachable. No finished lead/task directory exists. Use approved conversational result/detail surfaces and the chosen brief rather than inventing an unapproved dashboard.

## Preserve explicit user decisions
- Explicit complete instructions save directly. Missing or ambiguous dates ask; inferred lead status changes ask. Do not invent next Tuesday at 10:00 or automatically mark positive sentiment warm.
- A task may have a date-only deadline; do not demand a clock time when a date suffices. Precisely timed reminders need a time, or an existing explicit reminder preference.
- Save unambiguous facts even when a separate task awaits one missing detail. Ask the narrow missing question conversationally. Current Transcript already renders pending clarification inline; the attachment claim that every question is a blocking modal is false for current source.
- Briefs are disabled until each member chooses time/timezone/weekdays/channel. No 08:30 or 09:00 default.
- Recorded voice first; text replies default. Audio output is not a prerequisite for dogfood.
- Strict approved visual tokens/shadcn remain in force. No new lead directory/dashboard recipe without a material product/design decision.

## Reproduced multilingual gap
- Actual policy.ts status guard is largely English, while context.ts carries preferredLanguage/timezone/date and quote handling explicitly supports RON minor units. An English system prompt is not proof that a multilingual model cannot understand Romanian/Hungarian.
- Reviewer artifact: plans/008-browser-evidence/multilingual-status-policy-probe.json runs the current policy directly. English Set Bistro 24 to warm passes; Romanian Marchează Bistro 24 ca warm and Hungarian Jelöld a Bistro 24-et warm státuszúnak fail. English Set Bistro 24 to warm. The offer is not ready yet also fails because negation anywhere in the source blocks the status directive.
- Plan a bounded intent-policy repair/evaluation preserving explicit authorization and target scope. Do not disable checks or replace them with unverified model discretion. Include diacritics, mixed languages, direct directives, negated directives, unrelated negation, quoted customer content and adversarial forwarded text.

## Dogfood acceptance journey (evidence, not story-only)
1. Avi and Hunor sign in on Android Chrome and iPhone Safari; account/workspace attribution and teammate historical visibility correct. Validate mobile auth fallback and standalone limitations with device evidence. Firebase docs prefer redirect on mobile, but redirect needs the correct domain/storage configuration; changing one function blindly is insufficient.
2. A recorded ro/hu/en note about a real synthetic lead is accepted and shows saving/saved states promptly; Android/iPhone/Telegram formats verified. Selected model receives verified native audio or the bounded Groq transcript path. Provider limits/failure keep retryable accepted input; no paid fallback.
3. Explicit facts are filed once with source and right author. A vague next-week followup asks which day, while an explicit Monday date becomes date-only unless a time was requested. Interest remains a factual observation until status is confirmed.
4. Answer is readable during streaming. Working summarizes actual saved actions; questions are brief inline and do not hold the workspace slot. Teammate reads the same saved result; interrupted recording/upload/run paths recover honestly.
5. Ask what is due or what was logged this week in ordinary conversation; /today is optional. Return actual records and references with appropriate local formatting, not a database dump or an invented summary.
6. Opt in to a chosen brief schedule; receive at most one canonical brief on the chosen days/channel. No items means scheduled silence; no hardcoded morning, no inferred commitments. Telegram response and brief send handle known versus unknown outcomes without blind resend.
7. Request XLSX; get current authenticated snapshot. Local edits are not claimed to sync back. Remove membership and prove old access fails.
8. Correct a quote, Undo from here, reopen/reconnect and recover saved state without rewriting independent teammate work or replaying external sends.

## Delivery priority

Superseded execution order: [013-dogfood-execution-order.md](013-dogfood-execution-order.md), reviewer-authored 2026-10-04. Close the current cost patch, then prove text capture/reply/retrieval under 009; full web transport is not a prerequisite for that Telegram slice. The earlier bullets below describe remaining work, not a requirement to finish all foundations first.
- Complete current 015A.1 ledger cost patch and 014 live transport so ordinary conversation is usable within free limits.
- Finish one end-to-end text channel path (web plus full Telegram) with immediate wake and actual reply delivery, not schema-only evidence.
- Implement existing 010 voice handoff with browser recording and selected native/STT route, then chosen briefs and XLSX under 011/012.
- Treat the coherent capture -> filed facts -> retrieved followup -> chosen brief/export journey as release evidence. No additional speculative foundation or automatic business policies.
