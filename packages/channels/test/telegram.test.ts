import { describe, it, expect } from 'vitest';
import {
  normalizeTelegramUpdate,
  validateTelegramWebhookSecret,
} from '../src/telegram.js';

describe('Telegram Channel Normalization & Validation', () => {
  const botId = 'bot_main_123';

  it('validates webhook secret header against configured secret', () => {
    expect(validateTelegramWebhookSecret('valid_secret', 'valid_secret')).toBe(true);
    expect(validateTelegramWebhookSecret('wrong_secret', 'valid_secret')).toBe(false);
    expect(validateTelegramWebhookSecret(null, undefined)).toBe(false);
    expect(validateTelegramWebhookSecret('valid_secret', undefined)).toBe(false);
  });

  it('normalizes standard private chat text message', () => {
    const update = {
      update_id: 1001,
      message: {
        message_id: 42,
        from: { id: 98765, first_name: 'Avi' },
        chat: { id: 98765, type: 'private' },
        date: 1700000000,
        text: 'Follow up with Kerning team tomorrow',
      },
    };

    const res = normalizeTelegramUpdate(update, botId);
    expect(res.externalId).toBe('bot_main_123:1001');
    expect(res.telegramUserId).toBe('98765');
    expect(res.isPrivateChat).toBe(true);
    expect(res.kind).toBe('text');
    expect(res.text).toBe('Follow up with Kerning team tomorrow');
    expect(res.unsupportedMediaTypes).toEqual([]);
  });

  it('flags non-private chat messages', () => {
    const update = {
      update_id: 1002,
      message: {
        message_id: 43,
        from: { id: 98765 },
        chat: { id: -1001234567, type: 'group', title: 'Group Chat' },
        date: 1700000000,
        text: 'Hello group',
      },
    };

    const res = normalizeTelegramUpdate(update, botId);
    expect(res.isPrivateChat).toBe(false);
  });

  it('parses /start <code> account link command', () => {
    const update = {
      update_id: 1003,
      message: {
        message_id: 44,
        from: { id: 98765 },
        chat: { id: 98765, type: 'private' },
        date: 1700000000,
        text: '/start link_code_abcdef123',
      },
    };

    const res = normalizeTelegramUpdate(update, botId);
    expect(res.kind).toBe('start_command');
    expect(res.startCode).toBe('link_code_abcdef123');
  });

  it('categorizes unsupported photo without text as unsupported_media_only', () => {
    const update = {
      update_id: 1004,
      message: {
        message_id: 45,
        from: { id: 98765 },
        chat: { id: 98765, type: 'private' },
        date: 1700000000,
        photo: [{ file_id: 'ph_123' }],
      },
    };

    const res = normalizeTelegramUpdate(update, botId);
    expect(res.kind).toBe('unsupported_media_only');
    expect(res.unsupportedMediaTypes).toContain('photo');
    expect(res.text).toBeUndefined();
  });

  it('categorizes unsupported media WITH text as unsupported_media_with_text for confirmation', () => {
    const update = {
      update_id: 1005,
      message: {
        message_id: 46,
        from: { id: 98765 },
        chat: { id: 98765, type: 'private' },
        date: 1700000000,
        location: { latitude: 52.52, longitude: 13.405 },
        caption: 'Meet me at this location Friday',
      },
    };

    const res = normalizeTelegramUpdate(update, botId);
    expect(res.kind).toBe('unsupported_media_with_text');
    expect(res.unsupportedMediaTypes).toContain('location');
    expect(res.text).toBe('Meet me at this location Friday');
  });

  it('rejects invalid payload or missing sender', () => {
    expect(() => normalizeTelegramUpdate(null, botId)).toThrow();
    expect(() => normalizeTelegramUpdate({ update_id: 'not-number' }, botId)).toThrow();
    expect(() =>
      normalizeTelegramUpdate(
        { update_id: 1, message: { chat: { type: 'private' } } },
        botId,
      ),
    ).toThrow();
  });
});
