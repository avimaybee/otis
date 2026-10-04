/** @vitest-environment happy-dom */
/**
 * 009A guided Telegram linking UI: bounded refresh proof with fake timers.
 * Synthetic fetch only; no real bot, link or network. Proves the UX
 * promises: one read on open, at most 24 automatic checks per link within
 * two minutes at a five-second cadence, paused while hidden with one
 * coalesced foreground refresh, no overlap, no idle polling, and Connected
 * only from a server binding response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TelegramConnection } from '../src/components/TelegramConnection.js';

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const DISCONNECTED = { status: 'ok', available: true, state: 'disconnected', routing_workspace: null, connections: [] };
const CONNECTED = {
  status: 'ok',
  available: true,
  state: 'connected',
  routing_workspace: { id: 'ws-1', name: 'Kerning' },
  connections: [{ routing_workspace: { id: 'ws-1', name: 'Kerning' } }],
};
const LINK = { status: 'ok', deep_link: 'https://t.me/otis_test_bot?start=synthetic_code', expires_at: new Date(Date.now() + 600_000).toISOString() };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface FetchStub {
  calls: Array<{ url: string; method: string }>;
  connection: () => Promise<Response> | Response;
  link?: () => Promise<Response> | Response;
  disconnect?: () => Promise<Response> | Response;
}

function installFetch(stub: FetchStub): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      stub.calls.push({ url, method });
      if (url.includes('/telegram/connection') && method === 'GET') return stub.connection();
      if (url.includes('/telegram/connection') && method === 'DELETE') {
        return stub.disconnect ? stub.disconnect() : json({ status: 'ok', state: 'disconnected' });
      }
      if (url.includes('/telegram/link') && method === 'POST') {
        return stub.link ? stub.link() : json(LINK);
      }
      return json({ error: { code: 'not_found', message: 'no stub' } }, 404);
    }),
  );
}

async function mount(workspaceId = 'ws-1') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = async (id: string) => {
    await React.act(async () => root.render(<TelegramConnection workspaceId={id} workspaceName="Kerning" />));
  };
  await render(workspaceId);
  return {
    host,
    rerender: render,
    click: async (text: string) => {
      const button = Array.from(host.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text));
      if (!button) throw new Error(`button '${text}' not found in: ${host.textContent}`);
      await React.act(async () => {
        button.click();
      });
    },
    anchor: () => host.querySelector('a') as HTMLAnchorElement | null,
    unmount: async () => {
      await React.act(async () => root.unmount());
      host.remove();
    },
  };
}

async function advance(ms: number): Promise<void> {
  await React.act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('TelegramConnection', () => {
  it('reads once on open and never polls an idle disconnected row', async () => {
    const stub: FetchStub = { calls: [], connection: () => json(DISCONNECTED) };
    installFetch(stub);
    const view = await mount();
    expect(view.host.textContent).toContain('Message Otis from Telegram. Your messages are saved in Kerning.');
    // Established 44px hit-area recipe, applied locally to this row.
    expect(view.host.querySelector('button')?.className).toContain('otis-button');
    await advance(10 * 60_000);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.method).toBe('GET');
    await view.unmount();
  });

  it('bounds waiting refresh to 24 checks / two minutes, keeps the link in memory only', async () => {
    const stub: FetchStub = { calls: [], connection: () => json(DISCONNECTED) };
    installFetch(stub);
    const view = await mount();
    await view.click('Connect Telegram');
    const linkCalls = stub.calls.filter((call) => call.method === 'POST');
    expect(linkCalls).toHaveLength(1);
    expect(view.host.textContent).toContain('Open Telegram, then tap Start to connect your account.');
    expect(view.host.textContent).toContain('This link expires in 10 minutes.');
    expect(view.anchor()?.href).toBe(LINK.deep_link);
    expect(view.anchor()?.rel).toContain('noopener');
    // The anchor uses the neutral button treatment: same 44px recipe, no
    // global link underlining.
    expect(view.anchor()?.className).toContain('otis-button');
    expect(window.localStorage.length).toBe(0);

    await advance(120_000);
    const baseline = 1; // the single read on open, before the link existed
    const checks = stub.calls.filter((call) => call.method === 'GET').length;
    expect(checks - baseline).toBe(24);
    // After the window, no spinning: manual controls remain.
    await advance(60_000);
    expect(stub.calls.filter((call) => call.method === 'GET').length - baseline).toBe(24);
    expect(view.host.textContent).toContain('I\u2019ve tapped Start');
    await view.unmount();
  });

  it('pauses automatic checks while hidden and coalesces foreground focus', async () => {
    const stub: FetchStub = { calls: [], connection: () => json(DISCONNECTED) };
    installFetch(stub);
    const view = await mount();
    await view.click('Connect Telegram');

    const defineVisibility = (value: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { value, configurable: true });
      Object.defineProperty(document, 'hidden', { value: value === 'hidden', configurable: true });
    };
    const before = stub.calls.filter((call) => call.method === 'GET').length;
    defineVisibility('hidden');
    await advance(30_000);
    expect(stub.calls.filter((call) => call.method === 'GET').length).toBe(before);

    // Returning to the foreground performs a coalesced refresh; any
    // environment-emitted visibility event plus an explicit one during an
    // in-flight request must not stack unbounded.
    let release: (() => void) | null = null;
    stub.connection = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(json(DISCONNECTED));
      });
    defineVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(0);
    await advance(0);
    const inFlightStart = stub.calls.filter((call) => call.method === 'GET').length;
    expect(inFlightStart).toBeGreaterThan(before); // one foreground refresh
    expect(inFlightStart).toBeLessThanOrEqual(before + 2);
    expect(release).toBeTruthy(); // the refresh is still in flight (gated)

    // Two more focus events during the in-flight request coalesce: no new
    // request starts while it is pending, and exactly one follow-up runs.
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(0);
    expect(stub.calls.filter((call) => call.method === 'GET').length).toBe(inFlightStart);
    await React.act(async () => {
      release!();
      await Promise.resolve();
    });
    await advance(0);
    expect(stub.calls.filter((call) => call.method === 'GET').length).toBe(inFlightStart + 1);
    await view.unmount();
  });

  it('never claims Connected before the server binding proves it', async () => {
    const stub: FetchStub = { calls: [], connection: () => json(DISCONNECTED) };
    installFetch(stub);
    const view = await mount();
    await view.click('Connect Telegram');
    await view.click('I\u2019ve tapped Start');
    expect(view.host.textContent).toContain('Not connected yet. Open Telegram and tap Start.');
    expect(view.host.textContent).not.toContain('Connected to Telegram.');
    expect(view.anchor()).not.toBeNull();

    // A failed check keeps the valid link and the check action.
    stub.connection = () => json({ error: { code: 'internal_error', message: 'synthetic' } }, 500);
    await view.click('I\u2019ve tapped Start');
    expect(view.host.textContent).toContain('Couldn\u2019t check the connection. You can still finish in Telegram, then try again.');
    expect(view.anchor()).not.toBeNull();
    await view.unmount();
  });

  it('shows Connected only with the real routing workspace, stops polling, and disconnects in place', async () => {
    const stub: FetchStub = { calls: [], connection: () => json(CONNECTED) };
    installFetch(stub);
    const view = await mount();
    expect(view.host.textContent).toContain('Connected to Telegram.');
    expect(view.host.textContent).toContain('Messages go to Kerning.');
    const checks = stub.calls.filter((call) => call.method === 'GET').length;
    await advance(300_000);
    expect(stub.calls.filter((call) => call.method === 'GET').length).toBe(checks);

    stub.disconnect = () => json({ status: 'ok', state: 'disconnected' });
    await view.click('Disconnect');
    expect(stub.calls.some((call) => call.method === 'DELETE')).toBe(true);
    expect(view.host.textContent).toContain('Disconnected. You can reconnect anytime.');
    await view.unmount();
  });

  it('keeps the verified prior state when disconnect fails', async () => {
    const stub: FetchStub = { calls: [], connection: () => json(CONNECTED) };
    installFetch(stub);
    stub.disconnect = () => json({ error: { code: 'internal_error', message: 'synthetic' } }, 500);
    const view = await mount();
    await view.click('Disconnect');
    expect(view.host.textContent).toContain('Connected to Telegram.');
    expect(view.host.textContent).toContain('Could not disconnect Telegram. Try again.');
    expect(view.host.textContent).not.toContain('Disconnected. You can reconnect anytime.');
    await view.unmount();
  });

  it('reports unavailable without an active Connect button and shows a link failure with retry', async () => {
    const stub: FetchStub = { calls: [], connection: () => json({ ...DISCONNECTED, available: false }) };
    installFetch(stub);
    const view = await mount();
    expect(view.host.textContent).toContain('Telegram isn\u2019t available yet.');
    expect(view.host.textContent).not.toContain('Connect Telegram');
    await view.unmount();

    const failing: FetchStub = { calls: [], connection: () => json(DISCONNECTED), link: () => json({ error: { code: 'internal_error', message: 'x' } }, 500) };
    installFetch(failing);
    const second = await mount();
    await second.click('Connect Telegram');
    expect(second.host.textContent).toContain('Couldn\u2019t prepare the Telegram link. Try again.');
    expect(second.host.textContent).toContain('Connect Telegram');
    await second.unmount();
  });

  it('expires the link on time even when no status check ever completes', async () => {
    const stub: FetchStub = {
      calls: [],
      connection: () => json(DISCONNECTED),
      link: () => json({ ...LINK, expires_at: new Date(Date.now() + 30_000).toISOString() }),
    };
    installFetch(stub);
    const view = await mount();
    await view.click('Connect Telegram');
    expect(view.host.textContent).toContain('Open Telegram, then tap Start to connect your account.');

    // Checks hang forever: only the expiry timer can transition the row.
    stub.connection = () => new Promise<Response>(() => {});
    await advance(30_001);
    expect(view.host.textContent).toContain('This link expired. Get a new link to continue.');
    expect(view.host.textContent).toContain('Get a new link');
    await view.unmount();
  });

  it('drops stale async responses when the workspace changes', async () => {
    let releaseStatus: (() => void) | null = null;
    let releaseLink: (() => void) | null = null;
    const stub: FetchStub = {
      calls: [],
      connection: () =>
        new Promise<Response>((resolve) => {
          releaseStatus = () => resolve(json(CONNECTED));
        }),
      link: () =>
        new Promise<Response>((resolve) => {
          releaseLink = () => resolve(json(LINK));
        }),
    };
    installFetch(stub);
    const view = await mount('ws-1');

    // The old workspace's status response lands after switching: it must not
    // paint "Connected" for the new workspace.
    stub.connection = () => json(DISCONNECTED);
    await view.rerender('ws-2');
    expect(releaseStatus).toBeTruthy();
    await React.act(async () => {
      releaseStatus!();
      await Promise.resolve();
    });
    await advance(0);
    expect(view.host.textContent).not.toContain('Connected to Telegram.');
    expect(view.host.textContent).toContain('Message Otis from Telegram. Your messages are saved in Kerning.');

    // A stale issuer response must not produce a link for the new workspace.
    await view.click('Connect Telegram');
    expect(releaseLink).toBeTruthy();
    await view.rerender('ws-3');
    await React.act(async () => {
      releaseLink!();
      await Promise.resolve();
    });
    await advance(0);
    expect(view.host.textContent).not.toContain('Open Telegram, then tap Start');
    await view.unmount();
  });

  it('a hung old-workspace check cannot block a new workspace link', async () => {
    let hangResolve: (() => void) | null = null;
    const stub: FetchStub = { calls: [], connection: () => json(DISCONNECTED), link: () => json(LINK) };
    installFetch(stub);
    const view = await mount('ws-1');
    await view.click('Connect Telegram');
    stub.connection = () =>
      new Promise<Response>((resolve) => {
        hangResolve = () => resolve(json(DISCONNECTED));
      });
    await view.click('I\u2019ve tapped Start');
    await advance(0);
    expect(hangResolve).toBeTruthy();

    // Workspace switch while the old check hangs: the new ready row must
    // still be able to check and reach Connected.
    stub.connection = () => json(DISCONNECTED);
    await view.rerender('ws-2');
    for (let i = 0; i < 6; i += 1) {
      await React.act(async () => {
        await Promise.resolve();
      });
      await advance(0);
      const ready = Array.from(view.host.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Connect Telegram'),
      );
      if (ready) break;
    }
    await view.click('Connect Telegram');
    stub.connection = () => json(CONNECTED);
    await view.click('I\u2019ve tapped Start');
    await advance(0);
    expect(view.host.textContent).toContain('Connected to Telegram.');
    await React.act(async () => {
      hangResolve!();
      await Promise.resolve();
    });
    await view.unmount();
  });

  it('keeps the Open Telegram anchor on the approved primary contrast without underline', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const indexCss = readFileSync(join(root, 'apps/web/src/index.css'), 'utf8');
    const anchorRule = /a\.otis-button[^{]*\{([^}]*)\}/.exec(indexCss)?.[1] ?? '';
    expect(anchorRule).toContain('text-decoration: none');
    // The primary-foreground utility must own the color: a local color
    // override regressed the rendered contrast once already.
    expect(anchorRule).not.toContain('color');

    const tokens = readFileSync(join(root, 'apps/web/src/globals.css'), 'utf8');
    const token = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(tokens)?.[1]?.trim() ?? '';
    const toRgb = (value: string): [number, number, number] | null => {
      const hex = /^#([0-9a-f]{6})$/i.exec(value);
      if (hex) {
        const n = parseInt(hex[1]!, 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      }
      const rgb = /rgba?\(([^)]+)\)/i.exec(value);
      if (rgb) {
        const parts = rgb[1]!.split(',').map((part) => parseFloat(part));
        return [parts[0]!, parts[1]!, parts[2]!];
      }
      return null;
    };
    const luminance = ([r, g, b]: [number, number, number]) => {
      const f = (channel: number) => {
        const s = channel / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const primary = toRgb(token('--primary'));
    const primaryForeground = toRgb(token('--primary-foreground'));
    expect(primary).toBeTruthy();
    expect(primaryForeground).toBeTruthy();
    const [lighter, darker] = [luminance(primary!), luminance(primaryForeground!)].sort((a, b) => b - a);
    expect((lighter + 0.05) / (darker + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});
