/** @vitest-environment happy-dom */
/**
 * 010 local recording-session store: ordered reassembly, finalize racing a
 * pending chunk write, reload recovery, missing-chunk reporting and owner
 * purge. These exercise the real IndexedDB path through fake-indexeddb; they
 * are not device codec evidence.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import {
  appendVoiceChunk,
  checkpointVoiceSession,
  createVoiceSession,
  deleteVoiceSession,
  deleteVoiceSessionsForUser,
  finalizeVoiceSession,
  listVoiceSessions,
  rehydrateVoiceSessions,
  resetVoiceSessionsForTests,
} from '../src/api/voiceSessions.js';

let USER = 'user-voice-store-0';
let SCOPE = { userId: USER, workspaceId: 'ws', chatId: 'chat' };
let userCounter = 0;

beforeAll(async () => {
  const { indexedDB, IDBKeyRange } = await import('fake-indexeddb');
  Object.defineProperty(globalThis, 'indexedDB', { value: indexedDB, configurable: true });
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
  // happy-dom's Blob does not survive fake-indexeddb's structuredClone with
  // its bytes; Node's Blob does, and it is what real IndexedDB would retain.
  Object.defineProperty(globalThis, 'Blob', { value: NodeBlob, configurable: true });
});

beforeEach(() => {
  resetVoiceSessionsForTests();
  userCounter += 1;
  USER = `user-voice-store-${userCounter}`;
  SCOPE = { userId: USER, workspaceId: 'ws', chatId: 'chat' };
});

const chunk = (text: string): Blob => new Blob([text], { type: 'audio/webm' });

describe('voice session store', () => {
  it('reassembles ordered chunks with the negotiated MIME after finalize', async () => {
    const created = await createVoiceSession({
      sessionId: 's-order',
      userId: USER,
      workspaceId: 'ws',
      chatId: 'chat',
      mimeType: 'audio/webm;codecs=opus',
    });
    expect(created.durable).toBe(true);
    const a1 = await appendVoiceChunk({ sessionId: 's-order', sequence: 1, chunk: chunk('aa'), durationMs: 1000 });
    const a2 = await appendVoiceChunk({ sessionId: 's-order', sequence: 2, chunk: chunk('bb'), durationMs: 2000 });
    expect(a1).toEqual({ ok: true, durable: true });
    expect(a2).toEqual({ ok: true, durable: true });
    await checkpointVoiceSession({ sessionId: 's-order', durationMs: 2000, complete: true });
    const result = await finalizeVoiceSession('s-order');
    expect(result).not.toBeNull();
    expect(result!.meta.mimeType).toBe('audio/webm;codecs=opus');
    expect(result!.meta.complete).toBe(true);
    expect(await result!.blob.text()).toBe('aabb');
    expect(result!.missing).toBe(0);
  });

  it('finalize waits for an unfinished chunk write instead of racing it', async () => {
    await createVoiceSession({ sessionId: 's-race', userId: USER, workspaceId: 'ws', chatId: 'chat', mimeType: 'audio/webm' });
    const pending = appendVoiceChunk({ sessionId: 's-race', sequence: 1, chunk: chunk('late'), durationMs: 500 });
    const result = await finalizeVoiceSession('s-race');
    await pending;
    expect(result).not.toBeNull();
    expect(await result!.blob.text()).toBe('late');
  });

  it('reports a missing middle chunk instead of hiding the gap', async () => {
    await createVoiceSession({ sessionId: 's-gap', userId: USER, workspaceId: 'ws', chatId: 'chat', mimeType: 'audio/webm' });
    await appendVoiceChunk({ sessionId: 's-gap', sequence: 1, chunk: chunk('a'), durationMs: 1000 });
    await appendVoiceChunk({ sessionId: 's-gap', sequence: 3, chunk: chunk('c'), durationMs: 3000 });
    const result = await finalizeVoiceSession('s-gap');
    expect(result!.missing).toBe(1);
  });

  it('recovers an interrupted session by scope with its checkpointed state', async () => {
    await createVoiceSession({ sessionId: 's-bg', userId: USER, workspaceId: 'ws', chatId: 'chat', mimeType: 'audio/mp4' });
    await appendVoiceChunk({ sessionId: 's-bg', sequence: 1, chunk: chunk('bg'), durationMs: 900 });
    await checkpointVoiceSession({ sessionId: 's-bg', durationMs: 900, complete: false, interruption: 'background' });
    resetVoiceSessionsForTests();
    await rehydrateVoiceSessions(USER);
    const listed = await listVoiceSessions(SCOPE);
    expect(listed.map(meta => meta.sessionId)).toEqual(['s-bg']);
    const result = await finalizeVoiceSession('s-bg');
    expect(result!.meta.complete).toBe(false);
    expect(result!.meta.interruption).toBe('background');
    expect(await result!.blob.text()).toBe('bg');
  });

  it('scopes recovery to the exact workspace and chat', async () => {
    await createVoiceSession({ sessionId: 's-other', userId: USER, workspaceId: 'ws', chatId: 'other-chat', mimeType: 'audio/webm' });
    expect(await listVoiceSessions(SCOPE)).toEqual([]);
  });

  it('explicit discard removes the session and its chunks', async () => {
    await createVoiceSession({ sessionId: 's-del', userId: USER, workspaceId: 'ws', chatId: 'chat', mimeType: 'audio/webm' });
    await appendVoiceChunk({ sessionId: 's-del', sequence: 1, chunk: chunk('bye'), durationMs: 500 });
    await deleteVoiceSession('s-del');
    expect(await finalizeVoiceSession('s-del')).toBeNull();
    expect(await listVoiceSessions(SCOPE)).toEqual([]);
  });

  it('owner purge removes local audio and rejects stale appends', async () => {
    await createVoiceSession({ sessionId: 's-purge', userId: USER, workspaceId: 'ws', chatId: 'chat', mimeType: 'audio/webm' });
    await appendVoiceChunk({ sessionId: 's-purge', sequence: 1, chunk: chunk('private'), durationMs: 500 });
    await deleteVoiceSessionsForUser(USER);
    expect(await listVoiceSessions(SCOPE)).toEqual([]);
    expect(await finalizeVoiceSession('s-purge')).toBeNull();
    const stale = await appendVoiceChunk({ sessionId: 's-purge', sequence: 2, chunk: chunk('late'), durationMs: 900 });
    expect(stale.ok).toBe(false);
    const staleCheckpoint = await checkpointVoiceSession({ sessionId: 's-purge', durationMs: 900, complete: true });
    expect(staleCheckpoint.ok).toBe(false);
  });

  it('a new session created after purge starts cleanly in the new generation', async () => {
    await createVoiceSession({ sessionId: 's-old', userId: USER, workspaceId: 'ws', chatId: 'chat', mimeType: 'audio/webm' });
    await deleteVoiceSessionsForUser(USER);
    const fresh = await createVoiceSession({ sessionId: 's-new', userId: USER, workspaceId: 'ws', chatId: 'chat', mimeType: 'audio/webm' });
    expect(fresh.durable).toBe(true);
    await appendVoiceChunk({ sessionId: 's-new', sequence: 1, chunk: chunk('new'), durationMs: 1000 });
    const result = await finalizeVoiceSession('s-new');
    expect(await result!.blob.text()).toBe('new');
  });
});
