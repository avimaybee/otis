/** @vitest-environment happy-dom */
/**
 * 010 voice send end-to-end: scoped outbox media identity, durable-acceptance
 * gating, same-identity retry and scope-safety while an upload is paused.
 * These are orchestration tests with injected transport, not device evidence.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { Chat, ChatDetailResponse, ModelOption, VoiceMediaSummary } from '@otis/contracts';
import { Composer, type VoiceComposerConfig } from '../src/components/Composer.js';
import {
  configureVoiceUpload,
  resetVoiceUploadForTests,
  type VoiceUploadAdapter,
} from '../src/api/voice.js';
import {
  awaitOutboxSettlement,
  createOutboxEntry,
  entriesForUser,
  markOutboxFailed,
  markOutboxSaved,
  resetOutboxForTests,
  retryOutboxEntry,
} from '../src/api/outbox.js';
import { listVoiceSessions, resetVoiceSessionsForTests } from '../src/api/voiceSessions.js';
import type { VoiceMediaRecorder, VoiceRecorderEnvironment } from '../src/hooks/useVoiceRecorder.js';
import { api } from '../src/api/client.js';
import { mountRoute } from './route.js';
import * as stream from '../src/hooks/useActivityStream.js';

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const WS = 'ws_voice';
const CHAT = 'chat_voice';
let userSeq = 0;
let USER = 'usr_avi-0';
let MEMBERS: Record<string, string> = {};

// Each case gets its own account scope so fake IndexedDB state from a
// retained recording cannot leak into the next case.
beforeEach(() => {
  userSeq += 1;
  USER = `usr_avi-${userSeq}`;
  MEMBERS = { [USER]: 'Avi' };
});

const storyMedia: VoiceMediaSummary = {
  media_id: 'med_voicesend1',
  workspace_id: WS,
  chat_id: CHAT,
  uploader_user_id: USER,
  state: 'validated',
  format: 'audio/webm',
  content_type: 'audio/webm',
  byte_size: 4096,
  duration_ms: 4000,
  created_at: '2026-10-04T10:00:00.000Z',
  expires_at: '2026-10-18T10:00:00.000Z',
  transcript: null,
  transcription: null,
};

beforeAll(async () => {
  const { indexedDB, IDBKeyRange } = await import('fake-indexeddb');
  Object.defineProperty(globalThis, 'indexedDB', { value: indexedDB, configurable: true });
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
  Object.defineProperty(globalThis, 'Blob', { value: NodeBlob, configurable: true });
});

afterEach(() => {
  resetOutboxForTests();
  resetVoiceSessionsForTests();
  resetVoiceUploadForTests();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

async function waitFor(check: () => boolean, timeout = 4000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (check()) return;
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
    });
  }
  throw new Error('waitFor timeout');
}

// --- Outbox identity and settlement ---------------------------------------

describe('scoped outbox media identity', () => {
  beforeEach(() => resetOutboxForTests());

  it('creates a media entry under the recorder UUID and preserves it on retry', () => {
    const entry = createOutboxEntry({
      clientId: 'client-voice-1',
      userId: USER,
      workspaceId: WS,
      chatId: CHAT,
      text: '',
      mediaId: 'med_voice1',
    });
    expect(entry.clientId).toBe('client-voice-1');
    expect(entry.mediaId).toBe('med_voice1');
    markOutboxFailed(entry.clientId, { code: 'transport', message: 'down' });
    const retried = retryOutboxEntry(entry.clientId)!;
    expect(retried.clientId).toBe('client-voice-1');
    expect(retried.mediaId).toBe('med_voice1');
  });

  it('settles saved, failed and reconciled outcomes', async () => {
    const saved = createOutboxEntry({ userId: USER, workspaceId: WS, chatId: CHAT, text: '', mediaId: 'med_a' });
    const savedPromise = awaitOutboxSettlement(saved.clientId);
    markOutboxSaved(saved.clientId, { messageId: 'm1', runId: 'r1', sequence: 1 });
    expect(await savedPromise).toBe('saved');

    const failed = createOutboxEntry({ userId: USER, workspaceId: WS, chatId: CHAT, text: '', mediaId: 'med_b' });
    const failedPromise = awaitOutboxSettlement(failed.clientId);
    markOutboxFailed(failed.clientId, { code: 'transport', message: 'down' });
    expect(await failedPromise).toBe('failed');

    // Reconciled/pruned means the authoritative server row exists.
    expect(await awaitOutboxSettlement('missing-entry')).toBe('saved');
  });

  it('sends media_id through acceptance and omits it for text messages', async () => {
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({
        status: 'accepted',
        message_id: 'm1',
        run_id: 'r1',
        acceptance_sequence: 1,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await api.sendMessage(WS, CHAT, 'client-1', '', undefined, 'med_voice1');
    expect(JSON.parse(bodies[0]!)).toMatchObject({ client_message_id: 'client-1', media_id: 'med_voice1' });
    await api.sendMessage(WS, CHAT, 'client-2', 'hello');
    expect(JSON.parse(bodies[1]!)).not.toHaveProperty('media_id');
  });
});

// --- Composer/hook: acceptance gating, retry, scope safety ----------------

class FakeRecorder implements VoiceMediaRecorder {
  state = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['final'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
  emit(text: string): void {
    this.ondataavailable?.({ data: new Blob([text], { type: 'audio/webm' }) });
  }
}

function harness() {
  const stream = { getTracks: () => [{ stop: () => {} }] } as unknown as MediaStream;
  const recorders: FakeRecorder[] = [];
  const environment: VoiceRecorderEnvironment = {
    getUserMedia: async () => stream,
    isTypeSupported: () => true,
    createRecorder: () => {
      const recorder = new FakeRecorder();
      recorders.push(recorder);
      return recorder;
    },
    createMeter: () => ({ read: () => 0.5, close: () => {} }),
    validateBlob: async () => ({ ok: true, durationMs: 4000 }),
    vibrate: () => {},
    now: () => 1_000_000,
  };
  return { environment, recorders };
}

let composerScope = { userId: USER, workspaceId: WS, chatId: CHAT };
function voiceConfig(
  environment: VoiceRecorderEnvironment,
  adapter: VoiceUploadAdapter | null,
  onSent?: VoiceComposerConfig['onSent'],
  scope = composerScope,
): VoiceComposerConfig {
  return { available: true, adapter, scope, environment, onSent };
}

async function mountComposer(element: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => root.render(element));
  return {
    host,
    rerender: async (next: React.ReactElement) => {
      await React.act(async () => root.render(next));
    },
    unmount: async () => {
      await React.act(async () => root.unmount());
      host.remove();
    },
  };
}

async function recordIntoReview(view: { host: HTMLElement }, recorders: FakeRecorder[]) {
  await React.act(async () => {
    (view.host.querySelector('[aria-label="Record voice note"]') as HTMLElement).click();
  });
  await waitFor(() => recorders[0]?.state === 'recording');
  await React.act(async () => {
    recorders[0]!.emit('voice');
  });
  await React.act(async () => {
    (view.host.querySelector('[aria-label="Stop recording"]') as HTMLElement).click();
  });
  await waitFor(() => view.host.querySelector('[aria-label="Send voice note"]') !== null);
}

describe('voice send acceptance gating', () => {
  beforeEach(() => {
    resetVoiceSessionsForTests();
    resetOutboxForTests();
    composerScope = { userId: USER, workspaceId: WS, chatId: CHAT };
  });

  it('deletes local bytes only after durable outbox acceptance resolves', async () => {
    const { environment, recorders } = harness();
    const adapter: VoiceUploadAdapter = { upload: vi.fn().mockResolvedValue({ media: storyMedia }) };
    let resolveAccepted!: () => void;
    const onSent = vi.fn().mockImplementation(() => new Promise<void>(resolve => { resolveAccepted = resolve; }));
    const view = await mountComposer(
      <Composer running={false} commands={[]} onSend={async () => true} voice={voiceConfig(environment, adapter, onSent)} />,
    );
    await recordIntoReview(view, recorders);
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Send voice note"]') as HTMLElement).click();
    });
    await waitFor(() => onSent.mock.calls.length === 1);
    expect(await listVoiceSessions(composerScope)).toHaveLength(1);
    await React.act(async () => {
      resolveAccepted();
    });
    await waitFor(() => view.host.querySelector('textarea') !== null);
    expect(await listVoiceSessions(composerScope)).toHaveLength(0);
    await view.unmount();
  });

  it('keeps the recording and reuses the finalized upload on same-identity retry', async () => {
    const { environment, recorders } = harness();
    const upload = vi.fn().mockResolvedValue({ media: storyMedia });
    const adapter: VoiceUploadAdapter = { upload };
    let attempt = 0;
    const onSent = vi.fn().mockImplementation(() => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error('not accepted')) : Promise.resolve();
    });
    const view = await mountComposer(
      <Composer running={false} commands={[]} onSend={async () => true} voice={voiceConfig(environment, adapter, onSent)} />,
    );
    await recordIntoReview(view, recorders);
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Send voice note"]') as HTMLElement).click();
    });
    await waitFor(() => view.host.querySelector('[aria-label="Retry sending voice note"]') !== null);
    expect(await listVoiceSessions(composerScope)).toHaveLength(1);
    expect(upload).toHaveBeenCalledTimes(1);
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Retry sending voice note"]') as HTMLElement).click();
    });
    await waitFor(() => view.host.querySelector('textarea') !== null);
    expect(onSent).toHaveBeenCalledTimes(2);
    const first = onSent.mock.calls[0]![0] as { clientMessageId: string };
    const second = onSent.mock.calls[1]![0] as { clientMessageId: string };
    expect(first.clientMessageId).toBe(second.clientMessageId);
    // The finalized upload is reused: no second media for the same note.
    expect(upload).toHaveBeenCalledTimes(1);
    expect(await listVoiceSessions(composerScope)).toHaveLength(0);
    await view.unmount();
  });

  it('a scope move during a slow upload aborts the callback and retains old bytes', async () => {
    const { environment, recorders } = harness();
    let resolveUpload!: (value: { media: VoiceMediaSummary }) => void;
    const adapter: VoiceUploadAdapter = {
      upload: vi.fn().mockImplementation(() => new Promise(resolve => { resolveUpload = resolve; })),
    };
    const onSent = vi.fn().mockResolvedValue(undefined);
    const view = await mountComposer(
      <Composer running={false} commands={[]} onSend={async () => true} voice={voiceConfig(environment, adapter, onSent)} />,
    );
    await recordIntoReview(view, recorders);
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Send voice note"]') as HTMLElement).click();
    });
    await waitFor(() => (adapter.upload as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    const moved = { userId: USER, workspaceId: WS, chatId: 'chat_moved' };
    await view.rerender(
      <Composer running={false} commands={[]} onSend={async () => true} voice={voiceConfig(environment, adapter, onSent, moved)} />,
    );
    await React.act(async () => {
      resolveUpload({ media: storyMedia });
    });
    await waitFor(() => true, 300);
    expect(onSent).not.toHaveBeenCalled();
    expect(await listVoiceSessions({ userId: USER, workspaceId: WS, chatId: CHAT })).toHaveLength(1);
    await view.unmount();
  });

  it('unmount during a slow upload never invokes the send owner', async () => {
    const { environment, recorders } = harness();
    let resolveUpload!: (value: { media: VoiceMediaSummary }) => void;
    const adapter: VoiceUploadAdapter = {
      upload: vi.fn().mockImplementation(() => new Promise(resolve => { resolveUpload = resolve; })),
    };
    const onSent = vi.fn().mockResolvedValue(undefined);
    const view = await mountComposer(
      <Composer running={false} commands={[]} onSend={async () => true} voice={voiceConfig(environment, adapter, onSent)} />,
    );
    await recordIntoReview(view, recorders);
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Send voice note"]') as HTMLElement).click();
    });
    await waitFor(() => (adapter.upload as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    await view.unmount();
    await React.act(async () => {
      resolveUpload({ media: storyMedia });
    });
    expect(onSent).not.toHaveBeenCalled();
  });
});

// --- ConversationScreen integration ---------------------------------------

class GlobalRecorder implements VoiceMediaRecorder {
  static instances: GlobalRecorder[] = [];
  state = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static isTypeSupported(): boolean {
    return true;
  }
  constructor() {
    GlobalRecorder.instances.push(this);
  }
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
  emit(text: string): void {
    this.ondataavailable?.({ data: new Blob([text], { type: 'audio/webm' }) });
  }
}

class FakeAudio {
  onloadedmetadata: (() => void) | null = null;
  onerror: (() => void) | null = null;
  duration = 4;
  src = '';
  constructor() {
    setTimeout(() => this.onloadedmetadata?.(), 0);
  }
  load(): void {}
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}
  removeAttribute(): void {}
}

function installPlatformStubs() {
  Object.defineProperty(globalThis, 'MediaRecorder', { value: GlobalRecorder, configurable: true });
  Object.defineProperty(globalThis, 'Audio', { value: FakeAudio, configurable: true });
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:voice-test', configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true });
  const mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) };
  try {
    Object.defineProperty(navigator, 'mediaDevices', { value: mediaDevices, configurable: true });
  } catch {
    Object.defineProperty(Object.getPrototypeOf(navigator), 'mediaDevices', { value: mediaDevices, configurable: true });
  }
}

function makeChat(id: string): Chat {
  return {
    id,
    workspace_id: WS,
    title: 'Voice chat',
    author_user_id: USER,
    author_display_name: 'Avi',
    model_override: null,
    is_archived: false,
    activity_cursor: 1,
    created_at: '2026-10-04T10:00:00.000Z',
    updated_at: '2026-10-04T10:00:00.000Z',
    last_activity_at: '2026-10-04T10:00:00.000Z',
  };
}

const voiceModel: ModelOption = {
  command_key: 'mimo-25',
  display_name: 'MiMo V2.5',
  provider: 'opencode_go',
  available: true,
  is_current: true,
  is_default: true,
  native_audio_supported: true,
  voice_available: true,
};

function mockConversation(chats: Chat[]) {
  vi.spyOn(api, 'listChats').mockResolvedValue({ chats });
  vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
  vi.spyOn(api, 'models').mockResolvedValue({ models: [voiceModel], current_command_key: 'mimo-25', default_command_key: 'mimo-25' });
  vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
  vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
  vi.spyOn(api, 'getChat').mockImplementation(async (_ws, chatId): Promise<ChatDetailResponse> => ({ chat: makeChat(chatId), is_author: true }));
  vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: CHAT, messages: [], next_before_sequence: null });
  vi.spyOn(api, 'run').mockResolvedValue({
    run: { id: 'run_voice', status: 'queued' } as never,
    status: 'queued',
    steps: [],
    actions: [],
    activities: [],
    pending_clarification: null,
  });
}

describe('conversation voice send integration', () => {
  beforeEach(() => {
    installPlatformStubs();
    GlobalRecorder.instances = [];
    resetOutboxForTests();
    resetVoiceSessionsForTests();
    resetVoiceUploadForTests();
    sessionStorage.clear();
    history.replaceState({}, '', `/?workspace=${WS}&chat=${CHAT}`);
    vi.spyOn(stream, 'subscribeToActivity').mockReturnValue({ close: vi.fn() });
  });

  async function mountVoiceConversation() {
    const view = await mountRoute(`/?workspace=${WS}&chat=${CHAT}`, {
      userId: USER,
      workspaces: [{ id: WS, name: 'Kerning' }],
      members: MEMBERS,
    });
    await waitFor(() => view.host.querySelector('[aria-label="Record voice note"]') !== null);
    return view;
  }

  it('pauses on upload, then creates one media outbox entry and deletes bytes after acceptance', async () => {
    mockConversation([makeChat(CHAT)]);
    let resolveUpload!: (value: { media: VoiceMediaSummary }) => void;
    const upload = vi.fn().mockImplementation(() => new Promise(resolve => { resolveUpload = resolve; }));
    configureVoiceUpload({ upload });
    const sendMessage = vi.spyOn(api, 'sendMessage').mockResolvedValue({
      status: 'accepted',
      message_id: 'msg_voice',
      run_id: 'run_voice',
      acceptance_sequence: 1,
    });
    const view = await mountVoiceConversation();

    await React.act(async () => {
      (view.host.querySelector('[aria-label="Record voice note"]') as HTMLElement).click();
    });
    await waitFor(() => GlobalRecorder.instances[0]?.state === 'recording');
    await React.act(async () => {
      GlobalRecorder.instances[0]!.emit('voice');
    });
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Stop recording"]') as HTMLElement).click();
    });
    await waitFor(() => view.host.querySelector('[aria-label="Send voice note"]') !== null);
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Send voice note"]') as HTMLElement).click();
    });
    await waitFor(() => upload.mock.calls.length === 1);
    expect(sendMessage).not.toHaveBeenCalled();
    const clientMessageId = (upload.mock.calls[0]![0] as { clientMessageId: string }).clientMessageId;

    await React.act(async () => {
      resolveUpload({ media: storyMedia });
    });
    await waitFor(() => sendMessage.mock.calls.length === 1);
    expect(sendMessage).toHaveBeenCalledWith(WS, CHAT, clientMessageId, '', undefined, storyMedia.media_id, expect.anything(), undefined, expect.any(String));
    await waitFor(() => view.host.querySelector('textarea') !== null);
    expect(await listVoiceSessions({ userId: USER, workspaceId: WS, chatId: CHAT })).toHaveLength(0);
    await view.unmount();
  });

  it('a chat switch during a slow upload creates no entry for either scope and keeps the old recording', async () => {
    mockConversation([makeChat(CHAT), makeChat('chat_other')]);
    let resolveUpload!: (value: { media: VoiceMediaSummary }) => void;
    const upload = vi.fn().mockImplementation(() => new Promise(resolve => { resolveUpload = resolve; }));
    configureVoiceUpload({ upload });
    const sendMessage = vi.spyOn(api, 'sendMessage');
    const view = await mountVoiceConversation();

    await React.act(async () => {
      (view.host.querySelector('[aria-label="Record voice note"]') as HTMLElement).click();
    });
    await waitFor(() => GlobalRecorder.instances[0]?.state === 'recording');
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Stop recording"]') as HTMLElement).click();
    });
    await waitFor(() => view.host.querySelector('[aria-label="Send voice note"]') !== null);
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Send voice note"]') as HTMLElement).click();
    });
    await waitFor(() => upload.mock.calls.length === 1);

    await React.act(async () => {
      await view.router.navigate({ to: '/', search: { workspace: WS, chat: 'chat_other' } });
    });
    // The scope switch must be committed (old composer unmounted) before the
    // paused upload resolves, exactly like a real navigation during upload.
    await waitFor(() => location.search.includes('chat_other'));
    await React.act(async () => {
      resolveUpload({ media: storyMedia });
    });
    await waitFor(() => true, 300);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(entriesForUser(USER)).toHaveLength(0);
    expect(await listVoiceSessions({ userId: USER, workspaceId: WS, chatId: CHAT })).toHaveLength(1);
    await view.unmount();
  });

  it('workspace revocation during a slow upload parks the workspace without purging bytes or the session', async () => {
    mockConversation([makeChat(CHAT)]);
    let resolveUpload!: (value: { media: VoiceMediaSummary }) => void;
    const upload = vi.fn().mockImplementation(() => new Promise(resolve => { resolveUpload = resolve; }));
    configureVoiceUpload({ upload });
    let handlers: { onMembershipRevoked?: () => void } | null = null;
    vi.mocked(stream.subscribeToActivity).mockImplementation((_url, options) => {
      handlers = options as unknown as { onMembershipRevoked?: () => void };
      return { close: vi.fn() };
    });
    const sendMessage = vi.spyOn(api, 'sendMessage');
    const view = await mountVoiceConversation();

    await React.act(async () => {
      (view.host.querySelector('[aria-label="Record voice note"]') as HTMLElement).click();
    });
    await waitFor(() => GlobalRecorder.instances[0]?.state === 'recording');
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Stop recording"]') as HTMLElement).click();
    });
    await waitFor(() => view.host.querySelector('[aria-label="Send voice note"]') !== null);
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Send voice note"]') as HTMLElement).click();
    });
    await waitFor(() => upload.mock.calls.length === 1);
    await waitFor(() => handlers !== null);

    // Revocation parks the workspace: an explicit notice, never a
    // session-wide purge. The composer unmounts with the parked chat, so the
    // late upload resolves exactly like a scope switch: no entry, no send.
    await React.act(async () => {
      handlers!.onMembershipRevoked?.();
    });
    expect(view.host.textContent).toContain('Workspace unavailable');
    expect(view.host.textContent).not.toContain('Reload access');
    await React.act(async () => {
      resolveUpload({ media: storyMedia });
    });
    await waitFor(() => true, 300);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(entriesForUser(USER)).toHaveLength(0);
    expect(await listVoiceSessions({ userId: USER, workspaceId: WS, chatId: CHAT })).toHaveLength(1);
    await view.unmount();
  });
});
