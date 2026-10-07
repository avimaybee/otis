/** @vitest-environment happy-dom */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { Chat, RunDetailResponse } from '@otis/contracts';
import { RouterProvider } from '@tanstack/react-router';
import { SessionContext, createAppRouter } from '../src/router.js';
import { TestQueryProvider } from './query.js';
import { resetOutboxForTests } from '../src/api/outbox.js';
import { api } from '../src/api/client.js';
import * as stream from '../src/hooks/useActivityStream.js';

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const WS = 'ws_visibility';
const USER = 'usr_avi';
const TIMESTAMP = '2026-10-06T12:00:00.000Z';

function makeChat(id: string): Chat {
  return {
    id,
    workspace_id: WS,
    title: 'Visibility chat',
    author_user_id: USER,
    author_display_name: 'Avi',
    model_override: null,
    is_archived: false,
    activity_cursor: 7,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    last_activity_at: TIMESTAMP,
  };
}

async function mount(element: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => root.render(<TestQueryProvider>{element}</TestQueryProvider>));
  await React.act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  return {
    host,
    unmount: async () => {
      await React.act(async () => root.unmount());
      host.remove();
    },
  };
}

function RouteShell() {
  const [router] = React.useState(() => createAppRouter());
  return (
    <SessionContext.Provider
      value={{ userId: USER, workspaces: [{ id: WS, name: 'Kerning' }], members: { [USER]: 'Avi' }, onSignOut: () => {} }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>
  );
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

function mockChatApis() {
  vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [makeChat('chat_vis')] });
  vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] } as never);
  vi.spyOn(api, 'models').mockResolvedValue({ models: [], current_command_key: null, default_command_key: null } as never);
  vi.spyOn(api, 'getChat').mockResolvedValue({ chat: makeChat('chat_vis'), is_author: true } as never);
  vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: 'chat_vis', messages: [], next_before_sequence: null } as never);
  vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 7 } as never);
  vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
}

describe('F12-SSE hidden-tab suspend', () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetOutboxForTests();
    setVisibility('visible');
    history.replaceState({}, '', `/?workspace=${WS}&chat=chat_vis`);
  });

  afterEach(() => {
    setVisibility('visible');
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('closes the stream while hidden and resubscribes from the snapshot cursor on foreground', async () => {
    mockChatApis();
    const subscribe = vi.spyOn(stream, 'subscribeToActivity').mockReturnValue({ close: vi.fn() });

    const view = await mount(<RouteShell />);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(vi.mocked(subscribe).mock.calls[0]![0]).toContain('after=7');
    const firstClose = vi.mocked(subscribe).mock.results[0]!.value.close;

    await React.act(async () => setVisibility('hidden'));
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);

    await React.act(async () => setVisibility('visible'));
    expect(subscribe).toHaveBeenCalledTimes(2);
    // The foreground resubscribe replays from the snapshot cursor, so the
    // gapless catch-up covers everything missed while hidden.
    expect(vi.mocked(subscribe).mock.calls[1]![0]).toContain('after=7');

    await view.unmount();
  });

  it('does not poll run state from a hidden tab', async () => {
    const runningRun: RunDetailResponse = {
      run: { id: 'run_vis', status: 'running' } as never,
      status: 'running',
      steps: [],
      actions: [],
      activities: [],
      pending_clarification: null,
    };
    mockChatApis();
    vi.spyOn(api, 'listMessages').mockResolvedValue({
      chat_id: 'chat_vis',
      messages: [{
        id: 'm1', workspace_id: WS, chat_id: 'chat_vis', author_user_id: USER,
        author_display_name: 'Avi', author_kind: 'member', channel: 'web',
        inbound_message_id: 'in_m1', client_message_id: null, content_text: 'Working?',
        media_id: null, run_id: 'run_vis', sequence: 1,
        created_at: TIMESTAMP, updated_at: TIMESTAMP,
      }],
      next_before_sequence: null,
    } as never);
    vi.spyOn(api, 'runs').mockResolvedValue({ runs: [runningRun] });
    const runSpy = vi.spyOn(api, 'run').mockResolvedValue(runningRun);
    vi.spyOn(stream, 'subscribeToActivity').mockReturnValue({ close: vi.fn() });

    // Real timers for mount so the snapshot settles; the 2.5s backstop timer
    // cannot fire before the immediate hide below clears it.
    const view = await mount(<RouteShell />);
    await React.act(async () => setVisibility('hidden'));

    vi.useFakeTimers();
    try {
      await React.act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(runSpy).not.toHaveBeenCalled();

      await React.act(async () => setVisibility('visible'));
      // Separate acts: the visibility update must flush (re-arming the
      // backstop timer) before fake time advances past its deadline.
      await React.act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      // The foreground backstop resumes: one run refresh past the quiet window.
      expect(runSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }

    await view.unmount();
  });

  it('skips the transcript reload for already-filed acceptances', async () => {
    mockChatApis();
    vi.spyOn(api, 'listMessages').mockResolvedValue({
      chat_id: 'chat_vis',
      messages: [{
        id: 'msg_own', workspace_id: WS, chat_id: 'chat_vis', author_user_id: USER,
        author_display_name: 'Avi', author_kind: 'member', channel: 'web',
        inbound_message_id: 'in_own', client_message_id: 'uuid-own', content_text: 'Filed already',
        media_id: null, run_id: 'run_own', sequence: 1,
        created_at: TIMESTAMP, updated_at: TIMESTAMP,
      }],
      next_before_sequence: null,
    } as never);
    vi.spyOn(api, 'runs').mockResolvedValue({ runs: [] });
    const subscribe = vi.spyOn(stream, 'subscribeToActivity').mockReturnValue({ close: vi.fn() });

    const view = await mount(<RouteShell />);
    const listMessages = vi.mocked(api.listMessages);
    expect(listMessages).toHaveBeenCalledTimes(1);
    const onActivity = vi.mocked(subscribe).mock.calls[0]![1].onActivity;
    const accepted = (clientMessageId: unknown, id: string) => ({
      id, workspace_id: WS, chat_id: 'chat_vis', run_id: 'run_own', cursor: 100 + id.length,
      type: 'message_accepted', payload: { client_message_id: clientMessageId },
      created_at: TIMESTAMP,
    } as never);

    // Own send, already filed from the acceptance receipt: a resubscribe
    // replaying the row must not re-download the transcript.
    await React.act(async () => {
      onActivity(accepted('uuid-own', 'act_own'));
      await new Promise(resolve => setTimeout(resolve, 300));
    });
    expect(listMessages).toHaveBeenCalledTimes(1);

    // Teammate/other-tab acceptance: not filed locally, still refreshes.
    await React.act(async () => {
      onActivity(accepted('uuid-other', 'act_other'));
      await new Promise(resolve => setTimeout(resolve, 300));
    });
    expect(listMessages).toHaveBeenCalledTimes(2);

    // Fail open: an acceptance without an identity always refreshes.
    await React.act(async () => {
      onActivity(accepted(undefined, 'act_noid'));
      await new Promise(resolve => setTimeout(resolve, 300));
    });
    expect(listMessages).toHaveBeenCalledTimes(3);

    await view.unmount();
  });
});
