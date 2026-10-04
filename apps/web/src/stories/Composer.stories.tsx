import type { Meta, StoryObj } from '@storybook/react-vite';
import { Composer } from '../components/Composer.js';
import { storyCommands, storyModels } from './fixtures.js';

const base = {
  running: false,
  commands: storyCommands,
  models: storyModels,
  workspaces: [{ id: 'ws-1', name: 'Kerning' }],
  onSend: async () => true,
  onCommand: async () => true,
};

const meta: Meta<typeof Composer> = {
  title: 'Composer',
  component: Composer,
  decorators: [
    Story => (
      <div className="sb-composer-dock">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component: 'One production composer: a single textarea plus the Send/Stop slot. No toolbar, no model chips.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Composer>;

export const Empty: Story = {
  name: 'composer/empty',
  args: { ...base },
};

export const Short: Story = {
  name: 'composer/short',
  args: { ...base, draftValue: 'Thai Shop wants the offer by Friday.' },
};

export const Multiline: Story = {
  name: 'composer/multiline',
  args: {
    ...base,
    draftValue: 'Visited three places today.\nThai Shop is warm.\nBakery wants the offer Friday.',
  },
};

export const MaxLines: Story = {
  name: 'composer/max-lines',
  args: {
    ...base,
    draftValue: Array.from({ length: 8 }, (_, index) => `Line ${index + 1} of a long field note.`).join('\n'),
  },
  parameters: { docs: { description: { story: 'The field grows to six lines, then scrolls internally.' } } },
};

export const Ime: Story = {
  name: 'composer/ime',
  args: { ...base, draftValue: 'Școala din Târgu Mureș' },
  parameters: { docs: { description: { story: 'IME composition never submits mid-composition; Enter behavior is verified on devices in 008C.' } } },
};

export const FollowUp: Story = {
  name: 'composer/follow-up',
  args: {
    ...base,
    running: true,
    draftValue: 'actually make it Friday morning',
    onStop: async () => {},
    replyTo: {
      question: 'Which Friday should I use?',
      onCancel: () => {},
    },
  },
  parameters: {
    docs: {
      description: {
        story: 'A valid follow-up draft shows Send in the shared slot while Stop stays reachable through chat overflow.',
      },
    },
  },
};
