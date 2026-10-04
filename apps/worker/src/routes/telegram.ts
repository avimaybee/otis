/**
 * Telegram connection routes (009A guided linking).
 *
 * POST /api/workspaces/:workspaceId/telegram/link mints a one-time deep
 * link binding the caller's trusted identity and the workspace they chose
 * on web (requested_workspace_id). Only the SHA-256 hash is persisted
 * (ten-minute expiry, single use); the raw code is returned once and never
 * stored, logged, or echoed by any other surface. Reads never mint.
 *
 * GET  /api/workspaces/:workspaceId/telegram/connection returns a
 * read-only, zero-write status for the session user only.
 * DELETE .../connection disconnects that same user's own binding(s) in one
 * guarded batch: unused codes invalidated, not-yet-started deliveries
 * cancelled, delivered history untouched. Never another member's.
 */

import type {
  TelegramConnectionEntry,
  TelegramConnectionResponse,
  TelegramDisconnectResponse,
  TelegramLinkResponse,
} from '@otis/contracts';
import { sha256 } from '@otis/identity';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { pathSegment, requireWorkspaceScope } from './scope.js';

/** 24 random bytes render as exactly 32 unpadded base64url characters. */
export function mintLinkCode(randomBytes: Uint8Array = crypto.getRandomValues(new Uint8Array(24))): string {
  let binary = '';
  for (const byte of randomBytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_');
}

/** Operator provisioning present for both linking and replies. */
function telegramAvailable(env: Env): boolean {
  const username = (env.TELEGRAM_BOT_USERNAME ?? '').trim().replace(/^@/, '');
  const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  return username.length > 0 && token.length > 0;
}

export async function handleIssueTelegramLink(
  request: Request,
  env: Env,
  rawWorkspaceId: string,
  requestId: string,
): Promise<Response> {
  const workspaceId = pathSegment(rawWorkspaceId);
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;

  const username = (env.TELEGRAM_BOT_USERNAME ?? '').trim().replace(/^@/, '');
  if (!telegramAvailable(env) || !username) {
    return jsonError(503, 'service_unavailable', 'Telegram linking is not configured for this deployment.', requestId);
  }

  const code = mintLinkCode();
  const codeHash = await sha256(code);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  try {
    // Explicit generation invalidates this user's prior unused codes in the
    // same batch; the insert records the trusted workspace intent.
    await env.DB.batch([
      env.DB
        .prepare(`UPDATE link_codes SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL`)
        .bind(now, scope.user.id),
      env.DB
        .prepare(
          `INSERT INTO link_codes (id, code_hash, user_id, requested_workspace_id, created_at, expires_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .bind(`lc_${crypto.randomUUID()}`, codeHash, scope.user.id, workspaceId, now, expiresAt),
    ]);
  } catch {
    return jsonError(500, 'internal_error', 'Could not issue a Telegram link. Retry shortly.', requestId);
  }

  const body: TelegramLinkResponse = {
    status: 'ok',
    deep_link: `https://t.me/${username}?start=${code}`,
    expires_at: expiresAt,
  };
  return jsonSuccess(body, 200, { 'x-request-id': requestId, 'Cache-Control': 'no-store' });
}

/**
 * Read-only status for the session user's own Telegram connection(s).
 * Zero writes (no last_seen, no link-code or status mutation). Routing
 * workspace names are returned only while the caller still holds
 * membership there; numeric Telegram IDs and codes are never included.
 */
export async function handleGetTelegramConnection(
  request: Request,
  env: Env,
  rawWorkspaceId: string,
  requestId: string,
): Promise<Response> {
  const workspaceId = pathSegment(rawWorkspaceId);
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;

  const bindings = (
    await env.DB
      .prepare(
        `SELECT telegram_user_id, selected_workspace_id FROM telegram_users
         WHERE user_id = ? ORDER BY created_at ASC LIMIT 10`,
      )
      .bind(scope.user.id)
      .all<{ telegram_user_id: string; selected_workspace_id: string | null }>()
  ).results ?? [];

  const connections: TelegramConnectionEntry[] = [];
  let routing: { id: string; name: string } | null = null;
  for (const binding of bindings) {
    let routingWorkspace: { id: string; name: string } | null = null;
    if (binding.selected_workspace_id) {
      const ws = await env.DB
        .prepare(
          `SELECT w.id, w.name FROM workspaces w
           JOIN workspace_users wu ON wu.workspace_id = w.id AND wu.user_id = ?
           WHERE w.id = ?`,
        )
        .bind(scope.user.id, binding.selected_workspace_id)
        .first<{ id: string; name: string }>();
      if (ws) routingWorkspace = { id: String(ws.id), name: String(ws.name) };
    }
    connections.push({ routing_workspace: routingWorkspace });
    if (!routing && routingWorkspace) routing = routingWorkspace;
  }

  const state: TelegramConnectionResponse['state'] =
    connections.length === 0 ? 'disconnected' : routing ? 'connected' : 'routing_needed';

  const body: TelegramConnectionResponse = {
    status: 'ok',
    available: telegramAvailable(env),
    state,
    routing_workspace: routing,
    connections,
  };
  return jsonSuccess(body, 200, { 'x-request-id': requestId, 'Cache-Control': 'no-store' });
}

/**
 * Disconnects the session user's own Telegram connection(s). Guarded:
 * membership failure aborts the whole batch. Unused link codes are
 * invalidated and pending (not-yet-started) deliveries cancelled; sent
 * outcomes and workspace data stay untouched. Idempotent.
 */
export async function handleDeleteTelegramConnection(
  request: Request,
  env: Env,
  rawWorkspaceId: string,
  requestId: string,
): Promise<Response> {
  const workspaceId = pathSegment(rawWorkspaceId);
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;

  const userId = scope.user.id;
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB
        .prepare(`INSERT INTO acceptance_guards (id, guard_ok) VALUES (?, (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?))`)
        .bind(`guard_${crypto.randomUUID()}`, workspaceId, userId),
      env.DB.prepare(`UPDATE link_codes SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL`).bind(now, userId),
      env.DB
        .prepare(
          `UPDATE outbox SET status = 'cancelled', last_error = ?, updated_at = ?
           WHERE destination = 'telegram' AND status = 'pending'
             AND json_extract(payload_json, '$.user_id') = ?`,
        )
        .bind('Telegram disconnected by the account owner', now, userId),
      env.DB.prepare(`DELETE FROM telegram_users WHERE user_id = ?`).bind(userId),
    ]);
  } catch {
    return jsonError(500, 'internal_error', 'Could not disconnect Telegram. Try again.', requestId);
  }

  const body: TelegramDisconnectResponse = { status: 'ok', state: 'disconnected' };
  return jsonSuccess(body, 200, { 'x-request-id': requestId, 'Cache-Control': 'no-store' });
}
