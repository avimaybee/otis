import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ClarificationSummary } from '@otis/contracts';
import { QuestionPanel } from '../components/QuestionPanel.js';
import { Transcript } from '../components/Transcript.js';
import { ContractOnly } from './ContractOnly.js';
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

const panelContract = (fixtureId: string, expects: string): Story => ({
  name: fixtureId,
  args: {} as never,
  render: () => (
    <ContractOnly fixtureId={fixtureId} expects={expects} owner="question panel plan 2026-10-07-codex-style-questions-plan" />
  ),
});

/**
 * Contract-only question-panel states (design.md section 6, token 8.12).
 * The production QuestionPanel does not exist yet; these record the
 * expected content contract for review and authorize no shipped control.
 */
export const FreeText: Story = {
  name: 'question/free-text',
  args: {} as never,
  render: () => {
    const question: ClarificationSummary = {
      id: 'q-story-free-1',
      chat_id: 'chat-storybook',
      run_id: 'run-story-1',
      question: 'Which Friday should I use for the Thai Shop offer?',
      intended_operation: 'create_task',
      missing_fields: ['due'],
      candidates: ['This Friday', 'Next Friday'],
      status: 'pending',
      created_at: new Date(Date.UTC(2026, 9, 4, 9, 30, 0)).toISOString(),
      answerable_by_caller: true,
    };
    return (
      <QuestionPanel
        question={question}
        draftKey="storybook:question:free-text"
        onSubmit={() => {}}
        onSkip={() => {}}
        onClose={() => {}}
      />
    );
  },
  parameters: { docs: { description: { story: 'Production answer panel: numbered suggestions fill the field, typed text wins, Send carries the question identity.' } } },
};
export const Skipped: Story = panelContract(
  'question/skipped',
  'Skip defers without resolving; the pending callout stays reopenable.',
);
export const Reopened: Story = panelContract(
  'question/reopened',
  'Answer question opens that exact question and restores its scoped draft.',
);
export const Pending: Story = panelContract(
  'question/pending',
  'Local answer echo within 100 ms; panel owns its submission state.',
);
export const Failed: Story = panelContract(
  'question/failed',
  'Failed answer stays attached with same-payload Retry and editable recovery.',
);
export const Stale: Story = panelContract(
  'question/stale',
  'Resolved or superseded question refuses stale submission with recovery.',
);
export const LateAcceptance: Story = panelContract(
  'question/late-acceptance',
  'Late acknowledgement clears only its matching submission, never a newer draft.',
);
export const ChatIndependent: Story = panelContract(
  'question/chat-independent',
  'Ordinary chat, commands and voice stay sendable while a question waits.',
);
