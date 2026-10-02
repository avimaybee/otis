# Gate 010 handoff: automatic native audio and Groq transcription

Decision recorded 2026-10-01. Execution supplement to [010-voice.md](010-voice.md). Keep the original dependency order; do not start a separate voice project ahead of foundations. Current source and migration state must be inspected when 010 begins.

## Outcome and scope

Members record/send a voice note without choosing speech infrastructure. Otis selects a verified native transcription route when the conversation model supports the actual format; otherwise it uses configured Groq STT and gives the selected model the transcript. Native audio capability is not required for text/tool-model approval. The selected conversation model remains unchanged.

Groq is a server-side transcription integration only. It does not imply Groq chat-model support, TTS, live calls, translation, a generic provider router or public file hosting. Reuse the existing Worker, encrypted workspace credential store, D1, private R2, durable outbox/queue patterns, media lifecycle and actor. Do not add a GPU server, vector service, second message schema or install FFmpeg speculatively.

Read AGENTS.md, product.md voice/provider policy, architecture section 13, contracts media/routing/commands, Plan 005 and its capability matrix, Plan 010 and design.md voice states. Preserve accepted foundations and unrelated changes. No commit/push/deploy or paid-account change without separate authorization.

## Settled inputs

- Conversation providers remain Gemini and OpenCode Go with operator-approved models.
- Selected STT candidates: `whisper-large-v3-turbo` and `whisper-large-v3` on Groq.
- Recommend benchmarking Turbo first; the default is selected from accuracy/latency evidence, not assumed approved from this recommendation. Large V3 is an explicit alternative, not an automatic second pass on every note.
- Credential and STT configuration are shared per workspace. All current members have existing equal-access semantics; raw keys remain write-only.
- No extra inference spend: use the existing Go subscription and free Gemini/Groq access. On exhaustion, retry within bounds or report failure; no paid fallback, upgrades or key/account rotation to bypass quotas.
- Raw audio remains private and retained for 14 days. Three-minute and existing 20 MiB/lower-provider/channel byte limits remain in force.
- Text replies are default; native model support does not authorize audio generation.

## Route resolver: simple deterministic branches

Implement one resolver using the selected registry entry, verified per-format transcript capability, validated media metadata and workspace STT configuration. Gate 005 supplies the interface/capability representation; 010 completes integration.

| Condition | Result |
|---|---|
| Exact selected native endpoint accepts actual format and supplies usable transcript; current credential valid | `native` |
| Native unsupported/unverified for format, and Groq candidate/configuration/credential verified | `groq_stt` |
| Neither path usable | `unavailable`, with a safe explanation |

Do not probe support on every recording, infer it from model names, or send bytes to multiple services to discover a winner. Native authentication, quota and outage errors are not unsupported capability. They produce their own error; do not reroute silently. If another route is desired, ask conversationally or let the member explicitly change configuration. Groq fallback from a known unsupported/unverified native route is already authorized by workspace setup; do not ask per message.

Snapshot conversation model, route and registry version at acceptance; confirm against server-validated actual format before inference. If metadata invalidates the preliminary route, finalize an authorized compatible route before sending anything, or fail clearly. `/model` affects future turns, not a pending recording. Report effective voice support through configured STT separately from native support.

## Credential and setup integration

Extend the existing provider credential allowlist/types/validation to support `groq` as an STT-only provider. Inspect every exhaustive switch, contract serializer, metadata route and fixture before changing the enum. Preserve AES-GCM workspace/provider/version AAD and member rechecks. Do not create a parallel raw-key table or a browser VITE key. Conversation adapters must not treat every credential provider as a chat provider.

Store minimal workspace STT settings: enabled, provider `groq`, selected approved STT model. Add a migration only for absent fields after inspecting current numbering. Expose status/configuration, never ciphertext, nonce or key. Setup clearly states when Groq receives recordings and keeps the regular composer uncluttered. Never repurpose workspace `default_model` to mean the speech model.

Verify current key against fixed Groq endpoints using an authorized bounded synthetic test. Authentication/discovery alone does not verify transcript quality. Credential replacement resets verification and stale verification of key A cannot mark key B valid; reuse the provider-gate race protection. Membership must still exist when configuration commits.

## Groq transport

Use the fixed `https://api.groq.com/openai/v1/audio/transcriptions` endpoint. Send validated private bytes as multipart upload with the configured model, original filename/MIME, temperature 0, and JSON or verbose JSON. Prefer verbose JSON when metadata is useful. Do not manually set the multipart boundary. No public R2 URL, client-supplied provider origin, or arbitrary remote fetch.

Use transcription, not the English translation endpoint. Preserve original English/Romanian/Hungarian and code-switching. Language hint is optional; force one only when reliably specified. A short approved vocabulary hint may help names; do not include full business history or use the hint to dictate facts. Returned log probabilities/silence metrics are evidence aids, not calibrated certainty scores.

Official documentation lists WebM, MP4/M4A and OGG upload support; actual device/container/codec tests are still required. Enforce the lower verified byte limit, not the playground's displayed limit alone. Avoid transcoding until an actual supported-format failure proves a need. Test silence, corrupted bytes and empty transcript. Transcription output is member-attributed derived text; it is not permission to bypass existing clarification/tool policies.

## Durable pipeline on Cloudflare

1. Accept with existing stable message UUID/channel dedupe. Record attribution and a private media identity. Upload/quarantine validation follows Plan 010; known over-limit input never reaches STT.
2. Persist route/configuration snapshot and durable transcription intent before returning an accepted acknowledgment. Expose honest upload/transcribing/ready/error state. Use the existing media states rather than a competing lifecycle.
3. Claim the transcription job using conditional ownership and expiry. Keep external inference outside the workspace business-turn lease so Hunor's note does not block Avi's text turn. Use existing job/outbox infrastructure with a narrow handler; no extra queue is necessary solely for STT.
4. Recheck authorization/media validity before sending private bytes. Credentials are decrypted server-side. Pin the transcription model for this job; configuration changes affect future notes.
5. Commit a transcript receipt conditionally against current attempt/media identity and membership, including provider/model, source language if returned, safe uncertainty/timing data and correlation IDs. Do not let a stale attempt overwrite a successor. Never log text/audio/raw upstream bodies.
6. Atomically mark ready and create/release the existing agent dispatch intent. Agent retries/reconnects reuse the committed transcript. Recovery can reconstruct missing dispatch intent from durable state. Do not create a second logical agent run for a retry.
7. Native transcription follows the same readiness/receipt contract. Plan 010 keeps transcript generation separate from business writes even if the native provider can generate function calls from audio.

Idempotency is local logical exactly-once, not guaranteed provider inference exactly-once. A lost response after Groq accepted a request may require another bounded transcription request. An already committed transcript must not be retranscribed. Use stable source/media/route identity; per-attempt random IDs do not replace the logical receipt key. Tests must distinguish external requests from canonical transcript/agent effects.

A removal/erasure during inference prevents transcript publication or new agent work; follow workspace media cleanup rules. A Stop during transcription cancels future work when possible and rejects late publication. Already committed business actions follow existing Stop/Undo semantics.

## Quotas, retry and zero-spend behavior

The user's screenshot and Groq docs checked 2026-10-01 show each Whisper entry at 20 RPM, 2,000 RPD, 7,200 audio seconds/hour and 28,800 audio seconds/day. This is 2 hours/hour and 8 hours/day of audio, not 2,000 arbitrary-length notes. Limits are organization-scoped; do not multiply them per member/key or assume model quotas can be pooled to bypass limits. Treat the current account console/headers as authoritative over copied documentation.

Count requested audio duration and request attempts as separate bounds. Named local limits prevent avoidable bursts; they are not an exact mirror of all organization activity outside Otis. Respect 429 and Retry-After when supplied, use existing bounded retry defaults, and preserve an accepted note with visible status. Do not invent reset time or promise a background retry after the audio retention deadline. If no safe retry fits bounds, explain typing/retry-later options. No silent truncation or partial business writes.

Keep account on its explicitly designated free setup. Do not upgrade, enable paid balance fallback or attach billing as an implementation convenience. Free-tier caps are capacity limits, not a perpetual service guarantee.

## UX and privacy

Member records and sends normally. Working activity can say `Transcribing with Groq` or the native provider; collapse with other work after completion. Transcript remains inspectable/correctable. No routing selector in the ordinary composer and no confirm-every-note flow.

Ask specifically about uncertain business-critical content, such as names, amounts or dates. Do not require confirmation of every clean transcript. Preserve original transcript and source when corrected; existing conversational correction/ledger rules apply. Teammates can read retained audio/transcript under existing workspace access rules. Provider-only confidence/signature blobs never appear as model thoughts.

## Tests and acceptance

| Test | Required result |
|---|---|
| Verified native format | No Groq request; native transcript saved before business dispatch |
| Unsupported or unverified native format | Configured verified Groq selected; conversation model unchanged |
| Missing STT configuration/key | Voice unavailable; no unauthorized provider request |
| Native 401/429/5xx | Correct error, no automatic cross-provider reroute |
| Concurrent redelivery | One canonical transcript and one logical run/dispatch |
| Crash before/after receipt | Recover pending work or reuse saved transcript; no duplicate business effect |
| Stale transcription attempt | Cannot overwrite successor transcript or enqueue another run |
| Model/config changes mid-job | Accepted snapshot preserved; next note uses new selection |
| Removal/Stop/erasure mid-inference | No late publication or unauthorized agent work |
| Cross-workspace media/key IDs | Reject before external audio request |
| Long/oversized/corrupt recording | No STT/business writes; invalid quarantine cleaned |
| Groq quota/timeout/empty transcript | Visible bounded failure; no paid fallback or invented text |
| Original-language transcription | Romanian/Hungarian/code-switching preserved; not translated to English |
| Device/Telegram formats | Real Android/iPhone/OGG samples produce usable names, amounts and dates |
| Audio expiry | 14-day deletion idempotent; transcript/history policy preserved |

Use fake transport in routine CI, real workerd/D1/R2 integration for receipts/recovery, and authorized synthetic/user-approved samples for provider/device evidence. Live tests are opt-in and bounded. Never put customer recordings or API keys in Git. Compare Turbo and Large V3 on the same approved corpus and report accuracy on business-critical tokens plus latency; no absolute performance guarantee from provider benchmark ratios.

Run root typecheck/lint/test/build and diff checks, plus Plan 010 native-browser/device review. Do not use Playwright. Leave source reviewable; report implemented schema/routes/contracts, effective voice availability, Groq model choice and evidence, deterministic test counts, actual device/provider evidence or specific blockers, quotas/errors and remaining limitations. Text-only provider support is not proof that voice is complete.

## References

- [Groq speech to text](https://console.groq.com/docs/speech-to-text): models, multipart endpoint and supported upload formats.
- [Groq rate limits](https://console.groq.com/docs/rate-limits): request/audio-duration limits and organization scope.
- [Voice capture plan](010-voice.md), [provider foundation](005-provider-spike.md), [capability evidence](../docs/decisions/provider-capabilities.md).

References checked 2026-10-01; implementation rechecks exact API/schema/limits. These links and screenshot are documentation evidence, not verified Otis integration.
