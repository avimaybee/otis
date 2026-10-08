> Closed historical plan record, reconciled 2026-10-07 from `plans/010-voice.md`. Family 010: source/local voice implementation; exact-device/provider acceptance open. Remaining R07, R14 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# Plan 010: Capture voice notes and return text with a correct transcript

> Executor: plans 007–009 must pass. Read product.md sections 5.1, 6.3, 8.6, 9.1, 12.2 and 17, plus design.md's composer and voice section. The user chose a text reply by default; do not add a live call or mandatory TTS. Check document drift before work.

## Status

- Priority P1; effort M; risk medium; category multimodal/UX; depends on 007, 008, 009.
- Planned against scaffold revision `a3bd462` (2026-09-29); actual device/browser/provider support remains unverified until measured.

## Why and current state

Hunor's field notes may be recorded while walking. The app needs record/stop/send, honest upload/transcription/processing states, and correction of uncertain words. Telegram supplies OGG/Opus voice messages; browser MediaRecorder output varies. Product.md caps audio at three minutes, stores raw audio for 14 days, and keeps transcript/history according to workspace retention.

## Scope

Read [010-voice-ux-handoff.md](010-voice-ux-handoff.md) for the 2026-10-03 recording contract: codec detection, ordered 1 s IndexedDB chunks, real meter/haptics, background interruption, validated recovery and actual Android/iPhone evidence. Reuse gate 008's one composer/local storage module. Exact visuals come from design-tokens.md; missing meter/voice recipes require Avi's decision. This supplements rather than replaces the STT handoff below.

Read [010-groq-stt-handoff.md](010-groq-stt-handoff.md) with this plan. It specifies the user-approved automatic native-audio/Groq STT route, zero-additional-spend constraint, credential integration, durable transcription lifecycle and decisive tests. This is part of gate 010, not a new prerequisite gate. Groq setup is shared per workspace; ordinary members do not choose a route for every recording. Native capability failure does not disqualify an otherwise approved text/tool conversation model.

Modify the live web composer, Worker upload/transcription handlers, provider adapter, R2 retention job, Telegram voice handler and tests. Do not implement live bidirectional speech, avatars, video, image upload or automatic spoken reply. The operator handpicks models; the capability gate enables audio only after the selected model/endpoint/format passes actual tests. If not, use an explicitly configured and disclosed transcription provider or make voice unavailable for that chat.

## Required flow

On web, request microphone permission only after a user taps record. Show elapsed time, measured level/waveform only if actually measured, distinct Cancel and Send, and the three-minute limit before it is reached. Preserve an unsent recording through temporary navigation/interruption only where browser storage permits; never label it saved until upload commits. Reuse stable message UUID on retry. Reject known over-limit input before fetching where possible. Actual duration cannot always be trusted from client metadata, so use a bounded private quarantine upload when byte inspection is needed. Keep quarantine inaccessible; do not transcribe or make business writes until validation succeeds. Delete invalid bytes promptly and retain required metadata only. Stream to R2 where possible. Associate the object with workspace/user/message IDs and check current membership on every fetch, including reads by teammates. Use an authenticated Worker stream and scoped short-lived ticket, never a public/raw R2 bearer URL.

After accepted upload, use the workspace's handpicked model directly only if plan 005 verified that exact model/endpoint accepts the recording format and returns a usable transcript. Otherwise use a separately configured and disclosed transcription provider; if none is configured, say voice is unavailable for the selected model before sending audio to any provider. Test Romanian/Hungarian names, money and dates. Persist transcript with source language and confidence/uncertainty metadata if available; do not invent confidence where provider lacks it. The agent receives attributed transcript plus a pointer to original voice, not an untrusted instruction from an attachment. The user sees transcript and can correct it conversationally; the correction adds an event and does not erase the original text. Text is the default answer on both channels. Raw audio is removed after 14 days or earlier on workspace deletion; cleanup is idempotent and reports failures.

## Proposed file map and verification commands

Suggested implementation areas to map to live source: web recorder/composer, authenticated Worker upload/finalize/media routes, provider transcription adapter, R2 retention job, Telegram voice handler and targeted integration/device evidence. Do not presume these files are absent or add a second chat/message schema. Inspect the scaffold and current provider SDK support first.

Verification after plan 001 establishes the scripts: pnpm typecheck; pnpm lint; pnpm test; pnpm build. Use injected clock/storage for the 14-day deletion test. Then manually review browser microphone permission, recording, cancel, upload, transcript correction, keyboard and mobile safe-area behavior in the Codex or Antigravity browser; record results in docs/browser-review.md. Do not add browser automation. Do not report a command as passed if it has not run. If a proposed path conflicts with the scaffold, preserve the module boundary and document the exact mapping before editing. Do not push or open a PR unless the operator asks.

## Steps and verification

1. Build web recorder states and unit tests for duration limits and upload state transitions. Manually inspect permission denied, short recording, cancel, interruption, three-minute boundary, upload retry, keyboard/safe-area layout and no decorative fake waveform in a native browser session at 360/390 px.
2. Add authenticated upload and R2 object lifecycle. Verify wrong workspace cannot upload/fetch, MIME spoof and oversized/over-duration files are rejected before transcription, same UUID retry does not make a second message, and rejected attachments are not retained.
3. Spike actual Telegram OGG/Opus with the chosen transcription API. If unsupported, test a Worker-compatible conversion or a dedicated small processing service; document cost and latency before adopting it. Verify synthetic and user-approved sample voice notes and no silent empty transcript.
4. Connect transcript → agent → text reply and 14-day cleanup. Test uncertain-name clarification, corrected amount, partial provider failure, deletion of expired audio with transcript retained, and per-channel same ledger attribution. Run root checks and browser voice tests.

## Done criteria

Both channels accept <=3-minute supported voice notes, display a real transcript, allow correction, and answer in text. States clearly separate local, uploaded, transcribing and agent work. Unsupported format or long duration receives a precise explanation and creates no business write. Raw audio deletion is tested with a clock fixture.

## STOP conditions and maintenance

Stop if no tested transcription path handles Telegram OGG/Opus within viable latency/cost, if browser recording cannot survive the interruption behavior promised in product.md, or if R2 objects cannot be reliably deleted. Report the narrowest product adjustment rather than pretending to support a format. Official audio reference: https://ai.google.dev/gemini-api/docs/audio
