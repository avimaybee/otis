import type { Meta, StoryObj } from '@storybook/react-vite';
import { Transcript } from '../components/Transcript.js';
import { storyActivity, storyMembers, storyMessage } from './fixtures.js';

/**
 * General table capability: the model chooses columns per question and the
 * shared MarkdownTable shell renders every subject. Saved and streaming
 * branches use the same production renderer.
 */

const base = {
  members: storyMembers,
  currentUserId: 'user-hunor',
  steps: [],
  onInspectAction: () => {},
};

const meta: Meta<typeof Transcript> = {
  title: 'Table',
  component: Transcript,
  parameters: {
    docs: {
      description: {
        component: 'Model-composed tables for any subject: comparisons, timelines, plans. One semantic table per scroll region with a working Copy-table action.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Transcript>;

const ask = (text: string) => storyMessage({ content_text: text, run_id: 'run-story-table' });
const answer = (text: string) => storyMessage({ content_text: text, author_kind: 'system', author_user_id: null, run_id: 'run-story-table' });

export const Compare: Story = {
  name: 'table/compare',
  args: {
    ...base,
    messages: [
      ask('Compare these three quotes, including scope and downsides.'),
      answer([
        'Three options, cheapest first:',
        '',
        '| Supplier | Price | Scope | Exclusions | Tradeoff |',
        '|---|---|---|---|---|',
        '| Meridian Studio | €4,800 | Website + CRM setup | Copywriting | Fastest start, thinnest support |',
        '| Cedar Labs | €5,600 | Website + CRM + 3 months support | Data migration | Balanced cost and coverage |',
        '| Harbor Works | €7,200 | Full rebuild + migration + 12 months support | None listed | Most complete, slowest kickoff |',
        '',
        'Meridian wins on speed; Harbor wins on completeness.',
      ].join('\n')),
    ],
  },
};

export const Timeline: Story = {
  name: 'table/timeline',
  args: {
    ...base,
    messages: [
      ask('Show everything that happened with Cedar.'),
      answer([
        'With Cedar Labs so far:',
        '',
        '| Date | Interaction | Outcome |',
        '|---|---|---|',
        '| 12 Sep | Intro call | Interested, asked for a demo |',
        '| 19 Sep | Demo | Wants CRM contacts sync |',
        '| 2 Oct | Sent offer | Waiting on reply |',
      ].join('\n')),
    ],
  },
};

export const ActionPlan: Story = {
  name: 'table/action-plan',
  args: {
    ...base,
    messages: [
      ask('Turn these notes into an action plan.'),
      answer([
        'Action plan — suggested owners and dates are proposals, not commitments:',
        '',
        '| Action | Purpose | Depends on | Proposed owner |',
        '|---|---|---|---|',
        '| Send revised quote | Unblock Meridian decision | Final pricing | You |',
        '| Book migration window | Avoid Harbor downtime | Signed scope | You |',
      ].join('\n')),
    ],
  },
};

export const LongCells: Story = {
  name: 'table/long-cells',
  args: {
    ...base,
    messages: [
      ask('Compare our options in detail.'),
      answer([
        '| Option | Detail | Limitation |',
        '|---|---|---|',
        '| Stay on spreadsheets | Nothing changes; the team keeps the tracker they already know, with no migration cost and no new tool to learn this quarter. | Reporting stays manual and the client list keeps drifting out of date across copies. |',
        '| Adopt Otis fully | One shared memory for visits, promises and follow-ups; briefs surface overdue work before it slips. | Needs someone to log visits consistently for the first two weeks. |',
      ].join('\n')),
    ],
  },
  parameters: { docs: { description: { story: 'Long descriptive cells wrap at normal text size; the table scrolls horizontally only when columns truly overflow.' } } },
};

export const MissingValues: Story = {
  name: 'table/missing-values',
  args: {
    ...base,
    messages: [
      ask("What's the status of all leads?"),
      answer([
        '3 leads: one hot, one warm, one cold. Meridian’s follow-up is overdue; Harbor has no next step recorded.',
        '',
        '| Lead | Status | Next step | Due | Owner |',
        '|---|---|---|---|---|',
        '| Meridian Studio | Hot | Send revised quote | 6 Oct · overdue | You |',
        '| Cedar Labs | Warm | Follow up after demo | 8 Oct | Hunor |',
        '| Harbor Works | Cold | No open task | No date set | Unassigned |',
      ].join('\n')),
    ],
  },
  parameters: { docs: { description: { story: 'Unknown and disputed values stay explicit; a coverage summary accompanies the table.' } } },
};

export const Multiple: Story = {
  name: 'table/multiple',
  args: {
    ...base,
    messages: [
      ask('Explain the tradeoffs, then show me the numbers.'),
      answer([
        'Meridian is fastest, Harbor is most complete — that is the whole tradeoff.',
        '',
        '| Supplier | Price |',
        '|---|---:|',
        '| Meridian Studio | €4,800 |',
        '| Harbor Works | €7,200 |',
        '',
        'Follow-ups still open:',
        '',
        '| Lead | Next step |',
        '|---|---|',
        '| Meridian Studio | Send revised quote |',
      ].join('\n')),
    ],
  },
  parameters: { docs: { description: { story: 'Prose and several small tables compose instead of forcing one grid.' } } },
};

const streamingMember = storyMessage({ content_text: 'Compare the two offers.', run_id: 'run-story-table-stream' });

export const Streaming: Story = {
  name: 'table/streaming',
  args: {
    ...base,
    messages: [streamingMember],
    activities: [
      storyActivity({ type: 'text_chunk', run_id: 'run-story-table-stream', payload: { text: '| Supplier | Price |\n|---|---|\n| Meridian Studio | €4,800' } }),
    ],
  },
  parameters: { docs: { description: { story: 'An unfinished streamed table settles as syntax completes; the copy action tracks the rendered rows.' } } },
};
