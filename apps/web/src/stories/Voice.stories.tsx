import type { Meta, StoryObj } from '@storybook/react-vite';
import { ContractOnly } from './ContractOnly.js';

const meta: Meta<typeof ContractOnly> = {
  title: 'Voice',
  component: ContractOnly,
};

export default meta;
type Story = StoryObj<typeof ContractOnly>;

const voice = (fixtureId: string, expects: string): Story => ({
  name: fixtureId,
  args: { fixtureId, expects, owner: '010 with its capture and device contract' },
});

export const Permission: Story = voice(
  'voice/permission',
  'Microphone permission asks locally with useful retry; the typed draft is retained.',
);
export const Recording: Story = voice(
  'voice/recording',
  'Real duration and level with Stop and Cancel inside a three-minute cap.',
);
export const Interrupted: Story = voice(
  'voice/interrupted',
  'Interruption explains the stop and offers the validated saved portion or discard.',
);
export const Review: Story = voice(
  'voice/review',
  'Playback with duration plus Send or Cancel. No auto-submission.',
);
export const Upload: Story = voice(
  'voice/upload',
  'Locally retained recording with same-identity retry while offline or uploading.',
);
export const Transcribing: Story = voice(
  'voice/transcribing',
  'Actual server stage only. No invented answer before the transcript exists.',
);
export const Uncertain: Story = voice(
  'voice/uncertain',
  'Uncertain names, amounts and dates ask narrowly with the affected excerpt.',
);
export const Expired: Story = voice(
  'voice/expired',
  'Accepted audio expires after fourteen days; the transcript stays readable as Audio expired.',
);
export const RecordingDuringWork: Story = voice(
  'voice/recording-during-work',
  'Recording during earlier work uses the same composer and capture Stop to Review contract, not an extra recorder. Server routing and device capture arrive with 010.',
);
export const AmountConfirmation: Story = voice(
  'voice/amount-confirmation',
  'Uncertain amounts use server-supplied clarification choices answered in the composer. No invented numeric confidence.',
);
