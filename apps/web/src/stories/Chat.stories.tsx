import type { Meta, StoryObj } from '@storybook/react-vite';
import { Transcript } from '../components/Transcript.js';
import { storyMembers, storyMessage } from './fixtures.js';

const base = {
  members: storyMembers,
  currentUserId: 'user-hunor',
  steps: [],
  onInspectAction: () => {},
};

const meta: Meta<typeof Transcript> = {
  title: 'Chat',
  component: Transcript,
  parameters: {
    docs: {
      description: {
        component: 'Ordinary conversation renders with the production Transcript. Synthetic exchanges only.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Transcript>;

const shortExchange = [
  storyMessage({ content_text: 'Thai Shop wants the offer by Friday.', run_id: 'run-story-1' }),
  storyMessage({
    content_text: 'Saved. Thai Shop is warm, offer due Friday. Want me to draft it?',
    author_kind: 'system',
    author_user_id: null,
    run_id: 'run-story-1',
  }),
];

export const Empty: Story = {
  name: 'chat/empty',
  args: { ...base, messages: [] },
};

export const Short: Story = {
  name: 'chat/short',
  args: { ...base, messages: shortExchange },
};

export const LongRo: Story = {
  name: 'chat/long-ro',
  args: {
    ...base,
    messages: [
      storyMessage({
        content_text: 'Am fost la Restaurantul 2 azi dimineață. Șeful de sală a spus că vor oferta până vineri și l-a rugat pe Hunor să revină luni cu mostrele tipărite.',
        run_id: 'run-story-1',
      }),
      storyMessage({
        content_text: 'Am salvat vizita la Restaurantul 2 cu scadența de vineri și am notat cererea pentru mostre. Ți le reamintesc luni dimineață?',
        author_kind: 'system',
        author_user_id: null,
        run_id: 'run-story-1',
      }),
    ],
  },
};

export const LongHu: Story = {
  name: 'chat/long-hu',
  args: {
    ...base,
    messages: [
      storyMessage({
        content_text: 'Ma délelőtt a Pékségben voltam. A tulajdonos csak magyarul beszél, és kérte, hogy az árajánlatot péntekig küldjük el, mert jövő héten leltároznak.',
        run_id: 'run-story-1',
      }),
      storyMessage({
        content_text: 'Mentve. A Pékség árajánlata pénteken esedékes, a jövő heti leltár miatt. Szeretnéd, hogy megírjam a piszkozatot?',
        author_kind: 'system',
        author_user_id: null,
        run_id: 'run-story-1',
      }),
    ],
  },
};

export const LongUrl: Story = {
  name: 'chat/long-url',
  args: {
    ...base,
    messages: [
      storyMessage({
        content_text: 'Brutaria cere oferta aici: https://sheets.example.com/documente/oferte/2026/brutaria-2-revizie-finala-pentru-tipar',
        run_id: 'run-story-1',
      }),
      storyMessage({
        content_text: 'Am notat linkul la Brutaria. Îl păstrez ca sursă, nu ca instrucțiune.',
        author_kind: 'system',
        author_user_id: null,
        run_id: 'run-story-1',
      }),
    ],
  },
};
