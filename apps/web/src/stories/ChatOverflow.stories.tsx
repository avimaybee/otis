import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChatOverflow } from '../components/ChatOverflow.js';

const meta: Meta<typeof ChatOverflow> = {
  title: 'ChatOverflow',
  component: ChatOverflow,
  parameters: {
    docs: {
      description: {
        component: 'Conversation actions while a run is active. A rejected Stop stays visible and retryable in the menu instead of an unhandled rejection.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ChatOverflow>;

export const StopRejected: Story = {
  name: 'chatoverflow/stop-rejected',
  args: {
    running: true,
    onStop: async () => {
      throw new Error('Network failed.');
    },
  },
  play: async ({ canvasElement }) => {
    const trigger = canvasElement.querySelector('button[aria-label="Chat options"]') as HTMLButtonElement | null;
    trigger?.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const stop = [...canvasElement.querySelectorAll('[role="menuitem"]')].find(item =>
      item.textContent?.includes('Stop Otis'),
    ) as HTMLElement | null;
    // Radix renders the menu in a portal; fall back to the document body.
    const inPortal = [...document.body.querySelectorAll('[role="menuitem"]')].find(item =>
      item.textContent?.includes('Stop Otis'),
    ) as HTMLElement | null;
    (inPortal ?? stop)?.click();
  },
  parameters: {
    docs: {
      description: {
        story: 'A failed Stop keeps its reason in the menu with the action still available; the run keeps its own state below.',
      },
    },
  },
};
