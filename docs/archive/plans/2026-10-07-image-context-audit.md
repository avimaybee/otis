> Historical record, archived 2026-10-07 from `plans/2026-10-07-image-context-audit.md`. Its claims apply to the original baseline. Use [current implementation status](../../status.md) for active work; old proposals and DONE labels are not current authority.

# Otis image context across follow-ups

Status: root cause reproduced locally; complete repair specified, 2026-10-07. Source baseline `06ee63c`; unrelated UI/document changes are present and preserved. Read-only application audit; no subagents or production messages submitted. Recommendation revised after the user rejected unnecessarily reduced functionality.

Concurrent HEAD reached `b270e7e` before handoff. The inspected worker context/handler, provider adapters and canonical image integration test did not change between those commits. Current web/question-panel edits belong to another ongoing pass.

## Running observations

1. **Historical messages have no image metadata in assembled context.** `apps/worker/src/agent/context.ts` defines recent messages with text/author/sequence, and the handler rebuilds them as text-only provider messages. Verify the SQL and adapters next. This directly matches the reported follow-up behavior; the screenshots alone do not prove which provider payload was sent.
2. **Images are loaded only for the current run/source on round zero.** `agent/handler.ts:657` gates attachment hydration on `progress.roundIndex === 0`; its SQL matches current `run_id` or inbound source ID. A later run does not match the previous image message. Historical image replay is missing.
3. **Later tool rounds may also lose images.** Each loop reconstructs provider messages while the image load is round-zero-only. Linked stateful continuations may retain the earlier image within a run; stateless chat-completions must replay it. Adapter tracing is pending.
4. **Unavailable bytes silently degrade to text.** Invalid/expired/missing image objects are skipped or caught, with server logs, and the provider still receives the available text. This can produce confusing visual claims followed by inability to inspect; error/availability handling needs review.
5. **The existing regression test enshrines the omission.** `apps/worker/test/media-images.integration.test.ts:439` explicitly expects no images on every later round. It checks a scripted fake answer, not whether the actual endpoint retains visual input. This is only safe for a correctly linked stateful continuation; it is wrong for stateless replay.
6. **The screenshot's Muse model uses stateless Responses replay in Otis.** `packages/agent/src/providers/registry.ts:337` resolves Muse Spark 1.3 Contributor to `go-responses`. `opencode-go.ts:1518` sends `toResponsesInput(input)` without `previous_response_id`; historical text/tool items are replayed, but missing image fields cannot be reconstructed by the adapter. The session header is present for routing/cache affinity and is not a conversation-history reference.
7. **Adapters already preserve images when callers supply them.** Gemini maps image parts, Go chat maps image_url parts, Go Responses maps input_image parts for user messages throughout `input.messages`. The missing link is message/history hydration, not a need for a different image API.
8. **Real local Workers/D1/R2 probe reproduced both losses.** The original request carries 1 image, the next tool-round input carries 0, and a separate same-chat follow-up carries 0 with `previousContinuation: null`. Original question/answer text remains in the follow-up. The media remains validated in R2 with its D1 attachment receipt. This isolates request assembly from upload, UI rendering, expiry and provider model reasoning. The fake adapter supplies no vision capability evidence; it only records actual orchestration inputs.

## Evidence boundary

No production payload or live inference has been captured. Observations 1–7 are source-traced; observation 8 is a local orchestration reproduction. The model's statement that it cannot see images is not proof of model capability or proof that the original answer was guessed.

## Reproduction and exact checks

`pnpm exec vitest run --config plans/qa/2026-10-07-image-context.vitest.config.ts --reporter=dot` — 1 diagnostic test passed using actual local Workers/D1/R2 and a recording fake provider. The diagnostic intentionally asserts the **current defect**, not the repaired behavior. Its initial run failed package resolution from `plans/qa`; local imports were corrected and the successful run below produced:

```json
{"openingImages":1,"nextToolRoundImages":0,"followupImages":0,"historicalTextPresent":true,"originalImageStillStored":true,"followupContinuation":null}
```

`pnpm exec vitest run --project worker apps/worker/test/media-images.integration.test.ts --project pure packages/agent/test/provider-images.test.ts --reporter=dot --silent=passed-only` — 2 files / 19 tests passed. These establish existing storage/first-turn adapter mapping, not correct follow-up handling. Full application checks were not rerun because application source was not changed.

[Recorded diagnostic evidence](../../../plans/qa/2026-10-07-image-context-evidence.json), [reproducible probe](../../../plans/qa/2026-10-07-image-context.probe.test.ts), [probe configuration](../../../plans/qa/2026-10-07-image-context.vitest.config.ts). Local Markdown link/JSON/conflict checks and `git diff --check` passed; only line-ending warnings were printed. Preserve the probe as diagnosis, not a future regression that requires the bug to remain.

## How the native harnesses handle this

- **Codex:** OpenAI documents a `view_image` tool that attaches an image from a local path to the current context, so stored files can be viewed again. Conversation context must contain visual items or a valid continuation; keeping a file path also makes re-reading possible. OpenAI's Responses API can chain state with `previous_response_id`. These are documented building blocks, not a claim that every desktop/CLI version uses one identical private implementation. [Codex tool reference](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide), [conversation state](https://developers.openai.com/api/docs/guides/conversation-state).
- **Claude Code:** Its documented workflow accepts pasted/dropped images and file paths, supports multiple images in a conversation, and retains session conversation history. Claude's vision API docs explicitly describe resending full history in multi-turn requests, including earlier image blocks; Files API references reduce payload transfer. Follow-ups don't need the user to reattach the same image to the new message, because it remains in the earlier message's content. Context compaction has limits and may discard detail. Do not infer permanent pixel memory. [Image workflow](https://code.claude.com/docs/en/common-workflows#work-with-images), [vision](https://platform.claude.com/docs/en/build-with-claude/vision), [context lifecycle](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up).
- **OpenCode:** Attachments and the built-in read tool return actual image media. Its normalizer can resize/encode to bounded dimensions/bytes. The Go session header is documented for routing and prompt caching, not a substitute for image content. [Attachments](https://opencode.ai/v2/docs/attachments/), [Go](https://opencode.ai/v2/docs/console/go).
- **Gemini:** Interactions supports a real `previous_interaction_id` for stateful history, or full stateless replay. Otis only uses its stored within-run continuation; a new run does not inherit the prior run's image this way. [Interactions state](https://ai.google.dev/gemini-api/docs/interactions-overview).

## Recommendation revision after user feedback

Use existing D1 attachment receipts and private R2 objects. Add historical attachment references to bounded context; hydrate selected images onto their **original user messages**, preserving position and order. Current-run images must also appear on each **full stateless replay**. A valid linked Gemini continuation can send only newly introduced content. Never persist base64 in run progress, expose public object URLs or add an image-caption model call as a substitute for pixels.

Read all selected attachment metadata in one scoped query/batch; deduplicate media IDs and fetch bounded objects concurrently, with per-execution-slice reuse to avoid reading/encoding the same bytes every tool round. Rehydrate after restart. Add a total request image/byte bound: blindly hydrating every image in 10 historical messages could exceed Worker memory despite each upload meeting its own 5 MiB limit. Protect explicit/current images and the relevant recent image group; represent excluded/unavailable attachments truthfully rather than silently pretending text-only is the original input.

The original proposal wrongly reused the four-images-per-message upload bound as a whole-request history bound and deferred old-image retrieval. Those recommendations are withdrawn. Required baseline: durable discoverability from existing receipts, automatic latest/explicit-image hydration for immediate follow-ups, a scoped attachment query plus `view_image`, and actual multimodal delivery after the read. Request budgets limit a working set; they must not erase access to older attachments. Existing expiry policy still applies.

Further source inspection at `b6d84a2` found `query` only covers entities/tasks/events/drafts, and `ToolResultBlock` carries only `resultText`. Therefore merely adding an image-read declaration would not work. The revised plan includes registry/query changes and the provider payload path, keeping durable tool results as references and pixels ephemeral. Gemini documents image blocks in function results; Go can reuse its existing image-input mapping with attributed tool-supplied visual context.

Normalization and reuse are practical transfer optimizations: retain originals, serve standard renditions and allow original-detail reads. Cloudflare's Images binding accepts private R2 bytes and documents a 5,000-unique-transform monthly Free quota; it is not configured in current Otis. The revised plan uses one reused rendition rather than repeated Worker-side decoding or a public image URL. [Binding](https://developers.cloudflare.com/images/optimization/binding/), [pricing](https://developers.cloudflare.com/images/pricing/).

Detailed implementation and verification: [image-context repair plan](2026-10-07-image-context-repair-plan.md).
