/**
 * In-memory pub/sub live event bus for real-time token and activity streaming.
 *
 * Eliminates periodic D1 polling: active streaming responses (SSE and WebSockets)
 * receive events directly in RAM as the agent generates them.
 */

import type { StreamEventName } from '@otis/contracts';

export interface ChatStreamEvent {
  name: StreamEventName;
  data: unknown;
  id?: number;
}

export type ChatEventListener = (event: ChatStreamEvent) => void;

class LiveChatBus {
  private listeners = new Map<string, Set<ChatEventListener>>();

  subscribe(workspaceId: string, chatId: string, listener: ChatEventListener): () => void {
    const key = `${workspaceId}:${chatId}`;
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);

    return () => {
      const current = this.listeners.get(key);
      if (current) {
        current.delete(listener);
        if (current.size === 0) {
          this.listeners.delete(key);
        }
      }
    };
  }

  broadcast(workspaceId: string, chatId: string, event: ChatStreamEvent): void {
    const key = `${workspaceId}:${chatId}`;
    const set = this.listeners.get(key);
    if (set) {
      for (const listener of set) {
        try {
          listener(event);
        } catch {
          // Individual listener failures must not abort publication to others.
        }
      }
    }
  }

  listenerCount(workspaceId: string, chatId: string): number {
    return this.listeners.get(`${workspaceId}:${chatId}`)?.size ?? 0;
  }
}

export const liveChatBus = new LiveChatBus();
