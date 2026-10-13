# R16 — Repair Your information from the ledger to the editor

**Status:** selected, ready to implement. **Priority:** P1, including an immediate ownership repair. **Effort:** L overall, six bounded slices. **Risk:** high for persistence/replay, medium for draft/grid integration, low for control consolidation. **Planned:** 2026-10-10 at `813bc27` plus the current working tree. Inspected migration tip: `0029_attachment_annotations.sql`.

This supersedes the October 7 greenfield R16 plan. Repair the existing page and finish the selected flexible editing experience. This is a plan, not a claim that the repairs shipped. The running observations recorded during investigation are consolidated in section 2. Keep one R16 plan and the existing status/backlog; no competing audit/handoff document.

Inspect Git status and the relevant live owners before execution. Preserve unrelated transcript/agent/Telegram/export/erasure work. User prohibited subagents. Routine decomposition and reversible choices do not need permission. Commit/push/deploy authorization comes from the assigned implementation task, not this file.

## 1. Product intent and settled decisions

Otis is a mobile-first conversational business memory. This page edits the information Otis actually uses. Desktop should behave like a spreadsheet; mobile should make finding and editing a record easy. It is not another spreadsheet database synchronized later with Otis.

| User decision | Required behavior |
|---|---|
| Manual changes wait for Save | Cell, row, column and list edits remain in a recoverable scoped draft. Zero business writes/model calls on keystrokes. Explicit Save persists them. |
| Fluid information | Users and Otis can create/remove rows and sparse custom columns, and create simple named lists. Distinctive facts must not be discarded because the original schema lacks a field. |
| Nontechnical users | Say Your information, list, Add row, Add column, Save, History. Default a new column to text. No DBMS/schema wizard, internal IDs or tool names in ordinary UI. |
| Conversational calculations | Describe the desired calculation to Otis. It proposes a validated rule referencing actual columns. No required formula code or invented default expression. |
| Otis on clean saved information | Authorized cleanup applies immediately through ledger commands, with an intelligible summary, history and saved Undo. |
| Otis on an unsaved draft | Tidy that draft; the member still clicks Save. Enforce this target in code for both existing and new write tools. |
| No loss during tidy | Retain original values, sources, attachments, relationships and identities. Originals remain inspectable; a summary alone does not preserve its inputs. |
| Useful devices | Desktop ranges, clipboard/fill, typed editing, column controls and row actions; mobile search, readable row list, normal forms and reachable Save. |
| Team edits | Different-cell edits can coexist. Same-value/source conflicts keep the local draft and show the affected values; preserve unrelated teammate work. |

The Farsi example means distinctive information deserves useful storage. Preferred language already exists; reuse it when appropriate. Loading entrance instructions may justify a sparse custom column. These examples do not prescribe a lead-only template.

Release journeys: edit a client here and ask Otis to read the result; capture a fact in chat and see it here; add a sparse column and recover it after reload; create Products with price/quantity and a conversational total; tidy clean information and a dirty draft; recover a lost Save response; remove/Undo without losing sources; edit on a phone.

## 2. Verified observations and current owners

The [supplied screenshot](qa/2026-10-10-records-before.png) shows two Ask Otis buttons, two Add row buttons, a crowded toolbar and competing searches. Preserve the useful shared navigation, dark canvas, compact rows and real records. Empty space below four rows is not a defect to fill with dashboard cards.

Evidence below is source inspection. S = localized, M = one feature boundary, L = multiple persistence/client owners. Risk describes the change. Confidence describes the code finding; browser symptoms/exploitability were not exercised in this planning pass.

| ID / priority | Finding and consequence | Current evidence | Effort / risk / confidence |
|---|---|---|---|
| F01 / P0 | Create upserts an existing global entity ID without restricting the conflict update to the acting workspace. Reject foreign-ID collisions and enforce ownership in the transaction. | [records route](../apps/worker/src/routes/records.ts): 863–890, especially 874–877 | M / high / high |
| F02 / P0 | Save directly deletes/updates projections, fixes receipt hash/revision, and commits independent 100-statement chunks. Normal history/replay/Undo do not describe those effects; later failure can leave partial changes. | records route: 748–760, 912–992, 1005–1034 | L / high / high |
| F03 / P1 | Notes/Drafts mutations are skipped by `!isDraft && !isNotes` while the route returns saved true and UI clears the draft. | records route: 738–741, 754, 863, 964, 1034; [RecordsScreen](../apps/web/src/components/records/RecordsScreen.tsx): `handleSave` | M / high / high |
| F04 / P1 | Added columns are omitted from Save; list creation only changes local arrays. Names/types/options and empty definitions have no durable lifecycle. | RecordsScreen: `handleAddColumn`, `handleCreateList`, `handleSave`; [client](../apps/web/src/api/client.ts): 425–439; records route: 395–467 | L / medium / high |
| F05 / P1 | Phone/email read contacts but Save writes entity_state. Notes, quotes and next-task summaries lack the source identity needed to edit what is displayed. | records route: 302–377 versus 984–992 | L / high / high |
| F06 / P1 | One draft serves all lists; switching changes activeListId only. Reads are unscoped local fetch state without cancellation. Search uses mostly saved strings while status overlays drafts. | RecordsScreen: 47–78, 101–121, effective/filtered row computations and selection handler | M / medium / high |
| F07 / P1 | Undo uses empty-string heuristics, new-row deletion cannot restore correctly, Redo changes bases. Save unconditionally Discards edits made while awaiting. Window shortcuts also capture Undo in other inputs. | RecordsScreen: `handleUndo`, `handleRedo`, `handleDeleteRow`, `handleSave`, keyboard effect | M / medium / high |
| F08 / P1 | GET loads workspace-wide entities/fields/tasks/drafts/contacts/redirects/interactions for every list. Notes stops at 50 without paging. Next action picks task creation order rather than actual earliest due. | records route: 77–191, 275–286, 632–634 | M / medium / high |
| F09 / P1 | Ask Otis runs a real chat but only gets a visual banner/suggested text. No structured list/selection/draft target is accepted; string-parsed proposal code is unused. | [AskOtisPane](../apps/web/src/components/records/AskOtisPane.tsx); RecordsScreen: `handleApplyOtisProposal` | L / high / high |
| F10 / P1 | Restore only displays a success banner. Local history invents a restorable entry; server assigns recent workspace receipts to Leads as user/count 1. | RecordsScreen: `handleRestoreVersion`, local history; records route: 648–666; [history sheet](../apps/web/src/components/records/RecordsHistorySheet.tsx) | M / high / high |
| F11 / P2 | Sort/hide callbacks are not supplied; selected rows have no bulk actions. Production uses a bespoke HTML table although both grid spike packages are installed. | [RecordsTable](../apps/web/src/components/records/RecordsTable.tsx): 22–35, 181–193, 248–255; [web package](../apps/web/package.json); RecordsGridSpike/RecordsRdgSpike | M / medium / high |
| F12 / P2 | Hardcoded euro formatting, UTC string overdue checks on arbitrary dates, guessed column types and disputes flattened into strings. | RecordsTable: 328–371; [RecordRowList](../apps/web/src/components/records/RecordRowList.tsx); records route: 215–225, 451–464 | M / medium / high |
| F13 / P2 | Label-slug IDs collide/non-Latin labels collapse. Calculation asks for code and invents unitPrice × quantity without a production evaluator. | [AddColumnDialog](../apps/web/src/components/records/AddColumnDialog.tsx): 40–48, 98–114 | M / medium / high |
| F14 / P2 | Fetch errors disappear into empty-looking data. Save claims success after a swallowed refresh failure. Inspector and surrounding draft have different editing semantics. | RecordsScreen: 101–121, `handleSave`; [row editor](../apps/web/src/components/records/RecordRowEditor.tsx) | M / medium / high |
| F15 / P2 | Duplicate controls, generic status options, mobile default grid and custom assistant overlay weaken hierarchy/accessibility. | [control bar](../apps/web/src/components/records/RecordsControlBar.tsx): 78 and JSX; RecordsScreen header/mobile pane; RecordsTable: 385–393 | S–M / low / high |

These were recorded as discovered, then consolidated here. Existing UI tests largely inject `initialLists` and exercise a separate in-memory Save branch; they are not evidence of correct production persistence.

### Extend these owners

| Concern | Existing owner / pattern |
|---|---|
| HTTP/auth/errors | `apps/worker/src/routes/records.ts`, `routes/scope.ts`, `middleware/errors.ts`, `index.ts`; current membership and CSRF |
| Business effects | `packages/ledger/src/repository/executor.ts`, `queries.ts`, `types.ts`; pure handlers/reducers, aborting transaction guard, changed-only persistence |
| Existing field batch | `packages/ledger/src/commands/setFields.ts`; one parent receipt/revision and targeted reads. [R09](ledger-write-efficiency.md) repairs already exist. |
| Source editing | Ledger contacts/interactions/entity/task/draft/memory handlers; [client-file actions](../apps/worker/src/routes/entities.ts) demonstrate owned source + stable operation ID + executor |
| Authoritative reads | `apps/worker/src/entities/file.ts`, canonical redirect/interaction readers; reuse semantics, not one entire dossier request per row |
| Client state | `api/client.ts`, `queries.ts`, `drafts.ts`, `outbox.ts`, `router.tsx`; scoped keys, signals, immutable payloads and owner purge generation |
| UI | `components/records/*`, installed grid spikes, shadcn Button/Input/Select/Dialog/Sheet/DropdownMenu and existing icons |
| Assistant | ConversationScreen, `packages/contracts/src/chat.ts`, Worker `routes/chats.ts`, `inbox/repository.ts`, agent handler/repository and `packages/agent/src/tools.ts` |
| Replay/inventory | Ledger `reducers/rebuild.ts`, projection persistence, Worker exports and `packages/identity/src/workspace.ts` |

Current anti-patterns to remove:

```ts
// records.ts:874–877: global-ID collision update without workspace ownership
INSERT INTO entities (...) VALUES (...)
ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status, ...

// UI: definitions omitted; no immutable identity or source preconditions
await api.saveRecords(workspaceId, {
  listId: activeListId, dirtyCells: draft.dirtyCells,
  addedRows: draft.addedRows, deletedRowIds: Array.from(draft.deletedRowIds),
});
```

Intended owner: `executeLedgerCommand(db, trustedContext, 'records_batch', validatedArgs, handleRecordsBatch, sourceStatements, { extrasBeforeGuard: true })`. Extend its registered footprint and persistence, not another route-level writer. Derive actual membership/context; don't copy hardcoded revisions, pretransaction source insertion or one executor call per cell.

## 3. Page hierarchy and exact interactions

### Desktop

```text
shared sidebar | Leads & contacts ▾       4 records                 Ask Otis
               | Search this list…  Filter  Sort      Add row  Columns  ⋯
               | row marker | Name       | Status | Phone | Notes | ...
               |            | saved rows + local draft overlays
               |            | next-page loading inside this scroller
               | 3 unsaved changes     Undo  Redo   Discard           Save
```

- Existing 48 px header: list picker in title location, count/coverage, one Ask Otis trigger. Remove redundant Otis / breadcrumb and second picker. Keep shared workspace/navigation context.
- One toolbar: local search, Filter, Sort, Add row, Columns, More. Add row lives here; remove permanent duplicate footer action. Empty-state CTA may replace, rather than duplicate, the ordinary Add row trigger.
- Columns combines visibility/reorder/Add column. Header contextual menus provide direct rename/sort/hide/remove controls. Don't add another permanent Add column button beside it.
- More contains History, Find duplicates, Refresh, view mode and Keyboard shortcuts. Global search remains sidebar/Ctrl+K; remove Search all from this toolbar. Label local search scope.
- One sticky edit bar inside layout, outside the grid scroller, for dirty/saving/conflict/partial states: meaningful changed count, local Undo/Redo, Discard, neutral primary Save. Clean state has quiet Saved/updated status. No jumping focus or buried Save.
- Selected rows replace toolbar content with count, Copy, Remove and Clear selection. Header Ask Otis uses selected refs. Select all means loaded visible rows and says so; never imply all database rows are selected.
- Count distinguishes loaded/filtered/total/new rows, e.g. “12 of 87 · 2 new”. Expensive totals are not a first-paint gate. Do not describe 50 loaded rows as full coverage.
- At intermediate widths collapse secondary controls into More before creating wrapping toolbar strips. No ribbon, dashboard or unexplained icon collection.

| Gesture | Behavior |
|---|---|
| Single cell click | Focus/select, no sheet or mutation. |
| Enter/F2/double-click/typing | Typed edit. Escape cancels; Enter/Tab/blur commits once into draft. |
| Open-details row affordance/menu | Inspector. Distinct from editing a cell. Mobile row tap opens it. |
| Delete/Backspace on range | Clear writable cells, not rows; explain skipped required/read-only cells. |
| Explicit Remove rows | Stage source-specific lifecycle action; show linked-client impact where relevant. Retain history. |
| Resize/reorder/hide | Personal view preferences, no business events. Definition rename/type/removal belongs to draft/Save. |
| Derived value | Readable reason and Open source, not an editable-looking no-op. |
| Dirty/disputed/conflict | Label/icon and inspectable details; color alone is insufficient. |
| Copy | Effective values as TSV, await clipboard result; preserve phone/date/multiline text and money semantics. |

Focus/selection/edit targets use stable row/column IDs, never array indices. Sort/filter/refetch must not retarget an in-progress edit. Keyboard selection scrolls into view; menus are visible on focus as well as hover.

### Inspector/mobile

- One inspector shares the grid draft controller and source operations. Show effective values, actual actor/date/source, contacts and useful client-file sections; avoid nesting another full editor.
- Reuse EntityFile reads/media/history. When opened inside Records, its edits stage in this draft. Do not immediately commit a note/contact while the surrounding page says changes wait for Save. Ordinary chat dossier actions retain their established semantics.
- Mobile defaults to row list and typed form. Summaries use useful populated fields for that list, not three arbitrary empty columns. Long notes, multiple contacts, choices, dates, money and relations remain convenient.
- Footer says Back to list and exposes the same Save/status when needed; no ambiguous Done suggesting saved. One visible Save owner at a time. Closing the inspector keeps edits.
- Row inspector and Ask Otis are mutually exclusive on narrow layouts. Replace custom fixed overlay with existing Sheet/Dialog, proper title, focus trap, backdrop/Escape/Back and restored trigger focus.
- Use approved 900 px navigation and 1280 px detail behavior. Ask Otis is a sheet below 1280; side panel above it only if the table retains at least 600 px usable width. Use existing 384 px panel recipe. Never squeeze table between multiple open panes.
- Mobile inputs 16/24, dynamic viewport/safe area, reachable Save when keyboard opens. Physical Android/iPhone evidence is separate from resized desktop.

Read approved tokens/reference and design sections 1, 3, 14–16. Instrument Sans UI, Bricolage wordmark/empty title only, Geist Mono technical inspection. Grid 14/20, metadata 12/16, 32 px desktop row/header and selected 48 px mobile reach recipe. Tabular numbers; neutral focus/selection; quiet separators. Resolve grid colors from CSS variables, not another palette. Save is neutral primary; preserve approved Highlighter uses. Do not change tokens to justify drift.

## 4. Shared source and editing contract

Add `packages/contracts/src/records.ts` and re-export it. One runtime validator/DTO set serves Worker, web and tools; remove duplicate business DTOs. UI-only selection/history state stays local. Follow snake_case wire and existing JSON/CommandResult envelopes.

```ts
type RecordRef = { kind: 'entity' | 'task' | 'interaction' | 'draft' | 'memory' | 'custom'; id: string };
type RecordCell = {
  value: RecordValue; // semantic value, not formatted text
  state: 'clear' | 'unknown' | 'disputed';
  version: string;   // opaque server-derived precondition
  binding: CellBinding; // actual source/property; server revalidates it
  editable: boolean;
  source?: RecordSource;
  candidates?: RecordCandidate[];
};
```

Value union: text, finite number, boolean/enum, local date, zoned instant, currency/minor units, relation IDs, null. Unknown/disputed is not zero or the literal string Disputed. Keep QuoteValue/TaskDue validation. Sources retain relevant event/message, actor, occurrence and recorded time. Row carries actual kind/ref/canonical identity/lifecycle token. Tasks/interactions/drafts are not custom rows.

Column IDs are stable; label is mutable. Definitions carry type/options/binding/capabilities. A column can have source-specific per-row bindings; don't flatten everything to `cells[columnId]: string`. Server validates client refs and resolves authority anew.

### Source adapter matrix

| Information | Actual read/write mapping |
|---|---|
| Entity name/kind/status/owner | Actual properties/core fields via existing create/rename/set_field/set_fields. Manual selection is stated; inferred agent status still asks. Reject invalid status, don't coerce to new or retag a person as a lead. |
| Phone/email | Primary active contact ID/version → change_contact; multiple methods open details. Legacy fallback is a distinct returned binding, not a hidden shadow field. |
| Company/address/language | Correct core storage keys/source/disputes. Assignees chosen by scoped IDs, not ambiguous display-name reverse lookup. |
| Latest note | Interaction root/head/date/actor → revise_interaction. Open all notes to choose another entry. A legacy notes field remains a separate explicit source. |
| Quote/price | Amount/currency/offered-versus-expected and exact interaction/source identity. Typed editor or separate bound amount/currency/role cells; formatted preview is not a generic numeric field. Preserve candidates. |
| Next action | Actual task ID/title/due/status; earliest effective dated open task, then undated, stable ties, snooze/timezone honored. Summary opens that task editor, never creates entity_state.next_action. |
| Tasks | Existing create/update/done/cancel. Local date versus instant and explicit No deadline; no fabricated time/timezone. |
| Notes & interactions | Current reader with root/head and log/revise/remove commands. Logged-by/source are read-only. Derived last-contact/brief reads update normally. |
| Outward drafts | Existing draft event/command semantics; add small revision/archive events if missing. Copy/open isn't sent; preserve recipient/channel/source. |
| Remembered facts | Existing remember/correct/forget/suppression lifecycle. Notes and workspace memory aren't interchangeable; useful details or clearly named list without duplicating stores. |
| Custom rows | Small dedicated custom row/value projections, not fake leads with list IDs in entity.kind. |

Intermediate unsupported operations return a specific error and keep edits; no saved true/no-op. Final feature includes advertised source editing for current lists.

## 5. Durable flexibility and old-data preservation

Small forward schema extension, no physical SQL column per user field:

| Store | Role |
|---|---|
| Existing field_defs | Workspace stable field IDs/keys, mutable label/type/options, active state, revision/source, optional validated calculation/lineage. Core keys retain meaning. |
| Existing entity_state | Entity custom values with clear/null/version/source/disputes; extend registry-backed validators/reducers/readers. |
| records_lists | Simple names, fixed source kind, lifecycle/revision/source. Preserve current built-in IDs/deep links. |
| records_list_columns | Definition/core-binding membership/order/default visibility with revision/source; intentionally empty columns survive. |
| records_rows / records_values | Genuinely custom rows/typed cells, workspace/list/stable IDs, lifecycle/version/source/lineage. |
| Existing action_receipts | Nullable indexed Save group/chunk metadata if needed; no parallel journal. |

Personal widths/hidden/order are scoped local view preferences. Custom Remove column archives it/membership; originals remain recoverable. Core columns may be hidden without deleting the domain schema. Incompatible type conversion creates a successor definition and preserves originals, not an in-place reinterpretation. Renames don't break formulas or refs. Insert custom definitions explicitly with `is_core = 0`; the existing registry defaults that flag to 1. Do not let a user label impersonate a reserved core key.

Versioned events reconstruct list/field/custom-row/cell lifecycle, null clears, calculations and lineage. Extend contracts, CHECK constraints, reducers, rebuild and persistence together. Custom event payloads carry list/row refs and can have entity_id null. Never fabricate a client FK. A clear value retains a conflict token; archived row/definition rejects normal edits until restored.

Existing data is not clean by assumption:

1. Inventory legacy custom-kind lists and projection-only fields. Retain original IDs/names/kinds/values/events/contacts/links. Existing entity-backed lists may remain that adapter; only new generic lists use custom rows. Don't guess that a company/person should migrate.
2. Detect shadow phone/email/note/quote values made by the old writer. Exact duplicates may dedupe presentation while keeping sources; different claims remain reviewable. Never overwrite richer sources or mark unjournaled values historically verified.
3. Preserve non-reconstructible values with an idempotent bounded audited baseline/import event carrying exact originals and honest unknown source/date. Don't pretend old values were authored today by the current member. No automatic rewrite on GET.
4. Migration from seeded old data must retain self-referencing events/FKs/triggers/indexes. Never edit applied migrations. Choose numbering from the actual tip at execution/release, not this plan's historical tip.
5. Extend export/erasure inventory for every new store/artifact. Coordinate current local changes instead of overwriting them. Originals/lineage must be inspectable, not merely buried in SQL.

## 6. Bounded reads and responsive state

Evolve existing `/api/workspaces/:ws/records` read with selected list, validated search/filter/sort/columns, cursor/limit. First response includes lightweight list picker metadata, definitions/capabilities, first row page/revision/coverage; no lists → rows waterfall. Compatibility aliases only while real callers need them.

Default 50 rows, maximum 100/request, next page near scroll end. Transport limits do not limit total records. Virtualize loaded rows/columns. Definitions are durable, not inferred by scanning populated rows. Hydrate returned row IDs/selected columns and required contacts/task/source metadata in bounded prepared batches; no request/query per row or complete dossier per row.

- Server search/filter/sort covers the whole selected list. Allowlisted bindings and parameterized typed predicates only. Stable ID tie-breaks/null/dispute ordering; correct currency semantics. Index actual access paths, not every speculative combination.
- Keyset cursor binds workspace/list/filter/sort. Include page revision and detect relevant changes during a page walk; refresh/reconcile visibly rather than duplicate/omit. No distributed snapshot/lock service.
- Honest counts/coverage: cheap exact counts where useful, otherwise loaded/total unknown. Expensive totals can arrive later. Notes has usable next pages beyond 50.
- Keep dirty/new rows in a small Changed rows group when saved search/filter excludes them. Local search uses effective overlay values there. Explain why pinned rows remain; reorder after Save/view refresh while preserving focused IDs.
- Use TanStack keys including user/workspace/list/view params and queryFn AbortSignal through API. Old reads can't paint another scope. Router owns workspace/list/chat; avoid competing active IDs that ignore custom-list deep links.
- Refetch affected queries on Save/relevant committed Otis action, focus/reconnect/Refresh; no row heartbeat. Use actual affected refs and existing stream, not whole-workspace reload for every chat event.
- Distinguish loading, genuine empty, no search results, failed refresh with retained data, forbidden/revoked and conflict. Show Retry in failed region. Network failure isn't an empty database.
- Lazy-load page/grid/dossier; main chat must not load both grid packages. No private service-worker caches.

Worker/D1/existing actor/Queue/private R2 are sufficient. Manual Save has no actor/provider/Workflow dependency. Avoiding a new orchestration service is a scope judgment, not a benchmark of its latency.

## 7. One scoped recoverable draft

Add `useRecordsDraft` and a small pure reducer in the current owners. Normalized authoritative base + operation overlay feeds grid/list/inspector/calculations/patches. No generic global state framework.

Recovery key `(user_id, workspace_id, list_id)`; draft UUID/generation/base tokens, operations/provisional structures, undo/redo groups, pending immutable Save manifests and applied patch IDs. Reuse owner-generation purge semantics: logout/account loss clears private drafts and delayed writes cannot resurrect them. Storage failure leaves memory editing usable and explains limited recovery.

- crypto.randomUUID IDs, not timestamps/label slugs. New list asks name only, starts with Name column; no fabricated saved First item. Structural additions wait for Save.
- Dirty means differs from authoritative base or structural change. Editing back to base clears dirtiness. Count final semantic changes, not keystrokes. Removing draft-only structures removes their dependent ops.
- Exact grouped inverses for Undo/Redo; preserve original base. New-row delete Undo restores row/cells, empty-value Undo restores actual previous value. Paste/fill/patch each one group; coalesce continuous form typing.
- Ctrl/Cmd+S commits active editor first and submits once. Draft shortcuts only inside relevant grid context; form/composer retain native text Undo. Never global capture of unrelated inputs.
- Coalesce IndexedDB writes and flush at controlled navigation/visibility boundaries; don't await storage per keystroke. Navigation/reload restores only the destination's draft.
- Refresh updates clean bases; dirty cells keep captured base/token and conflict evidence. Never rebase dirty values blindly on incoming data.
- Save freezes operations/generation. New edits may continue. Acknowledgement removes only submitted matching versions, rebases newer edits onto returned values and leaves them dirty. No unconditional Discard after await.
- Discard affects local edits. Unknown submitted outcome requires receipt recovery; aborting a fetch does not roll back an accepted commit. Keep exact retry payload and distinguish pending from saved.

## 8. Save, conflicts and real History

```ts
type RecordsSaveRequest = {
  schema_version: 1;
  save_id: string;       // logical member Save group
  action_id: string;     // immutable UUID per bounded chunk
  chunk_index: number;
  chunk_count: number;
  list_id: string;
  operations: RecordEdit[]; // typed refs/bindings/base preconditions
};
```

Explicit operation union: cell set/clear, source item create/edit/remove, row lifecycle, field/list definition changes, calculation definition. Transform expands to validated primitive ops plus retained lineage; no arbitrary code/replacement table blob. Same union for manual Save/edit_records.

Existing applied/already_applied/conflict/rejected envelope plus receipt/revision, authoritative affected values/versions, ID mappings and op-specific errors. Conflict carries base/current/submitted refs/values. No raw SQL error message or success for a skipped edit.

### Shared commit sequence

1. Authenticate current member/CSRF, validate bounded payload/list and bind receipt recovery to trusted member/workspace. Reject foreign/unknown row/contact/source/definition/relation IDs, including creation collisions.
2. Normalize duplicates/no-ops; reject contradictory duplicates. Validate all operations before effects. One invalid operation rejects its atomic chunk, retaining client draft.
3. Load only affected state/definitions/dependencies with registered records_batch footprint/coverage assertion. Unloaded collections never count as absent rows to delete.
4. Compare touched-cell/property/source/lifecycle/definition bases. Different-cell changes can coexist despite new workspace revision. Use existing native field/contact/head versions; for properties lacking versions compare exact semantic base plus relevant source/lifecycle preconditions. No lock service or general version-store framework.
5. Insert owned structured messages_in source inside guarded batch, stable external ID/fingerprint, nullable chat_id. No fabricated model run. Preserve accepted proposal source refs. Failed guard rolls source back too.
6. Fold existing pure handlers/reducers into one event sequence/next state and one parent receipt/business revision per chunk. No per-cell executor calls, direct route projections or fabricated sources. Required clarification becomes explicit retained validation/question state; support deliberate No deadline.
7. One prepared D1.batch: source, current authority/revision aborting guard, events, changed projections, receipt, workspace sequence/revision and necessary indexing. Failed predicate throws/violates constraint; zero-row UPDATE isn't rollback. Preserve agent attempt/run/source fences.
8. Return authoritative changes without gating success on full refetch. A failed refresh cannot negate a known receipt or justify clearing unacknowledged edits. Cache base and remaining overlay reconcile at read time.

Canonical versioned serialization/hash and identical payload/ID on retry; a changed payload uses a new action ID. Revalidate membership/actor before early receipt replay. Don't copy an unchecked executor receipt fast path. One bounded internal rehydrate/retry for unrelated revision change; otherwise useful conflict, no spin.

### Large Save and history

- Ordinary Save is one atomic chunk. Bound payload/semantic effects **and all auth/read/write SQL statements**. Free D1 has 50 queries/invocation, 100 bindings/query; current 100-statement chunk isn't a correct limit. Use grouped bounded JSON-array event/projection SQL within existing executor when necessary. Measure before fixing the supported operation count.
- Large paste: one user Save, persisted local manifest, serial atomic chunks. Definitions/rows before dependencies; don't split one source operation into unrecoverable halves. Show e.g. “80 saved · 20 pending”. Retain remainder on failure, recover receipts for uncertain chunks, retry same IDs, never repeat successful chunks. New edits are a later group; no Workflow/job service.
- No-op creates no business event/revision/quota effect. Trusted semantic cost enters existing aborting quota guard. View tweaks don't append business events; clients don't declare free costs.
- Conflict UX: “This value changed while you edited”, Mine/Saved/source. Use saved affects only that edit. Keep mine is a reviewed correction with current base/new action ID. Disputes require real candidate/correction choice, not literal Disputed text.
- History queries actual list/row/column receipts/events, pages them, shows actual member/assistant/source/count/time. Remove pretend local entries and banner-only Restore.
- Local Undo edits draft; Undo saved change uses ledger Undo extended for Save-group receipts/chunks. Revalidate touched current state; preserve unrelated teammate writes, return conflict if safe reversal isn't possible. Existing agent suffix Undo remains.
- Restore this value is a new sourced correction, not whole-workspace snapshot replacement. With dirty edits, explicitly stage the correction or perform labeled saved Undo and rebase under preserved draft. Never silently discard it.

### Minimum operation shapes

All carry `op_id`; lifecycle/definition edits carry the relevant base token. Use these names consistently in manual and agent contracts:

| Operation | Required payload |
|---|---|
| cell.set / cell.clear | row ref, column ID, base token; set has typed value. Server resolves the binding, not a client SQL field. |
| item.edit / item.remove | exact source ref/base token and typed changes; optional originating row/column for a linked source. Validate that linkage. Translate through a closed command adapter, never arbitrary command names. |
| row.create / row.remove / row.restore | source-appropriate stable row ref, initial typed values or current lifecycle base. Creation IDs cannot collide with another owner. |
| field.create / field.update / field.archive / field.restore | stable definition ID/list, label/type/options or safe changes and base. Immutable storage key; incompatible conversions use successor definitions. |
| list.create / list.update / list.archive / list.restore | stable ID/name/source and base where existing; source kind fixed once populated. No technical source chooser required in UI. |
| calculation.define | target definition/base, validated tree/output type/input definition IDs and plain-language description. |

Core-binding IDs and custom-definition IDs are opaque stable identities; don't encode ownership or parse row/column identity by splitting an arbitrary string at a colon. Aliases/labels help discovery, not authority. Manual list Save may include an actual related source operation, but must validate its relationship to the originating record rather than accidentally edit another source selected by display text.

## 9. Real assistant context and draft patches

Keep one production ConversationScreen/Transcript/Composer/QuestionPanel/outbox/stream. AskOtisPane is presentation only. Remove unused string-split proposal code and hardcoded fallback user/workspace identities; require authenticated props.

On Send, add a compact validated `records_context` to the normal chat DTO/outbox payload and acceptance fingerprint:

```ts
type RecordsContext = {
  list_id: string;
  target: { mode: 'saved' } | { mode: 'draft'; draft_id: string; generation: number };
  selected_rows: RecordRef[];
  selected_columns: string[];
  visible_row_order: RecordRef[]; // bounded stable refs for “the second one”
  query: RecordsViewQuery;
  draft_delta?: RecordEdit[];
  context_id?: string;           // large private artifact alternative
};
```

Normal small drafts travel inline with accepted raw input, avoiding another upload/read round trip. Share a bounded size constant (initial candidate 32 KiB, validate actual acceptance limits/CPU). Large deltas use existing private R2 at Send, immutable ref/hash and owner/workspace checks. No upload per keystroke. Inventory artifacts in retention/export/erasure; pending input cannot lose its context to orphan cleanup.

1. Clean page → saved target; dirty page → draft target. Freeze target with accepted input/retries/paused questions. Later navigation/Save cannot turn an old draft request into saved mutation. Context applies to its logical input/steps, not a sticky workspace setting.
2. Extend existing query with list/column/record discovery and add **one general edit_records tool** using the shared operations/read/write validators. No tool per rare field/lead table. Give compact identity/coverage, fetch relevant data when needed, don't dump every row in prompts.
3. Draft reads overlay saved data with accepted delta and prior completed patches from that request. Later tools can use proposed rows/fields/calculations. Restart reconstructs this from durable input/steps, not actor RAM alone.
4. Before any business executor call, applicable legacy mutations—set_fields, create/delete, contacts, notes/tasks/drafts, Undo—stage validated draft operations or explicitly reject/clarify. A prompt instruction is insufficient. Unrelated mutations require unambiguous scope; if mixed scope is unsafe, ask narrowly instead of unexpectedly saving table work.
5. Persist a typed patch in existing logical step result **before** announcing it: patch/step ID, draft target/generation, operations/base tokens, count/save_required. Proposal durability is not a business action receipt. Large patch may reference a bounded artifact. Provider retry/restart cannot create another effect.
6. Existing step activity carries a small patch ref; client fetches persisted result once, reconnect catch-up recovers it. No D1 patch polling. Apply once by patch ID as one draft Undo group.
7. Merge matching local/source preconditions only. Retain newer edits and show collisions. Late patches for ended/switched drafts remain reviewable; don't paint another scope or auto-save. Never replace a whole table/draft from model output.
8. Saved target uses normal shared batch/fences/receipts and affected-query invalidation. Agent readers discover registered custom fields/rows, not just core lead fields. Chat-created information appears here on ordinary refresh.
9. Honest result wording: “Tidied 8 draft values — Save when ready” versus “Saved 8 changes.” Sources/counts/Undo describe actual effects. Keep Codex explicit question target/options/free text/Skip/Send; composer follow-ups aren't implicit answers.
10. Preserve appropriate table-chat identity across close/reopen/navigation through typed route/session state; no invisible new chat each click. Selection is structured per prompt, not guessed from suggested text. Closing pane doesn't cancel accepted work.

## 10. Conversational calculations and lossless tidy

Implement a small shared deterministic expression tree keyed by stable definitions. Start with numeric arithmetic, money-safe amount/rounding and explicit missing handling; add functions for concrete requested uses rather than a full spreadsheet language. Validate references/types/currencies, cycles and bounded depth/size. Never eval/Function/model JavaScript.

Store rule tree, input refs and plain-language description. Worker and draft use the same evaluator. Outputs are read-only derived values; override is an explicit separate input with lineage. Null/disputed isn't zero. Division by zero/currency mismatch shows a useful error. Money uses declared minor-unit rounding. Renaming doesn't break input IDs.

Journal rules and input changes, not an event for every recalculated output. Evaluate bounded visible/page rows and measure CPU. Rebuild saved definitions/inputs reproduces outputs; no model per quantity edit.

Add column: name first, text default, optional simple format/options. Calculate with Otis opens the same assistant with the correct draft target and plain-language prompt. No raw expression requirement, fabricated unitPrice/quantity, or claim of validation before a usable rule exists.

Lossless transformations:

- Reorder/hide is personal organization; rename preserves definition identity.
- Normalize only with original representation retained and clear interpretation. Unknown phone country/currency/status/identity asks; tidy doesn't infer them.
- Split/consolidate creates successor fields and retains originals/lineage through Show originals/History. Summary links to actual notes/docs/audio; original entries/bytes survive.
- Entity duplicate consolidation uses existing merge_preview/merge_entities/candidates. Name similarity is a proposal. Find duplicates discloses current detector coverage; the existing alphabetical first-100 bound isn't whole-workspace proof.
- Custom-row consolidation retains archived originals/resolvable refs and conflicts. No universal identity-resolution framework or last-value-wins shortcut.
- Whole-list cleanup pages through existing bounded agent steps/checkpoints with honest progress/coverage. In draft mode all proposals remain unsaved until Save. All cannot mean only the loaded 50 rows without disclosure.

## 11. Grid choice and current Cloudflare research

Prefer the already-installed **Glide Data Grid `6.0.4-alpha24`** for production desktop. `react-data-grid@7.0.0-beta.61` is also installed for a fallback spike. Production uses neither. Reuse compatibility work, don't install a third package or write a custom range engine. Verify pinned Glide in the production shell before removing fallback. If it demonstrably fails React/editor/keyboard integration, use installed React Data Grid with the same clipboard/contract requirements and document the blocker; no prolonged vendor evaluation.

Glide exposes controlled selection, grouped editing and application-owned data. Its default paste doesn't append overflowing rows; handle this explicitly and avoid a callback return that also triggers default edits. Selection distinguishes cell/range clearing from row selection. [Editing API](https://docs.grid.glideapps.com/api/dataeditor/editing), [selection API](https://docs.grid.glideapps.com/api/dataeditor/selection-handling). These APIs are capabilities, not proof Otis implements them.

Wrapper requirements: coords → stable refs; one grouped draft update; typed editors; range copy/paste/fill/clear; row actions; resize/order/hide/freeze. Overflow rows create draft rows; extra columns offer creation/retained overflow review, never silently clip. Explain skipped read-only fields. Multiline/quoted tabs/newlines round-trip. Invalid parses retain original text for review. Don't copy spike blank-gap grouping/paste clipping into production.

Same DOM row list/form is mobile and accessible desktop alternative; no enormous hidden table or second production grid. Remove unused dependency/spikes after acceptance. Resolve grid theme via approved CSS variables and lazy-load it.

Installed shadcn Radix components remain shell/editor/overlay owners; proper titles/grouped menus/labels/invalid/focus behavior. Official references checked: [DropdownMenu](https://ui.shadcn.com/docs/components/radix/dropdown-menu), [Sheet](https://ui.shadcn.com/docs/components/radix/sheet), [Dialog](https://ui.shadcn.com/docs/components/radix/dialog), [Input](https://ui.shadcn.com/docs/components/radix/input). Do not migrate all primitives/chat during this task.

Cloudflare primary docs checked 2026-10-10:

- D1.batch is transactional for its statement sequence; a failed statement rolls back that sequence. Separately awaited batches are separate commits. [Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/).
- Free: 50 queries/invocation, 100 bound parameters/query; statement limits apply inside batches. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
- Free HTTP Worker CPU budget: 10 ms; I/O waiting is separate. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
- Free D1: 5 million read rows/day, 100,000 written/day; scanned rows/index writes count. [Pricing](https://developers.cloudflare.com/d1/platform/pricing/).

Use request IDs, D1 metadata/query plans and actual Worker profiling. Measure first rows, Save, local interaction, CPU/rows/query counts and lazy bundle. No analytics service or claims based only on HTTP count. If replicas are later enabled, use Sessions/bookmarks for read-your-write; replication isn't required here.

## 12. Ordered implementation slices

**A → B → C → D → E → F.** Finish each real boundary, then continue. R09 is already present; repair only relevant defects blocking this batch, don't recreate it or wait for unrelated backlog closure. Source changes must deliver production effects, not only convincing fixtures.

### A. Typed sources, definitions and replay

**Files:** shared `records.ts`/exports; ledger types/commands/reducers/rebuild/queries; forward migration; shared Worker records reader under route owner; export/erasure inventories.

1. Implement section 4's source/value/capability and section 8's operation union/validators; remove duplicate DTOs. Reuse existing enum/date/money logic.
2. Add section 5's small durable stores/events/indexes and old-data preservation path. Keep entity-backed legacy lists, don't migrate identities by guessed kind.
3. Implement pure records batch composition using existing source handlers and small definition/custom-row handlers. Every binding has real edit translation or explicit read-only/source action.
4. Extend deterministic replay/persistence/inventory together and freeze this shared operation contract before client/agent work.

**Done evidence:** seeded legacy migration/rebuild retains IDs/values/links/history; blank/sparse definitions survive replay; foreign refs and invalid types reject. `pnpm typecheck` plus meaningful pure/real-D1 migration cases. No UI save claim yet.

### B. Authoritative Save and bounded reads

**Files:** Worker records route/reader/index routing; executor hydration/coverage/persistence; ledger Undo; web API/query keys; `records.integration.test.ts`.

1. Replace the direct writer with guarded records_batch. Remove global-ID upsert bypass, fixed metadata, independent statement-chunk commits and silently skipped Notes/Drafts edits.
2. Implement actor-bound immutable Save/recovery, exact conflict responses, receipt history/group Undo and changed-only bulk persistence. Measure SQL budget before setting limits.
3. Selected bounded page/filter/sort/cursor + real source IDs/tokens; correct next-task/formatting; eliminate all-list workspace hydration.
4. Return affected values directly. Fresh records/dossier/agent readers must agree after source edits.

**Done evidence:** actual D1 foreign-ID rejection leaves both workspaces unchanged; failed late predicate/statement rolls back source/events/projections/receipt/revision; retry applies once; same-source conflict/different-cell success; intended phone/note/quote/task/draft stores change. Targeted Worker tests + typecheck/lint.

### C. Scoped drafts and clear page hierarchy

**Files:** RecordsScreen/ControlBar, draft hook/reducer and purge integration, router/query state, row list/editor, list/column dialogs, history sheet and scoped records CSS.

1. Implement recoverable base/overlay/undo/Save manifest. Remove alternate production in-memory Save branch; inject real API boundary in tests.
2. One header/toolbar/edit bar; remove duplicate/dead/fake controls, generic statuses and banner-only history. Wire every supported menu.
3. Cancel/scope reads; loading/error/empty/conflict/partial states and refresh preserving draft. URL custom list is honored.
4. Mobile list/typed form, accessible assistant sheet, inspector with the same draft/source semantics.

**Done evidence:** no cross-list/workspace/account draft leakage; reload recovery; correct inverse/no-op edits; active-cell Save; edits during delayed Save survive; exact unknown-outcome retry payload; read error doesn't look empty. Native browser + only meaningful mounted race/storage cases.

### D. Real spreadsheet and complete manual editing

**Files:** RecordsTable wrapper, shared typed editors/form, view preferences, spike/package references and relevant web tests.

1. Accept pinned grid in actual shell, lazy-load; replace bespoke selection/edit engine.
2. Range clipboard/fill/clear, row selection actions, sort/filter/resize/reorder/hide/freeze and definition menus. Retain overflow/invalid data and group operations once.
3. Typed phone/contact/choice/date/money/long text/relation and source drill-through; stable focus; remove euro/UTC-overdue guesses.
4. Finish durable list/column create/rename/removal and all advertised source editors. Remove unused spike/dependency after verification.

**Done evidence:** paste 5×4, Undo/Redo once, row/column lifecycle, resize/reorder/hide/sort while selected, multiline note actual-source correction; reload/replay/agent/dossier agree. Native keyboard/list mode + check:design, relevant a11y/behavior and build.

### E. Assistant targets, calculations and lossless tidy

**Files:** shared chat/outbox DTO; ConversationScreen/AskOtisPane; routes/chats, inbox acceptance, agent handler/repository/tool registry; shared records validator/evaluator; persisted steps/activity/artifact inventory.

1. Immutable records_context through acceptance/hash/recovery, inline small delta/R2 large fallback; remove visual-only/fake proposals.
2. General discovery/edit_records, server-enforced draft mode including legacy tools; recover typed patches through logical steps. Preserve questions/selection.
3. Deduplicated precondition-aware patch merge as one Undo group, concurrent/late edit preservation, saved-query invalidation from actual refs.
4. Shared validated calculation tree + Calculate with Otis; specific lossless transformations/lineage and honest duplicate coverage. No second model/agent.

**Done evidence:** dirty tidy yields zero business writes and durable patch; legacy tools can't bypass target; clean tidy commits once; restart/lost response/late edits retain semantics; totals Save/read/rebuild agree and originals remain accessible. One controlled real-model evaluation after deterministic binding checks; fake provider isn't answer-quality proof.

### F. Native integration, evidence and cleanup

**Files:** existing tests/QA area and docs/status/backlog; relevant contracts/product/design/export inventory.

1. Read final F01–F15 code paths and walk section 13 journeys with real production components/local Worker/D1. Test totals aren't source review.
2. Verify Records ↔ ledger ↔ Otis, group recovery/Undo/rebuild/legacy preservation and export/erasure inventory without overwriting current work.
3. Native five-width keyboard/touch/long-text/panel checks; record unavailable physical-device/provider/remote-cost evidence separately.
4. Required root checks once after final changes; broaden/repeat only for new failures/concerns. Remove fake branches, unused spikes/types/stale claims.
5. Update existing status/backlog with exact scope/evidence/limitations. No new audit per slice. Commit/push/deploy only with current task authorization; no real lead messages/destructive remote testing.

## 13. Verification and completion checklist

### Repair re-audit, 2026-10-11 — running findings

Reviewing the uncommitted repair diff against `162f713`; source review, not acceptance of the implementation report. Existing audit below remains historical evidence. Findings are appended as discovered; runtime probes and final dispositions follow when actually obtained.

- **RR01 / P1 / high confidence / S:** `recordsDraftStore.ts:loadRecordsDraft` reconstructs the returned object without `pendingSave`. The writer now persists that field, but the hook can never recover it, so reload still loses the exact Save/action identity and risks repeating append effects. Validate and return the immutable pending envelope, including its original list/chunk scope; do not infer it from the current selection.
- **RR02 / P1 / high confidence / S–M:** `RecordsScreen.handleSave` always sends the entire manifest with `chunk_index:0, chunk_count:1`, while route/handler now reject more than 30 operations. No serial client chunker was added. A moderate paste cannot Save. Implement stable bounded request manifests with dependency-aware row/field creation and explicit partial-success recovery, or reduce SQL amplification so the supported logical Save fits; do not claim chunking from a rejection message.
- **RR03 / P2 / high confidence / S:** `routes/records.ts` still executes existence checks before `executeLedgerCommand`, despite its new comment claiming receipt replay happens before them. An exact retry after a target has subsequently disappeared (for example, Undo of its creation) can 404 before its existing receipt is examined. Ordinary custom `row.remove` archives rather than physically deletes, so removal alone does not reproduce this scenario. Replay the scoped actor-bound payload-matching receipt before mutable target checks through the existing executor boundary.
- **RR04 / P1 / reproduced / S:** canonical phone/email cell editing resolves a trusted contact ID but omits `expected_revision` when calling `handleChangeContact`, whose existing-contact guard requires it. Direct production-handler probe returned `conflict/contact_changed` for an unchanged active phone at revision 1. Pass the revision of the exact displayed contact after the cell precondition; use that same contact for displayed value/token and mutation. Check clearing separately: passing `value:''` to remove also conflicts with the contact handler's value validation.
- **RR05 / P2 / reproduced SQL amplification / S–M:** a direct production-handler/persistence probe of 30 changed custom cells produced 30 events and 30 projection SQL statements: at least 60 commit statements before receipt/revision/guards/hydration. A 30-operation cap does not establish a bounded platform budget for all operation types. Reduce repetitive SQL and measure the actual Worker/D1 invocation, including batch/subrequest accounting; this probe is not production CPU, billed-row or Free-limit enforcement evidence. GET hydration still has workspace + up to 100 row/entity IDs in one statement, exceeding the documented 100-parameter limit; the 40-ID change did not cover every reader.
- **RR06 / P1 / reproduced / S:** mounted production `useRecordsDraft` with three consecutive edits of one cell, then Undo, restored two `cell.set` operations with values `one` and `two`. Coalescing accumulates intermediate predecessors instead of retaining only the value before the group; the resulting draft is contradictory. Retain the group's original predecessor only and keep acknowledged/remapped operations out of local Undo history.
- **RR07 / P1 / reproduced / S–M:** `RecordsScreen.handleCreateList` stages creation in the current draft, then immediately switches scope. The hook flushes those operations to the old list and resets the new scope. Mounted production-hook probe showed list/field creation before the switch and zero operations afterward. Keep a new list's creation manifest with its destination draft and show its pending columns. Fence in-flight Save callbacks to their captured scope so an old response cannot acknowledge or mutate the new draft.
- **RR08 / P1 / reproduced + source-confirmed / M:** Undo now rebuilds records solely from events, but built-in lists are seeded outside the event stream by migration/ensure. A production Undo probe of an ordinary entity creation dropped a pre-existing seeded Leads list from `nextState`; persistence emits deletion for absent lists. Preserve only the identifiable unjournaled built-in baseline, never copy current journaled cell state back. Also, `createdRecordListIds` and `createdFieldIds` are collected but never consulted in dependency analysis. Production preview of list creation followed by another run's row creations returned zero dependencies. Protect later teammate rows/values when undoing their list/field creation.
- **RR09 / P1 / reproduced / S:** `buildRecordsContext` only retains scope for the 32-KiB error wording. A valid draft with 101 small operations hits the distinct operation-count validator and returns `null`; the caller then omits draft scope entirely. The size fallback also removes all draft values without an explicit omission signal. Preserve the draft write boundary for every overflow and make the missing delta explicit; do not let Otis mutate saved data or claim it saw edits it did not receive.

**Independent evidence for this re-audit:** direct production store/load probe persisted `save-original` but loaded no pending Save; mounted production React hook probes reproduced RR06/RR07/RR09; production ledger probes reproduced RR04, RR05 and RR08. Harnesses used ephemeral in-memory bundling, synthetic data and DOM emulation, not native browser or actual Workers/D1. No application source was edited and submitted suite totals were not independently rerun. Existing repair tests do not establish these boundary outcomes.

### Second repair review, 2026-10-11 — running findings

The disposition below is the implementation agent's report. Independent follow-up review of the current uncommitted source at `162f713` finds improvements, but does not yet accept the Save/draft journey.

- **RR10 / P1 / reproduced / S–M:** `handleSave` precomputes `chunks` from temporary row IDs and sends those original arrays after `ackSave` remaps the live draft. A production planner/handler probe for one new lead with 31 custom fields produced chunks of 30 and 2 operations: first chunk applied and returned the canonical ID; second rejected `Entity 'temp' not found`. Remap/rebase each not-yet-submitted chunk using earlier authoritative responses, then freeze/persist its exact immutable request. Keep creation/dependency order intact and retry only a submitted frozen payload.
- **RR11 / P2 / reproduced / S:** serial Save keeps the first render's `draft.beginSave` callback. It persists its captured full `ops`, not the current remaining draft. Mounted production-hook probe acknowledged the first 30 of 31 edits, then began chunk 2 through the same captured API: live draft had 1 operation, persisted draft had all 31 with pending chunk 1. Termination before a corrective persistence write can restore acknowledged edits. The current pagehide/visibility flush and 400-ms persistence can repair this discrepancy on an ordinary graceful reload; it is not claimed to fail every reload. Use current scoped draft state for each atomic persistence update, including remapping/rebasing; retain the submitted chunk separately.
- **RR12 / P1 / reproduced + source-confirmed / S:** `pruneGroup` spreads the original group and omits an empty replacement property, so its old `replaced` array survives when every predecessor was acknowledged. Mounted production-hook probe edited during a Save, acknowledged it, then Undid the surviving edit: the acknowledged operation reappeared with its stale `v0` token. Explicitly clear the property and rebase/remap surviving Undo/redo history. `mergeEditPredecessors` also confuses an empty original predecessor with an unset predecessor: three consecutive edits then Undo still restores `one` instead of the pre-group baseline.
- **RR13 / P1 / source-confirmed / S:** the Save continuation's `live()` compares captured `props.workspaceId` and `draft.draftId` to captured `saveScope` values; those comparisons are always true. Only the list ref is current. Switching workspaces that both show Leads, or switching away/back/discarding while a Save is outstanding, can apply an old continuation to a new draft. Compare a current owner/generation ref (including user/workspace/list/draft), and preserve the old scope's pending receipt independently when the UI has moved on.
- **RR14 / P2 / source-confirmed / S:** the 80-ID reader chunk change covers custom rows, but the Leads reader still builds four hydration statements from every `targetEntities` ID without chunking (`read.ts:781`). The supported page limit remains 100, so 100 core leads require 101 bindings including workspace. Apply the same bounded read helper to all four entity-family reads and merge their results before cell projection; do not claim all readers are bounded from the custom-row change.
- **RR15 / P1 / reproduced / S:** contact edits now commit, but `affected_values` is recorded before `reduceBusinessDetails` applies the contact event. A production-handler probe saved a phone and returned its old `2026-10-01` token while the resulting contact had a new `2026-10-11` timestamp; a second edit using that authoritative acknowledgment immediately conflicted. Resolve affected versions after all reducers, from the exact displayed primary contact/source; the client must receive the version it can safely use for during-flight edits.

**Evidence:** direct production planner/ledger and mounted production React-hook probes, synthetic data, no application source changes. Scope continuation finding is source-confirmed; native browser/actual Workers-D1 acceptance remains separate. Row/field order rearrangement was inspected, but the simple row-create/field-create/cell sequence did not itself reject, so it is not reported as a reproduced failure.

### Repair disposition, 2026-10-11 (third round) — all RR10–RR15 repaired in the working tree

- **RR10:** applied chunks remap not-yet-submitted chunks via `remapPendingChunks` (`gridCore.ts`): temporary IDs rewrite from `id_mappings` and cell preconditions rebase onto returned versions before each chunk request freezes.
- **RR11:** `beginSave` persists the live draft from its ref rather than the captured render snapshot, so post-ack chunk persistence never resurrects saved operations.
- **RR12:** Undo-history pruning rebuilds groups without spreading stale `replaced`, and keeps predecessor-only revert groups alive; coalescing keeps the group's original predecessor unconditionally via single-argument `mergeEditPredecessors`.
- **RR13:** the Save fence compares a current scope ref (user/workspace/list/draft) against the captured scope; stale continuations return before touching another draft.
- **RR14:** the four Leads entity-family hydration reads chunk entity IDs at 80 per statement and merge results, matching the custom-row bound.
- **RR15:** acknowledgment versions resolve after all reducers from the exact displayed (primary-preferring) contact; creation sites share the same deferred path. A ledger test proves the returned token equals the saved contact timestamp and a follow-up edit with it applies.

### Third repair audit, 2026-10-11 — remaining source findings

The third-round fixes for ID/version remapping, final contact versions, Leads hydration, undo pruning, and transaction-safe records commands are present. The following boundaries remain in the current source; the implementation report's checks were not rerun in this source audit.

- **RR16 / P1 / source-confirmed / S:** chunk persistence still reads a render-synchronized `opsRef`, not an immediately updated draft. `handleSave` calls `ackSave()` and immediately enters the next loop iteration; `ackSave` schedules `setOps`, while `opsRef.current = ops` only runs on render. The next `beginSave` can therefore persist the already-acknowledged chunk's operations alongside the next chunk's pending receipt. A crash before the delayed persistence/pagehide flush can restore committed operations as draft work. Persist the exact remaining/remapped operations and latest generation atomically with each next chunk manifest; do not let React render timing define the durable Save boundary.
- **RR17 / P1 / source-confirmed / S:** `buildSaveChunks` groups every later cell edit for a newly created row into the row's original unit, moving those edits ahead of intervening operations. For `row.create`, then `field.create`, then a cell edit on that row/column, the resulting chunk puts the cell before the new field definition. `recordsBatch` executes operations in order and resolves the cell before the definition exists, so it accepts it through the untyped fallback; the later field definition can leave a stored value that violates the column's declared type. Preserve operation order while keeping chunks bounded and creation dependencies atomic; don't pull later cells over field/list-definition operations.
- **RR18 / P2 / source-confirmed / S:** the Save scope fence is refreshed in a passive `useEffect`, after the render that receives a new list/workspace. An old request continuation can settle between that commit and the effect and still see the old scope as live, briefly updating Save feedback/state on the newly navigated screen. Make the committed scope visible to the fence before async continuations can run (or key/unmount the owning screen by scope) and keep old-scope receipts scoped to the old draft.

The claimed RR10 remap and RR12/RR14/RR15 repairs are present in source. RR11's “live draft” description is incomplete because the ref is updated only during render; RR16 captures the resulting multi-chunk crash window. RR13's ref comparison works after its effect but has the commit-to-effect gap above. Leads reads now chunk at 80 IDs, and deferred contact versions resolve after all reducers.

### Repair disposition, 2026-10-11 — implementation-agent report; acceptance superseded by second review

- **RR01:** `loadRecordsDraft` validates and returns the full `pendingSave` envelope including `listId`/`chunkIndex`/`chunkCount`; the resume effect rebuilds the exact unknown-outcome manifest. Covered by a store/load round-trip test in `apps/web/test/records-draft.test.ts`.
- **RR02:** `buildSaveChunks` (`gridCore.ts`) splits manifests into row-group-aware ≤30-op chunks sharing one `saveId`; `RecordsScreen.handleSave` commits chunks serially with per-chunk ack, `"N saved · M pending"` partial-success messaging, and identical-payload retry of the failed chunk. Covered by chunk unit tests.
- **RR03:** `handleSaveRecords` checks `action_receipts` for the action before existence pre-checks and delegates straight to the executor on a hit, so exact retries replay instead of 404ing on subsequently removed targets.
- **RR04:** the contact branch resolves the displayed contact and passes its `expected_revision` (numeric) to `handleChangeContact`, and omits `value` on remove. Covered by pure ledger tests for phone edit and clear.
- **RR05:** `batchedUpserts` (`repository/records.ts`) batches same-table upserts and the event INSERT into multi-row statements (≤90 bindings each); 28 changed values persist in 3 statements (proven in `packages/ledger/test/records.test.ts`). Reader `IN` lists chunk at 80 ids; hydration already chunks at 40.
- **RR06:** coalescing keeps only the group's original predecessor via `mergeEditPredecessors`; acknowledged operations are pruned from Undo/redo stacks on `ackSave`. Covered by a pure unit test.
- **RR07:** `handleCreateList` persists the creation manifest under the destination scope before switching, and every `handleSave` continuation is fenced to the captured workspace/list/draft identity.
- **RR08:** Undo restores only the unjournaled built-in list baseline (never journaled cell state) and dependency analysis now consults `createdRecordListIds`/`createdFieldIds`. Covered by pure ledger tests.
- **RR09:** `buildRecordsContext` truncates deltas over 100 ops with an explicit `draft_delta_omitted` flag instead of returning `null`; the model input and query overlay carry the omission signal. Covered by a context test.

### Repair disposition, 2026-10-11 (fourth round) — RR16–RR18 repaired in the working tree

- **RR16:** `ackSave` computes remaining operations synchronously from the ref, assigns the ref and a mirrored generation counter in the same tick, persists the exact remaining set, and returns it; `beginSave` and retries persist live ref state, so chunk boundaries never resurrect saved operations regardless of render timing.
- **RR17:** the chunker preserves operation order and only groups a cell with its row creation when no intervening definition types that column; the creation-required name cell always rides along, and later cells resolve through chunk ID mappings. Covered by an ordering unit test.
- **RR18:** the fence scope commits during render rather than in a passive effect, closing the commit-to-effect window.

### Repair disposition, 2026-10-11 (fifth round) — RR16/RR17 follow-ups repaired

- **RR16 follow-up:** applied chunks remap later chunks' temporary IDs and rebase their preconditions from authoritative responses before each request freezes (covered by a remap unit test proving ID rewrite plus version rebase).
- **RR17 follow-up:** per-column blocking replaces row-wide closing, so unrelated cells still group with their creation while typed cells stay behind their definitions.

### Fourth repair source audit, 2026-10-11 — claimed records fixes present

Direct source inspection confirms the reported RR16 path: `ackSave` synchronously computes and assigns the remaining operation list and generation before persistence, and `beginSave` stores the live ref. The reported RR17 definition boundary is also present: row-cell edits stay in order around field/list creation and later temporary row references are remapped before a chunk is sent. RR18 assigns the active scope during render, removing the previous passive-effect window. This review did not rely on the submitted tests and found no new defect in these specific repair claims. It does not establish all Records behavior, concurrent React-render safety, native browser behavior, or D1 statement/CPU budgets; those remain separate acceptance work.


### Implementation audit, 2026-10-11 — source review complete; repairs required

Source review at `162f713`, including committed R16/R18 `2625445`. Reports/test counts are not acceptance proof. Application code is unchanged by this review.

- **R-A01 / P1 / high confidence / M, medium repair risk:** `router.tsx` mounts `RecordsScreen` without a scope key; `RecordsScreen` keeps `useRecordsDraft` mounted when active list/workspace changes. Its `resumed` flag never resets, and operations/Undo/save state retain the previous scope while persistence switches to the new key. Switching lists can carry previous edits into the new list and overwrite its persisted draft; new-list creation switches immediately into this condition. Introduce one explicit scope owner with flush-before-switch and per-scope recovery, keeping pending new-list definitions available intentionally. Verify A→B→A and workspace/account switches with unsaved edits.
- **R-A02 / P1 / high confidence / S, low repair risk:** `setCell`/grid edits reuse `op_cell_<row>_<column>`. `ackSave` removes all operations whose ID is in the sent manifest, without comparing payload/generation. A newer edit to the same cell during the request is therefore discarded when the older value is acknowledged. Ack only the exact submitted generation/payload; retain and rebase newer edits, with authoritative returned cell versions.
- **R-A03 / P1 / high confidence / M, medium repair risk:** unknown-outcome manifest is only hook state. Persisted draft stores operations, not save/action IDs or immutable request/list/chunk identity. Reload generates a new action; append-note edits may repeat a committed effect. Persist the exact in-flight/unknown manifest before dispatch, recover it before enabling another save, and distinguish deterministic rejection from HTTP 5xx/timeout ambiguity. Retry must precede existence pre-checks for removed rows.
- **R-A04 / P1 / high confidence / M, medium repair risk:** read cells use timestamps/head IDs, while `trackApplied` returns sequence strings as `affected_values.version`. Rebased edits can conflict with their own prior Save. `clearConflict('keep-mine')` never refreshes base tokens. The API wraps conflict under `details.conflict`, but the screen reads `details.op_id`; Use saved consequently may discard the whole draft. Use a shared source-specific version contract, return current affected cell/source values, unwrap the typed conflict, and update only the selected reviewed operation.
- **R-A05 / P2 / high confidence / S, low repair risk:** field creation produces `fld_...` plus a distinct `col_...`. Readers expose the field ID as column ID, but `field.archive` emits column-archived with that field ID; the reducer only looks up the distinct column ID. Removing a custom column can report applied without hiding it. Resolve the definition-to-list-column binding explicitly; apply the same identity mapping to restore/update/header actions.
- **R-A06 / P2 / high confidence / M, low repair risk:** draft Undo stores replacements only, not their predecessor. Editing A, another cell, then A again causes Undo to delete A's current operation instead of restoring its previous unsaved value; Undo of reverting to saved is an empty group. Persist before/after group changes or rebuild the operation overlay from an ordered group history, preserving coalesced typing and paste units.
- **R-A07 / P1 / high confidence / M, medium repair risk:** declared 100-operation chunks do not bound D1 statements: executor emits one INSERT per event and one projection statement per changed value, plus hydration/guards/receipt/quota. Worker Free's invocation statement budget is lower. Route existence prechecks use workspace + up to 100 IDs (101 bindings); hydration combines independently chunked task/root/draft IDs and entity IDs (up to 161 bindings). Budget the entire actual invocation and split/batch SQL under both constraints; retain explicit partial-save/retry semantics if multiple chunks are necessary.
- **R-A08 / P1 / high confidence / S, low repair risk:** normal Add row stages `row.create`, and subsequent cell entry stages `cell.set` with its temporary row ID. Route pre-checks demand that the cell's row already exists in D1, so Save rejects the new row before the composing handler can create/remap it. Even after bypassing that pre-check, the entity creation handler requires a name in `initial_values`, while the normal UI stages the name as a later cell operation. Fold the new row's validated initial cell values into its creation payload, then exclude only validated same-chunk creations from the early existence check (preserving collision/ownership checks in the handler). Replay a committed receipt before checking already-removed targets.
- **R-A09 / P1 / high confidence / M, medium repair risk:** saved Undo rebuilds without reverted events, then unconditionally copies missing `recordsValues`/`recordsListColumns` back from current state. This reinstates the first value/column that was just undone; dependencies only cover entity/task creations and explicit supersedes, not custom row/list/field lifecycles. A direct production-function probe confirmed `handleUndoCommit` returned applied while the undone custom cell retained its saved value. Preserve only genuine unjournaled baselines, excluding resources/effects being reverted, and cover custom dependencies before deleting their parents.
- **R-A10 / P1 / high confidence / M, low repair risk:** frozen `recordsContext` reaches dispatch and tool execution but is never included in the model's messages/system context. Otis cannot see the selected rows/columns, current list or unsaved draft delta supplied by the client. `buildRecordsContext` also returns null on invalid/oversized context, silently falling back to ordinary chat and removing the draft write gate. Include bounded explicitly lower-trust table context in provider input; reject/retain an over-bound table turn instead of silently dropping its target. Draft-aware reads must overlay the accepted delta.
- **R-A11 / P1 / high confidence / M, medium repair risk:** reader contact cells carry `contact_id`, and legacy note/quote cells carry distinct bindings, but Save resolver ignores per-row bindings and resolves only column names/column definitions. Editing Phone creates another contact without primary identity/revision; clearing Phone fails without a chosen contact. Quote/note writes append and skip head preconditions, potentially overwriting the visible interpretation of a different source. Resolve trusted current source bindings on the server, preserve multi-contact identities and quote roles, and enforce exact source versions; do not trust client bindings as authority.
- **R-A12 / P1 / high confidence / S, low repair risk:** agent `edit_records` sends cell status changes to `handleSetField` with default stated provenance, bypassing the trusted explicit-member-intent guard used by `set_fields`. Manual Save is explicit intent; model-proposed edits are not. Carry executor-owned per-operation status verdicts so inferred changes ask before mutation and save unrelated clear facts independently where supported.
- **R-A13 / P2 / high confidence / S, low repair risk:** canvas edit/paste stores text strings even in numeric columns, unlike row-form `parseTextInput`; entity number fields reject these strings, while custom rows bypass definition-specific validation. Use one typed parse/validation owner for grid, row form and tool/save, retaining invalid input for review and preserving canonical numeric/date/currency types.

Direct source probes (no repository test edits or business data): production `handleUndoCommit` returned applied while the first custom value remained; production `handleRecordsBatch(field.archive)` returned applied while one custom column remained visible. These confirm R-A09/R-A05 independently of the submitted tests. Runtime D1 limit/transaction/browser journeys remain unproven in this review.

- **R-A14 / P2 / high confidence / M, low repair risk:** Leads columns are reconstructed from nonempty cells in the loaded page instead of durable column definitions. A newly created empty special column disappears after Save; later pages can change inferred labels/types/column presence. Calculations are only evaluated for custom lists and only against saved values; local draft input edits never recompute them. Build all lists from their durable definitions plus explicit legacy bindings, and share the existing deterministic evaluator with the local draft overlay.
- **R-A15 / P2 / high confidence / M, low repair risk:** entity rows are filtered for redirects/kinds after SQL LIMIT, then has-more is computed from the filtered page. An early page dominated by merged rows can incorrectly end pagination, excluding later records; totals count all nondeleted entity kinds rather than the displayed Leads set. Status filters run only over loaded rows, and unsupported column sorts silently fall back. Apply source predicates and supported filters before pagination, use matching count predicates, and expose capabilities truthfully.

**Repair order:** R-A01/R-A02/R-A03/R-A04/R-A08 form the basic safe manual-edit/Save flow; R-A09/R-A11 repair source/Undo fidelity; R-A05/R-A14 restore durable flexibility; R-A07 bounds the whole Worker invocation; R-A10/R-A12 protect conversational draft/intent; R-A06/R-A13/R-A15 finish predictable editing/query behavior. Preserve the actual ledger guard/receipts and lazy canvas grid; none of these requires an ORM, new editor framework or service split. Required acceptance is a real A→B→A unsaved draft, Add/edit/Save/readback, edit during delayed Save, lost-response reload retry without duplicate note, contact correction/clear, custom-column removal and saved Undo, correctly grounded draft-aware assistant turn, and actual Worker query/bind counts. UI/API/migration/runtime source was inspected; browser/device/live-model/production-cost/full-suite acceptance was not performed.


Use real browser for visual/interaction acceptance. Actual local D1 is necessary for rollback/ownership/replay; keep a small boundary suite, not styling fixtures mirroring implementation. Don't repeatedly run already-green unchanged suites.

Patterns: `apps/worker/test/records.integration.test.ts` uses SELF/D1/session; field-batch/interactions/entity-delete/ledger-migrations suites cover real bindings/receipts/replay. Mounted `apps/web/test/records.test.tsx` currently uses alternate in-memory Save; replace those assertions with real API-bound delayed/error/stale behavior. Existing draft/logout cases supply owner-purge patterns. New test files only for a distinct boundary.

Future implementation commands from root; these application commands were **not** run for this planning pass:

```powershell
pnpm exec vitest run --project worker apps/worker/test/records.integration.test.ts apps/worker/test/field-batch.integration.test.ts apps/worker/test/interactions.integration.test.ts apps/worker/test/entity-delete.integration.test.ts apps/worker/test/ledger-migrations.integration.test.ts
pnpm exec vitest run --project web apps/web/test/records.test.tsx
pnpm typecheck
pnpm lint
pnpm test
pnpm check:design
pnpm build
node plans/qa/docs-audit.mjs links
git diff --check
```

Run relevant new validator/reducer/evaluator cases with the configured pure project; add concrete filenames to targeted commands when created. No current Storybook/check:stories. Harness failure/hang needs exact report and investigation, not repeated blind retries or silent waiver.

| Journey | Required result |
|---|---|
| Source round-trip | UI Save changes actual source; fresh Records/client-file/agent query agree. Chat-created information appears here. |
| Scope | Foreign IDs/actor retry ID rejected with zero source/effect/receipt/revision change, including create collisions. |
| Atomic/replay | Late injected failure rolls back all chunk effects; success rebuilds equivalent projections/receipts. |
| Retry | Same immutable action applies once; changed payload conflicts; reload recovers uncertain Save without duplicate rows/events. |
| Team conflicts | Different cells retain both; same cell/head/definition retains draft and shows mine/saved; reviewed overwrite has new action ID. |
| Draft races | Back to base clean, new-row delete Undo correct, paste/fill group one Undo, editing during Save/refresh survives, composer native Undo works. |
| Flexibility | Blank sparse/non-Latin columns and empty Products survive; rename/remove/restore preserve IDs/types/originals/replay. |
| Manual source editors | Tasks/Notes/Drafts genuinely save advertised operations; no hidden shadow fields or fabricated sent state. |
| Paging | >150 rows/>50 notes, full-list filter/sort, mutation during paging; honest scope, no unexplained missing/duplicate rows. |
| History/Undo | Correct actor/source/count; group Undo preserves unrelated work or conflicts; Restore value is a new event; originals readable. |
| Draft Otis | Structured target arrives; questions/restart/legacy tool can't commit saved data; patches recover/dedupe and preserve newer edits. |
| Saved Otis | Same ledger/source; real questions for ambiguity/inferred status; pane closure doesn't lose accepted work. |
| Calculation/tidy | Quantity previews without model; Save/read/rebuild agree; missing/currency/dispute errors visible; synthesis retains sources/links. |
| Load/navigation/auth | Old scope aborted, errors distinct, recovery private/scoped and no stale owner resurrection. |
| Inventory | New stores/originals/lineage/artifacts exported truthfully/formula-safely and included in local scoped erasure. |
| Native UI/a11y | 360×800, 390×844, 900, 1280, 1440 CSS px; no duplicate controls/body sideways overflow; keyboard/ranges/paste/menu/Escape/focus; reachable Save, labeled errors and usable DOM list. |

Small synthetic profile: 50-row first load, 1/20/100/1,000 edits and dependency-heavy removal. Report requests, SQL count, scanned/written rows, wall time and actual CPU separately. Fixed small edit cost must follow touched state rather than workspace size. Feedback <100 ms; pending >300 ms stays in affected control. Main chat initial chunk excludes grid; record actual lazy chunk gzip bytes. Local fixture/device resize isn't Free/physical-device/provider/production proof.

## 14. Boundaries and maintenance

No ORM, Workflows migration, vector/report service, CRDT/live coediting backend, second agent/composer, full Excel formula/import engine, private notes, unsolicited proactivity or outward messaging. XLSX remains export snapshot; writable workbook/Sheets sync is separate. Preserve model/provider setup, source/run/outbox/question durability and teammate work.

Ordinary source drift/migration tip/naming/test failure calls for inspection and repair, not automatic approval. Pause only for a material unrequested data-loss/authority decision, a new paid service or unavailable external action; finish independent authorized work and explain the blocker.

One validator/reader/writer for manual and assistant editing. Review new fields/commands against source binding/capabilities, coverage, replay, inventory and draft-target enforcement. A control is accepted only with its real supported effect. View state stays separate from business events; proposals remain explicitly unsaved.

Planning evidence: actual page/route/ledger/draft/assistant source, screenshot and selected design intent inspected; Cloudflare/Glide/shadcn primary docs consulted. This request changed only plans/reference image. No application suite, provider call, real-browser/device check, remote profile, commit/push/deployment. Final document link/consistency/diff results are recorded in the backlog after checking.
