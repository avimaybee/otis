/**
 * @otis/channels/telegram
 * Telegram update normalization, webhook secret verification, and media inspection.
 * In accordance with docs/contracts.md and docs/archive/plans/004-inbound-routing.md.
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

export interface TelegramLocationObject {
  latitude: number;
  longitude: number;
  horizontal_accuracy?: number;
  live_period?: number;
  heading?: number;
  proximity_alert_radius?: number;
}

export interface TelegramVenueObject {
  location: TelegramLocationObject;
  title: string;
  address: string;
  foursquare_id?: string;
  foursquare_type?: string;
  google_place_id?: string;
  google_place_type?: string;
}

export interface TelegramMessageObject {
  message_id: number;
  from?: TelegramUserObject;
  chat: TelegramChatObject;
  date: number;
  text?: string;
  caption?: string;
  photo?: unknown[];
  location?: TelegramLocationObject;
  venue?: TelegramVenueObject;
  document?: unknown;
  video?: unknown;
  voice?: unknown;
  audio?: unknown;
  contact?: unknown;
  sticker?: unknown;
}

export interface TelegramCallbackQueryObject {
  id: string;
  from: TelegramUserObject;
  message?: TelegramMessageObject;
  inline_message_id?: string;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessageObject;
  callback_query?: TelegramCallbackQueryObject;
}

export type TelegramMessageKind =
  | 'text'
  | 'voice'
  | 'location'
  | 'start_command'
  | 'callback_query'
  | 'unsupported_media_only'
  | 'unsupported_media_with_text';

export interface NormalizedTelegramUpdate {
  updateId: number;
  externalId: string; // `${botInstallationId}:${update_id}`
  botInstallationId: string;
  telegramUserId: string;
  /** Canonical numeric chat ID as an opaque string. Never a username or address. */
  telegramChatId: string;
  /** Canonical numeric message ID as an opaque string. */
  telegramMessageId: string;
  /** True when the sender is another bot: never conversational input. */
  senderIsBot: boolean;
  /** Canonical numeric ID of the replied-to message, when this is a native reply. */
  replyToMessageId: string | null;
  isPrivateChat: boolean;
  kind: TelegramMessageKind;
  text?: string;
  startCode?: string;
  callbackQueryId?: string;
  callbackData?: string;
  location?: TelegramLocationObject;
  venue?: TelegramVenueObject;
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

  if (u.callback_query && typeof u.callback_query === 'object') {
    const cb = u.callback_query;
    const telegramUserId = cb.from ? String(cb.from.id) : '';
    if (!telegramUserId) {
      throw new Error('Invalid Telegram update: callback_query missing sender information.');
    }
    const senderIsBot = cb.from?.is_bot === true;
    const msg = cb.message;
    const telegramChatId = msg && typeof msg.chat?.id === 'number' ? String(msg.chat.id) : telegramUserId;
    const telegramMessageId = msg && typeof msg.message_id === 'number' ? String(msg.message_id) : '';
    const isPrivate = msg?.chat ? msg.chat.type === 'private' : true;
    const externalId = `${botInstallationId}:${u.update_id}`;

    return {
      updateId: u.update_id,
      externalId,
      botInstallationId,
      telegramUserId,
      telegramChatId,
      telegramMessageId,
      senderIsBot,
      replyToMessageId: null,
      isPrivateChat: isPrivate,
      kind: 'callback_query',
      callbackQueryId: cb.id,
      callbackData: cb.data || '',
      text: cb.data || '',
      unsupportedMediaTypes: [],
      rawUpdate: update,
    };
  }

  if (!u.message || typeof u.message !== 'object') {
    throw new Error('Unsupported Telegram update: only direct messages and callback queries are supported.');
  }

  const msg = u.message;
  const isPrivate = msg.chat && msg.chat.type === 'private';
  const telegramUserId = msg.from ? String(msg.from.id) : '';
  const telegramChatId = msg.chat && typeof msg.chat.id === 'number' ? String(msg.chat.id) : '';
  const telegramMessageId = typeof msg.message_id === 'number' ? String(msg.message_id) : '';
  const senderIsBot = msg.from?.is_bot === true;
  const replyTo = (msg as { reply_to_message?: { message_id?: unknown } }).reply_to_message;
  const replyToMessageId = replyTo && typeof replyTo.message_id === 'number' ? String(replyTo.message_id) : null;

  if (!telegramUserId) {
    throw new Error('Invalid Telegram update: message missing sender information.');
  }
  if (!telegramChatId || !telegramMessageId) {
    throw new Error('Invalid Telegram update: message missing canonical chat/message IDs.');
  }

  const externalId = `${botInstallationId}:${u.update_id}`;
  const baseIds = {
    telegramUserId,
    telegramChatId,
    telegramMessageId,
    senderIsBot,
    replyToMessageId,
  };

  const venue = msg.venue;
  const location = venue?.location || msg.location;
  const hasValidLocation = Boolean(
    location && typeof location.latitude === 'number' && typeof location.longitude === 'number',
  );

  // Check for unsupported media
  const unsupportedMediaTypes: string[] = [];
  if (Array.isArray(msg.photo) && msg.photo.length > 0) unsupportedMediaTypes.push('photo');
  if (msg.location && !hasValidLocation) unsupportedMediaTypes.push('location');
  if (msg.document) unsupportedMediaTypes.push('document');
  if (msg.video) unsupportedMediaTypes.push('video');
  if (msg.contact) unsupportedMediaTypes.push('contact');
  if (msg.sticker) unsupportedMediaTypes.push('sticker');

  const textContent = msg.text || msg.caption || '';
  const trimmedText = textContent.trim();

  // Check for /start <code> account link command. Exact command match:
  // /startled or /starting are ordinary text, never link commands. An
  // optional @botsuffix is accepted and validated by the caller.
  const startMatch = /^\/start(@[A-Za-z0-9_]+)?(?:\s+(.*))?$/.exec(trimmedText);
  if (startMatch) {
    const startCode = (startMatch[2] || '').split(/\s+/)[0] || '';
    return {
      updateId: u.update_id,
      externalId,
      botInstallationId,
      ...baseIds,
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
        ...baseIds,
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
      ...baseIds,
      isPrivateChat: isPrivate,
      kind: 'unsupported_media_only',
      unsupportedMediaTypes,
      rawUpdate: update,
    };
  }

  if (hasValidLocation && location) {
    const locText = venue
      ? `📍 Check-in at ${venue.title} (${venue.address}) [Coordinates: ${location.latitude}, ${location.longitude}]${trimmedText ? ` - ${trimmedText}` : ''}`
      : `📍 Shared location [Coordinates: ${location.latitude}, ${location.longitude}]${trimmedText ? ` - ${trimmedText}` : ''}`;
    return {
      updateId: u.update_id,
      externalId,
      botInstallationId,
      ...baseIds,
      isPrivateChat: isPrivate,
      kind: 'location',
      text: locText,
      location,
      venue,
      unsupportedMediaTypes,
      rawUpdate: update,
    };
  }

  if (msg.voice || msg.audio) {
    return {
      updateId: u.update_id,
      externalId,
      botInstallationId,
      ...baseIds,
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
    ...baseIds,
    isPrivateChat: isPrivate,
    kind: 'text',
    text: trimmedText,
    unsupportedMediaTypes,
    rawUpdate: update,
  };
}
