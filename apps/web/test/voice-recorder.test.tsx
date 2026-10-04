/** @vitest-environment happy-dom */
/**
 * 010 recorder + composer behavior with an injected fake MediaRecorder and
 * analyser. Covers permission denial, record→Review, cancel with draft
 * preservation, the three-minute cap, background interruption and same-UUID
 * upload retry. These are orchestration tests, not device codec proof.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { VoiceMediaSummary } from '@otis/contracts';
import { Composer, type VoiceComposerConfig } from '../src/components/Composer.js';
import { resetVoiceUploadForTests, type VoiceUploadAdapter } from '../src/api/voice.js';
import { resetVoiceSessionsForTests } from '../src/api/voiceSessions.js';
import type { VoiceMediaRecorder, VoiceRecorderEnvironment } from '../src/hooks/useVoiceRecorder.js';

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const storyMedia: VoiceMediaSummary = {
  media_id: 'med_voicetest1',
  workspace_id: 'ws',
  chat_id: 'chat',
  uploader_user_id: 'avi',
  state: 'transcribing',
  format: 'audio/webm',
  content_type: 'audio/webm',
  byte_size: 1024,
  duration_ms: 4000,
  created_at: new Date().toISOString(),
  expires_at: new Date().toISOString(),
  transcript: null,
  transcription: null,
};

beforeAll(async () => {
  const { indexedDB, IDBKeyRange } = await import('fake-indexeddb');
  Object.defineProperty(globalThis, 'indexedDB', { value: indexedDB, configurable: true });
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: IDBKeyRange, configurable: true });
  // happy-dom's Blob does not survive fake-indexeddb's structuredClone with
  // its bytes; Node's Blob does, and it is what real IndexedDB would retain.
  Object.defineProperty(globalThis, 'Blob', { value: NodeBlob, configurable: true });
});

afterEach(() => {
  resetVoiceSessionsForTests();
  resetVoiceUploadForTests();
  vi.restoreAllMocks();
  delete (document as unknown as { hidden?: unknown }).hidden;
});

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

function harness(overrides: Partial<VoiceRecorderEnvironment> = {}) {
  let now = 1_000_000;
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
    now: () => now,
    ...overrides,
  };
  return { environment, recorders, setNow: (value: number) => { now = value; } };
}

let scope = { userId: 'avi-0', workspaceId: 'ws', chatId: 'chat' };
let userCounter = 0;
beforeEach(() => {
  userCounter += 1;
  scope = { userId: `avi-${userCounter}`, workspaceId: 'ws', chatId: 'chat' };
});
const baseProps = { running: false, commands: [], onSend: async () => true };

function voiceConfig(
  environment: VoiceRecorderEnvironment,
  adapter: VoiceUploadAdapter | null,
  available = true,
): VoiceComposerConfig {
  return { available, adapter, scope, environment };
}

async function mount(element: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => {
    root.render(element);
  });
  return {
    host,
    unmount: async () => {
      await React.act(async () => root.unmount());
      host.remove();
    },
  };
}

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

describe('voice composer behavior', () => {
  it('keeps the mic absent when no server route is confirmed', async () => {
    const { environment } = harness();
    const view = await mount(<Composer {...baseProps} voice={voiceConfig(environment, null, false)} />);
    expect(view.host.querySelector('[aria-label="Record voice note"]')).toBeNull();
    await view.unmount();
  });

  it('requests the microphone only after the explicit action and maps denial', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    const { environment } = harness({ getUserMedia });
    const adapter = { upload: vi.fn() } satisfies VoiceUploadAdapter;
    const view = await mount(
      <Composer {...baseProps} draftValue="Keep this draft" voice={voiceConfig(environment, adapter)} />,
    );
    expect(getUserMedia).not.toHaveBeenCalled();
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Record voice note"]') as HTMLElement).click();
    });
    await waitFor(() => view.host.textContent?.includes('Microphone access is blocked') === true);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect((view.host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Keep this draft');
    expect(view.host.querySelector('[aria-label="Record voice note"]')).toBeTruthy();
    await view.unmount();
  });

  it('records, stops into Review and never auto-sends', async () => {
    const { environment, recorders, setNow } = harness();
    const adapter = { upload: vi.fn().mockResolvedValue({ media: storyMedia }) } satisfies VoiceUploadAdapter;
    const view = await mount(<Composer {...baseProps} voice={voiceConfig(environment, adapter)} />);
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Record voice note"]') as HTMLElement).click();
    });
    await waitFor(() => recorders[0]?.state === 'recording');
    expect(recorders[0]!.state).toBe('recording');
    await React.act(async () => {
      recorders[0]!.emit('voice');
    });
    setNow(1_004_000);
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Stop recording"]') as HTMLElement).click();
    });
    await waitFor(() => view.host.querySelector('[aria-label="Send voice note"]') !== null);
    expect(adapter.upload).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain('0:04');
    await view.unmount();
  });

  it('cancel during recording discards local audio and preserves the typed draft', async () => {
    const { environment, recorders } = harness();
    const adapter = { upload: vi.fn() } satisfies VoiceUploadAdapter;
    const view = await mount(
      <Composer {...baseProps} draftValue="Draft stays" voice={voiceConfig(environment, adapter)} />,
    );
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Record voice note"]') as HTMLElement).click();
    });
    await waitFor(() => recorders[0]?.state === 'recording');
    await React.act(async () => {
      recorders[0]!.emit('voice');
    });
    const cancel = Array.from(view.host.querySelectorAll('button')).find(button => button.textContent === 'Cancel');
    expect(cancel).toBeTruthy();
    await React.act(async () => cancel!.click());
    await waitFor(() => view.host.querySelector('textarea') !== null);
    expect((view.host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Draft stays');
    await view.unmount();
  });

  it('stops at the three-minute cap into Review', async () => {
    const { environment, recorders, setNow } = harness();
    const adapter = { upload: vi.fn() } satisfies VoiceUploadAdapter;
    const view = await mount(<Composer {...baseProps} voice={voiceConfig(environment, adapter)} />);
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Record voice note"]') as HTMLElement).click();
    });
    await waitFor(() => recorders[0]?.state === 'recording');
    setNow(1_000_000 + 180_000);
    await waitFor(() => view.host.querySelector('[aria-label="Send voice note"]') !== null, 6000);
    expect(recorders[0]!.state).toBe('inactive');
    expect(view.host.textContent).toContain('Three-minute limit reached');
    await view.unmount();
  }, 15_000);

  it('backgrounding stops capture and explains the interruption on return', async () => {
    const { environment, recorders } = harness();
    const adapter = { upload: vi.fn() } satisfies VoiceUploadAdapter;
    const view = await mount(<Composer {...baseProps} voice={voiceConfig(environment, adapter)} />);
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Record voice note"]') as HTMLElement).click();
    });
    await waitFor(() => recorders[0]?.state === 'recording');
    await React.act(async () => {
      recorders[0]!.emit('voice');
    });
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    hidden = true;
    await React.act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => view.host.querySelector('[aria-label="Send voice note"]') !== null);
    expect(view.host.textContent).toContain('Recording stopped when the app went to the background');
    expect(recorders[0]!.state).toBe('inactive');
    await view.unmount();
  });

  it('retry after a failed upload reuses the same client message identity', async () => {
    const { environment, recorders } = harness();
    const upload = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ media: storyMedia });
    const adapter: VoiceUploadAdapter = { upload };
    const onSent = vi.fn();
    const view = await mount(
      <Composer {...baseProps} voice={{ ...voiceConfig(environment, adapter), onSent }} />,
    );
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
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Send voice note"]') as HTMLElement).click();
    });
    await waitFor(() => view.host.querySelector('[aria-label="Retry sending voice note"]') !== null);
    expect(view.host.textContent).toContain('Could not send the recording');
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Retry sending voice note"]') as HTMLElement).click();
    });
    await waitFor(() => onSent.mock.calls.length === 1);
    expect(upload).toHaveBeenCalledTimes(2);
    const first = upload.mock.calls[0]![0] as { clientMessageId: string };
    const second = upload.mock.calls[1]![0] as { clientMessageId: string };
    expect(first.clientMessageId).toBe(second.clientMessageId);
    await waitFor(() => view.host.querySelector('textarea') !== null);
    await view.unmount();
  });

  it('recording during active work offers capture Stop, not the run Stop', async () => {
    const { environment, recorders } = harness();
    const adapter = { upload: vi.fn() } satisfies VoiceUploadAdapter;
    const view = await mount(
      <Composer {...baseProps} running onStop={async () => {}} voice={voiceConfig(environment, adapter)} />,
    );
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Record voice note"]') as HTMLElement).click();
    });
    await waitFor(() => recorders[0]?.state === 'recording');
    expect(view.host.querySelector('[aria-label="Stop recording"]')).toBeTruthy();
    expect(view.host.querySelector('[aria-label="Stop Otis"]')).toBeNull();
    await view.unmount();
  });
});
