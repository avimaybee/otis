> Historical record, archived 2026-10-07 from `docs/decisions/provider-capabilities.md`. Its claims apply to the original baseline. Use [current implementation status](../../../status.md) for active work; old proposals and DONE labels are not current authority.

# Provider capability evidence

Status: **production registry published for 6 proven models; review follow-up resolved**. See [live evidence report](../../../005-live-provider-evidence.md). All 6 original models verified live on 2026-10-01 for streaming text, usage reporting, faithful tool invocation, tool-result continuation, and repeated-prefix comparison using the validated tool loop. `PRODUCTION_REGISTRY` publishes `gemini-3.1-flash-lite`, `mimo-25`, `mimo-26-pro`, `deepseek-v4.1-flash` (proven 2026-10-03), and — enabled at operator direction on 2026-10-03 after a fresh passing smoke under the strict validator — `muse-12` and `muse-13`. `gemini-3.5-flash-lite` remains unverified. `glm-5.3-flash` (failing smoke) and `gpt-6-luna` (smoke blocked by account rate limits) were trialed on 2026-10-03 and removed at operator direction; both stay out until a passing full smoke. Native audio remains unverified on device codecs (effective voice routes through Groq STT per Gate 010). Plan 005 owns this file. Do not fill it from marketing claims or a provider model list.

The operator handpicked the following six models on 2026-10-01 for implementation and verification, including audio input. A workspace connects Gemini and OpenCode Go using its shared server-side credentials. Evidenced capabilities are published for proven models; no workspace default was chosen. Command keys below are initial implementation identifiers, matching provider API IDs.

| Command key | Provider / exact model | Endpoint family | Text / tools / stream | Public summary | WebM / MP4 / OGG transcript | Usage / cached tokens | Date / evidence | Availability |
|---|---|---|---|---|---|---|---|---|
| gemini-3.5-flash-lite | Gemini / `gemini-3.5-flash-lite` | Interactions `POST /v1beta/interactions` (`stream:true`, SSE, `x-goog-api-key`, `Api-Revision: 2026-05-20`) | Verified live (3826ms text, 4282ms tool, 2-step continuation) | Surfaced safely (`thought_summary` only; signatures never exposed) | Documented; native codec tests pending (Groq STT verified) | Verified live (`total_tokens`, `prompt_tokens`, `response_tokens`) | Live smoke passed 2026-10-01 (19.62s total) | Unverified in PRODUCTION_REGISTRY pending review acceptance |
| gemini-3.1-flash-lite | Gemini / `gemini-3.1-flash-lite` | Interactions, same endpoint | Verified live (4714ms text, 5649ms tool, 1-step continuation) | Surfaced safely (same rule) | Documented; native codec tests pending (Groq STT verified) | Verified live (same mapping) | Live smoke passed 2026-10-01 (23.61s total) | Approved and published in PRODUCTION_REGISTRY |
| mimo-25 | OpenCode Go / `mimo-v2.5` | Chat Completions `POST /v1/chat/completions` (SSE, Bearer, `x-opencode-session`, UA `otis/0.1.0`) | Verified live (10177ms text, 2943ms tool, 1-step continuation) | N/A (no public-summary field on this family) | Go endpoint unverified; Groq STT verified | Verified live (OpenAI usage shape) | Live smoke passed 2026-10-01 (19.56s total) | Approved and published in PRODUCTION_REGISTRY |
| mimo-26-pro | OpenCode Go / `mimo-v2.6-pro` | Chat Completions, same endpoint | Verified live (2812ms text, 2353ms tool, 1-step continuation) | N/A (same) | Go endpoint unverified; Groq STT verified | Verified live (same mapping) | Live smoke passed 2026-10-01 (11.09s total) | Approved and published in PRODUCTION_REGISTRY |
| muse-12 | OpenCode Go / `muse-spark-1.2-contributor` | Responses `POST /v1/responses` (SSE, same headers) | Verified live (6041ms text, 3362ms tool, stateless continuation); re-verified 2026-10-03 (3530ms text, 2635ms tool, 1-step success continuation) | N/A | Go endpoint unverified; Groq STT verified | Verified live (documented Responses usage shape) | Live smoke passed 2026-10-01 (21.34s) and 2026-10-03 (~14s) | Enabled in PRODUCTION_REGISTRY 2026-10-03. Training: yes; retention: not ZDR |
| muse-13 | OpenCode Go / `muse-spark-1.3-contributor` | Responses, same endpoint | Verified live (5769ms text, 6488ms tool, stateless continuation); re-verified 2026-10-03 (4296ms text, 4188ms tool, 1-step success continuation) | N/A | Go endpoint unverified; Groq STT verified | Verified live (same mapping) | Live smoke passed 2026-10-01 (27.86s) and 2026-10-03 (~19s) | Enabled in PRODUCTION_REGISTRY 2026-10-03. Training: yes; retention: not ZDR |
| deepseek-v4.1-flash | OpenCode Go / `deepseek-v4.1-flash` | Chat Completions `POST /v1/chat/completions` (SSE, Bearer, `x-opencode-session`, UA `otis/0.1.0`) | Verified live 2026-10-03 (strict validator: text success with usage, validated `echo_fixture` tool_handoff, 1-step success continuation; ~10s total) | N/A (no public-summary field on this family) | Native audio unverified (voice notes transcribe via configured Groq STT; replies are text) | Verified live (OpenAI usage shape) | Live smoke passed 2026-10-03 | Approved and published in PRODUCTION_REGISTRY. Training: not used; retention: 0 days (DeepSeek ZDR through 2026-10-31) |
| gpt-6-luna | OpenCode Go / `gpt-6-luna` | Responses `POST /v1/responses` (SSE, same headers) | Not established: smoke blocked twice by HTTP 429 rate limits (~1s rejections, 2026-10-03) | N/A | Native audio unverified (Groq STT route applies once enabled) | Not observed | Smoke blocked 2026-10-03, retry after 120s still 429 | Removed from PRODUCTION_REGISTRY at operator direction (was fail-closed unverified); re-add only after a passing full smoke. Training: not used; retention: 30 days abuse-monitoring logs |
| glm-5.3-flash | OpenCode Go / `glm-5.3-flash` | Chat Completions, same endpoint | Failed 2026-10-03: every tool-less text request rejected HTTP 400 (`invalid_request`, ~1s); tool-ful requests succeed (validated `echo_fixture` tool_handoff, 45-delta success continuation) | N/A | Native audio unverified | Observed only on tool-ful turns (OpenAI usage shape) | Smoke failed 2026-10-03 | Removed from PRODUCTION_REGISTRY; do not re-add without a passing full smoke. Training: not used; retention: 0 days |

Live smoke is opt-in (`pnpm smoke:providers` with `OTIS_SMOKE_PROVIDER`, `OTIS_SMOKE_MODEL`, and designated local keys). All 6 models have completed live verification across streaming text, faithful tool invocation, tool-result continuation, usage reporting, and repeated-prefix comparison with the validated tool loop harness. Native audio on device codecs remains pending (routed to Groq STT).

## Documentation evidence checked 2026-10-01

### Groq STT selection and effective voice support

The operator approved automatic native-preferred/configured-Groq routing on 2026-10-01. Native audio support is distinct from effective voice availability: an approved text/tool model can receive persisted transcripts from Groq. Do not mark the conversation model's native audio cell supported merely because the STT route works. Gate 005 supplies capability/resolver contracts; gate 010 implements the route and credential integration. See [Groq handoff](../../plans/010-groq-stt-handoff.md).

| STT provider / exact model | Role | Documentation | Otis live/device evidence | Default |
|---|---|---|---|---|
| Groq / `whisper-large-v3-turbo` | Selected multilingual transcription candidate | Speech-to-text endpoint documented | Unverified | Pending comparison |
| Groq / `whisper-large-v3` | Selected multilingual transcription candidate | Speech-to-text endpoint documented; user playground screenshot shows a successful recording | Full Otis/device integration unverified | Pending comparison |

Checked [Groq STT documentation](https://console.groq.com/docs/speech-to-text) and [limits](https://console.groq.com/docs/rate-limits) on 2026-10-01. User screenshot shows 20 RPM, 2,000 RPD, 7,200 audio seconds/hour and 28,800/day for each entry; these are account capacity evidence, not latency/quality guarantees. Dogfood uses only explicitly designated free access and the existing Go subscription, with no automatic paid fallback. Adding Groq STT does not approve any Groq conversation models.

### Conversation model documentation

Google documents the stable IDs and audio input for [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) and [Gemini 3.1 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite). This is documentation evidence, not live transcription/codec evidence.

The [official Go endpoint table](https://opencode.ai/docs/go/#endpoints) lists the four selected Go IDs and maps MiMo to Chat Completions and Muse to Responses. Revalidate account availability and audio forwarding on each exact Go route. Do not replace the Go route with a direct Xiaomi/Meta call while claiming Go capability was verified.

[Xiaomi audio guidance](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/audio-understanding) distinguishes local-file upload limitations from supported audio representations. Verify encoding and private-data handling before implementing audio transport; do not expose private R2 audio via a public URL as a workaround.

The [Go privacy table](https://opencode.ai/docs/go/#privacy) describes both Muse Contributor variants as using submitted data for training and not providing zero data retention. Preserve this metadata in the registry/evidence and future provider-selection presentation. The operator selected these variants; this note records their behavior without replacing that choice.

For each model record synthetic text/tool fixtures, malformed/failed calls, latency, provider/client versions, actual audio device/codec samples and transcript quality for Romanian/Hungarian names and amounts. Never include keys, authorization headers or real business recordings in the evidence.

Cache report compares an identical static prefix with changing suffix and a realistic conversation. Report observed cached tokens or unavailable, never guaranteed savings. Record the endpoint-specific usage field and stable session behavior. Explicit caches remain off until a separate measurement justifies them.

Current API references to recheck before implementation: [Gemini caching](https://ai.google.dev/gemini-api/docs/caching), [Gemini audio](https://ai.google.dev/gemini-api/docs/audio), [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling), [OpenCode Go](https://dev.opencode.ai/docs/go/). Adapter choice follows the tested endpoint. Model discovery does not auto-approve capability or commercial permitted use.

## Gate 005 audit resolutions (2026-10-01)

All 11 findings identified in [005-provider-audit.md](../005-provider-audit.md) were addressed and verified with deterministic regression tests:

1. **P1 — Chat Completions tool-call completion boundary**:
   - `packages/agent/src/providers/opencode-go.ts`: Enforced strict call-completion boundary. `tool_call_end` emits only upon confirming explicit finish reasons (`tool_calls` | `stop`). Truncated EOF, `length_limit`, or `content_filter` emit zero executable calls. Unfinished Responses calls at EOF are not synthesized.
   - Regression: `packages/agent/test/provider-opencode-go.test.ts` (0 executable calls on EOF truncation / unfinished items).

2. **P1 — Faithful tool-call continuation replay**:
   - `packages/agent/src/providers/types.ts`: Added `arguments: Record<string, unknown>` to `ToolResultBlock` and `assistantToolCalls` to `ServerContinuation`.
   - `packages/agent/src/providers/opencode-go.ts`: `toChatMessages` replays original assistant tool calls with exact arguments and call IDs (no `{}` fabrication).
   - Regression: `packages/agent/test/provider-opencode-go.test.ts` (replays original calls and args faithfully).

3. **P1 — Concurrent credential replacement identity guard**:
   - `packages/identity/src/credentials.ts`: `decryptWorkspaceCredential` extracts the persisted `ciphertext`. `markCredentialStatus` requires matching `expectedCiphertext` in the commit-time `UPDATE` predicate.
   - `apps/worker/src/providers/service.ts`: Supplies `expectedCiphertext` to `markCredentialStatus`.
   - Regression: `apps/worker/test/providers.integration.test.ts` (two concurrent replacements reading the same starting version; replacement B remains unverified for both successful and failed A probes in real D1).

4. **P1 — Commit-time membership check on credential status updates**:
   - `packages/identity/src/credentials.ts`: Added `EXISTS (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?)` to the status `UPDATE` predicate, followed by member recheck on zero changes.
   - `apps/worker/src/providers/service.ts`: Translates `not_member` error to `{ verified: false, reason: 'not_member' }`.
   - Regression: `apps/worker/test/providers.integration.test.ts` (pauses after precheck, removes actor; status and `last_verified_at` remain unchanged and returns `not_member`).

5. **P1 — Gemini output token bounding**:
   - `packages/agent/src/providers/gemini.ts`: Validates `maxOutputTokens` as a positive integer and serializes `generation_config: { max_output_tokens: cap }`.
   - Regression: `packages/agent/test/provider-gemini.test.ts` (asserts serialized `generation_config.max_output_tokens`).

6. **P1 — Public error sanitization**:
   - `packages/agent/src/providers/gemini.ts`, `packages/agent/src/providers/opencode-go.ts`: Sanitized upstream HTTP and SSE errors into fixed local category messages (`auth_failure`, `rate_limited`, `transient`, `malformed_response`) preserving only safe status and retry-after.
   - Regressions: `provider-gemini.test.ts` and `provider-opencode-go.test.ts` (synthetic error bodies with dummy keys, URLs, and prompt excerpts never leak into yielded events).

7. **P2 — SSE buffer byte accounting**:
   - `packages/agent/src/providers/sse.ts`: Replaced monotonic buffer counter with active UTF-8 byte measurement of undecoded `text`, `eventName`, and pending `dataLines`.
   - Regression: `packages/agent/test/provider-sse.test.ts` (many small events exceeding buffer limit succeed; single pending oversized event fails).

8. **P2 — Separated Responses and Chat Completions usage mapping**:
   - `packages/agent/src/providers/opencode-go.ts`: Created distinct `parseResponsesUsage` and `parseChatCompletionsUsage`. Added `stream_options: { include_usage: true }` to Chat Completions request.
   - Regression: `packages/agent/test/provider-opencode-go.test.ts` (verifies exact Responses and Chat Completions usage fields).

9. **P2 — Explicit Responses terminal event handling**:
   - `packages/agent/src/providers/opencode-go.ts`: Handles `response.incomplete` (distinguishing `max_output_tokens` -> `length_limit` vs refusal -> `refusal_or_block`), `response.failed` -> `transient`, and truncated EOF -> `malformed_response`.
   - Regression: `packages/agent/test/provider-opencode-go.test.ts` (distinct normalization for each outcome).

10. **P2 — Voice resolver MIME parameter parsing & transcription verification**:
    - `packages/agent/src/providers/voice.ts`: Implemented `parseAudioMime` supporting codec parameters (e.g. `audio/webm;codecs=opus`), rejected raw `audio/aac`, enforced explicit `nativeAudioFormats` capability check, and added `transcriptionVerified` requirement to `WorkspaceSttConfig`.
    - Regression: `packages/agent/test/provider-voice.test.ts` (verifies codec normalization, AAC rejection, and unverified STT handling).

11. **P2 — Strengthened live smoke assertions**:
    - `packages/agent/test/smoke.live.ts`: Strengthened assertions to require valid text response, completed tool call with expected args, and successful tool-continuation turn.

## Gate 005 review follow-up resolutions (2026-10-01)

All five follow-up items from [005-review-followup.md](../../plans/005-review-followup.md) were addressed and verified with deterministic tests:

1. **P1 — Multi-round conversation history & zero `{}` fabrication**:
   - `packages/agent/src/providers/types.ts`: Extended `ProviderMessage` to represent historical tool calls (`toolCalls?: AssistantToolCall[]`) and tool results (`role: 'tool'`, `toolCallId?: string`). Defined `HistoricalToolRound` and added `priorRounds?: HistoricalToolRound[]` to `ServerContinuation`.
   - `packages/agent/src/providers/opencode-go.ts`: `toChatMessages` replays all completed prior rounds from continuation or message history; validates correspondence between expected calls and results; checks uniqueness of result IDs; strictly rejects missing arguments before transport with `invalid_request` (0 fetch calls); eliminates `{}` fabrication entirely.
   - Persistence handoff to Plan 006: Plan 006 persists `ServerContinuation.priorRounds` and records completed tool turns as ordered `ProviderMessage` blocks (`assistant` with `toolCalls`, `tool` with results) in chat history so subsequent user turns retain the complete multi-round context.
   - Regression: `packages/agent/test/provider-opencode-go.test.ts` (two successive tool rounds followed by a final text response across fresh adapter instances retain all calls/results; subsequent ordinary chat turn retains context; missing arguments reject before fetch).

2. **P1 — Strict completion boundary & contradictory state rejection**:
   - `packages/agent/src/providers/opencode-go.ts`:
     - Chat Completions: validates explicit recognized `finish_reason` (`stop` | `tool_calls`). Unrecognized reasons emit zero executable calls and a typed `malformed_response` error. `tool_calls` requires at least one decoded completed call.
     - Responses: requires a documented terminal event (`response.completed`, `response.incomplete`, or `response.failed`) and valid `response.id`; bare `[DONE]` fails with `malformed_response`. Unfinished calls in `calls` at completed termination fail with `malformed_response` rather than silently claiming success.
   - Regressions: `packages/agent/test/provider-opencode-go.test.ts` (unrecognized Chat finish reason fails; bare Responses `[DONE]` fails; unclosed Responses function item at `response.completed` fails).

3. **P2 — Documented Responses usage fields**:
   - `packages/agent/src/providers/opencode-go.ts`: Corrected `parseResponsesUsage` to map documented plural `input_tokens_details` and `output_tokens_details` (with fallback to singular).
   - `packages/agent/test/provider-opencode-go.test.ts`: Corrected wire fixture and added regression asserting preserved cached and reasoning counts, explicit 0 counts, and null for absent details.

4. **P2 — Network-independent SSE byte bounding**:
   - `packages/agent/src/providers/sse.ts`: Refactored buffer accounting to track `currentEventBytes` for the active incomplete event and trailing line fragment, without charging future complete lines in the same network chunk against the current event.
   - Regression: `packages/agent/test/provider-sse.test.ts` (50 events parsed identically across separate chunks, a single coalesced chunk, and arbitrary 7-byte slice fragments; oversized single events still fail).

5. **P2 — Format-specific STT verification contract**:
   - `packages/agent/src/providers/voice.ts`: Extended `WorkspaceSttConfig` with `verifiedFormats?: Partial<Record<SupportedAudioFormat, boolean>>`. Documented that `transcriptionVerified === true` certifies all three required mobile/messaging formats (`audio/webm`, `audio/mp4`, `audio/ogg`). `resolveEffectiveVoiceRoute` checks format verification individually and returns `stt_unverified` for unverified formats.
   - Regressions: `packages/agent/test/provider-voice.test.ts` (single-format STT approval enables only that format and rejects other formats with `stt_unverified`; verified native audio remains preferred; all-three certification routes all formats).

## Final audit corrections resolved (2026-10-01)

1. **P1 — Gemini historical tool calls wire format & strict argument validation**:
   - `packages/agent/src/providers/gemini.ts`: `toInteractionsInput` now formats `function_call` steps with `id: call.id` (matching Google's `FunctionCallStep`) and preserves `call_id: result.callId` on `FunctionResultStep`. Strictly validates `call.arguments` prior to network fetch: rejects missing, empty, or non-object arguments with `invalid_request` (0 fetch calls). Explicitly preserves valid supplied `{}`.
   - Regression: `packages/agent/test/provider-gemini.test.ts` (`it('serializes historical function_call with id and function_result with call_id while preserving valid {}')`, `it('rejects malformed or non-object historical arguments before fetch with 0 network calls')`).

2. **P2 — Chat history single authority & complete vs partial overlap handling**:
   - `packages/agent/src/providers/opencode-go.ts`:
     - Tracks `messageAssistantCallIds` and `messageToolResultIds` separately.
     - Single authority rule per round (`priorRounds`, pending round with `expectedCalls`, and fallback pending round):
       - **No overlap:** `callsInMsg.length === 0 && resultsInMsg.length === 0` -> replays assistant calls and tool results once.
       - **Complete overlap:** `callsInMsg.length === callIds.length && resultsInMsg.length === resultIds.length` -> uses existing message history once without duplicate serialization.
       - **Complete assistant-only overlap (pending round):** `callsInMsg.length === callIds.length && resultsInMsg.length === 0` -> assistant call group already present in message history, emits pending results once without duplicate assistant calls.
       - **Partial overlap:** any other state (e.g. only call A present in messages from an A+B round; assistant call present without matching result; or results present without matching assistant calls) -> rejects before fetch with typed `invalid_request` (0 network requests).
     - Bidirectional completeness: when `expectedCalls` (`previousContinuation.assistantToolCalls`) is present, verifies that every pending result matches an expected call AND that every expected call has a matching result in `pendingToolResults`. Missing expected results (e.g. A+B with result A only) reject before fetch with `invalid_request` (0 fetch calls).
     - Validates tool call arguments in `messages`, `priorRounds`, and `toResponsesInput` consistently.
   - Persistence handoff to Plan 006:
     - During an active multi-round turn, the agent orchestrator persists `ServerContinuation.priorRounds` in the server-only continuation state and accumulates tool results into `pendingToolResults`.
     - Upon turn completion, the orchestrator appends the finalized turns as ordered `ProviderMessage` records (`assistant` with `toolCalls`, `tool` with results) into the canonical message history.
     - A tool round must be represented either entirely in message history (complete overlap) or entirely in continuation (no overlap); partial overlap is an invalid caller state and rejected before transport.
   - Regressions: `packages/agent/test/provider-opencode-go.test.ts` (`it('deduplicates a two-call fully represented round so grouped calls and results appear exactly once')`, `it('rejects partial overlap when message history contains only call A from an A+B prior round')`, `it('rejects partial overlap when message history contains only call A from an A+B pending round')`, `it('rejects partial overlap when assistant call is present in messages but its result is missing')`, `it('emits tool results without duplicating assistant calls when entire assistant call group is in messages')`, `it('rejects incomplete pending results when assistant calls A+B only receive result A before fetch')`).

3. **P2 — Consistent SSE retained parsed payload accounting**:
   - `packages/agent/src/providers/sse.ts`: Standardized byte accounting to measure retained parsed payload (event name, data lines, and `\n` line delimiters) consistently across complete lines and trailing incomplete lines via `checkTrailing`.
   - Documented the retained parsed payload definition in `sse.ts` docstring.
   - Regressions: `packages/agent/test/provider-sse.test.ts` (`it('yields identical parsed events near the byte bound whether coalesced, split before newline, or sliced across UTF-8 bytes')` — proves `"data: 123456789012345\n\n"` under 20-byte bound succeeds identically across all three chunking schemes, while oversized single events fail in all schemes).
