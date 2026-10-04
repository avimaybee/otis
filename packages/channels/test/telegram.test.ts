import { describe, it, expect } from 'vitest';
import {
  normalizeTelegramUpdate,
  validateTelegramWebhookSecret,
} from '../src/telegram.js';
import { replyMarkupForPart, splitTelegramText } from '../src/telegramSend.js';

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

  it('exposes canonical chat/message IDs, bot senders and reply targets', () => {
    const update = {
      update_id: 2001,
      message: {
        message_id: 77,
        from: { id: 98765, is_bot: false },
        chat: { id: 98765, type: 'private' },
        date: 1700000000,
        text: 'ok',
        reply_to_message: { message_id: 71 },
      },
    };
    const res = normalizeTelegramUpdate(update, botId);
    expect(res.telegramChatId).toBe('98765');
    expect(res.telegramMessageId).toBe('77');
    expect(res.senderIsBot).toBe(false);
    expect(res.replyToMessageId).toBe('71');
  });

  it('flags senders that are bots and rejects missing canonical IDs', () => {
    const botUpdate = {
      update_id: 2002,
      message: {
        message_id: 78,
        from: { id: 12345, is_bot: true },
        chat: { id: 98765, type: 'private' },
        date: 1700000000,
        text: 'beep',
      },
    };
    expect(normalizeTelegramUpdate(botUpdate, botId).senderIsBot).toBe(true);
    expect(() =>
      normalizeTelegramUpdate(
        { update_id: 2003, message: { from: { id: 1 }, chat: { id: 2, type: 'private' }, date: 1, text: 'x' } },
        botId,
      ),
    ).toThrow();
    expect(() =>
      normalizeTelegramUpdate(
        { update_id: 2004, message: { message_id: 3, from: { id: 1 }, chat: { type: 'private' }, date: 1, text: 'x' } },
        botId,
      ),
    ).toThrow();
  });

  it('treats /startled as ordinary text, not a link command', () => {
    const update = {
      update_id: 2005,
      message: {
        message_id: 79,
        from: { id: 98765 },
        chat: { id: 98765, type: 'private' },
        date: 1700000000,
        text: '/startled by the news',
      },
    };
    expect(normalizeTelegramUpdate(update, botId).kind).toBe('text');
  });
});

describe('Telegram send formatting', () => {
  it('keeps short text in one part without parse mode', () => {
    expect(splitTelegramText('Hello <>& "world"')).toEqual(['Hello <>& "world"']);
  });

  it('splits long text into ordered parts under the limit, preferably at breaks', () => {
    const text = `${'a'.repeat(3990)}\n${'b'.repeat(50)} tail`;
    const parts = splitTelegramText(text);
    expect(parts.length).toBe(2);
    expect(parts.every((part) => [...part].reduce((n, ch) => n + ch.length, 0) <= 4000)).toBe(true);
    expect(parts.join('')).toBe(text);
    expect(parts[0]!.endsWith('\n')).toBe(true);
  });

  it('never splits surrogate pairs or drops content', () => {
    const emoji = '\u{1F600}';
    const text = `${'x'.repeat(3999)}${emoji}${'y'.repeat(10)}`;
    const parts = splitTelegramText(text);
    expect(parts.join('')).toBe(text);
    for (const part of parts) {
      expect([...part].every((ch) => ch.length === 1 || ch.length === 2)).toBe(true);
    }
  });

  it('attaches ForceReply only to the final part of a question', () => {
    expect(replyMarkupForPart(true, true)).toEqual({ force_reply: true, selective: true });
    expect(replyMarkupForPart(true, false)).toBeUndefined();
    expect(replyMarkupForPart(false, true)).toBeUndefined();
  });
});
