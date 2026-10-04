import type { Meta, StoryObj } from '@storybook/react-vite';
import { Transcript } from '../components/Transcript.js';
import { UnavailableScreen } from '../components/UnavailableScreen.js';
import { storyMembers, storyMessage } from './fixtures.js';

const transcriptBase = {
  members: storyMembers,
  currentUserId: 'user-hunor',
  steps: [],
  onInspectAction: () => {},
};

const meta: Meta<typeof Transcript> = {
  title: 'Offline',
  component: Transcript,
  parameters: {
    docs: {
      description: {
        component:
          'Offline behavior uses production components with synthetic delivery state. Unsent input stays visible with honest local state until the bounded foreground flush confirms acceptance; the static shell explains connectivity without inventing a session.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Transcript>;

const pendingOffline = storyMessage({
  content_text: 'Bistro confirmed Friday, 9 October for the offer.',
  run_id: null,
  client_message_id: 'client-offline-1',
});
const failedOffline = storyMessage({
  content_text: 'Thai Shop wants the offer by Friday.',
  run_id: null,
  client_message_id: 'client-offline-2',
});

export const Shell: Story = {
  name: 'offline/shell',
  render: () => <UnavailableScreen offline onRetry={() => {}} />,
  parameters: {
    docs: {
      description: {
        story:
          'Installed PWA opens its static shell without signal. It explains connectivity, invents no session, data or answers, and retries through the normal session path.',
      },
    },
  },
};

export const Pending: Story = {
  name: 'offline/pending',
  args: {
    ...transcriptBase,
    messages: [pendingOffline],
    delivery: { 'client-offline-1': { state: 'sending', durable: false } },
  },
  parameters: {
    docs: {
      description: {
        story:
          'Unsent input stays visible while storage is unavailable: device-only honesty instead of a recoverability claim.',
      },
    },
  },
};

export const Reconnect: Story = {
  name: 'offline/reconnect',
  args: {
    ...transcriptBase,
    messages: [pendingOffline, failedOffline],
    delivery: {
      'client-offline-1': { state: 'sending', durable: true },
      'client-offline-2': { state: 'failed', error: 'Network failed.', durable: true },
    },
    onRetryMessage: () => {},
    onDiscardMessage: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          'Online and foreground trigger one bounded flush reusing original UUIDs; failures keep Retry plus local-only Discard attached to the message.',
      },
    },
  },
};

export const StorageUnavailable: Story = {
  name: 'offline/storage-unavailable',
  args: {
    ...transcriptBase,
    messages: [pendingOffline],
    delivery: { 'client-offline-1': { state: 'sending', durable: false } },
  },
  parameters: {
    docs: {
      description: {
        story:
          'Storage or quota failure keeps recoverable in-memory content and explains the limit truthfully: keeping on this device only.',
      },
    },
  },
};
