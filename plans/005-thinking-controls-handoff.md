# Model thinking controls — implementation handoff
Status: IMPLEMENTED; requested by Avi on 2026-10-03. This is an extension across existing gates 005–009, not another foundation gate. Implemented with additive migration 0009_thinking_controls.sql, provider mappings, commands and tools, immutable run snapshotting, UI controls, and verified test coverage.

## 1. Outcome and scope

**Placement update, 2026-10-03:** design-tokens.md and design.md supersede all older web placement examples in this handoff. No thinking/model controls inside the composer. Preserve verified provider mappings, immutable run snapshots, shared commands and author checks; place optional controls in slash suggestions and quiet chat overflow. Web configuration applies without chat bubbles or LLM turns. The earlier implementation status does not establish acceptance of this newer visual/behavior baseline.

Let the author choose the current chat's thinking effort through `/thinking`, on web and Telegram, with the same setting accessible beside the model choice in the web UI. The backend must send the actual verified provider parameter. Merely adding a prompt such as “think harder,” changing a label, or recording reasoning-token usage does not implement this feature.

Default: **Provider default**. Otis omits an explicit thinking parameter until the author chooses one. This is not a promise that thinking is disabled or that the provider always uses the same amount of computation. Do not impose high effort on every message or add automatic effort selection in this change.

Settings belong to a chat and its effective model. Workspace model defaults and shared credentials remain as implemented. Do not add a workspace-wide thinking default, per-member global preference, temporary one-message override, custom token-budget slider, or another provider service for this version. Teammates may inspect the setting through shared history but only the chat author can change it.

An explicit natural-language request such as “use high thinking for this chat” must ultimately use the same validated settings owner as the command. It must not be treated as authorization for the agent to increase its own effort whenever it wishes. Implement the deterministic command and owner first; expose that owner to the existing typed agent-tool boundary as a small settings operation, without a separate classifier/model call. An uncertain or unsupported request receives a brief clarification with the actual available choices.

## 2. Read and inspect before editing

Read root AGENTS.md, product.md, architecture.md, design.md, docs/contracts.md, the decision register, plans/README.md, and the existing 005/006/007 handoffs. Inspect the live working tree: substantial 007 and UI changes are present. Preserve all unrelated modifications; never reset the tree or overwrite another agent's work.

Current relevant owners, inspected 2026-10-03:

| Responsibility | Existing owner |
| --- | --- |
| Exact model IDs and verified capabilities | `packages/agent/src/providers/registry.ts` |
| Provider request contract | `packages/agent/src/providers/types.ts` (`TurnInput`) |
| Gemini Interactions transport | `packages/agent/src/providers/gemini.ts` |
| Go Chat Completions / Responses transports | `packages/agent/src/providers/opencode-go.ts` |
| Provider/model resolution | `apps/worker/src/providers/service.ts` |
| Accepted-message transaction and accepted-run model key | `apps/worker/src/inbox/repository.ts` |
| Dispatch model snapshot and bounded loop | `apps/worker/src/agent/handler.ts` |
| Shared command metadata/parser | `packages/commands/src/registry.ts`, `parse.ts` |
| Command validation and acceptance | `apps/worker/src/routes/commands.ts` |
| API contracts | `packages/contracts/src/chat.ts`, `index.ts` |
| Current UI | `apps/web/src/ConversationScreen.tsx` and its components/hooks; inspect exact model-picker owner |
| Telegram completion | `plans/009-telegram.md`; do not claim its unimplemented surface is ready |

At inspection, registry capabilities include text/tools/stream/audio/public summaries, but no thinking-control definition. TurnInput and both real adapters lack a selectable effort field. Reasoning-token accounting already exists. The shared command registry has `/model` but no `/thinking`.

The index records 006 independently accepted and 007 implemented but not yet accepted. Keep that historical acceptance intact; this is additive work. The current migration list ends at 0008, but inspect again before allocating an additive migration. Never rewrite an applied migration.

## 3. Provider evidence: do not invent universal levels

Official sources checked 2026-10-03:

- [Google thinking documentation](https://ai.google.dev/gemini-api/docs/thinking): Interactions requests use `generation_config.thinking_level`. Its current table lists `gemini-3.5-flash-lite` with `minimal`, `low`, `medium`, `high`, default minimal. Model documentation does not establish availability with our credentials or approve a currently disabled registry entry.
- [Google Gemini 3 developer guide](https://ai.google.dev/gemini-api/docs/gemini-3): documents model-specific thinking levels, including 3.1 Flash-Lite. The page is marked deprecated; consult its linked current guide before enabling options.
- [Google SDK issue 1581](https://github.com/googleapis/js-genai/issues/1581): historical report that stable `gemini-3.1-flash-lite` rejected minimal/medium through Interactions while low/high worked. The issue is closed. This is a reason to verify the exact endpoint, not evidence that the historical failure still occurs today. Do not silently replace the stable model with preview or migrate endpoints to make a dropdown pass.
- [OpenCode model variants](https://opencode.ai/docs/models/): describes application configuration and provider-dependent variants. OpenCode's application-side `reasoningEffort` configuration is not proof of a wire parameter accepted by the Go gateway for our models.
- [OpenCode Go documentation](https://opencode.ai/docs/go/): subscription/gateway reference. Do not infer MiMo/Muse effort controls from generic OpenAI compatibility.

Keep all current handpicked model IDs and enabled/disabled status intact. Exact Go effort parameters for MiMo V2.5, MiMo V2.6 Pro, Muse Spark 1.2 Contributor, and Muse Spark 1.3 Contributor remain **unverified by this handoff**. Native audio support is a different capability; it establishes nothing about configurable thinking.

For each actual model + endpoint, record: adjustable-control support state; option IDs and readable labels; exact native field/value mapping; documentation link; sanitized probe outcome; verification date. Mark supported options individually when some levels work and others fail. Do not expose `xhigh`, `max`, `none`, or `off` simply because another model/provider has them. In particular, Minimal must not be renamed Off.

An HTTP 200 alone may mean an unknown parameter was ignored. Evidence needs documented parameter semantics for that endpoint plus a controlled roundtrip exercising text, streamed completion, and tool continuation with the chosen value. Capture explicit API validation/acknowledgment if the provider offers it. Token counts alone do not prove a setting was honored. If evidence remains ambiguous, retain unverified status and explain it; do not fabricate certainty.

Use existing controlled synthetic smoke infrastructure. No live calls in ordinary tests/CI. Read keys through the established private environment/file mechanism; never print or persist them in reports. Respect the user's no-additional-paid-inference constraint and existing authorization/bounds. Stop with an exact evidence gap if a paid probe would be required.

## 4. Minimal capability and request contract

Extend the existing registry entry with a small optional thinking-control descriptor. Keep one implementation owner. It should express `unverified | supported | unsupported`, and a finite set of verified choices. Each choice includes a stable command ID, readable label, native mapping, and evidence reference/date. Omitted descriptor in old fixtures means unverified; it must never manufacture options.

Use an endpoint-specific discriminated union for mappings rather than arbitrary client-supplied JSON. Examples of potential mapping shapes:

```ts
type ThinkingRequest =
  | { kind: 'provider_default' }
  | { kind: 'gemini_level'; level: string }
  | { kind: 'go_chat_effort'; effort: string }
  | { kind: 'go_responses_effort'; effort: string };
```

These are shapes, not preapproved Go parameter claims. Add an actual provider-specific toggle/budget shape only if an existing handpicked model verifiably requires it. Allowed values come from server-owned registry choices; a free-form string from the browser, chat, or tool must not reach transport. Use existing runtime validation conventions rather than introducing a validation framework.

Add the resolved trusted thinking request to TurnInput. Adapters accept only mappings for their endpoint family; mismatched kinds reject before fetch. Provider default sends no thinking field, not null, zero, off, or an undocumented `auto` string.

Gemini's current Interactions mapping is `generation_config.thinking_level`; preserve existing max_output_tokens and other verified generation config fields. Do not copy generateContent's camelCase thinkingConfig structure into this endpoint.

For Go, establish exact wire support first. Chat Completions may use `reasoning_effort`, and Responses may use `reasoning.effort`, but these remain candidate fields until proven for the concrete Go model. Do not send both, copy OpenCode CLI's configuration verbatim, or switch endpoints implicitly.

Thinking effort and public thought-summary visibility stay independent. Preserve provider continuation/signature handling. Do not stringify private thought blocks, signatures, full prompts, or provider payloads into public activity. Existing verified public summaries may appear under Working; changing effort does not make unverified summaries available.

2026-10-04 clarification: Avi also requests a **streaming Thinking disclosure nested inside Working**. Its visibility/output contract belongs to [design.md section 6](../design.md#6-streaming-working-and-questions), [contracts section 8](../docs/contracts.md#8-activity-envelope) and [008B's Thinking handoff](008-ui-implementation-handoff.md#thinking-inside-working). Coordinate only the necessary existing-adapter normalization here. Displayable provider reasoning and provider summaries have different labels and must be verified per endpoint. Do not infer that an implemented effort selector means the provider returns text, and do not add a second settings owner or a service to generate imitation thoughts.

## 5. Durable chat setting and immutable run selection

Use a nullable chat setting containing its bound effective model key and verified choice ID, for example `thinking_override_json`. NULL means provider default. Store trusted identity/choice, not credentials or arbitrary request JSON. Validate decoded data at the owner boundary.

Add a nullable, versioned `thinking_snapshot_json` to agent_runs, or extend an equivalent existing accepted-run settings snapshot if one exists by implementation time. For new agent runs, persist an explicit provider-default or verified-choice snapshot in the same acceptance batch that stores the run's model_key. Include bound model ID/key, endpoint family, choice ID/label, trusted native mapping and mapping version/evidence identity. Do not duplicate the whole registry.

Model and effort must describe the same acceptance state. Current accepted-run model key is selected inside the committing transaction. If validated effort was derived from a pre-read, that batch must also recheck the relevant effective model and chat setting using null-safe comparisons. On a concurrent settings change, perform a bounded re-read/revalidation or return a retriable conflict; never accept a mixed pair. Use existing acceptance guard machinery rather than a new locking service.

Rules:

1. Message accepted under Model A / High keeps A / High even if still queued when the author selects Low or Model B.
2. All provider rounds, tool continuations, restart recovery, checkpoints and clarification resumption of that logical run keep its pinned effort. Steering an existing run does not change its effort.
3. Setting changes affect subsequently accepted new runs, never rewrite old run snapshots or regenerate previous answers.
4. Registry changes must not silently reinterpret a recorded option. A revoked/missing capability or unsupported recorded mapping produces an honest configuration error. No downgrade to default or paid/alternate model to rescue it.
5. Old runs with no thinking snapshot resume using provider-default semantics because that is what their original adapter sent. They must not inherit today's chat setting. Handle this compatibility explicitly, without rewriting business history.
6. Changing the effective model clears an incompatible model-bound choice to provider default and says so in the same command reply. Selecting the same effective model preserves its choice. `/model default` preserves only if the effective model remains the same.
7. When a workspace default later changes the effective model of an inheriting chat, its previous model-bound preference no longer applies. Return a visible provider-default/reset reason on the next read/turn; never map High from the old model to the new one silently. No workspace-wide scan/job is needed.

Extend the existing handler's ModelSnapshot/read path as needed, but consume accepted settings rather than resolving mutable chat preferences again. Make every real TurnInput carry the pinned mapping. Keep credentials separately resolved/decrypted as today; snapshots never contain a raw key.

## 6. Commands, settings owner and authorization

Register `/thinking [level|default]` in the existing shared registry/parser/help. Both surfaces use the same handler and validation owner.

| Input | Behavior |
| --- | --- |
| `/thinking` | Show current model, current thinking selection, and only verified available choices; perform no settings mutation |
| `/thinking high` | Validate High for this effective model; save the model-bound choice and a durable attributed confirmation |
| `/thinking default` | Clear the override; confirm Provider default |
| Unknown/unsupported level | Explain actual available choices; zero settings mutations and zero provider calls |
| Adjustable support unverified | Say controls have not been verified for this model; preserve provider default |
| Adjustable support unsupported | Say this model has no adjustable thinking control; preserve provider default |

Match current first-token parsing, Telegram bot suffixes, escaping, argument limits and command idempotency. Do not add `/effort` aliases or command synonyms until needed. List levels in a predictable model-specific order with readable labels, including Extra high only when verified. Use full model display names in confirmations.

Reuse the accepted-command transaction to write chat preference, source message, command receipt/run and public reply atomically, guarded by live membership and chat authorship. A replay with the same message ID must return its recorded reply without reapplying an older setting. A reused ID with a different payload remains a conflict. Do not place this non-business setting in the business ledger or invent another business write path.

The small natural-language settings tool must call that same owner with current trusted author/workspace/chat scope, existing attempt/fence guards where run-owned, and an idempotent tool action identity. It changes future-run settings only. An explicit request can be saved directly; ambiguous requests such as “be smarter” should ask what the user means rather than silently choosing expensive effort. Add its declaration only after command semantics and authorization are tested.

## 7. API and UI

Extend existing model/current-chat DTOs with current choice, provider-default state, capability state, verified choices, and a readable unavailability/reset reason. Reads follow existing workspace membership checks. Do not return raw native provider configuration just to power a selector; the client needs choice IDs/labels only.

The web control is a small Thinking submenu/row attached to the existing model choice. Avoid a permanent toolbar, extra card, or technical settings page. Show the selected readable level only where it helps explain the current configuration. The full chat remains the primary interface. The command picker suggests `/thinking` and its actual choices. Hide the selector when no adjustable choices are verified, while `/thinking` can still explain why.

Mobile: follow design.md touch-target, focus, safe-area and bottom-sheet/menu rules. Changing a level must not submit the draft composer, lose text, shift the transcript, or cover the send control. Keyboard and screen-reader users can identify current selection and dismiss the menu. Read-only teammate chats show the chosen setting without author controls.

Use the same accepted command endpoint and idempotency mechanism for picker actions; do not create a less protected browser-only PUT path. Announce saved selection after durable acknowledgment. On failure retain the prior selection and draft. Short confirmation: “High thinking for this chat. It applies to your next message.”

Telegram gate 009 registers `/thinking`, returns the same model-specific choices and may expose existing authenticated callback choices. Callbacks are opaque/bounded/server validated, bound to the requester and current effective model. Stale callbacks must not apply a choice to a different model after a switch. Do not declare Telegram integration accepted before the channel exists and is tested.

## 8. Budget, latency and caching

Keep existing run/token/time limits. Higher effort does not authorize increasing those limits or buying credits. Present one short explanation at the selector if useful: higher thinking can take longer and use more tokens. Do not promise exact cost multipliers or that High always improves quality.

Google's Interactions documentation says max_output_tokens includes thought tokens, and reaching it can leave an incomplete/empty response. Preserve incomplete/limit handling so partially generated tool arguments never execute. Do not manufacture an answer or retry forever with increasingly high effort. Any retry stays bounded with the same pinned setting; partial committed actions remain accurately reported.

Continue recording actual reported reasoning usage; unavailable values remain unknown, not zero. Avoid double-counting thought tokens already included in totals. Preserve existing stable system/tool prefixes. Do not inject thinking configuration into the business-memory text merely to set a transport field. Any application request/cache fingerprint for reusable generated output must distinguish the effective thinking request. Provider context-cache reuse follows documented compatibility; do not assume a different effort forces a cache miss or guarantees a hit.

## 9. Decisive verification

Extend existing owning suites, using deterministic fake providers/mock fetch. At minimum:

1. Registry exposes only evidenced options; absent metadata is unverified; invalid choice and endpoint mismatch reject before fetch.
2. Gemini request uses exact Interactions field with existing generation config intact. Default omits the field. Each verified Go mapping is tested against its own endpoint; no cross-endpoint fields.
3. `/thinking`, `/thinking high`, `/thinking default`, unknown values, bot suffixes and escaped literal text share parser semantics and make no LLM calls.
4. Author writes succeed; teammate writes and removal between route check and commit fail with no partial mutation/activity.
5. Identical command replay returns the original receipt and does not roll back a newer preference; changed-payload reuse conflicts.
6. Pause accepted run A before dispatch, change effort and accept run B: provider requests for A retain old effort and B use new effort. Repeat with a model switch and with concurrent acceptance/settings transactions; no mixed model/effort pair.
7. Pause after a tool result, restart the handler with persisted rows, change chat effort, then resume: all remaining provider rounds retain original mapping and no tool effects duplicate.
8. Ask a clarification under High, change to Low, then answer: original run keeps High. A separately accepted new request uses Low. Old snapshot-less fixtures/runs use default.
9. Different-model switch clears choice with recorded confirmation; same-model selection preserves it; a changed workspace default never inherits an incompatible old choice.
10. Model/capability unavailability after pinning fails honestly instead of switching/downgrading. Budget/incomplete errors cause no execution of truncated calls.
11. Natural-language settings tool calls the same owner, cannot target a teammate chat/workspace, cannot change the current pinned run, and does not elevate effort without explicit instruction.
12. UI shows readable current choice and model-specific options; failure/replay preserves draft and selection. Native browser checks cover phone/desktop geometry, menu focus and keyboard dismissal when gate 008 ships. Do not introduce Playwright.

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and `git diff --check` after source changes. Use existing local TEMP workaround if needed without modifying machine-wide variables. Report exact outcomes and focused regression locations. Mocks prove our serialization/ordering, not the remote provider's capability. Separately attach bounded live synthetic evidence for each enabled model/endpoint/option, or explicitly leave that choice unavailable.

## 10. Delivery order and documentation

Deliver as small reviewable parts inside the existing gates:

1. 005 extension: evidence, capability descriptor, request validation and adapter mappings. Unsupported/unverified entries continue working at provider default.
2. 006/007 extension: additive durable settings/snapshot, shared owner, `/thinking`, DTOs, accepted-run ordering and regression tests. Natural-language settings operation reuses that owner.
3. 008/009 integration: minimal selector/command discovery and Telegram binding as those surfaces complete. No fixture-only button advertised as functional.

Update product.md command/settings behavior, docs/contracts.md runtime DTO/accepted-run contract, architecture.md snapshot boundary, docs/decisions/provider-capabilities.md exact evidence, design.md selector behavior and relevant existing gate/handoff files. Keep future-work status explicit; do not imply a reviewed gate retroactively proves this new feature. This planning change itself only writes under plans/.

Done means a verified selectable option travels from an authorized attributed user action into the exact provider request, survives queue delay/restart/clarification without changing, and is represented honestly in chat. Return changed files, tests, sanitized live evidence or explicit gaps, migration compatibility and independent-review status. Do not mark ACCEPTED yourself. No deployment, generic effort router, new infrastructure or unrelated refactor is required.
