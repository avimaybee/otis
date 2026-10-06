import type { Meta, StoryObj } from '@storybook/react-vite';
import { SettingsPane } from '../components/SettingsPane.js';
import { MockApi, type MockRoute } from './mockApi.js';
import { storyModels } from './fixtures.js';

function settingsRoutes(models: typeof storyModels, credentials: 'ok' | 'failing'): MockRoute[] {
  return [
    { match: url => url.endsWith('/settings') && !url.includes('/me/'), body: { settings: { workspace_id: 'ws-1', default_model: 'mimo-25' } } },
    {
      match: url => url.endsWith('/me/settings'),
      body: { settings: { workspace_id: 'ws-1', user_id: 'user-avi', preferred_language: 'ro', brief_enabled: false, brief_local_time: null, brief_timezone: 'Europe/Bucharest', brief_weekdays: null } },
    },
    { match: url => url.includes('/models'), body: { models, current_command_key: 'mimo-25', default_command_key: 'mimo-25' } },
    { match: url => url.includes('/telegram/connection'), body: { status: 'ok', available: true, state: 'disconnected', routing_workspace: null, connections: [] } },
    {
      match: url => url.includes('/credentials/'),
      status: credentials === 'ok' ? 200 : 404,
      body: credentials === 'ok'
        ? { credential: { provider: 'gemini', status: 'available', last_verified_at: new Date().toISOString() } }
        : { error: { code: 'not_found', message: 'No credential.' } },
    },
  ];
}

const meta: Meta<typeof SettingsPane> = {
  title: 'Settings',
  component: SettingsPane,
  parameters: {
    docs: {
      description: {
        component: 'Scoped configuration uses the production settings pane with stubbed reads. Personal versus shared scope stays explicit.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SettingsPane>;

const props = {
  workspaceId: 'ws-1',
  workspaceName: 'Kerning',
  members: { 'user-avi': 'Avi', 'user-hunor': 'Hunor' },
  onClose: () => {},
  onSignOut: () => {},
};

export const Personal: Story = {
  name: 'settings/personal',
  render: args => (
    <MockApi routes={settingsRoutes(storyModels, 'ok')}>
      <SettingsPane {...args} />
    </MockApi>
  ),
  args: { ...props },
};

export const Workspace: Story = {
  name: 'settings/workspace',
  render: args => (
    <MockApi routes={settingsRoutes(storyModels, 'ok')}>
      <SettingsPane {...args} />
    </MockApi>
  ),
  args: { ...props },
  play: async ({ canvasElement }) => {
    const tab = canvasElement.querySelector('[role="tablist"] button:nth-child(2)') as HTMLButtonElement | null;
    tab?.click();
  },
  parameters: { docs: { description: { story: 'Workspace tab opens via interaction; the shared default and masked connections stay truthful.' } } },
};

export const Connection: Story = {
  name: 'settings/connection',
  render: args => (
    <MockApi routes={settingsRoutes(storyModels, 'failing')}>
      <SettingsPane {...args} />
    </MockApi>
  ),
  args: { ...props },
  play: async ({ canvasElement }) => {
    const tab = canvasElement.querySelector('[role="tablist"] button:nth-child(2)') as HTMLButtonElement | null;
    tab?.click();
  },
  parameters: { docs: { description: { story: 'Connections are masked and write-only; a missing key reads as not connected.' } } },
};

const unavailableModels = storyModels.map(model => ({ ...model, available: false, is_current: false }));

export const ModelUnavailable: Story = {
  name: 'settings/model-unavailable',
  render: args => (
    <MockApi
      routes={[
        { match: url => url.endsWith('/settings') && !url.includes('/me/'), body: { settings: { workspace_id: 'ws-1', default_model: null } } },
        {
          match: url => url.endsWith('/me/settings'),
          body: { settings: { workspace_id: 'ws-1', user_id: 'user-avi', preferred_language: 'ro', brief_enabled: false, brief_local_time: null, brief_timezone: null, brief_weekdays: null } },
        },
        { match: url => url.includes('/models'), body: { models: unavailableModels, current_command_key: null, default_command_key: null, unavailable_reason: 'No configured provider key is available in this workspace yet.' } },
        { match: url => url.includes('/credentials/'), status: 404, body: { error: { code: 'not_found', message: 'No credential.' } } },
      ]}
    >
      <SettingsPane {...args} />
    </MockApi>
  ),
  args: { ...props },
  parameters: { docs: { description: { story: 'No usable model is reported plainly with readable names, never a raw key or silent substitution.' } } },
};

export const ModelCatalogFailing: Story = {
  name: 'settings/model-catalog-failing',
  render: args => (
    <MockApi
      routes={[
        { match: url => url.endsWith('/settings') && !url.includes('/me/'), body: { settings: { workspace_id: 'ws-1', default_model: null } } },
        {
          match: url => url.endsWith('/me/settings'),
          body: { settings: { workspace_id: 'ws-1', user_id: 'user-avi', preferred_language: 'ro', brief_enabled: false, brief_local_time: null, brief_timezone: null, brief_weekdays: null } },
        },
        { match: url => url.includes('/models'), status: 500, body: { error: { code: 'internal_error', message: 'Catalog unavailable.' } } },
      ]}
    >
      <SettingsPane {...args} />
    </MockApi>
  ),
  args: { ...props },
  play: async ({ canvasElement }) => {
    const tabs = canvasElement.querySelectorAll('[role="tab"]');
    const workspaceTab = [...tabs].find(tab => tab.textContent !== 'You') as HTMLButtonElement | null;
    workspaceTab?.click();
  },
  parameters: {
    docs: {
      description: {
        story: 'A dead model catalog fails only its own section with a retry; personal and workspace settings still load and save.',
      },
    },
  },
};
