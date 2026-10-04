import type { Meta, StoryObj } from '@storybook/react-vite';
import { App } from '../App.js';
import { MockApi, type MockRoute } from './mockApi.js';

const meRoutes = (body: unknown, status = 200): MockRoute[] => [
  { match: url => url === '/api/me', status, body },
];

const meta: Meta<typeof App> = {
  title: 'Entry',
  component: App,
  parameters: {
    docs: {
      description: {
        component: 'Entry states use the production App with stubbed session checks. Synthetic sessions only.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof App>;

const USER = { id: 'user-avi', display_name: 'Avi' };

export const SignIn: Story = {
  name: 'entry/sign-in',
  render: () => (
    <MockApi routes={meRoutes({ error: { code: 'unauthorized', message: 'Sign in.' } }, 401)}>
      <App />
    </MockApi>
  ),
};

export const Pending: Story = {
  name: 'entry/pending',
  render: () => (
    <MockApi routes={[{ match: url => url === '/api/me', hang: true }]}>
      <App />
    </MockApi>
  ),
};

export const Failure: Story = {
  name: 'entry/failure',
  render: () => (
    <MockApi routes={[{ match: url => url === '/api/me', networkError: true }]}>
      <App />
    </MockApi>
  ),
};

export const Invite: Story = {
  name: 'entry/invite',
  render: () => (
    <MockApi routes={meRoutes({ user: USER, workspaces: [] })}>
      <App />
    </MockApi>
  ),
};

export const Revoked: Story = {
  name: 'entry/revoked',
  render: () => (
    <MockApi
      routes={[
        { match: url => url === '/api/me', body: { user: USER, workspaces: [{ id: 'ws-1', name: 'Kerning' }] } },
        {
          match: url => url.includes('/chats') || url.startsWith('/api/commands'),
          body: { error: { code: 'not_member', message: 'Access changed.' } },
          status: 401,
        },
        { match: url => url.includes('/models'), body: { models: [] } },
      ]}
    >
      <App />
    </MockApi>
  ),
};
