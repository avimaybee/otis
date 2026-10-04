/**
 * @otis/channels
 * Channel adapters (Telegram, Web, future WhatsApp) for Otis.
 */

import type { ChannelType } from '@otis/contracts';

export interface NormalizedMessage {
  id: string;
  channel: ChannelType;
  externalId: string;
  externalActorId: string;
  userId?: string;
  workspaceId?: string;
  chatId?: string;
  kind: 'text' | 'voice' | 'callback';
  text?: string;
  mediaRef?: string;
  timestamp: string;
}

export * from './telegram.js';
export * from './telegramSend.js';
