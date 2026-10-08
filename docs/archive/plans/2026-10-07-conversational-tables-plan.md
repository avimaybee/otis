> Historical record, archived 2026-10-07 from `plans/2026-10-07-conversational-tables-plan.md`. Its claims apply to the original baseline. Use [current implementation status](../../status.md) for active work; old proposals and DONE labels are not current authority.

# Comprehensive tables in Otis replies

Status: REVISED SPECIFICATION, 2026-10-07. Latest user clarification: “what's the status of all leads?” was an example of comprehensive tables, not an assignment to build a lead-specific reporting feature. The earlier plan narrowed the feature too far; this revision supersedes its lead-specific implementation direction. Source inspected at aac41d1. No application change made by this revision.

## Actual requirement

Otis should autonomously choose and construct a useful table whenever the information is easier to understand through rows and columns. The user can also explicitly request a table, choose columns, ask for more detail, combine different kinds of information, or refine a previous table. Headers, row meaning and cell content follow the request and available information. A “table” is not synonymous with a lead report.

Comprehensive means covering the important dimensions of the request with enough useful detail. It does not require filling every answer with every available field, fitting everything into five standard columns, or creating a backend endpoint for each possible question.

## Running observations

Entries 1–7 preserve the original discovery log from source inspection before aac41d1. Entries 8–10 record the scope correction and current-source implications.

1. **Markdown table support is already installed and wired.** `apps/web/src/components/Transcript.tsx:316` renders committed messages through react-markdown + remark-gfm; streaming branches use the same plugins. `index.css:77` defines locally scrolling tables. No new Markdown library is required; rendered usability has not been verified this pass.
2. **Current entity-query results can conceal incomplete coverage.** `agent/repository.ts:273` defaults to 25 rows and returns a plain array without total/has-more/next-cursor metadata. The schema allows a cursor and caps limit at 100. An answer headed “all leads” can therefore describe only the first page unless coverage is fixed.
3. **Useful overview columns require more than the entity row.** Current entity reads include names/status/assignment and batch projected fields, but next open task, deadline, last confirmed contact and readable owner are not assembled into a report. Build these as scoped set-based reads rather than one tool call/query per lead. Keep disputed values explicit.
4. **The generic entity query does not filter entity kind.** The source schema stores leads, clients and partners in `entities.kind`, but `query` exposes no kind filter. A lead-specific overview must constrain `kind = 'lead'` rather than assuming every business entity is a lead.
5. **A large model-written table repeats facts as generated tokens.** Existing replies have `ChatMessage.content_text`, not typed table blocks. Even after the database read, the model must generate every cell in a Markdown table. This is an avoidable latency/token cost for record-heavy reports, not a measured timing claim. Keep Markdown for ordinary comparative answers; render saved, typed read results directly for lead reports.
6. **The durable read-result path already exists, but live presentation does not.** The handler saves tool results in `run_steps.result_json` before `step_finished`; the authorized run API exposes normalized results. `step_finished` currently contains only step/status metadata. Reuse that durable result and the existing stream/replay path; a new report database or artifact service is unnecessary.
7. **“Last contact” must respect Undo.** The ledger rebuild removes reverted event IDs before reducing state. A naive `MAX(occurred_at)` over all contact events can surface undone activity. Use effective, non-reverted contact events, including a visit only when contact was recorded; drafts and opening WhatsApp are not confirmed contact.
8. **Scope correction from the user:** the example was mistaken for the feature. The earlier plan overemphasized lead columns, sorting and pagination; that contributed to an implementation scoped around leads. General table capability must be independently accepted with unrelated table subjects and freely selected columns. This is a correction to the specification, not evidence that the new read function is broken.
9. **The new helper is a fixed-shape data read, not the general presentation boundary.** At aac41d1, leadOverview.ts restricts display columns to status/next_step/due/owner/last_contact, and the prompt's “Your reports” instruction points to this resource and lead-count summaries. That is useful for a particular overview. It cannot alone cover quote comparisons, history, action plans or tables based on user-supplied information.
10. **No table-specific application renderer has been added by that commit.** The current transcript still renders arbitrary Markdown through remark-gfm in saved and streaming branches. This is already the broad presentation mechanism; extend its usability and the agent's instructions instead of defining general table behavior through lead-overview filters.

## Expected breadth

| Example request | What the agent should be able to construct |
|---|---|
| “What's the status of all leads?” | Columns suited to the requested overview, grounded in saved records, with honest coverage |
| “Compare these three quotes, including what's included, cost and downsides.” | Supplier/option, price, scope, exclusions and tradeoffs; columns chosen for this comparison |
| “Give me a timeline of everything that happened with Cedar.” | Date, interaction, outcome and relevant next action, keeping unknown dates explicit |
| “Show everyone's follow-ups this week.” | Person, business, task, deadline and state across the requested scope |
| “Compare our options for this project.” | Alternatives, costs if known, benefits, limitations and a clearly labeled recommendation |
| “Turn these notes into a detailed action plan.” | Action, purpose, dependencies, proposed owner/deadline where supplied or explicitly suggested |
| “Put this pasted information into a table.” | A faithful, organized table of the supplied material; no unrelated database lookup |
| “Add a risks column and group it by owner.” | A revised table preserving its referent, with new columns and requested grouping |
| “Explain the tradeoffs, then show me the numbers.” | Useful prose plus a table, or several smaller tables when that is clearer |

Actual saved facts, user-provided information and proposed plans have different meanings. The agent may create analytic comparisons and suggestions; it must identify assumptions/proposals rather than pretending every cell is a saved business fact. Explicit user-requested structure takes priority over default table preferences.

## Practical implementation

### 1. General presentation through the existing Markdown path

Use the current react-markdown/remark-gfm response path for flexible, model-composed tables. It already accepts arbitrary headers and rows. The same streaming/saved renderer must handle all subjects. Preserve sanitization and plain user-facing language; do not accept raw HTML or force the entire answer into a JSON table envelope.

Replace the lead-heavy prompt instruction with a compact general presentation rule. Keep guidance for using lead_overview in that tool/resource's description, where it explains an efficient read rather than limiting what a table can be.

Candidate stable instruction:

    Use a table when the user asks for one or when repeated information,
    alternatives, timelines or comparisons are clearer in rows and columns.
    Choose meaningful headers and enough detail to answer the actual request.
    Follow requested columns, grouping and depth; do not reuse a fixed lead
    template for unrelated information.

    Tables may combine saved records, relevant conversation or supplied
    information. Distinguish recorded facts from recommendations, assumptions
    and unknown values. Retrieve missing facts when needed; do not invent cells.
    Explain important takeaways briefly when useful. A table can accompany
    prose or another table instead of replacing the whole answer.

    Respect scope and coverage. Do not describe a partial read as complete.
    Preserve the referent when the user refines or asks about a previous table.

Use a few varied examples in evaluation, with one or two representative examples in the static prompt only if they improve real responses. Lead overviews cannot be the only examples. Keep the prefix deterministic and bump the prompt version for an implemented instruction change. No extra formatting/rewriting model call.

### 2. Select data reads for the question

The agent should use current entities/tasks/events/memory/conversation/media capabilities according to the information needed, then compose the requested presentation. Combine compatible facts by stable source IDs; keep attribution, date semantics and disputed state. Prefer bounded batch reads over a call per row. Compute exact totals and deadline state in code where appropriate. A table based entirely on user-supplied material needs no business-data read merely because it is a table.

Keep lead_overview as one efficient source when its data answers the request. It does not decide all table headers. If a lead table asks for quoted value, contact preference or richer history, retrieve those fields from the appropriate existing source rather than silently omitting them or adding another lead-report variant. Identify actual missing retrieval/filter capabilities with evidence before extending tools. No report-specific service per subject and no dynamic SQL exposed to the model.

The query/helper's page limit is a read/transfer bound, never a limit on tables as a capability. Obtain needed continuation pages or clearly present accessible remaining data through implemented controls. Do not silently stop at the first page. For very large outputs, adapt presentation without claiming unavailable pagination/export controls or manufacturing a full result from partial data.

### 3. Give arbitrary tables a readable production UI

Provide shared table components/styles for all Markdown tables in saved and streaming replies. Put a semantic table in a locally scrolling, keyboard-accessible wrapper. Use existing Otis typography, surfaces and borders; do not squeeze a wide table by shrinking normal text. Wrap long descriptive cells and preserve meaningful numeric/date formatting.

The important first column depends on the content: an option, date, action, lead or category. Do not hardcode a sticky “lead” column. Verify any sticky-column behavior in a real browser. Headers, empty/disputed values, long cells, alignment and multiple tables should stay readable on both narrow and wide viewports. The page and composer must not acquire horizontal overflow.

Use actual rendered rows for a functional “Copy table” action that produces tab-separated values for Sheets, including multiline cells and safe escaping. Keep ordinary message copy available. Add no dead sort/filter/download controls. If sorting/filtering is implemented later, scope it honestly and preserve visible row order for “the second one” references.

Streaming can legitimately settle unfinished Markdown; avoid remounting completed blocks or jumping the reader to the bottom. Reuse the production renderer in Storybook, and add a generic table recipe/fixtures to design.md for implementation review. Approved token values do not need to change simply to support this behavior.

### 4. Keep output optimizations separate from capability

The general capability must work through flexible Markdown. A direct renderer for a large saved record set may later reduce repeated model-generated cells; measure that benefit and use a shared table presentation if justified. It is not a prerequisite for quote comparisons, timelines, plans or user-supplied tables.

Do not build a report engine, custom query language, automatic chart/artifact service, separate formatter model or topic-specific table component to satisfy this request. Conversely, do not mark the feature complete after adding a prompt sentence: prove useful content, retrieval coverage and actual responsive rendering across varied questions.

## Acceptance for the corrected feature

The following are independently required:

- **Generality:** actual model responses construct useful tables for at least leads, quotes, timelines, cross-person tasks, proposed action plans and supplied alternatives. Different questions produce different appropriate columns. One successful lead_overview read is data-source evidence only.
- **Completeness and grounding:** requested columns/details appear where supported; unknown/disputed values and proposed assumptions remain explicit; pagination does not conceal missing records; suggestions cause no unrequested writes.
- **Conversation:** “add a column”, “compare only these two”, “group by owner”, “make it more detailed” and “explain the second row” operate on the relevant table. Current authority is revalidated for subsequent mutations.
- **Composition:** tables can accompany prose and other tables; small/simple replies remain natural. No table is forced on every reply, and supplied text does not trigger needless tools.
- **Usability:** shared production stories for variable column counts, numeric cells, long descriptions, empty/missing/disputed data, multiple tables and active streaming. Record native-browser checks at 360, 390, 900, 1280 and 1440 px, plus keyboard/semantic/copy behavior.
- **Checks:** implementation runs pnpm typecheck, pnpm lint, pnpm test, pnpm build, design checker and Storybook build. Use real Workers/D1 for data boundaries and controlled live models for answer quality; fakes cannot establish that a model chooses good columns.
- **Latency:** compare provider rounds/tokens, first useful output, completion and render responsiveness on the same varied fixtures. Keep explicit model/effort selection. No gain claim based solely on passing validators or adding a helper.

## Current evidence and handoff

Inspected current source at aac41d1. The user supplied the implementation agent's seven-test report; this revision did not independently rerun or accept those tests. Existing Markdown support is source-confirmed. No application source, schema, production data, model calls or browser state was changed by this correction.

Revision checks passed: 65 local links across the affected plans/index, whitespace/conflict checks, scoped git diff check, and 34 unique response-case IDs. Application tests were not rerun for these documentation changes.

Executor task: implement and verify the general presentation/response behavior above using the existing renderer and data tools. Preserve the useful lead read and unrelated work. Do not treat this request as another lead-overview filter expansion.

Related [overall response audit](2026-10-07-agent-response-audit.md) and [varied response cases](../../../plans/qa/2026-10-07-agent-response-cases.md). Primary library reference: [remark-gfm table support](https://github.com/remarkjs/remark-gfm).
