import type { Meta, StoryObj } from '@storybook/react-vite';
import { Composer } from '../components/Composer.js';
import { storyCommands, storyModels } from './fixtures.js';

const base = {
  running: false,
  commands: storyCommands,
  models: storyModels,
  workspaces: [{ id: 'ws-1', name: 'Kerning' }],
  onSend: async () => true,
  onCommand: async () => true,
};

const meta: Meta<typeof Composer> = {
  title: 'Command',
  component: Composer,
  decorators: [
    Story => (
      <div className="sb-composer-dock">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component: 'Slash shortcuts apply real scoped operations without chat bubbles. The picker filters the server registry.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Composer>;

export const Root: Story = {
  name: 'command/root',
  args: { ...base, draftValue: '/' },
};

export const Filter: Story = {
  name: 'command/filter',
  args: { ...base, draftValue: '/tod' },
};

export const Model: Story = {
  name: 'command/model',
  args: { ...base, draftValue: '/model ' },
  parameters: { docs: { description: { story: 'Only verified available models are selectable; the rest read as not configured.' } } },
};

export const Thinking: Story = {
  name: 'command/thinking',
  args: { ...base, draftValue: '/thinking ' },
};

export const Pending: Story = {
  name: 'command/pending',
  args: { ...base, draftValue: '/model ', controlPending: true },
  parameters: { docs: { description: { story: 'A pending control mutation stays local inside the composer bounds.' } } },
};

export const Failed: Story = {
  name: 'command/failed',
  args: { ...base, draftValue: '/model no-such-key', onCommand: async () => false },
  parameters: { docs: { description: { story: 'A failed save keeps the previous effective value plus a local error after submit. Static render shows the draft.' } } },
};

export const LiteralSlash: Story = {
  name: 'command/literal-slash',
  args: { ...base, draftValue: '// hello' },
  parameters: {
    docs: {
      description: {
        story: 'A // draft is literal text: the picker stays closed and submit sends it as an ordinary message, never a command.',
      },
    },
  },
};

const longModels = [
  ...storyModels,
  {
    command_key: 'gemini-warehouse-triage-extended-context',
    display_name: 'Gemini Warehouse Triage Extended Context Preview With A Very Long Display Name',
    provider: 'gemini',
    native_audio_supported: false,
    voice_available: false,
    available: true,
    is_current: false,
    is_default: false,
  },
  {
    command_key: 'mimo-field-notes-multilingual-beta',
    display_name: 'MiMo Field Notes Multilingual Beta For Romanian And Hungarian Street Capture',
    provider: 'opencode_go',
    native_audio_supported: false,
    voice_available: true,
    available: true,
    is_current: false,
    is_default: false,
  },
];

export const ModelLongNames: Story = {
  name: 'command/model-long-names',
  args: { ...base, models: longModels, draftValue: '/model ' },
  parameters: {
    docs: {
      description: {
        story: 'Extra 008A coverage per the 2026-10-04 approval: long model names wrap in full inside the 360 px picker instead of hiding behind aliases.',
      },
    },
  },
};
