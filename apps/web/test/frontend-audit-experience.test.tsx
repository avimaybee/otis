/** @vitest-environment happy-dom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { SignInView } from '../src/components/SignInView.js';
import { SettingsPane } from '../src/components/SettingsPane.js';
import { Transcript } from '../src/components/Transcript.js';
import { Composer } from '../src/components/Composer.js';
import { ChatOverflow } from '../src/components/ChatOverflow.js';
import { HistoryNav } from '../src/components/HistoryNav.js';
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

    it('renders "Received by Otis · Starting…" when run is queued', async () => {
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

      expect(view.host.textContent).toContain('Received by Otis · Starting…');

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
      expect(view.host.textContent).toContain('Audited ledger records remain governed by retention policy');

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
});

