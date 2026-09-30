/**
 * @otis/channels/telegram
 * Telegram update normalization, webhook secret verification, and media inspection.
 * In accordance with docs/contracts.md and plans/004-inbound-routing.md.
 */

export interface TelegramUserObject {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChatObject {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TelegramMessageObject {
  message_id: number;
  from?: TelegramUserObject;
  chat: TelegramChatObject;
  date: number;
  text?: string;
  caption?: string;
  photo?: unknown[];
  location?: unknown;
  document?: unknown;
  video?: unknown;
  voice?: unknown;
  audio?: unknown;
  contact?: unknown;
  sticker?: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessageObject;
}

export type TelegramMessageKind =
  | 'text'
  | 'voice'
  | 'start_command'
  | 'unsupported_media_only'
  | 'unsupported_media_with_text';

export interface NormalizedTelegramUpdate {
  updateId: number;
  externalId: string; // `${botInstallationId}:${update_id}`
  botInstallationId: string;
  telegramUserId: string;
  isPrivateChat: boolean;
  kind: TelegramMessageKind;
  text?: string;
  startCode?: string;
  unsupportedMediaTypes: string[];
  rawUpdate: unknown;
}

/**
 * Validates Telegram webhook secret token header.
 */
export function validateTelegramWebhookSecret(
  headerSecret: string | null,
  expectedSecret?: string,
): boolean {
  if (!expectedSecret || expectedSecret.trim().length === 0) {
    // Missing deployment variable disables endpoint (fail closed)
    return false;
  }
  if (!headerSecret) {
    return false;
  }
  return headerSecret === expectedSecret;
}

/**
 * Normalizes an incoming Telegram update with strict bot installation scoping,
 * private chat validation, and media categorization.
 */
export function normalizeTelegramUpdate(
  update: unknown,
  botInstallationId: string,
): NormalizedTelegramUpdate {
  if (!update || typeof update !== 'object') {
    throw new Error('Invalid Telegram update: payload must be an object.');
  }

  const u = update as TelegramUpdate;
  if (typeof u.update_id !== 'number') {
    throw new Error('Invalid Telegram update: missing or invalid update_id.');
  }

  if (!u.message || typeof u.message !== 'object') {
    throw new Error('Unsupported Telegram update: only direct messages are supported.');
  }

  const msg = u.message;
  const isPrivate = msg.chat && msg.chat.type === 'private';
  const telegramUserId = msg.from ? String(msg.from.id) : '';

  if (!telegramUserId) {
    throw new Error('Invalid Telegram update: message missing sender information.');
  }

  const externalId = `${botInstallationId}:${u.update_id}`;

  // Check for unsupported media
  const unsupportedMediaTypes: string[] = [];
  if (Array.isArray(msg.photo) && msg.photo.length > 0) unsupportedMediaTypes.push('photo');
  if (msg.location) unsupportedMediaTypes.push('location');
  if (msg.document) unsupportedMediaTypes.push('document');
  if (msg.video) unsupportedMediaTypes.push('video');
  if (msg.contact) unsupportedMediaTypes.push('contact');
  if (msg.sticker) unsupportedMediaTypes.push('sticker');

  const textContent = msg.text || msg.caption || '';
  const trimmedText = textContent.trim();

  // Check for /start <code> account link command
  if (trimmedText.startsWith('/start')) {
    const parts = trimmedText.split(/\s+/);
    const startCode = parts[1] || '';
    return {
      updateId: u.update_id,
      externalId,
      botInstallationId,
      telegramUserId,
      isPrivateChat: isPrivate,
      kind: 'start_command',
      text: trimmedText,
      startCode: startCode.length > 0 ? startCode : undefined,
      unsupportedMediaTypes,
      rawUpdate: update,
    };
  }

  // Handle unsupported media
  if (unsupportedMediaTypes.length > 0) {
    if (trimmedText.length > 0) {
      return {
        updateId: u.update_id,
        externalId,
        botInstallationId,
        telegramUserId,
        isPrivateChat: isPrivate,
        kind: 'unsupported_media_with_text',
        text: trimmedText,
        unsupportedMediaTypes,
        rawUpdate: update,
      };
    }
    return {
      updateId: u.update_id,
      externalId,
      botInstallationId,
      telegramUserId,
      isPrivateChat: isPrivate,
      kind: 'unsupported_media_only',
      unsupportedMediaTypes,
      rawUpdate: update,
    };
  }

  if (msg.voice || msg.audio) {
    return {
      updateId: u.update_id,
      externalId,
      botInstallationId,
      telegramUserId,
      isPrivateChat: isPrivate,
      kind: 'voice',
      text: trimmedText.length > 0 ? trimmedText : undefined,
      unsupportedMediaTypes,
      rawUpdate: update,
    };
  }

  return {
    updateId: u.update_id,
    externalId,
    botInstallationId,
    telegramUserId,
    isPrivateChat: isPrivate,
    kind: 'text',
    text: trimmedText,
    unsupportedMediaTypes,
    rawUpdate: update,
  };
}
