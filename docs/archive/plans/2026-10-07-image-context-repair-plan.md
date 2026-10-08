> Historical record, archived 2026-10-07 from `plans/2026-10-07-image-context-repair-plan.md`. Its claims apply to the original baseline. Use [current implementation status](../../status.md) for active work; old proposals and DONE labels are not current authority.

# Reliable visual context for Otis

Status: SPECIFIED, not implemented. Revised 2026-10-07 after the user rejected an unnecessarily limited workaround. Priority P1; effort M; medium payload/provider-loop risk. Initial source `06ee63c`, further inspection at `b6d84a2`. Preserve unrelated work. The former four-images-for-the-whole-request cap and deferral of older-image retrieval are withdrawn. Core work uses existing D1/R2 and the agent loop, plus an attachment query resource and one image-read tool. No vector store, caption model, image-memory service or new workflow engine.

## Problem and resulting behavior

Otis accepts still images into private R2 and durable `message_image_attachments` receipts. The handler loads images only for the current run/source on round zero. `getTurnContext` retrieves previous messages as text, with no attachment references. A same-chat follow-up therefore gets the original text/answer but no pixels. Stateless later tool rounds also lack pixels. Muse Spark 1.3 Contributor uses Otis's `go-responses` adapter, which replays full input without a `previous_response_id`.

Result: immediate follow-ups receive the relevant retained image on their first model request. Older-image questions and comparisons work through discovery and re-reading, without asking the user to re-upload. Every full replay keeps its active visual inputs; a truly linked Gemini continuation sends only new input. Attachment identity survives context truncation, reload, actor restart and model changes. Existing retention and membership rules still apply. Request budgets govern temporary visual context, not durable attachment discoverability.

## Relevant code and conventions

- `apps/worker/src/agent/context.ts`: batched D1 context queries, recent-message types and chronological mapping; default 10 messages, not 10 complete exchanges.
- `apps/worker/src/agent/handler.ts`: historical provider message assembly around 575; current images around 650–715; R2/base64 helper around 65; current continuation state and run checkpoints.
- `packages/agent/src/providers/types.ts`: `ProviderMessage.images`, `TurnInput.messages`, `previousContinuation`, image count/MIME/encoded bounds.
- `packages/agent/src/providers/opencode-go.ts`: Go chat/Responses image mapping already works for any supplied user message. The Responses body around 1518 does not use previous response lineage.
- `packages/agent/src/providers/gemini.ts`: `toInteractionsInput` excludes replay when a real interaction ID exists. Preserve this behavior.
- `packages/contracts/src/media.ts`: JPEG/PNG/WebP, 4 images per message, 5 MiB per image. These upload bounds do not bound accumulated history by themselves.
- `apps/worker/src/inbox/repository.ts`, `media/routes.ts`: scoped receipts/private media ownership, acceptance and retrieval. Reuse these rules; do not grant access from a model/client-supplied media ID.
- `apps/worker/test/media-images.integration.test.ts`: actual local Workers/D1/R2 fixtures. The test around 439 currently asserts all later rounds omit images; change that contract for stateless replay.
- `packages/agent/test/provider-images.test.ts`: mocked wire mapping and capability gates. Fake replies never establish real vision support.
- `apps/worker/src/agent/repository.ts`: `executeAgentTool` and existing scoped query/read bridge. `query` currently has no attachment resource.
- `packages/agent/src/tools.ts`, `policy.ts`, `prompt.ts`: add the image-read schema, read policy and model instructions here. `ToolResultBlock.resultText` is currently text-only; declaring a tool alone cannot deliver pixels.

## Implementation

1. **Preserve attachment identity independently of the text window.** Build a lightweight manifest from existing D1 attachment receipts: media/source-message ID, ordinal, timestamp, source-text excerpt, format and availability. Object keys stay server-side. Retrieve recent attachment entries independently of the current 10-message text window, using existing bounded query/pagination conventions. Scope chat/workspace and matching joins. Older entries remain discoverable in D1; no new canonical manifest table is needed. Compaction preserves source/attachment references, not base64 or invented captions. Reconstruct original user-message envelopes for selected images, including when that message has left the text window.

2. **Automatically maintain an active visual set.** Include new attachments, the latest image-bearing message group and explicitly referenced images so ordinary “rate it”/“what color is it?” follow-ups work on the first request. Preserve IDs of tool-viewed images in run progress so subsequent rounds/restarts retain them; never checkpoint base64. Deduplicate source envelopes. Separate per-message upload bounds from whole-request limits: a four-image upload rule does not justify a four-image conversation/comparison cap. Determine request byte/token/image budgets from actual endpoint limits and measured Worker memory/CPU. Use normalized renditions or tool-driven subsets for a larger comparison; keep every retained image discoverable. Do not silently omit required visual evidence or send all historical pixels forever. No extra LLM classifier is needed for current/latest/explicit references; ambiguous older references use the read tools below.

3. **Hydrate on full replay, not just round zero.** Put selected bytes on their original `ProviderMessage` user entries and preserve text. Always include current selected images in each stateless request. For a valid linked Gemini interaction, hydrate only genuinely new image input; do not resend the old opening image as a new turn. Go Responses currently uses replay, so it needs the images on every tool round. A session/cache header does not change this rule. Avoid duplicating the current message already excluded by run/source in context.

4. **Reuse reads/encoding within the execution slice.** A small local map keyed by selected media ID can reuse image content across full replays in that slice; bounded concurrent R2 reads avoid serial waits. Do not keep an unbounded actor-global cache, persist base64 or rely on the map after restart. Revalidate current membership and retained/scoped metadata before sensitive reads, including resumed/restarted slices. An expiry or removal cannot be bypassed by stale cache state. Read/encode only the selected set. Evaluate the existing per-byte string encoder's memory/CPU with realistic objects rather than adding a decoding library speculatively.

5. **Represent availability accurately.** Preserve text conversation when older attachments are unavailable, but give the model an honest per-message indication of what was omitted/expired/unreadable. If a newly submitted required attachment cannot be loaded, do not continue as though it was viewed; return a recoverable image-input error using existing error handling. Do not substitute an old model description for fresh visual inspection. When switching to a model marked vision-unsupported, do not break unrelated text chat merely because old image references exist; expose the capability limitation and allow a supported model choice when visual inspection is required. Keep unverified vision distinct from unsupported and run a real exact-route probe before recording capability support.

## Verification and completion

Use the actual local Workers/D1/R2 fixtures for upload → original answer → separate same-chat follow-up. Assert original image bytes reach the provider input, attached to the correct historical message, and the upload/receipt still exists only once. Repeat after constructing a new handler to prove recovery does not rely on in-memory state. Use a real Go Responses adapter with intercepted network bodies to assert historical `input_image` presence; test Go chat too. For linked Gemini continuation, assert no duplicate opening user/image turn and valid interaction lineage.

Cover image-only original text, multiple ordered attachments, original text retained, current plus historical attachments, tool round two, expiry/missing R2 bytes, excluded groups/budget boundaries, unsupported model switches, revoked membership and other workspace/chat attachments. Prove no image bytes/URLs leak through progress or logs. An immediate follow-up must not be classified using an extra LLM request. Update the existing omission regression to match endpoint semantics.

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, plus targeted worker/pure image suites. Measure D1 reads, R2 reads, encoded request bytes, peak Worker memory/CPU, first-text/completion latency with realistic 1/4-image inputs. Live vision claims require a non-sensitive known-answer image on the exact model/endpoint; do not send the user's supplied photos for diagnosis. The existing diagnostic in `plans/qa` intentionally asserts the current defect and must not remain a required repaired-behavior regression.

Done when an immediate follow-up and stateless tool continuation both retain the selected original image, linked continuation remains faithful, retries/restarts preserve that behavior, and scoped/bounded handling passes. Update relevant media/context contracts and plan status with actual evidence. No commit/push/deployment is authorized by this investigation.

## Required older-image discovery and actual read delivery

Older-image retrieval is part of this feature's completion, not an optional future gate. Extend existing `query` with `attachments`, scoped to the current chat, with bounded pagination and straightforward source-text/date/first/latest lookup. Return real metadata and IDs; do not require a vector index, fabricated caption or a new general search service.

Add `view_image(media_id, detail?: standard | original)` as a read tool. Check current membership, source/chat/workspace ownership, validation and expiry. Its durable result stores resolved media/source IDs and availability. The handler hydrates the actual pixels for the next provider request. Keep logical read steps/results in the existing loop, with no business ledger event or fake user message written to chat. Multiple reads in one round can share bounded parallel R2 hydration. The model gets recent manifest references or discovers older ones through `query`; the user never needs to supply internal IDs.

Extend ephemeral provider input/tool-result structures for hydrated read images. Durable CommandResult/checkpoints keep only references; image bytes must not be serialized into ordinary JSON tool output. For Gemini Interactions, map images to the matching `function_result.result` image/text blocks; Google documents multimodal function responses for Gemini 3. Preserve linked call IDs and interaction semantics. [Official function responses](https://ai.google.dev/gemini-api/docs/function-calling#multimodal-function-responses).

For Go Chat/Responses, retain normal tool-result text and use the existing user-image content mapping for an attributed tool-supplied visual input immediately after that result. This is provider-request context, not a persisted user-authored message or authority grant. Keep source/call IDs for replay ordering/deduplication. Do not assume the Go endpoint implements newer OpenAI multimodal function-output extensions. Test real adapter wire bodies. Full replay includes the active selected images; linked Gemini sends only newly read visual content.

## Transfer and detail optimization

Retain the validated original and reuse a standard inference rendition for large images, with `detail: original` available for small text or precise inspection. An approximately 2000 px maximum edge is a starting rendition target from the researched harness pattern; verify document readability instead of treating a thumbnail as sufficient evidence.

Cloudflare's Images Worker binding transforms private R2 bytes without a public URL and currently includes 5,000 unique transformations/month on Free. It is not configured in Otis today. Add it for the implemented normalization path, generate/reuse a deterministic versioned R2 rendition, and delete derived bytes with the original under existing cleanup/erasure rules. Avoid transforming on every model round. If the transform is unavailable, preserve original-image access. No new image-storage product is needed. [Private-byte binding](https://developers.cloudflare.com/images/optimization/binding/), [pricing and free limits](https://developers.cloudflare.com/images/pricing/).

Provider file references or genuine cross-turn continuation can further reduce transfer once exact endpoint support is verified. D1/R2 remains the reconstruction source across model changes/restarts. Session/cache headers alone are not conversation lineage. Record request bytes, token usage, R2 reads and transform counts; do not reduce capabilities to avoid measuring performance.

## Full-feature acceptance additions

- More than 10 intervening messages → attachment query/view → original pixels, without re-upload.
- Two old/new image-bearing messages → comparison; more than four small images remains possible within actual endpoint/memory limits.
- Image-read tool → actual pixels on next provider call, original call/source attribution intact; restart reconstructs from IDs.
- Model switch → canonical image reconstruction; no dependence on an old provider session.
- Standard rendition → original-detail read, with readable small-text fixtures and correct derived-object cleanup.

Implement metadata/active replay, then query/view with multimodal delivery, then rendition/reuse optimization as dependent slices of one feature. Update shared tools/schema versions, prompt guidance and provider fixtures together. Add a schema migration only if persisted variant metadata requires one. Complete the original verification plus these cases before marking this plan built.
