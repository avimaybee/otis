/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { App, SIGN_OUT_SERVER_TIMEOUT_MS } from '../src/App.js';
import { createOutboxEntry, entriesForUser, resetOutboxForTests } from '../src/api/outbox.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mockJson(payload: unknown, status = 200): void {
  const response = () =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  vi.spyOn(globalThis, 'fetch').mockImplementation(response as typeof fetch);
}

/** Routes each endpoint to its own shape so the shell exercises real contracts. */
function mockApi(routes: Record<string, unknown>): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const key = Object.keys(routes).find((route) => url.includes(route));
    const payload = key ? routes[key] : {};
    return Promise.resolve(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  }) as typeof fetch);
}

async function render(container: HTMLElement) {
  const root = createRoot(container);
  await React.act(async () => {
    root.render(<App />);
  });
  return {
    async unmount() {
      await React.act(async () => {
        root.unmount();
      });
    },
  };
}

function viewport(width: number): HTMLElement {
  const container = document.createElement('div');
  container.style.width = `${width}px`;
  container.style.minHeight = '640px';
  container.style.overflowX = 'auto';
  document.body.appendChild(container);
  return container;
}

describe('Signed-out entry', () => {
  beforeEach(() => {
    mockJson({ status: 'ok' }, 401);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows one title and one Google action, with no health badge', async () => {
    const container = viewport(360);
    const app = await render(container);

    expect(container.textContent).toContain('Sign in to Otis');
    const buttons = Array.from(container.querySelectorAll('button'));
    const google = buttons.filter((button) => button.textContent?.includes('Google'));
    expect(google).toHaveLength(1);
    expect(container.textContent).not.toContain('Connected');
    expect(container.textContent).not.toContain('firebase');

    await app.unmount();
    document.body.removeChild(container);
  });
});

describe('Loading entry', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((() => new Promise(() => {})) as typeof fetch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the loading threshold inside the landmark', async () => {
    const container = viewport(360);
    const app = await render(container);

    expect(container.querySelector('main.otis-entry')?.textContent).toContain('Loading');

    await app.unmount();
    document.body.removeChild(container);
  });
});

describe('Conversation shell', () => {
  beforeEach(() => {
    mockApi({
      '/api/me': {
        user: {
          id: 'usr_1',
          firebase_uid: 'fb',
          email: null,
          display_name: 'Avi',
          created_at: '',
          updated_at: '',
        },
        workspaces: [{ id: 'ws_1', name: 'Kerning', role: 'owner', joined_at: '' }],
      },
      '/api/commands': {
        surface: 'web',
        commands: [
          { name: 'model', summary: 'Show or set the model for this chat.', usage: '/model', available: true, deterministic: true },
        ],
      },
      '/chats': { chats: [], next_cursor: undefined },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the conversation without horizontal overflow at 360px', async () => {
    const container = viewport(360);
    const app = await render(container);
    await React.act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('.otis-topbar')).toBeTruthy();
    expect(container.querySelector('.otis-composer')).toBeTruthy();
    // Conversation-led, not a centered panel reduced to phone width.
    expect(container.querySelector('.otis-transcript')).toBeTruthy();
    expect(container.scrollWidth).toBeLessThanOrEqual(360);

    await app.unmount();
    document.body.removeChild(container);
  });

  it('renders the same composition at desktop width without overflow', async () => {
    const container = viewport(1280);
    const app = await render(container);
    await React.act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('.otis-shell')).toBeTruthy();
    expect(container.scrollWidth).toBeLessThanOrEqual(1280);

    await app.unmount();
    document.body.removeChild(container);
  });
});

describe('Sign-out session revoke', () => {
  const ME = {
    user: {
      id: 'usr_1',
      firebase_uid: 'fb',
      email: null,
      display_name: 'Avi',
      created_at: '',
      updated_at: '',
    },
    workspaces: [],
  };

  function mockSession(deleteImpl: () => Promise<Response>) {
    const seen: { method: string; url: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (typeof input === 'string' ? 'GET' : input.method);
      if (url.includes('/api/auth/session') && method === 'DELETE') {
        seen.push({ method, url });
        return deleteImpl();
      }
      if (url.includes('/api/me')) {
        return new Response(JSON.stringify(ME), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch);
    return seen;
  }

  function jsonOk(payload: unknown): Response {
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetOutboxForTests();
  });

  async function signOutFromEmptyWorkspace(container: HTMLElement) {
    const signOutBtn = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Sign out',
    ) as HTMLButtonElement;
    expect(signOutBtn).toBeTruthy();
    await React.act(async () => {
      signOutBtn.click();
      await Promise.resolve();
    });
  }

  it('revokes the server session with DELETE and cleans locally without a notice', async () => {
    const seen = mockSession(async () => jsonOk({ status: 'ok' }));
    const kept = createOutboxEntry({ userId: 'usr_1', workspaceId: 'ws_1', chatId: 'chat_1', text: 'pending' });
    expect(entriesForUser('usr_1').map((entry) => entry.clientId)).toEqual([kept.clientId]);

    const container = viewport(360);
    const app = await render(container);
    await React.act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Create your workspace');

    await signOutFromEmptyWorkspace(container);
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(seen).toHaveLength(1);
    expect(entriesForUser('usr_1')).toHaveLength(0);
    expect(container.textContent).toContain('Sign in to Otis');
    expect(container.textContent).not.toContain('may still hold it');

    await app.unmount();
    document.body.removeChild(container);
    resetOutboxForTests();
  });

  it('cleans locally and reports truthfully when the server revoke fails', async () => {
    mockSession(async () => {
      throw new TypeError('offline');
    });
    createOutboxEntry({ userId: 'usr_1', workspaceId: 'ws_1', chatId: 'chat_1', text: 'pending' });

    const container = viewport(360);
    const app = await render(container);
    await React.act(async () => {
      await Promise.resolve();
    });

    await signOutFromEmptyWorkspace(container);
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(entriesForUser('usr_1')).toHaveLength(0);
    expect(container.textContent).toContain('Sign in to Otis');
    expect(container.textContent).toContain('may still hold it');

    await app.unmount();
    document.body.removeChild(container);
    resetOutboxForTests();
  });

  it('bounds a hung server revoke instead of blocking local cleanup', async () => {
    vi.useFakeTimers();
    try {
      // A hung connection still settles: like a real fetch, the mock
      // rejects once the deadline aborts the signal.
      vi.spyOn(globalThis, 'fetch').mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/me')) {
          return Promise.resolve(jsonOk(ME));
        }
        return new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(init.signal.reason);
            return;
          }
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        });
      }) as typeof fetch);
      createOutboxEntry({ userId: 'usr_1', workspaceId: 'ws_1', chatId: 'chat_1', text: 'pending' });

      const container = viewport(360);
      const app = await render(container);
      await React.act(async () => {
        await Promise.resolve();
      });

      await signOutFromEmptyWorkspace(container);
      await React.act(async () => {
        await vi.advanceTimersByTimeAsync(SIGN_OUT_SERVER_TIMEOUT_MS);
      });
      await React.act(async () => {});

      expect(entriesForUser('usr_1')).toHaveLength(0);
      expect(container.textContent).toContain('Sign in to Otis');
      expect(container.textContent).toContain('may still hold it');

      await app.unmount();
      document.body.removeChild(container);
      resetOutboxForTests();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('index.html', () => {
  it('keeps a zoomable viewport', () => {
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');
    expect(html).toContain('name="viewport"');
    expect(html).not.toContain('user-scalable=no');
    expect(html).not.toContain('maximum-scale=1.0');
    expect(html).toContain('width=device-width');
  });

  it('keeps the pre-CSS boot shell on token values', () => {
    // Inline literals are the only paint before globals.css loads, so they
    // must copy the tokens exactly: canvas background, subtle metadata text,
    // destructive red, dynamic viewport height with a legacy fallback.
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');
    expect(html).toContain('background:#181818');
    expect(html).toContain('color:#8c8c8c');
    expect(html).toContain('color:#ff9c9c');
    expect(html).toContain('min-height:100dvh');
    expect(html).not.toContain('#f87171');
    expect(html).not.toContain('#242424');
  });
});