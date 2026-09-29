/**
 * @daybook/channels
 * Channel adapters (Telegram, Web, future WhatsApp) for Daybook.
 */

import type { ChannelType } from '@daybook/contracts';

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

export interface ChannelAdapter {
  receive(update: unknown): Promise<NormalizedMessage>;
  send(target: string, message: string): Promise<void>;
}
