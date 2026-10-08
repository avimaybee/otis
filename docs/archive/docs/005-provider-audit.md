> Historical record, archived 2026-10-07 from `docs/005-provider-audit.md`. Its claims apply to the original baseline. Use [current implementation status](../../status.md) for active work; old proposals and DONE labels are not current authority.

# Gate 005 independent review — 2026-10-01

Verdict: IMPLEMENTED; fixes required before acceptance. Live capability evidence remains pending separately. This review does not reopen the accepted foundation or introduce another architecture gate.

Reviewed the actual provider source, Worker services/routes, credential repository, tests, smoke harness and implementation handoffs. Independently ran typecheck, lint, 198 tests across 19 suites, build including Wrangler dry-run, and diff whitespace checks: all passed. No deployment, real-key inference, source-code edits, commit or push performed. Extra adapter probes used transpiled current source and synthetic mocked responses in a temporary directory outside the repository. Passing tests do not cover the failures below.

## Required fixes

### 1. P1 — Chat Completions exposes calls before confirming their end

Location: `packages/agent/src/providers/opencode-go.ts:264`.

The decoder closes all accumulated calls before checking whether the provider supplied a completion marker. Reproduced a clean EOF after a complete JSON arguments delta but before any finish reason or `[DONE]`: the adapter emits start, arguments, **executable tool_call_end**, then malformed_response. Parseable JSON is not a provider-confirmed completed call. Length/content-filter outcomes also occur after calls have already been exposed.

Fix: validate the protocol's call-completion boundary before publishing executable calls. Keep fragments available for Working activity. Do not treat EOF as a call-end marker. Do not synthesize completion of unfinished Responses calls at EOF either. An explicitly completed Responses output item is a different case; preserve the endpoint's real per-item boundary rather than imposing an invented rule on all providers.

Regression: valid JSON with no completion marker produces no executable call; unfinished calls plus length/block termination cannot be executed; interleaved completed calls still emit once each.

### 2. P1 — Stateless continuation invents the original arguments

Location: `packages/agent/src/providers/opencode-go.ts:475`; `packages/agent/src/providers/types.ts:39`.

`toChatMessages` fabricates assistant calls with `arguments: '{}'`. The input/result/continuation types cannot carry the actual original arguments or original assistant call grouping. Reproduced outgoing continuation for a create_task call: the assistant history claims it was invoked with `{}` regardless of the completed call's actual arguments. A successful HTTP round trip would not prove faithful conversation state.

Fix: preserve the original assistant tool-call message, IDs, arguments and ordering/grouping in the provider-neutral history or bounded server continuation. Replay it exactly, followed by corresponding results. Do not build a second history store or agent loop here. Document how 006 persists this existing continuation data.

Regression: two calls with distinct nonempty arguments, two results and a fresh adapter instance retain the original calls exactly; no empty fabricated calls.

### 3. P1 — Concurrent key replacements can share a verification identity

Locations: `apps/worker/src/routes/credentials.ts:66`; `packages/identity/src/credentials.ts:330`.

The route reads the current version and allocates current+1 outside the committing batch. Two concurrent replacements can both read v1 and both store v2. Valid interleaving: both requests read v1; A stores v2; verification decrypts A; B stores its independently allocated v2; A's successful probe marks B available because the status predicate checks only v2. The existing test manually assigns A=1 and B=2, so it cannot catch this case. This is a code-path analysis, not a new workerd race reproduction.

Fix: compare the actual probed persisted credential identity in the committing status write, preferably the existing nonce/ciphertext identity as the handoff already specifies, or use an atomically allocated replacement generation. Do not add a credential framework. The wrapping version must not be the sole proof that key bytes are unchanged.

Regression: coordinate two replacements that read the same starting version; pause A's verification, replace with B, release A; B remains unverified for both successful and failed A probes. Use real D1 and the production allocation path.

### 4. P1 — Verification status can commit after member removal

Location: `packages/identity/src/credentials.ts:319`.

`markCredentialStatus` checks membership with a SELECT, then performs an UPDATE whose predicates do not include membership. Removal between those statements still allows an ex-member's in-flight verification to modify shared credential status. The guarded credential replacement batch elsewhere does not guard this new status write.

Fix: put membership authorization in the committing statement or existing transaction guard. Preserve the correct not_member result without exposing key material.

Regression: pause after the membership precheck, remove the actor, release the status write; status and last_verified_at remain unchanged. This interleaving is not covered by rejecting a member removed before verification starts.

### 5. P1 — Gemini ignores the output-token bound

Location: `packages/agent/src/providers/gemini.ts:192`.

The request does not map TurnInput.maxOutputTokens at all. Reproduced requested cap=17 with no generation_config in the outgoing body. The documented field is `generation_config.max_output_tokens`. This breaks the bounded request contract and makes the smoke request token cap ineffective for Gemini; a timeout is not an output-token budget.

Fix: send the documented cap and validate supplied bounds before transport. Retain the one selected API family.

Regression: inspect the actual serialized request in workerd; the exact requested cap is sent. See [Google Interactions reference](https://ai.google.dev/api/interactions-api).

### 6. P1 — Public errors forward upstream secrets and URLs

Locations: `packages/agent/src/providers/gemini.ts:112,418`; `packages/agent/src/providers/opencode-go.ts:58,420`.

Copying upstream error.message and truncating to 500 characters is not sanitization. A synthetic error containing DUMMY_SECRET_MARKER and a key-bearing URL was reproduced verbatim in the yielded public error. This demonstrates a boundary failure; it is not evidence that a real provider has leaked a real key.

Fix: produce safe local messages from typed categories/status. Preserve safe status and numeric Retry-After metadata. Do not forward arbitrary upstream messages into events, activity, logs or smoke reports, and do not introduce an elaborate redaction framework when fixed messages suffice.

Regression: HTTP and SSE errors containing dummy keys, bearer strings, URLs and private prompt excerpts never expose those values in normalized events.

### 7. P2 — SSE bound limits total output instead of retained buffer

Location: `packages/agent/src/providers/sse.ts:35`.

bufferedBytes increments forever and never accounts for consumed events. Reproduced three nine-byte events with a 20-byte buffer bound: two events parsed, the third raises overflow despite no oversized retained event. The production 256 KiB limit similarly terminates sufficiently long healthy streams, including JSON/event overhead and keepalives.

Fix: bound retained undecoded text plus pending event data, accounting for UTF-8 bytes. If a total-response limit is wanted, define it explicitly and separately; do not silently conflate it with the event-buffer limit.

Regression: many small consumed events totaling more than the buffer limit succeed; a single pending oversized event fails; UTF-8 splits and keepalives remain correct.

### 8. P2 — Endpoint usage schemas are conflated

Locations: `packages/agent/src/providers/opencode-go.ts:137,412,578`; `packages/agent/test/provider-opencode-go.test.ts:33`.

The Responses decoder uses the Chat Completions parser. Reproduced real Responses-shaped usage with input_tokens=20, output_tokens=9, cached_tokens=12, reasoning_tokens=3: normalized values are all null except totalTokens=29. The Responses fixture incorrectly uses prompt_tokens/completion_tokens, hiding the defect. Chat reasoning tokens are normally nested under completion_tokens_details, and Chat streaming does not request `stream_options.include_usage`.

Fix: map each family's documented usage fields separately; explicitly request streamed usage where supported, confirming Go forwarding with live evidence later. Null means genuinely absent, not discarded reported data.

Regression: correct Responses schema preserves all supplied counts; correct Chat details preserve cached/reasoning counts; absent fields remain null; zero remains zero. See [official Responses SDK schema](https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts).

### 9. P2 — Responses ignores real failure/incomplete terminal events

Location: `packages/agent/src/providers/opencode-go.ts:408`.

The decoder recognizes response.completed and looks for failed/incomplete status inside it. The Responses protocol has response.failed and response.incomplete events. Reproduced response.incomplete with max_output_tokens reason: it becomes malformed_response and loses usage instead of the expected length_limit. Refusal needs its actual reason, not every incomplete response mapped to length.

Fix: handle documented terminal event names/status/reasons explicitly, preserving safe usage/error metadata. Unknown auxiliary events may be ignored; recognized terminal outcomes must not be.

Regression: completed, failed, max-token incomplete, content-filter/refusal and true truncated EOF each normalize distinctly. Go-specific deviations remain unverified until observed. See [official Responses SDK schema](https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts).

### 10. P2 — Voice resolver does not enforce its verified-format contract

Locations: `packages/agent/src/providers/voice.ts:60,107,126`.

Two reproduced cases: audio/webm;codecs=opus and audio/mp4;codecs=mp4a.40.2 normalize to null; generic audio=supported with no nativeAudioFormats entry enables native OGG anyway. WorkspaceSttConfig carries credential status but no model/format transcription evidence, so it also cannot distinguish a valid key from a tested route. Relabeling raw audio/aac as an MP4 container is not conversion.

Fix: parse MIME parameters without losing relevant format/codec evidence, require explicit tested format capability, and represent verified Groq model/format transcription independently of credential validity. Make approved conversation-model availability a clear prerequisite. Keep audio validation/transcription transport in 010; no recorder or transcoder is required in 005.

Regression: Android/iPhone MIME parameters normalize appropriately; missing format evidence never enables native transcription; a valid Groq key with unverified transcription does not enable STT; tested fallback does; genuine container validation remains 010's responsibility.

### 11. P2 — Live smoke can pass without a working tool round trip

Location: `packages/agent/test/smoke.live.ts:189`.

The smoke test asserts only that the text turn has a finish event and a usage event. Missing tool_call_end or a failed/null roundTrip is printed but does not fail. Any finish reason, including length_limit or refusal, passes the text assertion. This cannot establish the required text/tool capability evidence for approving a registry entry.

Fix: assert the intended successful text result, completed fixture call with expected arguments, faithful successful tool-result continuation and expected terminal semantics. Separate unreported cache metrics from failures; never require a cache hit. Fix the Gemini cap before live invocation. Do not auto-approve registry entries from a loose smoke success.

Regression: deterministic failing/absent tool and continuation cases cause the evidence harness to fail. Live smoke remains opt-in, uses synthetic input only, and must not expose secrets or enable paid fallback.

## Handoff and acceptance

Fix the existing boundaries above; preserve the current package structure and handpicked registry. No generic middleware framework, additional provider SDK, orchestration rewrite, UI work or actual Groq transport is requested by this review. Add focused behavior tests rather than mirroring implementation internals.

Rerun the root checks once the fixes land. Report each finding with its regression evidence and disclose any remaining protocol assumptions. Local mocked correctness and live capability approval are separate: all selected production entries correctly remain unverified, and no real endpoint has been certified by this audit. 006 should consume the corrected accepted adapter contract, not paper over transport defects inside its business loop.
