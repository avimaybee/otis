/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { axe } from 'vitest-axe';
import * as matchers from 'vitest-axe/matchers';
import { EntityFilePane } from '../src/components/EntityFile.js';
import { FileGallery } from '../src/components/FileGallery.js';
import { FollowUps } from '../src/components/FollowUps.js';
import { WorkspaceHistorySearch } from '../src/components/WorkspaceHistorySearch.js';
import { WorkspaceSource } from '../src/components/WorkspaceSource.js';
import { api, ApiError } from '../src/api/client.js';
import {
  businessFile,
  fileEntry,
  followUpPage,
  historyMatches,
} from './fixtures/businessFixtures.js';
import { TestQueryProvider } from './query.js';

expect.extend(matchers);
// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const disposers: (() => Promise<void>)[] = [];
const rules = { rules: { 'color-contrast': { enabled: false } } };
const props = { workspaceId: 'ws-1', userId: 'user-avi', entityId: 'client-1' };
const settle = async () =>
  React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
async function mount(element: React.ReactElement) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await React.act(async () => root.render(<TestQueryProvider>{element}</TestQueryProvider>));
  await settle();
  const dispose = async () => {
    await React.act(async () => root.unmount());
    host.remove();
  };
  disposers.push(dispose);
  return { host, dispose };
}
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((item) => item.textContent === text);
  expect(found, text).toBeTruthy();
  return found!;
}
async function click(text: string) {
  await React.act(async () => button(text).click());
  await settle();
}
async function input(selector: string, value: string) {
  const control = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  expect(control).toBeTruthy();
  const prototype =
    control.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.spyOn(api, 'entityFile').mockResolvedValue(businessFile());
  vi.spyOn(api, 'workspaceSource').mockResolvedValue({
    id: 'message-original',
    chat_id: 'chat-1',
    author_name: 'Hunor',
    author_user_id: 'user-hunor',
    text: 'Original member wording.',
    recorded_at: '2026-10-01T08:00:00Z',
    channel: 'web',
    sequence: 1,
    context: [],
  });
});
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('business capability controls', () => {
  it('restores original audio wording as a sourced edit, with Review and Undo available', async () => {
    const edit = vi.spyOn(api, 'entityAction').mockResolvedValue({ status: 'applied', action_id: 'restore-transcript' });
    await mount(<EntityFilePane {...props} initialFile={businessFile()} initialSection="attachments" />);
    await click('Restore original transcript');
    expect(edit.mock.calls[0]![2]).toMatchObject({
      command: 'update_attachment',
      args: { expected_revision: 1, restore_original_transcript: true },
    });
    expect(document.body.textContent).toContain('Review / Undo');
  });
  it('discloses bounded coverage and distinguishes original and correction sources', async () => {
    const view = await mount(
      <EntityFilePane {...props} initialFile={businessFile()} initialSection="notes" />,
    );
    expect(view.host.textContent).toContain('1 of 31 notes');
    expect(view.host.textContent).toContain('Reported by Hunor');
    expect(view.host.textContent).toContain('Corrected by Avi');
    expect(await axe(view.host, rules)).toHaveNoViolations();
    await click('Original source');
    expect(api.workspaceSource).toHaveBeenCalledWith(
      'ws-1',
      'message-original',
      expect.any(AbortSignal),
    );
    expect(document.body.textContent).toContain('Original member wording.');
  });
  it('saves only the selected entry and reuses the immutable operation after a network failure', async () => {
    const action = vi
      .spyOn(api, 'entityAction')
      .mockRejectedValueOnce(new TypeError('Network interrupted'))
      .mockResolvedValue({ status: 'applied', action_id: 'saved-1', summary: 'Entry corrected.' });
    await mount(<EntityFilePane {...props} initialFile={businessFile()} initialSection="notes" />);
    await click('Edit entry');
    await input('#entry-text', 'Corrected manually');
    expect(await axe(document.querySelector('[role="dialog"]')!, rules)).toHaveNoViolations();
    await click('Save');
    expect((document.querySelector('#entry-text') as HTMLTextAreaElement).value).toBe(
      'Corrected manually',
    );
    await click('Save');
    expect(action).toHaveBeenCalledTimes(2);
    expect(action.mock.calls[0]![2]).toEqual(action.mock.calls[1]![2]);
    expect(action.mock.calls[1]![2]).toMatchObject({
      command: 'revise_interaction',
      expected_revision: 12,
      args: {
        interaction_id: 'interaction-note',
        expected_head_event_id: 'event-correction',
        payload: { text: 'Corrected manually' },
      },
    });
    expect(document.body.textContent).toContain('Review / Undo');
    expect(document.querySelector('#entry-text')).toBeNull();
  });
  it('preserves a conflicting edit and explicitly rebases it onto the reviewed saved head', async () => {
    const latest = {
        ...fileEntry,
        head_event_id: 'new-head',
        payload: { text: 'Teammate update' },
      },
      refreshed = { ...businessFile(), as_of_business_revision: 13 };
    vi.mocked(api.entityFile).mockImplementation(async (_w, _e, options) =>
      options.section
        ? {
            version: 1,
            entity_id: 'client-1',
            as_of_business_revision: 13,
            section: 'timeline',
            page: {
              items: [latest],
              total: 1,
              availability: 'available',
              has_more: false,
              next_cursor: null,
            },
          }
        : refreshed,
    );
    const action = vi
      .spyOn(api, 'entityAction')
      .mockRejectedValueOnce(new ApiError(409, 'revision_conflict', 'This file changed.'))
      .mockResolvedValue({ status: 'applied', action_id: 'saved-2' });
    await mount(<EntityFilePane {...props} initialFile={businessFile()} initialSection="notes" />);
    await click('Edit entry');
    await input('#entry-text', 'My proposed correction');
    await click('Save');
    expect((document.querySelector('#entry-text') as HTMLTextAreaElement).value).toBe(
      'My proposed correction',
    );
    expect(button('Save').disabled).toBe(true);
    await click('Compare saved entry');
    expect(document.body.textContent).toContain('Saved: Teammate update');
    await click('Apply my correction to this version');
    await click('Save');
    expect(action.mock.calls[1]![2]).toMatchObject({
      expected_revision: 13,
      args: { expected_head_event_id: 'new-head', payload: { text: 'My proposed correction' } },
    });
    expect(action.mock.calls[1]![2].operation_id).not.toBe(action.mock.calls[0]![2].operation_id);
  });
  it('resets filter labels and bookmarks when a file revision refreshes', async () => {
    const view = await mount(
      <EntityFilePane {...props} initialFile={businessFile()} initialSection="notes" />,
    );
    vi.mocked(api.entityFile).mockImplementation(async (_w, _e, options) =>
      options.section
        ? {
            version: 1,
            entity_id: 'client-1',
            as_of_business_revision: 12,
            section: 'notes',
            page: {
              items: [],
              total: 0,
              availability: 'available',
              has_more: false,
              next_cursor: null,
            },
          }
        : { ...businessFile(), as_of_business_revision: 13 },
    );
    await input('#file-from', '2026-10-01');
    await click('Apply filters');
    expect(view.host.textContent).toContain('0 of 0 notes');
    await click('Refresh');
    expect((document.querySelector('#file-from') as HTMLInputElement).value).toBe('');
    expect(view.host.textContent).toContain('1 of 31 notes');
  });
  it('pauses the selected follow-up with stable retries, source attribution and saved Undo', async () => {
    vi.spyOn(api, 'followUps').mockResolvedValue(followUpPage());
    const action = vi
      .spyOn(api, 'followUpAction')
      .mockRejectedValueOnce(new TypeError('Offline'))
      .mockResolvedValue({ status: 'applied', action_id: 'rule-edit', summary: 'Paused.' });
    await mount(
      <FollowUps
        workspaceId="ws-1"
        userId="user-avi"
        open
        onClose={() => {}}
        initialPage={followUpPage()}
      />,
    );
    expect(document.body.textContent).toContain('Monday, Wednesday');
    expect(await axe(document.querySelector('[role="dialog"]')!, rules)).toHaveNoViolations();
    await click('Pause');
    await click('Pause');
    expect(action.mock.calls[1]![1]).toEqual(action.mock.calls[0]![1]);
    expect(action.mock.calls[1]![1]).toMatchObject({
      args: { rule_id: 'rule-1', expected_revision: 1, status: 'paused' },
      expected_revision: 12,
    });
    expect(document.body.textContent).toContain('Review / Undo');
  });
  it('pages the submitted search after the search draft changes and distinguishes Otis evidence', async () => {
    const first = historyMatches(),
      second = {
        ...first,
        items: [
          {
            ...first.items[0]!,
            message_id: 'reply-1',
            source_kind: 'otis' as const,
            excerpt: 'Otis summary',
          },
        ],
        has_more: false,
        next_cursor: null,
      };
    const search = vi
      .spyOn(api, 'searchWorkspaceHistory')
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    await mount(
      <WorkspaceHistorySearch workspaceId="ws-1" open onClose={() => {}} onOpenChat={() => {}} />,
    );
    await input('#history-words', 'copper');
    await click('Search');
    await input('#history-words', '');
    await click('Load more matches');
    expect(search.mock.calls[1]![1]).toMatchObject({ query: 'copper', cursor: 'fixture-next' });
    expect(document.body.textContent).toContain('2 of 2 matches');
    expect(document.body.textContent).toContain('check the member’s original wording');
    expect(await axe(document.querySelector('[role="dialog"]')!, rules)).toHaveNoViolations();
  });
  it('aborts a private-source read when the source panel closes', async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(api.workspaceSource).mockImplementation(async (_w, _id, requestSignal) => {
      signal = requestSignal;
      return new Promise(() => {});
    });
    const view = await mount(
      <WorkspaceSource workspaceId="ws-1" sourceId="message-original" onClose={() => {}} />,
    );
    expect(signal?.aborted).toBe(false);
    await view.dispose();
    disposers.pop();
    expect(signal?.aborted).toBe(true);
  });
  it('downloads only the selected original and releases private object URLs on navigation and close', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(
        async () => new Response(new Blob(['synthetic image'], { type: 'image/png' })),
      );
    vi.stubGlobal('fetch', fetch);
    const create = vi
        .spyOn(URL, 'createObjectURL')
        .mockReturnValueOnce('blob:first')
        .mockReturnValueOnce('blob:second'),
      revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    function Gallery() {
      const [selected, setSelected] = React.useState<number | null>(0);
      return (
        <FileGallery
          workspaceId="ws-1"
          userId="user-avi"
          files={[
            { media_id: 'one', format: 'image/png' },
            { media_id: 'two', format: 'image/png' },
          ]}
          selected={selected}
          onSelect={setSelected}
          onClose={() => setSelected(null)}
        />
      );
    }
    const view = await mount(<Gallery />);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('/api/workspaces/ws-1/media/one');
    expect(fetch.mock.calls[0]![1].headers['x-expected-user-id']).toBe('user-avi');
    await click('Next');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith('blob:first');
    expect(create).toHaveBeenCalledTimes(2);
    await view.dispose();
    disposers.pop();
    expect(revoke).toHaveBeenCalledWith('blob:second');
  });
  it('supports focused-button arrows and bounded image swipes without treating scroll or pinch as navigation', async () => {
    const fetch = vi.fn(async () => new Response(new Blob(['image'], { type: 'image/png' })));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:gallery');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    function Gallery() {
      const [selected, setSelected] = React.useState<number | null>(0);
      return <FileGallery {...props} files={[
        { media_id: 'one', format: 'image/png' },
        { media_id: 'two', format: 'image/png' },
        { media_id: 'three', format: 'image/png' },
      ]} selected={selected} onSelect={setSelected} onClose={() => setSelected(null)} />;
    }
    await mount(<Gallery />);
    await React.act(async () => button('Next').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    ));
    await settle();
    expect(document.body.textContent).toContain('2 of 3');
    await React.act(async () => button('Previous').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    ));
    await settle();
    expect(document.body.textContent).toContain('1 of 3');
    async function swipe(x: number, y = 0, fingers = 1) {
      const image = document.querySelector('img')!;
      const start = new Event('touchstart', { bubbles: true });
      Object.defineProperty(start, 'touches', { value: Array.from({ length: fingers }, () => ({ clientX: 150, clientY: 100 })) });
      const end = new Event('touchend', { bubbles: true });
      Object.defineProperties(end, {
        touches: { value: [] },
        changedTouches: { value: [{ clientX: 150 + x, clientY: 100 + y }] },
      });
      await React.act(async () => { image.dispatchEvent(start); image.dispatchEvent(end); });
      await settle();
    }
    await swipe(100);
    await swipe(-10);
    await swipe(-100, 120);
    await swipe(-100, 0, 2);
    expect(document.body.textContent).toContain('1 of 3');
    expect(fetch).toHaveBeenCalledTimes(3);
    await swipe(-100, 3);
    expect(document.body.textContent).toContain('2 of 3');
    await swipe(-100);
    expect(document.body.textContent).toContain('3 of 3');
    await swipe(-100);
    expect(document.body.textContent).toContain('3 of 3');
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it('never paints another selection or account’s bytes while a replacement original is loading', async () => {
    let finishSecond: ((response: Response) => void) | undefined;
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new Blob(['first'], { type: 'image/png' })))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishSecond = resolve; }))
      .mockResolvedValueOnce(new Response(new Blob(['new account'], { type: 'image/png' })));
    vi.stubGlobal('fetch', fetch);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:new-account');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const painted: { selected: number | null; userId: string; url: string | null }[] = [];
    function Gallery() {
      const [selected, setSelected] = React.useState<number | null>(0);
      const [userId, setUserId] = React.useState('user-avi');
      React.useLayoutEffect(() => {
        painted.push({ selected, userId, url: document.querySelector('img')?.getAttribute('src') ?? null });
      }, [selected, userId]);
      return <>
        <button onClick={() => setUserId('user-hunor')}>Switch account</button>
        <FileGallery workspaceId="ws-1" userId={userId} files={[
          { media_id: 'one', format: 'image/png', filename: 'First' },
          { media_id: 'two', format: 'image/png', filename: 'Second' },
        ]} selected={selected} onSelect={setSelected} onClose={() => setSelected(null)} />
      </>;
    }
    await mount(<Gallery />);
    expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:first');
    await click('Next');
    expect(painted.find((frame) => frame.selected === 1)?.url).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('Opening file');
    expect(revoke).toHaveBeenCalledWith('blob:first');
    await click('Switch account');
    expect(painted.find((frame) => frame.userId === 'user-hunor')?.url).toBeNull();
    expect(fetch.mock.calls[2]![1].headers['x-expected-user-id']).toBe('user-hunor');
    await React.act(async () => finishSecond!(new Response(new Blob(['late response']))));
    await settle();
    expect(create).toHaveBeenCalledTimes(2);
    expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:new-account');
  });
});
