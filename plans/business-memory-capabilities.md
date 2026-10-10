# Business memory capabilities — executable implementation plans

**C1 and all selected C2–Q slices are implemented.** Prepared 2026-10-08 against `929b57e`, reconciled with `32fd9e5`, source-rechecked at `ecc2246`, then implemented/repaired under direct user authorization. [Current implementation status](../docs/status.md#c2q-implementation-2026-10-08) owns exact checks and remaining acceptance limits. The plan below preserves intended behavior and implementation details rather than constituting another backlog. Records Save remains a separate unaccepted writer; M0 retains its own scope. Restricted-visibility notes are excluded; C7 covers attribution and existing access boundaries. The user authorized commit/push and real-browser verification on 2026-10-09.

### Selected implementation, 2026-10-09

| Slice | Local implementation | Canonical source |
|---|---|---|
| C2 | Complete sourced client file, independent section pages/coverage, selected-entry Save/conflict/retry and Review/Undo | [Shared reader](../apps/worker/src/entities/file.ts), [HTTP actions](../apps/worker/src/routes/entities.ts), [production pane](../apps/web/src/components/EntityFile.tsx) |
| C7 | Original reporter versus corrector, source/time/author filters and consistent existing member-preference access | [Interaction DTO](../packages/contracts/src/interactions.ts), [source reader](../apps/worker/src/conversationSearch.ts) |
| C3 | Multiple phone/email contacts, primary selection, company/address, explicit merge preview/conflicts, origin-preserving replay and Undo; shared readers follow canonical identities | [Contacts](../packages/ledger/src/commands/contacts.ts), [merge](../packages/ledger/src/commands/mergeEntity.ts), [canonical SQL](../packages/ledger/src/repository/canonical.ts) |
| C4 | Linked/retained originals, PDF upload/background conversion/read/retry, gallery, original audio plus corrected/restored transcript, explicit release grace | [Files](../packages/ledger/src/commands/attachments.ts), [documents](../apps/worker/src/media/documents.ts), [gallery](../apps/web/src/components/FileGallery.tsx) |
| C5 | Workspace FTS search, bounded backfill/coverage, stable pages, filters and original source/context opening | [Search owner](../apps/worker/src/conversationSearch.ts), [production search](../apps/web/src/components/WorkspaceHistorySearch.tsx) |
| C6 | Explicit weekly/after-quote rules, calendar versus elapsed offsets, no-contact condition, own inspector, occurrence dedupe and guarded delivery; general overdue-first work | [Rules](../apps/worker/src/reminders/rules.ts), [delivery](../apps/worker/src/reminders/service.ts), [work reader](../apps/worker/src/entities/work.ts), [inspector](../apps/web/src/components/FollowUps.tsx) |
| Q | Candid capability discussion grounded in registered tools, comprehensive general tables, coverage/source/dispute guidance and accurate minor units | [Prompt](../packages/agent/src/prompt.ts), [tools](../packages/agent/src/tools.ts), [response cases](qa/2026-10-07-agent-response-cases.md) |

Forward migrations 0023–0029 were applied to production on 2026-10-09 before the authorized push. Fresh-schema tests exercise the complete sequence; C1's populated-history upgrade fixture also runs the later migrations. Controlled provider/visual acceptance and real production costs are recorded separately in status; implementation presence is not a native-device or latency-parity claim.


An executor must read its selected workstream and the shared contracts below. Source paths are relative to the repository root. New filenames and SQL shapes are proposed owners unless the source review explicitly records their implementation. Preserve other sessions' changes, inspect the current migration tip, and do not copy a historical migration number. Planning does not authorize commits, pushes, deployment, real contact messages or remote data changes. Do not invoke subagents.

## 1. Source baseline used to plan the work

This table records the source baseline before the selected implementation. The current implementation matrix above and linked status supersede its missing-feature descriptions.

Otis's answer is a product request, not reliable evidence of current implementation. Inspect live source before every slice; do not use a model's description or old docs as a completion oracle.

| Request | Verified current source | Plan and boundary |
|---|---|---|
| Fix/remove one visit, quote or note | Ledger revise/remove, lifecycle projection, migrations 0023/0024 and registered tools are committed at `ecc2246`; basic quote/date/contact repairs pass. These source defects are repaired locally; migrations 0023–0025, live/provider and optional UI acceptance remain open. | Repair and complete the existing C1 path. Do not replace field correction, forget or whole-entity Undo. |
| Everything on a client together | Entity, fields, tasks, events, drafts and memory can be read separately. Current interactions are now discoverable through a shared paged reader; a combined client file remains missing. | C2 composes those authoritative reads into one file with current facts, sources, coverage and paged history. |
| Multiple phones/email/company/address and merge | Core `set_fields` has a small fixed field set. Aliases/rename and generic entities exist; a lossless identity merge does not. R16 already plans flexible fields. | C3 supplies structured contact methods and a reversible merge, sharing R16's cell/record semantics. |
| Linked photos/PDF/audio | Private R2 media, voice transcript/source, four images per input, recent historical images and `view_image` exist. Attachment discovery is chat-scoped. Accepted media can expire under the existing retention cleanup; PDF is not a supported `MediaFormat`. | C4 adds business links, retained originals, PDF reading and a gallery. Keep the existing upload/media/provider owners. |
| Search across chats | `read_chat_history` can read an explicitly identified chat in the workspace. Memory FTS exists. There is no discoverable workspace-wide conversation search. | C5 adds indexed search and source excerpts; do not add a vector service or a second search engine. |
| Recurring/after-quote follow-ups | `reminders/service.ts`, migration 0018 and reminder tools implement one-off reminders. Brief scheduling and overdue-first lead overview exist. | C6 extends those owners with explicit recurrence/conditions and a general overdue work view. |
| Who logged what | Events contain trusted actor/source/time. Current prompt/context exposes member identity. Some event reads omit useful provenance, and direct personal-memory reads need policy consistency. | C7 exposes reporter/corrector/source consistently and repairs existing authorization boundaries. Restricted-visibility notes are outside selected scope. |
| Sent bubble appears after its answer | `deriveTranscript` appends a saved-but-unseen source after every server row and ignores the accepted sequence retained in the outbox. | M0 repairs ordering and acceptance reconciliation in existing owners. No timestamp-based reorder or database renumbering. |

The R09 repair commit `7d67719` is in this baseline. The original eight review cases now give seven passes and one result-classification failure (`rejected/already_resolved` versus the probe's `already_applied`). No question is recreated in that case. Finish its real run-continuation and cost/identity acceptance in [the existing prerequisite plan](ledger-write-efficiency.md); do not implement the six earlier source defects again. M0 can proceed independently.

## 2. Architecture, budget and source conventions

Otis remains conversational business memory with optional direct inspection/editing. It is not a new CRM/dashboard. Extend the existing TypeScript functions, prepared SQL, ledger command/reducer/executor, D1 projections, private R2, named workspace actor, Queue, cron, TanStack cache and production components.

Business edits append versioned events with one trusted source, deterministic projection replay, scoped receipts and existing Undo. Never UPDATE/DELETE historical events to make an edit look clean. Identity, conversations, scheduling delivery and extraction transport remain their existing durable owners; they are not replacement business ledgers. Use `createLedgerEvent`, the existing aborting guard and `CommandResult` pattern rather than a new transaction abstraction. Model/client IDs never authorize workspace, actor, owner, source or attempt.

Independent reads go in one D1 batch when they share a consistent view. Business effects, changed projections, receipts, revision and dependent intent changes commit together. A zero-row conditional UPDATE is not an abort. Every expensive asynchronous result rechecks current source/membership/attempt before publication or a write. These are constraints on all workstreams, not permission to add extra guard tables.

Current platform constraints: ordinary Workers Free CPU is 10 ms; D1 Free allows 50 queries per invocation and 100 bound parameters per statement. D1's included daily allowance is 5 million rows read and 100,000 written. Network waiting is not CPU. Measure actual CPU/rows at the venue instead of inferring compliance from local wall time or `SEARCH`. Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

D1 `batch()` can roll back a failed sequence; preserve the existing failing SQL guard so lost preconditions actually cause rollback. Source: [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/). Ordinary request reads must be indexed by trusted workspace plus the actual entity/interaction/document/schedule being used. Paginate historical data instead of hydrating every workspace store.

Cloudflare Workflows can schedule instances and sleep durably. Recurring reminders here already have D1 ownership and delivery machinery, so the selected architecture extends indexed due discovery and existing delivery. It avoids making a workflow instance the sole reminder record. Reconsider Workflows only for an independently measured long multi-stage job, not as a prerequisite for these features. Sources: [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Workflow triggers](https://developers.cloudflare.com/workflows/build/trigger-workflows/).

UI reuses existing components and approved semantic tokens. Keep `Transcript`, composer, image/audio players and records primitives; do not migrate the chat scroller or install a UI stack to fix ordering. New sheets/dialogs need accessible titles, labeled fields, keyboard/focus behavior and source/empty/error/pending states. Keep the instrumented compact layout, user-language copy and current fonts from `design-tokens.md`. No token edits to excuse drift. At `32fd9e5`, `components/records/RecordsScreen.tsx` uses seed data/local Save and `AskOtisPane.tsx` simulates proposals. Reuse their useful layout only after replacing those paths with authoritative contracts; a banner or local history row cannot assert a ledger commit. Keep demonstrations explicitly isolated/labeled until then. C2's file must not read `INITIAL_RECORD_LISTS`.

## 3. Order and independently reviewable slices

| Workstream | Priority / effort / risk | Dependencies | Reviewable delivery |
|---|---|---|---|
| M0: source/answer ordering | P1 / S–M / medium | Existing R01 reconciliation owners | Deterministic display order under delayed ACK, live answer, reload and retries. |
| C1: interaction correction/removal | P1 / M / high data semantics | R09 writer acceptance | Conversational revise/remove, source/history, Undo and consistent downstream facts. |
| C2: complete client file | P1 / M / medium | C1 effective interaction read; first read-only slice can precede correction writes | Shared file read plus compact web/mobile inspection and useful grounded responses. |
| C7: attribution | P1 / S–M / medium | C1/C2 source model and existing identity/access policy | Trusted reporter/corrector/source in files, history and answers; consistent existing personal-memory access. |
| C3: contacts and merging | P2 / L / high | C1/C2, current authority rules, shared R16 field/lifecycle contract | Multiple contacts first; identity-verified lossless merge second. |
| C4: retained linked media/documents | P2 / M–L / medium | C2 file read and existing authenticated media path | Links/retention first; PDF conversion/read and gallery next. |
| C5: cross-chat search | P1 usefulness / M / medium | Existing history/memory readers and current source access rules | Discover retained workspace conversations with evidence, attribution and bounded pages. |
| C6: recurring/conditional follow-ups | P2 / M–L / high scheduling correctness | C1 effective quote/contact semantics; existing reminders/briefs | Recurrence first, after-quote condition second, overdue view shared with C2. |
| Q: response/capability grounding | P1 / S–M / low | Each actual tool/read becoming available | Correct capability answers, completeness and provenance; controlled live evaluation. |

Recommended execution: M0 plus R09 acceptance; C1; C2; C7 attribution; C3 contacts; C4 links/documents and C5 search; C3 merge; C6; final integrated Q acceptance. Do not wait for every later feature to make C1/C2 useful. Every slice supplies its own regression tests before extending the next owner. No parallel session may claim another's checks as its own.

## 4. M0 — Keep a sent message above the answer to it

### Source and reproducible boundary

Owners: `apps/web/src/api/transcript.ts`, `api/outbox.ts`, `api/snapshot.ts`, `ConversationScreen.tsx`, `components/Transcript.tsx`, current outbox/conversation/scroll-route tests. Server investigation owners if correlation is missing: `apps/worker/src/actor/dispatch.ts`, inbox acceptance and shared `ChatMessage`/activity contracts in `packages/contracts/src/index.ts`.

Current `deriveTranscript` sorts the server rows, then does this for every absent local UUID:

```ts
let sequence = ordered.length > 0 ? ordered[ordered.length - 1]!.sequence + 1 : 1;
for (const entry of outbox) {
  if (byClientId.has(entry.clientId)) continue;
  ordered.push(localMessage(entry, sequence));
  sequence += 1;
}
```

`markOutboxSaved` already stores `entry.sequence` from `accepted.acceptance_sequence`. An acknowledged source at 8 plus an already received answer at 9 therefore renders answer → source when the source's authoritative row is absent. [The three-case probe](qa/2026-10-08-message-order.probe.test.ts) reproduces the defect; two canonical-order/identity controls pass. This is a display bug, not proof of reversed D1 persistence.

### Implementation steps

1. Add the missing-source/answer test to `apps/web/test/outbox.test.ts`. Use a saved entry with sequence 8/run R and a system row with sequence 9/run R. Assert one source above its answer, unchanged accepted sequence and stable client-UUID key. Use `markOutboxSaved`'s returned entry, not a stale pre-update object.
2. Merge authoritative rows and acknowledged unseen outbox rows by canonical sequence, replacing only on server ID/client UUID. Keep delivery metadata and the immutable outbox payload. Never deduplicate by text, timestamps or run alone; a member may intentionally repeat text and an answer can quote it.
3. Keep provisional placement separate from server sequence for unacknowledged entries. At enqueue record a small optional placement anchor: the latest known authoritative sequence and a local submission ordinal. Store it in the existing account-scoped outbox transaction, including new-chat entries; do not add a counter service/store. Concurrent tabs must allocate/update the ordinal in that transaction. Legacy entries use stable existing local order until ACK supplies their true sequence.
4. Insert unacknowledged messages at their captured anchor in local send order instead of chasing the newest server tail on every render. ACK replaces provisional placement with its trusted sequence. Never use a fabricated/fractional sequence as a pagination cursor, server revision or query-cache record. No global timestamp sorting: device and server clocks differ.
5. Trace answer-before-ACK. If current `run_started`/`answer_saved` plus accepted run metadata cannot associate a reply with a local source, add a source client UUID/inbound reference to the existing committed activity payload, derived server-side from the run source. This is an additive correlation field, not a new endpoint/stream or model-provided ID. Keep old payload fallback and scoped validation. An unlinked reply must not silently bind to the newest typed draft.
6. Keep the accepted echo until safe canonical reconciliation. A source patched into a cache and then pruned from outbox must not disappear when an older result lands. Preserve R01 cancel-before-patch/reconciliation fixes, and cover no-cache/staged-primary paths. Ordering repair alone does not prove old-return reconciliation safe.
7. In mounted `ConversationScreen`, verify DOM order and `Transcript`'s run association. A live preview/Working/question belongs with the source run, before its final answer, rather than being moved below a follow-up because it became the last message. Follow-ups remain sendable; do not block Send until Otis finishes to hide the race.

### Acceptance

- ACK before answer; answer before ACK; stale primary after ACK; source row omitted then recovered; duplicate/replayed ACK/SSE; reconnect with missing source; retry after reload; new-chat mapping; two rapid sends; two tabs; stop/failed/question runs; image/voice source; a follow-up while the previous answer streams.
- D1 canonical source sequence remains before its response. If this fails in a real-D1 fixture, fix the server allocation transaction separately; never renumber messages on the client.
- Exactly one bubble per UUID at every checkpoint, matching run identity; no tail jump when the reader is inspecting older history. Reconciliation replaces the stable key rather than remounting source/media controls.
- Run the probe config, existing outbox/durability/offline/conversation/scroll suites and full implementation gates in section 12. Add a production story for delayed ACK/live answer using the same components; inspect at the five required widths with native browser controls. No CSS ordering hacks.

## 5. C1 — Correct or remove one interaction without losing the client

### Current behavior and scope

Owners: `packages/ledger/src/commands/logEvent.ts`, `commands/events.ts`, `commands/undo.ts`, `reducers/{fields,rebuild}.ts`, `repository/{executor,queries}.ts`, `types.ts`; event/result types in `packages/contracts/src/index.ts`; `packages/agent/src/tools.ts`; Worker agent repository/context, brief read, lead overview, action inspection; client-file UI in C2.

At `ecc2246`, `handleLogEvent` creates a fresh root and reduces interactions before fields; registered revise/remove tools append lifecycle events. Rebuild excludes reverts and reduces interactions before head-aware quotes. Generic `query(events)` and Records Notes still expose raw events without an effective-current contract. Contact SQL now excludes superseded/removed events separately. `supersedes_event_id` also supports field/memory semantics; do not globally suppress every superseded field event and break dispute history. The current audit below distinguishes completed repairs from remaining C1 work.

Support precise requests: “That visit was Tuesday, not Monday”, “Correct the offered quote to €500”, “Remove the duplicate note”, “Undo that correction”. Preserve original reports and remove only the identified interaction from current use. This is logical removal with history/Undo, not audited erasure.

### Data contract

- A stable `interaction_id` is the original interaction event ID for legacy rows; revisions retain that root. The current event ID plus row revision is the optimistic edit token. System-generated actor, source, recorded time and original kind are immutable history.
- Revision emits another note/visit/contact/quote event with `supersedes_event_id` pointing to the exact current event and typed payload containing the root ID. Validate the payload exactly as new logging does. Separate `occurred_at` from recorded time; do not rewrite who originally logged the event.
- Removal emits a small `interaction_removed` event targeting root/current event with an optional reason. Add it through a forward migration updating the closed event-kind constraint, preserving self-references and foreign keys using the established migration pattern. Never edit applied 0021/0022.
- Use a minimal `interaction_state` projection: workspace/root/entity/current event/removal state/revision plus indexed current occurrence/sequence metadata needed by timeline reads. Content remains in events; do not copy entire client files into a projection. Backfill legacy roots deterministically. An explicit history read follows the chain with author/source metadata.
- A single pure effective-interaction reducer/read predicate governs current timeline, quote selection, last contact, briefs, overdue/after-quote conditions and agent queries. Append/revise/remove/Undo must not produce different answers in these consumers. Keep replay as the correctness oracle, not a SQL-only hidden lifecycle.

### Ordered implementation

1. Characterize current quote projection, contact calculation, revert and source attribution using existing ledger/brief tests. Add fixtures with two offered quotes, one expected budget, a corrected visit and a duplicate note. Pin the differences between historical/current views before changing reducers.
2. Define strict `revise_interaction` and `remove_interaction` argument/result contracts. Arguments: root/target ID, expected current event/revision, validated replacement payload/date or removal reason. No arbitrary JSON merge patch, event-kind conversion, workspace/actor override or model-supplied approval. Changing a visit into a quote requires explicitly replacing the interaction, preserving both histories.
3. Add command handlers and projection reduction through the existing executor. Hydrate the target chain/head, scoped entity and affected quote/contact dependency only; retain current membership/source/run/attempt guards. Unknown handlers keep their existing fallback. Invalid later SQL or failed preconditions must roll back event, state, receipt and revision.
4. Implement authoritative root/current resolution. A stale selected note cannot revise a newer teammate correction silently. Return the current text/date and a narrow conflict; a newly confirmed edit uses a new action ID/current token. “The second note” resolves against a persisted/file-visible ordered result, not whichever SQL row is second today. Ask only if the target is ambiguous.
5. Integrate replay/Undo. Removal Undo restores the prior current head; correction Undo restores the preceding effective content. Later unrelated teammate entries remain. Restoring an older value after newer teammate edits creates an explicit sourced correction or conflict, never silently reverting the teammate. Prove live projection equals rebuild after each sequence.
6. Replace current-use raw event reads in the shared reader and dependent modules; retain an explicit history mode. Two quote roles remain separate, with currency/minor units and disputed values. Correcting/removing an older quote cannot erase a newer active quote; removing latest contact recalculates from the next eligible contact/sent/visit-with-contact.
7. Expose the tools with concise grounded descriptions and wire logical-step receipts. A clear instruction applies directly; an ambiguous root/date asks a targeted question. The resulting confirmation names the entry and changed value/date; an empty no-op does not claim a save.
8. Add optional Edit/Remove on one file entry. Show original source/author and current edit time in Details. Use the existing compact Sheet/form/menu. Submit immutable action ID and token; keep a failed draft. Remove shows that one entry leaves the active file and offers saved Undo. Do not require deleting/recreating the client.

### Required tests and completion

- Pure lifecycle: append → revise → revise → remove; revert each actionable event; historical roots; deterministic order with identical occurrence dates; unknown kind/version; wrong entity; incorrect quote currency/minor units/role; invalid local/instant date; conflicting selected head.
- Real D1: exact replay/different payload; source/member/attempt loss after precheck; later SQL failure; simultaneous edits; removed/deleted entity; disputed fields; quota; same action Undo and from-here Undo; teammate unaffected; self-reference migration and rebuild.
- Consumer checks: effective events, C2 file, offered/expected quote, brief, lead overview, search, document links and future after-quote rule show the same head/removal. Historical source remains inspectable and never presented as current.
- New integration file proposed: `apps/worker/test/interactions.integration.test.ts`; extend ledger pure tests, agent-tools, brief and entity lifecycle cases. Complete source/contract/migration/tests before UI acceptance; use section 12 commands. Keep this slice independently useful before contacts/search/scheduling exist.

### C1 source audit and required repairs, 2026-10-08

**Current verdict: core C1 repairs implemented locally; production and full-file UI acceptance remain open.** The user explicitly authorized direct repairs after the source review. The original source audit at `ecc2246` is historical evidence: [28 source hashes and receipt](qa/2026-10-08-c1-recheck-evidence.json), [nine controls passing/eight counterexamples failing](qa/2026-10-08-c1-recheck-tests.json). Its findings remain recorded as observations 71–80 in status. The earlier [first-review receipt](qa/2026-10-08-c1-review-evidence.json) and [52-test implementation output](qa/2026-10-08-c1-implementation-tests.txt) describe the prior baseline.

Implemented repairs:

- **Undo:** custom/unknown handlers hydrate complete interaction state; known unrelated writers skip that read, deletion loads its own entity's roots. Actual Undo persists root deletion, restores previous heads, ignores older/already-reverted descendants and preserves unrelated teammate work. Preview describes the entry text/value and occurrence restored.
- **Quote decisions:** migration 0025 adds `entity_state.quote_authority_json`, a replay-derived decision plus covered financial claims. Resolutions and explicit field corrections survive duplicate removal and date/description-only changes. New financial claims and independent field reports remain accountable. Original events are unchanged.
- **Discovery and consumers:** the shared current-interaction reader returns stable root/head IDs, content, date, actor/source and cursor/coverage. The existing query tool exposes it; Records Notes uses it and distinguishes offered/expected quote values. Explicit event history includes lifecycle/revert links. Stale edits return current content; identical edits consume no extra revision/quota. Root-only tool targets join existing bulk accounting through trusted scoped entity lookup.
- **Validation and reads:** shared contracts validate logging/corrections with the same payload allowlists/channel enum and strict calendar-valid zoned timestamps normalized to UTC. Content-only corrections retain occurrence. Non-quote edits/logs hydrate only needed records; active quote siblings load only when reduction needs them. Forward 0025 canonicalizes legacy quote snapshots and seeds earlier quote decisions.

Verification: the [17-case source-audit probe](qa/2026-10-08-c1-repair-tests.json) passes; [93 targeted pure/workerd cases](qa/2026-10-08-c1-repair-targeted-tests.json) pass, including actual guarded Undo/from-here/teammate cases and populated 0025 upgrade/current-read/no-op/conflict cases. A completed full `pnpm test` run recorded 1,146 passed, 10 skipped and four previously recorded composed-eval status failures. The final rerun stalled in workerd RPC teardown and was terminated; final-source coverage is the 93 targeted cases plus 17 audit cases. This is not a clean full-suite claim. Typecheck, lint, build/Worker dry-run and design/story checkers passed. [Full-suite report](qa/2026-10-08-c1-repair-full-tests.json); current detailed behavior and limitations are in [status](../docs/status.md#c1-direct-repairs-2026-10-08).

Remaining acceptance/work:

1. Production read-only Wrangler check shows latest applied migration **0022**, with no `interaction_state` table. Apply 0023–0025 before deploying these handlers, under explicit deployment authorization. No remote writes, commit, push or deployment were performed.
2. C2's combined client file, optional file-entry Edit/Remove controls, later search/media/follow-up consumers, live-model answer quality and native-device coverage remain separate work. Local C1 evidence does not implement them.
3. R16 Records manual Save bypasses ledger commands/guards, records a fixed receipt revision/hash and silently skips Notes/Drafts edits. Replace that writer before accepting spreadsheet edits; current-read repair is not write acceptance.
4. Production CPU, billed rows and p50/p95 latency remain unmeasured. Local SQL/read shape and fake-provider orchestration are not native-harness performance proof.

## 6. C2 — Read and inspect the complete client file

### Owners and result

Current owners: Worker agent `repository.ts`, `context.ts`, `leadOverview.ts`; ledger queries; brief reader; shared contracts; existing conversation and records components. Proposed reusable reader: `apps/worker/src/entities/file.ts`; route: `routes/entities.ts`; DTO: `packages/contracts/src/entityFile.ts`; UI: `components/EntityFile.tsx` composed inside the existing inspection/records Sheet. One read implementation serves the tool and UI. Do not assemble seven independent HTTP requests in the browser or another reporting service.

Support “Everything on Popescu”, “What happened before this quote?”, “What should we do next?” and “Who recorded that?”. A full file means all relevant sections are represented with honest current/history coverage, not all retained bytes crammed into one prompt. Large histories paginate; fetching one page must never produce an “everything reviewed” claim.

Define a versioned `EntityFile` response with:

```ts
{
  entity: { id, name, kind, aliases, status, assignedMember, mergedFrom },
  asOfBusinessRevision,
  facts: [{ field, value, state, candidates, source, updatedAt }],
  contacts: { items, nextCursor, visibleCount },
  quotes: { offered, expected, disputes, historyCursor },
  tasks: { items, nextCursor, openCount, overdueCount },
  timeline: { items, nextCursor, visibleCount, order },
  notes: { items, nextCursor, visibleCount },
  attachments: { items, nextCursor, visibleCount },
  drafts: { items, nextCursor },
  coverage: { sections, omissions, bounded, unavailable }
}
```

Every current value and timeline item has a source ref/author/observed or occurred time. Dates are typed; unknown differs from disputed. Quote roles/currencies are explicit. Section errors distinguish retryable outage from legitimately empty data and from access loss. `mergedFrom`, contacts and files are populated only when their actual supporting slices exist; absence does not invent a capability or seed placeholder data.

### Implementation steps

1. Resolve the entity by scoped ID or current name/alias and return narrow candidates for an ambiguous name. Deleted entries are omitted from normal reads; explicit accessible history may explain deletion. Once C3 exists, old IDs redirect to the canonical file while retaining originating identity in sources.
2. Batch independent indexed reads for one entity, touched/current fields, aliases, active tasks/drafts, effective interaction heads and relevant memory. Batch member display names by returned trusted IDs; do not perform a query per row. Use the current schema/source names and inspect query plans with unrelated workspace data present.
3. Make effective timeline paging deterministic. Display by actual occurrence time with committed sequence/root ID as tie-breaks; when occurrence date is date-only retain that type. Provide an alternate recorded-order history when useful. A corrected date may move the current entry; history still records when the correction happened. Cursors are versioned, entity/filter/order-bound, validated and opaque.
4. Supply independent section cursors rather than one giant result cursor. Default first pages: 20 timeline items and bounded task/note/contact/attachment pages, never more than the shared 50-row public bound without an explicit larger contract. Counts describe the same visible scoped set. Paginating a timeline must not reload contacts/tasks/quotes on every page.
5. Distinguish offered quote from expected budget. Derive current values from effective interaction/correction/dispute semantics, not raw `MAX(date)` or `quote` text alone. Several active quote currencies/versions are represented, not summed. Show last contact using the same effective rule as briefs, and next step using the same task/snooze/timezone semantics as overdue reads.
6. Add `query` resource `entity_file` or one equally narrow `read_entity_file` tool. Prefer the existing query resource if it preserves strict typed section paging; do not register duplicate tools for the same read. Keep low-volume ordinary turns on the current context; use the file for explicit client-file/reasoning requests. Do not prepend every entire client file on every prompt.
7. Expose `GET /api/workspaces/:ws/entities/:entityId/file` and a section-page variant using the same reader/access predicate. TanStack keys include account/workspace/entity/section/filter. Cancel obsolete reads on navigation; patch affected file sections from actual write receipts and invalidate precisely. A delayed response cannot overwrite a newer accepted correction or dirty R16 draft.
8. Compose the file surface: name/status at top, contact/current facts, next work, offered/expected quotes, then Timeline, Notes and Files with collapsed histories and clear Load more. Desktop uses the current optional detail/records pane; mobile uses a labeled Sheet. Opening a source reveals its original message, author, date and current-versus-replaced state. An “Ask Otis about this” action passes entity/result context, not copied secret payloads into a public URL.
9. Keep task completion/correction actions real and scoped; reuse existing update handlers. Manual field edits obey the existing explicit Save draft choice. An entry-specific correction is its own explicit Save, not an automatic flush of unrelated dirty spreadsheet cells. Opening the file/read source never edits data.
10. Update prompt/table guidance for complete answers. A concise file overview can include a useful table followed by recommendations; specific user-requested details expand. Unknown/unavailable/partial sections are stated accurately; existing personal preference scope is respected. Do not use a lead-only template for other entity kinds.

### Acceptance cases

- One entity with stated/disputed fields, two phone methods, offered and expected quotes, open/completed/snoozed tasks, note/visit/contact/sent events, sources by two members, aliases, corrected/removed interactions and linked files. Every section is grounded and actor-labeled.
- More than one page per section; overlapping/new inserts; corrected occurrence dates; merged IDs; missing authors after permitted lifecycle handling; deleted entities; empty file; unavailable section; stale query after write; cross-workspace ID; removed member; reporter/corrector/teammate views under current permissions.
- Larger unrelated workspace data does not grow target-only reads. Record prepares, batches, rows read, serialized bytes and CPU venue. No row-level N+1, unrelated full loader, all-file binary prefetch or model summary treated as canonical truth.
- Rebuild and a fresh file read agree after correction/remove/Undo. Quotes, next step and last contact match existing brief/lead overview semantics. UI source links do actual scoped reads; no fake history action.
- Proposed test `apps/worker/test/entity-file.integration.test.ts`, web `entity-file.test.tsx`, stories `entity-file/{empty,populated,partial,history,conflict,loading,mobile}`. Add fixtures to the maintained design inventory only as implemented. Use section 12 gates and a native five-width/keyboard comparison.

## 7. C3 — Multiple contact methods and lossless duplicate merging

### Contacts first

Owners: existing entity fields and ledger writer/reducers; agent field validation; `draft_message` recipient resolution; C2 reader; R16 row/cell editor. Proposed projection `entity_contacts`, reduced from small contact add/change/remove/primary-selection events. It holds trusted workspace, stable contact ID/entity, method (`phone`, `email`), value/original representation, label, primary state, source event and revision. Company/address and distinctive contextual facts use shared core/custom field definitions; do not create a fixed physical column for every possible client detail.

1. Define typed contact changes with ID/version preconditions. Preserve the original phone/email representation alongside a comparison key where reliable. Country-free local phone numbers are not guessed into E.164. Email normalization must not silently alter user-intended local parts. Distinguish personal company/contact labels from another entity's canonical identity.
2. Add targeted projection hydration and atomic contact commands. Replayed mutations add no duplicate contact. Selecting a primary contact changes the relevant methods together, with a constraint/guard enforcing at most one active primary per type. No automatic primary switch when confidence is uncertain; retain existing primary until changed or removed.
3. Bridge the old `phone` field losslessly. Legacy nonempty phone becomes a sourced contact on backfill/read adapter; do not emit a fictitious member event during migration. Existing tool consumers can continue using the effective primary phone. Custom columns must not become a second contact source. Keep conflict/source history if two old values disagree.
4. Register contact edits for Otis and R16. Clear “Add this second number” applies directly. “Use his number” with several methods asks which; outgoing draft chooses the explicitly named or unambiguous primary recipient. No external message sending is added.
5. C2/records display all methods with normal labels and a primary marker. Contact removal is reversible and does not remove a client, original message or unrelated method. Address/language/company keep original source and unknown/disputed state; special data remains eligible for flexible custom fields.

Contacts acceptance: two phones/two emails; duplicate same method; original formatting; no inferred country; malformed values; primary change/remove; legacy migration; conflicting data; retry/different payload; teammate version race; scoped Undo/rebuild; draft/WhatsApp copy encoding using the selected method; privacy and exported representation.

### Identity merge second

Otis may identify likely duplicates but never merge distinct people by fuzzy name alone. “Merge Hunor and Hunor-Attila; they are the same person” supplies explicit intent, but both scoped targets and consequences must still be verified. If only names look similar, present candidates and ask. One explicit targeted confirmation covers the concrete merge preview when identity/conflicts require it; do not ask separately for every preserved note.

Use a small event-backed `entity_redirects` projection to resolve old IDs to a surviving canonical ID, plus explicit field/contact conflict decisions. Original events, source identities and file links are retained. Do not rewrite thousands of historical event `entity_id`s or delete the source client to simulate merging.

1. Add `preview_entity_merge` as a read or bounded mode of a single merge tool, not a separate orchestration engine. Return source/target display names, visible dependency counts, conflicting fields/status/owners/contact primaries and required decisions at current revision. The preview hides inaccessible content/counts. An opaque preview/version token binds targets and base revisions.
2. Define `merge_entities` with canonical/source IDs, expected revisions and explicit conflict decisions. Server derives authority and source. Reject cross-workspace/deleted/same-target/cyclic redirects and a missing target. Initially merge one source into one target per command; a many-record cleanup can repeat reviewed commands under existing run/Undo ownership.
3. Preserve compatible fields, aliases, notes, tasks, drafts, contacts, attachments and references. Conflicting confirmed values stay candidates/disputed unless the member explicitly selects one; preserve the other value/source in history. Won/lost, assignment and primary contact are not silently chosen by timestamp. Same phone alone is evidence, not permission.
4. Commit the redirect and affected current field/contact decisions in one guarded ledger transaction. Emit an `entity_merged` event with original/surviving identity refs and minimal reversible decisions, not a full blob of history. A failed dependency/authority/revision check rolls back everything. Dependents can retain original IDs and resolve at reads, avoiding mass writes.
5. Implement one canonical resolver used by find/query, file, tasks, notes/memory, briefs, lead overview, draft grounding, attachments, search, editor and exports. Pagination and aggregate counts deduplicate canonical identities. New writes through an old alias/ID resolve to the canonical ID while retaining an immutable originating entity reference. Resolve that reference from the actual supplied ID or uniquely resolved alias before redirecting, never from a model-invented history label. A write directly to the surviving client originates there. Bound redirect traversal and reject cycles; rebuild the redirect projection deterministically.
6. Return a losslessness manifest: source IDs and counts/mappings for retained relationships and each conflict decision. Do not claim a summary proves all original information retained. Automated tests assert that every old source/relationship remains reachable through current file or history.
7. Undo unmerges the specific redirect/decisions with original records restored. A post-merge note/task/file addressed through the former client's ID returns to that immutable origin; work addressed directly to the surviving client stays there. A new correction targets its interaction/contact root and therefore keeps that root's origin. Derived merge decisions can be reverted only if their expected heads still match; a teammate replacement produces a precise conflict instead of being overwritten. Do not infer ownership from dates/text or redistribute a new shared dependency with no provable origin. Preview such a conflict and require a sourced explicit assignment before unmerge can complete. Tests assert the manifest before merge, after merge and after Undo, including later writes to both origins.
8. UI presents “Combine duplicate clients”, one comparison and clear conflicts; after commit the file shows “Combined with …” plus history/Undo. It must remain understandable without primary-key/database terminology. R16 cleanup calls this same lifecycle, not a separate destructive merge.

Merge tests: real two-client histories with thousands of unrelated rows; lossless different notes/tasks/files; status/owner/quote conflict; same-name distinct entities; shared phone; alias collision; source/target deleted; double merge/retry/different payload; concurrent teammate change; chained merge/cycle; source author/access; mapping counts; old ID/alias lookup; dependent writes after merge; Undo/from-here/rebuild and erasure/export.

Proposed files: ledger `commands/contacts.ts`, `commands/mergeEntity.ts` and reducers/extensions following existing shape; Worker canonical resolver colocated with entity reads. Extend existing tool/DTO owners. Proposed tests `contacts.integration.test.ts`, `entity-merge.integration.test.ts`, ledger pure and C2/brief/agent-tool regressions. Use forward migrations; contact/redirect rows are projections of ledger events. No ORM or identity matching service.

## 8. C4 — Retained business photos, documents and original audio

### Existing owners and chosen approach

Reuse `apps/worker/src/media/{routes,repository,cleanup,renditions,transcription}.ts`, accepted message/image attachments, private R2 binding, provider adapters, current `MessageImages`/`VoiceMessagePlayer`, and C2 file UI. Accepted media currently expires (audio cleanup documents 14 days), and normal read/finalize paths check `expires_at`. A gallery alone cannot deliver permanent business-file access if cleanup still removes the bytes.

Add event-backed `attachment_links` connecting an existing scoped media ID to an entity and optionally stable interaction root. Bytes stay in R2 once. Link identity, origin message, upload author, occurrence/upload date and retained status are accessible metadata, not public object keys. Existing chat-only attachments remain supported; do not guess entity linkage from proximity to a name when ambiguous.

For PDFs, first evaluate Cloudflare's managed `env.AI.toMarkdown` through one Worker AI binding and the existing Queue. The service documents PDF conversion and is free for most conversion formats; some model-backed conversions may incur Workers AI usage. It avoids implementing a PDF parser in the ordinary Worker request. This is the selected conversion candidate, subject to measured fidelity/latency/limits before acceptance. Sources: [conversion overview](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/), [supported formats](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/supported-formats/), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).

Provider-native PDF understanding is optional on a verified capable route. Gemini supports native document input and reusable file uploads; its provider files expire, so R2 originals remain canonical and uploads are a disposable accelerator. Do not advertise support on OpenCode/Muse/other selected routes without an actual probe. Source: [Gemini document processing](https://ai.google.dev/gemini-api/docs/document-processing). Most text-only routes can consume bounded converted text without a provider-file integration.

### Implementation slices

1. **Links and retention:** define `link_attachment`, `unlink_attachment` and explicit retention behavior through the ledger. Validate media workspace/state/source and entity/interaction ownership. A link never grants access beyond the current scoped source/media policy. Exact replay yields the existing link; different-target reuse conflicts. Unlink is logical and preserves history/Undo.
2. Add a retained-business-file policy to media metadata; do not use an arbitrary far-future expiry as a policy. Existing transient uploads retain their current TTL. Linked originals remain retained while current/history links require them. Explicit unpin after all links are released starts a visible grace/retention policy; audited erasure can remove bytes. Undo during that grace works. Display original unavailable/expired truthfully for historical files already deleted; do not ask users to reupload retained bytes that still exist.
3. Make cleanup and linking race-safe. Cleanup conditionally claims only unretained eligible media; linking must reject a deleting/expired claim. Recheck links/state before R2 removal, retry real failures, and retain tombstone metadata when bytes disappear. Do not delete before the SQL decision is durable or pretend R2 deletion can be rolled back with D1. Index due unretained media and inspect cleanup rows written/read.
4. Extend attachment discovery to `entity_id`/workspace-accessible source plus typed kind/date filters. Preserve chat-scoped default and old image pagination. Composite cursors include sequence plus attachment position/media ID, so a four-photo input split across pages never drops remaining photos at the same sequence. Entity files show accessible photos/PDF/audio even when original chat is outside the recent prompt window.
5. **PDF upload/read:** add `application/pdf` to a separate document format branch; do not route PDF through image/audio validators. Use the existing quarantine/ticket/private upload protocol, actual magic/container checks and a bounded initial upload size (proposed 20 MiB, accepted only after conversion/budget measurement). Reject malformed/unsupported/encrypted-without-readable-content files honestly. Preserve original filename safely and compute a source checksum once.
6. Create a small durable extraction job keyed by workspace/media checksum/extractor version. Reuse the existing Queue/wake/retry pattern; do not hold the workspace execution slot or the upload ACK while conversion runs. Job completion is attempt-guarded and cannot overwrite a newer extraction or resurrect erased/inaccessible media. Retries reuse original bytes and a completed extraction; no conversion on each follow-up.
7. Store converted text/chunks/manifest in private R2 and small job/manifest metadata in D1. Bound each returned chunk and total accepted output; do not store a multi-megabyte document in one D1 row or inline the whole text in every prompt. Source refs identify media/checksum/extractor version and actual page/section when available. If conversion supplies no reliable page map, cite section/chunk and do not invent page numbers.
8. Add typed `read_document` (metadata, section/search, selected chunk read) and extend actual image view/discovery. Reads perform membership and current source-access checks before text/bytes/provider spend. Empty/scanned output is `needs_visual` or extraction failure, not a successful blank read. Use verified native PDF/vision when available for layout, tables and scans; otherwise say what could not be read and retain the file. Do not summarize unread pages as facts.
9. File content is untrusted data: embedded instructions/links do not authorize writes, network fetches or secret access. Render converted Markdown with the existing safe renderer; disallow executable schemes/raw HTML and unsolicited remote image fetches. Original text, extracted content and model interpretation stay distinct. Facts saved from a document are sourced ledger actions; extraction itself does not quietly mutate business records.
10. **Gallery/source UX:** use current image/audio controls inside a lazy-loaded client-file gallery. Thumbnail metadata loads first; bytes load on view. Next/Previous/keyboard swipe moves across retained links, preserving source/date/author and viewport. PDFs show filename/status, a scoped original viewer/download and read/extraction state. Audio displays original player and corrected transcript together; transcript edits append a sourced correction, leaving original audio intact.
11. Client private object URLs/ranges are released on close/navigation/access loss. Every Worker range/read checks membership/source access before returning content, including cache validation. Do not expose presigned bearer URLs/public buckets for permanent private viewing. Source: [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [presigned URL security](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

### Acceptance matrix

- Images already retained: initial/follow-up/old-chat retrieval; all four from one source across pagination; more files in a gallery than per-turn image bound; unknown/model-unsupported vision; immutable retry UUID; no duplicate storage/link.
- PDF: text, tables, image/scanned content, non-Latin text, malformed/encrypted/oversized, extracted output limit, cancelled/retried job, unavailable conversion binding, new extractor version, older source after model switch. Test actual managed conversion and selected provider separately; fake adapters prove plumbing only.
- Voice: original/transcript/corrected transcript retain linkage; metadata survives optional-byte expiry; linked retention prevents cleanup; genuine Android/iPhone/Telegram formats remain an independent field gate.
- Security/lifecycle: foreign media/entity/source; link cannot bypass source access; owner transfer; source removed; late membership loss; range/cache; erased workspace; cleanup-versus-link; failed R2 delete; Undo/unpin; export with permitted links and no object keys/secrets.
- Cost: extraction once per immutable version; no idle database poll/token transport; bytes/storage conversion measured on typical and bounded-large fixtures. Image/PDF code is lazy in the web bundle; ordinary text sends gain no PDF dependency or conversion wait.
- Extend media integration/cleanup/rendition/voice suites; proposed `document-media.integration.test.ts`, `entity-attachments.integration.test.ts`; web gallery/source tests and implemented states. Record actual binding/format/provider evidence before marking supported.

## 9. C5 — Search the workspace's retained conversations and sources

### Current gap and contract

Current `read_chat_history` accepts an explicit chat ID and pages it, validating workspace membership/existence. This is useful older-history access, not workspace search: the model cannot discover which unrelated chat contains a promise. Memory already has FTS; preserve its active/suppression/private filtering. Do not replace it with embeddings as a prerequisite.

Proposed owners: `apps/worker/src/conversationSearch.ts`, a versioned DTO/tool in current contracts/tools, current conversation append/reply/erasure paths, C2 source reader and existing access rules. Add one D1 FTS5 projection of retained searchable conversation text/source documents as needed. FTS is rebuildable acceleration, never the only source. D1 documents FTS5 support: [SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/).

Each result includes source kind/ID, chat ID/title where applicable, trusted author, entity/root when known, actual recorded/occurred dates, excerpt, current/history/retracted state, and a source read reference. A model reply mentioning a promise is not proof the team made one; label member statement versus agent answer versus committed task/interaction evidence.

### Implementation sequence

1. Add `search_workspace_history` with plain `query`, optional entity/chat/author/date/source-kind filters, bounded limit and cursor. Date intervals use inclusive start/exclusive end and the acting member's explicit interpretation timezone; ask if needed. No raw SQL/FTS syntax from the model, no workspace/actor authority arguments.
2. Build the index from canonical rows. Insert/update through the same message append/acceptance transaction or a durable idempotent index work item, preserving current latency/statement budgets. Committed system answers index only after acceptance; previews never index. Batch historical backfill by checkpoint/cursor, not a single full-database scan in a request. Erasure removes index content with sources.
3. Index source text with trusted workspace/actor/source date metadata outside searchable body. Entity aliases expand candidates through the existing resolver; do not dump every workspace alias into the query. Preserve Unicode names/diacritics and sanitize bounded user words. Empty/punctuation-only searches return a useful narrow result/clarification rather than an unbounded fallback scan.
4. Apply workspace, live membership, existing personal-memory scope where applicable, active/suppression and date predicates before LIMIT/excerpt/count. Then hydrate returned source IDs in bounded batches. Never return restricted snippets/counts and hope the model hides them. Canonical source existence/visibility is checked again on open.
5. Support two explicit read modes: bounded relevance results for finding evidence, and chronological paged results for “all matching conversations last month”. Chronological keyset cursors use immutable recorded time plus source ID and a first-page upper boundary. Do not use changing FTS rank as a supposedly stable all-results cursor. Relevance results disclose their bound and invite narrowing/chronological continuation where completeness matters.
6. Add bounded surrounding-message retrieval using existing `read_chat_history` once a match identifies the chat/sequence. Return enough preceding/following context to resolve negation, speaker and corrections; no whole-chat loading by default. Keep original source order and identity. Corrected/removed business claims link to their current interaction/task state rather than being re-saved from a stale transcript.
7. Expose source opening to the UI: navigate within the existing chat and fetch around that message, or open a read-only source sheet. Highlight the selected passage without editing/reposting it. Non-author teammates can inspect permitted shared history but cannot append/stop as that author. Source reads retain their existing access rules.
8. Prompt guidance: recent context first, targeted search when older/cross-chat evidence is needed, read source before a consequential write, cite human dates/authors without dumping IDs. “What did we promise Popescu last month?” reconciles retrieved words with saved tasks/promises and correction history. Never turn a draft/agent suggestion into a commitment.

### Evidence and regression cases

- Promise in a different chat beyond the recent window; alias/renamed/merged entity; Romanian/Hungarian/Persian names; “we did not promise”; model-only promise; corrected date/value; quoted/forwarded context; matching new message between pages; repeated identical text; forgotten/suppressed note; erased source.
- Filters and cursors with identical timestamps, foreign IDs, malformed/expired cursor, author/date/scope changes and empty search. Ranked partial output cannot claim all results. Source IDs stay stable after indexing/backfill/rebuild.
- Three members: author, owner and teammate; current shared conversation access and read-only author boundaries remain intact. Foreign workspaces and removed members get no snippets/counts/neighbor messages/cached replies. Existing personal preferences are not indexed into shared conversation results. Retained old shared history follows existing join disclosure.
- Measure FTS row counts, hydrations, result bytes and ordinary acceptance write overhead with sparse/large unrelated corpus. No per-result queries, search-on-every-token or model summarizer before results paint.
- Proposed `workspace-history-search.integration.test.ts`, index backfill/erasure tests, agent composed recall cases and web source navigation tests. Complete section 12 gates, then controlled actual-model cross-chat answers. Documentation-only planning is not search acceptance.

## 10. C6 — Recurring and condition-based follow-ups

### Reuse, not replacement

Owners: `apps/worker/src/reminders/service.ts`, reminder tools/validators, current cron/Queue entrypoints, brief kernel/read/service, C1 effective interactions, task due/timezone helpers, C2 work section and lead overview. Migration 0018 already provides member-owned one-off reminders and an indexed due sweep. Keep one-offs working; a task deadline, explicit reminder and chosen daily brief remain different intents.

Support a deliberately useful first recurrence set: weekly on chosen weekdays/local time; after an offered quote by elapsed hours or local calendar days; optional “if no response” condition. Natural conversation creates/changes/cancels these rules. No cron/RRULE editor, general workflow DSL, inference-created nags or automatic external outreach. Custom unsupported recurrence is reported clearly until implemented.

### Durable model and semantics

- `reminder_rules` is a small event-backed projection: workspace, rule ID, requesting/receiving member, optional entity, rule kind/typed spec, timezone/channel, active/paused/cancelled, revision and `next_due_at`.
- Extend existing `reminders` occurrence rows with nullable rule/root refs, expected rule version and a unique stable occurrence key. One-offs keep their existing shape. Internal delivery attempts/status are transport state; confirmed rule changes use ledger events/receipts/Undo and trusted source.
- Weekly spec: weekday array, local `HH:mm`, IANA zone, optional explicit start/end. Compute the next future slot in code. Missing time/zone asks; no 09:00/noon/device-zone invention. “My usual time” may use an explicitly saved chosen setting, with the confirmation stating it.
- Relative spec: trigger offered/expected quote as explicitly resolved, elapsed-hour versus calendar-day offset, local time when needed, timezone and optional no-contact condition. “Three days later” must not be silently converted between 72 hours and local calendar dates if material; propose/confirm the actual interpretation narrowly.
- Weekly occurrence key is stable per rule/local scheduled day, not provider run or retry. Delivered slots do not fire again because rule text/version changes. “Again today” is a separate explicit one-off request. The version still guards claims of pending occurrences.
- After-quote key is rule plus stable interaction root. Correcting its amount/date reschedules an undelivered occurrence against the current head; a delivered occurrence does not fire again simply because the quote was corrected. A genuinely new quote root creates a new occurrence.
- “If no response” checks effective contact after that quote using the code-owned last-contact rule. Without that requested condition, do not silently suppress an explicit reminder merely because a contact occurred. Date-only due, instant due and snooze remain distinct.

### Implementation steps

1. Add pure recurrence validators/calculators with current date/time helpers: valid timezone/calendar input, deterministic next slot, weekly day selection, DST gap/fold behavior. Use one documented policy: a nonexistent local time advances to the next valid local minute; an ambiguous fold fires once at the earlier occurrence. Show the actual next time/zone in confirmation. Test this policy; do not rely on `Date.parse` rollover.
2. Create strict create/change/pause/cancel rule tools through the existing logical-step/ledger owner. Persist clear requested details and ask narrowly for missing time/zone/condition. No arbitrary JSON schedule or trusted user IDs from the model. Default recipient is the requesting member; another recipient requires explicit instruction and scoped authorization.
3. Add forward rule/occurrence migrations and indexes for active `next_due_at`, workspace/member rule reads and stable occurrence uniqueness. New handlers hydrate only the rule/affected source/occurrence dependencies. Exact action replay charges no extra mutation, and whole-request rollback includes future occurrence changes.
4. On quote create/revise/remove/Undo, update or durably enqueue evaluation of just the affected rule/source pair in the same accepted action path. Do not scan every rule on every chat message. Removal cancels pending source-linked occurrences; source Undo can reconsider system-cancelled pending work, but never resurrect a member-cancelled rule or resend a delivered occurrence.
5. Extend the due sweep: indexed bounded discovery, guard current rule version/member/channel/condition/source head, claim and create occurrence/delivery intents atomically, then advance only that rule's next due. Web/Telegram use the existing canonical-message and delivery owners. Network retries repair one occurrence rather than send another.
6. Improve wake precision without multiplying all maintenance. Current cron is every five minutes. For approximately minute-level reminders, add a reminder-only minutely cron branch in the same Worker if measured Free budgets allow; existing voice/media/memory/brief sweeps keep their cadence. Branch by actual cron expression and dedupe overlaps. Empty ticks do an indexed read and no writes. Queue handles bounded remaining due work/retries; no polling of provider tokens or per-rule heartbeat rows.
7. Record scheduled time separately from actual delivered time. This architecture is minute-level/best-effort, not a hard real-time guarantee. If delivery is delayed after downtime, produce one informative latest reminder per recurring rule and skip/report obsolete missed occurrences rather than flood weeks of alerts. Do not drop pending one-off reminders silently; their late-delivery policy must be explicit and tested.
8. Cancel/change handles a due-race. If delivery has already committed, report that standing outcome and affect only future reminders. A queue item with an old rule/version cannot deliver after cancellation. Membership/recipient access loss and erased sources prevent delivery at commit.
9. Add a general `tasks`/work ordering option `overdue_first` using the existing due/snooze/member-timezone semantics, plus full filtered counts and keyset pages. Reuse it in C2, ordinary requested tables and optional R16 work lists. The lead overview remains a useful source, not the only overdue surface.
10. UI uses ordinary copy: “Every Monday at 09:00 · Europe/Bucharest”, “Three days after an offered quote, if no reply”. Show next run, channel, pause/change/cancel and actual last delivery. Daily briefs still start disabled and keep their chosen cadence; setting a recurring rule does not enable unsolicited briefs or lead messaging.

### Required proofs

- Weekly next-slot before/after today's time, multiple weekdays, start/end, leap/year boundary, invalid timezone/date, spring gap/autumn fold. Relative hours versus calendar days; quote correction/removal/restore; explicit no-response versus unconditional reminder; later contact; snoozed/completed tasks.
- Create/change/cancel/replay with immutable action hashes; stale rule version; crash around occurrence/delivery/next-due commit; two sweeps/queues; late Queue; transient Telegram failure; removal/owner transfer; recipient/source access; downtime catch-up; one-off and chosen briefs unchanged.
- Empty cron no writes; many unrelated future rules not scanned; cap/continuation honesty; due ordering/counts across multiple zones. Measure rows/CPU per empty/due tick and notification delay with actual scheduling venue.
- Extend `reminders.integration.test.ts`, brief/kernel tests and agent tool/clarification cases; proposed `recurring-reminders.integration.test.ts`, pure recurrence tests and overdue task-read tests. Use section 12 gates. Do not call fake deliveries real notification acceptance.

## 11. C7 — Who logged what and trustworthy source attribution

### Scope corrected by the user's latest clarification

Otis's wishlist combined attribution with keeping some entries private. The user subsequently clarified that they had not requested a feature called private notes. **Restricted-visibility notes are not selected implementation scope.** The earlier author-and-workspace-owner answer records a possible access policy if that feature is explicitly selected later; it does not authorize private capture, a new audience schema or changes to shared conversation access.

This workstream implements “who logged what”. Preserve current shared workspace business records and existing personal preference boundaries. Private R2/downloads elsewhere in this plan mean membership-protected storage, not a new private-note product.

### Existing owners and implementation slices

Events already contain trusted `actor_user_id`, source, channel, occurrence and recorded time. The generic event query omits some actor columns; file/table/agent reads need useful provenance. Reuse existing users/membership/source relationships and C1/C2 DTOs rather than creating a second audit log.

1. Return actor identity, readable current display name, original source reference, channel, occurrence date and recorded date in the effective interaction/history DTO. Join scoped source/user rows in the same bounded read; avoid one HTTP/SQL lookup per timeline row.
2. Distinguish the original reporter from a later corrector. A correction/removal event records the current authorized actor and retains the root's original author/source. “Recorded by Hunor · corrected by Avi” must follow saved events, not model guesses or a mutable last-editor field that loses the reporter.
3. Distinguish the trusted acting member from a person mentioned in content. “Hunor told me the client called” records the authenticated reporter; Hunor is a reported participant unless authoritative source identity actually establishes him as the author. Do not infer permissions or account identity from a name/Telegram display text.
4. Pass provenance into retrieved agent context and client-file/table/source UI. Questions like “What did Hunor log last week?” use actor and time filters in code, preserving the requested interval timezone. Do not rank the most recent mention of Hunor as his own report.
5. Keep original occurrence time, recording time and correction time separate. Missing historical author/display name uses a truthful fallback. Membership removal, owner transfer or profile rename does not reattribute an old event to another person. If the existing store keeps only a current display name, label it as current rather than inventing the original spelling.
6. Preserve current access rules at source/history/action reads: membership is rechecked, teammate chats remain read-only, question answers still target their original requester, and foreign workspace IDs grant nothing. Actor display does not grant authority to edit/answer as that person.
7. Characterize and repair the existing personal-memory direct-ID gap independently. At this baseline `get_memory` filters workspace/active/suppression but does not apply the `member_in_workspace` subject predicate used by search/context. Knowing another member's memory ID must not return their personal preference. Reuse the current policy; do not open it to owners or add a new business-note visibility system.

### Acceptance and files

Use two reporters plus an owner and a second workspace. Log a visit, correct it as another authorized member, remove/Undo, merge clients and rebuild. Assert reporter/corrector/source/time on the file, events, agent context and requested attribution table. Test actor-name mention versus actual actor, profile change, departed display name, source deletion under audited erasure, simultaneous teammate work and bounded joins with thousands of unrelated rows.

Direct-known-ID personal-memory tests assert own permitted access and denial to another member/foreign workspace, including inactive/suppressed entries. Owner status alone must not broaden the existing preference policy. This test is for an existing authorization boundary, not acceptance of a private-note feature.

Extend existing event/tool serializers, C2 reader/components, `memory.integration.test.ts`, agent-tool/actor and ledger rebuild tests. Add proposed `event-attribution.integration.test.ts` and production file/source stories. Use section 12's implementation/native gates. No new private-note tables, composer switch, ACL framework or preview audience bus is part of C7.

## 12. Q — Response quality, verification and delivery

### Capability truth and useful answers

Update `packages/agent/src/prompt.ts`, tool descriptions and composed evals only when the underlying slice exists. The current prompt's absolute technical-secrecy wording must not prevent candid product feedback when directly asked for capabilities/features. Permit plain-language capability explanation and requested developer discussion while keeping keys, private content and authority protected. Do not create a developer mode or infer privileges from “I'm the developer”.

Ground capability answers in actual registered tools and current read results. A minimal generated capability description from those same owners is sufficient if tool descriptions are inadequate; no parallel hand-maintained capability matrix or introspection service. Distinguish available, limited, unavailable and requested improvements. Explain existing Undo, retained-image lookup, older-chat reads and one-off reminders accurately. Never fabricate an audit of backend internals or claim a feature exists because a plan does.

File answers should lead with useful facts and actual pending work, choose requested/general tables, disclose paged coverage, preserve author/date/source and distinguish recorded fact from recommendation. Corrections say what committed; partial/failed writes do not become confident confirmations. Comprehensive output is supported by efficient scoped reads, not a second formatter model or forced short-answer rule.

### Common test/command gates

Inspect actual tests/project names before running. Root package scripts currently support:

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm check:design
node plans/qa/docs-audit.mjs links
git diff --check
```

Implementation slices run the first four plus meaningful behavior cases. UI changes additionally run the design checker, scoped a11y/keyboard cases and native comparison at 360, 390, 900, 1280 and 1440 px. Use production components and native Codex/Antigravity browser controls; no Playwright. Synthetic DOM geometry is not physical device/provider proof.

Focused existing command patterns (use only affected suites and add the new selected files):

```text
pnpm exec vitest run --project worker apps/worker/test/field-batch.integration.test.ts apps/worker/test/agent-tools.integration.test.ts
pnpm exec vitest run --project worker apps/worker/test/ledger.integration.test.ts apps/worker/test/brief.integration.test.ts
pnpm exec vitest run --project worker apps/worker/test/memory.integration.test.ts apps/worker/test/reminders.integration.test.ts
pnpm exec vitest run --project web apps/web/test/outbox.test.ts apps/web/test/conversation.test.tsx apps/web/test/scroll-route.test.tsx
pnpm exec vitest run --project pure
pnpm exec vitest run --config vitest.eval.config.ts
```

A missing renamed test file is a reason to inspect current ownership, not claim the check passed. Harness hangs/known pristine failures are reported exactly with actual narrower results; do not silently waive full gates or write “all green”. Documentation-only planning requires link/consistency/diff checks and reports application tests only if actually run.

### Integrated acceptance corpus

Extend [the maintained response cases](qa/2026-10-07-agent-response-cases.md), not another disconnected eval report. At minimum exercise:

1. Correct an offered €450 quote to €500, change only that interaction's date, then remove a duplicate visit and Undo. Expected budget and unrelated teammate entries remain intact.
2. Ask for everything on that client; source facts, offered/expected quotes, current tasks, contact methods, timeline and file links agree with rebuild. If paged, the answer states coverage and can continue.
3. Add a second phone/email; draft to a specified method; combine two confirmed duplicate files, preserving contradictory facts and all sources; Undo merge without losing post-merge work.
4. Link several photos, a PDF and a voice note; refer to them from a new/older chat; retrieve retained originals after recent context changes. Correct transcript without changing original audio.
5. Search another chat for last month's promise, including negation/aliases/corrections and source attribution. Read the source before creating/modifying a task; no unsupported claim of comprehensive recall.
6. Ask for Monday reminders and three-day-after-quote conditional follow-ups; provide missing time/zone, change/cancel, then simulate DST/downtime/contact/quote correction and Queue retries. Exactly the appropriate occurrence is delivered.
7. Two teammates log and correct different entries on the same client; file/table/history/source show actual reporters and correctors. Foreign/removed members are denied, and an existing personal preference cannot be read by another member through a known ID.
8. Send a follow-up while Otis streams; hold ACK/snapshot/SSE in varied order, reopen offline, retry and load earlier. Source bubbles retain identity/order and answers stay with the right run.
9. Ask the actual developer capability question from this request. The response identifies available tools/limitations accurately, proposes improvements in plain language and performs no business mutation or fake introspection.

Deterministic providers prove orchestration/effect safety. Before response-quality acceptance, run a controlled varied held-out live-model set through the actual configured adapters, with synthetic business data and explicit spend/route evidence. Measure first useful output, total time, provider/cache/tokens when supplied and each failure type. The user's original request for low latency remains; do not claim native-harness parity from fake replies or local smoke.

### Migration, performance and rollout record

Each schema slice gets a forward migration from the then-current tip (0022 at planning), local workerd migration/rebuild/foreign-key/self-reference checks and legacy fixture compatibility. New projections/indexes include backfill/erasure/Undo inventory. Keep scope-specific read-only fallback only when truthful; missing schema must not emit fake success or expose tools that cannot execute.

Measure ordinary text-turn cost before/after each feature, not just the feature path. No client-file read, document parser, global FTS scan or recurrence pass should run for every message. Capture query rows/bytes/prepares/batches, response size, first paint/first useful output and actual Worker CPU at its venue. Run large unrelated fixtures and bounded target-heavy fixtures separately. Persisted business history is not a disposable cache; verify storage/retention growth rather than pruning dedupe/history indiscriminately.

When a selected slice is ready, record actual files/contracts/migrations/checks/remaining limits in existing `docs/status.md` and its backlog row. Review the concrete result before any user-authorized deployment. No source/remote mutation was performed by this planning document. Keep detailed unique test artifacts under `plans/qa`; do not create another audit/status/handoff document per slice.

### Stop/clarify conditions

- Source drift: compare current in-scope code with the inspected `32fd9e5` baseline and this document, retain already implemented repairs, update the selected slice before editing. The probes were run at `929b57e`; compare their actual owners before relying on them. Routine naming/refactoring can be resolved without asking.
- A requirement would permanently erase history, merge uncertain identities, silently choose disputed values, expose private material or send real external contact messages: preserve the safe state and surface the specific unresolved decision. These plans do not authorize those effects.
- A bounded migration/transaction cannot preserve self-references, dependent data or required Undo, or measured platform costs exceed the actual venue: document the concrete evidence and adapt the narrow design before proceeding. Do not solve it by adding an unmeasured service/framework or claiming a higher budget.
- An unavailable provider/conversion capability remains unavailable until measured. Retain the input and useful other facts; do not hide a gap behind empty completed output or a request to reupload existing retained bytes.
