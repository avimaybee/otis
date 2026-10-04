# Plan 011: Member-chosen briefs and explicit reminders

Planned against a3bd462, revised 2026-09-29. Status: TODO. Depends on 002, 007 and 009. Read product.md section 10, contracts dates/schedules and architecture section 14. **No enabled default schedule or hardcoded 09:00.**

## Outcome

Each member can say when and where they want their brief, change/disable it, and ask /today at any time. Scheduled work appears once from actual records, not invented tasks or inferred deadlines. Explicit one-off reminders are separate jobs.

## Scope/files

Suggested implementation areas: brief selection/time/delivery, Worker scheduled handler, schedule settings, web/Telegram delivery and tests. This gate must deliver chosen-time briefs and explicit reminders. Keep push notifications, automatic overnight drafts and dashboard out. Keep opportunistic/missed-logging follow-ups disabled unless the open D17 product decision is resolved in favor; its outcome must not change brief scheduling correctness.

## Implementation

1. Store brief schedule per member/workspace: enabled false initially, chosen local time/timezone/weekdays/channel and revision. Conversation/settings update the same service. Ask for missing/ambiguous time; never resolve a null time to 09:00.
2. Implement injected-clock due calculations with IANA timezone. Spring-forward next valid instant; fall-back first. Changing schedule must not recreate an already-generated daily brief. Disabled schedules generate nothing.
3. Select up to five distinct items deterministically: due explicit promises, due tasks, explicitly undated next actions, stale warm/hot leads. Missing-date clarifications are not undated tasks. Existing lead status inferred from sentiment cannot enter ranking as a committed change.
4. Use typed last-contact semantics, snooze handling, stable ties, currency-safe value comparisons and reason/source IDs. A promise is a typed reason, not keyword matching. Do not create member commitments from stale-sweep inference.
5. Persist one canonical brief using unique workspace/member/local-date/scheduled_daily. Store selected item IDs so 'the second one' resolves to what was shown. Model may phrase only those selections; deterministic copy is fallback when unavailable.
6. Canonical web message plus selected outward channel. Web means in-app, not closed-browser push. No items means no scheduled notification; on-demand /today still answers.
7. Delivery outbox distinguishes known failure from unknown Telegram send outcome. Never blindly retry an uncertain send or claim internal idempotency guarantees external exactly-once behavior.
8. Explicit one-off reminders require confirmed date/time (or an existing explicit member reminder-time preference). Give them separate job/dedupe IDs; changing/cancelling task invalidates stale reminder attempts.
9. Stale-sweep candidates/system suggestions use reason-key dedupe. Any system task is visibly rule-originated; missing assignee/date must be clarified before creating a member commitment.

## Field-use quality addition, 2026-10-03

Each of the at-most-five items states a concrete selection reason, due date where known and a source reference: for example, an explicit promised offer due on the member's local date. Reasons derive from records and ranking, not invented explanatory model text. Show confirmed status only; disputed facts cannot support a confident brief/draft. Saved item IDs/order resolve did the first one even after live ranking changes.

Working optional actions are Done, Draft, Move and Snooze. They invoke shared authorized services; ordinary conversation remains sufficient. Move changes due; Snooze changes notification timing under the date contract. Missing times ask. Draft is generated only when requested. Missing lead phone or language asks narrowly where needed; opening WhatsApp is not sent. Test edited/completed/disputed items between brief generation and action, and no unrelated teammate change lost.

Chosen-time/channel opt-in stays unchanged. No automatic Telegram preference, browser push, one unsolicited nudge/day or ignore-three auto-policy is enabled by a narrative example. D17 remains unresolved; chosen brief plus explicit requested reminders are the current allowed interrupt budget. No-items scheduled silence is intentional. Opt-in end-of-day wraps are deferred until their schedule/kind/frequency contract is approved.

## Verification cases

Pure tests: disabled schedule, arbitrary chosen time, weekdays, timezone midnight, both DST changes, schedule edits, date-only due, precise instant due, explicit no-deadline, snooze, promise overlap, disputed facts, same-rank ties and currency mismatch.

Workers tests: repeated/concurrent cron yields one canonical brief; separate members/timezones; /today without schedule; empty candidates no send; known/unknown delivery; exact saved-item reply mapping; canceled reminder never delivered; duplicate stale reason produces no duplicate commitment.

Run root typecheck/lint/test/build. Record the member schedule used in synthetic live Telegram/web smoke. Do not claim a morning-default implementation meets this plan.

Stop if any path invents a missing date/time, duplicates a brief or marks unknown delivery successful. Any proactive trigger beyond a chosen schedule or explicit reminder requires D17 resolution and its own consent, frequency, ordering and dedupe tests.
