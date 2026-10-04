import type { Meta, StoryObj } from '@storybook/react-vite';
import { Transcript } from '../components/Transcript.js';
import { storyMembers, storyMessage, storyRun } from './fixtures.js';

const base = {
  members: storyMembers,
  currentUserId: 'user-hunor',
  steps: [],
  onInspectAction: () => {},
};

const meta: Meta<typeof Transcript> = {
  title: 'Message',
  component: Transcript,
  parameters: {
    docs: {
      description: {
        component:
          'Capture and processing milestones share one production bubble with attached delivery state. Saved means durable acceptance, never a completed answer.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Transcript>;

const pendingMember = storyMessage({ content_text: 'Thai Shop wants the offer by Friday.', run_id: 'run-story-1', client_message_id: 'client-sending-1' });

export const Sending: Story = {
  name: 'message/sending',
  args: {
    ...base,
    messages: [pendingMember],
    delivery: { 'client-sending-1': { state: 'sending', durable: true } },
  },
  parameters: { docs: { description: { story: 'Local bubble exists; server acceptance is not yet confirmed. Same renderer as persisted messages.' } } },
};

export const Saved: Story = {
  name: 'message/saved',
  args: {
    ...base,
    messages: [storyMessage({ content_text: 'Thai Shop wants the offer by Friday.', run_id: 'run-story-1', client_message_id: 'client-saved-1' })],
    delivery: { 'client-saved-1': { state: 'saved', durable: true } },
  },
  parameters: { docs: { description: { story: 'Server acceptance is known and quiet; Otis may still be working.' } } },
};

const failedMember = storyMessage({ content_text: 'Thai Shop wants the offer by Friday.', run_id: null, client_message_id: 'client-failed-1' });

export const Failed: Story = {
  name: 'message/failed',
  args: {
    ...base,
    messages: [failedMember],
    delivery: { 'client-failed-1': { state: 'failed', error: 'Network failed.', durable: true } },
    onRetryMessage: () => {},
  },
  parameters: { docs: { description: { story: 'Delivery failure keeps the bubble with reason plus Retry attached to the message.' } } },
};

export const Retry: Story = {
  name: 'message/retry',
  args: {
    ...base,
    messages: [failedMember],
    delivery: { 'client-failed-1': { state: 'failed', error: 'Network failed.', durable: true } },
    onRetryMessage: () => {},
  },
  parameters: { docs: { description: { story: 'Retry reuses the same client UUID and payload, including clarification linkage.' } } },
};

export const UnknownAcceptance: Story = {
  name: 'message/unknown-acceptance',
  args: {
    ...base,
    messages: [storyMessage({ content_text: 'Thai Shop wants the offer by Friday.', run_id: 'run-story-1', client_message_id: 'client-unknown-1' })],
    delivery: { 'client-unknown-1': { state: 'sending', durable: true } },
  },
  parameters: { docs: { description: { story: 'Timeout after commit means uncertain acceptance: the same identity reconciles, never a second run.' } } },
};

export const LocalDurable: Story = {
  name: 'message/local-durable',
  args: {
    ...base,
    messages: [storyMessage({ content_text: 'Thai Shop wants the offer by Friday.', run_id: 'run-story-1', client_message_id: 'client-durable-1' })],
    delivery: { 'client-durable-1': { state: 'sending', durable: false } },
  },
  parameters: { docs: { description: { story: 'Storage failure keeps recoverable in-memory input and says reload recovery is unavailable.' } } },
};

const filedRun = storyRun('succeeded', {
  actions: [
    {
      action_id: 'action-7',
      command_name: 'set_fields',
      result_status: 'applied',
      committed_revision: 42,
      summary: 'Thai Shop is warm.',
      created_at: new Date().toISOString(),
    },
  ],
  steps: [
    { step_index: 0, tool_name: 'set_fields', status: 'succeeded', action_id: 'action-7', result: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ],
});

export const Filed: Story = {
  name: 'message/filed',
  args: {
    ...base,
    messages: [
      pendingMember,
      storyMessage({
        content_text: 'Done. Thai Shop is warm with the offer due Friday.',
        author_kind: 'system',
        author_user_id: null,
        run_id: 'run-story-1',
      }),
    ],
    runs: { 'run-story-1': filedRun },
  },
};

const partialRun = storyRun('partial', {
  actions: [
    {
      action_id: 'action-7',
      command_name: 'set_fields',
      result_status: 'applied',
      committed_revision: 42,
      summary: 'Thai Shop is warm.',
      created_at: new Date().toISOString(),
    },
  ],
});

export const PartialFiled: Story = {
  name: 'message/partial-filed',
  args: {
    ...base,
    messages: [
      pendingMember,
      storyMessage({
        content_text: 'Thai Shop is warm, but the follow-up did not save.',
        author_kind: 'system',
        author_user_id: null,
        run_id: 'run-story-1',
      }),
    ],
    runs: { 'run-story-1': partialRun },
  },
};
