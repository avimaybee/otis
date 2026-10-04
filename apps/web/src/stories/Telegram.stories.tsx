import type { Meta, StoryObj } from '@storybook/react-vite';
import { TelegramConnection } from '../components/TelegramConnection.js';
import { MockApi, type MockRoute } from './mockApi.js';

/**
 * 009A guided Telegram linking states, rendered from the production
 * component with synthetic server payloads only (no real bot, token, link
 * or network). Connect -> Open Telegram -> tap Start -> Connected.
 */
const meta: Meta<typeof TelegramConnection> = {
  title: 'Telegram',
  component: TelegramConnection,
  parameters: {
    docs: {
      description: {
        component: 'Extreme-ease Telegram linking: no codes or identifiers for members; only the server binding proves Connected.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof TelegramConnection>;

function panel() {
  return (
    <div className="otis-settings">
      <TelegramConnection workspaceId="ws-1" workspaceName="Kerning" />
    </div>
  );
}

const disconnected = { status: 'ok', available: true, state: 'disconnected', routing_workspace: null, connections: [] };
const disconnectedRoute: MockRoute = { match: (url) => url.includes('/telegram/connection'), body: disconnected };
const linkRoute = (expiresAt: string): MockRoute => ({
  match: (url, method) => url.includes('/telegram/link') && method === 'POST',
  body: { status: 'ok', deep_link: 'https://t.me/otis_story_bot?start=synthetic', expires_at: expiresAt },
});
const future = () => new Date(Date.now() + 10 * 60_000).toISOString();

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
function clickByText(root: HTMLElement, text: string): void {
  const button = Array.from(root.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`story button '${text}' not found`);
  button.click();
}

export const Disconnected: Story = {
  name: 'telegram/disconnected',
  render: () => <MockApi routes={[disconnectedRoute]}>{panel()}</MockApi>,
};

export const Unavailable: Story = {
  name: 'telegram/unavailable',
  render: () => (
    <MockApi routes={[{ match: (url) => url.includes('/telegram/connection'), body: { ...disconnected, available: false } }]}>
      {panel()}
    </MockApi>
  ),
};

export const Preparing: Story = {
  name: 'telegram/preparing',
  render: () => (
    <MockApi routes={[disconnectedRoute, { match: (url, method) => url.includes('/telegram/link') && method === 'POST', hang: true }]}>
      {panel()}
    </MockApi>
  ),
  play: async ({ canvasElement }) => {
    clickByText(canvasElement, 'Connect Telegram');
    await flush();
  },
  parameters: { docs: { description: { story: 'Only the button changes while the issuer request is in flight; nothing else moves.' } } },
};

export const Ready: Story = {
  name: 'telegram/ready',
  render: () => <MockApi routes={[disconnectedRoute, linkRoute(future())]}>{panel()}</MockApi>,
  play: async ({ canvasElement }) => {
    clickByText(canvasElement, 'Connect Telegram');
    await flush();
  },
  parameters: { docs: { description: { story: 'A validated deep link with the ten-minute note and a read-only Start check.' } } },
};

export const Waiting: Story = {
  name: 'telegram/waiting',
  render: () => <MockApi routes={[disconnectedRoute, linkRoute(future())]}>{panel()}</MockApi>,
  play: async ({ canvasElement }) => {
    clickByText(canvasElement, 'Connect Telegram');
    await flush();
    clickByText(canvasElement, 'I\u2019ve tapped Start');
    await flush();
  },
  parameters: { docs: { description: { story: 'Checking before Start never blames the person or claims connection.' } } },
};

export const Connected: Story = {
  name: 'telegram/connected',
  render: () => (
    <MockApi
      routes={[
        {
          match: (url) => url.includes('/telegram/connection'),
          body: {
            status: 'ok',
            available: true,
            state: 'connected',
            routing_workspace: { id: 'ws-1', name: 'Kerning' },
            connections: [{ routing_workspace: { id: 'ws-1', name: 'Kerning' } }],
          },
        },
      ]}
    >
      {panel()}
    </MockApi>
  ),
};

export const RoutingNeeded: Story = {
  name: 'telegram/routing-needed',
  render: () => (
    <MockApi
      routes={[
        {
          match: (url) => url.includes('/telegram/connection'),
          body: { status: 'ok', available: true, state: 'routing_needed', routing_workspace: null, connections: [{ routing_workspace: null }] },
        },
      ]}
    >
      {panel()}
    </MockApi>
  ),
  parameters: { docs: { description: { story: 'A linked identity without a valid workspace stays visible as linked, never hidden as disconnected.' } } },
};

export const CheckFailed: Story = {
  name: 'telegram/check-failed',
  render: () => (
    <MockApi
      routes={[
        { match: (url, method) => url.includes('/telegram/connection') && method === 'GET', status: 500, body: { error: { code: 'internal_error', message: 'Synthetic failure.' } } },
        linkRoute(future()),
      ]}
    >
      {panel()}
    </MockApi>
  ),
  play: async () => {
    // The initial read fails, so the row starts as a load failure with Retry.
    await flush();
  },
  parameters: { docs: { description: { story: 'A failed first read explains itself without inventing a connection state; retry stays available.' } } },
};

export const Expired: Story = {
  name: 'telegram/expired',
  render: () => <MockApi routes={[disconnectedRoute, linkRoute(new Date(Date.now() - 60_000).toISOString())]}>{panel()}</MockApi>,
  play: async ({ canvasElement }) => {
    clickByText(canvasElement, 'Connect Telegram');
    await flush();
    clickByText(canvasElement, 'I\u2019ve tapped Start');
    await flush();
  },
  parameters: { docs: { description: { story: 'An expired link asks for a new link; no manual token repair exists.' } } },
};

export const Disconnect: Story = {
  name: 'telegram/disconnect',
  render: () => (
    <MockApi
      routes={[
        {
          match: (url, method) => url.includes('/telegram/connection') && method === 'GET',
          body: {
            status: 'ok',
            available: true,
            state: 'connected',
            routing_workspace: { id: 'ws-1', name: 'Kerning' },
            connections: [{ routing_workspace: { id: 'ws-1', name: 'Kerning' } }],
          },
        },
        {
          match: (url, method) => url.includes('/telegram/connection') && method === 'DELETE',
          body: { status: 'ok', state: 'disconnected' },
        },
      ]}
    >
      {panel()}
    </MockApi>
  ),
  play: async ({ canvasElement }) => {
    await flush();
    clickByText(canvasElement, 'Disconnect');
    await flush();
  },
  parameters: { docs: { description: { story: 'In-place Disconnecting… then the honest disconnected notice; reconnect stays one tap away.' } } },
};
