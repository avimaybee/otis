import type { Meta, StoryObj } from '@storybook/react-vite';
import { Transcript, WorkingDisclosure } from '../components/Transcript.js';
import { StatusPill } from '../components/StatusPill.js';
import { storyActivity, storyMembers, storyMessage, storyRun } from './fixtures.js';

const meta: Meta<typeof Transcript> = {
  title: 'Work',
  component: Transcript,
  parameters: {
    docs: {
      description: {
        component: 'Working shows persisted real activity with the production disclosure: static highlight dot, chronological steps, compact terminal state.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Transcript>;

const base = {
  members: storyMembers,
  currentUserId: 'user-hunor',
  steps: [],
  onInspectAction: () => {},
};

const member = storyMessage({ content_text: 'Mark Thai Shop warm and remind me Friday.', run_id: 'run-story-1' });

const runningActivities = [
  storyActivity({ type: 'step_started', run_id: 'run-story-1', payload: { tool_name: 'set_fields', step_index: 0 } }),
];

export const Running: Story = {
  name: 'work/running',
  args: { ...base, messages: [member], activities: runningActivities },
};

const finishedRun = storyRun('succeeded', {
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
    { step_index: 1, tool_name: 'create_task', status: 'succeeded', action_id: null, result: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ],
});

const answered = storyMessage({
  content_text: 'Done. Thai Shop is warm with the offer due Friday.',
  author_kind: 'system',
  author_user_id: null,
  run_id: 'run-story-1',
});

export const Finished: Story = {
  name: 'work/finished',
  args: { ...base, messages: [member, answered], runs: { 'run-story-1': finishedRun } },
};

export const Expanded: Story = {
  name: 'work/expanded',
  render: () => (
    <div className="sb-column">
      <WorkingDisclosure
        steps={[
          { id: 'step-0', label: 'Updating the record', state: 'succeeded', actionId: 'action-7', summary: 'Thai Shop is warm.' },
          { id: 'step-1', label: 'Saving the follow-up', state: 'succeeded' },
        ]}
        finished
        expanded
        onToggle={() => {}}
        onInspectAction={() => {}}
      />
    </div>
  ),
};

const failedRun = storyRun('failed', {
  run: { ...storyRun('failed').run, error_code: 'provider_stream_error', error_message: 'Provider transport failed.' },
});

export const Failed: Story = {
  name: 'work/failed',
  args: {
    ...base,
    messages: [member],
    runs: { 'run-story-1': failedRun },
  },
};

export const Partial: Story = {
  name: 'work/partial',
  args: {
    ...base,
    messages: [member],
    runs: { 'run-story-1': storyRun('partial', { actions: finishedRun.actions }) },
  },
};

export const Stopped: Story = {
  name: 'work/stopped',
  args: {
    ...base,
    messages: [member],
    runs: { 'run-story-1': storyRun('cancelled') },
  },
};

export const StatusPills: Story = {
  name: 'work/status-pills',
  render: () => (
    <div className="sb-column">
      <p className="text-sm text-muted-foreground">Restaurant 2 just went <StatusPill status="warm" />. Offer by Friday?</p>
      <p className="text-sm text-muted-foreground">Bistro is <StatusPill status="hot" /> after six pitches.</p>
      <p className="text-sm text-muted-foreground">Bakery is <StatusPill status="cold" /> for now.</p>
      <p className="text-sm text-muted-foreground">Thai Shop <StatusPill status="won" /> the catering deal.</p>
    </div>
  ),
  parameters: { docs: { description: { story: 'Reference composition: warm and hot use the highlight outline; other states stay neutral; won uses success text.' } } },
};

function thinkActivity(runId: string, text: string, extra: Record<string, unknown> = {}) {
  return storyActivity({
    type: 'reasoning_summary',
    run_id: runId,
    payload: {
      provider: 'gemini',
      round_index: 0,
      block_id: 's0',
      content_kind: 'summary',
      mode: 'append',
      state: 'streaming',
      text,
      ...extra,
    },
  });
}

const thinkingMember = storyMessage({ content_text: 'Is Thai Shop a good fit?', run_id: 'run-think-1' });

export const ThinkingLive: Story = {
  name: 'work/thinking-live',
  args: {
    ...base,
    messages: [thinkingMember],
    runs: { 'run-think-1': storyRun('running') },
    activities: [thinkActivity('run-think-1', 'Checking the visit notes '), thinkActivity('run-think-1', 'against Friday promises.')],
  },
  parameters: { docs: { description: { story: 'The nested Thinking trigger appears once displayable content exists; it begins collapsed.' } } },
};

export const ThinkingFinished: Story = {
  name: 'work/thinking-finished',
  args: {
    ...base,
    messages: [
      thinkingMember,
      storyMessage({ content_text: 'Thai Shop fits: warm with Friday due.', author_kind: 'system', author_user_id: null, run_id: 'run-think-1' }),
    ],
    runs: { 'run-think-1': storyRun('succeeded') },
    activities: [
      thinkActivity('run-think-1', 'Checking the visit notes.', { state: 'complete' }),
      thinkActivity('run-think-1', '', { state: 'complete' }),
    ],
  },
};

export const ThinkingAbsent: Story = {
  name: 'work/thinking-absent',
  args: {
    ...base,
    messages: [
      thinkingMember,
      storyMessage({ content_text: 'Saved without visible reasoning.', author_kind: 'system', author_user_id: null, run_id: 'run-think-1' }),
    ],
    runs: {
      'run-think-1': storyRun('succeeded', {
        steps: [
          { step_index: 0, tool_name: 'set_fields', status: 'succeeded', action_id: null, result: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        ],
      }),
    },
    activities: [],
  },
  parameters: { docs: { description: { story: 'Effort support without public text renders no Thinking disclosure at all.' } } },
};

export const ThinkingOnly: Story = {
  name: 'work/thinking-only',
  args: {
    ...base,
    messages: [
      thinkingMember,
      storyMessage({ content_text: 'Thai Shop looks warm.', author_kind: 'system', author_user_id: null, run_id: 'run-think-1' }),
    ],
    runs: { 'run-think-1': storyRun('succeeded') },
    activities: [thinkActivity('run-think-1', 'Weighing the Friday promise.', { state: 'complete' })],
  },
  parameters: { docs: { description: { story: 'A thinking-only reply says Worked with no invented step count.' } } },
};

export const ThinkingWithTools: Story = {
  name: 'work/thinking-with-tools',
  args: {
    ...base,
    messages: [
      thinkingMember,
      storyMessage({ content_text: 'Marked warm with Friday due.', author_kind: 'system', author_user_id: null, run_id: 'run-think-1' }),
    ],
    runs: {
      'run-think-1': storyRun('succeeded', {
        actions: [
          { action_id: 'action-7', command_name: 'set_fields', result_status: 'applied', committed_revision: 42, summary: 'Thai Shop is warm.', created_at: new Date().toISOString() },
        ],
        steps: [
          { step_index: 0, tool_name: 'set_fields', status: 'succeeded', action_id: 'action-7', result: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        ],
      }),
    },
    activities: [thinkActivity('run-think-1', 'Confirming the status change first.', { state: 'complete' })],
  },
};

export const ThinkingInterrupted: Story = {
  name: 'work/thinking-interrupted',
  args: {
    ...base,
    messages: [thinkingMember],
    runs: { 'run-think-1': storyRun('failed', { run: { ...storyRun('failed').run, error_code: 'provider_stream_error' } }) },
    activities: [thinkActivity('run-think-1', 'Halfway through the records ')],
  },
  parameters: { docs: { description: { story: 'Stop and failure keep useful partial content, marked interrupted from the terminal run state.' } } },
};

export const ThinkingReplay: Story = {
  name: 'work/thinking-replay',
  args: {
    ...base,
    messages: [thinkingMember],
    runs: { 'run-think-1': storyRun('running') },
    activities: (() => {
      const first = thinkActivity('run-think-1', 'Same words twice ');
      return [first, { ...first }];
    })(),
  },
  parameters: { docs: { description: { story: 'Reconnect replay deduplicates by record identity; the text appears once.' } } },
};

export const ThinkingTruncated: Story = {
  name: 'work/thinking-truncated',
  args: {
    ...base,
    messages: [thinkingMember],
    runs: { 'run-think-1': storyRun('succeeded') },
    activities: [
      thinkActivity('run-think-1', 'Long deliberation kept within budget.', { state: 'complete' }),
      thinkActivity('run-think-1', '', { state: 'truncated' }),
    ],
  },
  parameters: { docs: { description: { story: 'The display cap says Thinking truncated once; the answer is unaffected.' } } },
};
