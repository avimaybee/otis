/** @vitest-environment happy-dom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { SignInView } from '../src/components/SignInView.js';
import { SettingsPane } from '../src/components/SettingsPane.js';
import { Transcript, formatOutcomeSummary, consolidateWorkingSteps } from '../src/components/Transcript.js';
import { DetailPane } from '../src/components/DetailPane.js';
import { Composer } from '../src/components/Composer.js';
import { ChatOverflow } from '../src/components/ChatOverflow.js';
import { HistoryNav } from '../src/components/HistoryNav.js';
import { ProviderConnection } from '../src/components/ProviderConnection.js';
import { Command, CommandItem, CommandList } from '../src/components/ui/command.js';
import { ErrorBoundary } from '../src/components/ErrorBoundary.js';
import { TestQueryProvider } from './query.js';
import { api } from '../src/api/client.js';
import type { ChatMessage, MemberSettings, RunDetailResponse } from '@otis/contracts';

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  history.replaceState({}, '', '/');
});

async function mount(element: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => {
    root.render(<TestQueryProvider>{element}</TestQueryProvider>);
  });
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    host,
    unmount: async () => {
      await React.act(async () => root.unmount());
      host.remove();
    },
  };
}

async function fillInput(input: HTMLInputElement, value: string) {
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const mockMemberSettings: MemberSettings = {
  workspace_id: 'ws_test',
  user_id: 'user_1',
  preferred_language: 'en',
  brief_timezone: 'Europe/Bucharest',
  brief_enabled: false,
  brief_local_time: null,
  brief_weekdays: null,
  brief_channel: 'web',
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-01T10:00:00Z',
};

const makeMessage = (overrides: Partial<ChatMessage> & { id: string; content_text: string }): ChatMessage => ({
  workspace_id: 'ws_test',
  chat_id: 'chat_1',
  author_user_id: 'user_1',
  author_kind: 'member',
  channel: 'web',
  inbound_message_id: null,
  client_message_id: null,
  media_id: null,
  run_id: null,
  sequence: 1,
  created_at: '2026-10-05T10:00:00.000Z',
  updated_at: '2026-10-05T10:00:00.000Z',
  ...overrides,
});

describe('Frontend Experience Audit & Confidence Verification (FE-01 - FE-16)', () => {
  describe('FE-01: Invitation Flow and Redemption', () => {
    it('SignInView detects invite token in URL and displays invitation callout', async () => {
      history.replaceState({}, '', '/?invite=tok_alpha');
      const view = await mount(<SignInView onSignedIn={vi.fn()} />);

      expect(view.host.textContent).toContain('Workspace invitation');
      expect(view.host.textContent).toContain('Sign in with Google to accept your invitation');

      await view.unmount();
    });

    it('SettingsPane generates shareable invite link with copy action and expiry notice', async () => {
      vi.spyOn(api, 'settings').mockResolvedValue({
        settings: { workspace_id: 'ws_test', default_model: null, created_at: '', updated_at: '' },
      });
      vi.spyOn(api, 'memberSettings').mockResolvedValue({ settings: mockMemberSettings });
      vi.spyOn(api, 'models').mockResolvedValue({ models: [], current_command_key: null, default_command_key: null });
      vi.spyOn(api, 'listMembers').mockResolvedValue({
        members: [{ user_id: 'user_1', role: 'owner', joined_at: '', email: 'user@example.com', display_name: 'User' }],
      });
      vi.spyOn(api, 'createInvite').mockResolvedValue({
        token: 'tok_beta_123',
        expires_at: '2026-10-12T00:00:00Z',
      });

      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeTextMock);

      const view = await mount(
        <SettingsPane
          workspaceId="ws_test"
          workspaceName="Kerning Test"
          currentUserRole="owner"
          onClose={vi.fn()}
          onSignOut={vi.fn()}
        />,
      );

      // Switch to Workspace tab
      const wsTab = Array.from(view.host.querySelectorAll('[role="tab"]')).find((el) =>
        el.textContent === 'Kerning Test',
      ) as HTMLButtonElement;
      expect(wsTab).toBeTruthy();
      await React.act(async () => {
        wsTab.click();
      });

      const inviteInput = view.host.querySelector('input[aria-label="Invite email address"]') as HTMLInputElement;
      expect(inviteInput).toBeTruthy();

      await fillInput(inviteInput, 'teammate@example.com');

      const sendInviteBtn = Array.from(view.host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Create invite link'),
      ) as HTMLButtonElement;
      expect(sendInviteBtn).toBeTruthy();

      await React.act(async () => {
        sendInviteBtn.click();
      });

      expect(api.createInvite).toHaveBeenCalledWith('ws_test', 'teammate@example.com');
      expect(view.host.textContent).toContain('Invite link ready for teammate@example.com');
      expect(view.host.textContent).toContain('Expires');

      await view.unmount();
    });

    it('SettingsPane downloads the workspace export with success and failure states', async () => {
      vi.spyOn(api, 'settings').mockResolvedValue({
        settings: { workspace_id: 'ws_test', default_model: null, created_at: '', updated_at: '' },
      });
      vi.spyOn(api, 'memberSettings').mockResolvedValue({ settings: mockMemberSettings });
      vi.spyOn(api, 'models').mockResolvedValue({ models: [], current_command_key: null, default_command_key: null });
      vi.spyOn(api, 'listMembers').mockResolvedValue({
        members: [{ user_id: 'user_1', role: 'owner', joined_at: '', email: 'user@example.com', display_name: 'User' }],
      });
      const download = vi.spyOn(api, 'downloadWorkspaceExport').mockResolvedValue(
        new Response(JSON.stringify({ version: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const createdUrls: string[] = [];
      vi.spyOn(URL, 'createObjectURL').mockImplementation(((blob: Blob) => {
        expect(blob).toBeInstanceOf(Blob);
        const url = 'blob:mock-export';
        createdUrls.push(url);
        return url;
      }) as typeof URL.createObjectURL);
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

      const view = await mount(
        <SettingsPane
          workspaceId="ws_test"
          workspaceName="Kerning Test"
          currentUserRole="owner"
          onClose={vi.fn()}
          onSignOut={vi.fn()}
        />,
      );
      const wsTab = Array.from(view.host.querySelectorAll('[role="tab"]')).find((el) =>
        el.textContent === 'Kerning Test',
      ) as HTMLButtonElement;
      await React.act(async () => {
        wsTab.click();
      });

      const downloadBtn = Array.from(view.host.querySelectorAll('button')).find((b) =>
        b.textContent === 'Download JSON',
      ) as HTMLButtonElement;
      expect(downloadBtn).toBeTruthy();
      await React.act(async () => {
        downloadBtn.click();
      });
      expect(download).toHaveBeenCalledWith('ws_test', 'json');
      expect(createdUrls).toEqual(['blob:mock-export']);
      expect(view.host.textContent).toContain('Workspace data downloaded');

      const sheetBtn = Array.from(view.host.querySelectorAll('button')).find((b) =>
        b.textContent === 'Download spreadsheet',
      ) as HTMLButtonElement;
      expect(sheetBtn).toBeTruthy();
      await React.act(async () => {
        sheetBtn.click();
      });
      expect(download).toHaveBeenCalledWith('ws_test', 'xlsx');

      download.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Export failed here.' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await React.act(async () => {
        downloadBtn.click();
      });
      expect(view.host.textContent).toContain('Export failed here.');

      await view.unmount();
    });
  });

  describe('FE-02: Brief Schedule Timezone Copy', () => {
    it('displays accurate brief schedule timezone label and explanatory copy', async () => {
      vi.spyOn(api, 'settings').mockResolvedValue({
        settings: { workspace_id: 'ws_test', default_model: null, created_at: '', updated_at: '' },
      });
      vi.spyOn(api, 'memberSettings').mockResolvedValue({ settings: mockMemberSettings });
      vi.spyOn(api, 'models').mockResolvedValue({ models: [], current_command_key: null, default_command_key: null });
      vi.spyOn(api, 'listMembers').mockResolvedValue({
        members: [{ user_id: 'user_1', role: 'owner', joined_at: '', email: 'user@example.com', display_name: 'User' }],
      });

      const view = await mount(
        <SettingsPane
          workspaceId="ws_test"
          workspaceName="Kerning Test"
          currentUserRole="owner"
          onClose={vi.fn()}
          onSignOut={vi.fn()}
        />,
      );

      expect(view.host.textContent).toContain('Brief schedule timezone');
      expect(view.host.textContent).toContain('Controls the timezone for your scheduled morning briefs. Changing this adjusts when your brief delivers.');

      await view.unmount();
    });
  });

  describe('FE-03 & FE-04: Clarification Paused State and Run Acceptance', () => {
    it('renders "Paused · Needs your answer" when run is waiting for input', async () => {
      const runDetail: RunDetailResponse = {
        run: {
          id: 'run_pause_test',
          workspace_id: 'ws_test',
          chat_id: 'chat_1',
          source_message_id: 'msg_1',
          source_job_id: null,
          executor_kind: 'agent',
          status: 'waiting_for_input',
          model_key: 'mimo-25',
          attempt_id: null,
          lease_fence: 1,
          error_code: null,
          error_message: null,
          created_at: '2026-10-05T10:00:00Z',
          updated_at: '2026-10-05T10:00:00Z',
        },
        status: 'waiting_for_input',
        steps: [
          {
            step_index: 0,
            tool_name: 'analyze',
            status: 'running',
            action_id: null,
            result: null,
            created_at: '2026-10-05T10:00:00Z',
            updated_at: '2026-10-05T10:00:00Z',
          },
        ],
        actions: [],
        sources: [],
        activities: [],
        pending_clarification: {
          id: 'clar_1',
          workspace_id: 'ws_test',
          chat_id: 'chat_1',
          run_id: 'run_pause_test',
          source_message_id: 'msg_1',
          requester_user_id: 'user_1',
          question: 'What time would you like the reservation for?',
          intended_operation: 'book_table',
          missing_fields: ['time'],
          candidates_json: null,
          source_revision: 1,
          status: 'pending',
          resolution_response: null,
          resolved_at: null,
          created_at: '2026-10-05T10:00:01Z',
          updated_at: '2026-10-05T10:00:01Z',
        },
      };

      const messages: ChatMessage[] = [
        makeMessage({
          id: 'msg_1',
          content_text: 'Book a table at Bistro',
          run_id: 'run_pause_test',
        }),
      ];

      const view = await mount(
        <Transcript
          messages={messages}
          members={{}}
          steps={[{ id: 's1', label: 'Analyzing request', state: 'running' }]}
          run={runDetail}
          runs={{ run_pause_test: runDetail }}
          currentUserId="user_1"
          onInspectAction={vi.fn()}
        />,
      );

      expect(view.host.textContent).toContain('Paused · Needs your answer');

      await view.unmount();
    });

    it('renders "Thinking…" when run is queued', async () => {
      const runDetail: RunDetailResponse = {
        run: {
          id: 'run_start_test',
          workspace_id: 'ws_test',
          chat_id: 'chat_1',
          source_message_id: 'msg_start',
          source_job_id: null,
          executor_kind: 'agent',
          status: 'queued',
          model_key: 'mimo-25',
          attempt_id: null,
          lease_fence: 1,
          error_code: null,
          error_message: null,
          created_at: '2026-10-05T10:00:00Z',
          updated_at: '2026-10-05T10:00:00Z',
        },
        status: 'queued',
        steps: [],
        actions: [],
        sources: [],
        activities: [],
      };

      const messages: ChatMessage[] = [
        makeMessage({
          id: 'msg_start',
          content_text: 'Review sales notes',
          run_id: 'run_start_test',
        }),
      ];

      const view = await mount(
        <Transcript
          messages={messages}
          members={{}}
          steps={[]}
          run={runDetail}
          runs={{ run_start_test: runDetail }}
          currentUserId="user_1"
          onInspectAction={vi.fn()}
        />,
      );

      expect(view.host.textContent).toContain('Thinking…');

      await view.unmount();
    });
  });

  describe('FE-05 & FE-06: Permissions and Retention Disclosure', () => {
    it('distinguishes member from owner roles and guards owner actions', async () => {
      vi.spyOn(api, 'settings').mockResolvedValue({
        settings: { workspace_id: 'ws_test', default_model: null, created_at: '', updated_at: '' },
      });
      vi.spyOn(api, 'memberSettings').mockResolvedValue({ settings: mockMemberSettings });
      vi.spyOn(api, 'models').mockResolvedValue({ models: [], current_command_key: null, default_command_key: null });
      vi.spyOn(api, 'listMembers').mockResolvedValue({
        members: [{ user_id: 'user_1', role: 'member', joined_at: '', email: 'user@example.com', display_name: 'User' }],
      });

      const view = await mount(
        <SettingsPane
          workspaceId="ws_test"
          workspaceName="Kerning Test"
          currentUserRole="member"
          onClose={vi.fn()}
          onSignOut={vi.fn()}
        />,
      );

      // Switch to Workspace tab
      const wsTab = Array.from(view.host.querySelectorAll('[role="tab"]')).find((el) =>
        el.textContent === 'Kerning Test',
      ) as HTMLButtonElement;
      expect(wsTab).toBeTruthy();
      await React.act(async () => {
        wsTab.click();
      });

      expect(view.host.textContent).toContain('Only workspace owners can rename this workspace.');
      expect(view.host.textContent).toContain('Only workspace owners can delete this workspace.');
      // Danger zone not rendered for non-owners
      expect(view.host.textContent).not.toContain('Danger zone');

      await view.unmount();
    });

    it('requires confirmation before removing a member in owner view', async () => {
      vi.spyOn(api, 'settings').mockResolvedValue({
        settings: { workspace_id: 'ws_test', default_model: null, created_at: '', updated_at: '' },
      });
      vi.spyOn(api, 'memberSettings').mockResolvedValue({ settings: mockMemberSettings });
      vi.spyOn(api, 'models').mockResolvedValue({ models: [], current_command_key: null, default_command_key: null });
      vi.spyOn(api, 'listMembers').mockResolvedValue({
        members: [
          { user_id: 'user_1', role: 'owner', display_name: 'Avi', joined_at: '', email: 'avi@example.com' },
          { user_id: 'user_2', role: 'member', display_name: 'Teammate', joined_at: '', email: 'teammate@example.com' },
        ],
      });
      const removeSpy = vi.spyOn(api, 'removeMember').mockResolvedValue({ ok: true } as never);

      const view = await mount(
        <SettingsPane
          workspaceId="ws_test"
          workspaceName="Kerning Test"
          currentUserRole="owner"
          currentUserId="user_1"
          members={{ user_1: 'Avi', user_2: 'Teammate' }}
          onClose={vi.fn()}
          onSignOut={vi.fn()}
        />,
      );

      // Switch to Workspace tab
      const wsTab = Array.from(view.host.querySelectorAll('[role="tab"]')).find((el) =>
        el.textContent === 'Kerning Test',
      ) as HTMLButtonElement;
      expect(wsTab).toBeTruthy();
      await React.act(async () => {
        wsTab.click();
      });

      expect(view.host.textContent).toContain('Danger zone');
      expect(view.host.textContent).toContain('no workspace content is kept');

      // Click remove on member user_2
      const removeBtns = Array.from(view.host.querySelectorAll('button')).filter((b) => b.textContent === 'Remove');
      expect(removeBtns.length).toBe(1);

      await React.act(async () => {
        removeBtns[0]?.click();
      });

      // Does not immediately call removeMember
      expect(removeSpy).not.toHaveBeenCalled();
      expect(view.host.textContent).toContain('Confirm');

      // Confirm button click
      const confirmBtn = Array.from(view.host.querySelectorAll('button')).find((b) => b.textContent === 'Confirm');
      expect(confirmBtn).toBeTruthy();

      await React.act(async () => {
        confirmBtn?.click();
      });

      expect(removeSpy).toHaveBeenCalledWith('ws_test', 'user_2');

      await view.unmount();
    });

    it('offers a backup download in the delete confirm step without requiring it', async () => {
      vi.spyOn(api, 'settings').mockResolvedValue({
        settings: { workspace_id: 'ws_test', default_model: null, created_at: '', updated_at: '' },
      });
      vi.spyOn(api, 'memberSettings').mockResolvedValue({ settings: mockMemberSettings });
      vi.spyOn(api, 'models').mockResolvedValue({ models: [], current_command_key: null, default_command_key: null });
      vi.spyOn(api, 'listMembers').mockResolvedValue({
        members: [
          { user_id: 'user_1', role: 'owner', display_name: 'Avi', joined_at: '', email: 'avi@example.com' },
        ],
      });
      const download = vi.spyOn(api, 'downloadWorkspaceExport').mockResolvedValue(
        new Response(JSON.stringify({ version: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const deleted = vi.spyOn(api, 'deleteWorkspace').mockResolvedValue({ deleted: true });
      vi.spyOn(URL, 'createObjectURL').mockImplementation((() => 'blob:mock-backup') as typeof URL.createObjectURL);
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

      const onDeleted = vi.fn();
      const view = await mount(
        <SettingsPane
          workspaceId="ws_test"
          workspaceName="Kerning Test"
          currentUserRole="owner"
          currentUserId="user_1"
          onClose={vi.fn()}
          onSignOut={vi.fn()}
          onWorkspaceDeleted={onDeleted}
        />,
      );
      const wsTab = Array.from(view.host.querySelectorAll('[role="tab"]')).find((el) =>
        el.textContent === 'Kerning Test',
      ) as HTMLButtonElement;
      await React.act(async () => {
        wsTab.click();
      });

      const armBtn = Array.from(view.host.querySelectorAll('button')).find((b) =>
        b.textContent === 'Delete workspace',
      ) as HTMLButtonElement;
      await React.act(async () => {
        armBtn.click();
      });

      // Confirm step names the workspace, offers the backup, and deletes either way.
      expect(view.host.textContent).toContain('Permanently delete');
      const backupBtn = Array.from(view.host.querySelectorAll('button')).find((b) =>
        b.textContent === 'Download backup',
      ) as HTMLButtonElement;
      expect(backupBtn).toBeTruthy();
      await React.act(async () => {
        backupBtn.click();
      });
      expect(download).toHaveBeenCalledWith('ws_test', 'json');
      expect(deleted).not.toHaveBeenCalled();

      const confirmBtns = Array.from(view.host.querySelectorAll('button')).filter((b) =>
        b.textContent === 'Delete workspace',
      );
      await React.act(async () => {
        confirmBtns[confirmBtns.length - 1]?.click();
      });
      expect(deleted).toHaveBeenCalledWith('ws_test');
      expect(onDeleted).toHaveBeenCalled();

      await view.unmount();
    });
  });

  describe('FE-08: Pending State Feedback', () => {
    it('ChatOverflow stop button shows "Stopping Otis…" while in flight', async () => {
      let resolveStop!: () => void;
      const onStopMock = vi.fn().mockImplementation(() => new Promise<void>((res) => { resolveStop = res; }));

      const view = await mount(
        <ChatOverflow
          models={[]}
          running={true}
          onStop={onStopMock}
        />,
      );

      const menuTrigger = view.host.querySelector('button[aria-label="Chat options"]') as HTMLElement;
      expect(menuTrigger).toBeTruthy();

      await React.act(async () => {
        menuTrigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      const stopBtn = Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) =>
        el.textContent?.includes('Stop Otis'),
      ) as HTMLElement;
      expect(stopBtn).toBeTruthy();

      await React.act(async () => {
        stopBtn.click();
      });

      expect(onStopMock).toHaveBeenCalled();
      expect(stopBtn.textContent).toContain('Stopping Otis…');

      await React.act(async () => {
        resolveStop();
      });

      await view.unmount();
    });
  });

  describe('FE-09 & FE-15: Composer Error Recovery', () => {
    it('Composer displays model error notice with retry button when modelsError is set', async () => {
      const retryMock = vi.fn();
      const view = await mount(
        <Composer
          commands={[]}
          onSend={vi.fn()}
          modelsError="Could not load models."
          onRetryModels={retryMock}
        />,
      );

      expect(view.host.textContent).toContain('Could not load models.');
      const retryBtn = Array.from(view.host.querySelectorAll('button')).find((b) => b.textContent === 'Retry');
      expect(retryBtn).toBeTruthy();

      await React.act(async () => {
        retryBtn?.click();
      });

      expect(retryMock).toHaveBeenCalled();

      await view.unmount();
    });
  });

  describe('FE-11, FE-12, FE-13: Conversation Rendering & Outcome Receipts', () => {
    it('FE-11: Renders outcome receipt line beneath assistant messages', async () => {
      const runDetail: RunDetailResponse = {
        run: {
          id: 'run_outcome_test',
          workspace_id: 'ws_test',
          chat_id: 'chat_1',
          source_message_id: 'msg_u',
          source_job_id: null,
          executor_kind: 'agent',
          status: 'completed' as never,
          model_key: 'mimo-25',
          attempt_id: null,
          lease_fence: 1,
          error_code: null,
          error_message: null,
          created_at: '2026-10-05T10:00:00Z',
          updated_at: '2026-10-05T10:00:02Z',
        },
        status: 'succeeded',
        steps: [
          {
            step_index: 0,
            tool_name: 'record_visit',
            status: 'succeeded',
            action_id: 'act_1',
            result: null,
            created_at: '2026-10-05T10:00:00Z',
            updated_at: '2026-10-05T10:00:00Z',
          },
        ],
        actions: [
          {
            action_id: 'act_1',
            command_name: 'record_visit',
            result_status: 'applied',
            committed_revision: 1,
            summary: 'Follow-up for Bistro',
            created_at: '2026-10-05T10:00:00Z',
          },
        ],
        sources: [],
        activities: [],
      };

      const messages: ChatMessage[] = [
        makeMessage({
          id: 'msg_u',
          content_text: 'Save note: Visit Bistro tomorrow',
          run_id: 'run_outcome_test',
          sequence: 1,
        }),
        makeMessage({
          id: 'msg_a',
          author_kind: 'agent' as never,
          author_user_id: null,
          content_text: 'Saved the follow-up for Bistro.',
          run_id: 'run_outcome_test',
          sequence: 2,
        }),
      ];

      const onInspect = vi.fn();
      const view = await mount(
        <Transcript
          messages={messages}
          members={{}}
          steps={[]}
          run={runDetail}
          runs={{ run_outcome_test: runDetail }}
          currentUserId="user_1"
          onInspectAction={onInspect}
        />,
      );

      expect(view.host.textContent).toContain('Follow-up for Bistro saved');
      expect(view.host.textContent).toContain('View changes');

      const viewChangesBtn = Array.from(view.host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('View changes'),
      );
      expect(viewChangesBtn).toBeTruthy();

      await React.act(async () => {
        viewChangesBtn?.click();
      });

      expect(onInspect).toHaveBeenCalledWith('act_1');

      await view.unmount();
    });

    it('FE-12: Empty chat displays purposeful subtitle', async () => {
      const view = await mount(
        <Transcript
          messages={[]}
          members={{}}
          steps={[]}
          currentUserId="user_1"
          onInspectAction={vi.fn()}
        />,
      );

      expect(view.host.textContent).toContain('What’s happening?');
      expect(view.host.textContent).toContain('Keep track of visits, promises, and follow-ups.');

      await view.unmount();
    });

    it('FE-13: Multiline notes preserve formatting in member message bubble', async () => {
      const multilineText = 'Item 1: Check inventory\nItem 2: Follow up with supplier\nItem 3: Update price list';
      const messages: ChatMessage[] = [
        makeMessage({
          id: 'msg_multi',
          content_text: multilineText,
          run_id: null,
        }),
      ];

      const view = await mount(
        <Transcript
          messages={messages}
          members={{}}
          steps={[]}
          currentUserId="user_1"
          onInspectAction={vi.fn()}
        />,
      );

      const bubble = view.host.querySelector('.whitespace-pre-wrap');
      expect(bubble).toBeTruthy();
      expect(bubble?.textContent).toBe(multilineText);

      await view.unmount();
    });
  });

  describe('FE-14: Search Label', () => {
    it('HistoryNav uses honest search button and placeholder "Filter loaded chats"', async () => {
      const view = await mount(
        <HistoryNav
          workspaces={[{ id: 'ws_test', name: 'Kerning' }]}
          workspaceId="ws_test"
          workspaceName="Kerning"
          ownChats={[]}
          teamChats={[]}
          onSelectChat={vi.fn()}
          onNewChat={vi.fn()}
          onSwitchWorkspace={vi.fn()}
          onOpenSettings={vi.fn()}
        />,
      );

      expect(view.host.textContent).toContain('Filter loaded chats');

      const searchBtn = Array.from(view.host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Filter loaded chats'),
      );
      expect(searchBtn).toBeTruthy();

      await React.act(async () => {
        searchBtn?.click();
      });

      const filterInput = view.host.querySelector('input[placeholder="Filter loaded chats"]');
      expect(filterInput).toBeTruthy();

      await view.unmount();
    });
  });

  describe('Model selector polish & Voice badges', () => {
    it('does not display "Voice unavailable" when voice is not supported', async () => {
      const models = [
        {
          command_key: 'gemini-2.5-flash',
          display_name: 'Gemini 2.5 Flash',
          provider: 'gemini',
          native_audio_supported: false,
          voice_available: false,
          available: true,
          is_current: true,
          is_default: true,
        },
      ];

      const view = await mount(
        <ChatOverflow
          models={models}
          onCommand={vi.fn()}
        />,
      );

      // Open the dropdown menu
      const trigger = view.host.querySelector('button[aria-label="Chat options"]') as HTMLButtonElement;
      expect(trigger).toBeTruthy();
      await React.act(async () => {
        trigger.click();
      });

      // The text "Voice unavailable" must never appear
      expect(document.body.textContent).not.toContain('Voice unavailable');

      await view.unmount();
    });
  });

  describe('LIVE-01: Sign-in Proposition and Purpose', () => {
    it('displays product purpose before shared-conversation disclosure', async () => {
      const view = await mount(<SignInView onSignedIn={vi.fn()} />);

      expect(view.host.textContent).toContain('Sign in to Otis');
      expect(view.host.textContent).toContain('Keep track of visits, promises, and follow-ups.');
      expect(view.host.textContent).toContain('Members of a workspace can read its shared conversations and retained voice notes.');

      const proposition = view.host.querySelector('.otis-entry__proposition');
      const note = view.host.querySelector('.otis-entry__note');
      expect(proposition).toBeTruthy();
      expect(note).toBeTruthy();

      await view.unmount();
    });
  });

  describe('LIVE-02: Brief Schedule Unified Presentation', () => {
    it('presents morning brief status and timing alongside timezone configuration', async () => {
      vi.spyOn(api, 'settings').mockResolvedValue({
        settings: { workspace_id: 'ws_test', default_model: null, created_at: '', updated_at: '' },
      });
      vi.spyOn(api, 'memberSettings').mockResolvedValue({
        settings: {
          ...mockMemberSettings,
          brief_enabled: true,
          brief_local_time: '08:30',
          brief_weekdays: [1, 2, 3, 4, 5],
          brief_channel: 'web',
        },
      });
      vi.spyOn(api, 'models').mockResolvedValue({ models: [], current_command_key: null, default_command_key: null });
      vi.spyOn(api, 'listMembers').mockResolvedValue({ members: [] });

      const view = await mount(
        <SettingsPane
          workspaceId="ws_test"
          workspaceName="Kerning Test"
          currentUserRole="owner"
          onClose={vi.fn()}
          onSignOut={vi.fn()}
        />,
      );

      expect(view.host.textContent).toContain('Morning brief schedule');
      expect(view.host.textContent).toContain('Enabled');
      expect(view.host.textContent).toContain('08:30');
      expect(view.host.textContent).toContain('Mon, Tue, Wed, Thu, Fri');
      expect(view.host.textContent).toContain('Brief schedule timezone');

      await view.unmount();
    });

    it('explains disabled state when brief is not yet scheduled', async () => {
      vi.spyOn(api, 'settings').mockResolvedValue({
        settings: { workspace_id: 'ws_test', default_model: null, created_at: '', updated_at: '' },
      });
      vi.spyOn(api, 'memberSettings').mockResolvedValue({ settings: mockMemberSettings });
      vi.spyOn(api, 'models').mockResolvedValue({ models: [], current_command_key: null, default_command_key: null });
      vi.spyOn(api, 'listMembers').mockResolvedValue({ members: [] });

      const view = await mount(
        <SettingsPane
          workspaceId="ws_test"
          workspaceName="Kerning Test"
          currentUserRole="owner"
          onClose={vi.fn()}
          onSignOut={vi.fn()}
        />,
      );

      expect(view.host.textContent).toContain('Morning brief schedule');
      expect(view.host.textContent).toContain('Disabled');
      expect(view.host.textContent).toContain('Morning briefs start disabled until you configure a schedule.');
      expect(view.host.textContent).toContain('Weekday brief at 08:30');

      await view.unmount();
    });
  });

  describe('LIVE-03: Provider Effective Access and Truthful Status', () => {
    it('renders platform-included provider with Included badge, purpose, and custom key action without remove button', async () => {
      vi.spyOn(api, 'credentialStatus').mockResolvedValue({
        status: 'ok',
        credential: {
          provider: 'opencode_go',
          status: 'available',
          key_version: 1,
          last_verified_at: null,
          source: 'platform',
          has_platform_fallback: true,
        },
      });

      const view = await mount(
        <ProviderConnection
          workspaceId="ws_test"
          provider="opencode_go"
          name="OpenCode Go"
          onUpdated={vi.fn()}
        />,
      );

      expect(view.host.textContent).toContain('OpenCode Go');
      expect(view.host.textContent).toContain('Included');
      expect(view.host.textContent).toContain('Chat & reasoning inference · Included with Otis platform');
      expect(view.host.textContent).toContain('Provide custom key');
      expect(view.host.textContent).not.toContain('Remove');

      await view.unmount();
    });

    it('renders workspace custom key with Custom key badge, Replace key, and Remove key with confirmation', async () => {
      vi.spyOn(api, 'credentialStatus').mockResolvedValue({
        status: 'ok',
        credential: {
          provider: 'gemini',
          status: 'available',
          key_version: 1,
          last_verified_at: '2026-10-05T12:00:00Z',
          source: 'workspace',
          has_platform_fallback: true,
        },
      });

      const view = await mount(
        <ProviderConnection
          workspaceId="ws_test"
          provider="gemini"
          name="Gemini"
          onUpdated={vi.fn()}
        />,
      );

      expect(view.host.textContent).toContain('Gemini');
      expect(view.host.textContent).toContain('Custom key');
      expect(view.host.textContent).toContain('Chat & multimodal inference · Workspace custom key');
      expect(view.host.textContent).toContain('Replace key');
      expect(view.host.textContent).toContain('Remove key');

      // Click remove key to see confirmation
      const removeBtn = Array.from(view.host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Remove key'),
      );
      expect(removeBtn).toBeTruthy();

      await React.act(async () => {
        removeBtn?.click();
      });

      expect(view.host.textContent).toContain('Removing this key will revert this workspace to included platform access.');
      expect(view.host.textContent).toContain('Confirm remove');

      await view.unmount();
    });
  });

  describe('LIVE-04: Member List Owner & Viewer Identification', () => {
    it('clearly displays member name, email, role, and indicates "(You)" for current viewer', async () => {
      vi.spyOn(api, 'settings').mockResolvedValue({
        settings: { workspace_id: 'ws_test', default_model: null, created_at: '', updated_at: '' },
      });
      vi.spyOn(api, 'memberSettings').mockResolvedValue({ settings: mockMemberSettings });
      vi.spyOn(api, 'models').mockResolvedValue({ models: [], current_command_key: null, default_command_key: null });
      vi.spyOn(api, 'listMembers').mockResolvedValue({
        members: [
          {
            workspace_id: 'ws_test',
            user_id: 'user_owner',
            role: 'owner',
            joined_at: '2026-10-01T00:00:00Z',
            created_at: '2026-10-01T00:00:00Z',
            updated_at: '2026-10-01T00:00:00Z',
            display_name: 'Avi Owner',
            email: 'avi@kerning.com',
          },
          {
            workspace_id: 'ws_test',
            user_id: 'user_teammate',
            role: 'member',
            joined_at: '2026-10-02T00:00:00Z',
            created_at: '2026-10-02T00:00:00Z',
            updated_at: '2026-10-02T00:00:00Z',
            display_name: 'Hunor Member',
            email: 'hunor@kerning.com',
          },
        ],
      });

      const view = await mount(
        <SettingsPane
          workspaceId="ws_test"
          workspaceName="Kerning Test"
          currentUserRole="owner"
          currentUserId="user_owner"
          onClose={vi.fn()}
          onSignOut={vi.fn()}
        />,
      );

      // Switch to Workspace tab
      const wsTab = Array.from(view.host.querySelectorAll('[role="tab"]')).find((el) =>
        el.textContent === 'Kerning Test',
      ) as HTMLButtonElement;
      expect(wsTab).toBeTruthy();
      await React.act(async () => {
        wsTab.click();
      });

      expect(view.host.textContent).toContain('Avi Owner (You)');
      expect(view.host.textContent).toContain('Owner · avi@kerning.com');
      expect(view.host.textContent).toContain('Hunor Member');
      expect(view.host.textContent).toContain('Member · hunor@kerning.com');

      await view.unmount();
    });
  });

  describe('LIVE-05: Create Workspace Focus Management', () => {
    it('manages focus when toggling new workspace creation and returns focus on cancel', async () => {
      vi.spyOn(api, 'settings').mockResolvedValue({
        settings: { workspace_id: 'ws_test', default_model: null, created_at: '', updated_at: '' },
      });
      vi.spyOn(api, 'memberSettings').mockResolvedValue({ settings: mockMemberSettings });
      vi.spyOn(api, 'models').mockResolvedValue({ models: [], current_command_key: null, default_command_key: null });
      vi.spyOn(api, 'listMembers').mockResolvedValue({ members: [] });

      const view = await mount(
        <SettingsPane
          workspaceId="ws_test"
          workspaceName="Kerning Test"
          currentUserRole="owner"
          currentUserId="user_owner"
          onClose={vi.fn()}
          onSignOut={vi.fn()}
        />,
      );

      // Switch to Workspace tab
      const wsTab = Array.from(view.host.querySelectorAll('[role="tab"]')).find((el) =>
        el.textContent === 'Kerning Test',
      ) as HTMLButtonElement;
      await React.act(async () => {
        wsTab.click();
      });

      const newWsBtn = Array.from(view.host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('+ New workspace'),
      ) as HTMLButtonElement;
      expect(newWsBtn).toBeTruthy();

      await React.act(async () => {
        newWsBtn.click();
      });

      const input = view.host.querySelector('input[aria-label="New workspace name"]') as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(document.activeElement).toBe(input);

      const cancelBtn = Array.from(view.host.querySelectorAll('button')).find((b) =>
        b.textContent === 'Cancel',
      ) as HTMLButtonElement;
      expect(cancelBtn).toBeTruthy();

      await React.act(async () => {
        cancelBtn.click();
      });

      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const restoredBtn = Array.from(view.host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('+ New workspace'),
      ) as HTMLButtonElement;
      expect(restoredBtn).toBeTruthy();
      expect(document.activeElement).toBe(restoredBtn);

      await view.unmount();
    });
  });

  describe('LIVE-06: Outcome Summary Sanitization', () => {
    it('sanitizes technical IDs and avoids redundant saved suffixes', () => {
      expect(formatOutcomeSummary('mem_01J2K3L4M5N6P7Q8', 1)).toBe('1 change saved');
      expect(formatOutcomeSummary('(mem_01J2K3L4)', 2)).toBe('2 changes saved');
      expect(formatOutcomeSummary('Saved note for Thai Shop', 1)).toBe('Saved note for Thai Shop');
      expect(formatOutcomeSummary('Thai Shop offer by Friday', 1)).toBe('Thai Shop offer by Friday saved');
      expect(formatOutcomeSummary('Created task for Thai Shop', 1)).toBe('Created task for Thai Shop');
      expect(formatOutcomeSummary('Follow-up saved', 1)).toBe('Follow-up saved');
      expect(formatOutcomeSummary('Saved memory mem_123 for Alice', 1)).toBe('Saved memory for Alice');
      expect(formatOutcomeSummary(null, 3)).toBe('3 changes saved');
    });
  });

  describe('LIVE-08 & LIVE-09: Composer Loading Copy and Quiet Model Label', () => {
    it('shows checking model status during loading and quiet model indicator when resolved', async () => {
      const viewLoading = await mount(
        <Composer
          running={false}
          commands={[]}
          models={[]}
          modelsLoading={true}
          modelReady={false}
          onSend={vi.fn()}
        />,
      );

      expect(viewLoading.host.textContent).toContain('Checking available model…');
      expect(viewLoading.host.textContent).not.toContain('Choose a model to start. Connections are in Settings.');
      await viewLoading.unmount();

      const viewReady = await mount(
        <Composer
          running={false}
          commands={[]}
          models={[
            {
              command_key: 'gemini',
              display_name: 'Gemini 2.5 Pro',
              available: true,
              is_default: true,
              is_current: true,
              thinking: { state: 'supported', choices: [], is_default: true },
            },
          ]}
          modelsLoading={false}
          modelReady={true}
          onSend={vi.fn()}
        />,
      );

      expect(viewReady.host.textContent).toContain('Gemini 2.5 Pro');
      // No duplicate dropdown trigger inside composer
      expect(viewReady.host.querySelector('[aria-label="Choose model"]')).toBeNull();
      await viewReady.unmount();
    });
  });

  describe('LIVE-13: Command Suggestions ARIA ID Resolution', () => {
    it('preserves custom DOM id on CommandItem and CommandList for ARIA resolution', async () => {
      const view = await mount(
        <Command label="Commands">
          <CommandList id="cmd-list-picker">
            <CommandItem id="cmd-option-0" value="/model">/model</CommandItem>
            <CommandItem id="cmd-option-1" value="/help">/help</CommandItem>
          </CommandList>
        </Command>,
      );

      const list = view.host.querySelector('#cmd-list-picker');
      const item0 = view.host.querySelector('#cmd-option-0');
      const item1 = view.host.querySelector('#cmd-option-1');
      expect(list).toBeTruthy();
      expect(list?.getAttribute('id')).toBe('cmd-list-picker');
      expect(item0).toBeTruthy();
      expect(item1).toBeTruthy();
      expect(item0?.getAttribute('id')).toBe('cmd-option-0');

      await view.unmount();
    });
  });

  describe('LIVE-14: HistoryNav Option Touch Target Isolation', () => {
    it('renders dedicated nonoverlapping options button class for chat rows', async () => {
      const view = await mount(
        <HistoryNav
          workspaces={[{ id: 'ws_test', name: 'Kerning' }]}
          workspaceId="ws_test"
          workspaceName="Kerning"
          ownChats={[{
            id: 'chat_1',
            workspace_id: 'ws_test',
            title: 'Client discussion',
            author_user_id: 'usr_1',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }]}
          teamChats={[]}
          activeChatId={null}
          onSelectChat={vi.fn()}
          onNewChat={vi.fn()}
          onSwitchWorkspace={vi.fn()}
          onOpenSettings={vi.fn()}
          onRenameChat={vi.fn()}
          onDeleteChat={vi.fn()}
        />,
      );

      const optionsBtn = view.host.querySelector('.otis-nav__options-btn');
      expect(optionsBtn).toBeTruthy();
      expect(optionsBtn?.getAttribute('aria-label')).toContain('Options for Client discussion');

      await view.unmount();
    });
  });

  describe('LIVE-15: HistoryNav Filter Escape Bubbling Prevention', () => {
    it('stops propagation of Escape event when closing search filter', async () => {
      const outerKeyDown = vi.fn();
      const view = await mount(
        <div onKeyDown={outerKeyDown}>
          <HistoryNav
            workspaces={[{ id: 'ws_test', name: 'Kerning' }]}
            workspaceId="ws_test"
            workspaceName="Kerning"
            ownChats={[]}
            teamChats={[]}
            activeChatId={null}
            onSelectChat={vi.fn()}
            onNewChat={vi.fn()}
            onSwitchWorkspace={vi.fn()}
            onOpenSettings={vi.fn()}
          />
        </div>,
      );

      const filterBtn = Array.from(view.host.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Filter loaded chats'),
      ) as HTMLButtonElement;
      expect(filterBtn).toBeTruthy();

      await React.act(async () => {
        filterBtn.click();
      });

      const searchInput = view.host.querySelector('input[type="search"]') as HTMLInputElement;
      expect(searchInput).toBeTruthy();

      await React.act(async () => {
        searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      expect(outerKeyDown).not.toHaveBeenCalled();
      await view.unmount();
    });
  });

  describe('LIVE-17: Consolidated Read Steps in WorkingDisclosure', () => {
    it('groups consecutive identical read steps without actions', () => {
      const rawSteps = [
        { id: 's1', label: 'Reading saved records', state: 'succeeded' as const },
        { id: 's2', label: 'Reading saved records', state: 'succeeded' as const },
        { id: 's3', label: 'Reading saved records', state: 'succeeded' as const },
        { id: 's4', label: 'Reading saved records', state: 'succeeded' as const },
        { id: 's5', label: 'Saving follow-up: "Thai Shop"', state: 'succeeded' as const, actionId: 'act_1' },
      ];

      const consolidated = consolidateWorkingSteps(rawSteps);
      expect(consolidated).toHaveLength(2);
      expect(consolidated[0]?.label).toBe('Reading saved records');
      expect(consolidated[0]?.count).toBe(4);
      expect(consolidated[1]?.actionId).toBe('act_1');
    });
  });

  describe('LIVE-18: Blank Startup Resilience via ErrorBoundary', () => {
    it('catches runtime errors and renders recovery UI with Reload button', async () => {
      const ProblemChild = () => {
        throw new Error('Test hydration failure');
      };

      // Suppress console.error in test runner output
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const view = await mount(
        <ErrorBoundary>
          <ProblemChild />
        </ErrorBoundary>,
      );

      expect(view.host.textContent).toContain('Something went wrong');
      expect(view.host.textContent).toContain('Reload Otis');

      errorSpy.mockRestore();
      await view.unmount();
    });
  });

  describe('LIVE-19 & LIVE-20: DetailPane Memory Change Reversal & Focus Restoration', () => {
    it('describes memory reversals and affected context items individually', async () => {
      vi.spyOn(api, 'action').mockResolvedValue({
        action: {
          action_id: 'act_1',
          workspace_id: 'ws_test',
          command_name: 'forget_memory',
          result_status: 'applied',
          summary: 'Removed memory note mem_01J2K3',
          committed_revision: 1,
          actor_kind: 'member',
          actor_user_id: 'usr_1',
          source_message_id: null,
          run_id: 'run_1',
          step_id: null,
          created_at: '2026-10-05T12:00:00Z',
          events: [],
          undo: { available: true, reverted_event_ids: [], reverted_by_event_ids: [] },
          source: null,
        },
      });

      vi.spyOn(api, 'undoPreview').mockResolvedValue({
        preview: {
          target_action_id: 'act_1',
          mode: 'from_here',
          selected_action_ids: ['act_1', 'act_2', 'act_3'],
          affected_event_ids: [],
          affected_entities: [],
          affected_tasks: [],
          affected_context: [
            { id: 'evt_1', summary: 'memory note', changes: ['Saved context: "Apex Paperworks note" will be removed.'] },
            { id: 'evt_2', summary: 'memory forgotten', changes: ['Forgotten memory will be restored.'] },
          ],
          dependencies: [],
          expected_revision: 1,
        },
      });

      const triggerBtn = document.createElement('button');
      triggerBtn.textContent = 'View changes';
      document.body.appendChild(triggerBtn);
      triggerBtn.focus();
      expect(document.activeElement).toBe(triggerBtn);

      const view = await mount(
        <DetailPane
          workspaceId="ws_test"
          chatId="chat_1"
          actionId="act_1"
          onClose={vi.fn()}
          onUndone={vi.fn()}
        />,
      );

      // What changed should sanitize raw mem_ ID
      expect(view.host.textContent).toContain('Removed memory note');
      expect(view.host.textContent).not.toContain('mem_01J2K3');

      // Revert 3 saved changes describes reversal context
      expect(view.host.textContent).toContain('Revert 3 saved changes?');
      expect(view.host.textContent).toContain('Saved context: "Apex Paperworks note" will be removed.');
      expect(view.host.textContent).toContain('Forgotten memory will be restored.');

      await view.unmount();

      // Focus restored to trigger on unmount
      expect(document.activeElement).toBe(triggerBtn);
      triggerBtn.remove();
    });
  });
});

