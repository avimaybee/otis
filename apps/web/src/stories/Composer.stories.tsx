import type { Meta, StoryObj } from '@storybook/react-vite';
import { Composer } from '../components/Composer.js';
import type { ImageAttachment } from '../components/Composer.js';
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
  title: 'Composer',
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
        component: 'One production composer: a single textarea plus the Send/Stop slot. No toolbar, no model chips.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Composer>;

export const Empty: Story = {
  name: 'composer/empty',
  args: { ...base },
};

export const Short: Story = {
  name: 'composer/short',
  args: { ...base, draftValue: 'Thai Shop wants the offer by Friday.' },
};

export const Multiline: Story = {
  name: 'composer/multiline',
  args: {
    ...base,
    draftValue: 'Visited three places today.\nThai Shop is warm.\nBakery wants the offer Friday.',
  },
};

export const MaxLines: Story = {
  name: 'composer/max-lines',
  args: {
    ...base,
    draftValue: Array.from({ length: 8 }, (_, index) => `Line ${index + 1} of a long field note.`).join('\n'),
  },
  parameters: { docs: { description: { story: 'The field grows to six lines, then scrolls internally.' } } },
};

export const Ime: Story = {
  name: 'composer/ime',
  args: { ...base, draftValue: 'Școala din Târgu Mureș' },
  parameters: { docs: { description: { story: 'IME composition never submits mid-composition; Enter behavior is verified on devices in 008C.' } } },
};

export const FollowUp: Story = {
  name: 'composer/follow-up',
  args: {
    ...base,
    running: true,
    draftValue: 'actually make it Friday morning',
    onStop: async () => {},
    replyTo: {
      question: 'Which Friday should I use?',
      onCancel: () => {},
    },
  },
  parameters: {
    docs: {
      description: {
        story: 'A valid follow-up draft shows Send in the shared slot while Stop stays reachable through chat overflow.',
      },
    },
  },
};

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function storyPhoto(id: string, status: ImageAttachment['status']): ImageAttachment {
  return {
    id,
    file: new File([], `${id}.png`, { type: 'image/png' }),
    previewUrl: TINY_PNG_DATA_URL,
    status,
  };
}

export const WithPhotos: Story = {
  name: 'composer/with-photos',
  args: {
    ...base,
    draftValue: 'What is in these photos?',
    images: {
      available: true,
      workspaceId: 'ws-1',
      chatId: 'chat-1',
      onEnsureChat: async () => 'chat-1',
      upload: async () => ({ mediaId: 'med_story_1', format: 'image/png' as const }),
      controller: {
        attachments: [storyPhoto('photo-ready-1', 'ready'), storyPhoto('photo-uploading-2', 'uploading')],
        addFiles: () => {},
        remove: () => {},
        clear: () => {},
      },
    },
  },
  parameters: {
    docs: {
      description: {
        story: 'Local previews render instantly with per-photo upload state; remove is per photo and the draft is untouched.',
      },
    },
  },
};
