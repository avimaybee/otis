> Closed historical plan record, reconciled 2026-10-07 from `plans/005-implementation-handoff.md`. Family 005: adapters and historical route evidence present; accounting/quality partial. Remaining R07, R13 work is carried into the [current backlog](../../../plans/README.md#repair-order); see the [001–015 closure register](../../status.md#numbered-plan-closure). Original TODO/DONE and acceptance language describes the old baseline, not a current instruction or all-implemented verdict.

# Gate 005 implementation handoff: provider foundation

Prepared 2026-10-01 against HEAD `859ed92` and the existing working tree. This is an execution supplement to [005-provider-spike.md](005-provider-spike.md), not a new gate. Inspect HEAD and uncommitted changes before starting; this baseline is a locator, not permission to discard subsequent work.

## Assignment and result

Implement Plan 005: a small, tested provider boundary for Gemini and OpenCode Go, using encrypted workspace credentials and an operator-maintained model registry. Preserve the foundation-first development order. Do not turn the deployed welcome screen into a chat product during this gate.

The result must let Plan 006 consume provider-neutral streamed text, complete tool calls, usage and typed failures without knowing HTTP protocols. It must also let settings validate approved model keys. It must not execute business tools, mutate the ledger, or make the model an authorization boundary.

Gate 004B is locally accepted, with 152 tests across 12 files at review. Its immutable dispatch fence and live-lease ledger guard are requirements to preserve. Deployed sign-in and Kerning selection were observed in the user's screenshot; remote migrations, queue consumption and cron operation are not established by that screenshot.

## Read and inspect first

Read AGENTS.md, plans/README.md (including Engineering simplicity), the original Plan 005, architecture.md sections 9/11/13, relevant contracts, docs/agent-handoff.md and docs/decisions/provider-capabilities.md. Inspect product.md provider, model, voice and caching requirements. Inspect these live files:

- `packages/agent/src/index.ts`: currently only a scaffold. `SUPPORTED_MODELS = ['gemini-2.0-flash', 'opencode-go']` is not approval or capability evidence. Replace this placeholder and inspect all importers.
- `packages/identity/src/credentials.ts`: AES-GCM workspace/provider-scoped storage and server-side decryption already exist. Replacement resets verification. Reuse them.
- `packages/identity/src/settings.ts`: shared model settings exist, but registry validation is explicitly deferred to this gate.
- `apps/worker/src/routes/settings.ts` and `routes/credentials.ts`: existing authenticated scope/CSRF/error conventions.
- `apps/worker/src/actor/dispatch.ts`: claimed fence, attempt, durable source and handler boundary. Leave the echo dispatcher in place until Plan 006.
- `packages/contracts/src/index.ts`: model overrides and provider status types; do not duplicate them.
- `vitest.config.ts`: package tests run in Node; Worker tests run in workerd. Node success alone is not Workers compatibility evidence.
- Current migrations, package manifests and lockfile. Do not reserve migration numbers in advance.

Start with `git status --short`, `git rev-parse --short HEAD`, and a baseline check. Preserve unrelated docs, UI references and all existing foundation work. Never print `.env`, `.dev.vars`, credentials or request authorization headers.

## Settled choices and inputs

Both providers are supported. Keys belong to the workspace and are shared for runs; do not switch to per-member keys. Models are handpicked by Avi, not auto-approved from provider discovery. Workspace default applies to new chats; `/model` selects a chat override later. Everything remains workspace-scoped. Audio is recorded voice notes; text replies are default. No silent paid-provider fallback.

The operator selected all six initial models on 2026-10-01. Implement and verify all six; do not reduce the approved selection to one per provider or replace one silently. Exact IDs and documentation references are recorded in docs/decisions/provider-capabilities.md: Gemini `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`; OpenCode Go `mimo-v2.5`, `mimo-v2.6-pro`, `muse-spark-1.2-contributor`, `muse-spark-1.3-contributor`. Go MiMo entries use Chat Completions and Muse entries use Responses per the checked official endpoint table. Operator selection is complete; live capability and account availability still need verification. No workspace default has been selected. Do not publish test-only registry fixtures as production entries.

The operator expects voice input across the selected models. Updated decision 2026-10-01: verify native transcript capability, but an unsupported/unverified native path may use explicitly workspace-configured Groq STT automatically in gate 010. Keep native capability separate from effective voice availability; do not reject a text/tool model solely for lacking audio. Gate 005 defines capability and route-resolution types/interfaces, while [010-groq-stt-handoff.md](010-groq-stt-handoff.md) owns Groq transport, setup and recording integration. Documented base-model audio support does not prove the Go gateway forwards it. MiMo local-file upload limitations are distinct from supported audio encodings. Preserve Contributor data-use metadata. Dogfood permits no additional inference spending beyond the existing Go subscription and free Gemini/Groq access; no automatic paid fallback.

Live smoke requires an explicitly designated credential in the existing encrypted workspace store or an opt-in local secret environment. Merely discovering a secret on disk is not authorization to spend it. Once designated for synthetic provider verification, do not ask permission for every probe. Use a bounded smoke procedure and no real Kerning records.

## Scope and simplicity

Keep provider-neutral types, a registry, provider transports and a fake provider in the existing `@otis/agent` package. Keep D1, authorization and credential access in the Worker/identity boundary. Do not make identity import agent implementation and create a circular dependency; place any shared DTO in contracts and pass validated model selection into the existing settings commit service.

Suggested files, adapted to the repository conventions:

```text
packages/agent/src/providers/types.ts
packages/agent/src/providers/registry.ts
packages/agent/src/providers/gemini.ts
packages/agent/src/providers/opencode-go.ts
packages/agent/src/providers/fake.ts
packages/agent/test/provider*.test.ts
apps/worker/src/providers/service.ts
apps/worker/test/providers.integration.test.ts
scripts/provider-smoke.ts
docs/decisions/provider-capabilities.md
```

Use ordinary functions and injected transport/clock where needed for tests. Prefer native fetch/streams or one justified Workers-compatible SDK. Do not install SDKs for every endpoint family, a generic plugin loader, an agent framework, Redis, a vector database, or a second queue. Add a shared stream parser only if actual protocols need it. No module split of the dispatcher is required.

Out of scope: real agent loop, memory retrieval, business prompts/tools, web/Telegram command presentation, UI redesign, recorder, TTS, live voice, automatic schedules, exports, MCP and commercial launch. Gate 005 supplies the model resolver for `/model`; Plan 007 implements command delivery and responses. Do not claim `/model` works in either client from resolver tests alone.

## Step 1: freeze a minimal provider-neutral contract

Define typed turn input, model descriptor, tool declaration, tool-result continuation, usage, terminal outcome and provider error. Keep schemas independent of tool execution. Input must include exact selected provider/model/endpoint descriptor, workspace/chat/run/request correlation, stable per-chat provider session ID, complete messages, tools, output limit, timeout and AbortSignal. Resolve credentials outside public DTOs; inject the key into the server-only transport call, never a serializable activity object.

An adapter emits an AsyncIterable of normalized events:

- `text_delta`: text in arrival order.
- `tool_call_start`, `tool_call_arguments`, `tool_call_end`: stable call ID/name and final validated JSON arguments. Interleaved calls remain separate by ID/index. Consumers receive one completed call per provider call.
- `provider_thought_summary`: only a field explicitly documented as a public summary. Never relabel raw reasoning, hidden prompts, or opaque protocol tokens as thoughts.
- `usage`: normalized cumulative snapshot, with documented replacement/aggregation semantics. Missing token fields are null, not zero. Include input/output/cache-read/cache-write and reasoning tokens only if supplied; document overlap to avoid double-counting.
- `finish`: success, tool handoff, length limit, refusal/block or other mapped terminal reason. A clean network close is not automatically successful completion.
- `error`: typed sanitized failure. Define one consistent terminal-error convention; do not emit an error and then success, or both throw and emit the same error.

Preserve provider-required continuation metadata, including opaque signatures or reasoning handles, in a server-only bounded continuation object when the chosen API requires it. Never display or log it. Verify a tool-result round trip; flattening a response to text alone may break the next provider request. Provider history is not canonical workspace memory, and process memory must not be the only place future resumed turns can recover this metadata. Document the persistence handoff to 006 without building its agent loop now:
- **Persistence & single authority handoff to Plan 006**: Plan 006 persists `ServerContinuation.priorRounds` and records completed tool turns as ordered `ProviderMessage` blocks (`assistant` with `toolCalls`, `tool` with results) in chat history so subsequent user turns retain the complete multi-round context. `toChatMessages` distinguishes complete overlap from partial overlap per tool round: if a round's calls and results are completely present in `messages`, it uses existing history once and skips replaying from continuation; if a round has no overlap, it replays from continuation once; if a round has partial overlap (e.g. only subset of calls or calls without results), it rejects before transport with typed `invalid_request` (0 network requests).

Keep the adapter incapable of executing tools. Transport completion means the provider completed its output, not that Otis saved an action.

## Step 2: registry and model resolution

Use a versioned operator-maintained registry. Each entry needs a unique safe short command key, display name, provider, exact model ID, fixed endpoint family, operator approval, lifecycle (active/retired), capability states and evidence reference/date. Capability states must distinguish unverified, supported and unsupported. Operator approval and successful verification are separate requirements.

Resolution rejects unknown keys, raw arbitrary model IDs, retired entries, unverified required text/tool/stream capabilities and missing/invalid credentials. Never accept a user-supplied base URL: use fixed approved provider origins to avoid credential exfiltration. Discovery verifies a handpicked ID; it never auto-adds entries.

List only available approved choices for an authenticated workspace, without returning provider discovery payloads or credential material. A retired selection keeps history readable but blocks the next run with a model-unavailable result; never rewrite historical model IDs or substitute another model. Null workspace default remains a valid unconfigured state. No production default is inferred from registry order.

Use the same resolver for shared settings now and future chat commands/runs. Keep membership rechecks in the existing committing service. Validate credential availability from persisted metadata, not a client flag. Do not perform a paid inference on every settings GET. Treat availability as a snapshot: Plan 006 must revalidate at dispatch and pin provider/model for that run.

## Step 3: implement and test the fake provider first

Provide deterministic scripts for text, two interleaved calls, usage, tool continuation, cancellation and failure. Fake calls perform no network I/O and no business writes. Include fake-only registry entries through test injection, never the production allowlist. This is the interface Plan 006 will use for deterministic policy tests.

Test stream event ordering and terminal semantics before implementing live transports. Use fixtures for real provider wire shapes as well as the normalized fake; adapter tests must exercise decoding, not just construct the expected output manually.

## Step 4: Gemini adapter

Recheck current official Gemini docs and SDK support. Pick one explicit API family after proving it supports the required Workers runtime, tool round trip, streaming and usage. Explain the choice briefly in the evidence report. Do not implement both Interactions and generateContent merely because both exist. Avoid legacy SDKs. A direct REST adapter is acceptable when it is simpler and supports the required protocol.

Implement text streaming, one/two function calls, tool-result continuation, usage, terminal reasons, cancellation and typed errors. Validate the chosen SDK or HTTP adapter in workerd with mocked network, not only Node. Preserve any required protocol metadata in continuations. Unsupported public summaries are a valid recorded result.

Do not rely on automatic SDK function execution: external tools are forbidden in this gate. Check current official schemas; do not treat a declaration accepted by one provider as universally supported JSON Schema. Reject unsupported schemas explicitly rather than silently weakening them.

## Step 5: OpenCode Go adapter

Verify each selected ID against the current official Go endpoint table and the account's models discovery endpoint. The docs currently distinguish Chat Completions, Responses and Messages. Implement only the family or families actually required by selected models; unsupported families return a clear typed result. Do not build every family speculatively.

Use a stable `x-opencode-session` per workspace/chat and an honest distinctive User-Agent such as `otis/<version>`. Do not impersonate another client or transform Otis prompts into fabricated coding traffic. Preserve the same session for retries and clarification continuations; different workspaces/chats get different IDs. Request IDs and run IDs remain distinct from session IDs. Test outgoing headers without exposing their real values in logs.

Authenticate only to the approved Go origin. A 200 models response is discovery evidence, not evidence of tools, streaming or audio. Do not switch to Zen credits or another endpoint after a cap failure. Record provider-side balance fallback behavior if observable, without changing account settings.

The user has explicitly chosen private Go dogfood; do not reopen that settled choice. Document observed service limitations and report a concrete provider rejection if one occurs. This gate does not certify future commercial use.

## Step 6: streaming and failures

Read arbitrary chunk boundaries correctly: split UTF-8 characters, split JSON, multiple events per chunk, CRLF, comments/keepalive, final usage after content, and index/ID interleaving. Bound buffered event size, accumulated tool arguments and request duration with named constants. Reject malformed/truncated arguments and never expose a partial call as executable. A stream cut off before its required completion marker fails even if some text arrived.

Support cancellation before request, during stream, and when the consumer stops iterating. Close/cancel readers and transports in finally blocks. Distinguish invalid credentials, rate limit, quota exhaustion when provable, unknown model, unsupported capability, timeout, aborted, malformed response, blocked output and transient outage. Preserve safe numeric Retry-After/reset metadata if supplied; never invent reset times or infer quota exhaustion from every 429.

No automatic retry after output/tool fragments become visible. Let orchestration own retries and receipts in 006. Prefer no hidden adapter retry for dogfood; if an SDK retries internally, explicitly configure and test that behavior. No silent provider failover. Never include raw upstream response bodies, authorization URLs or key-bearing SDK error objects in public errors/logs.

## Step 7: Worker credentials, settings and verification

Reuse authenticated workspace scope, CSRF and AES-GCM decryption. No global environment-key fallback for a missing workspace credential. Do not expose a generic arbitrary prompt/proxy endpoint. If setup needs a verification route, make it a narrow authenticated and bounded operation, with fixed synthetic probes and sanitized metadata only.

Verification of credential A must not mark a replacement credential B valid. Compare a stable persisted credential identity in the committing update; the existing wrapping `key_version` alone is not a replacement generation. Reuse existing ciphertext/nonce identity or add a minimal generation only if necessary. Recheck membership when persisting verification/model settings. Mark auth failure invalid; timeout/429 is not proof the key is invalid. Storing a new key continues to reset verification.

Model-setting validation must be exercised through the Worker route, not only a pure registry function. Test valid approved selection, unknown/retired key, missing/invalid credentials, cleared default, wrong workspace and removal during a pending write. Preserve 003B's guarded committing path. Do not force identity services to perform live provider calls.

## Step 8: usage, caching and audio evidence

Expose accurate usage and latency: time to first event and total request time. Record metric units and whether usage is cumulative. Never label missing usage as a free request. Estimated cost uses a dated explicit rate source and correct cached-token accounting; unknown prices/cap signals stay null. A Go subscription accounting estimate is not a measured bank charge or exact remaining account balance.

Use existing durable storage for production metrics where a real run exists. Do not fabricate runs just to probe providers. If current run storage lacks required fields, add only the minimal migration/contracts required by 005 and update fixtures; leave aggregation/UI to later gates. Synthetic smoke records can be a sanitized report artifact. Define the persistence fields consumed by 006 and distinguish a tested serializer from actual production run writes.

Keep a deterministic static prompt/tool prefix and changing suffix in the smoke fixtures. No prompt padding, no shared private workspace cache, no explicit cache provisioning by default. Record provider-reported cache metrics, eligibility and unreported states. Repeated requests do not guarantee a cache hit. A measured miss is valid evidence, not a failed adapter. No need to build a metrics dashboard.

Audio input, transcription and tool use from audio are separate capabilities. Expose supported/unsupported/unverified without building upload/recording infrastructure. Verify native paths with Android browser WebM/Opus, iPhone browser MP4/AAC and Telegram OGG/Opus as applicable; never just rename bytes. Samples absent means native capability unverified. Effective voice availability additionally depends on the tested Groq route and workspace configuration supplied by 010. Automatic routing from that configuration is approved; ad hoc substitution on auth/quota/outage errors is not. Text adapter acceptance does not claim end-to-end voice readiness.

## Step 9: live smoke and evidence

Provide an opt-in smoke command that requires provider/model selection and a designated secret source. It is never run by `pnpm test`, build, or CI. Bound request/output limits; do not loop until cache hits. Report planned request count before using a paid key. Use fabricated neutral data and a harmless fake tool (for example, echoing a fixture identifier), never real lead records or external action tools.

For each selected provider test a text stream, a function-call/result round trip, usage capture and a small repeated-prefix comparison. Persist only sanitized metadata: command key/exact ID, endpoint family, date, runtime/client version, probe type, finish/error category, latency, usage/cache metrics, evidence status and source links. No keys, prompt bodies, customer text, audio content or raw protocol reasoning.

Update docs/decisions/provider-capabilities.md with observed pass/fail/unverified cells. Separate operator approval, mocked protocol evidence, workerd compatibility and live evidence. Live absence is an explicit blocker to full capability acceptance, not permission to mark a model available. If IDs/credentials are pending, mark implementation complete with live evidence pending; do not mark the whole gate DONE.

## Required test matrix

| Area | Decisive evidence |
|---|---|
| Registry | Unknown/raw ID, duplicate command key, retired/unverified model rejected; test entries never published |
| Transport | Correct endpoint/headers/body; tools and complete continuation preserved |
| Stream parser | Split bytes/JSON, interleaved tools, late usage, malformed/truncated call and early EOF |
| Terminal states | Exactly one terminal result; blocked/length outcomes never mislabeled success |
| Cancellation | Before/during stream and early iterator return cancel I/O without leaked readers |
| Errors | 401, model unavailable, 429, Retry-After, 5xx, timeout, abort; sanitized messages |
| Usage | Null missing metrics, explicit zero preserved, cumulative updates not double-counted |
| Isolation | Distinct workspace/chat sessions; no cross-workspace credential selection |
| Settings | Real authenticated route rejects unavailable models; membership guard preserved |
| Credentials | A-verification/B-replacement race cannot verify B; key replacement resets status |
| Runtime | Provider service executes mocked turn in actual workerd with encrypted D1 credential |
| Live | Selected Gemini and Go text/tool round trips, measured metadata or exact pending blocker |

Use fake network in routine tests. Ensure existing actor, ledger, identity and web tests still pass. No real provider call is allowed to sneak into default test scripts.

## Verification and completion report

Run targeted package/Worker tests, then root commands independently and record exit codes:

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
```

If C: is still full, set process-local TEMP/TMP to the existing `D:\wtmp` for test execution. Do not delete user files or silently alter machine-wide settings. Build is a Wrangler dry-run, not deployment evidence.

Leave source changes reviewable and uncommitted unless explicitly instructed otherwise. No push, PR, deploy, account-setting changes or real business outbound actions are authorized by this handoff. Report gate status honestly; do not alter accepted foundation behavior to make provider fixtures pass.

Completion report must list: diff/HEAD, files/contracts/migrations/dependencies, exact chosen API families and why, implemented behavior, deterministic tests and counts, workerd evidence, live probe metadata/evidence path, capability/credential/registry states, cache and audio limitations, root checks, unresolved inputs, and next eligible Plan 006. A replacement agent must be able to continue from the report without rediscovering decisions.

## Official references to recheck during execution

- [OpenCode Go](https://opencode.ai/docs/go/): endpoint-family mapping and session/client guidance; checked 2026-10-01. Verify again for selected IDs rather than copying a catalog into the production registry.
- [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling): chosen API/tool continuation requirements.
- [Gemini caching](https://ai.google.dev/gemini-api/docs/caching): endpoint-specific cache reporting and support.
- [Gemini SDKs](https://ai.google.dev/gemini-api/docs/libraries), [audio](https://ai.google.dev/gemini-api/docs/audio), and [pricing](https://ai.google.dev/gemini-api/docs/pricing): check the exact selected model and API family. No model ID is approved by these links.
