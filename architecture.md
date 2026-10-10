# Otis architecture

Current source ownership, reconciled 2026-10-10 against `2bcae14`. The working tree also contains uncommitted changes, which are not treated as accepted or deployed behavior. [Product](product.md) defines intent; [contracts](docs/contracts.md) defines semantic boundaries; [status](docs/status.md) distinguishes implementation, open defects and unverified acceptance. This document does not claim the Free budget or latest deployment journey has passed.

## 1. What the architecture must make true

Accept input durably, execute authorized work once, preserve sources/history, recover interrupted work and give useful output promptly. Use one Worker application, existing workspace actors/Queue, D1 and private R2. No second ledger, speculative services, ORM or vector infrastructure.

## 2. Deployment and storage

| Owner | Responsibility |
|---|---|
| Worker HTTP | Session/membership/CSRF, bounded routes, acceptance and private downloads |
| WorkspaceActor | Immediate dispatch, bounded recovery slices, live SSE execution venue and best-effort Stop |
| D1 | Identity, conversations/sources and search indexes, runs/steps/receipts/outbox, events/projections, memory/media/brief metadata |
| R2 | Private audio/images and retained standard image renditions |
| Queue | Delayed continuation/retry hints and fallback dispatch |
| Cron | Recover durable due work, selected briefs, transcription/delivery and media cleanup |
| React/PWA | Local optimistic view, scoped drafts/outbox/capture and static offline shell |
| Provider adapters | Exact model endpoint, streaming/tool protocol, image/audio input and safe errors |

Bindings and actual entry points live in [wrangler.jsonc](wrangler.jsonc) and [Worker index](apps/worker/src/index.ts). An actor's RAM/live bus is transient; D1/R2 remain canonical.

## 3. Module boundaries

Shared contracts live in `packages/contracts`; identity/session/credentials in `packages/identity`; event commands/reducers/repository in `packages/ledger`; provider protocol, prompt, tools and policy in `packages/agent`. Commands/channels/brief kernel are shared packages. Worker `inbox`, `actor`, `agent`, `chat`, `media`, `brief` supply bindings and orchestration.

`packages/sheet` generates XLSX snapshots for the workspace export route. Worker routes also provide scoped JSON export, unified workspace search and owner-only workspace erasure. Frontend source in `apps/web/src` uses the installed TanStack query/router, shadcn primitives, IndexedDB helpers, stick-to-bottom and Markdown/GFM owners. Its current interface includes adaptive Markdown tables, workspace search, client files, Records, mobile history navigation and responsive settings.

## 4. Identity and authorization

Firebase verification establishes a server session; trusted workspace context comes from current membership. Every ID-bearing route/tool also checks workspace/resource/source ownership. A model-proposed ID never establishes authority. Teammate history is readable; append/Stop are author-scoped.

Platform keys are runtime secrets. Optional encrypted workspace BYOK takes priority. Credentials/status updates and replacement verification preserve owner/version checks. See [providers](docs/providers.md). Private media passes through membership-checked Worker routes.

## 5. Schema ownership

The single [migration sequence](migrations) owns numbering. Identity/conversation sources precede ledger references; actor, memory, media/images and briefs extend it. Inspect actual local/remote migration state, never a dated count in a runbook.

Only ledger commands write business events/projections. Other canonical stores have their own owners. Events retain schema version, committed workspace order, actor, channel, source and provenance. Tables carrying workspace-owned data include workspace scope. Ordinary event history is append-only.

## 6. Durable acceptance

[Inbox repository](apps/worker/src/inbox/repository.ts) validates membership, author/chat ownership, bounds and payload identity. Acceptance atomically persists input, chat message, logical run and outbox before returning acknowledgment. Duplicate delivery returns the original logical IDs only when owner/chat/payload match; changed-payload UUID reuse conflicts.

The browser echoes with one client UUID before the server response. An acknowledgment means input was accepted, not that tools finished. Telegram validates the installation/webhook/private identity and deduplicates installation/update identity; unsupported/unlinked input does not gain mutation authority.

## 7. Execution and recovery

[Dispatch hint](apps/worker/src/dispatchHint.ts) wakes the existing workspace actor directly after acceptance. The actor acknowledges promptly and continues through actor-owned `state.waitUntil`; the ordinary turn need not wait for Queue batching or cron.

D1 run/step/outbox records and workspace attempt/lease state make restart/repeated hints recoverable. External async inference can outlive authority: existing stale-attempt checks must remain at commits. D1's serialized ACID writes do not make an old provider result current.

Run bounded slices; persist continuation before yielding. Queue handles due retry/checkpoint hints and cron recovers lost work. Human clarification parks the typed operation and releases the execution slot. A targeted answer revalidates current context before resuming. Workspace serialization remains a deliberate concurrency constraint; per-chat execution is separate unassigned work.

## 8. Business transaction protocol

[Ledger executor](packages/ledger/src/repository/executor.ts) owns trusted scope, logical action identity, expected revision, current membership/source/attempt, pure reduction and atomic persistence. Replay returns recorded receipts; changed action payload conflicts.

A D1 batch must actually fail when a precondition fails. A zero-row UPDATE does not roll back neighboring statements. Test membership/revision/attempt loss and a late statement failure against real local D1. Preserve receipt/events/projections/revisions together.

Changed-only projection persistence exists. Actor/settings paths partly reuse scoped assertion rows; cron bounds a legacy prune, and healthy parked questions are excluded from recovery discovery. Complete projection/event reads, remaining per-operation ledger/media/voice guards and key-length-based cleanup gaps remain efficiency work. Prefer direct atomic predicates and a bounded reusable assertion when necessary; do not add consensus-like machinery or remove failure semantics to lower a statement count. [D1 batch reference](https://developers.cloudflare.com/d1/worker-api/d1-database/).

## 9. Logical tools and provider protocol

[Agent handler](apps/worker/src/agent/handler.ts) runs validated tools through [repository](apps/worker/src/agent/repository.ts), with persisted logical steps/results and provider continuation in the existing run checkpoint. A retry cannot repeat a committed effect.

Gemini linked interactions and Go stateless replay are different protocols. Keep exact call IDs/arguments/results, original relevant input and selected attachments. Stop interrupts where possible but authority checks still protect completion. Provider continuation/cache IDs are acceleration, not canonical memory.

## 10. Conflict and Undo

Commands preserve stated/inferred provenance, current field disputes and candidate history. Undo uses existing receipts/events and current revision/dependency checks. Default suffix Undo preserves unrelated work; single-action is secondary. Stop preserves committed work and does not undo it.

Terminal failed-run continuation is not implemented; ordinary delivery retry and answering a parked clarification are distinct existing paths.

## 11. Context and memory

[Context assembly](apps/worker/src/agent/context.ts) batches initial scoped reads, loads bounded recent transcript/active notes, matched entity memory/FTS, current summaries/disputes and saved brief references. [Memory refresh](apps/worker/src/agent/memory.ts) derives extractive summaries from canonical records.

Known gaps: note meaning is lost during prompt serialization; direct memory reads can return inactive entries; retrieval ranking/older text and read-only-round context reuse remain incomplete. Do not describe the current bounded window as comprehensive recall.

Attachment receipts retain original identity. The handler replays current/latest selected images and scoped `query attachments`/`view_image` reads discover older ones. Standard renditions are retained/reused; original-detail reads remain possible. Pixels are not checkpointed as base64.

## 12. Public activity and streaming

[Activity route](apps/worker/src/routes/activity.ts) forwards SSE to the same named actor used for dispatch. The in-memory bus therefore carries ordinary provider previews directly within that venue; the old blanket cross-isolate finding is superseded for this path.

[Stream publisher](apps/worker/src/agent/streamPublish.ts) emits first text promptly, coalesces previews and persists bounded text on round close; Thinking still has bounded durable batches. Final messages/receipts and activity cursors support reconnect.

Remaining work is concrete: production heartbeat still reads D1 activity; outside-actor publications depend on catch-up; reconnect triggers full snapshot refresh; agent public activity lacks the current-attempt guard and live access revocation remains periodically checked. The target is direct preview plus bounded authoritative recovery, not database polling for tokens or a new streaming service.

## 13. Media and voice

Media routes claim/upload/finalize bounded private objects, validate actual container/format, persist metadata and dispatch transcript work. Selected-model verified native transcription or configured Groq produces a durable transcript before the agent proceeds.

Local capture uses ordered IndexedDB chunks, actual meter state and interruption/review controls. Server cleanup expires retained media. Actual formats, restart/resume, codec playback and weak-network recording still need real-device/provider acceptance.

[Image renditions](apps/worker/src/media/renditions.ts) serve small originals directly and reuse one stored standard rendition for larger images. Transform failure falls back honestly to retained original bytes; repeated quota failures and large replay CPU/memory are measurement work.

## 14. Briefs and reminders

Pure `packages/brief` handles time/DST and deterministic selection; Worker `brief/service`, `cron` and channel delivery persist/generate/send chosen-time briefs. Discovery now selects due members using `brief_next_due_utc`.

No separate one-off reminder owner exists. Explicit no-deadline task ranking is also incomplete: current brief reads cannot prove that marker. Remaining candidate caps/ordinal follow-up meaning require targeted fixtures, not fabricated reminder success.

## 15. Budgets and observability

Keep ordinary Worker CPU below 10 ms and D1 use comfortably below 5 million reads/100,000 writes per day. These are constraints, not measured guarantees. CPU excludes network waiting; row cost uses actual D1 metadata and includes scans/index writes. Worker, actor, Queue, R2 and Images limits are distinct.

Current official [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [Images pricing](https://developers.cloudflare.com/images/pricing/) were checked 2026-10-07. Images Free includes 5,000 unique transformations/month; exceeding it rejects new transforms rather than granting unlimited free normalization. Do not use query count as a CPU proof.

Record non-sensitive acceptance/dispatch/context/provider/first-text/completion timings, query rows and network/render costs. Current adapters expose usage and tool-round checkpoints retain it, but the text-only final branch does not retain its round usage; complete run accounting remains open. Extend existing run records, without a new analytics system. Never log keys, provider bodies, field notes or audio.

## 16. Operations and acceptance

[Operations](docs/operations.md) owns environment/deployment/recovery; [verification](docs/verification.md) owns commands and meaningful acceptance. A build dry run, source test, native-browser fixture, live model/device test and deployed dogfood are separate evidence layers.

Workspace JSON/XLSX export and owner-only cross-store D1/R2 erasure are implemented. Independent workbook/restore checks, backup policy, and an end-to-end production erasure/export journey remain release acceptance. The last deployment evidence recorded in [status](docs/status.md) predates the current source snapshot; do not infer deployment from a branch commit.

## 17. Frontend state and local durability

Query keys and drafts/outbox/capture use account/workspace/chat scope. The router owns selection; epochs ignore stale responses. Submitted UUID/payload remains immutable through HTTP/stream inversion, retry and reload. One scoped flush owner handles due sends; local delivery does not control server execution authority.

PWA caches the static shell, not private API/provider/media data. Update activation respects unsent work. Completed transcript rendering and optional panes should avoid repeated full work; the large entry bundle remains a measured startup cost. Workspace-only loss must not purge another workspace's unsent work; this boundary is still open in current cleanup behavior.
