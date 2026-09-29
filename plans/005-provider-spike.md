# Plan 005: Prove Gemini and OpenCode Go capabilities behind one adapter

> Executor: this is a bounded integration spike plus production-ready adapter interfaces. Read product.md sections 6.3, 8.1, 8.6, 12.3 and 12.5. Never paste real API keys into tests, logs, plans, prompts, or source. Source-document drift check is in plans/README.md.

## Status

- Priority P0; effort M; risk medium; category integration/research; depends on 001 and provider settings from 003.
- Planned at unversioned document snapshot, 2026-09-29.

## Why and current state

The user wants Gemini API and OpenCode Go API-key access with workspace-shared credentials, one per connected provider. The product operator will handpick the models shown in Daybook; a provider's discovered catalog is not a user-facing model list. A workspace default applies to new chats, and `/model` changes only the current chat. Model lists, endpoints, audio/tool support, thought summaries and streaming differ. OpenCode Go's official guide lists model-specific Chat Completions, Responses, and Messages endpoints; it describes expected traffic as coding-agent traffic. The user explicitly wants private Daybook dogfood through Go. The plan must support that choice without falsely promising every Go model has one OpenAI-compatible endpoint or that commercial Daybook traffic is pre-approved.

## Scope

Modify packages/agent/provider interfaces, provider adapters, capability registry, Worker secret/credential access, provider tests, and a documented spike report under docs/decisions. Do not build the agent's business policy, UI, voice recorder, or select a permanent model by popularity. Do not send real business notes to a provider during a test without the user's explicit sample.

## Adapter contract

Expose streamTurn(input, toolSchemas, settings) as an async sequence of normalized events: text_delta, tool_call_start/arguments/end, provider_thought_summary only if actually supplied, usage, finish, and typed error. Separately expose transcribeAudio or explicit unsupported capability. Tool arguments are incomplete until the provider's end marker; never execute a partial streamed JSON fragment. Normalize model ID, provider, endpoint family, request/run ID, input/output token counts, cached-read and cached-write token counts when reported, and measured latency. Record `null` when a provider/endpoint does not expose a cache metric; do not interpret missing as zero. Preserve a stable conversation/session identifier; for Go follow the official x-opencode-session and distinctive User-Agent guidance where applicable. Use a stable session ID per Daybook chat (including resumed turns), not one ID shared across members/workspaces, and verify whether each chosen endpoint forwards the header. Never display fabricated thoughts or raw hidden reasoning.

## Prompt caching and cost contract

Keep the large, identical prompt prefix byte-stable across successive turns on the same model: versioned system instructions, tool declarations in deterministic order, and stable policy examples if they are genuinely needed. Put the changing workspace/member context, retrieved memory, current ledger state, recent turns and latest message after that prefix. Do not pad prompts to reach cache thresholds; shorter uncached requests may cost less than longer cached ones. Never include one workspace's private context in a shared cross-workspace cache object or prefix merely to increase hits. Record a hash of the static prompt version and tool-schema version, not the plaintext prompt, with each run.

Gemini implicit caching is automatic on eligible models but is not a guaranteed hit; read the response's cached-token usage field. Its explicit caching has a TTL and storage charge, so leave it off for the first dogfood pass. Evaluate explicit caching only if measured repeated-prefix volume and provider pricing show net savings after cache creation/storage, and only for truly stable, authorized content. If enabled later, key a cache resource by provider, exact model, prompt/schema versions, workspace scope if it contains workspace material, and expiry; invalidate on version change. A short stable instruction block below a model's minimum cache size may never hit.

OpenCode Go documents cached-read prices and asks for a stable `x-opencode-session` for routing and prompt caching. It does not promise a hit on every turn. Capture cached token counts from the chosen endpoint's usage payload if present, preserve the session header across retries and follow-up turns, and verify real repeated synthetic requests. Do not claim saved subscription capacity from a pricing table alone; compare reported usage/cap accounting for the selected model and endpoint. Keep a provider-specific `cache_reporting` capability value of `reported`, `unavailable`, or `unverified`.

For each run persist input, output, cached-read/write tokens if reported, model, prompt version, cache eligibility, latency and estimated charge/cap consumption. Aggregate hit rate and effective cost per completed action, with missing metrics explicitly excluded. Compare an A/B fixture with identical static prefix and changing suffix, then a realistic Daybook conversation; require equivalent tool behavior and answer quality. The first optimization target is context selection and avoiding redundant model calls, not a larger cacheable prompt.

Use the current @google/genai SDK for Gemini. Create a versioned, operator-maintained allowlist with a unique short command key, exact provider/model ID, display name, endpoint family, capability evidence and last verified date; user-facing settings and `/model` accept only these keys. Discover provider models only to verify a handpicked ID, availability and endpoint, never to auto-publish the catalog. A model is available to a workspace only while its provider credential is configured and valid. For OpenCode Go, query the models endpoint using its workspace key at setup/revalidation, then test actual text streaming, tool calling and voice ingestion/transcription on the exact endpoint before marking those capabilities. A voice-approved model must return a usable transcript from supported browser and Telegram recordings; accepting an audio payload alone is insufficient. If a selected model lacks this capability, require an explicitly configured and disclosed transcription provider or make voice unavailable for that chat. Handle 401, 429/cap exhaustion, timeout, malformed tool output, and provider outage as typed failures. Do not silently fail over to another paid provider without workspace configuration or user-visible explanation. A removed/unavailable approved model leaves existing chats readable and asks members to select an available model before the next new run; do not silently substitute another model.

## Proposed file map and verification commands

These paths are targets to create or extend; the repository has no source files at planning time. In scope: packages/agent/src/providers/types.ts, gemini.ts, opencode-go.ts, fake.ts, capabilities.ts; packages/agent/test/providers/*.test.ts; docs/decisions/provider-capabilities.md. Keep live smoke scripts outside CI or require an explicit opt-in flag.

Verification after plan 001 establishes the scripts: pnpm typecheck; pnpm lint; pnpm test; pnpm build. Live synthetic smoke is recorded separately with model/endpoint/date and no prompt or secret value. Do not report a command as passed if it has not run. If a proposed path conflicts with the scaffold, preserve the module boundary and document the exact mapping before editing. Do not push or open a PR unless the operator asks.

## Steps and verification

1. Implement adapter types and deterministic fake provider fixtures. Verify pnpm test proves the same fixture stream yields the same normalized events for fake Gemini and fake Go wire shapes; no network needed.
2. Build Gemini adapter; run mocked HTTP/SDK tests for one text response, streaming, one and two tool calls, usage, thought-summary absent/present, and error types. Verify pnpm typecheck and tests pass. Run a live smoke only with a user-provided secret in a local secret store, never CI, and record capability results without content.
3. Build Go adapter by endpoint family, not a universal client URL. Verify mocked Responses/Chat Completions/Messages variants as needed for the chosen model(s), plus models discovery and cap/error handling. Live smoke with a private key and synthetic non-sensitive prompt; record the chosen model/endpoint/capabilities and exact date.
4. Write docs/decisions/provider-capabilities.md with matrix: model ID, endpoint, streaming, tool calls, thought summary, audio input and transcript quality for browser/Telegram formats, token reporting, cached-token reporting, cost/cap signal, approval state, and pass/fail date. Run repeated synthetic-prefix probes and record observed cache tokens or `unreported`, not assumed savings. Verify settings rejects an ID absent from the operator allowlist and retains readable history if an ID is retired. Run root checks. Mark unsupported cells honestly.

## Done criteria

Both adapters work with deterministic fake tests. At least one handpicked Gemini model and one handpicked Go model complete a live synthetic text+tool turn with measured latency, or the matrix records the exact blocker. Settings and `/model` reject unapproved or uncredentialed provider/model IDs. Voice capability is marked approved only after a real endpoint proves accepted browser/Telegram audio, a usable transcript, and the required tool behavior; otherwise that chat must use an explicit transcription provider or see voice unavailable. One workspace can connect both providers with shared keys and run different approved models in different member chats. No raw credential appears in output or event logs. The agent layer can be tested entirely through a fake provider.

## STOP conditions and maintenance

Stop and report if Go's actual API behavior or account policy blocks the intended private use, if neither chosen model supports reliable tool calls, or if a provider SDK cannot run in Workers. Do not route real customer traffic through an untested model. Before commercial reliance on Go, re-read its then-current usage guidance and obtain a clear product decision; keep Gemini as a viable route. Re-evaluate models on provider changes rather than hardcoding the 2026 catalog.

Official references: https://dev.opencode.ai/docs/go/ ; https://ai.google.dev/gemini-api/docs/caching ; https://ai.google.dev/gemini-api/docs/pricing ; https://ai.google.dev/gemini-api/docs/function-calling ; https://ai.google.dev/gemini-api/docs/audio ; https://ai.google.dev/gemini-api/docs/streaming
