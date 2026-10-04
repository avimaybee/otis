import type { Meta, StoryObj } from '@storybook/react-vite';
import { DetailPane } from '../components/DetailPane.js';
import { MockApi, type MockRoute } from './mockApi.js';
import { storyUndoPreview } from './fixtures.js';

function actionRoutes(previewMode: 'from_here' | 'single', withDependency: boolean, teammateNote: boolean): MockRoute[] {
  return [
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
          events: [
            { id: 'event-70', kind: 'status_change', sequence: 70, occurred_at: new Date().toISOString(), entity_id: 'entity-1', payload: {}, reverted: false },
          ],
          undo: { available: true, reverted_event_ids: [], reverted_by_event_ids: [] },
          source: { id: 'msg-101', channel: 'web', created_at: new Date().toISOString(), text_preview: 'Mark Thai Shop warm' },
        },
      },
    },
    {
      match: url => url.includes('/actions/action-7/undo-preview'),
      body: {
        preview: teammateNote
          ? { ...storyUndoPreview(previewMode, withDependency), affected_entities: [{ id: 'entity-1', name: 'Thai Shop', changes: ['status: new to warm (Hunor’s later visit note is preserved)'] }] }
          : storyUndoPreview(previewMode, withDependency),
      },
    },
  ];
}

const meta: Meta<typeof DetailPane> = {
  title: 'Undo',
  component: DetailPane,
  parameters: {
    docs: {
      description: {
        component: 'Undo previews the exact grouped effect with the production detail pane. Synthetic receipts only.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof DetailPane>;

const props = {
  workspaceId: 'ws-storybook',
  chatId: 'chat-storybook',
  actionId: 'action-7',
  onClose: () => {},
  onUndone: () => {},
};

export const Single: Story = {
  name: 'undo/single',
  render: args => (
    <MockApi routes={actionRoutes('single', false, false)}>
      <DetailPane {...args} />
    </MockApi>
  ),
  args: { ...props },
};

export const FromHere: Story = {
  name: 'undo/from-here',
  render: args => (
    <MockApi routes={actionRoutes('from_here', false, false)}>
      <DetailPane {...args} />
    </MockApi>
  ),
  args: { ...props },
  parameters: { docs: { description: { story: 'Default scope reverses the selected write plus later same-run changes.' } } },
};

export const Dependency: Story = {
  name: 'undo/dependency',
  render: args => (
    <MockApi routes={actionRoutes('from_here', true, false)}>
      <DetailPane {...args} />
    </MockApi>
  ),
  args: { ...props },
  parameters: { docs: { description: { story: 'Later dependent work blocks the commit with a narrow question instead of a silent broad rollback.' } } },
};

export const TeammatePreserved: Story = {
  name: 'undo/teammate-preserved',
  render: args => (
    <MockApi routes={actionRoutes('from_here', false, true)}>
      <DetailPane {...args} />
    </MockApi>
  ),
  args: { ...props },
  parameters: { docs: { description: { story: 'Unrelated teammate work survives the grouped preview.' } } },
};

export const MobileScopeSheet: Story = {
  name: 'undo/mobile-scope-sheet',
  render: args => (
    <MockApi routes={actionRoutes('from_here', false, false)}>
      <DetailPane {...args} />
    </MockApi>
  ),
  args: { ...props },
  parameters: {
    docs: {
      description: {
        story: 'Sheet composition at phone widths: exact preview, primary suffix undo (Undo from here) with secondary single-action choice (Only this action). Same production pane; viewport supplies the sheet.',
      },
    },
  },
};
