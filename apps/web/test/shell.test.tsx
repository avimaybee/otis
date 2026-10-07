/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/App.js';
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

describe('index.html', () => {
  it('keeps a zoomable viewport', () => {
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');
    expect(html).toContain('name="viewport"');
    expect(html).not.toContain('user-scalable=no');
    expect(html).not.toContain('maximum-scale=1.0');
    expect(html).toContain('width=device-width');
  });
});