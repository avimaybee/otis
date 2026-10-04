/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from '../src/api/client.js';
import {
  acquireFlushClaim,
  classifySendError,
  computeBackoffMs,
  FLUSH_BACKOFF_CAP_MS,
  readFlushClaim,
  registerFlushOwner,
  releaseFlushClaim,
  renewFlushClaim,
  requestFlush,
  resetFlushForTests,
  selectDueEntries,
  unregisterFlushOwner,
  withFlushLock,
} from '../src/api/flush.js';
import {
  claimDelivery,
  clearUserOutbox,
  createOutboxEntry,
  deferOutboxRetry,
  discardUnsentEntry,
  entriesForChat,
  entriesForUser,
  getNewChatMapping,
  getOutboxEntry,
  markOutboxFailed,
  markOutboxSaved,
  rehydrateOutbox,
  releaseDelivery,
  resetOutboxForTests,
  retryOutboxEntry,
} from '../src/api/outbox.js';
import { parseRetryAfterMs } from '../src/api/client.js';
import { PWA_API_DENYLIST, PWA_MANIFEST, PWA_STATIC_GLOBS, PWA_WORKBOX } from '../src/pwa.js';
import { UnavailableScreen } from '../src/components/UnavailableScreen.js';
import { UpdatePrompt } from '../src/components/UpdatePrompt.js';
import { api } from '../src/api/client.js';
import * as stream from '../src/hooks/useActivityStream.js';
import { Toaster } from 'sonner';
import { Composer } from '../src/components/Composer.js';
import { mountRoute } from './route.js';
import type { Chat, ChatMessage } from '@otis/contracts';

vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string) => store.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    update: vi.fn(async (key: string, updater: (old: unknown) => unknown) => {
      store.set(key, updater(store.get(key)));
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    __store: store,
  };
});

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: vi.fn(() => ({
    needRefresh: [false, vi.fn()],
    offlineReady: [false, vi.fn()],
    updateServiceWorker: vi.fn(),
  })),
}));

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const WS = 'ws_008d';
const USER = 'usr_008d';
const UPD = 'usr_008d_upd';

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

beforeEach(async () => {
  resetOutboxForTests();
  resetFlushForTests();
  sessionStorage.clear();
  vi.clearAllMocks();
  history.replaceState({}, '', '/');
  // The mocked IndexedDB store outlives module memory resets: clear it so
  // reload simulations start from exactly what their test persisted.
  const idb = (await import('idb-keyval')) as unknown as { __store: Map<string, unknown> };
  idb.__store.clear();
});

afterEach(() => {
  resetOutboxForTests();
  resetFlushForTests();
  sessionStorage.clear();
  vi.restoreAllMocks();
  history.replaceState({}, '', '/');
});

describe('008D error classification and backoff', () => {
  it('retries transport and rate failures, never auth/validation ones', () => {
    expect(classifySendError(new TypeError('offline'))).toBe('transient');
    expect(classifySendError(new Error('boom'))).toBe('transient');
    for (const status of [408, 425, 429, 500, 502, 503]) {
      expect(classifySendError(new ApiError(status, 'x', 'y'))).toBe('transient');
    }
    // Permanent: validation, auth, conflicts, obsolete clarifications stay
    // failed with their attached recovery action and never reroute.
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(classifySendError(new ApiError(status, 'x', 'y'))).toBe('permanent');
    }
  });

  it('parses Retry-After delay seconds and HTTP dates', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('not-a-date')).toBeUndefined();
    const future = new Date(Date.now() + 60_000).toUTCString();
    const parsed = parseRetryAfterMs(future)!;
    expect(parsed).toBeGreaterThan(30_000);
    expect(parsed).toBeLessThanOrEqual(60_000);
  });

  it('backs off exponentially, honors Retry-After, and caps', () => {
    expect(computeBackoffMs(0)).toBe(2000);
    expect(computeBackoffMs(1)).toBe(4000);
    expect(computeBackoffMs(2)).toBe(8000);
    expect(computeBackoffMs(100)).toBe(FLUSH_BACKOFF_CAP_MS);
    expect(computeBackoffMs(3, 50)).toBe(50);
    // A valid server instant is authoritative: the exponential cap must
    // never shorten a 600-second rate limit. Only absurd values hit the
    // documented 24h parsing bound.
    expect(computeBackoffMs(1, 600_000)).toBe(600_000);
    expect(computeBackoffMs(1, 999_999_999_999)).toBe(24 * 60 * 60_000);
  });
});

describe('008D due selection and deferral metadata', () => {
  it('attempts the first unresolved entry per chat and lets resolved rows skip', () => {
    const first = createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat_b', text: 'b-first' });
    const second = createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat_a', text: 'a-first' });
    createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat_a', text: 'a-second' });
    markOutboxSaved(first.clientId, { messageId: 'm', runId: 'r', sequence: 1 });
    // Each chat offers its first unresolved entry: the newer same-chat
    // input waits behind the in-flight one instead of overtaking it.
    expect(selectDueEntries(entriesForUser(USER), Date.now(), 8).map(entry => entry.clientId)).toEqual([second.clientId]);
  });

  it('holds newer inputs behind a deferred retry and resumes in order', () => {
    const first = createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat_a', text: 'a-first' });
    createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat_a', text: 'a-second' });
    markOutboxFailed(first.clientId, { code: 'transport', message: 'down' });
    deferOutboxRetry(first.clientId, new Date(Date.now() + 60_000).toISOString());
    // The deferred first entry blocks its chat; nothing there is attemptable.
    expect(selectDueEntries(entriesForUser(USER), Date.now(), 8)).toEqual([]);
    // Permanent failures resolve explicitly and never block their chat.
    const permanent = createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat_p', text: 'p-first' });
    const follower = createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat_p', text: 'p-second' });
    markOutboxFailed(permanent.clientId, { code: 'validation_error', message: 'bad' });
    expect(selectDueEntries(entriesForUser(USER), Date.now(), 8).map(entry => entry.clientId)).toEqual([follower.clientId]);
  });

  it('skips exhausted entries without blocking on them forever', () => {
    const old = createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'old' });
    for (let index = 0; index < 8; index += 1) markOutboxFailed(old.clientId, { code: 't', message: 'm' });
    expect(selectDueEntries(entriesForUser(USER), Date.now(), 8)).toEqual([]);
  });

  it('manual retry clears the scheduled automatic retry', () => {
    const entry = createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'hi' });
    deferOutboxRetry(entry.clientId, new Date(Date.now() + 60_000).toISOString());
    expect(getOutboxEntry(entry.clientId)?.nextRetryAt).toBeDefined();
    const retried = retryOutboxEntry(entry.clientId)!;
    expect(retried.nextRetryAt).toBeUndefined();
    expect(retried.state).toBe('sending');
  });

  it('discard removes unsent entries locally but never accepted ones', () => {
    const failed = createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'bad' });
    markOutboxFailed(failed.clientId, { code: 'transport', message: 'down' });
    expect(discardUnsentEntry(failed.clientId)).toBe(true);
    expect(entriesForChat(USER, WS, 'chat')).toHaveLength(0);
    const saved = createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'kept' });
    markOutboxSaved(saved.clientId, { messageId: 'm', runId: 'r', sequence: 1 });
    expect(discardUnsentEntry(saved.clientId)).toBe(false);
    expect(discardUnsentEntry('missing')).toBe(false);
  });

  it('purges one account drafts without touching another', async () => {
    const { saveDraft, loadDraft, deleteDraftsForUser } = await import('../src/api/drafts.js');
    await saveDraft(`otis:draft:${USER}:ws:chat`, 'avi draft');
    await saveDraft('otis:draft:hunor:ws:chat', 'hunor draft');
    await deleteDraftsForUser(USER);
    expect(await loadDraft(`otis:draft:${USER}:ws:chat`)).toBeNull();
    expect(await loadDraft('otis:draft:hunor:ws:chat')).toBe('hunor draft');
  });

  it('flushes a trailing debounced draft write on unmount', async () => {
    const { loadDraft } = await import('../src/api/drafts.js');
    const view = await mount(
      <Composer running={false} commands={[]} draftKey={`otis:draft:${USER}:ws:chat`} onSend={async () => true} />,
    );
    const input = view.host.querySelector('textarea') as HTMLTextAreaElement;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'last word');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Unmount well inside the debounce window: the trailing write still lands.
    await view.unmount();
    expect(await loadDraft(`otis:draft:${USER}:ws:chat`)).toBe('last word');
  });

  it('recovers a persisted draft after reload until its account is purged', async () => {    const { saveDraft, loadDraft, deleteDraftsForUser, moveDraft } = await import('../src/api/drafts.js');
    await saveDraft(`otis:draft:${USER}:ws:chat`, 'half-typed offer');
    const view = await mount(
      <Composer running={false} commands={[]} draftKey={`otis:draft:${USER}:ws:chat`} onSend={async () => true} />,
    );
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect((view.host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('half-typed offer');
    await view.unmount();
    // New-chat binding carries a newer pending draft; the sent text itself
    // is consumed rather than duplicated.
    await saveDraft(`otis:draft:${USER}:ws:new`, 'newer pending note');
    await moveDraft(`otis:draft:${USER}:ws:new`, `otis:draft:${USER}:ws:chat`, 'sent text');
    expect(await loadDraft(`otis:draft:${USER}:ws:chat`)).toBe('newer pending note');
    expect(await loadDraft(`otis:draft:${USER}:ws:new`)).toBeNull();
    await deleteDraftsForUser(USER);
    const again = await mount(
      <Composer running={false} commands={[]} draftKey={`otis:draft:${USER}:ws:chat`} onSend={async () => true} />,
    );
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect((again.host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    await again.unmount();
  });

  it('a delayed draft write cannot resurrect content purged mid-flight', async () => {
    const { saveDraft, loadDraft, deleteDraftsForUser } = await import('../src/api/drafts.js');
    const idb = (await import('idb-keyval')) as unknown as {
      update: {
        getMockImplementation: () => ((...args: Array<never>) => Promise<unknown>) | undefined;
        mockImplementationOnce: (impl: (...args: Array<never>) => Promise<unknown>) => void;
      };
      __store: Map<string, unknown>;
    };
    // Pause the save inside its storage round-trip, purge meanwhile, then
    // let it continue: the generation fence must drop the write instead of
    // resurrecting the purged draft.
    let releaseUpdate!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseUpdate = resolve;
    });
    const baseUpdate = idb.update.getMockImplementation()!;
    idb.update.mockImplementationOnce(async (...args: Array<never>) => {
      await gate;
      return baseUpdate(...args);
    });
    const saving = saveDraft(`otis:draft:${USER}:ws:chat`, 'Private draft');
    await new Promise(resolve => setTimeout(resolve, 0));
    await deleteDraftsForUser(USER);
    releaseUpdate();
    await saving;
    expect(await loadDraft(`otis:draft:${USER}:ws:chat`)).toBeNull();
    // The purge keeps a cleared record carrying the bumped generation (never
    // a delete, so the generation survives for other tabs to observe).
    const stored = idb.__store.get(`otis/drafts/v1/${USER}`) as
      | { generation: number; drafts: Record<string, unknown> }
      | undefined;
    expect(stored?.drafts).toEqual({});
    expect(typeof stored?.generation).toBe('number');
  });

  it('binds writes to the originating session, not the call-time generation', async () => {
    const { saveDraft, loadDraft, deleteDraftsForUser, draftSession } = await import('../src/api/drafts.js');
    const key = `otis:draft:${USER}:ws:chat`;
    const stale = draftSession(key);
    expect(stale).not.toBeNull();
    await deleteDraftsForUser(USER);
    // A write replaying the pre-logout session is dropped even though it is
    // issued after the purge: authorization travels with the originator.
    await saveDraft(key, 'Private draft', stale!);
    expect(await loadDraft(key)).toBeNull();
    // A write under the current session proceeds normally.
    await saveDraft(key, 'Fresh draft');
    expect(await loadDraft(key)).toBe('Fresh draft');
  });

  it('a logout with pending keystrokes cannot resurrect input on unmount', async () => {
    const { loadDraft, deleteDraftsForUser } = await import('../src/api/drafts.js');
    const view = await mount(
      <Composer running={false} commands={[]} draftKey={`otis:draft:${USER}:ws:chat`} onSend={async () => true} />,
    );
    const input = view.host.querySelector('textarea') as HTMLTextAreaElement;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'typed pre-logout');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Logout lands while the debounced save is still pending; the unmount
    // trailing flush replays the keystroke-time session and is dropped.
    await deleteDraftsForUser(USER);
    await view.unmount();
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
    });
    expect(await loadDraft(`otis:draft:${USER}:ws:chat`)).toBeNull();
  });

  it('a persisted owner generation fences other-tab draft writes unknown at purge', async () => {
    // Two live module instances sharing the mocked store stand in for two
    // tabs: only the persisted generation — checked atomically inside every
    // storage transaction — can fence the other tab, never a local Map.
    const draftsA = await import('../src/api/drafts.js?tab=draft-a');
    const draftsB = await import('../src/api/drafts.js?tab=draft-b');
    expect(draftsA.saveDraft === draftsB.saveDraft).toBe(false);
    const key = `otis:draft:${USER}:ws:chat`;
    const otherKey = 'otis:draft:hunor:ws:chat';
    // Tab A holds private input; tab B reads it once and thereby observes
    // the pre-logout session (without ever persisting this key itself).
    await draftsA.saveDraft(key, 'private-a');
    await draftsB.saveDraft(otherKey, 'hunor draft');
    expect(await draftsB.loadDraft(key)).toBe('private-a');
    const stale = draftsB.draftSession(key);
    expect(stale).not.toBeNull();
    // Tab A logs out: the purge bumps the persisted generation and clears.
    await draftsA.deleteDraftsForUser(USER);
    expect(await draftsA.loadDraft(key)).toBeNull();
    // Tab B replays its pre-logout session after the purge: fenced and
    // dropped, even though its entry never existed at purge time.
    await draftsB.saveDraft(key, 'stale tab write', stale!);
    expect(await draftsB.loadDraft(key)).toBeNull();
    // The other owner is intact, and explicit reactivation (fresh session
    // after adopting the generation) writes again; a fresh instance — the
    // reload/navigation path — reads it back.
    expect(await draftsB.loadDraft(otherKey)).toBe('hunor draft');
    await draftsB.saveDraft(key, 'fresh post-login input');
    expect(await draftsB.loadDraft(key)).toBe('fresh post-login input');
    const reloaded = await import('../src/api/drafts.js?tab=draft-reload');
    expect(await reloaded.loadDraft(key)).toBe('fresh post-login input');
    expect(await reloaded.loadDraft(otherKey)).toBe('hunor draft');
  });

  it('restores the draft on composer remount and first mount after logout and reactivation', async () => {
    const drafts = await import('../src/api/drafts.js');
    const seeder = await import('../src/api/drafts.js?tab=draft-seed');
    expect(seeder.saveDraft === drafts.saveDraft).toBe(false);
    const composerProps = (draftKey: string) => ({
      running: false,
      commands: [] as never[],
      draftKey,
      onSend: async () => true,
    });
    const readInput = (view: { host: HTMLElement }) =>
      (view.host.querySelector('textarea') as HTMLTextAreaElement).value;
    // At least one logout happened for this owner before reactivation writes
    // under the new session; remounts keep restoring it.
    await drafts.deleteDraftsForUser(USER);
    await drafts.saveDraft(`otis:draft:${USER}:ws:chat`, 'post-login draft');
    const view = await mount(<Composer {...composerProps(`otis:draft:${USER}:ws:chat`)} />);
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(readInput(view)).toBe('post-login draft');
    await view.unmount();
    const again = await mount(<Composer {...composerProps(`otis:draft:${USER}:ws:chat`)} />);
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(readInput(again)).toBe('post-login draft');
    await again.unmount();
    // A reload is a fresh module instance that never observed the owner: the
    // first hydration adopts the persisted generation and restores instead
    // of rejecting valid input as stale.
    const FRESH = 'usr_008d_fresh';
    const freshKey = `otis:draft:${FRESH}:ws:chat`;
    await seeder.deleteDraftsForUser(FRESH);
    await seeder.saveDraft(freshKey, 'fresh reload draft');
    const regressed = await import('../src/api/drafts.js?tab=draft-regress');
    expect(regressed.draftSession(freshKey)).toBeNull();
    const loaded = await regressed.loadDraft(freshKey);
    expect(loaded).toBe('fresh reload draft');
    expect(regressed.draftSession(freshKey)).not.toBeNull();
    const reloaded = await mount(<Composer {...composerProps(freshKey)} />);
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(readInput(reloaded)).toBe('fresh reload draft');
    await reloaded.unmount();
  });
});

describe('008D cross-tab flush claims', () => {
  // happy-dom ships navigator.locks as null, so the IndexedDB fallback is
  // the live path here; the Web Locks path is exercised with a mock.
  // The mock installs an own property that must be deleted afterwards:
  // there is no own descriptor to restore to.
  let locksStubbed = false;

  afterEach(() => {
    if (locksStubbed) {
      delete (window.navigator as unknown as Record<string, unknown>)['locks'];
      locksStubbed = false;
    }
  });

  function mockLocks(deny: boolean) {
    Object.defineProperty(window.navigator, 'locks', {
      configurable: true,
      value: {
        request: vi.fn(async (_name: string, _opts: unknown, callback: (lock: object | null) => Promise<string>) =>
          deny ? callback(null) : callback({}),
        ),
      },
    });
    locksStubbed = true;
  }

  it('runs under Web Locks and skips when another tab holds the claim', async () => {
    mockLocks(false);
    const work = vi.fn(async () => {});
    expect(await withFlushLock(USER, work)).toBe('ran');
    expect(work).toHaveBeenCalledTimes(1);
    // A racing tab whose claim is denied never runs its work: no storm.
    mockLocks(true);
    const racing = [withFlushLock(USER, work), withFlushLock(USER, work)];
    expect(await Promise.all(racing)).toEqual(['skipped', 'skipped']);
    expect(work).toHaveBeenCalledTimes(1);
  });
});

describe('008D atomic flush claims across tabs', () => {
  // fake-indexeddb provides real IndexedDB transaction semantics that
  // happy-dom lacks, so the two-tab race below exercises the actual
  // store-level serialization — not a mock of it. Each test uses its own
  // user scope since the fake backing store is shared per file.
  const TAB_A = 'tab-a';
  const TAB_B = 'tab-b';

  async function fakeFactory(): Promise<IDBFactory> {
    const { indexedDB } = await import('fake-indexeddb');
    return indexedDB;
  }

  it('lets exactly one racing tab win the same scope', async () => {
    const factory = await fakeFactory();
    const scope = `${USER}-race`;
    const now = 1_000_000;
    const results = await Promise.all([
      acquireFlushClaim(scope, TAB_A, now, factory),
      acquireFlushClaim(scope, TAB_B, now, factory),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const holder = await readFlushClaim(scope, factory);
    expect(holder).not.toBeNull();
    // The loser observes the winner's committed claim and stands down.
    const loser = holder!.owner === TAB_A ? TAB_B : TAB_A;
    expect(await acquireFlushClaim(scope, loser, now + 1000, factory)).toBe(false);
    // Release is owner-token guarded: a stranger cannot free the claim.
    expect(await releaseFlushClaim(scope, loser, factory)).toBe(false);
    expect(await readFlushClaim(scope, factory)).not.toBeNull();
    expect(await releaseFlushClaim(scope, holder!.owner, factory)).toBe(true);
    expect(await readFlushClaim(scope, factory)).toBeNull();
    // After release the other tab may proceed.
    expect(await acquireFlushClaim(scope, loser, now + 2000, factory)).toBe(true);
    await releaseFlushClaim(scope, loser, factory);
  });

  it('denies a second acquire while the first tab is still working', async () => {
    const factory = await fakeFactory();
    const scope = `${USER}-working`;
    const now = 2_000_000;
    let releaseWork!: () => void;
    const workGate = new Promise<void>(resolve => {
      releaseWork = resolve;
    });
    // A holds the claim and pauses inside its work, like the reproduced
    // get/set/get race: B must not enter while A is active.
    const running = withFlushLockFor(factory, scope, async () => {
      await workGate;
    });
    // Let A's acquire commit before B attempts.
    await new Promise(resolve => setTimeout(resolve, 10));
    const denied = await acquireFlushClaim(scope, TAB_B, now + 100, factory);
    expect(denied).toBe(false);
    releaseWork();
    await running;
    expect(await readFlushClaim(scope, factory)).toBeNull();
  });

  it('expires dead claims and renews live ones', async () => {
    const factory = await fakeFactory();
    const scope = `${USER}-lease`;
    const now = 3_000_000;
    expect(await acquireFlushClaim(scope, TAB_A, now, factory)).toBe(true);
    // Renewal before expiry extends this owner's lease past the old bound.
    expect(await renewFlushClaim(scope, TAB_A, now + 20_000, factory)).toBe(true);
    expect(await acquireFlushClaim(scope, TAB_B, now + 31_000, factory)).toBe(false);
    // Another owner's renew never steals.
    expect(await renewFlushClaim(scope, TAB_B, now + 32_000, factory)).toBe(false);
    // Past the renewed lease the scope is claimable again.
    expect(await acquireFlushClaim(scope, TAB_B, now + 20_000 + 30_001, factory)).toBe(true);
    await releaseFlushClaim(scope, TAB_B, factory);
  });

  async function withFlushLockFor(factory: IDBFactory, scope: string, work: () => Promise<void>): Promise<'ran' | 'skipped'> {
    vi.stubGlobal('indexedDB', factory);
    try {
      return await withFlushLock(scope, work);
    } finally {
      vi.unstubAllGlobals();
    }
  }
});

describe('008D claim transactions settle only on commit', () => {
  // Discriminating stub: every mutating request reports success, but the
  // transaction itself aborts afterwards instead of committing — the exact
  // shape of the reproduced early-resolve bug (a put that "succeeded" must
  // never report an acquired claim).
  function abortingFactory(seeds: Record<string, unknown> = {}) {
    const listeners: Record<'complete' | 'abort' | 'error', Array<() => void>> = { complete: [], abort: [], error: [] };
    let closed = false;
    let mutated = false;
    let settled = false;
    const fire = (type: 'complete' | 'abort') => {
      queueMicrotask(() => {
        if (settled) return;
        settled = true;
        for (const fn of listeners[type]) fn();
      });
    };
    // A mutating request that succeeds aborts the transaction instead of
    // committing; read-only flows still commit normally.
    const settleCheck = () => {
      if (mutated) {
        mutated = false;
        fire('abort');
      } else {
        fire('complete');
      }
    };
    const makeRequest = <T,>(value: T, mutating: boolean) => {
      const request = {
        result: undefined as T | undefined,
        error: undefined as unknown,
        onsuccess: null as null | ((event: unknown) => void),
        onerror: null as null | ((event: unknown) => void),
      };
      queueMicrotask(() => {
        request.result = value;
        request.onsuccess?.({ target: request });
        if (mutating) mutated = true;
        queueMicrotask(settleCheck);
      });
      return request;
    };
    const store = {
      get: (key: string) => makeRequest<unknown>(seeds[key], false),
      put: () => makeRequest<void>(undefined, true),
      delete: () => makeRequest<void>(undefined, true),
    };
    const tx = {
      objectStore: () => store,
      error: new DOMException('aborted', 'AbortError'),
      set oncomplete(fn: () => void) {
        listeners.complete.push(fn);
      },
      set onabort(fn: () => void) {
        listeners.abort.push(fn);
      },
      set onerror(fn: () => void) {
        listeners.error.push(fn);
      },
      abort: () => fire('abort'),
    };
    const db = {
      transaction: () => tx,
      close: () => {
        closed = true;
      },
      objectStoreNames: { contains: () => true },
    };
    const factory = {
      open: () => {
        const request = {
          result: undefined as unknown,
          error: undefined as unknown,
          onsuccess: null as null | ((event: unknown) => void),
          onerror: null as null | ((event: unknown) => void),
          onupgradeneeded: null as null | ((event: unknown) => void),
        };
        queueMicrotask(() => {
          request.result = db;
          request.onupgradeneeded?.({ target: request });
          request.onsuccess?.({ target: request });
        });
        return request;
      },
    };
    return { factory: factory as unknown as IDBFactory, wasClosed: () => closed };
  }

  it('rejects acquire when the transaction aborts after put success', async () => {
    const { factory, wasClosed } = abortingFactory();
    await expect(acquireFlushClaim('scope-abort', 'tab-a', 1000, factory)).rejects.toThrow();
    expect(wasClosed()).toBe(true);
  });

  it('rejects renew and release on the same abort path', async () => {
    const seed = { 'scope-abort': { userId: 'scope-abort', owner: 'tab-a', expiresAt: 9999 } };
    const { factory } = abortingFactory(seed);
    await expect(renewFlushClaim('scope-abort', 'tab-a', 1000, factory)).rejects.toThrow();
    await expect(releaseFlushClaim('scope-abort', 'tab-a', 1000, factory)).rejects.toThrow();
  });
});

describe('008D flush owner wake and fencing', () => {
  it('delivers due entries in order and stops at logout mid-flight', async () => {
    const first = createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'first' });
    createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'second' });
    const delivered: string[] = [];
    registerFlushOwner({
      userId: USER,
      deliver: async entry => {
        delivered.push(entry.clientId);
        if (delivered.length === 1) {
          // Account switch purges mid-flight and replaces the owner: the
          // loop must not continue the second entry afterwards.
          clearUserOutbox(USER);
          unregisterFlushOwner(USER);
        }
        return true;
      },
      isCurrent: () => true,
    });
    requestFlush('test');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(delivered).toEqual([first.clientId]);
  });

  it('wakes on online and visible foreground without reposting settled work', async () => {
    const entry = createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'hi' });
    const delivered: string[] = [];
    registerFlushOwner({
      userId: USER,
      deliver: async item => {
        delivered.push(item.clientId);
        markOutboxSaved(item.clientId, { messageId: 'm', runId: 'r', sequence: 1 });
        return true;
      },
      isCurrent: () => true,
    });
    // Let the mount wake settle the entry first.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(delivered).toEqual([entry.clientId]);
    // Later wakes find settled work and post nothing further.
    window.dispatchEvent(new Event('online'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(delivered).toEqual([entry.clientId]);
    expect(entriesForChat(USER, WS, 'chat')).toHaveLength(1);
  });
});

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

function routeMocks(chats: Chat[], messagesByChat: Record<string, ChatMessage[]>) {
  vi.spyOn(api, 'listChats').mockImplementation(async () => ({ chats }));
  vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
  vi.spyOn(api, 'models').mockResolvedValue({
    models: SEND_MODELS,
    current_command_key: 'mimo-25',
    default_command_key: 'mimo-25',
  });
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
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const send = view.host.querySelector('[aria-label="Send"]') as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  await React.act(async () => send.click());
}

describe('008D offline send, reload, foreground flush', () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  it('sends offline, reloads, then foreground-flushes one saved UUID', async () => {
    const baseNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseNow);
    try {
      routeMocks([chatRow('chat_A', 'Alpha')], { chat_A: [chatMessage('chat_A', 'm1', 'Alpha note')] });
      let online = false;
      const posted: string[] = [];
      vi.spyOn(api, 'sendMessage').mockImplementation(async (_ws, _chat, clientId, text) => {
        if (!online) throw new TypeError('offline');
        posted.push(`${clientId}:${text}`);
        return { status: 'accepted', message_id: `msg-${clientId}`, run_id: 'run_live', acceptance_sequence: 2 };
      });
      const view = await mountRoute(`/?workspace=${WS}&chat=chat_A`, {
        userId: USER,
        workspaces: [{ id: WS, name: 'Kerning' }],
        members: { [USER]: 'Avi' },
      });
      await sendFromComposer(view, 'Hello while offline');
      expect(view.host.textContent).toContain('Hello while offline');
      // Immediate honest failure with a bounded retry scheduled, same UUID kept.
      const failed = entriesForUser(USER).filter(entry => entry.state === 'failed');
      expect(failed).toHaveLength(1);
      const uuid = failed[0]!.clientId;
      expect(failed[0]!.nextRetryAt).toBeDefined();
      // Let the debounced persistence land before the simulated reload.
      await React.act(async () => {
        await tick();
      });

      // Reload: fresh JS memory, persisted per-account record restored.
      await view.unmount();
      resetOutboxForTests();
      resetFlushForTests();
      await rehydrateOutbox(USER);
      expect(entriesForUser(USER).map(entry => entry.clientId)).toEqual([uuid]);

      // Foreground with the network back: one POST, one saved bubble.
      online = true;
      nowSpy.mockReturnValue(baseNow + 60_000);
      const again = await mountRoute(`/?workspace=${WS}&chat=chat_A`, {
        userId: USER,
        workspaces: [{ id: WS, name: 'Kerning' }],
        members: { [USER]: 'Avi' },
      });
      // Mount flush may already be settling; foreground is the required wake.
      again.host.ownerDocument.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('online'));
      await React.act(async () => {
        await tick();
      });
      await React.act(async () => {
        await tick();
      });
      expect(posted.filter(line => line.startsWith(uuid)).length).toBe(1);
      const bubbles = () => Array.from(again.host.querySelectorAll('.otis-turn__bubble'));
      expect(bubbles().filter(node => node.textContent === 'Hello while offline')).toHaveLength(1);
      expect(again.host.querySelectorAll('.otis-delivery')).toHaveLength(0);
      await again.unmount();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps input sent before a deferred restore resolves and delivers it once', async () => {
    routeMocks([chatRow('chat_A', 'Alpha')], { chat_A: [chatMessage('chat_A', 'm1', 'Alpha note')] });
    const idb = (await import('idb-keyval')) as unknown as {
      get: {
        getMockImplementation: () => ((key: string) => Promise<unknown>) | undefined;
        mockImplementation: (impl: (key: string) => Promise<unknown>) => void;
      };
      __store: Map<string, unknown>;
    };
    const userKey = `otis/outbox/v1/user/${USER}`;
    // A previous logout left a cleared generation-1 record behind.
    idb.__store.set(userKey, { schemaVersion: 1, generation: 1, entries: {}, tombstones: {}, newChats: {} });
    // Hold the restore's storage read: the user logs in and sends first.
    const baseGet = idb.get.getMockImplementation()!;
    let openRestore = false;
    let releaseRestore!: () => void;
    const restoreGate = new Promise<void>(resolve => {
      releaseRestore = () => {
        openRestore = true;
        resolve();
      };
    });
    idb.get.mockImplementation(async (key: string) => {
      if (key === userKey && !openRestore) await restoreGate;
      return baseGet(key);
    });
    try {
      // Hold HTTP acceptance too: the POST stays in flight across the restore.
      let releaseSend!: () => void;
      const sendGate = new Promise<void>(resolve => {
        releaseSend = resolve;
      });
      const posted: string[] = [];
      vi.spyOn(api, 'sendMessage').mockImplementation(async (_ws, _chat, clientId, text) => {
        posted.push(`${clientId}:${text}`);
        await sendGate;
        return { status: 'accepted', message_id: `msg-${clientId}`, run_id: 'run_live', acceptance_sequence: 2 };
      });
      const view = await mountRoute(`/?workspace=${WS}&chat=chat_A`, {
        userId: USER,
        workspaces: [{ id: WS, name: 'Kerning' }],
        members: { [USER]: 'Avi' },
      });
      // Send stays instant while the restore is still deferred (R5): the
      // composer never blocks on storage.
      await sendFromComposer(view, 'Hello before restore');
      expect(view.host.textContent).toContain('Hello before restore');
      const uuid = entriesForUser(USER)[0]!.clientId;
      await React.act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      // The debounced persist raced the deferred restore: it must adopt the
      // persisted generation and keep the fresh input, never erase it as
      // stale — login precedes mount precedes restore precedes any send.
      const storedDuring = idb.__store.get(userKey) as { entries: Record<string, { text: string }> };
      expect(Object.keys(storedDuring.entries)).toEqual([uuid]);
      // The restore resolves afterwards: original UUID and bubble stay.
      releaseRestore();
      await React.act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      expect(entriesForUser(USER).map(entry => entry.clientId)).toEqual([uuid]);
      expect(view.host.textContent).toContain('Hello before restore');
      // Acceptance lands: exactly one delivery of the original UUID, one
      // bubble, no duplicate from the restore wake racing the held POST.
      releaseSend();
      await React.act(async () => {
        await tick();
      });
      await React.act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });
      expect(posted).toHaveLength(1);
      expect(posted[0]!.startsWith(uuid)).toBe(true);
      const bubbles = () => Array.from(view.host.querySelectorAll('.otis-turn__bubble'));
      expect(bubbles().filter(node => node.textContent === 'Hello before restore')).toHaveLength(1);
      expect(view.host.querySelectorAll('.otis-delivery')).toHaveLength(0);
      await view.unmount();
    } finally {
      idb.get.mockImplementation(baseGet);
    }
  });

  it('flushes multiple queued inputs in chronological order', async () => {
    routeMocks([chatRow('chat_A', 'Alpha')], { chat_A: [chatMessage('chat_A', 'm1', 'Alpha note')] });
    const posted: string[] = [];
    vi.spyOn(api, 'sendMessage').mockImplementation(async (_ws, _chat, clientId, text) => {
      posted.push(text);
      return { status: 'accepted', message_id: `msg-${clientId}`, run_id: 'run_live', acceptance_sequence: 2 };
    });
    const view = await mountRoute(`/?workspace=${WS}&chat=chat_A`, {
      userId: USER,
      workspaces: [{ id: WS, name: 'Kerning' }],
      members: { [USER]: 'Avi' },
    });
    await sendFromComposer(view, 'First note');
    await sendFromComposer(view, 'Second note');
    await React.act(async () => {
      await tick();
    });
    await React.act(async () => {
      await tick();
    });
    // Two rapid sends carry distinct UUIDs and post in input order through
    // the single per-chat flush path.
    expect(new Set(posted).size).toBe(2);
    expect(posted).toEqual(['First note', 'Second note']);
    const bubbles = Array.from(view.host.querySelectorAll('.otis-turn__bubble'));
    expect(bubbles.filter(node => node.textContent === 'First note')).toHaveLength(1);
    expect(bubbles.filter(node => node.textContent === 'Second note')).toHaveLength(1);
    await view.unmount();
  });

  it('holds a follow-up POST behind an unacknowledged first POST without blocking input', async () => {
    routeMocks([chatRow('chat_A', 'Alpha')], { chat_A: [chatMessage('chat_A', 'm1', 'Alpha note')] });
    let releaseFirst!: () => void;
    const posts: Array<{ uuid: string; text: string }> = [];
    let firstStarted = false;
    vi.spyOn(api, 'sendMessage').mockImplementation(
      (ws, chat, clientId, text) =>
        new Promise(resolve => {
          posts.push({ uuid: clientId, text });
          if (!firstStarted) {
            // The first POST stays in flight: the model has not even started.
            firstStarted = true;
            releaseFirst = () =>
              resolve({ status: 'accepted', message_id: `msg-${clientId}`, run_id: 'run_live', acceptance_sequence: 2 });
            return;
          }
          resolve({ status: 'accepted', message_id: `msg-${clientId}`, run_id: 'run_live', acceptance_sequence: 3 });
        }),
    );
    const view = await mountRoute(`/?workspace=${WS}&chat=chat_A`, {
      userId: USER,
      workspaces: [{ id: WS, name: 'Kerning' }],
      members: { [USER]: 'Avi' },
    });
    await sendFromComposer(view, 'First hello');
    // Local acceptance is instant: bubble and follow-up input stay available.
    expect(view.host.textContent).toContain('First hello');
    await sendFromComposer(view, 'Second hello');
    expect(view.host.textContent).toContain('Second hello');
    const bubbles = () => Array.from(view.host.querySelectorAll('.otis-turn__bubble'));
    expect(bubbles()).toHaveLength(3);
    // Exactly one HTTP POST is in flight; the second waits its turn.
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toBe('First hello');
    // Once the first 202 arrives, the second POST starts without waiting
    // for any model reply: acceptance order follows input order.
    releaseFirst();
    await React.act(async () => {
      await tick();
    });
    await React.act(async () => {
      await tick();
    });
    expect(posts.map(post => post.text)).toEqual(['First hello', 'Second hello']);
    expect(new Set(posts.map(post => post.uuid)).size).toBe(2);
    await view.unmount();
  });

  it('holds newer flush inputs behind a deferred transient retry', async () => {
    const first = createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'first' });
    createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'second' });
    markOutboxFailed(first.clientId, { code: 'transport', message: 'down' });
    deferOutboxRetry(first.clientId, new Date(Date.now() + 60_000).toISOString());
    const delivered: string[] = [];
    registerFlushOwner({
      userId: USER,
      deliver: async entry => {
        delivered.push(entry.clientId);
        return true;
      },
      isCurrent: () => true,
    });
    requestFlush('test');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(delivered).toEqual([]);
    // Once the blocker resolves explicitly, the follower proceeds in order.
    markOutboxSaved(first.clientId, { messageId: 'm', runId: 'r', sequence: 1 });
    requestFlush('test');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).not.toBe(first.clientId);
  });

  it('posts one UUID once across concurrent flushes', async () => {
    const entry = createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'once' });
    let calls = 0;
    registerFlushOwner({
      userId: USER,
      // Mirrors the production transport guard exactly: claim, re-read
      // fresh, and never POST for settled entries.
      deliver: async item => {
        if (!claimDelivery(item.clientId)) return false;
        try {
          const fresh = getOutboxEntry(item.clientId);
          if (!fresh || fresh.state === 'saved') return true;
          calls += 1;
          markOutboxSaved(item.clientId, { messageId: 'm', runId: 'r', sequence: 1 });
          return true;
        } finally {
          releaseDelivery(item.clientId);
        }
      },
      isCurrent: () => true,
    });
    requestFlush('a');
    requestFlush('b');
    requestFlush('c');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls).toBe(1);
    expect(getOutboxEntry(entry.clientId)?.state).toBe('saved');
  });

  it('claims one delivery per UUID across remounts and releases it', () => {
    expect(claimDelivery('uuid-claim-1')).toBe(true);
    expect(claimDelivery('uuid-claim-1')).toBe(false);
    releaseDelivery('uuid-claim-1');
    expect(claimDelivery('uuid-claim-1')).toBe(true);
    releaseDelivery('uuid-claim-1');
  });

  it('keeps a stale clarification failed in its original scope', async () => {
    routeMocks([chatRow('chat_A', 'Alpha')], { chat_A: [chatMessage('chat_A', 'm1', 'Alpha note')] });
    const posted: string[] = [];
    vi.spyOn(api, 'sendMessage').mockImplementation(async (_ws, _chat, _clientId, text) => {
      posted.push(text);
      throw new ApiError(409, 'clarification_resolved', 'Already answered.');
    });
    const view = await mountRoute(`/?workspace=${WS}&chat=chat_A`, {
      userId: USER,
      workspaces: [{ id: WS, name: 'Kerning' }],
      members: { [USER]: 'Avi' },
    });
    await sendFromComposer(view, 'Late clarification answer');
    // Permanent: failed with Retry, no automatic retry scheduled, no reroute.
    const failed = entriesForUser(USER).filter(entry => entry.state === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.nextRetryAt).toBeUndefined();
    expect(location.search).toBe(`?workspace=${WS}&chat=chat_A`);
    const calls = posted.length;
    window.dispatchEvent(new Event('online'));
    await React.act(async () => {
      await tick();
    });
    expect(posted.length).toBe(calls);
    expect(view.host.textContent).toContain('Late clarification answer');
    await view.unmount();
  });

  it('flushes a background workspace in its own scope without rerouting the view', async () => {
    const WSA = 'ws_008d_a';
    const WSB = 'ws_008d_b';
    const chatsB = [chatRow('chat_B', 'Beta')];
    chatsB[0]!.workspace_id = WSB;
    vi.spyOn(api, 'listChats').mockImplementation(async () => ({ chats: chatsB }));
    vi.spyOn(api, 'commands').mockResolvedValue({ surface: 'web', commands: [] });
    vi.spyOn(api, 'models').mockResolvedValue({
      models: SEND_MODELS,
      current_command_key: 'mimo-25',
      default_command_key: 'mimo-25',
    });
    vi.spyOn(api, 'getChat').mockImplementation(async (_ws, id) => ({ chat: chatsB.find(item => item.id === id)!, is_author: true }));
    vi.spyOn(api, 'listMessages').mockImplementation(async (_ws, id) => ({
      chat_id: id,
      messages: [chatMessage('chat_B', 'm-b', 'Beta note')],
      next_before_sequence: null,
    }));
    vi.spyOn(api, 'activity').mockResolvedValue({ activities: [], latest_cursor: 0 } as never);
    vi.spyOn(api, 'clarifications').mockResolvedValue({ clarifications: [] });
    vi.spyOn(stream, 'subscribeToActivity').mockReturnValue({ close: vi.fn() });

    // Two Workspace-A inputs went offline while the reader is on Workspace-B:
    // a new-chat entry (no chat yet) and an existing-chat follow-up.
    const newEntry = createOutboxEntry({ userId: USER, workspaceId: WSA, chatId: null, text: 'Alpha new' });
    const oldEntry = createOutboxEntry({ userId: USER, workspaceId: WSA, chatId: 'chat_A', text: 'Alpha follow-up' });
    const createdChats: string[] = [];
    const posted: Array<{ ws: string; chat: string; uuid: string; text: string }> = [];
    vi.spyOn(api, 'createChat').mockImplementation(async (ws, _key) => {
      createdChats.push(ws);
      return {
        chat: {
          id: 'chat_created_A',
          workspace_id: ws,
          title: 'Alpha',
          author_user_id: USER,
          author_display_name: 'Avi',
          model_override: null,
          is_archived: false,
          activity_cursor: 1,
          created_at: '2026-10-03T12:00:00.000Z',
          updated_at: '2026-10-03T12:00:00.000Z',
          last_activity_at: '2026-10-03T12:00:00.000Z',
        },
      };
    });
    let followUpFails = true;
    const sendCalls: Array<{ ws: string; chat: string; uuid: string }> = [];
    vi.spyOn(api, 'sendMessage').mockImplementation(async (ws, chat, clientId, text) => {
      sendCalls.push({ ws, chat, uuid: clientId });
      if (ws === WSA && chat === 'chat_A' && followUpFails) {
        followUpFails = false;
        throw new ApiError(429, 'rate_limited', 'Slow down.', undefined, 30);
      }
      posted.push({ ws, chat, uuid: clientId, text });
      return { status: 'accepted', message_id: `msg-${clientId}`, run_id: 'run_live', acceptance_sequence: 2 };
    });

    const view = await mountRoute(`/?workspace=${WSB}&chat=chat_B`, {
      userId: USER,
      workspaces: [
        { id: WSA, name: 'Alpha Co' },
        { id: WSB, name: 'Kerning' },
      ],
      members: { [USER]: 'Avi' },
    });
    expect(view.host.textContent).toContain('Beta note');
    requestFlush('test');
    await React.act(async () => {
      await tick();
    });
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
    });

    // Exact API path: creation and both sends carry Workspace-A scope even
    // though Workspace-B is viewed. The new-chat follow-up fails once with
    // 429, then retries after its 30ms Retry-After reusing its UUID.
    expect(createdChats).toEqual([WSA]);
    expect(getNewChatMapping(newEntry.newChatKey!, USER)).toBe('chat_created_A');
    const forNew = posted.filter(line => line.uuid === newEntry.clientId);
    expect(forNew).toEqual([{ ws: WSA, chat: 'chat_created_A', uuid: newEntry.clientId, text: 'Alpha new' }]);
    const oldCalls = sendCalls.filter(line => line.uuid === oldEntry.clientId);
    expect(oldCalls).toHaveLength(2);
    expect(oldCalls[0]).toMatchObject({ ws: WSA, chat: 'chat_A' });
    const forOld = posted.filter(line => line.uuid === oldEntry.clientId);
    expect(forOld).toHaveLength(1);
    expect(forOld[0]).toMatchObject({ ws: WSA, chat: 'chat_A', text: 'Alpha follow-up' });
    // The viewed chat is undisturbed: no reroute, no error banner, intact.
    expect(location.search).toBe(`?workspace=${WSB}&chat=chat_B`);
    expect(view.host.textContent).toContain('Beta note');
    expect(view.host.querySelector('.otis-chat-error')).toBeNull();
    await view.unmount();
  });

  it('discards a failed bubble locally without another POST', async () => {
    routeMocks([chatRow('chat_A', 'Alpha')], { chat_A: [chatMessage('chat_A', 'm1', 'Alpha note')] });
    const posted: string[] = [];
    vi.spyOn(api, 'sendMessage').mockImplementation(async (_ws, _chat, _clientId, text) => {
      posted.push(text);
      throw new TypeError('offline');
    });
    const view = await mountRoute(`/?workspace=${WS}&chat=chat_A`, {
      userId: USER,
      workspaces: [{ id: WS, name: 'Kerning' }],
      members: { [USER]: 'Avi' },
    });
    await sendFromComposer(view, 'Drop this');
    const discard = Array.from(view.host.querySelectorAll('button')).find(
      button => button.textContent === 'Discard',
    ) as HTMLButtonElement;
    expect(discard).toBeTruthy();
    expect(discard.getAttribute('aria-label')).toBe('Discard unsent message');
    await React.act(async () => discard.click());
    expect(view.host.textContent).not.toContain('Drop this');
    expect(posted).toHaveLength(1);
    expect(entriesForUser(USER)).toHaveLength(0);
    await view.unmount();
  });
});

describe('008D cross-tab outbox storage', () => {
  // Two live module instances sharing the mocked store stand in for two
  // tabs. Query-suffixed dynamic imports give each tab its own memory while
  // the idb-keyval mock stays the single shared IndexedDB.
  async function twoTabs() {
    const outboxA = await import('../src/api/outbox.js?tab=a');
    const outboxB = await import('../src/api/outbox.js?tab=b');
    expect(outboxA.entriesForUser === outboxB.entriesForUser).toBe(false);
    return { outboxA, outboxB };
  }

  async function storedRecord(userId: string) {
    const idb = (await import('idb-keyval')) as unknown as { __store: Map<string, unknown> };
    return idb.__store.get(`otis/outbox/v1/user/${userId}`) as
      | { entries: Record<string, { text: string }>; tombstones: Record<string, string> }
      | undefined;
  }

  it('two tabs creating different entries both survive reload', async () => {
    const { outboxA, outboxB } = await twoTabs();
    const a = outboxA.createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'unsentA' });
    const b = outboxB.createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'unsentB' });
    await new Promise(resolve => setTimeout(resolve, 10));
    // A fresh tab reload sees both inputs: no whole-snapshot clobbering.
    const reloaded = await import('../src/api/outbox.js?tab=reload');
    await reloaded.rehydrateOutbox(USER);
    const texts = reloaded.entriesForUser(USER).map(entry => entry.text).sort();
    expect(texts).toEqual(['unsentA', 'unsentB']);
    expect(reloaded.entriesForUser(USER).map(entry => entry.clientId).sort()).toEqual(
      [a.clientId, b.clientId].sort(),
    );
  });

  it('accepted and discarded entries are not resurrected by stale tabs', async () => {
    const outboxA = await import('../src/api/outbox.js?tab=c');
    const outboxB = await import('../src/api/outbox.js?tab=d');
    expect(outboxA.entriesForUser === outboxB.entriesForUser).toBe(false);
    const x = outboxA.createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'will reconcile' });
    await new Promise(resolve => setTimeout(resolve, 10));
    // Tab A reconciles against the server row and prunes; tab B still holds
    // the entry in memory and persists afterwards.
    outboxA.pruneReconciledEntries(new Set([x.clientId]));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await storedRecord(USER))?.entries[x.clientId]).toBeUndefined();
    const y = outboxB.createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'will discard' });
    outboxB.discardUnsentEntry(y.clientId);
    await new Promise(resolve => setTimeout(resolve, 10));
    // The stored record itself carries neither deleted entry.
    expect((await storedRecord(USER))?.entries[x.clientId]).toBeUndefined();
    expect((await storedRecord(USER))?.entries[y.clientId]).toBeUndefined();
    // A fresh reload sees neither deleted entry, and B's own live entry.
    const reloaded = await import('../src/api/outbox.js?tab=reload2');
    await reloaded.rehydrateOutbox(USER);
    expect(reloaded.entriesForUser(USER).map(entry => entry.clientId)).not.toContain(x.clientId);
    expect(reloaded.entriesForUser(USER).map(entry => entry.clientId)).not.toContain(y.clientId);
  });

  it('a logout-time purge survives a stale tab delayed write', async () => {
    const outboxA = await import('../src/api/outbox.js?tab=e');
    const outboxB = await import('../src/api/outbox.js?tab=f');
    expect(outboxA.entriesForUser === outboxB.entriesForUser).toBe(false);
    const x = outboxA.createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'private' });
    // Let A's persist land before B restores, mirroring real tab timing.
    await new Promise(resolve => setTimeout(resolve, 10));
    await outboxB.rehydrateOutbox(USER);
    expect(outboxB.entriesForUser(USER).map(entry => entry.clientId)).toContain(x.clientId);
    // Tab A logs out: memory purged and the persisted generation bumped.
    outboxA.clearUserOutbox(USER);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await storedRecord(USER))?.entries[x.clientId]).toBeUndefined();
    // Tab B (stale, pre-logout memory) persists afterwards: the persisted
    // generation wins and nothing is restored.
    outboxB.markOutboxFailed(x.clientId, { code: 'transport', message: 'stale tab write' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await storedRecord(USER))?.entries[x.clientId]).toBeUndefined();
    const reloaded = await import('../src/api/outbox.js?tab=reload3');
    await reloaded.rehydrateOutbox(USER);
    expect(reloaded.entriesForUser(USER)).toEqual([]);
  });

  it('a logout purge drops every stored row of that owner, including rows this tab never knew', async () => {
    // Tab B contributes a row tab A never holds in memory; the purge must
    // drop it from storage anyway (whole-owner generation fence, not a UUID
    // list), while another owner stays intact throughout.
    const outboxA = await import('../src/api/outbox.js?tab=purge-a');
    const outboxB = await import('../src/api/outbox.js?tab=purge-b');
    expect(outboxA.entriesForUser === outboxB.entriesForUser).toBe(false);
    const OTHER = 'usr_008d_other';
    const a1 = outboxA.createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'a-private' });
    const b1 = outboxB.createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'b-private-unknown-to-a' });
    const other = outboxA.createOutboxEntry({ userId: OTHER, workspaceId: WS, chatId: 'chat', text: 'other-owner' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await storedRecord(USER))?.entries[a1.clientId]).toBeDefined();
    expect((await storedRecord(USER))?.entries[b1.clientId]).toBeDefined();
    // Tab A logs out knowing only its own memory: storage for USER is
    // cleared wholly, OTHER untouched.
    outboxA.clearUserOutbox(USER);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await storedRecord(USER))?.entries).toEqual({});
    expect((await storedRecord(OTHER))?.entries[other.clientId]).toBeDefined();
    // Stale tab B persists a pre-purge memory row afterwards — one it
    // created but never had to share before the purge: the persisted
    // generation fences it and nothing returns.
    outboxB.markOutboxFailed(b1.clientId, { code: 'transport', message: 'stale tab write' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await storedRecord(USER))?.entries).toEqual({});
    // A fresh reload sees no USER rows and keeps the other owner intact.
    const reloaded = await import('../src/api/outbox.js?tab=purge-reload');
    await reloaded.rehydrateOutbox(USER);
    await reloaded.rehydrateOutbox(OTHER);
    expect(reloaded.entriesForUser(USER)).toEqual([]);
    expect(reloaded.entriesForUser(OTHER).map(entry => entry.text)).toEqual(['other-owner']);
  });
});

describe('008D offline shell, update prompt and PWA contract', () => {
  it('renders the offline shell without asserting a session', async () => {
    const retried = vi.fn();
    const view = await mount(<UnavailableScreen offline onRetry={retried} />);
    expect(view.host.textContent).toContain('appear to be offline');
    expect(view.host.textContent).toContain('nothing was sent');
    // Honest scope: the shell promises saved unsent input, never the full
    // conversation history (authenticated history is deliberately uncached).
    expect(view.host.textContent).not.toContain('conversations stay');
    await React.act(async () => (view.host.querySelector('.otis-entry__action') as HTMLElement).click());
    expect(retried).toHaveBeenCalledTimes(1);
    await view.unmount();
    const online = await mount(<UnavailableScreen offline={false} onRetry={() => {}} />);
    expect(online.host.textContent).toContain('could not check your session');
    await online.unmount();
  });

  it('prompts for updates but never reloads with unsent entries', async () => {
    const { useRegisterSW } = await import('./pwa-register-stub.js');
    const mocked = vi.mocked(useRegisterSW);
    const activate = vi.fn();
    mocked.mockReturnValue({
      needRefresh: [true, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: activate,
    });
    const reloaded = vi.fn();
    const view = await mount(
      <div>
        <Toaster />
        <UpdatePrompt userId={USER} onReload={reloaded} />
      </div>,
    );
    expect(view.host.textContent).toContain('update is ready');
    createOutboxEntry({ userId: USER, workspaceId: WS, chatId: 'chat', text: 'in flight' });
    await React.act(async () => (view.host.querySelectorAll('button')[0] as HTMLElement).click());
    expect(reloaded).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain('Finish sending first');
    await view.unmount();
    // With nothing unsent, the safe action activates the waiting worker
    // through the supported path — never a bare reload of the old worker.
    resetOutboxForTests();
    const clear = await mount(
      <div>
        <Toaster />
        <UpdatePrompt userId={USER} />
      </div>,
    );
    await React.act(async () => (clear.host.querySelectorAll('button')[0] as HTMLElement).click());
    expect(activate).toHaveBeenCalledWith(true);
    await clear.unmount();
    mocked.mockReturnValue({
      needRefresh: [false, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: vi.fn(),
    });
  });

  it('commits a scheduled draft before activating the update, and still blocks on unsent entries', async () => {
    const { useRegisterSW } = await import('./pwa-register-stub.js');
    const mocked = vi.mocked(useRegisterSW);
    // Ordering proof: at the instant activation runs, the draft must already
    // be committed to storage — a fire-and-forget flush would read back empty.
    const activations: string[] = [];
    const activate = vi.fn(async () => {
      const idb = (await import('idb-keyval')) as unknown as { __store: Map<string, unknown> };
      const record = idb.__store.get(`otis/drafts/v1/${UPD}`) as
        | { drafts?: Record<string, { text: string }> }
        | undefined;
      activations.push(record?.drafts?.['ws/chat']?.text ?? '<missing>');
    });
    mocked.mockReturnValue({
      needRefresh: [true, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: activate,
    });
    const { scheduleDraftSave, loadDraft } = await import('../src/api/drafts.js');
    const draftKey = `otis:draft:${UPD}:ws:chat`;
    await loadDraft(draftKey);
    const view = await mount(
      <div>
        <Toaster />
        <UpdatePrompt userId={UPD} />
      </div>,
    );
    const reloadButton = () => view.host.querySelectorAll('button')[0] as HTMLElement;
    // An unsent message still blocks first — even with a draft waiting — and
    // nothing is committed or activated for it.
    createOutboxEntry({ userId: UPD, workspaceId: WS, chatId: 'chat', text: 'in flight' });
    scheduleDraftSave(draftKey, 'typed draft');
    await React.act(async () => reloadButton().click());
    expect(activate).not.toHaveBeenCalled();
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(document.body.textContent).toContain('Finish sending first');
    // Once sending settles, clicking immediately (well inside the 400ms
    // debounce a reload would otherwise orphan) commits first, then activates.
    // The draft write itself is held here: activation must wait for the
    // commit, not race it — a fire-and-forget flush would activate first.
    resetOutboxForTests();
    const idbUpdate = (await import('idb-keyval')) as unknown as {
      update: {
        getMockImplementation: () => ((...args: Array<never>) => Promise<unknown>) | undefined;
        mockImplementation: (impl: (...args: Array<never>) => Promise<unknown>) => void;
      };
      __store: Map<string, unknown>;
    };
    const baseUpdate = idbUpdate.update.getMockImplementation()!;
    const draftRecordKey = `otis/drafts/v1/${UPD}`;
    let openWrite = false;
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>(resolve => {
      releaseWrite = () => {
        openWrite = true;
        resolve();
      };
    });
    idbUpdate.update.mockImplementation(async (...args: Array<never>) => {
      if (String(args[0]) === draftRecordKey && !openWrite) await writeGate;
      return baseUpdate(...args);
    });
    try {
      await React.act(async () => reloadButton().click());
      await React.act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      // The commit is still held: nothing may activate yet.
      expect(activate).not.toHaveBeenCalled();
      expect(await loadDraft(draftKey)).toBeNull();
      releaseWrite();
      await React.act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      expect(activate).toHaveBeenCalledWith(true);
      expect(activations).toEqual(['typed draft']);
      expect(await loadDraft(draftKey)).toBe('typed draft');
    } finally {
      idbUpdate.update.mockImplementation(baseUpdate);
    }
    await view.unmount();
    mocked.mockReturnValue({
      needRefresh: [false, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: vi.fn(),
    });
  });

  it('waits for an already-running draft write before activating', async () => {
    const { useRegisterSW } = await import('./pwa-register-stub.js');
    const mocked = vi.mocked(useRegisterSW);
    const activate = vi.fn();
    mocked.mockReturnValue({
      needRefresh: [true, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: activate,
    });
    const { scheduleDraftSave, loadDraft } = await import('../src/api/drafts.js');
    const draftKey = `otis:draft:${UPD}:ws:chat`;
    await loadDraft(draftKey);
    const idb = (await import('idb-keyval')) as unknown as {
      update: {
        getMockImplementation: () => ((...args: Array<never>) => Promise<unknown>) | undefined;
        mockImplementation: (impl: (...args: Array<never>) => Promise<unknown>) => void;
      };
    };
    const baseUpdate = idb.update.getMockImplementation()!;
    const draftRecordKey = `otis/drafts/v1/${UPD}`;
    let writeStarted = false;
    let openWrite = false;
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>(resolve => {
      releaseWrite = () => {
        openWrite = true;
        resolve();
      };
    });
    idb.update.mockImplementation(async (...args: Array<never>) => {
      if (String(args[0]) === draftRecordKey) {
        writeStarted = true;
        if (!openWrite) await writeGate;
      }
      return baseUpdate(...args);
    });
    try {
      const view = await mount(
        <div>
          <Toaster />
          <UpdatePrompt userId={UPD} />
        </div>,
      );
      // Fire the debounce now: by the time the update is clicked, no pending
      // timer remains — only a storage round-trip already mid-flight.
      scheduleDraftSave(draftKey, 'held flight draft', 1);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(writeStarted).toBe(true);
      await React.act(async () => (view.host.querySelectorAll('button')[0] as HTMLElement).click());
      await React.act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      // A flush that only drains timers would report safe here and activate
      // while the commit is still unsettled.
      expect(activate).not.toHaveBeenCalled();
      releaseWrite();
      await React.act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      expect(activate).toHaveBeenCalledWith(true);
      expect(await loadDraft(draftKey)).toBe('held flight draft');
      await view.unmount();
    } finally {
      idb.update.mockImplementation(baseUpdate);
    }
    mocked.mockReturnValue({
      needRefresh: [false, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: vi.fn(),
    });
  });

  it('holds the update after a failed save until the text commits', async () => {
    const { useRegisterSW } = await import('./pwa-register-stub.js');
    const mocked = vi.mocked(useRegisterSW);
    const activate = vi.fn();
    mocked.mockReturnValue({
      needRefresh: [true, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: activate,
    });
    const { scheduleDraftSave, loadDraft } = await import('../src/api/drafts.js');
    const draftKey = `otis:draft:${UPD}:ws:chat`;
    await loadDraft(draftKey);
    const idb = (await import('idb-keyval')) as unknown as {
      update: {
        getMockImplementation: () => ((...args: Array<never>) => Promise<unknown>) | undefined;
        mockImplementation: (impl: (...args: Array<never>) => Promise<unknown>) => void;
      };
    };
    const baseUpdate = idb.update.getMockImplementation()!;
    const draftRecordKey = `otis/drafts/v1/${UPD}`;
    let failedOnce = false;
    idb.update.mockImplementation(async (...args: Array<never>) => {
      if (String(args[0]) === draftRecordKey && !failedOnce) {
        failedOnce = true;
        throw new Error('quota exceeded');
      }
      return baseUpdate(...args);
    });
    try {
      const view = await mount(
        <div>
          <Toaster />
          <UpdatePrompt userId={UPD} />
        </div>,
      );
      // The debounce fires into a failing write: the text stays dirty even
      // though the pending queue already emptied.
      scheduleDraftSave(draftKey, 'doomed draft', 1);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(failedOnce).toBe(true);
      await React.act(async () => (view.host.querySelectorAll('button')[0] as HTMLElement).click());
      await React.act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      // Pending already emptied, yet unsafe: the update is held, not silently
      // treated as safe — and stays retryable.
      expect(activate).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain('Could not save your draft');
      // Retyping retries the same text: the next flush commits, then activates.
      scheduleDraftSave(draftKey, 'doomed draft');
      await React.act(async () => (view.host.querySelectorAll('button')[0] as HTMLElement).click());
      await React.act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      expect(activate).toHaveBeenCalledWith(true);
      expect(await loadDraft(draftKey)).toBe('doomed draft');
      await view.unmount();
    } finally {
      idb.update.mockImplementation(baseUpdate);
    }
    mocked.mockReturnValue({
      needRefresh: [false, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: vi.fn(),
    });
  });

  it('does not activate when a send lands while the draft flush is held', async () => {
    const { useRegisterSW } = await import('./pwa-register-stub.js');
    const mocked = vi.mocked(useRegisterSW);
    const activate = vi.fn();
    mocked.mockReturnValue({
      needRefresh: [true, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: activate,
    });
    const { scheduleDraftSave, loadDraft } = await import('../src/api/drafts.js');
    const draftKey = `otis:draft:${UPD}:ws:chat`;
    await loadDraft(draftKey);
    const idb = (await import('idb-keyval')) as unknown as {
      update: {
        getMockImplementation: () => ((...args: Array<never>) => Promise<unknown>) | undefined;
        mockImplementation: (impl: (...args: Array<never>) => Promise<unknown>) => void;
      };
    };
    const baseUpdate = idb.update.getMockImplementation()!;
    const draftRecordKey = `otis/drafts/v1/${UPD}`;
    let openWrite = false;
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>(resolve => {
      releaseWrite = () => {
        openWrite = true;
        resolve();
      };
    });
    idb.update.mockImplementation(async (...args: Array<never>) => {
      if (String(args[0]) === draftRecordKey && !openWrite) await writeGate;
      return baseUpdate(...args);
    });
    try {
      const view = await mount(
        <div>
          <Toaster />
          <UpdatePrompt userId={UPD} />
        </div>,
      );
      scheduleDraftSave(draftKey, 'held draft');
      await React.act(async () => (view.host.querySelectorAll('button')[0] as HTMLElement).click());
      await React.act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      expect(activate).not.toHaveBeenCalled();
      // The user sends while the commit is held: an unsent entry now exists.
      createOutboxEntry({ userId: UPD, workspaceId: WS, chatId: 'chat', text: 'sent during hold' });
      releaseWrite();
      await React.act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      // The draft committed, but the re-check sees the send: still held.
      expect(activate).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain('Finish sending first');
      expect(await loadDraft(draftKey)).toBe('held draft');
      await view.unmount();
    } finally {
      idb.update.mockImplementation(baseUpdate);
      resetOutboxForTests();
    }
    mocked.mockReturnValue({
      needRefresh: [false, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: vi.fn(),
    });
  });

  it('holds when a keystroke lands during the second held drain, preserving it', async () => {
    const { useRegisterSW } = await import('./pwa-register-stub.js');
    const mocked = vi.mocked(useRegisterSW);
    const activate = vi.fn();
    mocked.mockReturnValue({
      needRefresh: [true, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: activate,
    });
    const { scheduleDraftSave, loadDraft, flushUserDraftSaves } = await import('../src/api/drafts.js');
    const draftKey = `otis:draft:${UPD}:ws:chat`;
    await loadDraft(draftKey);
    const idb = (await import('idb-keyval')) as unknown as {
      update: {
        getMockImplementation: () => ((...args: Array<never>) => Promise<unknown>) | undefined;
        mockImplementation: (impl: (...args: Array<never>) => Promise<unknown>) => void;
      };
    };
    const baseUpdate = idb.update.getMockImplementation()!;
    const draftRecordKey = `otis/drafts/v1/${UPD}`;
    // Release writes one at a time: each drain's commit stays held until the
    // test lets exactly it through.
    const waiters: Array<() => void> = [];
    let holdOpen = false;
    idb.update.mockImplementation(async (...args: Array<never>) => {
      if (String(args[0]) === draftRecordKey && !holdOpen) {
        await new Promise<void>(resolve => {
          waiters.push(resolve);
        });
      }
      return baseUpdate(...args);
    });
    const releaseOne = () => waiters.shift()!();
    try {
      const view = await mount(
        <div>
          <Toaster />
          <UpdatePrompt userId={UPD} />
        </div>,
      );
      const reloadButton = () => view.host.querySelectorAll('button')[0] as HTMLElement;
      scheduleDraftSave(draftKey, 'first keystroke');
      await React.act(async () => reloadButton().click());
      await React.act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      // First drain held on its write; a keystroke lands meanwhile.
      expect(waiters).toHaveLength(1);
      expect(activate).not.toHaveBeenCalled();
      scheduleDraftSave(draftKey, 'second keystroke');
      releaseOne();
      await React.act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      // Second drain held on its own write; another keystroke lands inside it.
      expect(waiters).toHaveLength(1);
      expect(activate).not.toHaveBeenCalled();
      scheduleDraftSave(draftKey, 'third keystroke');
      await React.act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      expect(activate).not.toHaveBeenCalled();
      releaseOne();
      await React.act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      // Both drains committed, but the synchronous last look sees the third
      // keystroke still scheduled: held, not looped, not lost.
      expect(activate).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain('Could not save your draft');
      // The held keystroke is preserved: a direct flush commits it afterwards.
      holdOpen = true;
      for (const waiter of waiters.splice(0)) waiter();
      expect(await flushUserDraftSaves(UPD)).toBe(true);
      expect(await loadDraft(draftKey)).toBe('third keystroke');
      await view.unmount();
    } finally {
      holdOpen = true;
      idb.update.mockImplementation(baseUpdate);
    }
    mocked.mockReturnValue({
      needRefresh: [false, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: vi.fn(),
    });
  });

  it('holds the update when the draft commit fails', async () => {
    const { useRegisterSW } = await import('./pwa-register-stub.js');
    const mocked = vi.mocked(useRegisterSW);
    const activate = vi.fn();
    mocked.mockReturnValue({
      needRefresh: [true, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: activate,
    });
    const { scheduleDraftSave, loadDraft } = await import('../src/api/drafts.js');
    const draftKey = `otis:draft:${UPD}:ws:chat`;
    await loadDraft(draftKey);
    const view = await mount(
      <div>
        <Toaster />
        <UpdatePrompt userId={UPD} />
      </div>,
    );
    scheduleDraftSave(draftKey, 'doomed draft');
    const idb = (await import('idb-keyval')) as unknown as {
      update: { mockRejectedValueOnce: (error: unknown) => void };
    };
    idb.update.mockRejectedValueOnce(new Error('quota exceeded'));
    await React.act(async () => (view.host.querySelectorAll('button')[0] as HTMLElement).click());
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    // Honest degradation: no activation on uncommitted input, and the action
    // is usable again instead of stuck pending.
    expect(activate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Could not save your draft');
    const reload = view.host.querySelectorAll('button')[0] as HTMLButtonElement;
    expect(reload.disabled).toBe(false);
    expect(reload.getAttribute('aria-busy')).toBe('false');
    await view.unmount();
    mocked.mockReturnValue({
      needRefresh: [false, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: vi.fn(),
    });
  });

  it('keeps the service-worker cache to versioned static assets only', () => {
    for (const pattern of PWA_STATIC_GLOBS) {
      expect(pattern).not.toMatch(/api|auth|audio|credential|key/i);
    }
    expect(PWA_WORKBOX.globPatterns.join(' ')).toMatch(/woff2/);
    expect(PWA_WORKBOX.navigateFallback).toBe('index.html');
    expect(PWA_API_DENYLIST.some(rule => rule.test('/api/workspaces/ws/chats'))).toBe(true);
    expect(PWA_API_DENYLIST.some(rule => rule.test('/api/auth/session'))).toBe(true);
    expect(PWA_API_DENYLIST.some(rule => rule.test('/index.html'))).toBe(false);
    expect(PWA_API_DENYLIST.some(rule => rule.test('/'))).toBe(false);
    // No installability manifest ships: there are no approved icon/color
    // assets, and the plugin's defaults would misrepresent the baseline.
    // The offline shell needs precache + fallback only, both asserted above.
    expect(PWA_MANIFEST).toBe(false);
  });
});
