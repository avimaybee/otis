import type { Meta, StoryObj } from '@storybook/react-vite';
import { HistoryNav } from '../components/HistoryNav.js';
import { Transcript } from '../components/Transcript.js';
import { DetailPane } from '../components/DetailPane.js';
import { SourcePane } from '../components/SourcePane.js';
import { MockApi, type MockRoute } from './mockApi.js';
import { ContractOnly } from './ContractOnly.js';
import { storyChat, storyMembers, storyMessage, storyMemorySource, storyUndoPreview } from './fixtures.js';

const meta: Meta<typeof HistoryNav> = {
  title: 'Nav',
  component: HistoryNav,
  parameters: {
    docs: {
      description: {
        component: 'History navigation uses the production sidebar rows: full-bleed, selected row with the highlight bar.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof HistoryNav>;

const ownChats = [
  storyChat('chat-1', 'Thai Shop offer'),
  storyChat('chat-2', 'Bakery visit'),
  storyChat('chat-3', 'Friday pitches'),
];
const teamChats = [storyChat('chat-9', 'Hunor Monday route', 'user-avi')];

const navBase = {
  workspaceName: 'Kerning',
  workspaces: [{ id: 'ws-1', name: 'Kerning' }],
  workspaceId: 'ws-1',
  members: storyMembers,
  activeChatId: 'chat-1',
  onSelectChat: () => {},
  onNewChat: () => {},
  onSwitchWorkspace: () => {},
  onOpenSettings: () => {},
};

export const Sidebar: Story = {
  name: 'nav/sidebar',
  args: { ...navBase, variant: 'sidebar', ownChats, teamChats },
};

export const Drawer: Story = {
  name: 'nav/drawer',
  args: { ...navBase, variant: 'drawer', open: true, ownChats, teamChats, onClose: () => {} },
  parameters: {
    docs: {
      description: {
        story: 'History drawer open on the Vaul primitive: one positioned surface, contained history scroll, backdrop scrim shared with the dialog layer.',
      },
    },
  },
};

export const LongTitle: Story = {
  name: 'nav/long-title',
  args: {
    ...navBase,
    variant: 'sidebar',
    ownChats: [storyChat('chat-long', 'Restaurantul 2 de pe strada principală cu oferta de vineri și mostrele tipărite pentru luni dimineață')],
    teamChats: [],
  },
  parameters: { docs: { description: { story: 'Long titles truncate on one row; the full title stays on hover.' } } },
};

export const ReadOnly: Story = {
  name: 'nav/read-only',
  render: () => (
    <div>
      <Transcript
        messages={[
          storyMessage({ content_text: 'Hunor logged six pitches before lunch.', author_user_id: 'user-avi', run_id: null }),
        ]}
        members={storyMembers}
        currentUserId="user-hunor"
        steps={[]}
        onInspectAction={() => {}}
      />
      <div className="otis-readonly text-sm">
        <p>This is Avi’s conversation.</p>
      </div>
    </div>
  ),
  parameters: { docs: { description: { story: 'A teammate transcript is attributed and read-only with the production banner class.' } } },
};

const detailRoutes: MockRoute[] = [
  {
    match: url => url.includes('/actions/action-7') && !url.includes('undo'),
    body: {
      action: {
        action_id: 'action-7',
        workspace_id: 'ws-storybook',
        command_name: 'set_fields',
        result_status: 'applied',
        summary: 'Thai Shop is warm.',
        committed_revision: 41,
        actor_kind: 'member',
        actor_user_id: 'user-avi',
        source_message_id: 'msg-101',
        run_id: 'run-story-1',
        step_id: 'step-0',
        created_at: new Date().toISOString(),
        events: [],
        undo: { available: true, reverted_event_ids: [], reverted_by_event_ids: [] },
        source: { id: 'msg-101', channel: 'web', created_at: new Date().toISOString(), text_preview: 'Mark Thai Shop warm' },
      },
    },
  },
  { match: url => url.includes('/actions/action-7/undo-preview'), body: { preview: storyUndoPreview('from_here', false) } },
  { match: url => url.includes('/memory/memory-1/source'), body: storyMemorySource() },
];

export const DetailSource: Story = {
  name: 'detail/source',
  render: () => (
    <MockApi routes={detailRoutes}>
      <SourcePane workspaceId="ws-storybook" memoryId="memory-1" onClose={() => {}} onAccessLost={() => {}} onOpenChat={() => {}} />
    </MockApi>
  ),
};

export const DetailAction: Story = {
  name: 'detail/action',
  render: () => (
    <MockApi routes={detailRoutes}>
      <DetailPane workspaceId="ws-storybook" chatId="chat-storybook" actionId="action-7" onClose={() => {}} onUndone={() => {}} />
    </MockApi>
  ),
};

export const EntityTimeline: Story = {
  name: 'detail/entity-timeline',
  render: () => (
    <ContractOnly
      fixtureId="detail/entity-timeline"
      expects="Read-only sourced entity timeline inside the existing detail surface: original reports, corrections, author and time, pending and disputed facts. No lead editor."
      owner="008C with its bounded scoped read contract"
    />
  ),
};

const longContentRoutes: MockRoute[] = [
  {
    match: url => url.includes('/actions/action-long') && !url.includes('undo'),
    body: {
      action: {
        action_id: 'action-long',
        workspace_id: 'ws-storybook',
        command_name: 'set_fields',
        result_status: 'applied',
        summary: 'Thai Shop is warm with the offer due Friday morning before the market visit, plus six follow-ups across the street.',
        committed_revision: 41,
        actor_kind: 'member',
        actor_user_id: 'user-avi',
        source_message_id: 'msg-101',
        run_id: 'run-story-1',
        step_id: 'step-0',
        created_at: new Date().toISOString(),
        events: [],
        undo: { available: true, reverted_event_ids: [], reverted_by_event_ids: [] },
        source: { id: 'msg-101', channel: 'web', created_at: new Date().toISOString(), text_preview: 'A very long field note about Thai Shop, the bakery, the bistro, and Friday.' },
      },
    },
  },
  {
    match: url => url.includes('/actions/action-long/undo-preview'),
    body: {
      preview: {
        target_action_id: 'action-long',
        mode: 'from_here',
        selected_action_ids: ['action-long', 'action-8', 'action-9'],
        affected_event_ids: ['event-70'],
        affected_entities: [
          { id: 'entity-1', name: 'Thai Shop', changes: ['status: new to warm'] },
          { id: 'entity-2', name: 'Restaurantul 2 de pe strada principala', changes: ['offer due: Friday'] },
          { id: 'entity-3', name: 'Bakery', changes: ['visit logged'] },
        ],
        affected_tasks: [
          { id: 'task-2', title: 'Send Thai Shop the offer before the Friday market visit', changes: ['due: Friday'] },
          { id: 'task-3', title: 'Bring printed samples on Monday morning', changes: ['due: Monday'] },
        ],
        dependencies: [],
        expected_revision: 42,
      },
    },
  },
];

export const ActionLongContent: Story = {
  name: 'detail/action-long-content',
  render: () => (
    <MockApi routes={longContentRoutes}>
      <DetailPane workspaceId="ws-storybook" chatId="chat-storybook" actionId="action-long" onClose={() => {}} onUndone={() => {}} />
    </MockApi>
  ),
  parameters: {
    docs: {
      description: {
        story: 'Extra 008A coverage per the 2026-10-04 approval: long dialog content scrolls inside the 600 px dialog with the close action reachable.',
      },
    },
  },
};
