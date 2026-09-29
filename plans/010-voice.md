# Plan 010: Capture voice notes and return text with a correct transcript

> Executor: plans 007–009 must pass. Read product.md sections 5.1, 6.3, 8.6, 9.1, 12.2 and 17, plus design.md's composer and voice section. The user chose a text reply by default; do not add a live call or mandatory TTS. Check document drift before work.

## Status

- Priority P1; effort M; risk medium; category multimodal/UX; depends on 007, 008, 009.
- Planned at unversioned document snapshot, 2026-09-29.

## Why and current state

Hunor's field notes may be recorded while walking. The app needs record/stop/send, honest upload/transcription/processing states, and correction of uncertain words. Telegram supplies OGG/Opus voice messages; browser MediaRecorder output varies. Product.md caps audio at three minutes, stores raw audio for 14 days, and keeps transcript/history according to workspace retention.

## Scope

Modify apps/web composer, Worker upload and transcription handling, packages/agent transcription adapter, R2 retention job, Telegram voice handler, and deterministic unit/Worker tests. Do not implement streaming bidirectional speech, avatars, voices, video, image upload, or automatic spoken reply. Do not pass raw audio to OpenCode Go without a tested audio capability; a separate transcription provider is allowed.

## Required flow

On web, request microphone permission only after a user taps record. Show recording elapsed time, actual level/waveform only if measured, distinct Cancel and Send, and a three-minute limit visible before it is reached. Preserve an unsent recording through a temporary navigation/interruption if browser storage allows; never label it saved to workspace until upload succeeds. Use stable message UUID. Validate media MIME/type, size and duration server-side; reject over-three-minute clips without truncation or transcription and retain metadata only. Stream to R2 where possible rather than buffering a large blob in Worker memory. Associate R2 object with workspace/user/message IDs, verify current workspace membership on fetch (not only the original author), and use a short-lived retrieval path, not public bucket URLs.

After accepted upload, use the workspace's handpicked model directly only if plan 005 verified that exact model/endpoint accepts the recording format and returns a usable transcript. Otherwise use a separately configured and disclosed transcription provider; if none is configured, say voice is unavailable for the selected model before sending audio to any provider. Test Romanian/Hungarian names, money and dates. Persist transcript with source language and confidence/uncertainty metadata if available; do not invent confidence where provider lacks it. The agent receives attributed transcript plus a pointer to original voice, not an untrusted instruction from an attachment. The user sees transcript and can correct it conversationally; the correction adds an event and does not erase the original text. Text is the default answer on both channels. Raw audio is removed after 14 days or earlier on workspace deletion; cleanup is idempotent and reports failures.

## Proposed file map and verification commands

These paths are targets to create or extend; the repository has no source files at planning time. In scope: apps/web/src/components/VoiceComposer.tsx; apps/web/src/lib/recording.ts; apps/worker/src/routes/voice.ts; apps/worker/src/voice/transcribe.ts, retention.ts; packages/channels/src/telegram/voice.ts; apps/worker/test/voice.integration.test.ts; docs/browser-review.md.

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
