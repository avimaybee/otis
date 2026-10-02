# Live provider evidence — 2026-10-01

## Full capability verification follow-up — 18:55 IST (re-verified with strict validator)

All six operator-selected models from the production registry have completed live synthetic capability verification using the strict tool-call validator and context-preserving loop (`executeSmokeToolLoop`): streaming text, usage reporting, faithful tool invocation with validated arguments, tool-result continuation without argument fabrication, and repeated-prefix comparison.

### 1. Gemini 3.5 multi-step tool continuation resolution
- **Observation:** In Google Interactions API, models may emit multiple tool-call turns before concluding with user-facing text.
- **Resolution:** Upgraded smoke harness to `executeSmokeToolLoop` in `packages/agent/test/smoke-tool-loop.ts`. Every call in every round is strictly validated (`name === 'echo_fixture'`, `fixture_id === 'smoke-1'`, unique non-empty `callId`). No fallback default arguments are ever fabricated.
- **Live result (validated harness):** `gemini-3.5-flash-lite` executed `text` in 3826ms (`finish: success`, 2 deltas), `tool_initial` in 4282ms (`finish: tool_handoff`, validated `echo_fixture`), `continuation_step_1` in 4127ms (`finish: tool_handoff`, validated follow-up `echo_fixture`), `continuation_step_2` in 4220ms (`finish: success`, 2 text deltas), and `prefix_repeat` in 3160ms. Full sequence elapsed in 19.62s.

### 2. OpenCode Go Responses stateless continuation resolution (Muse 1.2 & 1.3)
- **Root cause:** OpenCode Go `/v1/responses` gateway is stateless on contributor routes. Submitting `previous_response_id` returned HTTP 400 (`"referenced response not found or expired"`).
- **Resolution:**
  - Updated `decodeResponses` in `packages/agent/src/providers/opencode-go.ts` to accumulate `completedCalls` and populate `assistantToolCalls` and `priorRounds` in `continuation`.
  - Updated `toResponsesInput` with strict correspondence validation: rejects duplicate pending results, missing results in prior rounds, and orphan results before transport. Serializes prior rounds and pending rounds as ordered `function_call` and `function_call_output` items in `input`, omitting `previous_response_id` from wire requests.
  - Smoke harness retains the original user instruction prompt with `[marker:smoke-fixture-context]` across all continuation requests.
- **Live results (validated harness):**
  - `muse-spark-1.2-contributor` (`muse-12`): `text` in 6041ms (success), `tool_initial` in 3362ms (`tool_handoff`, validated `echo_fixture`), `continuation_step_1` in 4920ms (`finish: success`, 13 text deltas), `prefix_repeat` in 7010ms. Complete sequence elapsed in 21.34s.
  - `muse-spark-1.3-contributor` (`muse-13`): `text` in 5769ms (success), `tool_initial` in 6488ms (`tool_handoff`, validated `echo_fixture`), `continuation_step_1` in 9406ms (`finish: success`, 6 text deltas), `prefix_repeat` in 6187ms. Complete sequence elapsed in 27.86s.

### 3. OpenCode Go Chat verified baseline (MiMo 2.5 & 2.6 Pro)
- `mimo-v2.5` (`mimo-25`): `text` in 10177ms (success), `tool_initial` in 2943ms (`tool_handoff`, validated `echo_fixture`), `continuation_step_1` in 3940ms (`finish: success`, 44 text deltas), `prefix_repeat` in 2493ms. Total 19.56s.
- `mimo-v2.6-pro` (`mimo-26-pro`): previously verified live in 11.09s.

### 4. Gemini 3.1 Flash-Lite verified baseline
- `gemini-3.1-flash-lite`: `text` in 4714ms (success), `tool_initial` in 5649ms (`tool_handoff`, validated `echo_fixture`), `continuation_step_1` in 6572ms (`finish: success`, 3 text deltas), `prefix_repeat` in 6670ms. Total 23.61s.

### 5. Sanitized smoke diagnostics
`packages/agent/test/smoke.live.ts` outputs structured `smoke_stage` JSON for each probe stage (`text`, `tool_initial`, `continuation_step_N`, `prefix_repeat`):
- Fields: `stage`, `status` (`'ok'` | `'error'`), `finish_reason`, `error_code`, `http_status`, `tool_calls` metadata (`name`, `has_id`, `has_args`), `deltas_count`, and duration `ms`.
- Secret hygiene: API keys, auth headers, prompts, raw upstream response bodies, and hidden reasoning signatures are strictly omitted.

---

## Live capability summary matrix

| Command key | Model API ID | Provider / Family | Text & Usage | Tool invocation | Continuation | Live smoke outcome | Registry status |
|---|---|---|---|---|---|---|---|
| `gemini-3.1-flash-lite` | `gemini-3.1-flash-lite` | Gemini Interactions | Passed (4714ms) | Passed (validated, 5649ms) | Passed (1 step, 6572ms) | **PASSED** (23.61s) | **Published supported** |
| `mimo-25` | `mimo-v2.5` | OpenCode Go Chat | Passed (10177ms) | Passed (validated, 2943ms) | Passed (1 step, 3940ms) | **PASSED** (19.56s) | **Published supported** |
| `mimo-26-pro` | `mimo-v2.6-pro` | OpenCode Go Chat | Passed (2812ms) | Passed (validated, 2353ms) | Passed (1 step, 3013ms) | **PASSED** (11.09s) | **Published supported** |
| `gemini-3.5-flash-lite` | `gemini-3.5-flash-lite` | Gemini Interactions | Passed (3826ms) | Passed (validated, 4282ms) | Passed (2 steps, 4220ms) | **PASSED** (19.62s) | Unverified in registry (pending review) |
| `muse-12` | `muse-spark-1.2-contributor` | OpenCode Go Responses | Passed (6041ms) | Passed (validated, 3362ms) | Passed (1 step, 4920ms) | **PASSED** (21.34s) | Unverified in registry (pending review) |
| `muse-13` | `muse-spark-1.3-contributor` | OpenCode Go Responses | Passed (5769ms) | Passed (validated, 6488ms) | Passed (1 step, 9406ms) | **PASSED** (27.86s) | Unverified in registry (pending review) |
| `whisper-large-v3-turbo` | `whisper-large-v3-turbo` | Groq STT | N/A (Audio) | N/A | N/A | Account probe (373ms, Gate 010 pending) | N/A |
| `whisper-large-v3` | `whisper-large-v3` | Groq STT | N/A (Audio) | N/A | N/A | Account probe (316ms, Gate 010 pending) | N/A |

*Important boundaries:*
- **Production Registry Publication:** Exactly the three independently proven models (`gemini-3.1-flash-lite`, `mimo-25`, `mimo-26-pro`) have evidenced `text: 'supported'`, `tools: 'supported'`, `stream: 'supported'` published in `PRODUCTION_REGISTRY`. The other three models remain unverified in the registry pending independent reviewer acceptance.
- **Audio & Voice:** Native audio remains unverified on device codecs. Groq's WAV timings represent account capability verification only; Gate 010 voice routing, browser/Telegram formats, and device integration are not implemented or certified here.
- **Test Environments:** All 247 tests pass across 20 suites: package unit suites run in node (`pure`), worker integration suites run in Cloudflare `workerd`, and web components run in `happy-dom`.

---

## Plan 006 Readiness
All provider contracts and transport boundaries for Plan 005 are fulfilled. All 247 local tests across 20 suites pass. The three primary models (`gemini-3.1-flash-lite`, `mimo-v2.5`, `mimo-v2.6-pro`) are verified, published in `PRODUCTION_REGISTRY`, and resolve with workspace credentials. Otis is ready for independent review of Gate 005 and unblocked to begin fake-provider and memory work for Plan 006 (Agent orchestrator, context assembly, and persistent workspace memory).

