# R19 — Integrate semantic retrieval into Otis's core

Status: selected for detailed planning by the user, 2026-10-10; implementation not started by this planning pass. Planned against `cc1076c` plus the current uncommitted Records and generated-documents work. This file owns implementation detail; `plans/README.md` owns backlog status. Preserve concurrent changes. No subagents, new deployments or remote resources are authorized by writing this plan.

Priority P1; effort L across six bounded slices; risk medium for retrieval behavior and high at source-access/erasure boundaries. No R16/R18 UI completion prerequisite for memory/history/context slices; flexible-record/generated-document adapters depend on those actual source contracts. Read this whole file before executing, reconcile live-source drift, and update the existing backlog/status only with evidence actually obtained. Latest user instructions override old architectural exclusions of speculative vectors: this capability is now explicitly selected, while canonical SQL ownership remains unchanged.

## 1. Outcome and boundaries

Otis should find relevant business information despite different wording or language, assemble useful context before asking the answer model, and return original evidence with fewer repeated searches. This is a shared retrieval capability inside context assembly and existing tools/search/document preparation, not another button or a separate agent. Embeddings identify candidates; current SQL sources, membership and ledger commands remain authoritative. The implementation must replace obsolete retrieval code after consumers switch, rather than stacking another system alongside it forever.

## 2. Running source observations

These observations were recorded while reading live code, not inferred from historical completion claims. Locations can drift in the current dirty tree; inspect the named symbols before implementation.

| Observation | Evidence and implication |
|---|---|
| Context reads every entity name | `apps/worker/src/agent/context.ts`, `getTurnContext`, initial batch: `SELECT id, name FROM entities WHERE workspace_id = ?`. Subsequent JavaScript substring matching scans those names and the first 200 aliases. Replace this hot-path scan with bounded indexed name/alias candidates; semantic matching must never silently authorize identity selection. |
| Memory relevance is largely recency | Same file: FTS uses the first ten cleaned tokens joined with OR, limits to five hits and orders by observation date. Final tiers then date decide context. `agent/repository.ts`, `search_memory`, independently repeats this and falls back to full-phrase `%LIKE%`. Consolidate ranking and keyword fallback behind the shared retriever. |
| Every tool result can reload context | `agent/handler.ts`, `cachedContext`: `{ sourceText, toolResults, value }`, compared against `completedToolResults.length`. Reading a source changes that count even if no business state changed. Separate reusable query vectors from source freshness, and reuse base context after read-only tools. |
| Conversation history has valuable existing guarantees | `conversationSearch.ts`, `searchWorkspaceHistory`: scoped FTS, explicit member/Otis/system attribution, family/date/author filters, exact keyword counts and stable chronological bookmarks. Semantic relevance must extend this without redefining keyword totals or promising exhaustive semantic pagination. |
| Workspace search duplicates retrieval and hides errors | `unifiedSearch.ts`, `unifiedWorkspaceSearch`: sequential category reads, LIKE matching, all entity names for labels, caught failures become empty categories; `total_matches` sums returned hits. Replace broad reads, batch independent work and distinguish failure/partial coverage from empty results. |
| Original sources and lifecycle already exist | `conversationSearch.ts`, source opening; `entities/canonical.ts`, merged identity families; ledger executor, projection diffs/Undo; memory suppressions; document extraction checksum/attempt guards; private R2. Reuse these boundaries instead of creating another business record or permission model. |
| Documents are sectioned; generated documents are concurrent work | `media/documents.ts`, `readDocument`/`processDocumentExtractions`; uncommitted `media/generatedDocuments.ts`, `publishDocument` and current revision/source-ready state. Search text sections and finalized Markdown, never an unfinished authoring buffer; detect API drift before wiring this consumer. |
| Embedding access exists, joint integration does not | Prior synthetic API calls returned Embedding 2 vectors with 768 values in 812/729/995 ms, 50 input tokens total. `wrangler vectorize list` succeeded and returned no indexes in the configured account. No binding is present in `wrangler.jsonc`. These are local network observations, not production latency/billing or joint acceptance. |
| Free storage imposes a real corpus bound | Official Vectorize Free storage is five million dimensions: 768 dimensions fits at most 6,510 vectors before any reserve. Revision duplicates, document sections and a second test/rebuild index count too. The plan must bound/reconcile inventory rather than index unlimited conversation forever. |

Further investigation and the executable design follow below; no application behavior is claimed implemented.

Additional findings: `find_entities` currently pads a weak name search with the 50 most recently updated clients; that is neither dependable typo matching nor semantic identity evidence. The context's all-name read also supplies display labels later in the function, so removing its early scan requires replacing that later dependency. The current full-phrase LIKE fallbacks can exceed D1's documented 50-byte pattern bound, even though tool queries accept 500 characters. Search must not hide such failures as “nothing found.”

Short drift anchors from the inspected code:

```ts
// agent/context.ts: wave construction and later display-name dependency
db.prepare(`SELECT id, name FROM entities WHERE workspace_id = ?`).bind(workspaceId)
// agent/handler.ts: current invalidation
const toolResultCount = progress.completedToolResults.length;
if (!cachedContext || cachedContext.sourceText !== ctx.sourceText ||
    cachedContext.toolResults !== toolResultCount) { /* getTurnContext(...) */ }
// conversationSearch.ts: semantic changes must preserve the chronological contract
if (args.cursor && mode !== 'chronological') { /* invalid_argument */ }
// agent/repository.ts: existing tool bridge accepts scoped db/storage/actor/run
export async function executeAgentTool(params: ExecuteAgentToolParams): Promise<CommandResult>
```

Follow existing pure validation/result conventions in `packages/agent/src/tools.ts`, prepared SQL and scoped typed errors in `conversationSearch.ts`, and fenced durable completion in `media/documents.ts`. Use named ESM imports and existing `.js` specifiers, direct TypeScript and current Vitest projects; do not introduce a dependency just to implement formatting/rank fusion. Examples locate conventions, not proof that every current reader is already safe.

## 3. Product rules the executor must preserve

- Ordinary capture, recall, corrections, spreadsheet assistance and document preparation remain conversational. No “choose an embedding model” control in the chat composer.
- All answering providers can use the same retrieval system. Changing the answer model to OpenCode/Groq does not change the embedding space.
- Clear writes still go directly through existing ledger commands. Similarity does not grant permission, establish a client identity, resolve a dispute, infer a lead status or schedule a deadline.
- Preserve original member/Otis/system attribution, chronology, source IDs and explicit distinction between saved facts, historical wording, generated advice and inference. An old assistant answer is not proof of a business promise.
- Existing member-specific preferences remain subject-restricted. Do not add a private-note feature or a new access-role system.
- Preserve retained shared history from before the acting member joined and from former teammates, as current policy permits. The current reader needs membership; the original reporter need not still be a member for every shared historical source. Media/background jobs retain their actual current ownership/availability checks; do not turn that into a global retroactive author-membership restriction.
- Forget/suppression, removal, expiration, deletion claims and workspace erasure take precedence over relevance. No old transcript may silently reintroduce suppressed memory.
- Tables remain general. Semantic search finds evidence; all-record reports still use exact filtered SQL pages/counts, never the top semantic matches as the whole business.
- Retained image/audio originals and vision replay stay intact. This delivery indexes their already-existing textual evidence, corrected transcripts and annotations. Direct image/audio/video embeddings are a later selectable extension, not required for this text integration.
- Unsaved Records drafts remain local/targeted draft context; do not upload them to the shared index. Otis can reason from the accepted draft overlay in the current run, and the user still clicks Save.

## 4. Target flow and replacement map

```text
Committed ledger/chat/document change
  → small indexing intent in the SAME D1 transaction
  → coalesced existing Queue wake, with bounded cron recovery
  → load current source → deterministic chunks → Gemini embeddings
  → batched revision-specific Vectorize upsert → conditional progress

User request / existing search tool
  → trusted workspace/member/filter scope
  → exact lookup + keyword candidates alongside bounded semantic lookup
  → batched current-source/access/suppression validation
  → deterministic rank + deduplicate + context budget
  → sourced evidence for initial context, tools, search or PDF preparation

Current facts / counts / deadlines / write authority
  → existing SQL and ledger owners
```

| Consumer | Replace or improve | Must retain |
|---|---|---|
| `agent/context.ts` | Whole-workspace name load, first-200 alias guess, independent FTS/recency selection; use bounded entity lookup plus shared historical retrieval | Recent transcript, attachments, current clock/timezone, own preferences, capability catalog, relevant disputes, pending question and explicit draft target |
| `agent/repository.ts`: `search_memory` | Duplicated keyword/phrase-LIKE/recency logic | Scope/subject/family filters and existing memory IDs; useful content returned with current provenance |
| `find_entities` | Recent-50 padding and broad substring-only candidates | Exact name/contact/ID priority, deterministic ambiguity and current canonical family; require confirmation for descriptive matches before writes |
| `search_workspace_history` / `conversationSearch.ts` | Relevance mode gains semantic candidates through the common owner | Chronological keyword search, keyword total and existing cursor semantics; original-source reader remains usable |
| `unifiedSearch.ts` and its route/dialog | Independent sequential LIKE owners and all-name labeling; one batched keyword/exact stage and one shared semantic request | Existing category navigation, keyboard access, current source opening; no duplicated search screen |
| Uploaded files / `read_document` | Content discovery and relevant section selection instead of filename-only discovery/repeated section walking | Full document reader, explicit section coverage, original bytes, extraction state and revision-safe cursors |
| Generated documents / preparation | Reuse relevant evidence and finalized document sections | Current factual client dossier, requested depth, source references, generated-content label, existing authoring/render owners |
| Records | Search committed special fields/custom rows and pass relevant source refs to Otis | Grid's local filtering/sort, exact Save, calculations, draft overlay and revision conflicts |
| Briefs / work / reporting | Optional contextual enrichment only when the user requests explanation | Deterministic due/overdue/status/aggregate reads; scheduled briefs must not acquire a mandatory embedding call |
| Web and Telegram | Both agent entry points use the same core retrieval | Stable accepted-message echo, explicit question answers, Stop/retry and existing transport semantics |

## 5. Small ownership layout and interfaces

Keep retrieval runtime in `apps/worker/src/retrieval/`: `profile.ts`, `embeddings.ts`, `sources.ts`, `indexing.ts`, `retrieve.ts`, and `keyword.ts`/`rank.ts` only if extracting them improves clarity. These are direct functions, not a class hierarchy, plugin registry, repository framework or second agent loop. Keep credential resolution in the existing provider service, shared response/source types in `packages/contracts`, and mutation scheduling at the actual D1 commit owners.

Add a narrow internal retrieval request: trusted workspace/member; query; purpose (`context`, `memory`, `history`, `workspace`, `document`); requested source kinds; optional entity family, chat, author, member scope and half-open dates; bounded limit/character budget; AbortSignal; optional run-local query-vector cache. Public clients/tools cannot set workspace authority, physical index, model, namespace, arbitrary metadata filters or SQL.

Return `hits` plus `coverage`. Each hit has a typed source reference, current source version, title, passage, author/source kind, observed/recorded time, entity/origin/canonical refs when known, section/offset when applicable, `matched_by` and a deterministic rank. Use a discriminated source-ref union rather than parsing IDs by string prefixes:

```ts
type RetrievalSourceRef =
  | { kind: 'memory'; memory_id: string }
  | { kind: 'message'; message_id: string; chat_id: string }
  | { kind: 'interaction'; root_event_id: string; head_event_id: string }
  | { kind: 'entity'; entity_id: string }
  | { kind: 'task'; task_id: string }
  | { kind: 'record'; list_id: string; row_id: string }
  | { kind: 'document'; media_id: string; extraction_version: string; section: number }
  | { kind: 'generated_document'; document_id: string; revision_id: string; section: number };
```

Fit current ID names/types rather than forcing these illustrative names onto incompatible contracts. `coverage` records keyword/semantic status (`used`, `skipped`, `unavailable`), safe reason codes, result bound, omitted/ineligible candidates, indexing incompleteness and document extraction limitations. Never invent an exhaustive semantic total. Do not expose raw similarity as a user-facing probability or certainty.

Pass the narrow server-only retrieval dependencies (DB, optional index binding/storage, credential resolver, profile/deadline/cache) from `Env` into the existing handler options and `ExecuteAgentToolParams`; HTTP search builds the same dependency object at its scoped route. Do not import `Env` into the pure agent/contracts packages, expose these dependencies as model arguments, or create a second independent retriever inside each tool. The default missing-binding/off path uses the same keyword/source owner, not a copy of the old repository SQL. Existing tests/callers can omit remote dependencies and still exercise authoritative local keyword retrieval.

Public history/unified response changes must be versioned or coordinated across validators, routes, tools and web clients in one slice. Preserve old fields only with their correct meaning: history `total` remains a keyword count with `total_kind='keyword'`; add `returned_count` and `coverage.retrieval_mode`. Unified search replaces misleading `total_matches` with `returned_count` and per-category coverage; if temporarily preserving `total_matches` for compatibility, explicitly mark it `count_kind='returned'` and stop displaying it as an exhaustive total. Avoid a second v2 API that nobody uses.

## 6. Embedding and Vectorize contract

Pin one profile: `gemini-embedding-2`, 768 dimensions, cosine, text retrieval, chunker/formatter version 1. Its ID changes when any semantic input formatting, model, dimensions or chunking changes. Do not put embeddings into the generation model registry as a chat model. No silent fallback to another embedding model against the same index. Embedding 2's reduced output is normalized automatically; validate length, finite numbers and a nonzero plausible norm. Do not add an unnecessary normalization pass or arbitrary quality threshold derived from the three-call probe.

Use direct REST `embedContent`, server-side `x-goog-api-key`, explicit `outputDimensionality: 768`, one independent chunk per request. Query formatting is `task: search result | query: {query}`; source formatting is `title: {title or none} | text: {passage}`. Multiple parts are not a per-chunk batch. An SDK is unnecessary for these requests; do not add one solely for embeddings. Treat response/body failures and truncation as failures, not an empty vector. Bound request and response body processing; redact provider error bodies. Abort both fetch and body reads through the existing deadline conventions.

Create one V2 index per deployed profile/environment. Use a Worker binding, not an account API token on the hot path. Define namespace as a stable digest of the trusted workspace ID, never a display name or model argument. Vector ID is a 64-character SHA-256 hex digest of an unambiguous encoding of workspace, source kind/ID, profile, source generation/version and chunk ordinal/hash. Do not concatenate UUIDs into an ID exceeding the 64-byte limit. Persist the mapping; namespace alone does not make IDs globally unique.

Metadata contains short IDs/kinds and required routing/filter fields only, no full passages, keys, original filenames containing unnecessary PII or public R2 URLs. Create indexes before writes for the fields actually used: `kind`, `audience`, `entity_key`, `chat_key`, `author_key`, `recorded_day`, `list_key`, `document_key` (eight maximum). Use compact digests for long filter identities. `audience` is `shared` or the digest of the existing member subject; querying own preferences plus shared content can use `$in`. Recheck permissions in D1 regardless. A source linked to multiple clients cannot be accurately represented as one scalar entity field: such sources use authoritative family filtering after hydration, with bounded refill and a partial-coverage flag. Never discard them by an invalid metadata shortcut. Re-resolve merged families instead of relying on stale canonical metadata.

Normal queries request IDs/scores and necessary indexed metadata, not full vector values/full metadata. Treat ANN scores as approximate; bit equality with locally calculated cosine is not an acceptance criterion. `describe()`/Wrangler info must confirm actual index dimensions/metric during setup. Upsert/delete acknowledgment is not query visibility. No message-level visibility polling.

## 7. Source coverage and deterministic chunking

| Source | Eligible material and version | Refresh / exclusion rules |
|---|---|---|
| Memory | Active unsuppressed entry, content + category, native revision/source provenance | Forget/supersede/rebuild/status/content changes; existing subject restriction |
| Current interaction | Stable root and current active head, original reporter/time plus current corrected payload | Correction/removal/Undo; exclude removed/reverted heads and deleted owners; do not index every historical event as a current fact |
| Entity card | Name/aliases, clear current fields including special fields, active contacts, source refs; disputed values clearly identified as disputed | Rename/contact/field changes/deletion; do not include all historical notes in one growing card |
| Task | Title/body, entity link and current status/due wording where present | Update/cancel/Undo; overdue decisions still use code, not embedded wording |
| Custom record | Committed active row, meaningful field labels and values, list name, native source refs | Row/value/list archive, field deletion/rename and Save; exclude hidden archived data from current recall unless an explicit history reader requests it |
| Conversation | Retained member text and original source identity; corrected voice transcript overlay where available | Chat text/transcript correction, source suppression/retention/deletion; attachment-only messages contribute textual annotations/links, not invented descriptions |
| Uploaded document | Accessible ready extracted text/Markdown sections, checksum + extractor attempt/version | Retry/current extraction replacement, expiration/deletion, attachment ownership change; failed/scanned extraction cannot claim visual recall |
| Generated document | Finalized current Markdown revision with generated label/source refs | Publication/revision replacement; never draft buffers or every PDF render retry; avoid indexing its rendered PDF again as duplicate text |

Default historical recall indexes member business text, not every assistant preview, tool protocol or system message. Explicit history `source_kind='otis'` can still keyword-search original assistant answers; finalized generated documents are separately searchable. This saves quota and limits advice feeding back as member facts. Meaningful retained member text is not filtered by an LLM or arbitrary “business intent” classifier. Omit only empty/non-content transport messages and configuration commands already excluded from conversation storage; record eligibility counts honestly.

Chunk short memories/interactions/tasks as one coherent passage. For longer documents use heading/paragraph boundaries, initially target 1,200–2,000 characters with a hard 4,000 UTF-8-byte ceiling per embedding passage, including title/prefix budget; split oversized paragraphs without losing Unicode characters. Preserve structured Markdown rows and their headers where they fit; split wide/long tables into independently interpretable row groups, repeating the header. Split larger entity/custom cards by labeled field groups with the identity header repeated. Large cell text becomes searchable passages, not a 100-column concatenation cut halfway through a fact. No model-based summarization/chunking.

Preserve exact source section and offsets; optional boundary overlap is at most one sentence/200 bytes and must be deduplicated. The concatenated non-overlap ranges must cover the eligible text. Missing extraction sections or corpus-budget exclusions are explicit coverage, not silent truncation. Derive a stable content hash from actual formatted passage plus profile; store only changed chunks. Changes to heading/identity text require reembedding affected input. A display-only grid width/reorder need not alter embeddings. Renaming a field changes its semantic label; use a bounded list refresh job, not thousands of synchronous writes on the user's Save.

Keep source text in its original language. No translation round before embedding, no English-only tokenizer, and no rule interpreting “no budget concern” as “budget concern” merely because the vector matched. Retrieval brings wording to the answer model; code still enforces financial/due/status semantics. Attachments' text does not replace their original image/PDF/audio.

## 8. Durable indexing without another ledger

### 8.1 Storage shape

Add a forward migration at the next **available** number; `0030`/`0031` are concurrent uncommitted work and their final identities must be inspected. Do not edit an applied migration or copy their full events-table rebuild for this feature. Use two small ordinary D1 tables plus a narrow FTS projection only for source kinds without an existing text index:

- `retrieval_sources`: one row per `(workspace, kind, source_id)`; desired generation, current prepared source token/hash, profile, state, next-attempt time, attempt ID/expiry/count, chunk progress, completed generation/hash, safe error code, timestamps. This row is also the coalesced durable indexing job. No separate per-field/per-token jobs or receipts. Track source deletion with a tombstone instead of losing cleanup inventory. A changed desired generation must not clear an active claim or permit a second processor to race the same row.
- `retrieval_chunks`: globally unique vector ID, workspace/source/profile/generation, ordinal, source version/content hash, exact section/offset, prepared short passage when necessary, publication state (`pending`, `submitted`, `retiring`), mutation ID if returned, timestamps. Unique source/profile/generation/chunk identity makes retries idempotent. Store no numeric vectors in D1, agent checkpoints or ordinary logs. These rows inventory even partially uploaded/retiring vectors.
- `retrieval_extra_fts`: workspace scope token and derived passage text for documents, cards/custom rows/tasks/interactions not already covered sufficiently by existing FTS. Reuse existing memory/chat FTS for those sources; do not duplicate every chat/memory in a second FTS. Introduce extra FTS only with an actual consumer in the same slice. Scope before ranking; join current source/version/status on reads. Do not globally rank inaccessible entries then filter a small LIMIT afterward.

Backfill/profile counters and cursors can live in the existing appropriate maintenance state owner, or one small retrieval-control table if no compatible owner exists. Do not smuggle JSON into unrelated business/member settings. If a control table is necessary, keep only actual corpus/backfill/profile/due cursors and a coalesced workspace wake; no job framework. Document its fields and cleanup. Index due jobs, source identity, generation/state and retiring chunks by the predicates actually used; prove SEARCH plans and row cost.

Minimum state transitions: a source is `dirty → running → submitted`, `running → dirty` for resumable/retry work, `running → suspended` for terminal/config failures, or `* → tombstoned` for removal. Keep desired generation independent of the claim's generation. A new change while running increments desired generation without clearing the old attempt; the old attempt must release only its own claim and schedule the latest generation, never mark it complete. Claim expiry permits bounded recovery. A submitted source becoming dirty keeps its prior manifest for cleanup but its obsolete content cannot pass hydration. Tombstones cannot be revived by late completion. If Undo/rebuild legitimately restores the source, use a new desired generation after current eligibility is verified. Add CHECKs and exact conditional transitions rather than silently representing impossible combinations as arbitrary JSON.

Keyword preparation must not wait for vector admission or Gemini quota. Extra-kind prepared passages/FTS can exist with `semantic_state='excluded_budget'`/`pending` and no remote vector submission; count remote reservations/submitted/retiring entries separately from keyword-only passage rows. A large document can therefore remain keyword-searchable without fitting the semantic budget. Track prepared-text coverage separately from semantic submitted coverage; never use a single “ready” bit for both.

### 8.2 Commit hooks

At the ledger executor's existing changed-projection diff, collect a Set of affected source keys. Append dirty-source SQL to the **same guarded `db.batch`** as business state/events/receipts. One affected entity card is marked once for a multi-field Save, not once per field. Mark memory/interaction/task/custom-row changes from their actual diffs. An update that leaves searchable content unchanged may mark the source dirty once, but the processor's input hash must avoid another embed/upsert. Failed/replayed/no-effect ledger actions must not create new generations. No Gemini/Vectorize call inside a ledger transaction.

Keep the ledger layer transport-independent: a small prepared-SQL intent helper is permitted; it must not import Worker env, credentials, queues or Gemini. A guarded statement failure must abort business and indexing intent together; do not treat a zero-row completion as rollback. Existing execution attempts and receipts remain untouched.

At conversation commit, append one source intent with the actual canonical chat-message ID in the same transaction that writes the original message. Both web and Telegram paths go through this owner. Do not index accepted raw transport payload plus canonical message as two copies. Transcript correction and original source suppression invalidate the corresponding message source. At extraction completion, append intent only with the accepted current checksum/attempt; at finalized Markdown publication, append with the current revision. PDF rendering alone does not change its text embedding. At uploaded-file association, privacy/retention or deletion transitions, invalidate the relevant source promptly.

Inspect direct projection restoration in `agent/memory.ts` and all replay/rebuild/Undo/merge paths. They must dirty the same sources in their transactional boundary, or invoke a bounded generation/rebuild marker whose readers reject outdated derived material until refresh. Do not schedule indexing only from agent tools; manual Save and recovery writes must also be covered. Suppression checks during hydration are mandatory even before asynchronous indexing notices a tombstone.

After commit, send one workspace `retrieval_index` hint through `DISPATCH_QUEUE`, coalesced through the durable work cursor where possible. A failed/missing Queue send leaves the intent due; existing five-minute maintenance recovers it. No standalone queue, Workflow or heartbeat. Explicitly branch `kind` in `index.ts` so an indexing hint cannot enter business dispatch by fallthrough. Indexing must not occupy the conversational workspace actor's execution slot while waiting on embeddings. Share backpressure with existing document/voice work; never append unbounded work to the one-minute reminder tick.

### 8.3 Processing, retries and stale work

1. Claim a due source conditionally with one attempt ID and expiry; snapshot desired generation/profile. Read current source in bounded batches with current workspace/owner/media checks. Stale queue bodies supply hints only, never content or authority.
2. Determine native source token and formatted content hash. If unchanged and complete for this profile, finish without remote calls. If source is ineligible/deleted, retire its manifest and complete cleanup work; no new embedding.
3. Prepare a bounded set of chunks and persist the attempted version's vector IDs **before** calling Vectorize. This is necessary to clean a crash after a remote write. Advance a resumable chunk cursor for large sources; do not hold the whole job in RAM and mark it done after only its first sections.
4. Embed at concurrency two, initially at most eight passages per Queue invocation, with a shared deadline and sufficient remaining D1/subrequest budget. Batch upsert the ready vectors once. Handle a partial embedding set explicitly: submit only successes, retain failures/pending cursor; never misalign vector and source ordinals.
5. Recheck current desired generation/source token/attempt after each external boundary. Record submitted progress only when the matching attempt is still valid. An upsert acknowledged before a crash may be retried with the same versioned IDs. If the work became obsolete, its inventory becomes retiring. Remote work cannot be rolled back; source validation ensures it cannot become authoritative.
6. Mark generation submitted/completed only after all planned chunks have remote acknowledgments; this means submitted, not proven visible. Keyword coverage is available while embeddings catch up. Backfill/recovery does not block an ordinary send.
7. Delete retired vectors in bounded batches. Keep their cleanup inventory until delete acknowledgment and a later reconciliation window; account for asynchronous deletion and late stale uploads. Deletion/erasure can be reissued idempotently. Do not delete an in-flight version's only manifest: a late external completion might recreate its vectors. Wait for claims and bounded external deadlines to expire before final cleanup, then reconcile. No distributed-consensus layer.
8. For 429/temporary network errors, obey bounded Retry-After/backoff using `next_attempt_at`; do not sleep through a Queue handler or retry Gemini several times inside the user's turn. Permanent configuration/auth failures suspend that profile/workspace with a safe code until credentials/config change; do not spin cron every five minutes forever. Stop after a bounded attempt count and expose retry state through existing diagnostics.

Workspace erasure must preserve content-free external cleanup inventory **before** deleting source/manifest rows. Do not cascade-delete the only vector IDs and then declare removal complete. Reuse the existing erasure/cleanup owner; keep IDs/profile/namespace/attempt deadlines only, no passages/keys. Deny all hydration immediately once membership/workspace is gone. Late indexing must recheck workspace existence; retained cleanup must remove anything a previously authorized in-flight remote operation can still submit. This is part of feature acceptance, not a post-release privacy TODO.

Keep native source version, dirty generation and formatted embedding hash distinct. A dirty generation can advance while the actual embedding input stays identical. In that case adopt the existing vector/chunk under a freshly validated current source token and provenance instead of discarding it solely because the dirty counter changed. Hydration validates this current manifest association; it must not require the original vector ID's generation to equal a later no-op scheduling generation. If routing/filter metadata changed, submit the corrected metadata explicitly (full upsert with values retrieved only for this exceptional background maintenance, or a rebuilt vector); don't pretend an unchanged text hash repairs stale filters. Content changes never adopt an old passage. This prevents no-op updates either paying for unnecessary embeddings or making otherwise valid vectors permanently ineligible.

## 9. Retrieval algorithm and freshness

### 9.1 Candidate retrieval

Validate trusted membership before remote retrieval. Start independent keyword/exact SQL work and the query embedding together; execute vector lookup once that vector is ready. Use one embedding for the whole query and one shared semantic request for a purpose, rather than one per category. Scope workspace/audience/source kind/date/chat/document in the index where correctly representable; repeat exact filters during source hydration. Entity families and multi-linked messages need authoritative checks, not a bogus single-entity shortcut.

Exact IDs/names/aliases/normalized phone/email candidates outrank similarity. Use bounded prepared equality/prefix probes and existing `normalizeName`/`contactComparison` conventions. Add only the normalized lookup columns/indexes or a small names FTS projection demonstrated necessary by query plans. Maintain them from the actual rename/contact/alias owner; do not strip meaningful accents inconsistently with existing matching. Do not use arbitrary full-turn `%LIKE%` or loading all names. For initial mentions, bounded token/phrase probes plus relevant record candidates are acceptable; if a name is not confidently resolved, preserve the query and ambiguity for `find_entities` rather than asserting a match. No recent-50 fallback that hides unavailable older clients.

Initial candidate bounds: keyword 30 and semantic `topK=40`, maximum 70 unique chunk candidates. Parameterize these in one profile, not in each consumer. Hydrate grouped by source kind, batch source/parent/member/suppression reads and canonical mapping, and respect D1's 100-parameter ceiling after adding scope binds. Avoid one SQL/R2 call per hit. If post-hydration stale/access/filter exclusions exhaust useful matches, allow at most one larger/refined vector request using the **same vector**, under the same deadline and maximum 100 distinct candidates. State partial coverage on exhaustion. Do not repeatedly double topK in a loop.

Recent sources whose desired generation is not yet submitted/current get a bounded SQL/FTS overlay: limit to the relevant scoped/date/entity candidates and last small set of newly changed sources. Build tiny missing keyword passages on demand only for a bounded relevant set; never read every dirty source on every turn. For newly uploaded/finalized documents explicitly referenced by the turn, directly read their relevant/current sections through the existing owner; index lag must not make “this file” inaccessible. A read immediately after a write still obtains current data even when the relevant vector is old.

Keyword memory/history remain useful during missing index/provider outage/capacity exclusions. Extra document/card FTS becomes ready independently of embedding quota. Retrieval failures distinguish: authorization/invalid filters fail, semantic timeout/429 degrades, keyword database failure reports partial/unavailable. Do not turn all errors into success with empty arrays.

### 9.2 Hydration as authority

Before returning passage text, validate current membership, workspace, native source version/state, owning record existence, canonical family and filter match; memory status/suppression; chat source suppression; media ready/retained/expiry/deletion-claim; extraction version; generated revision publication/currentness. This must happen for keyword hits, semantic hits, cached candidates and direct source opening used by the new flow. Review `readWorkspaceMessageSource`: its current access check alone is not a suppression filter. Opening a source after it was forgotten must not bypass the retrieval rule; give an unavailable/suppressed result with no hidden text.

Specify currentness per adapter rather than using workspace business revision for everything: memory entry revision/content/status; interaction root/head/state; message content plus current transcript/suppression token; entity/custom card's affected field/contact/label tokens plus transactional dirty generation; document checksum/extractor attempt; generated document current revision/checksum. A millisecond `updated_at` alone is insufficient where two edits can share it. The same source-token builder is used at preparation and hydration; unchanged unrelated workspace writes must not invalidate every indexed source. For a current fact's quoted historical origin, retain both the current fact reference and original evidence reference; validation of one does not automatically prove the other accessible/current.

The prepared passage in a chunk row is safe to reuse only after its exact source token/checksum/head and generation are validated against canonical state. It is a derived cache, never the authority; no full R2 document download per hit. Group document checks by document/extraction; original source opening still uses the existing private reader and reports missing bytes. When a correction or merge makes a hit stale, reject the old text and use a bounded current-source candidate if relevant. Never mix new labels with old fields and call the result current.

Do not read all events for a client just to validate one interaction; current root/head projection plus the relevant head/source rows is sufficient. Preserve original identity as `origin` and resolve canonical presentation separately. Pass provenance/source refs through every tool response and context evidence block so downstream answer/doc generation does not have to rediscover it.

### 9.3 Ranking and evidence budget

Use deterministic reciprocal-rank fusion, initially `1/(60 + rank)` for each keyword/semantic list, plus an explicit exact-identity tier. A small implementation is enough; no learned reranker, second model or “RAG framework.” Recency is a tie-break or a small purpose-specific preference, never a global replacement for relevance. Source precedence is explicit: current facts for current-state questions; original member wording for historical promises; generated advice labeled separately. A semantically matching negation or disputed report must remain visibly negated/disputed.

Deduplicate overlapping chunks, original message vs extracted note from that message, duplicate document output vs its Markdown and merged client families. Keep source relationships rather than deleting independent corroborating reports. Default maximum two passages per source document/message and enough diversity for multi-client questions; an explicitly selected document can exceed that within its separate reading budget. Do not use MMR/vector pairwise downloads by default. Do not adopt one hard cosine cutoff across all languages/kinds; calibrate any abstention behavior against the acceptance corpus and disclose unknowns.

Initial historical context budget remains 6,000 characters total, including source labels/quotes; maximum 12 evidence entries. Own standing preferences/recent transcript are separately budgeted as they are today. Whole short facts fit without chopping values; large passages can be excerpted with exact offsets and explicit truncation. Tools can return up to 12,000 evidence characters when a requested detailed synthesis needs more, with returned/source coverage. Full requested reports/documents still use paged source readers; a larger PDF must not just expand one global initial-context window.

## 10. Latency, caching and quota policy

### 10.1 Interactive path

Exact/structured requests with already-bound IDs, slash commands, explicit question answers and settings/Stop need no speculative workspace semantic call. Use deterministic routing hints from the actual entry point/accepted context, not an LLM router or an English list of “recall words.” For ordinary free-text turns that may need business memory, attempt shared semantic recall within a bounded deadline alongside base SQL. Short follow-ups resolve their referent from the accepted recent conversation/draft target; do not embed “what about him?” alone or the entire run/tool protocol. Build a bounded query from the current request plus up to two relevant preceding member turns/resolved client labels, preserving supplied dates/names; at most 2,000 characters. For long source material, retrieve from the user's request and attachment titles/current target, not all 16,000 characters or a pasted file's contents. Direct material supplied by the user stays available separately.

Starting total retrieval deadlines, subject to measured tuning: 1,200 ms for initial recall, 2,500 ms for an explicit search tool, 1,200 ms for semantic expansion in interactive workspace search. These cover embedding, Vectorize and hydration, not each leg separately. Background embedding has its own longer bounded job deadline. The local ~0.8-second probe is not a target SLA; if useful hits rarely arrive before the initial deadline, change placement/budget based on end-to-end measurements rather than shipping a feature that always times out. Do not issue late second provider requests solely because a semantic result arrived after the first one started.

Cancellation propagates from request/Stop/attempt expiry. Vectorize's binding may not accept an AbortSignal: a bounded race can stop using its result, but does not cancel or refund the remote operation. Ensure late results cannot publish to a left chat, mutate progress or resurrect suppressed content. Abort background pending requests at its job deadline. Do not misreport deliberate cancellation as a network outage.

Use a bounded in-memory query-vector/in-flight cache keyed by workspace, actor/credential scope, profile, query formatting and normalized query hash; initially 32 entries, ten-minute TTL, with bytes capped. Reuse a successful vector across tool rounds and queries with different filters; filters affect retrieval results, not the same query vector. Do not strip negation, dates or punctuation to make unrelated queries share a cache key. Cache cancellation must be caller-aware: one canceled consumer cannot abort a shared request still needed by another. Simplest safe first implementation is run-local in-flight reuse and a successful-vector cache; no cross-run shared in-flight controller. Never persist 768-value vectors into every run checkpoint. A cold restart can reembed; cache RAM is optional acceleration, not durable memory.

Do not cache final snippets/answers across source/access changes. Query-vector cache hits still authorize and hydrate every source. Retained tool-step results are durable conversation evidence, but older results replayed after Undo/forget/access loss must not be injected as current truth: revalidate their source manifests at resume; exclude unavailable passages while preserving immutable original step receipts. New lower-trust source material does not become executable instructions.

### 10.2 Context cache repair

In `handler.ts`, replace invalidation by every completed result with explicit base-context dependencies: source/steering text, actual committed business revision/write outcome, preference/settings changes, draft generation and attachment selection. Classify effects from the trusted tool owner/actual result, not merely a model-proposed tool name. Read-only search/source calls leave base context reusable; authoritative mutations and successful settings changes invalidate needed parts. `needs_clarification` with saved unrelated facts is still a write; no-effect/rejected/question-only results are not. A staged Records patch changes the run-local overlay, not shared business memory.

Reuse query vectors even when base context refreshes. On resumed slices, validate source-backed cached evidence again, including transcript suppression, media lifetime and current membership; preserve existing attempt checks. Teammate writes can happen between slices, so do not assume local cache is fresh for the whole run. Prefer the workspace revision reads already made in the execution flow; do not add one polling query every token or every cache access. Settings/conversation/media versions may change independently of business revision and need their own accepted source tokens.

### 10.3 Free service budget

As of the referenced official pricing, Vectorize Free allows five million stored dimensions and thirty million queried dimensions/month. At 768 dimensions, reserve a **global** maximum 5,500 inventoried vectors for normal operation and remaining space for retiring/in-flight/probe vectors; initially aim for at most 4,500 current vectors. Count all workspaces, profiles and test indexes. Stored capacity is not unlimited just because SQL/R2 retains all original text. Warn/suspend semantic expansion before capacity is exhausted; never delete canonical sources to free vectors.

Maintain a bounded inventory count/control reservation in the same claim/preparation transaction so concurrent document jobs cannot each assume the remaining space is theirs. This is one conditional capacity reservation, not distributed locks. Store reservations for in-flight chunks and release on retirement/terminal failure; do not claim deletion frees remote quota immediately. Prioritize active curated facts/cards/current interactions, then retained documents and older chat material by declared policy. Already-submitted meaningful sources remain searchable until explicitly replaced/retired; cap admission/backfill rather than silently evicting random historical evidence. Coverage reports eligible/current/submitted/pending/excluded-by-budget counts and last bounded reconciliation. All excluded originals remain available through keyword/direct source reading.

At 768, the documented billing formula gives roughly 39,062 combined stored/query units within thirty million queried dimensions; this is an estimate under that formula, not observed usage or a guarantee. Use account metrics and tracked query/index operations, including refill/probes/retries, to set actual admission budgets. If corpus cannot fit, evaluate 384 dimensions on the same held-out questions as an explicit new profile/rebuild decision; do not silently truncate existing 768-value vectors or switch models. Do not promise indexing all retained chat and all document pages forever on Free.

Gemini standard text embeddings are listed as free; its asynchronous Batch API is not a Free-tier strategy. Active RPM/TPM/RPD limits are project-specific; successful API calls do not prove the project's billing tier or unlimited capacity. Background indexing yields on throttling to prioritize interactive lookup. A simple shared cooldown/backoff and bounded concurrency using existing scheduling is enough; no Redis/rate-limit service, key rotation to bypass quotas or per-request D1 quota counter. Don't mark a chat-generation Gemini credential invalid solely because this embedding model is restricted.

Ordinary Worker Free CPU is 10 ms/request; D1 permits 50 queries/invocation and 100 bindings/statement. Network waiting is not CPU. Queues' Free daily operations include existing dispatch/voice/document traffic: coalesce indexing wakes and avoid one message per chunk. Measure the actual HTTP/actor/Queue venues separately; hashing/tokenization/JSON parsing and FTS maintenance are CPU/row costs. Keep batches small enough to leave budget for auth/source checks, manifests, other jobs and completion; document actual queries rather than guessing that one `db.batch` means one query.

## 11. Consumer-specific integration details

### Initial agent context and prompt

Split `getTurnContext` into base-context assembly plus retrieval evidence composition without duplicating ownership. Keep its externally required shape where possible; add a typed `retrievedEvidence` block rather than misrepresenting all source kinds as memory entries. Continue supplying own preferences as preferences, not relevance-selected optional facts. Load display names for the actual selected subject IDs with a bounded join/map, replacing the later `rowsAt(5)` dependency. Current summaries remain optional acceleration and are checked for staleness; do not embed summary text or trust its coverage as the canonical evidence.

Render a compact evidence block with source ref, reporter/date, exact passage and current/historical/generated/disputed labels. Treat contents as lower-trust quoted data even inside the system prompt. Prevent duplicate evidence already present in recent transcript or tool results from inflating every round. Do not omit current attachments/selected image sources as a side effect of the text retrieval change. Add prompt guidance that initial snippets often suffice for recall, while writes/current aggregate reports require the appropriate source/tool. No blanket “always search memory before every answer.”

### Memory/entity tools

`search_memory` returns only eligible memory entries and their source refs; semantic expansion cannot secretly return documents under a memory ID. Keep `get_memory` as the exact current entry reader. If a general document/message query is required, existing workspace search/history tools serve it. `find_entities` can surface descriptive semantic candidates (“the gym owner who only speaks Farsi”), but `bestMatch` may only be established by the existing deterministic identity evidence/confirmation path. Do not use cosine as an identity confidence score. Core mutation validators still recheck supplied IDs/source heads.

### History and source opening

Keep chronological mode fully keyword-based with its snapshot/count/bookmark contract. Relevance mode can fuse semantic member-message candidates with keyword results; source-kind filters for Otis/system use keyword coverage unless explicitly indexed. More than ten words should no longer prevent relevance search: accept a bounded 500-character query, use the whole query for embeddings and a bounded sanitized term set for FTS, disclosing keyword term bounds. Chronological keyword mode retains deliberate existing validation until its pagination/count semantics are updated deliberately. Validate unknown mode/source/filter fields consistently in tool and route schemas.

Historical text stays original wording, not the current revised client fact. Return the useful passage and source ref together. `read_source` is for surrounding original context when necessary, not an obligatory second tool call for every already-hydrated snippet. If the current prompt explicitly requires the source reader before claims about promises, update that guidance narrowly so a fully sourced original passage returned by retrieval qualifies as reading evidence; an unsourced model summary does not.

### Unified search UX

Keep one search dialog. First show quick exact/keyword results, then enrich by meaning without erasing the current query's results or duplicating entries. Prefer two bounded requests to the same search owner (`mode=keyword` and optional `mode=hybrid`) with the same query generation and AbortSignal, rather than a new search streaming protocol. Start hybrid only for queries with meaningful descriptive text (not every single character/phone fragment), after the existing debounce; do not wait for a complete first request if it needlessly serializes semantic work. A returned semantic error must preserve successful keyword results and display a quiet “Showing keyword results” coverage state. A real keyword failure gets Retry; it must not display “No results.” A late response for a different workspace/query/closed dialog is ignored even if abort arrived too late.

Batch exact/keyword category reads; load labels only for returned candidates. Search phone/email with normalization and proper source access. Include document passages in the file category and custom rows in a typed record result, with exact row/list/source destination. Chat results must open the matched message, not merely the conversation top; file results open the exact file/section where supported and disclose if section navigation is unavailable. Preserve existing callbacks while extending a typed result target and `ConversationScreen` navigation. Keyboard/mouse/mobile selection, loading/error/empty/partial states use current production components/tokens. No new global toolbar controls or database jargon.

### Documents, PDFs, Records and Telegram

`read_document` retains complete ordered section reading and can optionally select a section reference discovered by the shared retriever; selection is bound to checksum/revision, not an unvalidated R2 key. Share source-ref types with finalized generated documents. PDF preparation first retrieves relevant original interactions/documents plus current client facts, then authors the requested depth; headings and sections remain authoring concerns. Generated advice is not inserted into active business memory automatically. If R18 publication/revision guards drift or are incomplete, defer only this adapter and name it pending; do not disable memory/history integration or improvise another document store.

Records' saved unique fields (“only speaks Farsi”) and custom rows feed entity/custom cards after Save. Tidy operates on the accepted local draft overlay and uses current retrieved facts without uploading drafts. Grid filter/order/save/calculation logic remains exact. Telegram uses the same handler/tools, with the same evidence/coverage semantics; no separate bot embedding pipeline or long unrequested source dump in every bot reply.

## 12. Ordered implementation slices

Each slice is a coherent delivery. Do not call a helper-only change “deep integration complete.” Run the slice gate and inspect code/data flow before updating status. Preserve unrelated dirty-tree changes; broad commands must not stage/reset them. Reconcile live files first with `git diff --stat cc1076c..HEAD -- apps/worker/src packages/contracts packages/agent packages/ledger migrations` **and** `git diff --stat -- <same paths>`: HEAD-only drift misses concurrent uncommitted work. Routine naming/decomposition is the executor's choice; changed authority/retention/paid resources are material decisions, not opportunities to invent new architecture.

| Slice | Deliverable | Depends on | Initial status |
|---|---|---|---|
| E1 | Profile, source contracts, Gemini client, credential boundary and isolated real compatibility probe | None; current migration/source inventory | Planned |
| E2 | Transactional source intents, durable chunk inventory, background indexing/recovery, scoped hydration and keyword fallback | E1 | Planned |
| E3 | Shared hybrid retriever, ranking, exact entity lookup and existing memory/history tools | E2 | Planned |
| E4 | Initial-context integration, read-only cache repair, resume/Stop/provenance handling | E3 | Planned |
| E5 | Unified search, documents/generated files, saved flexible records and web/Telegram source journeys | E3; relevant R16/R18 source contract available | Planned |
| E6 | Backfill/admission, lifecycle/erasure reconciliation, measured rollout and removal of obsolete retrieval code | E4/E5; core cleanup correctness must already exist in E2 | Planned |

### E1 — Establish the real contract

Scope: new retrieval profile/client/types; `providers/service.ts`; contracts exports; `index.ts` Env/options; `wrangler.jsonc`; local test config and migration inventory; opt-in smoke script/config. Keep the answer-model adapter unchanged.

1. Read current source/config and capture prior API/Cloudflare evidence; inventory eligible source counts and estimated passages using read-only SQL or local fixtures. No customer text in diagnostics.
2. Implement direct REST adapter with formatting, response validation, fetch/body deadlines, safe errors and injectable transport for local checks. Extend provider credential resolution by provider identity, not a fake `ModelEntry` for an embedding chat model. Interactive lookup checks acting membership; background indexing checks current workspace plus existing source/owner rules. Prefer encrypted Gemini BYOK; use platform secret only when policy permits absent BYOK, not an unannounced model/provider switch. A BYOK-specific auth/model failure degrades retrieval instead of quietly billing another credential; preserve generation behavior unless a separate repair is needed.
3. Define deployment capability (`binding/profile/key available`) and rollout modes `off`, `tools`, `core`; default off until acceptance. This is one server config, not per-tool flags. Missing binding must be safe and not crash provider answers. Do not call `describe()`/models.list on each user message.
4. When actual resource setup is authorized, create the isolated synthetic index and metadata indexes, bind it to a preview Worker, verify 768/cosine and round-trip real vectors/scoped sources. Record operation counts. Never put keys into probe output/CLI args/query strings. Remove only the explicitly created synthetic resources when authorized and preserve production data.

Gate: pure adapter checks for wrong dimensions/nonfinite/zero, prefix contract, individual chunk mapping, 429/auth/body timeout/cancellation; one opt-in real Worker probe with namespaces/metadata/direct source hydration, bounded visibility wait and approximate score tolerance. A mocked Vectorize API does not satisfy the joint compatibility gate. Update status “client present / live probe pending” if resources are not available; do not fake completion.

Run `pnpm typecheck`, `pnpm lint` and `pnpm exec vitest run --project worker apps/worker/test/embeddings.test.ts` after adding that adapter test; all exit 0. Record the separate opt-in probe result, or explicitly pending. Never launch live network tests from the normal suite.

### E2 — Make the index recoverable and source-safe

Scope: next forward migration; commit scheduling helper at `packages/ledger/src/repository/executor.ts`; original chat/inbox commit; transcript/media/document publication owners; `agent/memory.ts` restoration; `retrieval/sources.ts`/`indexing.ts`; Queue/cron kind; identity erasure inventory/cleanup. Read current R16/R18 work before touching their owners.

1. Add source/job/chunk inventory/due indexes and optional extra FTS/control storage, with strict state checks and source/profile uniqueness. Build source adapters from current projections and original source readers; keep full table scans out of ordinary hydration.
2. Append coalesced intents to the actual existing atomic write batches. Explicitly cover mixed saved+parked tools, manual Records Save, correction/removal, Undo, merge, memory suppression and restored projections; document native version/token per source type. Rollback must leave no indexing intent.
3. Implement bounded claim/prepare/embed/upsert/conditional-submit/retire/retry with immutable version IDs and retained stale manifests. Use the existing Queue; recover due work in the maintenance owner without busy polling or long sleeps.
4. Implement batched authority hydration and recent-source keyword fallback before any consumer sees vectors. Add erasure cleanup inventory before cascading sources. Resume stale jobs by source IDs only, not queued content.

Gate: actual local Workers/D1/R2 checks for atomic rollback, repeated receipt, correction old-job race, partial upload crash, coalesced multi-field Save, suppression, deleted/expired media, removed member, source restoration and content-free erasure cleanup. Verify indexed query plans and statement/rows-written counts; 5 versus 60 unrelated entities/notes must not scale target-only hydration/intent cost. Fake embeddings prove lifecycle orchestration only; E1 remains the live venue gate.

Run `pnpm exec vitest run --project worker apps/worker/test/retrieval.integration.test.ts`, `pnpm typecheck` and `pnpm lint`; all exit 0. Inspect actual rows after forced rollback/restart instead of trusting mocked completion assertions.

### E3 — Replace fragmented retrieval owners

Scope: `retrieval/retrieve.ts`/keyword/ranking; `agent/repository.ts` and tool validators; `conversationSearch.ts`; history/memory/source contracts and source routes. Keep mutations and chronological history semantics intact.

1. Implement bounded parallel keyword/semantic candidates, grouped hydration, one refill maximum, deterministic fusion/diversity/dedup and typed coverage. Use exact current filters and the same source owner for every branch.
2. Replace memory search's old FTS/LIKE ranking with shared memory retrieval; maintain exact `get_memory`. Replace recent-50 `find_entities` padding with exact/keyword/semantic candidates and honest ambiguity. Normalize phones/emails with existing contract helpers.
3. Add semantic relevance history without changing chronological keyword counts/bookmarks. Remove ten-word relevance rejection consistently; keep bounded safe FTS. Fix source opening so suppression/ineligibility cannot be bypassed by a retrieved ID.
4. Remove superseded private sanitizers/fallback functions only when no remaining consumer needs them. Keep safe keyword acceleration and its index; embeddings do not justify deleting it.

Gate: scoped tools return useful passages with original sources, all existing filters work, exact names/contact/numbers outrank semantic neighbors, long Unicode queries don't hit oversized LIKE, chronological pages retain their prior behavior, and outages return honest keyword coverage. Use real D1 for filters/FTS/canonical family, small pure checks for rank/dedup; no dozens of snapshots mirroring implementation.

Run the pure and worker retrieval checks plus `pnpm exec vitest run --project worker apps/worker/test/agent-tools.integration.test.ts apps/worker/test/business-capabilities.integration.test.ts`; all exit 0. Update schemas, serializers and callers together and run `pnpm typecheck`/`pnpm lint`.

### E4 — Put retrieval before the model and avoid repeated work

Scope: `agent/context.ts`, `handler.ts`, repository injection, run-local cache and `packages/agent/src/prompt.ts` source/evidence rendering. Extend existing checkpoints only with compact source manifests/timing if needed, never full vector blobs.

1. Start base SQL and bounded historical retrieval together. Retain preferences/transcript/image/document selections; remove all-name/first-200 matching and its display-label dependency. Render retrieved source types as typed evidence.
2. Reuse query vectors across tool rounds and refresh base context only for actual writes/settings/steering/draft/attachment changes. Revalidate source-bearing replay results on resume and handle partial-save clarifications correctly.
3. Keep direct structured actions fast; implement bounded referent-aware query construction without a model router. Wire Stop/timeout/stale-attempt discard across embedding and provider boundaries.
4. Record non-sensitive retrieval timings and statuses in the existing run summary/accounting owner; retain final-round usage while touching its actual accounting branch if needed for comparison, without introducing per-hit/per-token database writes.

Gate: read-only search/read_source rounds do not re-fetch all context or reembed the same query; a write refreshes affected context; teammate correction/suppression between slices cannot replay stale evidence as active; Stop/navigation prevents late publication; current and historical images still reach the provider. A controlled actual-model question set must show source recall before calling this slice accepted; fake providers can prove wiring only.

Run `pnpm exec vitest run --project worker apps/worker/test/context-batch.integration.test.ts apps/worker/test/memory.integration.test.ts apps/worker/test/agent-tools.integration.test.ts` with added focused cache/resume cases, then typecheck/lint. Capture actual-model evidence separately; absence of a configured live provider is a named acceptance limitation, not permission to fabricate it.

### E5 — Complete user-facing and document integration

Scope: unified search route/service/contracts, existing search dialog/API/navigation; document readers/publication/extraction; committed record source adapter; relevant prompt/tool declarations; Telegram acceptance through the existing handler. No page redesign or new report engine.

1. Replace sequential category scans/all-name label map with bounded shared retrieval and batched exact SQL. Expose keyword-first then semantic expansion under query-generation cancellation, per-category coverage, true returned counts and source-specific targets.
2. Enable content search for uploaded PDFs/text/Markdown and finalized generated Markdown; open current exact revision/section and retain original file access. Document drafts and noncurrent versions remain excluded from default recall.
3. Index committed custom columns/rows and source links; preserve draft Save semantics. Validate that “Farsi-only client” can be found from a saved special field and current source, while unsaved draft information stays scoped to that run.
4. Use the same retrieved evidence for detailed conversation preparation/PDF authoring and both web/Telegram replies. Do not force semantic search or a PDF generator on ordinary capture.

Gate: native browser search by name/phone/paraphrase/document sentence, rapid query changes/close/workspace switch, semantic failure and retry, exact chat-message/file/custom-row opening and mobile keyboard use. Check five approved widths and scoped a11y/design tests for touched UI. A real rehearsal request produces supported details from client facts plus retrieved notes/files with honest omissions; generated PDF quality/rendering itself remains R18 acceptance, not proven by the retriever.

Run `pnpm exec vitest run --project worker apps/worker/test/search-and-duplicates.integration.test.ts apps/worker/test/business-capabilities-routes.integration.test.ts`, the targeted existing/new search-dialog web checks, `pnpm check:design`, typecheck/lint and `pnpm build`; all exit 0. Native browser checks use available Codex/Antigravity controls, never Playwright. Read `design-tokens.md`/`design.md`, reuse the existing Overlay/Input/Button/shadcn owners, keep local feedback within 100 ms and pending within the affected control after 300 ms; visual acceptance at 360, 390, about 900, 1280 and 1440 px is distinct from synthetic DOM checks.

### E6 — Reconcile, measure and remove the old cost

Scope: existing maintenance/debug/run evidence, backfill/control config, obsolete retrieval paths, existing status/backlog/provider/architecture/contracts docs. No new audit/handoff document per slice.

1. Backfill in bounded keyset pages by source type/workspace; save cursors, pause at admission/quota bounds and resume safely. Enqueue latest current versions only. Do not block startup/migration or rewrite canonical events/FTS history; run no full remote export of business data.
2. Reconcile manifests/retiring IDs and aggregate index inventory with bounded scheduled/operator runs. Check stale vectors, missing sources, cleanup after late jobs and capacity/profile drift. Do not fetch/list the whole Vectorize index on every cron or HTTP request.
3. Compare old baseline with tools mode, then core mode on the held-out corpus. Tune placement/deadlines/chunk sizing only from measured retrieval quality and total time. No duplicated “shadow” embedding calls on all live traffic; use opt-in sampled synthetic/authorized evaluation.
4. Enable core only after scoped source/security/lifecycle gates and acceptable latency/cost. Turning off core must keep keyword/source reads working while cleanup/recovery remains available. Deleting the new schema is not rollback.
5. Delete unused phrase-LIKE/recency selection, recent-50 padding, context all-name/alias scan and misleading totals. Keep necessary keyword indexes and chronological reader. Update current docs as implemented/partial with evidence and limitations; do not label unrun browser/provider/production tests green.

Gate: final cross-app journey and code trace pass, every actual consumer points to shared retrieval where intended, no old scan/recent-50 path remains in hot retrieval, capacity stays within configured/account limits, restoration/backfill/retry work after restart, and measured answer-quality/latency/token reports justify activation. No requirement to rewrite unrelated routes just to remove every LIKE in the repository.

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, design checks when UI changed and documentation checks. Record a bounded live compatibility/quality run and native web/Telegram journey, including quota/storage inventory. These commands passing alone do not prove the measured activation goals.

## 13. Verification commands and evidence requirements

Current repository commands, inspected in `package.json` and `vitest.config.ts`:

| Purpose | Command | Required evidence |
|---|---|---|
| Typecheck | `pnpm typecheck` | Exit 0; report unrelated concurrent errors separately, never silently waive a touched-file error |
| Lint | `pnpm lint` | Exit 0; no catch-all `any`, lint suppression or unsafe source DTO cast to make this compile |
| Pure retrieval checks | `pnpm exec vitest run --project pure packages/contracts/test/retrieval.test.ts` | Add when contracts/chunk/query/rank pure behavior is implemented; use the actual chosen file path |
| D1/R2 lifecycle checks | `pnpm exec vitest run --project worker apps/worker/test/retrieval.integration.test.ts` | Real local bindings; injected remote client only; actual guarded writes/filters/restart/cleanup |
| Agent integration | `pnpm exec vitest run --project worker apps/worker/test/agent-tools.integration.test.ts apps/worker/test/business-capabilities.integration.test.ts` | Existing tool/source semantics remain green; inspect current actual filenames before execution |
| Full suite | `pnpm test` | Required final check; if the harness hangs, record command/time/last output and unresolved gate, don't loop indefinitely or claim a pass |
| Build | `pnpm build` | Exit 0; includes dry-run bundle, no deployment |
| Touched web behavior | `pnpm exec vitest run --project web` | Existing search/production transcript/draft behavior; targeted tests first, broad suite once final changes settle |
| Design | `pnpm check:design` | Exit 0 for UI changes; current branch has no Storybook/check:stories script |
| Docs | `node plans/qa/docs-audit.mjs links` and `git diff --check` | No broken local links/anchors; clean touched-file whitespace; distinguish unrelated dirty diffs |
| Source review | `rg -n 'cachedContext|completedToolResults.length|SELECT id, name FROM entities|ORDER BY updated_at DESC LIMIT 50|sanitizeFtsQuery|total_matches' apps/worker/src apps/web/src packages/contracts/src` | Read each remaining hit; no superseded retrieval path stays reachable; a hit in another legitimate owner is not automatically a failure |
| Live venue | Opt-in `scripts/probe-retrieval.mjs` or equivalent, added in E1, with explicit preview env/index and synthetic IDs | Actual Worker→Gemini→Vectorize→D1/R2 path; safe aggregate output, no secrets/customer passages; bounded wait/cleanup |

Keep normal `pnpm test` offline. `vitest.config.ts` derives local bindings from production config: strip the new remote Vectorize binding like current Workers AI stripping, then inject the narrow test client. Otherwise adding the binding can accidentally require Cloudflare login or make unit tests spend credits. Local fakes prove control flow, not Vectorize scoring/visibility. Use actual local D1 rollback/FTS checks and a small opt-in live probe, not a huge fake-provider suite or a browser that only looks correct.

### High-value behavioral matrix

| Case | Observable pass criterion |
|---|---|
| Romanian/Hungarian/English paraphrases | Expected original source in bounded top results even without shared keywords; dates/authors retained |
| Negation and historical promise | Passage preserves exact negation/member vs Otis attribution; answer never turns a suggestion into a promise |
| Exact phone/email/client | Exact canonical source remains first; no semantic neighbor silently selected for a write |
| Client merged then undone | Current family reads include eligible origin information, no duplicate identity count, unmerge restores filters |
| Correction while old embed pending | Old completion may leave a retiring vector, but its passage never reaches current answer; new head found via fallback |
| Forget/source suppression | Search, initial context, direct source opening and resumed tool replay do not expose/relearn suppressed content |
| Partial upload + restart | Same version IDs reused; remaining sections finish; no false full coverage or missing cleanup inventory |
| Member removed while request waits | No hydrated evidence/commit published after access loss; keys and passages absent from failure logs |
| New file immediately queried | Supplied document/current section accessible despite index lag; failed extraction honest |
| Draft vs saved special field | Unsaved overlay usable only in accepted draft run; saved value discoverable across tools/web/Telegram |
| Long/wide Markdown table | Every eligible row retained across chunks with useful headers/offsets; no fabricated financial cells |
| Wrong profile/binding | Semantic capability disabled with safe reason; keyword answers continue; no vector mixing |
| 429/outage/Stop | Bounded response/fallback; background work reschedules; no hot retry loop or late result publication |
| Rapid search typing/navigation | Only current query/workspace results display; keyword results survive semantic failure; exact source opens |
| Free storage reached | Admission pauses with explicit partial coverage; no lost business source or hidden paid upgrade |
| Workspace erasure with in-flight job | Access revoked immediately; external cleanup inventory survives source deletion and removes late submitted IDs |

### Quality and performance acceptance

Freeze at least 24 representative questions and expected source refs **before** tuning: eight exact/structured, eight paraphrase/multilingual history/memory, four long-document/custom-field synthesis, four no-evidence/negation/obsolete-source cases. Use synthetic business-shaped fixtures and authorized real-source questions separately; never transmit a workspace wholesale just to benchmark. Include sparse and crowded source sets and measure candidate recall@5/@10, unsupported claims, returned evidence bytes, provider rounds, model input tokens, time to first visible text and total completion. Run the same answer model/effort/output request and similar network venue for baseline versus hybrid; alternating order reduces warm-cache/provider variation. Split warm/cold query-vector cache measurements and report failed/timeouts, not only fastest successful runs.

Hard gates: zero workspace/member/suppression leakage in the lifecycle corpus; exact identity/aggregate/date behavior unchanged; no missing eligible source hidden behind complete coverage; ≤one query embedding per distinct query/profile within a slice; no unnecessary base-context reload after read-only calls; bounded SQL/remote work independent of unrelated workspace size. Quality goal: expected-source recall@10 improves on paraphrase/multilingual cases without losing exact matches. Activation goal: structured fast-path p95 overhead ≤100 ms in the same venue, and median total time/provider rounds improve on recall cases. Treat p95 improvement targets as measured release decisions, not guaranteed service SLAs; if core mode adds time without quality/round reduction, keep tools integration active and adjust core placement before accepting E4/E6.

Report CPU, D1 rows read/written and Queue/embedding/vector operations from actual venues; do not infer compliance from 768 dimensions or network timings. Do not write telemetry per token/hit: aggregate a compact safe retrieval summary into existing run completion/checkpoint records. Do not retain query text, keys, vectors or passages in diagnostics.

## 14. Code quality and review checklist

- Direct prepared SQL with bound values; filter constructors use known fields and typed enums. Validate query bounds/UTF-8 byte limits once at the boundary; do not repeat inconsistent validators in route/tool/helper.
- Named source adapters/helpers with explicit return types; exhaustive source/state switches; no generic record maps or arbitrary JSON blobs spreading through authority code. Runtime provider/DB JSON is `unknown` until validated. Keep pure formatting/chunking/ranking separate from network/storage effects.
- Structured safe error codes distinguish invalid request/access loss, source unavailable, deadline/throttle/config mismatch and partial indexing. Do not catch an authorization failure and label it an ordinary semantic miss.
- One source-eligibility/version/filter implementation shared by indexing/hydration/direct opening where applicable. Avoid copying every client's entire dossier into a vector card; keep related evidence individually sourced.
- Use existing guard/claim/revision conventions. Every multi-statement completion depending on a claim must be atomically preconditioned; checking afterward is not rollback. Do not remove stale-attempt checks because SQLite serializes writes.
- Coalesced dirty keys and batch APIs; no per-field embedding, source read, Queue message or quota write. No all-workspace names/aliases/manifests loaded for ordinary queries.
- Explicit bounded cache/budget/deadline constants in one profile; meaningful named values, no tune knobs scattered across seven callers. Failed promises are evicted. Caller cancellation and late outcomes cannot corrupt the cache.
- Profile/vector IDs hash an unambiguous encoded tuple. Namespaces/filters come from trusted identity and proven relationships. No public R2/object-key shortcuts or embedding credentials in client/contracts/prompts.
- Keyword path stays first-class, indexed and covered. Remove obsolete paths only after migrating their consumers; do not retain an indefinitely enabled duplicate retrieval implementation “for safety.” Rollback uses one deployment mode.
- Keep interfaces small and purpose-based; no LangChain/LlamaIndex, ORM, new vector abstraction supporting hypothetical providers, learned reranker, workflow engine or general computer tools. A proper deep integration is completeness of these flows, not the number of packages.

## 15. Release, maintenance and stop conditions

Start `off` with no remote customer indexing. Validate E1/E2, then opt-in tools; admit/backfill within observed budget, then core recall and existing search consumers. All modes preserve canonical input/ledger/source stores. Profile changes rebuild into a separate index/manifest under capacity accounting; atomically select the deployment profile only after candidate acceptance. If Free space cannot hold old+new, use a declared keyword-only maintenance interval to retire/rebuild, not dimension mixing or deleting source history. Old-profile cleanup is bounded and auditable.

Commit/push/deploy and indexing real business data need current task authorization; historical authorization is not a reason to stage unrelated active work. Routine local implementation under the selected task can proceed once requested. Resource creation/config changes must name the actual index/environment and profile, not ask the user to approve an abstract architecture. This planning pass does not execute those actions.

Stop the affected rollout/slice and report the concrete issue if the selected model/binding is unavailable, the only credential lacks the embedding model, a migration number is occupied, there is no safe source token for a consumer, desired filtered sources cannot fit within declared capacity, or a remote operation cannot be inventoried/cleaned safely. Keep independent consumers progressing with keyword retrieval; do not widen permissions/change paid tier/rewrite the ledger to work around the issue. Routine drift is reconciled by inspecting live owners, not by restarting the whole plan or blocking because line numbers moved.

At completion update `docs/status.md`, `plans/README.md`, relevant architecture/provider/contracts sections and operations setup with actual files/migration/profile/binding/source coverage, exact checks, live probe environment, observed latency/row/operation counts and open limitations. Do not claim all historical information is semantically indexed when budget/extraction/capability exclusions remain. No new per-slice audit/status documents. Future source types join eligibility/dirtying/hydration/reference/ranking/cleanup as one contract; source ownership changes and model/profile migrations are the maintenance points to scrutinize.

## 16. Primary references and dated evidence

Checked official sources on 2026-10-10. Recheck service/account limits at setup; these pages establish API constraints, not measured Otis compliance. Architecture and ranking decisions above are this plan's recommendations, not vendor performance claims.

- [Gemini embeddings](https://ai.google.dev/gemini-api/docs/embeddings): current model, retrieval input format, dimensions, normalization and aggregation behavior.
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) and [active rate-limit guidance](https://ai.google.dev/gemini-api/docs/rate-limits): standard versus asynchronous Batch availability; project quotas must be observed.
- [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/) and [pricing](https://developers.cloudflare.com/vectorize/platform/pricing/): dimension/ID/namespace/storage/operation bounds and capacity estimates.
- [Vectorize insert/upsert](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/), [query behavior](https://developers.cloudflare.com/vectorize/best-practices/query-vectors/), [client binding/API](https://developers.cloudflare.com/vectorize/reference/client-api/), [metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/): asynchronous visibility, immutable-revision strategy inputs, scope/filter setup and response cost.
- [Worker limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/): actual venue budgets, prepared query bounds and background wake cost.

Planner evidence: read current source/config and dirty-tree/history at `cc1076c`; recorded prior synthetic Gemini results and read-only Wrangler inventory. No source changes, migration, index creation, business-data embedding, application tests or deployment in this planning pass. Documentation verification is recorded in the backlog after completion.
