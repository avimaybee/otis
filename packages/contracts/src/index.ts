/**
 * @daybook/contracts
 * Shared domain, DTO, and API contracts for Daybook.
 */

export interface HealthResponse {
  status: 'ok';
  timestamp: string;
}

export type ChannelType = 'web' | 'telegram' | 'whatsapp';

export type EntityKind = 'business' | 'person' | 'other';

export type LeadStatus =
  | 'new'
  | 'cold'
  | 'warm'
  | 'hot'
  | 'won'
  | 'lost'
  | 'deprioritized';

export type TaskStatus = 'open' | 'done' | 'cancelled';
