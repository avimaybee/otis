import type { Meta, StoryObj } from '@storybook/react-vite';
import { RecordsScreen } from '../components/records/RecordsScreen.js';
import { INITIAL_RECORD_LISTS } from '../components/records/seedData.js';

const mockWorkspaces = [
  { id: 'ws-default', name: 'Acme Carpentry', role: 'owner' },
  { id: 'ws-secondary', name: 'Acme Developments', role: 'member' },
];

const mockMembers = {
  'user-hunor': 'Hunor',
  'user-elena': 'Elena',
};

const meta: Meta<typeof RecordsScreen> = {
  title: 'Records/Screen',
  component: RecordsScreen,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Your information (R16): dedicated conversational business memory view with desktop spreadsheet grid, mobile card list, custom sparse fields, live calculations, recoverable draft overlay, and Ask Otis contextual tidying.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof RecordsScreen>;

export const LeadsTable: Story = {
  name: 'records-leads-table',
  args: {
    workspaceId: 'ws-default',
    listId: 'leads',
    workspaces: mockWorkspaces,
    userId: 'user-hunor',
    members: mockMembers,
    onSignOut: () => {},
    onNavigate: () => {},
    onNavigateToList: () => {},
    initialLists: INITIAL_RECORD_LISTS,
  },
};

export const ProductsCalculations: Story = {
  name: 'records-products-calculations',
  args: {
    workspaceId: 'ws-default',
    listId: 'products',
    workspaces: mockWorkspaces,
    userId: 'user-hunor',
    members: mockMembers,
    onSignOut: () => {},
    onNavigate: () => {},
    onNavigateToList: () => {},
    initialLists: INITIAL_RECORD_LISTS,
  },
};

export const TasksList: Story = {
  name: 'records-tasks-list',
  args: {
    workspaceId: 'ws-default',
    listId: 'tasks',
    workspaces: mockWorkspaces,
    userId: 'user-hunor',
    members: mockMembers,
    onSignOut: () => {},
    onNavigate: () => {},
    onNavigateToList: () => {},
    initialLists: INITIAL_RECORD_LISTS,
  },
};
