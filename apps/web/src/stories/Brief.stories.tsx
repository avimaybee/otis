import type { Meta, StoryObj } from '@storybook/react-vite';
import { ContractOnly } from './ContractOnly.js';

const meta: Meta<typeof ContractOnly> = {
  title: 'Brief',
  component: ContractOnly,
};

export default meta;
type Story = StoryObj<typeof ContractOnly>;

const brief = (fixtureId: string, expects: string): Story => ({
  name: fixtureId,
  args: { fixtureId, expects, owner: '011 with its schedule and selection contract' },
});

export const Disabled: Story = brief(
  'brief/disabled',
  'Schedules start disabled with no default hour. The member chooses time, days, timezone and channel.',
);
export const Configured: Story = brief(
  'brief/configured',
  'Chosen schedule shown truthfully: local time, weekdays, timezone and delivery channel.',
);
export const Empty: Story = brief(
  'brief/empty',
  'Nothing due means an honest empty state when opened, never a sent notification.',
);
export const DeliveryUnknown: Story = brief(
  'brief/delivery-unknown',
  'Unknown delivery stays uncertain with deliberate retry wording, never a blind repeat claim.',
);
