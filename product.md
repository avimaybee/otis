# Otis product

Otis is a business memory you talk to. A member reports a visit, message, promise or useful detail by text or voice; Otis files the clear facts, asks for genuinely missing details, and retrieves useful context when needed. It should feel responsive and capable enough for daily field work.

Kerning is the first workspace and dogfood partner, not a hardcoded tenant. Any member/workspace follows the same identity, storage and permission rules. The latest explicit user correction governs intent. [Implementation status](docs/status.md) records which parts below are implemented or still open; this document defines behavior, not a completion claim.

## 1. Core experience

A member can log an interaction, ask what the team knows, correct a record, create a next step, prepare an outward draft and inspect/undo a change through ordinary conversation. Web and Telegram use the same durable workspace memory. Optional slash commands and settings do not become the main workflow.

Clear complete instructions save directly. If a report contains useful facts plus an ambiguous follow-up, save the facts and ask only for the missing follow-up detail. Do not force a whole report into clarification or make users learn internal IDs/tool names.

Match the current user's language, useful tone and requested depth. Short confirmations can be short; requests for analysis, comparison or a complete overview need enough detail to be useful. Do not hide partial success, unavailable capabilities or missing evidence behind confident generic wording.

## 2. Workspace and identity

Identity establishes the acting member, never the model, speaker guess or Telegram display name. A user may belong to multiple workspaces. Business records, aliases, memory and preferences remain within their workspace.

Members share workspace records and retained chat/audio history, including pre-join history with clear join disclosure. A teammate transcript is inspectable but read-only: a member cannot append/stop work as its author. Personal settings do not silently become shared policy.

Workspace ownership governs lifecycle operations and transfer. Current membership is rechecked at sensitive reads/writes, including private media. Removing access must not erase unrelated unsent work in another workspace.

## 3. Facts, commitments and correction

Core records include entities, names/aliases, lead status, phone/language, assigned member, sourced facts/events, tasks, drafts and memory. New entities are not automatically inferred to be warm/hot. Existing lead-status changes inferred from sentiment require a question; an explicit instruction can apply directly. “Closed” asks won or lost when unclear.

Prices distinguish offered quotes from expected budget, preserve currency and use integer minor units. A manager's availability is contextual knowledge, not a scheduled promise. Next step/due come from tasks; last contact comes from confirmed contact, a confirmed sent message or a visit with actual contact.

Missing deadlines ask. A date-only deadline is a local calendar date with its interpretation timezone; an explicit time is an instant. Do not choose today, noon or a timezone merely to satisfy a schema. Explicit “no deadline” is permitted and remains distinguishable from an unresolved deadline. Snooze suppresses notification until an explicit instant without silently moving the original deadline.

Corrections preserve the original report and append a sourced change. Conflicting current facts keep candidates/history and an explicit dispute. A disputed current value cannot be presented as confirmed or quietly used in a draft/brief. Resolve the affected fact without blocking unrelated useful work.

## 4. Memory and context

Sourced durable preferences, shorthand and aliases should improve subsequent conversations within the workspace. Preserve what a note concerns, who it applies to and when it was observed. Distinguish confirmed facts, preferences, recommendations and uncertainty.

Retrieve relevant historical facts and conversation when the recent window is insufficient. A model's previous description is not a substitute for retained source evidence. Forgotten/superseded memory must not return as an active instruction or be silently promoted again from old transcripts. Summaries/caches can accelerate retrieval but are never the sole canonical state.

Members can search workspace records and conversations from the app. Conversation search keeps the original message as the source and reports its match/coverage; an index accelerates lookup but does not replace the stored conversation.

Untrusted forwarded or supplied content is context, not permission to perform writes. Do not infer durable personality/style rules from one editing request.

## 5. Responses and tables

Give the answer first, then useful supporting detail or next actions. State what actually completed and what remains unresolved. Use receipts/source context for saved actions; model prose alone does not prove a write or external delivery.

Build a table when requested or when rows/columns make information easier to compare. This is a general response capability: leads, quotes, timelines, tasks across people, alternatives, proposed plans and user-supplied information all qualify. Choose headers, detail and grouping from the actual question. Do not force every request into a lead overview.

Retrieve missing saved facts where needed, preserve requested columns, and mark unknown/disputed values. Distinguish recommendations from recorded facts. A partial page cannot be called “all”; state coverage and continue retrieval when needed within practical budgets.

Follow-ups such as “add a column,” “compare these two,” “make it more detailed” and “explain the second row” refer to the relevant visible result. Revalidate facts/authority before any subsequent mutation. Prose and several tables can coexist.

The production renderer makes wide/long tables readable with local scrolling, normal typography and working tab-separated table copy. When a table is wider than the message text column, it can widen symmetrically into available transcript space while retaining local horizontal scrolling. No dead sorting/export controls, new report language or separate formatter model is required.

## 6. Responsive conversation and questions

Echo user input immediately; show local sending, confirmed acceptance and failure accurately. Retry the immutable submitted payload with its original UUID. Saved input does not mean the agent has finished. Preserve recoverable drafts, recordings and submitted work through weak connectivity.

Show actual progress and actual provider-supplied displayable reasoning inside Working. Stream useful text promptly. Follow-ups remain sendable during active work; Stop preserves completed effects and differs from Undo.

The question experience follows the user's Codex reference: a question panel shows the actual question/options and accepts a free-text answer in its own input, with Skip and Send. Main chat input stays available for ordinary messages. Every answer is tied to its explicit question; route changes, retries, several paused tasks and delayed responses cannot silently retarget it. Skip defers display rather than destroying the pending operation.

## 7. Undo and failures

Default Undo from here reverses the selected successful write and later successful writes in that same run. Single-action undo is secondary. Preview concrete effects and dependencies; preserve teammate and unrelated-run work. Undo appends reverts rather than deleting events or restoring an entire workspace.

A failed/stopped run can have committed useful work. Explain that accurately and expose its successful actions. Failed/partial runs have an author-scoped Retry run action that retains receipts and progress; blindly resending the original text is not equivalent. Successful, cancelled and live runs are not restarted by this action. Empty final output fails visibly; precise wording when earlier actions committed still has local follow-on changes and needs acceptance.

## 8. Voice and images

Members record voice notes with Stop → Review → Send, text reply by default. Use actual microphone level if showing a meter. Preserve ordered local chunks/recoverable capture, make interruptions explicit, and expose the persisted transcript before later filing completes when available.

The exact selected provider/model/endpoint/format determines native transcription support. Otherwise use the configured verified Groq route. Quota/outage/authentication failure does not silently authorize another provider or paid inference. Actual Android/iPhone/Telegram recordings need evidence.

Images retain attachment/source identity. Recent image follow-ups should work without re-uploading; older retained images remain discoverable and viewable by scoped read tools. Preserve selected images on stateless replay/tool rounds and restore selection after restart. Normalized renditions reduce repeated payload cost; unavailable/expired/unsupported visual input gets an honest limitation, not a guessed description.

Client files can keep linked image and PDF originals. PDFs may have a background text extraction with visible availability/coverage; the original remains available when extraction fails. Voice transcript corrections are sourced overlays and do not replace the original audio or transcript. These features still need live Worker/device and broad format acceptance.

## 9. Briefs and reminders

Briefs start disabled. A member chooses time, weekdays, timezone and delivery channel. At most one scheduled daily brief per member/local date; no default 09:00 or automatic notification on empty work.

Select a small actionable set with concrete reasons, dates where known and sources. Prioritize explicit promises/due tasks, explicitly undated next actions and stale warm/hot leads using deterministic rules. Due dates alone do not prove a reminder was delivered.

Done, Draft, Move and Snooze may use existing authorized services; ordinary conversation remains sufficient. Replies to a saved brief item must resolve that item, while “the second one” after a newer table refers to the relevant newer result.

Explicit one-off reminders and member-requested weekly or after-quote follow-up rules are implemented through the existing reminder service. Rule timing, timezone, channel, quote condition and deduplicated occurrences are stored; actual chosen-channel/device delivery acceptance remains separate. Additional unsolicited proactivity remains unresolved and disabled.

## 10. Outward drafts and export

Create/revise outward drafts only when requested, in the requested or known recipient language, grounded in confirmed facts. Copy is available; a usable normalized phone permits a prefilled WhatsApp link. Ask for a phone only when handoff needs it. Copy/open never marks sent; sent status requires the member's explicit completed-send confirmation. No agent tool sends to a lead in v1.

A member-scoped route generates a JSON workspace export and an XLSX snapshot using the same scoped data collection. The workbook uses formula-safe cell text; it is a snapshot, not another database or edit-back synchronization. Independent reader and restore/rebuild acceptance remain open.

An owner-only workspace erasure route removes workspace-scoped D1 data and inventoried R2 media, then records a content-free tombstone with per-store counts. Backup/restore behavior and the complete production retention/erasure journey still need release acceptance.

## 11. Model setup and practical scope

Platform credentials in Cloudflare secrets support default use; encrypted workspace BYOK takes priority. The operator offers an approved model registry; discovery does not automatically expose models. Chat model/effort selection is server-confirmed and snapshotted per accepted run.

Use existing Cloudflare services and direct code. Performance means fast local feedback, minimal avoidable waits, prompt useful streaming and useful grounded completion—not arbitrarily short answers or weaker recovery.

After reliable dogfood, consider self-serve expansion, read-only MCP, connected Google Sheets, broader proactivity or WhatsApp bot only as separately chosen work. The user has now selected flexible fields and direct editing through the information surface below. No general research agent, dashboard, live voice call, automated lead outreach, billing platform or speculative infrastructure is part of this cleanup.

Success is repeat field use: capture → recall → useful resurfacing → action. The two-week habit/usefulness criterion and real-device/native-latency measurements remain acceptance work, not promises inferred from a demo.

## 12. Editable information — selected, partially implemented

**Your information** now presents real workspace records in a desktop grid and a mobile-friendly row view, with list/column and draft-edit controls. The page is useful for viewing and preparing changes, but its manual Save path is not accepted: it currently writes projections outside ledger commands, uses fixed receipt metadata, commits chunks separately, and reports success for Notes/Drafts edits it skips. R16 tracks replacing that path with authoritative ledger-backed Save before the UI is described as safe direct editing.

Manual cell, row and column changes collect in a recoverable draft until explicit **Save**. Local Undo/Redo operates on that draft. Saved edits are sourced ledger commands, with history and saved Undo; ordinary removal preserves recoverable history. Concurrent edits retain the member's draft and resolve only the affected conflicting values, preserving unrelated teammate work.

Otis can create fields, organize information and define calculations conversationally. On clean saved information, authorized cleanup applies immediately with history/Undo. With unsaved manual edits, Otis tidies the draft and the member still clicks Save. Never let another tool silently bypass that draft target. Summaries and consolidation retain original values, source evidence and relationships; uncertain identity/status/value changes still ask narrowly.

The [implementation plan](plans/editable-records.md) defines the remaining data/UI/Save/tool contracts and acceptance slices. It extends the existing ledger and Cloudflare owners; it is neither a second business database nor an export-edit synchronization feature.
