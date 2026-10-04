import type { Meta, StoryObj } from '@storybook/react-vite';
import type { VoiceMediaSummary } from '@otis/contracts';
import { Composer } from '../components/Composer.js';
import type { VoiceUploadAdapter } from '../api/voice.js';
import type { VoiceController } from '../hooks/useVoiceRecorder.js';
import { storyCommands, storyModels } from './fixtures.js';
import { ContractOnly } from './ContractOnly.js';

/**
 * Voice fixtures (design.md section 10). The recorder-owned states render the
 * one production Composer with clearly synthetic recorder state. Server-stage
 * and message-render fixtures stay labeled contract-only until the backend
 * route and the production voice message component exist.
 */

const meta: Meta<typeof Composer> = {
  title: 'Voice',
  component: Composer,
  decorators: [
    Story => (
      <div className="sb-composer-dock">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof Composer>;

const base = {
  running: false,
  commands: storyCommands,
  models: storyModels,
  workspaces: [{ id: 'ws-storybook', name: 'Kerning' }],
  onSend: async () => true,
  onCommand: async () => true,
};

const scope = { userId: 'user-hunor', workspaceId: 'ws-storybook', chatId: 'chat-storybook' };

const storyMedia: VoiceMediaSummary = {
  media_id: 'med_storyvoice1',
  workspace_id: 'ws-storybook',
  chat_id: 'chat-storybook',
  uploader_user_id: 'user-hunor',
  state: 'transcribing',
  format: 'audio/webm',
  content_type: 'audio/webm',
  byte_size: 48_000,
  duration_ms: 23_000,
  created_at: new Date(Date.UTC(2026, 9, 4, 9, 30, 0)).toISOString(),
  expires_at: new Date(Date.UTC(2026, 9, 18, 9, 30, 0)).toISOString(),
  transcript: null,
  transcription: null,
};

const storyAdapter: VoiceUploadAdapter = { upload: async () => ({ media: storyMedia }) };

function voiceController(overrides: Partial<VoiceController>): VoiceController {
  return {
    phase: 'idle',
    elapsedMs: 0,
    levels: [],
    error: null,
    errorCode: null,
    interrupted: false,
    capReached: false,
    durable: true,
    recoverable: true,
    missingChunks: 0,
    uploadState: 'idle',
    review: null,
    playing: false,
    start: async () => {},
    stop: () => {},
    cancel: () => {},
    discard: () => {},
    send: async () => {},
    togglePlayback: () => {},
    ...overrides,
  };
}

/** Clearly synthetic measured levels for the story only; production reads the analyser. */
const storyLevels = Array.from({ length: 28 }, (_, index) => 0.2 + 0.65 * Math.abs(Math.sin(index / 2.7)));

const review = {
  sessionId: 'session-story-1',
  durationMs: 23_000,
  mimeType: 'audio/webm',
  clientMessageId: 'client-voice-story-1',
};

export const Permission: Story = {
  name: 'voice/permission',
  args: {
    ...base,
    draftValue: 'Bistro owner wants the offer by Thursday.',
    voice: {
      available: true,
      adapter: storyAdapter,
      scope,
      controller: voiceController({
        error: 'Microphone access is blocked. Allow it in your browser, then try again.',
        errorCode: 'permission',
      }),
    },
  },
};

export const Recording: Story = {
  name: 'voice/recording',
  args: {
    ...base,
    voice: {
      available: true,
      adapter: storyAdapter,
      scope,
      controller: voiceController({ phase: 'recording', elapsedMs: 14_000, levels: storyLevels }),
    },
  },
};

export const Interrupted: Story = {
  name: 'voice/interrupted',
  args: {
    ...base,
    voice: {
      available: true,
      adapter: storyAdapter,
      scope,
      controller: voiceController({ phase: 'review', elapsedMs: 11_000, interrupted: true, review }),
    },
  },
};

export const Review: Story = {
  name: 'voice/review',
  args: {
    ...base,
    voice: {
      available: true,
      adapter: storyAdapter,
      scope,
      controller: voiceController({ phase: 'review', elapsedMs: 23_000, review }),
    },
  },
};

export const Upload: Story = {
  name: 'voice/upload',
  args: {
    ...base,
    voice: {
      available: true,
      adapter: storyAdapter,
      scope,
      controller: voiceController({
        phase: 'review',
        elapsedMs: 23_000,
        review,
        uploadState: 'failed',
        error: 'Could not send the recording. It is kept on this device. Try again.',
        errorCode: 'upload',
      }),
    },
  },
};

export const RecordingDuringWork: Story = {
  name: 'voice/recording-during-work',
  args: {
    ...base,
    running: true,
    onStop: async () => {},
    voice: {
      available: true,
      adapter: storyAdapter,
      scope,
      controller: voiceController({ phase: 'recording', elapsedMs: 6_000, levels: storyLevels }),
    },
  },
};

const contract = (fixtureId: string, expects: string): Story => ({
  name: fixtureId,
  args: {} as never,
  render: () => (
    <ContractOnly fixtureId={fixtureId} expects={expects} owner="010 backend route and the production voice message component" />
  ),
});

export const Transcribing: Story = contract(
  'voice/transcribing',
  'Actual server stage only. No invented answer before the transcript exists.',
);
export const Uncertain: Story = contract(
  'voice/uncertain',
  'Uncertain names, amounts and dates ask narrowly with the affected excerpt.',
);
export const Expired: Story = contract(
  'voice/expired',
  'Accepted audio expires after fourteen days; the transcript stays readable as Audio expired.',
);
export const AmountConfirmation: Story = contract(
  'voice/amount-confirmation',
  'Uncertain amounts use server-supplied clarification choices answered in the composer. No invented numeric confidence.',
);
