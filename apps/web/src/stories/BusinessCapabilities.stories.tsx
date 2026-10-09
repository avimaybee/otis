import { useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '../api/queries.js';
import { EntityFilePane } from '../components/EntityFile.js';
import { FollowUps } from '../components/FollowUps.js';
import { WorkspaceHistorySearch } from '../components/WorkspaceHistorySearch.js';
import { FileGallery } from '../components/FileGallery.js';
import { businessFile, fileEntry, followUpPage, historyMatches } from './businessFixtures.js';
import { MockApi, type MockRoute } from './mockApi.js';

const meta: Meta = {
  title: 'Business capabilities',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Production client files, workspace search, private gallery and own follow-ups. All payloads are synthetic. Use the controls to exercise paging, correction, conflicts and retry; this is not live provider/device evidence.',
      },
    },
  },
};
export default meta;
type Story = StoryObj;
const file = businessFile();
const routes: MockRoute[] = [
  {
    match: (url, method) => url.includes('/actions') && method === 'POST',
    body: { status: 'applied', action_id: 'synthetic-action', summary: 'Selected edit saved.' },
  },
  {
    match: (url) => url.includes('/file?'),
    response: (url) => {
      const params = new URL(url, 'http://storybook.local').searchParams,
        section = params.get('section') ?? 'notes';
      const page = file[section as keyof typeof file];
      return Response.json({
        version: 1,
        entity_id: 'client-1',
        as_of_business_revision: 12,
        section,
        page: params.has('interaction_id')
          ? { ...file.notes, items: [fileEntry], total: 1, has_more: false, next_cursor: null }
          : params.has('cursor')
            ? {
                ...file.notes,
                items: Array.from({ length: 30 }, (_, n) => ({
                  ...fileEntry,
                  interaction_id: `note-${n + 2}`,
                  payload: { text: `Additional saved note ${n + 2}.` },
                })),
                has_more: false,
                next_cursor: null,
              }
            : page,
      });
    },
  },
  { match: (url) => url.includes('/file'), body: file },
  {
    match: (url) => url.includes('/sources/'),
    body: {
      id: 'message-original',
      chat_id: 'chat-1',
      author_name: 'Hunor',
      author_user_id: 'user-hunor',
      text: 'The original member wording is retained here.',
      recorded_at: '2026-10-01T08:00:00Z',
      channel: 'web',
      sequence: 1,
      context: [],
    },
  },
  { match: (url) => url.includes('/followups'), body: followUpPage() },
];
function Fixture({ children, overrides = [] }: { children: ReactNode; overrides?: MockRoute[] }) {
  const [client] = useState(createAppQueryClient);
  return (
    <MockApi routes={[...overrides, ...routes]}>
      <QueryClientProvider client={client}>
        <main className="mx-auto w-full max-w-3xl p-4 min-w-0 bg-background text-foreground">
          {children}
        </main>
      </QueryClientProvider>
    </MockApi>
  );
}
const props = {
  workspaceId: 'ws-1',
  userId: 'user-avi',
  entityId: 'client-1',
  initialFile: file,
  onAsk: () => {},
  onOpenChat: () => {},
};
export const CompleteFile: Story = {
  name: 'file/current',
  render: () => (
    <Fixture>
      <EntityFilePane {...props} />
    </Fixture>
  ),
};
export const Corrections: Story = {
  name: 'file/entries',
  render: () => (
    <Fixture>
      <EntityFilePane {...props} initialSection="notes" />
    </Fixture>
  ),
};
export const Contacts: Story = {
  name: 'file/contacts',
  render: () => (
    <Fixture>
      <EntityFilePane {...props} initialSection="contacts" />
    </Fixture>
  ),
};
export const Quotes: Story = {
  name: 'file/quotes',
  render: () => (
    <Fixture>
      <EntityFilePane {...props} initialSection="quotes" />
    </Fixture>
  ),
};
export const OriginalFiles: Story = {
  name: 'file/attachments',
  render: () => (
    <Fixture
      overrides={[
        {
          match: (url) => url.includes('/media/'),
          status: 410,
          body: { error: { message: 'Synthetic expired original.' } },
        },
      ]}
    >
      <EntityFilePane {...props} initialSection="attachments" />
    </Fixture>
  ),
};
export const History: Story = {
  name: 'file/history',
  render: () => (
    <Fixture>
      <EntityFilePane {...props} initialSection="history" />
    </Fixture>
  ),
};
export const Conflict: Story = {
  name: 'file/edit-conflict',
  render: () => (
    <Fixture
      overrides={[
        {
          match: (_url, method) => method === 'POST',
          status: 409,
          body: { error: { code: 'head_changed', message: 'Another member updated this entry.' } },
        },
      ]}
    >
      <EntityFilePane {...props} initialSection="notes" />
    </Fixture>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Edit entry → Save gives a real conflict through the production request handler. Your text remains; Compare saved entry and review the replacement head before trying again.',
      },
    },
  },
};
export const Unavailable: Story = {
  name: 'file/unavailable',
  render: () => (
    <Fixture
      overrides={[
        {
          match: () => true,
          status: 404,
          body: { error: { code: 'not_found', message: 'This client file is unavailable.' } },
        },
      ]}
    >
      <EntityFilePane {...props} initialFile={undefined} />
    </Fixture>
  ),
};
export const Search: Story = {
  name: 'history/search',
  render: () => (
    <Fixture
      overrides={[
        {
          match: (url) => url.includes('/history/search'),
          response: (url) =>
            Response.json(
              url.includes('cursor=')
                ? {
                    ...historyMatches(),
                    items: [
                      {
                        ...historyMatches().items[0]!,
                        message_id: 'message-second',
                        excerpt: 'The second retained sample promise.',
                      },
                    ],
                    has_more: false,
                    next_cursor: null,
                  }
                : historyMatches(),
            ),
        },
      ]}
    >
      <WorkspaceHistorySearch
        workspaceId="ws-1"
        open
        onClose={() => {}}
        onOpenChat={() => {}}
        members={{ 'user-hunor': 'Hunor', 'user-avi': 'Avi' }}
      />
    </Fixture>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Enter copper and Search to view sourced matches, filters and paging. Open original uses the production source sheet.',
      },
    },
  },
};
export const SearchEmpty: Story = {
  name: 'history/no-matches',
  render: () => (
    <Fixture
      overrides={[
        {
          match: (url) => url.includes('/history/search'),
          body: { ...historyMatches(), items: [], total: 0, has_more: false, next_cursor: null },
        },
      ]}
    >
      <WorkspaceHistorySearch workspaceId="ws-1" open onClose={() => {}} onOpenChat={() => {}} />
    </Fixture>
  ),
};
export const SearchFailure: Story = {
  name: 'history/search-failed',
  render: () => (
    <Fixture overrides={[{ match: (url) => url.includes('/history/search'), networkError: true }]}>
      <WorkspaceHistorySearch workspaceId="ws-1" open onClose={() => {}} onOpenChat={() => {}} />
    </Fixture>
  ),
};
export const OwnFollowUps: Story = {
  name: 'followup/active',
  render: () => (
    <Fixture>
      <FollowUps
        workspaceId="ws-1"
        userId="user-avi"
        open
        onClose={() => {}}
        initialPage={followUpPage()}
      />
    </Fixture>
  ),
};
export const PausedFollowUps: Story = {
  name: 'followup/paused',
  render: () => (
    <Fixture>
      <FollowUps
        workspaceId="ws-1"
        userId="user-avi"
        open
        onClose={() => {}}
        initialPage={{
          ...followUpPage(),
          rows: followUpPage().rows.map((row) => ({ ...row, status: 'paused' })),
        }}
      />
    </Fixture>
  ),
};
export const EmptyFollowUps: Story = {
  name: 'followup/empty',
  render: () => (
    <Fixture>
      <FollowUps
        workspaceId="ws-1"
        userId="user-avi"
        open
        onClose={() => {}}
        initialPage={{ ...followUpPage(), rows: [], total: 0 }}
      />
    </Fixture>
  ),
};
export const MissingOriginal: Story = {
  name: 'gallery/unavailable',
  render: () => (
    <Fixture overrides={[{ match: (url) => url.includes('/media/'), status: 410 }]}>
      <FileGallery
        workspaceId="ws-1"
        userId="user-avi"
        selected={0}
        files={[
          {
            media_id: 'synthetic-missing-image',
            format: 'image/png',
            filename: 'Original photo.png',
          },
        ]}
        onSelect={() => {}}
        onClose={() => {}}
      />
    </Fixture>
  ),
};
