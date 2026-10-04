/**
 * Telegram durable outbound delivery (009A).
 *
 * Delivery rows are created atomically inside completion batches and sent by
 * this bounded worker — never inline during business commits, so no
 * transaction spans provider/Telegram I/O. One conditional claim per row
 * (pending -> sending) means overlapping consumers never double-send; the
 * server UUID-keyed rows plus same-answer reuse keep redelivery safe.
 *
 * Outcome policy: ok:true + recorded outcome -> delivered; explicit 400/403
 * -> failed_known (terminal); 429 -> pending with next_retry_at honoring
 * retry_after (minimum one second, bounded attempts); transport/timeout/5xx
 * without trustworthy rejection, malformed responses, crashes, or success
 * that cannot be recorded -> outcome_unknown (never automatic pending:
 * Telegram sendMessage has no idempotency key here). Stale sending rows
 * with no recorded result become outcome_unknown after 30 seconds; a late
 * original sender cannot overwrite that transition.
 */

import { replyMarkupForPart, splitTelegramText } from '@otis/channels';

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
export const TELEGRAM_SEND_TIMEOUT_MS = 10_000;
export const TELEGRAM_STALE_SENDING_SECONDS = 30;
export const TELEGRAM_DELIVERY_BATCH = 5;
export const TELEGRAM_SEND_PACING_MS = 1000;
export const TELEGRAM_DELIVERY_TOPIC = 'send_message';
export const TELEGRAM_DELIVERY_PAYLOAD_VERSION = 1;

export type TelegramDeliveryKind = 'final' | 'question' | 'command' | 'failure' | 'admin' | 'brief';

export interface TelegramDeliveryPayload {
  payload_version: 1;
  user_id: string;
  workspace_id: string;
  chat_id: string;
  bot_installation_id: string;
  telegram_user_id: string;
  telegram_chat_id: string;
  source_message_id: string;
  run_id: string | null;
  kind: TelegramDeliveryKind;
  /** Stable per-response key: run ID for finals, clarification ID for questions. */
  key: string;
  part_index: number;
  part_count: number;
  previous_part_id: string | null;
  clarification_id: string | null;
  text: string;
  /** Recorded Bot API message ID after a successful send (for reply routing). */
  telegram_message_id?: number | null;
  /**
   * Scheduled-brief reference (kind 'brief' only). The delivery row carries
   * no inbound source message, so the consumer revalidates against this
   * canonical brief row instead of a source update. Absent for reply kinds.
   */
  brief_id?: string | null;
}

export interface TelegramDeliveryTarget {
  botInstallationId: string;
  telegramUserId: string;
  telegramChatId: string;
}

/**
 * One bounded reader for persisted Telegram source payloads: plain updates
 * are their own source; envelopes carry the redacted update beside
 * metadata (`telegram.reply`, `telegram.result`, `telegram.clarification_id`).
 * Returns null pieces instead of guessing when parsing fails.
 */
export function parseTelegramRawPayload(rawPayload: unknown): {
  update: Record<string, unknown> | null;
  telegram: Record<string, unknown> | null;
} {
  try {
    const parsed = JSON.parse(String(rawPayload ?? '{}')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return { update: null, telegram: null };
    const telegram =
      parsed['telegram'] && typeof parsed['telegram'] === 'object'
        ? (parsed['telegram'] as Record<string, unknown>)
        : null;
    const inner =
      parsed['update'] && typeof parsed['update'] === 'object'
        ? (parsed['update'] as Record<string, unknown>)
        : null;
    return { update: inner ?? parsed, telegram };
  } catch {
    return { update: null, telegram: null };
  }
}

/**
 * Resolves the private-chat delivery target for a telegram source message.
 *
 * Exact source binding only: the Telegram sender ID comes from the stored
 * update itself, and the binding row must match BOTH that sender and the
 * source author user. A removed original binding can therefore never
 * receive data through a different surviving binding of the same user, and
 * legacy multiple bindings never retarget. The source row must be a
 * Telegram-channel message; anything else resolves to nothing.
 */
export async function resolveTelegramTarget(
  db: D1Database,
  sourceMessageId: string,
): Promise<TelegramDeliveryTarget | null> {
  const source = await db
    .prepare(`SELECT user_id, channel, external_id, raw_payload FROM messages_in WHERE id = ?`)
    .bind(sourceMessageId)
    .first<{ user_id: string | null; channel: string; external_id: string; raw_payload: string | null }>();
  if (!source || !source.user_id || source.channel !== 'telegram') return null;
  const installationId = String(source.external_id ?? '').split(':')[0] || '';
  if (!installationId) return null;
  const parsed = parseTelegramRawPayload(source.raw_payload);
  const message = parsed.update?.['message'] as
    | { from?: { id?: unknown }; chat?: { id?: unknown } }
    | undefined;
  const fromId = message?.from?.id;
  const chatRawId = message?.chat?.id;
  if (typeof fromId !== 'number' || !Number.isSafeInteger(fromId)) return null;
  if (typeof chatRawId !== 'number' || !Number.isSafeInteger(chatRawId)) return null;
  const senderId = String(fromId);
  // The binding must be the source sender's own current binding — never an
  // arbitrary first row for the user.
  const link = await db
    .prepare(`SELECT telegram_user_id FROM telegram_users WHERE telegram_user_id = ? AND user_id = ?`)
    .bind(senderId, String(source.user_id))
    .first<{ telegram_user_id: string }>();
  if (!link) return null;
  return { botInstallationId: installationId, telegramUserId: String(link.telegram_user_id), telegramChatId: String(chatRawId) };
}

/**
 * Revalidates a scheduled-brief delivery row immediately before send.
 * Briefs have no inbound source message, so there is no source update to
 * resolve: instead every persisted reference is rechecked — the canonical
 * brief row, current membership, the member's live Telegram binding, and
 * the still-selected telegram schedule channel. Any drift cancels instead
 * of sending. Returns the verified target or a bounded safe reason.
 */
export async function resolveBriefDeliveryTarget(
  db: D1Database,
  payload: TelegramDeliveryPayload,
  installationId: string,
): Promise<{ target: TelegramDeliveryTarget } | { error: string }> {
  if (!payload.brief_id) return { error: 'brief reference missing' };
  const brief = await db
    .prepare(`SELECT workspace_id, user_id, chat_id, status FROM briefs WHERE id = ?`)
    .bind(payload.brief_id)
    .first<{ workspace_id: string; user_id: string; chat_id: string | null; status: string }>();
  if (!brief || brief.workspace_id !== payload.workspace_id || brief.status !== 'ready') {
    return { error: 'brief no longer available' };
  }
  // The delivery must name the brief's own owner and chat: a row retargeted
  // to another member (or another chat) in the same workspace cancels here,
  // before any binding or schedule check could pass it.
  if (brief.user_id !== payload.user_id || brief.chat_id !== payload.chat_id) {
    return { error: 'brief delivery identity mismatch' };
  }
  const member = await db
    .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
    .bind(payload.workspace_id, payload.user_id)
    .first();
  if (!member) return { error: 'membership no longer valid' };
  const link = await db
    .prepare(
      `SELECT telegram_user_id FROM telegram_users
       WHERE telegram_user_id = ? AND user_id = ? AND selected_workspace_id = ?`,
    )
    .bind(payload.telegram_user_id, payload.user_id, payload.workspace_id)
    .first<{ telegram_user_id: string }>();
  if (!link) return { error: 'Telegram binding changed since this delivery was queued' };
  // Private-chat invariant: a brief intent never addresses another chat.
  if (payload.telegram_chat_id !== payload.telegram_user_id) {
    return { error: 'brief delivery target mismatch' };
  }
  const settings = await db
    .prepare(`SELECT brief_channel FROM member_settings WHERE workspace_id = ? AND user_id = ?`)
    .bind(payload.workspace_id, payload.user_id)
    .first<{ brief_channel: string }>();
  if (!settings || settings.brief_channel !== 'telegram') {
    return { error: 'telegram brief channel no longer selected' };
  }
  if (payload.bot_installation_id !== installationId) {
    return { error: 'bot installation changed since this delivery was queued' };
  }
  return {
    target: {
      botInstallationId: installationId,
      telegramUserId: payload.telegram_user_id,
      telegramChatId: payload.telegram_chat_id,
    },
  };
}

export interface TelegramDeliveryInput {
  workspaceId: string;
  userId: string;
  chatId: string;
  sourceMessageId: string;
  runId: string | null;
  kind: TelegramDeliveryKind;
  key: string;
  text: string;
  clarificationId?: string | null;
  /**
   * Canonical brief reference (kind 'brief' only): the consumer revalidates
   * scheduled delivery against this row instead of a source update.
   */
  briefId?: string | null;
  /**
   * Explicit routing target, for rows created in the same batch (link
   * redemption confirmation): resolution reads would not see uncommitted
   * rows, so the caller — which already verified everything — supplies it.
   */
  target?: TelegramDeliveryTarget;
}

/**
 * Builds deterministic delivery-row INSERTs (OR IGNORE on the immutable
 * identical key only) for one logical response, split into ordered parts.
 * Synchronous variant for callers that already hold a verified target and
 * run inside a synchronous composition callback (ledger extra statements).
 * Each part carries its own key plus the previous-part dependency; later
 * parts are never sent while an earlier part is unknown/failed.
 */
export function buildTelegramDeliveryStatements(
  db: D1Database,
  input: TelegramDeliveryInput & { target: TelegramDeliveryTarget },
): D1PreparedStatement[] {
  const parts = splitTelegramText(input.text);
  const now = new Date().toISOString();
  return parts.map((text, partIndex) => {
    const id = `tgdl_${input.sourceMessageId}_${input.kind}_${input.key}_${partIndex}`;
    const previousPartId = partIndex === 0 ? null : `tgdl_${input.sourceMessageId}_${input.kind}_${input.key}_${partIndex - 1}`;
    const payload: TelegramDeliveryPayload = {
      payload_version: TELEGRAM_DELIVERY_PAYLOAD_VERSION,
      user_id: input.userId,
      workspace_id: input.workspaceId,
      chat_id: input.chatId,
      bot_installation_id: input.target.botInstallationId,
      telegram_user_id: input.target.telegramUserId,
      telegram_chat_id: input.target.telegramChatId,
      source_message_id: input.sourceMessageId,
      run_id: input.runId,
      kind: input.kind,
      key: input.key,
      part_index: partIndex,
      part_count: parts.length,
      previous_part_id: previousPartId,
      clarification_id: input.clarificationId ?? null,
      brief_id: input.briefId ?? null,
      text,
      telegram_message_id: null,
    };
    return db.prepare(
      `INSERT OR IGNORE INTO outbox (id, workspace_id, destination, topic, payload_json, status, created_at, updated_at)
       VALUES (?, ?, 'telegram', ?, ?, 'pending', ?, ?)`,
    ).bind(id, input.workspaceId, TELEGRAM_DELIVERY_TOPIC, JSON.stringify(payload), now, now);
  });
}

/**
 * Resolves the target (or accepts an explicit one) and returns the ordered
 * delivery statements; no statements when the target cannot be proven.
 */
export async function buildTelegramDeliveryInserts(
  db: D1Database,
  input: TelegramDeliveryInput,
): Promise<D1PreparedStatement[]> {
  const target = input.target ?? (await resolveTelegramTarget(db, input.sourceMessageId));
  if (!target) return [];
  return buildTelegramDeliveryStatements(db, { ...input, target });
}

export type TelegramSendFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TelegramSendResult {
  ok: boolean;
  chatId?: number;
  messageId?: number;
  retryable?: boolean;
  retryAfterSeconds?: number;
  terminal?: boolean;
  reason?: string;
}

/**
 * One bounded sendMessage POST. Production base URL is pinned; tests inject
 * fetchFn. The token-bearing URL is never logged — only the chat ID and a
 * sanitized reason.
 */
export async function sendTelegramText(
  botToken: string,
  telegramChatId: string,
  text: string,
  replyMarkup: { force_reply?: true; selective?: true } | undefined,
  fetchFn: TelegramSendFetch = fetch,
  timeoutMs = TELEGRAM_SEND_TIMEOUT_MS,
): Promise<TelegramSendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        chat_id: telegramChatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
    // Parse the body regardless of HTTP status: Telegram reports real 429
    // and 403 responses with a JSON envelope, so classification must not be
    // shadowed by a non-2xx status. A 2xx carrying ok:true still requires
    // matching positive IDs; a non-2xx carrying ok:true (e.g. 5xx) proves
    // nothing and stays unknown.
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const parsed = (body ?? {}) as {
      ok?: unknown;
      result?: { message_id?: unknown; chat?: { id?: unknown } };
      error_code?: unknown;
      description?: unknown;
      parameters?: { retry_after?: unknown };
    };
    if (response.ok && parsed.ok === true) {
      const messageId = parsed.result?.message_id;
      const chatId = parsed.result?.chat?.id;
      if (
        typeof messageId === 'number' && Number.isSafeInteger(messageId) && messageId > 0 &&
        String(chatId) === String(telegramChatId)
      ) {
        return { ok: true, chatId: Number(chatId), messageId };
      }
      return { ok: false, reason: `Telegram response mismatch for chat ${telegramChatId}` };
    }
    if (response.ok) {
      return { ok: false, reason: `malformed Telegram response for chat ${telegramChatId}` };
    }
    // Non-2xx: only a matching explicit rejection envelope classifies the
    // failure — the HTTP status must equal a numeric ok:false error_code.
    // 5xx, inconsistent (e.g. HTTP 429 + ok:true, HTTP 500 + error_code
    // 429) and malformed envelopes stay unknown, never delivered/retried.
    const explicitRejection =
      parsed.ok === false &&
      typeof parsed.error_code === 'number' &&
      parsed.error_code === response.status;
    if (!explicitRejection) {
      return { ok: false, reason: sanitizeReason(`Telegram error ${response.status} for chat ${telegramChatId}`) };
    }
    const errorCode = response.status;
    const description = typeof parsed.description === 'string' ? parsed.description : 'rejected';
    if (errorCode === 429) {
      const retryAfter = parsed.parameters && typeof parsed.parameters.retry_after === 'number'
        ? Math.max(1, Math.floor(parsed.parameters.retry_after))
        : 1;
      return { ok: false, retryable: true, retryAfterSeconds: retryAfter, reason: sanitizeReason(`Telegram flood control (${description})`) };
    }
    if (errorCode === 400 || errorCode === 403) {
      return { ok: false, terminal: true, reason: sanitizeReason(`Telegram rejected (${errorCode}): ${description}`) };
    }
    return { ok: false, reason: sanitizeReason(`Telegram error ${errorCode} for chat ${telegramChatId}`) };
  } catch (err) {
    const reason = err instanceof Error ? err.name : String(err);
    return { ok: false, reason: sanitizeReason(`Telegram transport failure for chat ${telegramChatId}: ${reason}`) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reasons are persisted and may surface in logs/diagnostics: strip anything
 * shaped like a bot token so a token can never leak through an error string.
 */
function sanitizeReason(reason: string): string {
  return reason.replace(/bot\d+:[\w-]+/g, 'bot[redacted]');
}

export interface TelegramDeliverySummary {
  attempted: number;
  delivered: number;
  held: number;
  /**
   * Bounded delay until the next eligible delivery could succeed (multipart
   * continuation, retry deadline, per-chat pacing or batch-limit remainder),
   * or null when only unknown/failed/blocked/attempt-exhausted rows remain.
   * Production entrypoints publish one delayed queue hint with this delay;
   * blocked parts never qualify.
   */
  continuation_delay_seconds: number | null;
}

/**
 * Earliest safe wake for still-eligible Telegram work in scope, as a bounded
 * delay in seconds. Null when nothing can ever become eligible (blocked by
 * an unknown/failed predecessor, attempts exhausted, or no rows at all).
 */
export async function nextTelegramDeliveryWake(
  db: D1Database,
  options: { workspaceId?: string; nowIso?: string } = {},
): Promise<number | null> {
  const now = options.nowIso ?? new Date().toISOString();
  const scopeClause = options.workspaceId ? 'AND o.workspace_id = ?' : '';
  const scopeBinds = options.workspaceId ? [options.workspaceId] : [];
  const rows = (
    await db
      .prepare(
        `SELECT o.id, o.next_retry_at,
                (SELECT r.last_attempt_at FROM outbox r
                 WHERE r.destination = 'telegram'
                   AND json_extract(r.payload_json, '$.telegram_chat_id')
                     = json_extract(o.payload_json, '$.telegram_chat_id')
                   AND r.last_attempt_at IS NOT NULL
                 ORDER BY r.last_attempt_at DESC LIMIT 1) AS last_chat_attempt
         FROM outbox o
         WHERE o.destination = 'telegram' AND o.status = 'pending'
           AND o.attempt_count < o.max_attempts
           AND (
             json_extract(o.payload_json, '$.previous_part_id') IS NULL
             OR EXISTS (
               SELECT 1 FROM outbox prev
               WHERE prev.id = json_extract(o.payload_json, '$.previous_part_id')
                 AND prev.status = 'delivered'
             )
           ) ${scopeClause}
         ORDER BY o.created_at ASC LIMIT 50`,
      )
      .bind(...scopeBinds)
      .all<{ id: string; next_retry_at: string | null; last_chat_attempt: string | null }>()
  ).results ?? [];
  if (rows.length === 0) return null;

  const nowMs = Date.parse(now);
  let earliestMs: number | null = null;
  for (const row of rows) {
    let candidateMs = nowMs;
    if (row.next_retry_at) {
      const retryMs = Date.parse(row.next_retry_at);
      if (Number.isFinite(retryMs) && retryMs > candidateMs) candidateMs = retryMs;
    }
    if (row.last_chat_attempt) {
      const lastMs = Date.parse(row.last_chat_attempt);
      if (Number.isFinite(lastMs)) candidateMs = Math.max(candidateMs, lastMs + TELEGRAM_SEND_PACING_MS);
    }
    // Eligible right now means the batch limit (or a race) held it back:
    // continue shortly rather than waiting for the cron backstop.
    if (candidateMs <= nowMs) candidateMs = nowMs + 1_000;
    earliestMs = earliestMs === null ? candidateMs : Math.min(earliestMs, candidateMs);
  }
  if (earliestMs === null) return null;
  return Math.min(300, Math.max(1, Math.ceil((earliestMs - nowMs) / 1000)));
}

/**
 * Delivers due Telegram rows for one workspace (or all when omitted),
 * bounded to TELEGRAM_DELIVERY_BATCH items per invocation with one-second
 * pacing between sends. Stale sending rows with no recorded result become
 * outcome_unknown first; a late original sender cannot overwrite that
 * transition (claim-scoped updates everywhere).
 */
export async function deliverTelegramOutbox(
  db: D1Database,
  env: { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_BOT_INSTALLATION_ID?: string },
  options: {
    workspaceId?: string;
    limit?: number;
    fetchFn?: TelegramSendFetch;
    /** Fixed instant (tests) or omit for the live clock. */
    clock?: () => string;
  } = {},
): Promise<TelegramDeliverySummary> {
  // Fresh clock per operation: claims, retry deadlines and result
  // timestamps always reflect the actual moment, never invocation start.
  const clock = options.clock ?? (() => new Date().toISOString());
  const limit = Math.min(options.limit ?? TELEGRAM_DELIVERY_BATCH, TELEGRAM_DELIVERY_BATCH);
  const summary: TelegramDeliverySummary = { attempted: 0, delivered: 0, held: 0, continuation_delay_seconds: null };
  const scopeClause = options.workspaceId ? 'AND workspace_id = ?' : '';
  const scopeBinds = options.workspaceId ? [options.workspaceId] : [];

  // Stale sending rows with no recorded result: outcome_unknown, never resend.
  const staleCutoff = new Date(new Date(clock()).getTime() - TELEGRAM_STALE_SENDING_SECONDS * 1000).toISOString();
  await db
    .prepare(
      `UPDATE outbox SET status = 'outcome_unknown', last_error = ?, updated_at = ?
       WHERE destination = 'telegram' AND status = 'sending' AND last_attempt_at <= ? ${scopeClause}`,
    )
    .bind('send result never recorded', clock(), staleCutoff, ...scopeBinds)
    .run();

  // Due selection excludes stuck shapes BEFORE the limit so held rows cannot
  // starve ready ones: chats with an in-flight send or a send that finished
  // inside the pacing second (per-chat one-per-second across consumers
  // without a lock service), later parts whose predecessor is not delivered,
  // and rows past their attempt bound.
  const pacingCutoff = new Date(new Date(clock()).getTime() - TELEGRAM_SEND_PACING_MS).toISOString();
  const due = (
    await db
      .prepare(
        `SELECT o.id, o.workspace_id, o.payload_json, o.attempt_count, o.max_attempts FROM outbox o
         WHERE o.destination = 'telegram' AND o.status = 'pending'
           AND (o.next_retry_at IS NULL OR o.next_retry_at <= ?) ${scopeClause}
           AND o.attempt_count < o.max_attempts
           AND NOT EXISTS (
             SELECT 1 FROM outbox busy
             WHERE busy.destination = 'telegram' AND busy.status = 'sending'
               AND json_extract(busy.payload_json, '$.telegram_chat_id')
                 = json_extract(o.payload_json, '$.telegram_chat_id')
           )
           AND NOT EXISTS (
             SELECT 1 FROM outbox recent
             WHERE recent.destination = 'telegram'
               AND recent.last_attempt_at IS NOT NULL
               AND recent.last_attempt_at > ?
               AND json_extract(recent.payload_json, '$.telegram_chat_id')
                 = json_extract(o.payload_json, '$.telegram_chat_id')
           )
           AND (
             json_extract(o.payload_json, '$.previous_part_id') IS NULL
             OR EXISTS (
               SELECT 1 FROM outbox prev
               WHERE prev.id = json_extract(o.payload_json, '$.previous_part_id')
                 AND prev.status = 'delivered'
             )
           )
         ORDER BY o.created_at ASC, o.id ASC LIMIT ?`,
      )
      .bind(clock(), ...scopeBinds, pacingCutoff, limit)
      .all<Record<string, unknown>>()
  ).results ?? [];

  let sendsDone = 0;
  for (const row of due) {
    const id = String(row['id']);
    let payload: TelegramDeliveryPayload;
    try {
      payload = JSON.parse(String(row['payload_json'] ?? '')) as TelegramDeliveryPayload;
      if (!payload || payload.payload_version !== TELEGRAM_DELIVERY_PAYLOAD_VERSION || !payload.text) throw new Error('bad payload');
    } catch {
      await db
        .prepare(`UPDATE outbox SET status = 'failed_known', last_error = ?, updated_at = ? WHERE id = ?`)
        .bind('invalid persisted delivery payload', clock(), id)
        .run();
      continue;
    }
    summary.attempted += 1;
    const claimId = `dlv_${crypto.randomUUID()}`;
    // The claim rechecks retry eligibility, the attempt bound AND the
    // per-chat exclusivity/pacing at claim time: two overlapping consumers
    // cannot both claim rows for the same private chat even though both saw
    // them eligible in their pre-claim SELECT.
    const claimedAt = clock();
    const claimPacingCutoff = new Date(new Date(claimedAt).getTime() - TELEGRAM_SEND_PACING_MS).toISOString();
    const claimed = await db
      .prepare(
        `UPDATE outbox SET status = 'sending', claimed_by = ?, last_attempt_at = ?, attempt_count = attempt_count + 1, updated_at = ?
         WHERE id = ? AND status = 'pending'
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
           AND attempt_count < max_attempts
           AND NOT EXISTS (
             SELECT 1 FROM outbox busy
             WHERE busy.destination = 'telegram' AND busy.status = 'sending'
               AND busy.id <> outbox.id
               AND json_extract(busy.payload_json, '$.telegram_chat_id')
                 = json_extract(outbox.payload_json, '$.telegram_chat_id')
           )
           AND NOT EXISTS (
             SELECT 1 FROM outbox recent
             WHERE recent.destination = 'telegram'
               AND recent.id <> outbox.id
               AND recent.last_attempt_at IS NOT NULL
               AND recent.last_attempt_at > ?
               AND json_extract(recent.payload_json, '$.telegram_chat_id')
                 = json_extract(outbox.payload_json, '$.telegram_chat_id')
           )`,
      )
      .bind(claimId, claimedAt, claimedAt, id, claimedAt, claimPacingCutoff)
      .run();
    if ((claimed.meta.changes ?? 0) !== 1) continue;
    // Attempt count from the live row, never the stale pre-claim SELECT.
    const attempts = Number(
      (await db.prepare(`SELECT attempt_count FROM outbox WHERE id = ?`).bind(id).first<{ attempt_count: number }>())
        ?.attempt_count ?? 1,
    );
    const maxAttempts = Number(row['max_attempts'] ?? 3);

    // Re-resolve identity, membership, chat and destination right before
    // exposing business content. Never retarget from current selections.
    // Context-free administrative replies (empty workspace/user: generic
    // guidance with no business data) skip these checks — there is no
    // binding that could have gone stale, and the destination below is
    // still revalidated against the original source.
    if (payload.workspace_id && payload.user_id) {
      const member = await db
        .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
        .bind(payload.workspace_id, payload.user_id)
        .first();
      const chatOk = payload.chat_id
        ? await db
          .prepare(`SELECT 1 FROM chats WHERE id = ? AND workspace_id = ? AND author_user_id = ?`)
          .bind(payload.chat_id, payload.workspace_id, payload.user_id)
          .first()
        : null;
      if (!member || (payload.chat_id && !chatOk)) {
        await db
          .prepare(`UPDATE outbox SET status = 'cancelled', last_error = ?, updated_at = ? WHERE id = ? AND status = 'sending' AND claimed_by = ?`)
          .bind('identity, membership, or chat no longer valid', clock(), id, claimId)
          .run();
        continue;
      }
    }
    // Destination revalidation against the original source (not the mutable
    // payload): a removed or replaced binding cancels instead of leaking.
    // Context-free administrative replies carry no workspace/user binding;
    // their destination is verified against the source update itself.
    let sendChatId = payload.telegram_chat_id;
    if (payload.kind === 'brief') {
      // Scheduled briefs carry no inbound source message: revalidate the
      // canonical brief row, membership, live binding and chosen channel.
      const installationId = env.TELEGRAM_BOT_INSTALLATION_ID ?? 'otis_bot';
      const resolved = await resolveBriefDeliveryTarget(db, payload, installationId);
      if ('error' in resolved) {
        await db
          .prepare(`UPDATE outbox SET status = 'cancelled', last_error = ?, updated_at = ? WHERE id = ? AND status = 'sending' AND claimed_by = ?`)
          .bind(`Brief delivery no longer valid: ${resolved.error}`, clock(), id, claimId)
          .run();
        continue;
      }
      sendChatId = resolved.target.telegramChatId;
    } else if (payload.workspace_id && payload.user_id) {
      const member = await db
        .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
        .bind(payload.workspace_id, payload.user_id)
        .first();
      if (!member) {
        await db
          .prepare(`UPDATE outbox SET status = 'cancelled', last_error = ?, updated_at = ? WHERE id = ? AND status = 'sending' AND claimed_by = ?`)
          .bind('Workspace membership revoked since this delivery was queued', clock(), id, claimId)
          .run();
        continue;
      }
      const target = await resolveTelegramTarget(db, payload.source_message_id);
      if (
        !target ||
        target.telegramUserId !== payload.telegram_user_id ||
        target.telegramChatId !== payload.telegram_chat_id ||
        target.botInstallationId !== payload.bot_installation_id
      ) {
        await db
          .prepare(`UPDATE outbox SET status = 'cancelled', last_error = ?, updated_at = ? WHERE id = ? AND status = 'sending' AND claimed_by = ?`)
          .bind('Telegram binding changed since this delivery was queued', clock(), id, claimId)
          .run();
        continue;
      }
      sendChatId = target.telegramChatId;
    } else {
      const source = await db
        .prepare(`SELECT raw_payload FROM messages_in WHERE id = ?`)
        .bind(payload.source_message_id)
        .first<{ raw_payload: string | null }>();
      const parsedSource = parseTelegramRawPayload(source?.raw_payload);
      const sourceMessage = parsedSource.update?.['message'] as { chat?: { id?: unknown } } | undefined;
      const sourceChatRaw = sourceMessage?.chat?.id;
      const sourceChatId = typeof sourceChatRaw === 'number' && Number.isSafeInteger(sourceChatRaw)
        ? String(sourceChatRaw)
        : '';
      if (!sourceChatId || sourceChatId !== payload.telegram_chat_id) {
        await db
          .prepare(`UPDATE outbox SET status = 'cancelled', last_error = ?, updated_at = ? WHERE id = ? AND status = 'sending' AND claimed_by = ?`)
          .bind('Telegram destination no longer matches its source update', clock(), id, claimId)
          .run();
        continue;
      }
    }

    const botToken = env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      await db
        .prepare(`UPDATE outbox SET status = 'failed_known', last_error = ?, updated_at = ? WHERE id = ? AND status = 'sending' AND claimed_by = ?`)
        .bind('Telegram bot token not configured', clock(), id, claimId)
        .run();
      continue;
    }

    // One private-chat send per second between consecutive HTTP attempts.
    if (sendsDone > 0) await new Promise((resolve) => setTimeout(resolve, TELEGRAM_SEND_PACING_MS));
    const sent = await sendTelegramText(
      botToken,
      sendChatId,
      payload.text,
      replyMarkupForPart(payload.kind === 'question', payload.part_index === payload.part_count - 1),
      options.fetchFn,
    );
    // Result timestamps come from AFTER the send returned: a slow request
    // must never backdate its own retry deadline or recorded outcome.
    const resultAt = clock();
    sendsDone += 1;
    if (sent.ok) {
      const recorded = await db
        .prepare(
          `UPDATE outbox SET status = 'delivered', last_attempt_at = ?, updated_at = ?, payload_json = ? WHERE id = ?
           AND status = 'sending' AND claimed_by = ?`,
        )
        .bind(
          resultAt,
          resultAt,
          JSON.stringify({ ...payload, telegram_message_id: sent.messageId ?? null }),
          id,
          claimId,
        )
        .run();
      if ((recorded.meta.changes ?? 0) === 1) {
        summary.delivered += 1;
      }
      // changes === 0 means recovery already transitioned this row (e.g. to
      // outcome_unknown): the send happened but is honestly left unrecorded
      // rather than resurrecting a settled row.
      continue;
    }
    if (sent.terminal) {
      await db
        .prepare(`UPDATE outbox SET status = 'failed_known', last_error = ?, updated_at = ? WHERE id = ? AND status = 'sending' AND claimed_by = ?`)
        .bind(sent.reason ?? 'rejected', clock(), id, claimId)
        .run();
      continue;
    }
    if (sent.retryable) {
      if (attempts >= maxAttempts) {
        await db
          .prepare(`UPDATE outbox SET status = 'failed_known', last_error = ?, updated_at = ? WHERE id = ? AND status = 'sending' AND claimed_by = ?`)
          .bind(sent.reason ?? 'retry budget exhausted', clock(), id, claimId)
          .run();
        continue;
      }
      // Retry deadline from the actual response time, not invocation start.
      const retryAt = new Date(new Date(resultAt).getTime() + (sent.retryAfterSeconds ?? 1) * 1000).toISOString();
      await db
        .prepare(`UPDATE outbox SET status = 'pending', last_error = ?, next_retry_at = ?, updated_at = ? WHERE id = ? AND status = 'sending' AND claimed_by = ?`)
        .bind(sent.reason ?? 'retrying', retryAt, clock(), id, claimId)
        .run();
      continue;
    }
    await db
      .prepare(`UPDATE outbox SET status = 'outcome_unknown', last_error = ?, updated_at = ? WHERE id = ? AND status = 'sending' AND claimed_by = ?`)
      .bind(sent.reason ?? 'unknown outcome', clock(), id, claimId)
      .run();
  }
  summary.continuation_delay_seconds = await nextTelegramDeliveryWake(db, {
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    nowIso: clock(),
  }).catch(() => null);
  return summary;
}

/**
 * Bounded scan for workspaces with due Telegram deliveries: pending rows
 * past their retry time AND stale sending rows a terminal run left behind
 * (a run that already finished will never invoke stale cleanup itself, so
 * cron must discover them). Agent dispatch rows are discovered separately.
 */
export async function scanTelegramDue(db: D1Database, limit = 25): Promise<string[]> {
  const now = new Date().toISOString();
  const staleCutoff = new Date(new Date(now).getTime() - TELEGRAM_STALE_SENDING_SECONDS * 1000).toISOString();
  const rows = (
    await db
      .prepare(
        `SELECT DISTINCT workspace_id FROM outbox
         WHERE destination = 'telegram'
           AND (
             (status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?))
             OR (status = 'sending' AND last_attempt_at <= ?)
           )
         ORDER BY workspace_id ASC LIMIT ?`,
      )
      .bind(now, staleCutoff, limit)
      .all<{ workspace_id: string }>()
  ).results ?? [];
  return rows.map((row) => String(row['workspace_id']));
}
