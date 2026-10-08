# Providers and capability evidence

[Registry](../packages/agent/src/providers/registry.ts) owns offered model IDs, command keys, endpoint family, effort choices and modality evidence. Do not maintain a duplicate model matrix here. This is configuration/evidence guidance; [status](status.md) records outstanding acceptance.

## Credentials

[Provider service](../apps/worker/src/providers/service.ts) resolves optional encrypted workspace BYOK first and the matching Worker platform secret otherwise. Platform keys support default use without per-workspace setup. The identity credential service owns encryption/replacement/status guards; raw keys never return to the client or enter prompts/logs/exports.

Conversation providers and Groq STT are separate roles. Remove/replace a key through the existing authorized route; reverify the current credential version. A old probe's success cannot mark a replacement key verified.

## Exact route and continuation

- Gemini adapter uses its configured exact API/model and linked interaction continuation. Preserve original content/call identity and use full replay only under the implemented continuation failure rules.
- OpenCode Go adapters use model-specific Chat Completions or Responses routes. Current Responses replay is stateless: preserve prior calls, exact arguments/results, source text and selected images every round. A cache/session header is not provider-side conversational memory.
- Normalize streaming text, completed tool calls, safe usage/errors and actual allowlisted displayable reasoning separately. Never execute an unfinished tool call or fabricate missing arguments.
- Run model/effort snapshots remain fixed for accepted work. Later selection affects subsequent work and does not rewrite an in-flight run.

Use [Gemini API documentation](https://ai.google.dev/gemini-api/docs), [OpenCode providers](https://opencode.ai/v2/docs/providers/), [OpenCode Go](https://opencode.ai/v2/docs/console/go) and [Groq speech documentation](https://console.groq.com/docs/speech-to-text) when implementing/changing wire behavior. Private Go dogfood integration is settled; commercial reliance remains separate. This cleanup did not rerun live provider probes or approve new models.

## Voice and vision

Text/tool capability does not imply native audio/vision. Resolve verified exact model/endpoint and actual container; use configured verified Groq if native transcription is unsupported/unverified. Auth/quota/outage is not capability absence or permission for an undisclosed fallback. No automatic paid route.

Image attachments retain D1 receipts/private R2 source bytes. Current replay/view/rendition code supports follow-up access; fake PNG bytes and wire-mapping tests do not prove actual visual understanding. Android/iPhone/Telegram audio and representative photo/document inputs require exact-route live evidence.

Thinking displays only the adapter's verified exposed channel and accurate normalized semantics. A control accepted by an endpoint is not proof of every model's thought display, native input format, cache hit or quality.

## Retained evidence

[Historical live-provider report](005-live-provider-evidence.md) remains at its stable path because registry/test evidence references point there. Treat every dated model/route/case as historical evidence, not a fresh all-capabilities claim.

Later synthetic live cases remain in [Telegram/provider evidence](../plans/qa/telegram-capabilities-live-evidence.json); its [audit narrative](archive/plans/2026-10-06-telegram-and-model-integration-audit.md) records limitations and request shape. Consult each entry's actual evidence reference; official metadata and completed live cases have different strength.

`pnpm smoke:providers` is opt-in. Normal root tests use fake/mock transport and skip explicit live voice execution. Never print keys or load secrets into a client/browser to run a probe. Measure first useful token/complete response/round count with fixed model, effort, prompt/history and tool set; a single historical latency sample is not a native-harness parity result.
