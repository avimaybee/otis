/**
 * @otis/worker/routes/inbound
 * Telegram webhook inbound router.
 * In accordance with docs/contracts.md and plans/004-inbound-routing.md.
 *
 * 009A additions: the conversational route requires the server bot token
 * (replies are the point of the route; without it the endpoint truthfully
 * reports itself disabled) and publishes best-effort wake-ups for dispatch
 * and durable Telegram deliveries after acceptance. The link/start
 * administrative path is covered by the same helper, so an unrouted /start
 * still gets its single bounded confirmation without a retry loop.
 */

import { validateTelegramWebhookSecret } from '@otis/channels';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import { acceptTelegramInbound } from '../inbox/telegram.js';
import { deliverTelegramOutbox, sendTelegramChatAction } from '../inbox/telegramDelivery.js';
import { publishDispatchHint, publishTelegramDeliveryHint } from '../dispatchHint.js';
import { processTranscriptionJobs, scheduleNextTranscriptionWake } from '../media/transcription.js';
import { extractPlatformKeys } from '../providers/service.js';

export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  requestId: string,
  ctx?: ExecutionContext,
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

  // Conversational acceptance is only meaningful when replies can be sent.
  // Truthful disabled state; no updates are consumed without a reply path.
  if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN.trim().length === 0) {
    return jsonError(
      503,
      'service_unavailable',
      'Telegram messaging is disabled because TELEGRAM_BOT_TOKEN is not configured.',
      requestId,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'bad_request', 'Invalid JSON body.', requestId);
  }

  const botInstallationId = env.TELEGRAM_BOT_INSTALLATION_ID || 'otis_bot';

  try {
    const result = await acceptTelegramInbound(env.DB, botInstallationId, body, {
      botUsername: env.TELEGRAM_BOT_USERNAME,
      botToken: env.TELEGRAM_BOT_TOKEN,
      // Production dials the bounded adapter for the workspace-less
      // administrative exception. Test environments never contact Telegram:
      // synthetic transports are injected by tests that need that path.
      adminTransport: env.ENVIRONMENT === 'test' ? undefined : fetch,
      storage: env.STORAGE,
      fileTransport: env.ENVIRONMENT === 'test' ? undefined : fetch,
      platformKeys: extractPlatformKeys(env),
    });
    // Voice acceptance creates a durable transcription intent; run a bounded
    // best-effort pass so Telegram notes also land without waiting for cron.
    if (result.status === 'accepted' && result.workspace_id && env.STORAGE && env.ENVIRONMENT !== 'test') {
      const pass = processTranscriptionJobs(env.DB, env.STORAGE, {
        workspaceId: result.workspace_id,
        ...(env.CREDENTIALS_KEY ? { wrappingKeyMaterial: env.CREDENTIALS_KEY } : {}),
        ...(env.GROQ_API_KEY ? { platformApiKey: env.GROQ_API_KEY } : {}),
        limit: 2,
      }).then(async (outcome) => {
        // A deferred retry with no wake behind it would sleep until the cron
        // sweep: anchor the follow-up to the job's own durable due instant.
        if (outcome && outcome.deferred > 0) {
          await scheduleNextTranscriptionWake({ db: env.DB, queue: env.DISPATCH_QUEUE }, result.workspace_id!);
        }
      }).catch(() => undefined);
      if (ctx) ctx.waitUntil(pass);
      else void pass;
      // Transcription precedes dispatch and can outlast one typing lifetime:
      // refresh while the bounded pass runs (capped), then let the dispatch
      // heartbeat take over. Best-effort; never fails acceptance.
      if (ctx && env.TELEGRAM_BOT_TOKEN) {
        const voiceChatId = (body as { message?: { chat?: { id?: number | string } } })?.message?.chat?.id;
        if (voiceChatId) {
          const voiceToken = env.TELEGRAM_BOT_TOKEN;
          let voicePings = 0;
          const voiceTimer = setInterval(() => {
            voicePings += 1;
            if (voicePings > 7) {
              clearInterval(voiceTimer);
              return;
            }
            void sendTelegramChatAction(voiceToken, voiceChatId, 'typing', fetch).catch(() => undefined);
          }, 4000);
          void pass.then(
            () => clearInterval(voiceTimer),
            () => clearInterval(voiceTimer),
          );
        }
      }
    }
    // Show Telegram native typing indicator so user sees the bot working immediately
    if (result.status === 'accepted' && env.TELEGRAM_BOT_TOKEN) {
      const tgChatId = (body as { message?: { chat?: { id?: number | string } } })?.message?.chat?.id;
      if (tgChatId && ctx) {
        ctx.waitUntil(
          sendTelegramChatAction(
            env.TELEGRAM_BOT_TOKEN,
            tgChatId,
            'typing',
            env.ENVIRONMENT === 'test' ? undefined : fetch,
          ).catch(() => undefined),
        );
      }
    }
    // The work is already durable; hints are never load-bearing. A lost hint
    // is covered by the cron sweep, and delivery claims are idempotent.
    if (result.status === 'accepted' && result.run_id && result.workspace_id) {
      publishDispatchHint(ctx, env, result.workspace_id);
    }
    publishTelegramDeliveryHint(ctx, env, result.workspace_id);
    if (result.status === 'accepted' && result.workspace_id && env.TELEGRAM_BOT_TOKEN && ctx && env.ENVIRONMENT !== 'test') {
      ctx.waitUntil(
        deliverTelegramOutbox(env.DB, env, {
          workspaceId: result.workspace_id,
          limit: 5,
        }).catch(() => undefined),
      );
    }
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
