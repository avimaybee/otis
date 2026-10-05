/** @vitest-environment happy-dom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { VoiceMessagePlayer } from '../src/components/VoiceMessagePlayer.js';

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
});

async function mount(element: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => root.render(element));
  return {
    host,
    unmount: async () => {
      await React.act(async () => root.unmount());
      host.remove();
    },
  };
}

describe('VoiceMessagePlayer (SOL-09)', () => {
  it('renders transcript text alongside playback control', async () => {
    const view = await mount(
      <VoiceMessagePlayer
        workspaceId="ws_1"
        mediaId="med_1"
        text="Visited Bistro, they loved the new price."
      />,
    );

    expect(view.host.textContent).toContain('Visited Bistro, they loved the new price.');
    expect(view.host.textContent).toContain('Play recording');
    const playButton = view.host.querySelector('button[aria-label="Play voice note"]');
    expect(playButton).not.toBeNull();

    await view.unmount();
  });

  it('renders honest expired state when audio returns 410 audio_expired', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 410,
      json: async () => ({ error: 'audio_expired' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    // Mock HTMLAudioElement play rejection to trigger onerror / inspectError
    const playMock = vi.fn().mockRejectedValue(new Error('MediaError 410'));
    class MockAudio {
      src = '';
      play = playMock;
      pause = vi.fn();
      removeAttribute = vi.fn();
      load = vi.fn();
      constructor(src?: string) {
        if (src) this.src = src;
      }
    }
    vi.stubGlobal('Audio', MockAudio);

    const view = await mount(
      <VoiceMessagePlayer
        workspaceId="ws_1"
        mediaId="med_expired"
        text="Retained text transcript"
      />,
    );

    const playButton = view.host.querySelector('button[aria-label="Play voice note"]') as HTMLButtonElement;
    await React.act(async () => {
      playButton.click();
    });

    expect(view.host.textContent).toContain('Recording expired. Transcript retained.');
    expect(view.host.textContent).toContain('Retained text transcript');

    await view.unmount();
  });
});
