import type { Meta, StoryObj } from '@storybook/react-vite';
import { Transcript } from '../components/Transcript.js';
import { storyActivity, storyMembers, storyMessage } from './fixtures.js';

const base = {
  members: storyMembers,
  currentUserId: 'user-hunor',
  steps: [],
  onInspectAction: () => {},
};

const meta: Meta<typeof Transcript> = {
  title: 'Stream',
  component: Transcript,
  parameters: {
    docs: {
      description: {
        component: 'Streaming appends deduplicated text deltas to the production renderer. Synthetic chunks only.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Transcript>;

const liveMember = storyMessage({ content_text: 'What did Thai Shop say?', run_id: 'run-story-1' });

export const Live: Story = {
  name: 'stream/live',
  args: {
    ...base,
    messages: [liveMember],
    activities: [
      storyActivity({ type: 'text_chunk', run_id: 'run-story-1', payload: { text: 'Thai Shop wants ' } }),
      storyActivity({ type: 'text_chunk', run_id: 'run-story-1', payload: { text: 'the offer by Friday.' } }),
    ],
  },
};

export const UnfinishedMarkdown: Story = {
  name: 'stream/unfinished-markdown',
  args: {
    ...base,
    messages: [liveMember],
    activities: [
      storyActivity({ type: 'text_chunk', run_id: 'run-story-1', payload: { text: '**Thai Shop** wants the offer by *Friday' } }),
    ],
  },
  parameters: { docs: { description: { story: 'Unfinished markdown may settle as syntax completes; earlier blocks stay stable.' } } },
};

export const Replay: Story = {
  name: 'stream/replay',
  args: {
    ...base,
    messages: [liveMember],
    activities: [
      storyActivity({ type: 'text_chunk', run_id: 'run-story-1', payload: { text: 'Thai Shop wants the offer by Friday.' } }),
    ],
  },
  parameters: { docs: { description: { story: 'Reconnect resumes from the persisted cursor with cursor replay, never a new model request.' } } },
};

export const Disconnected: Story = {
  name: 'stream/disconnected',
  render: args => (
    <div>
      <p className="otis-connection text-xs" role="status">Reconnecting to activity… Your conversation is retained.</p>
      <Transcript {...args} />
    </div>
  ),
  args: {
    ...base,
    messages: [liveMember],
    activities: [
      storyActivity({ type: 'text_chunk', run_id: 'run-story-1', payload: { text: 'Thai Shop wants ' } }),
    ],
  },
  parameters: { docs: { description: { story: 'Disconnect keeps useful content and resumes snapshots; the resync line uses the production connection class.' } } },
};
