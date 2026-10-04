# Voice and brief integration review checkpoint

Recorded by reviewer on 2026-10-04, 22:01 Asia/Calcutta. This is a checkpoint, not gate acceptance.

## Release already available

Baseline `b9f667a` was pushed. Remote migrations 0010 and 0011 were applied. Cloudflare deployment `74de611f-379d-4ba6-b0f4-7f411f2a54c6` exists. Public HTML and its current JavaScript returned HTTP 200; the bundle contains both stopped and failed partial-response labels. This is asset evidence, not authenticated browser acceptance. Earlier preflight statements saying this baseline is unshipped are historical.

## Active ownership

- Original OpenCode `ses_f03ab0129ffeAosuk1THki88Ha`: worker entrypoint integration and new voice entrypoint tests; mount media dispatcher, prompt transcription wakeups, bounded recovery/retention.
- Backend `ses_ef948d524ffe47LpHeq2z21FOq`: media routes/storage/transcription, credentials/settings/contracts, migration 0012, backend tests.
- Composer `ses_ef948d47dffercBJekwRI6bjWy`: all necessary web recorder/upload/outbox integration and scoped tests. Extend existing outbox; do not create a separate voice outbox.
- User agent 2 `ses_ef94770caffe7BO8eImuFO4gxI`: only packages/brief kernel and tests. Preserve Muse Spark 1.3 Contributor/Xhigh.

User authorizes overnight coordination and roughly 30-minute check-ins, necessary reviewed migrations and coherent commit/push releases. Do not orchestrate or message Antigravity. Preserve unrelated QA artifacts and queued 008C. No Codex subagents. Never publish unfinished parallel code or secrets.

## Findings already sent to their owners

1. Groq timeout must cover response body, not only response headers; clean up abort listener. Test stalled response body and cancellation.
2. Client settings cannot self-certify verified audio formats. WAV credential probe does not prove WebM/MP4/OGG. Current DTO rejects client verified_formats, but complete evidence path still needs review.
3. Upload creation must reuse stable client message identity; retry cannot create another media/R2 object. PUT/finalize retry after lost response must reconcile the existing state.
4. Actual duration must enforce three minutes. Browser WebM often lacks Info.Duration: support actual browser containers without trusting declared duration or rejecting the normal Android path. Current parser requires further verification.
5. Native route availability must match implemented processing. Current transcription processor rejects non-Groq jobs; accepting native audio into that processor is not a working route.
6. Recorder send currently deletes local session before its void onSent callback durably accepts the message. Await existing scoped outbox acceptance before deleting; preserve recording on failure, stable UUID on retry, and guard scope/logout during slow upload.
7. Brief comparator using amount only for same currency and ID otherwise is non-transitive. Counterexample equal group/age: A=z/RON100, B=m/EUR50, C=a/RON10. Add mixed-currency permutation/transitivity tests and total ordering.
8. Schedule resolution scans 240 prior minutes and constructs new Intl formatters on ordinary evaluations. Actual transpiled implementation measured 10 Bucharest evaluations at 258ms locally. Reuse formatters, skip already-generated/unselected days early, avoid ordinary minute scan while retaining DST tests. This is CPU cost, not D1 writes.

## Integration acceptance still required

Review final code, not only reports. Verify recorder -> upload -> durable message -> prompt transcription -> agent reply, retries, playback/retention, exact-format availability and Stop. Verify existing text/commands still work. Run coordinated root verification after peers finish shared edits; scoped tests during implementation. Do not call fake recorder/container/provider tests Android/iPhone or real Groq quality evidence. Production browser/device acceptance remains separate.

Brief kernel alone does not implement scheduled delivery: chosen schedules, canonical daily persistence, existing outbox/channel delivery and saved-item follow-up mapping remain required integration. No automatic morning fallback or unsolicited reminders.
