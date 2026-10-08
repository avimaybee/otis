import { describe, expect, it } from 'vitest';
import {
  VOICE_BOUNDS,
  isValidMediaId,
  normalizeVoiceFormat,
  validateChatMessageRequest,
  validateCreateVoiceUploadRequest,
  validateUpdateVoiceSettingsRequest,
} from '../src/index.js';

const baseUpload = {
  chat_id: 'chat_1',
  client_message_id: 'cm_1',
  content_type: 'audio/webm;codecs=opus',
  byte_size: 1024,
  duration_ms: 30_000,
};

describe('voice contract validation', () => {
  it('normalizes the three supported containers and rejects renamed streams', () => {
    expect(normalizeVoiceFormat('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(normalizeVoiceFormat('audio/mp4;codecs=mp4a.40.2')).toBe('audio/mp4');
    expect(normalizeVoiceFormat('audio/ogg;codecs=opus')).toBe('audio/ogg');
    expect(normalizeVoiceFormat('audio/aac')).toBeNull();
    expect(normalizeVoiceFormat('application/octet-stream')).toBeNull();
  });

  it('accepts a bounded claim and canonicalizes the declared MIME', () => {
    const result = validateCreateVoiceUploadRequest(baseUpload);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.content_type).toBe('audio/webm');
      expect(result.value.filename).toBeUndefined();
    }
  });

  it('rejects over-limit byte and duration claims before any upload', () => {
    expect(validateCreateVoiceUploadRequest({ ...baseUpload, byte_size: VOICE_BOUNDS.MAX_BYTES + 1 }).valid).toBe(false);
    expect(validateCreateVoiceUploadRequest({ ...baseUpload, duration_ms: VOICE_BOUNDS.MAX_DURATION_SECONDS * 1000 + 1 }).valid).toBe(false);
    expect(validateCreateVoiceUploadRequest({ ...baseUpload, byte_size: 1 }).valid).toBe(false);
    expect(validateCreateVoiceUploadRequest({ ...baseUpload, content_type: 'audio/flac' }).valid).toBe(false);
  });

  it('keeps filenames plain and bounded', () => {
    const result = validateCreateVoiceUploadRequest({ ...baseUpload, filename: 'C:\\Users\\x\\note.webm' });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.filename).toBe('note.webm');
  });

  it('allows a media-only chat message and rejects malformed media ids', () => {
    expect(isValidMediaId('med_1234-abcd')).toBe(true);
    expect(isValidMediaId('msg_1234')).toBe(false);
    const mediaOnly = validateChatMessageRequest({ client_message_id: 'cm_1', media_id: 'med_1234-abcd' });
    expect(mediaOnly.valid).toBe(true);
    const malformed = validateChatMessageRequest({ client_message_id: 'cm_1', media_id: '../etc/passwd' });
    expect(malformed.valid).toBe(false);
    const neither = validateChatMessageRequest({ client_message_id: 'cm_1' });
    expect(neither.valid).toBe(false);
    const emptyTextNoMedia = validateChatMessageRequest({ client_message_id: 'cm_1', text: '   ' });
    expect(emptyTextNoMedia.valid).toBe(false);
  });

  it('accepts a valid IANA timezone and rejects bogus ones', () => {
    const withZone = validateChatMessageRequest({ client_message_id: 'cm_1', text: 'hi', timezone: 'Europe/Bucharest' });
    expect(withZone.valid).toBe(true);
    if (withZone.valid) expect(withZone.value.timezone).toBe('Europe/Bucharest');
    const withoutZone = validateChatMessageRequest({ client_message_id: 'cm_1', text: 'hi' });
    expect(withoutZone.valid).toBe(true);
    if (withoutZone.valid) expect(withoutZone.value.timezone).toBeUndefined();
    expect(validateChatMessageRequest({ client_message_id: 'cm_1', text: 'hi', timezone: 'Not/AZone' }).valid).toBe(false);
    expect(validateChatMessageRequest({ client_message_id: 'cm_1', text: 'hi', timezone: '' }).valid).toBe(false);
    expect(validateChatMessageRequest({ client_message_id: 'cm_1', text: 'hi', timezone: 42 }).valid).toBe(false);
  });

  it('validates STT settings updates against the approved models and rejects client evidence', () => {
    expect(validateUpdateVoiceSettingsRequest({ enabled: true, model: 'whisper-large-v3-turbo' }).valid).toBe(true);
    const invalidModel = validateUpdateVoiceSettingsRequest({ model: 'whisper-tiny' });
    expect(invalidModel.valid).toBe(false);
    // verified_formats is server-recorded evidence from an actual transcription.
    const clientEvidence = validateUpdateVoiceSettingsRequest({ verified_formats: ['audio/webm'] });
    expect(clientEvidence.valid).toBe(false);
  });
});
