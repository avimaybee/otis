import type { Meta, StoryObj } from '@storybook/react-vite';
import { Transcript } from '../components/Transcript.js';
import { storyClarification, storyMembers, storyMessage, storyRun } from './fixtures.js';

const base = {
  members: storyMembers,
  currentUserId: 'user-hunor',
  steps: [],
  onInspectAction: () => {},
  onReply: () => {},
};

const meta: Meta<typeof Transcript> = {
  title: 'Question',
  component: Transcript,
  parameters: {
    docs: {
      description: {
        component: 'Clarifications are ordinary conversational text answered in the composer. No badge, no card, no invented choices.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Transcript>;

function questionRun(question: string, runId = 'run-story-1') {
  const clarification = { ...storyClarification(question), run_id: runId };
  return storyRun('waiting_for_input', { run: { ...storyRun('waiting_for_input').run, id: runId }, pending_clarification: clarification });
}

function questionExchange(question: string, memberText: string, runId = 'run-story-1') {
  const member = storyMessage({ content_text: memberText, run_id: runId });
  return { messages: [member], runs: { [runId]: questionRun(question, runId) } };
}

export const Deadline: Story = {
  name: 'question/deadline',
  args: { ...base, ...questionExchange('Which Friday should I use for the Thai Shop offer?', 'Send Thai Shop the offer.') },
};

export const Status: Story = {
  name: 'question/status',
  args: { ...base, ...questionExchange('Should I mark Thai Shop warm, or leave it new?', 'Thai Shop seemed interested.') },
};

export const Entity: Story = {
  name: 'question/entity',
  args: { ...base, ...questionExchange('Thai Shop or Thai Garden?', 'Log a visit at Thai.') },
};

export const Dispute: Story = {
  name: 'question/dispute',
  args: { ...base, ...questionExchange('You said 3,500, Hunor logged 3,600. Which one is live?', 'The Bistro deal is 3,500.') },
};

export const Multiple: Story = {
  name: 'question/multiple',
  args: {
    ...base,
    messages: [
      storyMessage({ content_text: 'Send Thai Shop the offer.', run_id: 'run-story-1' }),
      storyMessage({ content_text: 'Move the Bistro visit to Friday.', run_id: 'run-story-2' }),
    ],
    runs: {
      'run-story-1': questionRun('Which Friday should I use for the Thai Shop offer?', 'run-story-1'),
      'run-story-2': questionRun('Morning or afternoon on Friday?', 'run-story-2'),
    },
  },
  parameters: { docs: { description: { story: 'Each pending question stays attached to its own request context.' } } },
};
