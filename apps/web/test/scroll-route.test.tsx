/** @vitest-environment happy-dom */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import * as matchers from 'vitest-axe/matchers';
import { axe } from 'vitest-axe';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from '../src/api/client.js';
import { api } from '../src/api/client.js';
import * as stream from '../src/hooks/useActivityStream.js';
import { Composer } from '../src/components/Composer.js';
import { Transcript, clearScrollPositionsForTests, readScrollPosition, saveScrollPosition } from '../src/components/Transcript.js';
import { ThinkingDisclosure } from '../src/components/Thinking.js';
import { ChatOverflow } from '../src/components/ChatOverflow.js';
import { useViewportComposer } from '../src/hooks/useViewportComposer.js';
import { applyActivitySnapshot, applyOlderMessages, mergeMessages, type ChatSnapshot } from '../src/api/snapshot.js';
import {
  dayKeyInZone,
  formatClockTime,
  formatDayLabel,
  formatMoney,
  parseAppLanguage,
} from '../src/i18n/format.js';
import { parseConversationSearch } from '../src/router.js';
import { storyMembers, storyMessage } from '../src/stories/fixtures.js';
import { storyRun } from '../src/stories/fixtures.js';
import { resetOutboxForTests } from '../src/api/outbox.js';
import { mountRoute } from './route.js';
import type { Chat, ChatMessage, PublicActivity } from '@otis/contracts';

expect.extend(matchers);

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const RULES = { rules: { 'color-contrast': { enabled: false } } };

async function mount(element: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => root.render(element));
  return {
    host,
    unmount: async () => {
      await React.act(async () => root.unmount());
      host.remove();
    },
  };
}

async function fill(input: HTMLTextAreaElement, value: string) {
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const COMMANDS = [
  { name: 'model', summary: 'Show or set the model for this chat.', usage: '/model', available: true, deterministic: true },
  { name: 'help', summary: 'List the available commands.', usage: '/help', available: true, deterministic: true },
];

beforeEach(() => {
  sessionStorage.clear();
  resetOutboxForTests();
  clearScrollPositionsForTests();
  document.documentElement.lang = 'en';
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  clearScrollPositionsForTests();
  history.replaceState({}, '', '/');
});

describe('008C typed route search', () => {
  it('keeps the shared ?workspace=&chat= shape and drops unknown params', () => {
    expect(parseConversationSearch({ workspace: 'ws', chat: 'chat_1', foo: 1 })).toEqual({ workspace: 'ws', chat: 'chat_1' });
    expect(parseConversationSearch({})).toEqual({});
    expect(parseConversationSearch({ workspace: '', chat: 'new' })).toEqual({ chat: 'new' });
    expect(parseConversationSearch({ chat: 123 })).toEqual({});
  });
});

describe('008C prepend anchors and merge ordering', () => {
  const base = (id: string, sequence: number, text: string): ChatMessage => ({
    id,
    workspace_id: 'ws',
    chat_id: 'chat_1',
    author_user_id: 'u1',
    author_kind: 'member',
    channel: 'web',
    inbound_message_id: null,
    client_message_id: null,
    content_text: text,
    media_id: null,
    run_id: null,
    sequence,
    created_at: '2026-10-03T12:00:00.000Z',
    updated_at: '2026-10-03T12:00:00.000Z',
  });

  it('prepends older pages without duplicating overlapping rows', () => {
    const snapshot = {
      messages: [base('m2', 2, 'second'), base('m3', 3, 'third')],
      older: 2,
    } as ChatSnapshot;
    // Overlapping page responses dedupe by stable identity and keep order.
    const merged = applyOlderMessages(snapshot, [base('m1', 1, 'first'), base('m2', 2, 'second')], 1);
    expect(merged.messages.map(message => message.id)).toEqual(['m1', 'm2', 'm3']);
    expect(merged.older).toBe(1);
    // Repeated pagination with the same cursor adds nothing.
    const again = applyOlderMessages(merged, [base('m1', 1, 'first')], 1);
    expect(again.messages.map(message => message.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('keeps streaming activity stable while an older page resolves', () => {
    const snapshot = { messages: [base('m2', 2, 'second')], activities: [], cursor: 0 } as ChatSnapshot;
    const chunk: PublicActivity = {
      schema_version: 1,
      id: 'act-1',
      cursor: 1,
      workspace_id: 'ws',
      chat_id: 'chat_1',
      run_id: 'run-1',
      type: 'text_chunk',
      payload: { text: 'live answer' },
      created_at: '2026-10-03T12:00:01.000Z',
    };
    const streamed = applyActivitySnapshot(snapshot, chunk);
    expect(streamed.messages.map(message => message.id)).toEqual(['m2']);
    const prepended = applyOlderMessages(streamed, [base('m1', 1, 'first')], null);
    expect(prepended.messages.map(message => message.id)).toEqual(['m1', 'm2']);
    expect(prepended.activities.map(activity => activity.id)).toEqual(['act-1']);
    expect(mergeMessages([base('m1', 1, 'a')], [base('m1', 1, 'a')])).toHaveLength(1);
  });

  it('bounds saved reading anchors and keeps the newest write', () => {
    for (let index = 0; index < 21; index += 1) {
      saveScrollPosition(`chat-${index}`, { top: index, follow: false });
    }
    expect(readScrollPosition('chat-0')).toBeUndefined();
    expect(readScrollPosition('chat-20')).toEqual({ top: 20, follow: false });
    saveScrollPosition('chat-1', { top: 111, follow: true });
    expect(readScrollPosition('chat-1')).toEqual({ top: 111, follow: true });
  });
});

describe('008C transcript follow, jump and announcements', () => {
  it('restores a saved reading anchor instead of jumping to the bottom', async () => {
    saveScrollPosition('restore-1', { top: 120, follow: false });
    const view = await mount(
      <Transcript
        messages={[storyMessage({ content_text: 'First kept note.' }), storyMessage({ content_text: 'Second kept note.' })]}
        members={storyMembers}
        currentUserId="user-hunor"
        steps={[]}
        onInspectAction={() => {}}
        positionKey="restore-1"
      />,
    );
    expect((view.host.querySelector('.otis-transcript') as HTMLElement).scrollTop).toBe(120);
    // History disclosure, not a new announcement surface.
    expect(view.host.querySelector('[role="log"]')?.getAttribute('aria-live')).toBe('polite');
    await view.unmount();
  });

  it('shows Jump to latest with its count and reports it once', async () => {
    const jumped = vi.fn();
    const view = await mount(
      <Transcript
        messages={[storyMessage({ content_text: 'Keep reading here.' })]}
        members={storyMembers}
        currentUserId="user-hunor"
        steps={[]}
        pendingUnread={3}
        onJumpToLatest={jumped}
        onInspectAction={() => {}}
      />,
    );
    const jump = view.host.querySelector('[aria-label="Jump to latest messages"]') as HTMLElement;
    expect(jump).toBeTruthy();
    expect(jump.textContent).toContain('3');
    await React.act(async () => jump.click());
    expect(jumped).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('marks the log busy while running and clears it on failure', async () => {
    const running = await mount(
      <Transcript
        messages={[storyMessage({ content_text: 'Working now.', run_id: 'run-story-1' })]}
        members={storyMembers}
        currentUserId="user-hunor"
        steps={[]}
        runs={{ 'run-story-1': storyRun('running') }}
        onInspectAction={() => {}}
      />,
    );
    expect(running.host.querySelector('[role="log"]')?.getAttribute('aria-busy')).toBe('true');
    await running.unmount();
    const failed = await mount(
      <Transcript
        messages={[storyMessage({ content_text: 'Could not finish.', run_id: 'run-story-1' })]}
        members={storyMembers}
        currentUserId="user-hunor"
        steps={[]}
        runs={{ 'run-story-1': storyRun('failed') }}
        onInspectAction={() => {}}
      />,
    );
    expect(failed.host.querySelector('[role="log"]')?.getAttribute('aria-busy')).toBe('false');
    expect(await axe(failed.host, RULES)).toHaveNoViolations();
    await failed.unmount();
  });

  it('keeps streamed token subtrees off the live region', async () => {
    const view = await mount(
      <Transcript
        messages={[storyMessage({ content_text: 'Please summarize.', run_id: 'run-live' })]}
        members={storyMembers}
        currentUserId="user-hunor"
        steps={[]}
        runs={{
          'run-live': storyRun('running', {
            steps: [
              {
                step_index: 0,
                tool_name: 'query',
                status: 'running',
                action_id: null,
                result: null,
                created_at: '2026-10-03T12:00:00.000Z',
                updated_at: '2026-10-03T12:00:00.000Z',
              },
            ],
          }),
        }}
        activities={[
          {
            schema_version: 1,
            id: 'act-live-1',
            cursor: 1,
            workspace_id: 'ws_1',
            chat_id: 'chat_1',
            run_id: 'run-live',
            type: 'text_chunk',
            payload: { text: 'partial answer' },
            created_at: '2026-10-03T12:00:01.000Z',
          },
        ]}
        onInspectAction={() => {}}
      />,
    );
    expect(view.host.querySelector('.otis-streamed')?.getAttribute('aria-live')).toBe('off');
    expect(view.host.querySelector('.otis-working')?.getAttribute('aria-live')).toBe('off');
    expect(view.host.querySelector('.otis-streamed')?.getAttribute('aria-live')).toBe('off');
    expect(view.host.querySelector('.otis-working')?.getAttribute('aria-live')).toBe('off');
    await view.unmount();
  });

  it('renders Romanian and Hungarian diacritics as ordinary text with comma-below and double acutes', async () => {
    const candidateString = 'Restaurantul 2 e cald acum. Oferta până vineri, 3.500 RON. Șantier, țară, tűz, őr.';
    const timeString = 'Fri 9 Oct · 3,500 RON · 07:41';
    const view = await mount(
      <Transcript
        messages={[storyMessage({ content_text: `${candidateString}\n\n${timeString}` })]}
        members={storyMembers}
        currentUserId="user-hunor"
        steps={[]}
        onInspectAction={() => {}}
      />,
    );
    expect(view.host.textContent).toContain(candidateString);
    expect(view.host.textContent).toContain(timeString);

    // Verify correct Unicode codepoints:
    // Romanian Ș (\u0218) and ț (\u021B) have comma-below, not cedilla (\u015E, \u015F, \u0162, \u0163)
    expect(candidateString).toContain('\u0218'); // Ș (capital S comma-below in Șantier)
    expect(candidateString).toContain('\u021B'); // ț (lowercase t comma-below in țară)
    expect(candidateString).not.toContain('\u015E'); // Ş (capital S cedilla)
    expect(candidateString).not.toContain('\u015F'); // ş (lowercase s cedilla)
    expect(candidateString).not.toContain('\u0162'); // Ţ (capital T cedilla)
    expect(candidateString).not.toContain('\u0163'); // ţ (lowercase t cedilla)

    // Hungarian ő (\u0151) and ű (\u0171) have double acutes, not umlauts (\u00F6, \u00FC)
    expect(candidateString).toContain('\u0151'); // ő (lowercase o double-acute in őr)
    expect(candidateString).toContain('\u0171'); // ű (lowercase u double-acute in tűz)
    expect(candidateString).not.toContain('\u00F6'); // ö (umlaut)
    expect(candidateString).not.toContain('\u00FC'); // ü (umlaut)

    await view.unmount();
  });
});

describe('008C history partition keeps completions announcing once', () => {
  const group = (id: string, sequence: number, text: string) =>
    storyMessage({ id, content_text: text, sequence });

  async function mountRerender(initial: Parameters<typeof Transcript>[0]) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const renderAll = async (props: Parameters<typeof Transcript>[0]) => {
      await React.act(async () => {
        root.render(<Transcript {...props} />);
      });
    };
    await renderAll(initial);
    return {
      host,
      renderAll,
      unmount: async () => {
        await React.act(async () => root.unmount());
        host.remove();
      },
    };
  }

  const baseProps = {
    members: storyMembers,
    currentUserId: 'user-hunor',
    steps: [],
    onInspectAction: () => {},
  } as const;

  it('mutes prepended history without touching the live log', async () => {
    const view = await mountRerender({ ...baseProps, messages: [group('m1', 1, 'First'), group('m2', 2, 'Second')] });
    expect(view.host.querySelector('[role="log"]')?.getAttribute('aria-live')).toBe('polite');
    expect(view.host.querySelectorAll('.otis-message-group[aria-live="off"]')).toHaveLength(0);
    // An older page resolves above: only the prepended group opts out.
    await view.renderAll({ ...baseProps, messages: [group('m0', 0, 'Older'), group('m1', 1, 'First'), group('m2', 2, 'Second')] });
    const groups = Array.from(view.host.querySelectorAll('.otis-message-group'));
    expect(groups).toHaveLength(3);
    expect(groups[0]!.getAttribute('aria-live')).toBe('off');
    expect(groups[1]!.getAttribute('aria-live')).toBeNull();
    expect(groups[2]!.getAttribute('aria-live')).toBeNull();
    expect(view.host.querySelector('[role="log"]')?.getAttribute('aria-live')).toBe('polite');
    await view.unmount();
  });

  it('announces a completion that settles while a prepend overlaps', async () => {
    const view = await mountRerender({
      ...baseProps,
      messages: [group('m1', 1, 'Please summarize.')],
      runs: { 'run-live': storyRun('running') },
    });
    // Streaming and prepend resolve together with the completed answer.
    await view.renderAll({
      ...baseProps,
      messages: [
        group('m0', 0, 'Older note'),
        group('m1', 1, 'Please summarize.'),
        { ...group('m2', 2, 'Summary done.'), author_kind: 'system' as const, author_user_id: null },
      ],
      runs: { 'run-live': storyRun('succeeded') },
    });
    const groups = Array.from(view.host.querySelectorAll('.otis-message-group'));
    expect(groups[0]!.getAttribute('aria-live')).toBe('off');
    // The completed answer stays in the live partition: announced once, and
    // the log itself was never muted to suppress the prepend.
    expect(groups[2]!.getAttribute('aria-live')).toBeNull();
    expect(view.host.querySelector('[role="log"]')?.getAttribute('aria-live')).toBe('polite');
    expect(view.host.textContent).toContain('Summary done.');
    await view.unmount();
  });
});

describe('008C thinking disclosure behavior', () => {
  const block = {
    key: 'run-1:0:s0',
    runId: 'run-1',
    roundIndex: 0,
    blockId: 's0',
    provider: 'gemini',
    contentKind: 'summary' as const,
    state: 'complete' as const,
    text: 'Considering the visit first.',
    firstCursor: 1,
    lastCursor: 2,
    truncated: false,
  };
  it('exposes one named trigger with stable expanded state', async () => {
    const view = await mount(<ThinkingDisclosure blocks={[block]} />);
    const trigger = view.host.querySelector('button') as HTMLElement;
    expect(trigger.textContent).toContain('Thinking');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(view.host.textContent).not.toContain('Considering the visit');
    await React.act(async () => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(view.host.textContent).toContain('Considering the visit first.');
    // The label never mutates per token: it stays one static trigger.
    expect(trigger.textContent).toContain('Thinking');
    expect(await axe(view.host, RULES)).toHaveNoViolations();
    await view.unmount();
  });

  it('renders nothing when no displayable reasoning arrived', async () => {
    const view = await mount(<ThinkingDisclosure blocks={[]} />);
    expect(view.host.innerHTML).toBe('');
    await view.unmount();
  });
});

describe('008C overflow stop is an action, not a choice', () => {
  it('offers Stop Otis as a menu item that runs once', async () => {
    const onStop = vi.fn().mockResolvedValue(undefined);
    const view = await mount(
      <ChatOverflow
        models={[
          {
            command_key: 'mimo-25',
            display_name: 'MiMo V2.5',
            provider: 'opencode_go',
            available: true,
            is_current: true,
            is_default: true,
            native_audio_supported: false,
            voice_available: false,
          },
        ]}
        running
        onStop={onStop}
        onCommand={vi.fn()}
      />,
    );
    await React.act(async () => {
      (view.host.querySelector('[aria-label="Chat options"]') as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    const stop = Array.from(document.querySelectorAll('[role="menuitem"]')).find(item =>
      item.textContent?.includes('Stop Otis'),
    ) as HTMLElement;
    expect(stop).toBeTruthy();
    expect(
      Array.from(document.querySelectorAll('[role="menuitemradio"]')).some(item => item.textContent?.includes('Stop Otis')),
    ).toBe(false);
    await React.act(async () => stop.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});

describe('008C composer keyboard contract', () => {
  const desktopMedia = (matches: boolean) =>
    vi.spyOn(window, 'matchMedia').mockImplementation(
      query =>
        ({
          media: query,
          matches,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList,
    );

  it('sends on desktop Enter and keeps Shift+Enter as a newline', async () => {
    desktopMedia(true);
    const onSend = vi.fn().mockResolvedValue(true);
    const view = await mount(<Composer running={false} commands={COMMANDS} onSend={onSend} />);
    const input = view.host.querySelector('textarea')!;
    await fill(input, 'Hello desktop');
    await React.act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledWith('Hello desktop');
    await fill(input, 'Second line');
    await React.act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('never sends while composing an IME candidate', async () => {
    desktopMedia(true);
    const onSend = vi.fn();
    const view = await mount(<Composer running={false} commands={COMMANDS} onSend={onSend} />);
    const input = view.host.querySelector('textarea')!;
    await fill(input, 'kore');
    await React.act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }));
    });
    expect(onSend).not.toHaveBeenCalled();
    await view.unmount();
  });
});

describe('008C viewport measurement', () => {
  function Probe({ showComposer }: { showComposer: boolean }) {
    const composerRef = useViewportComposer();
    // Read-only views render no composer node; own chats mount (and can
    // replace) one. The callback ref tracks the mounted element itself.
    return showComposer ? <div ref={composerRef} data-composer="yes">probe</div> : <div>probe</div>;
  }

  it('publishes measured viewport and composer variables and cleans up', async () => {
    const observe = vi.spyOn(window.ResizeObserver.prototype, 'observe');
    const disconnect = vi.spyOn(window.ResizeObserver.prototype, 'disconnect');
    const view = await mount(<Probe showComposer />);
    expect(document.documentElement.style.getPropertyValue('--app-viewport-height')).toBe(
      `${Math.round(window.innerHeight)}px`,
    );
    expect(document.documentElement.style.getPropertyValue('--app-composer-height')).toBe('0px');
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]![0]).toBe(view.host.querySelector('[data-composer]'));
    await view.unmount();
    expect(disconnect).toHaveBeenCalled();
    expect(document.documentElement.style.getPropertyValue('--app-viewport-height')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--app-composer-height')).toBe('');
  });

  it('moves observation from the old node to a replaced composer', async () => {
    const observe = vi.spyOn(window.ResizeObserver.prototype, 'observe');
    const disconnect = vi.spyOn(window.ResizeObserver.prototype, 'disconnect');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const renderProbe = async (showComposer: boolean, key: string) => {
      await React.act(async () => {
        root.render(<Probe showComposer={showComposer} key={key} />);
      });
    };
    // Read-only first: no composer node exists, so nothing is observed.
    await renderProbe(false, 'read-only');
    expect(document.documentElement.style.getPropertyValue('--app-composer-height')).toBe('0px');
    const observedBefore = observe.mock.calls.length;
    // Switching to an own chat mounts the composer; replacing it moves the
    // single observer off the old node onto the new one.
    await renderProbe(true, 'own');
    expect(observe.mock.calls.length).toBeGreaterThan(observedBefore);
    const firstNode = observe.mock.calls[observe.mock.calls.length - 1]![0];
    await renderProbe(true, 'own-replaced');
    expect(disconnect).toHaveBeenCalled();
    const secondNode = observe.mock.calls[observe.mock.calls.length - 1]![0];
    expect(secondNode).toBeTruthy();
    expect(secondNode).not.toBe(firstNode);
    await React.act(async () => root.unmount());
    host.remove();
    expect(document.documentElement.style.getPropertyValue('--app-composer-height')).toBe('');
  });
});

describe('008C formatting owner', () => {
  it('separates UTC-midnight records by the viewer calendar date', () => {
    expect(dayKeyInZone('2026-01-01T00:30:00.000Z', 'UTC')).toBe('2026-01-01');
    expect(dayKeyInZone('2026-01-01T00:30:00.000Z', 'America/New_York')).toBe('2025-12-31');
    expect(dayKeyInZone('2026-01-01T00:30:00.000Z', 'Pacific/Kiritimati')).toBe('2026-01-01');
  });

  it('formats across a DST spring-forward boundary', () => {
    expect(formatClockTime('2026-03-08T06:59:00.000Z', 'en-US', 'America/New_York')).toBe('01:59 AM');
    expect(formatClockTime('2026-03-08T07:01:00.000Z', 'en-US', 'America/New_York')).toBe('03:01 AM');
    expect(formatDayLabel('2026-10-03T12:00:00.000Z', 'en-US', 'UTC')).toContain('Oct');
  });

  it('renders RON honestly and never invents currency', () => {
    const ron = formatMoney(3500, 'RON', 'ro-RO');
    expect(ron).toContain('RON');
    expect(ron).toContain('3.500');
    expect(formatMoney(3500, null, 'ro-RO')).not.toContain('RON');
    expect(formatMoney(Number.NaN, 'RON', 'ro-RO')).toBe('');
  });

  it('handles missing timestamps without Invalid Date and validates language tags', () => {
    expect(formatClockTime('not-a-date')).toBe('');
    expect(formatClockTime('')).toBe('');
    expect(formatDayLabel(null as unknown as string)).toBe('');
    expect(parseAppLanguage('ro-RO')).toBe('ro');
    expect(parseAppLanguage('hu')).toBe('hu');
    expect(parseAppLanguage('en-US')).toBe('en');
    expect(parseAppLanguage('de')).toBeNull();
    expect(parseAppLanguage('')).toBeNull();
  });
});

const WS = 'ws_008c';
const USER = 'usr_008c';

const SEND_MODELS = [
  {
    command_key: 'mimo-25',
    display_name: 'MiMo V2.5',
    provider: 'opencode_go',
    available: true,
    is_current: true,
    is_default: true,
    native_audio_supported: false,
    voice_available: false,
  },
];

function chatRow(id: string, title: string): Chat {
  return {
    id,
    workspace_id: WS,
    title,
    author_user_id: USER,
    author_display_name: 'Avi',
    model_override: null,
    is_archived: false,
    activity_cursor: 1,
    created_at: '2026-10-03T12:00:00.000Z',
    updated_at: '2026-10-03T12:00:00.000Z',
    last_activity_at: '2026-10-03T12:00:00.000Z',
  };
}

function chatMessage(chatId: string, id: string, text: string): ChatMessage {
  return {
    id,
    workspace_id: WS,
    chat_id: chatId,
    author_user_id: USER,
    author_display_name: 'Avi',
    author_kind: 'member',
    channel: 'web',
    inbound_message_id: `in_${id}`,
    client_message_id: null,
    content_text: text,
    media_id: null,
    run_id: null,
    sequence: 1,
    created_at: '2026-10-03T12:00:00.000Z',
    updated_at: '2026-10-03T12:00:00.000Z',
  };
}

function routeMocks(chats: Chat[], messagesByChat: Record<string, ChatMessage[]>) {
  vi.spyOn(api, 'listChats').mockImplementation(async () => ({ chats }));
  vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
  vi.spyOn(api, 'models').mockResolvedValue({ models: [], current_command_key: null, default_command_key: null });
  vi.spyOn(api, 'getChat').mockImplementation(async (_ws, id) => {
    const chat = chats.find(item => item.id === id);
    if (!chat) throw new ApiError(404, 'not_found', 'Gone');
    return { chat, is_author: true };
  });
  vi.spyOn(api, 'listMessages').mockImplementation(async (_ws, id) => ({
    chat_id: id,
    messages: messagesByChat[id] ?? [],
    next_before_sequence: null,
  }));
  vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
  vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
  vi.spyOn(stream, 'subscribeToActivity').mockReturnValue({ close: vi.fn() });
}

describe('008C typed navigation and drawer', () => {
  it('restores a deep-linked chat on entry', async () => {
    routeMocks([chatRow('chat_A', 'Alpha')], { chat_A: [chatMessage('chat_A', 'm1', 'Alpha note')] });
    const view = await mountRoute(`/?workspace=${WS}&chat=chat_A`, {
      userId: USER,
      workspaces: [{ id: WS, name: 'Kerning' }],
      members: { [USER]: 'Avi' },
    });
    expect(view.host.textContent).toContain('Alpha note');
    expect(view.host.querySelector('.otis-topbar__title')?.textContent).toBe('Alpha');
    await view.unmount();
  });

  it('selects a chat once from the drawer and closes it', async () => {
    routeMocks([chatRow('chat_A', 'Alpha'), chatRow('chat_B', 'Beta')], {
      chat_A: [chatMessage('chat_A', 'm1', 'Alpha note')],
      chat_B: [chatMessage('chat_B', 'm2', 'Beta note')],
    });
    const view = await mountRoute(`/?workspace=${WS}&chat=chat_A`, {
      userId: USER,
      workspaces: [{ id: WS, name: 'Kerning' }],
      members: { [USER]: 'Avi' },
    });
    await React.act(async () => (view.host.querySelector('[aria-label="Open history"]') as HTMLElement).click());
    expect(document.querySelector('div[role="dialog"][data-state="open"]')).toBeTruthy();
    const beta = Array.from(document.querySelectorAll('.otis-nav__row')).find(row =>
      row.textContent?.includes('Beta'),
    ) as HTMLElement;
    expect(beta).toBeTruthy();
    await React.act(async () => beta.click());
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(location.search).toBe(`?workspace=${WS}&chat=chat_B`);
    expect(view.host.textContent).toContain('Beta note');
    expect(document.querySelector('div[role="dialog"][data-state="open"]')).toBeNull();
    await view.unmount();
  });

  it('closes the drawer on Back without navigating away', async () => {
    routeMocks([chatRow('chat_A', 'Alpha')], { chat_A: [chatMessage('chat_A', 'm1', 'Alpha note')] });
    const view = await mountRoute(`/?workspace=${WS}&chat=chat_A`, {
      userId: USER,
      workspaces: [{ id: WS, name: 'Kerning' }],
      members: { [USER]: 'Avi' },
    });
    await React.act(async () => (view.host.querySelector('[aria-label="Open history"]') as HTMLElement).click());
    expect(document.querySelector('div[role="dialog"][data-state="open"]')).toBeTruthy();
    const searchBefore = location.search;
    await React.act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(document.querySelector('div[role="dialog"][data-state="open"]')).toBeNull();
    expect(location.search).toBe(searchBefore);
    await view.unmount();
  });

  it('traps focus in the drawer and returns it to the trigger', async () => {
    routeMocks([chatRow('chat_A', 'Alpha')], { chat_A: [chatMessage('chat_A', 'm1', 'Alpha note')] });
    const view = await mountRoute(`/?workspace=${WS}&chat=chat_A`, {
      userId: USER,
      workspaces: [{ id: WS, name: 'Kerning' }],
      members: { [USER]: 'Avi' },
    });
    const trigger = view.host.querySelector('[aria-label="Open history"]') as HTMLElement;
    trigger.focus();
    await React.act(async () => trigger.click());
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close history');
    await React.act(async () => (document.querySelector('[aria-label="Close history"]') as HTMLElement).click());
    expect(document.querySelector('div[role="dialog"][data-state="open"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await view.unmount();
  });

  it('ignores a late previous-chat page after navigating away', async () => {
    const chats = [chatRow('chat_A', 'Alpha'), chatRow('chat_B', 'Beta')];
    vi.spyOn(api, 'listChats').mockImplementation(async () => ({ chats }));
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: [], current_command_key: null, default_command_key: null });
    vi.spyOn(api, 'getChat').mockImplementation(async (_ws, id) => ({ chat: chats.find(item => item.id === id)!, is_author: true }));
    let resolveA!: (value: { chat_id: string; messages: ChatMessage[]; next_before_sequence: null }) => void;
    vi.spyOn(api, 'listMessages').mockImplementation(async (_ws, id) => {
      if (id === 'chat_A') {
        // Held open: navigation happens while this read is in flight, then
        // the stale payload resolves outside act like a real late network.
        return new Promise(resolve => {
          resolveA = resolve as never;
        });
      }
      return { chat_id: id, messages: [chatMessage('chat_B', 'm2', 'Beta note')], next_before_sequence: null };
    });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(stream, 'subscribeToActivity').mockReturnValue({ close: vi.fn() });

    const view = await mountRoute(`/?workspace=${WS}&chat=chat_A`, {
      userId: USER,
      workspaces: [{ id: WS, name: 'Kerning' }],
      members: { [USER]: 'Avi' },
    });
    await React.act(async () => (view.host.querySelector('[aria-label="Open history"]') as HTMLElement).click());
    const beta = Array.from(document.querySelectorAll('.otis-nav__row')).find(row =>
      row.textContent?.includes('Beta'),
    ) as HTMLElement;
    await React.act(async () => beta.click());
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    resolveA({ chat_id: 'chat_A', messages: [chatMessage('chat_A', 'm1', 'Stale alpha')], next_before_sequence: null });
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(view.host.textContent).toContain('Beta note');
    expect(view.host.textContent).not.toContain('Stale alpha');
    await view.unmount();
  });

  it('shows an honest unavailable state with no cached private content', async () => {
    vi.spyOn(api, 'listChats').mockResolvedValue({ chats: [] });
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'models').mockResolvedValue({ models: [], current_command_key: null, default_command_key: null });
    vi.spyOn(api, 'getChat').mockRejectedValue(new ApiError(404, 'not_found', 'Gone'));
    vi.spyOn(api, 'listMessages').mockResolvedValue({ chat_id: 'gone', messages: [], next_before_sequence: null });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(stream, 'subscribeToActivity').mockReturnValue({ close: vi.fn() });
    const view = await mountRoute(`/?workspace=${WS}&chat=gone`, {
      userId: USER,
      workspaces: [{ id: WS, name: 'Kerning' }],
      members: { [USER]: 'Avi' },
    });
    await React.act(async () => {
      await Promise.resolve();
    });
    expect(view.host.textContent).toContain('Conversation unavailable');
    expect(view.host.querySelector('.otis-turn')).toBeNull();
    await view.unmount();
  });
});

describe('008C reviewer follow-ups: delayed ack and stale-route fencing', () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  function sendMocks() {
    const chats = [chatRow('chat_A', 'Alpha'), chatRow('chat_B', 'Beta')];
    vi.spyOn(api, 'listChats').mockImplementation(async () => ({ chats }));
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'models').mockResolvedValue({
      models: SEND_MODELS,
      current_command_key: 'mimo-25',
      default_command_key: 'mimo-25',
    });
    vi.spyOn(api, 'getChat').mockImplementation(async (_ws, id) => ({ chat: chats.find(item => item.id === id)!, is_author: true }));
    vi.spyOn(api, 'run').mockResolvedValue({
      run: { id: 'run_live', status: 'queued' } as never,
      status: 'queued',
      steps: [],
      actions: [],
      activities: [],
      pending_clarification: null,
    });
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(stream, 'subscribeToActivity').mockReturnValue({ close: vi.fn() });
  }

  async function sendFromComposer(view: { host: HTMLElement }, text: string) {
    const input = view.host.querySelector('textarea')!;
    await fill(input, text);
    const send = view.host.querySelector('[aria-label="Send"]') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await React.act(async () => send.click());
  }

  it('takes send-triggered follow at the local moment, never on delayed acceptance', async () => {
    sendMocks();
    vi.spyOn(api, 'listMessages').mockImplementation(async (_ws, id) => ({
      chat_id: id,
      messages: id === 'chat_A' ? [chatMessage('chat_A', 'm1', 'Alpha note')] : [],
      next_before_sequence: null,
    }));
    let resolvePost!: (value: { status: string; message_id: string; run_id: string; acceptance_sequence: number }) => void;
    vi.spyOn(api, 'sendMessage').mockImplementation(
      () =>
        new Promise(resolve => {
          resolvePost = resolve as never;
        }),
    );
    const view = await mountRoute(`/?workspace=${WS}&chat=chat_A`, {
      userId: USER,
      workspaces: [{ id: WS, name: 'Kerning' }],
      members: { [USER]: 'Avi' },
    });
    const scroller = view.host.querySelector('.otis-transcript') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { value: 11264, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 800, configurable: true });
    const jump = () => view.host.querySelector('[aria-label="Jump to latest messages"]') as HTMLElement | null;

    await sendFromComposer(view, 'Hello while held');
    expect(view.host.textContent).toContain('Hello while held');

    // The reader scrolls up to re-read while the POST is still held: two
    // descending scroll positions establish the upward baseline, then the
    // released state, without depending on real layout.
    await React.act(async () => {
      scroller.scrollTop = 10463;
      scroller.dispatchEvent(new Event('scroll'));
      scroller.scrollTop = 200;
      scroller.dispatchEvent(new Event('scroll'));
      await tick();
    });
    await React.act(async () => {
      await tick();
    });
    expect(jump()).toBeTruthy();

    // Delayed HTTP 202 acceptance must not drag the released reader back.
    resolvePost({ status: 'accepted', message_id: 'msg_held', run_id: 'run_live', acceptance_sequence: 2 });
    await React.act(async () => {
      await tick();
    });
    await React.act(async () => {
      await tick();
    });
    expect(view.host.textContent).toContain('Hello while held');
    expect(jump()).toBeTruthy();
    await view.unmount();
  });

  it('ignores a stale old-route auth failure after an external route move', async () => {
    sendMocks();
    vi.spyOn(api, 'listMessages').mockImplementation(async (_ws, id) => ({
      chat_id: id,
      messages: [chatMessage(id, `m-${id}`, id === 'chat_A' ? 'Alpha note' : 'Beta note')],
      next_before_sequence: null,
    }));
    let rejectA!: (err: unknown) => void;
    vi.spyOn(api, 'sendMessage').mockImplementation(async (_ws, chatId) => {
      if (chatId === 'chat_A') {
        await new Promise<void>((_resolve, reject) => {
          rejectA = reject;
        });
      }
      return { status: 'accepted', message_id: 'msg_b', run_id: 'run_live', acceptance_sequence: 1 };
    });
    const view = await mountRoute(`/?workspace=${WS}&chat=chat_B`, {
      userId: USER,
      workspaces: [{ id: WS, name: 'Kerning' }],
      members: { [USER]: 'Avi' },
    });
    expect(view.host.textContent).toContain('Beta note');

    // Move to A through the drawer, send with the POST held, then take a
    // real browser Back to B: epoch is untouched, only the route target moves.
    await React.act(async () => (view.host.querySelector('[aria-label="Open history"]') as HTMLElement).click());
    const alpha = Array.from(document.querySelectorAll('.otis-nav__row')).find(row =>
      row.textContent?.includes('Alpha'),
    ) as HTMLElement;
    await React.act(async () => alpha.click());
    await React.act(async () => {
      await tick();
    });
    expect(location.search).toBe(`?workspace=${WS}&chat=chat_A`);
    await sendFromComposer(view, 'Note for alpha');
    expect(view.host.textContent).toContain('Note for alpha');

    await React.act(async () => {
      window.history.back();
      await tick();
    });
    await React.act(async () => {
      const deadline = Date.now() + 3000;
      while ((view.router.state.location.search as { chat?: string }).chat !== 'chat_B') {
        if (Date.now() > deadline) throw new Error('back navigation did not commit');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await tick();
    });
    expect(location.search).toBe(`?workspace=${WS}&chat=chat_B`);
    expect(view.host.textContent).toContain('Beta note');

    // The stale chat-A POST now fails with 403: the current chat must not
    // be closed or cleared because of the old route's response.
    rejectA(new ApiError(403, 'forbidden', 'Revoked elsewhere'));
    await React.act(async () => {
      await tick();
    });
    await React.act(async () => {
      await tick();
    });
    expect(view.host.textContent).toContain('Beta note');
    expect(view.host.textContent).not.toContain('Conversation unavailable');
    expect(view.host.querySelector('.otis-turn')).toBeTruthy();
    await view.unmount();
  });
});
