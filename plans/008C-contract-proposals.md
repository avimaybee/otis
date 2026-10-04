# 008C contract proposals: language, display timezone, entity history

Status: reviewable proposal, NOT implemented. These three 008C requirements
cannot be completed honestly without additive contract/storage/API surface,
and inventing it unilaterally (ambient language inference, brief-timezone
reuse, workspace-wide fetching) is explicitly forbidden. Each proposal below
names the exact gap, the smallest additive change, its authority, and the
decision Avi must make. No inference service, no new framework, no ledger or
identity rewrite in any of them.

Conventions used: `workspace_settings`/`member_settings`/`workspace_users`
(0001, extended 0004), `chats`/`messages_in`/`chat_messages` (0002),
`entities`/`entity_aliases`/`events`/`action_receipts` (0003). Workspace
settings writes today require membership with a commit-time guard plus an
audit row (`packages/identity/src/settings.ts` `setWorkspaceSettings`);
member settings are own-only. Chat reads serialize in
`apps/worker/src/inbox/repository.ts` (`listChatMessages` fixed column list).

## P1 — per-message content language (additive, nullable, unwritten until decided)

Gap, verified: `ChatMessage` (`packages/contracts/src/index.ts:403`) carries
no language; `chat_messages`/`messages_in` (0002) have no language column;
`listChatMessages` selects a fixed column list
(`apps/worker/src/inbox/repository.ts:262`); `validateChatMessageRequest`
(`packages/contracts/src/chat.ts:25`) accepts no language. Nothing infers
language today, and nothing may start: ambient member preference is not
content language, especially for mixed ro/hu/en threads.

Smallest change:

1. Migration `0010`: `ALTER TABLE chat_messages ADD COLUMN
   content_language TEXT NULL` (content lives in `chat_messages` for both
   member and assistant rows; the `messages_in` transport envelope is
   untouched). No CHECK constraint; validation lives in TypeScript next to
   the other DTO validation. No backfill: all existing rows stay NULL,
   which means unknown/inherit and keeps every old message valid.
2. Contract: `ChatMessage.content_language: string | null`;
   `CreateChatMessageRequest.content_language?: string`. Server validation
   mirrors the other request validation: must satisfy
   `Intl.getCanonicalLocales(tag)` without throwing, length-bounded;
   invalid tags are rejected with 422, never coerced or guessed.
3. Writer: `acceptWebMessage` persists the validated request tag on the
   member row; assistant rows are written NULL (no inference, no model
   call). Serializer: extend the fixed column list and row mapping in
   `listChatMessages` (and the `chat_messages` reader in
   `apps/worker/src/inbox/telegram.ts` if it materializes `ChatMessage`).
4. Web: `Transcript` sets `lang` only when `content_language` is a
   non-empty string; otherwise the message inherits the application
   language (today's behavior, unchanged). The existing
   `parseAppLanguage` validator stays scoped to application language.
5. Tests: 422 on bad tags; write→read round-trip; NULL rows serialize as
   null; web asserts `lang` present only with metadata, inheritance
   otherwise; legacy rows valid.

Decision required (Avi): where a member tag comes from. Default proposed:
nowhere automatic — the field ships write-ready and stays NULL until an
explicit per-message affordance exists (which itself needs a design
recipe, not invented here). Forbidden alternatives, stated so they stay
forbidden: ambient `navigator.language` tagging, author-preference
stamping, per-message model detection.

## P2 — workspace display timezone (additive setting, viewer zone until set)

Gap, verified: `WorkspaceSettings`
(`packages/contracts/src/index.ts:178`) is `{workspace_id,
default_model, created_at, updated_at}`; the table and
`get/setWorkspaceSettings` match. `brief_timezone` is brief-schedule
configuration on `member_settings`, and per-deadline source-member
timezones are interpretation rules — neither may stand in for display.
`apps/web/src/i18n/format.ts` already accepts an explicit display zone;
callers pass `undefined`, so the viewer (device) zone applies.

Smallest change:

1. Migration: `ALTER TABLE workspace_settings ADD COLUMN display_timezone
   TEXT NULL`.
2. Contract: `WorkspaceSettings.display_timezone: string | null`;
   `UpdateWorkspaceSettingsRequest.display_timezone?: string | null`.
   Server validation mirrors the client-side check already used for brief
   timezones (`new Intl.DateTimeFormat('en', { timeZone })` try/catch);
   invalid zones are 422, null clears.
3. Route/writer: extend `handleUpdateWorkspaceSettings` and
   `setWorkspaceSettings` with the same membership guard and
   `settings_audit` pattern; authority stays identical to `default_model`
   today (any member — settled established behavior for equal members).
4. Web: pass the configured zone into the existing formatter call sites
   (timestamps, day separators); settings workspace tab gains the control
   only after explicit recipe approval — a new settings control is not
   built in this proposal.
5. Semantics, locked: the zone affects display only; stored UTC instants
   and ledger facts are untouched; brief and source-member zones keep
   their meanings. Until a workspace sets one, the viewer zone applies
   (status quo, recorded here — not a silent substitution).

Decision required (Avi): approval for the workspace-tab control only.
Authority is settled (member parity). No settings product is invented
by this proposal.

## P3 — bounded entity history read (new scoped read, no projection)

Gap, verified: all business data needed already exists and is immutable
(`events`: per-workspace sequence, `entity_id`, `occurred_at` vs
`recorded_at`, `provenance`, `action_id`, `supersedes_event_id`,
`reverts_event_id`, RESTRICTed sources; plus `entities`,
`entity_aliases`, `action_receipts`). What is missing is the read
operation: today only single-action (`DetailPane`) and single-memory
(`SourcePane`) reads exist, both membership-checked with honest
unavailable states. Assembling history by downloading workspace chats is
forbidden and is not proposed.

Smallest change:

1. Contract DTOs (additive, `packages/contracts`): `EntityHistoryEntry`
   `{ event_id, sequence, kind, occurred_at, recorded_at, actor_kind,
   actor_user_id, channel, provenance, summary, superseded_by_event_id,
   reverted_by_event_id, source: { chat_id, text_preview } | null }` and
   `EntityHistoryResponse` `{ entity: { id, name, kind, status },
   history: EntityHistoryEntry[], next_before_sequence: number | null }`.
2. Route `GET
   /api/workspaces/:workspaceId/entities/:entityId/history?before_sequence&limit`
   (cap 50 per page, in the style of `ACTIVITY_BOUNDS`): membership scope
   via the existing `requireWorkspaceScope`; single-entity predicate with
   stable `sequence` ordering and cursor pagination; erased/inaccessible
   entities return 404 with no protected details, following the
   `DetailPane` `failedAccess` pattern.
3. Pending/disputed display derives from existing columns only
   (`supersedes_event_id` / `reverts_event_id` chains plus
   `action_receipts.result_status`); no new writes. The exact derivation
   rule needs ledger-owner confirmation — flagged below, not invented.
4. Web: `DetailPane` gains a timeline section reusing approved recipes;
   the labeled contract-only story `detail/entity-timeline` becomes a
   production story. No editable lead page, no second projection.
5. Tests: ordering/stability across pages, bound enforcement,
   cross-workspace 404, erased-source honesty, author/time/source
   attribution, recorded-vs-occurred preservation where material.

Decision required (Avi): confirm the pending/disputed derivation rule,
the page cap, and gate placement (coordinated 007 read-contract work
first, UI binding after — not inside 008C unilaterally).

## Decision register (exact questions, not vague future work)

| # | Question | Options | Default proposed |
|---|---|---|---|
| D1 | P1 member-tag source | explicit per-message affordance (needs recipe) vs stay NULL | stay NULL; field write-ready |
| D2 | P1 assistant rows | NULL always vs match member tag | NULL always (no inference) |
| D3 | P2 authority | SETTLED — any member (workspace-settings parity is established authorized behavior for equal members, same as `default_model`; not a new preference question) | member parity |
| D4 | P2 control | approve a workspace-tab timezone control | not built until approved |
| D5 | P3 derivation + cap + gate | confirm disputed rule, 50/page, 007-first placement | as proposed, pending confirmation |
