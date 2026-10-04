import type { Meta, StoryObj } from '@storybook/react-vite';
import { Transcript, type TranscriptProps } from '../components/Transcript.js';
import { storyActivity, storyMembers, storyMessage } from './fixtures.js';

const base = {
  members: storyMembers,
  currentUserId: 'user-hunor',
  steps: [],
  onInspectAction: () => {},
  onLoadOlder: () => {},
};

const meta: Meta<typeof Transcript> = {
  title: 'Scroll',
  component: Transcript,
  parameters: {
    docs: {
      description: {
        component: 'Reading position fixtures use the production Transcript in a bounded frame. Follow/release behavior is owned by 008C with browser evidence.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Transcript>;

const manyMessages = Array.from({ length: 30 }, (_, index) =>
  index % 2 === 0
    ? storyMessage({ content_text: `Note ${index + 1}: talked to the bakery about Friday.` })
    : storyMessage({ content_text: `Saved note ${index + 1}.`, author_kind: 'system', author_user_id: null }),
);

function framed(args: Partial<TranscriptProps>) {
  return (
    <div className="sb-scroll">
      <Transcript messages={[]} members={storyMembers} currentUserId="user-hunor" steps={[]} onInspectAction={() => {}} {...args} />
    </div>
  );
}

export const Follow: Story = {
  name: 'scroll/follow',
  render: args => framed(args),
  args: { ...base, messages: manyMessages },
};

export const Released: Story = {
  name: 'scroll/released',
  render: args => framed(args),
  args: { ...base, messages: manyMessages },
  parameters: { docs: { description: { story: 'Scrolling up releases follow; new output preserves reading position plus Jump to latest (008C).' } } },
};

export const Prepend: Story = {
  name: 'scroll/prepend',
  render: args => framed(args),
  args: { ...base, messages: manyMessages, hasOlder: true },
};

export const PrependWhileStreaming: Story = {
  name: 'scroll/prepend-while-streaming',
  render: args => framed(args),
  args: {
    ...base,
    messages: [...manyMessages, storyMessage({ content_text: 'And the bistro?', run_id: 'run-story-1' })],
    hasOlder: true,
    activities: [storyActivity({ type: 'text_chunk', run_id: 'run-story-1', payload: { text: 'Checking the bistro…' } })],
  },
  parameters: { docs: { description: { story: 'Older pages insert above without losing the live answer position (008C).' } } },
};
