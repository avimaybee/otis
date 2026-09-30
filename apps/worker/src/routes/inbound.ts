/**
 * @otis/worker/routes/inbound
 * Telegram webhook inbound router.
 * In accordance with docs/contracts.md and plans/004-inbound-routing.md.
 */

import { validateTelegramWebhookSecret } from '@otis/channels';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { acceptTelegramInbound } from '../inbox/telegram.js';

export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!expectedSecret || expectedSecret.trim().length === 0) {
    return jsonError(
      503,
      'service_unavailable',
      'Telegram webhook endpoint is disabled because TELEGRAM_WEBHOOK_SECRET is not configured.',
      requestId,
    );
  }

  const secretHeader = request.headers.get('x-telegram-bot-api-secret-token');
  if (!validateTelegramWebhookSecret(secretHeader, expectedSecret)) {
    return jsonError(401, 'unauthorized', 'Invalid Telegram webhook secret token.', requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'bad_request', 'Invalid JSON body.', requestId);
  }

  const botInstallationId = env.TELEGRAM_BOT_INSTALLATION_ID || 'otis_bot';

  try {
    const result = await acceptTelegramInbound(env.DB, botInstallationId, body);
    return jsonSuccess(result, 200, { 'x-request-id': requestId });
  } catch (err) {
    return jsonError(
      500,
      'internal_error',
      `Failed to process Telegram update: ${String(err)}`,
      requestId,
    );
  }
}
