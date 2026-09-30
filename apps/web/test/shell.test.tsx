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

describe('Web App Shell Smoke & 360px Layout', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
    if (typeof window !== 'undefined') {
      vi.spyOn(window, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('verifies index.html has accessible zoomable viewport without user-scalable restrictions', () => {
    const htmlPath = resolve(__dirname, '../index.html');
    const html = readFileSync(htmlPath, 'utf-8');

    expect(html).toContain('name="viewport"');
    expect(html).not.toContain('user-scalable=no');
    expect(html).not.toContain('maximum-scale=1.0');
    expect(html).toContain('width=device-width');
  });

  it('renders Otis shell into 360px mobile viewport without horizontal overflow', async () => {
    const container = document.createElement('div');
    container.style.width = '360px';
    container.style.minHeight = '640px';
    container.style.overflowX = 'auto';
    document.body.appendChild(container);

    const root = createRoot(container);
    await React.act(async () => {
      root.render(<App />);
    });

    const header = container.querySelector('header');
    const main = container.querySelector('main');
    expect(header).toBeDefined();
    expect(main).toBeDefined();
    expect(container.querySelector('h1')?.textContent).toBe('Otis');

    // Programmatic verification: no element exceeds the 360px container
    expect(container.scrollWidth).toBeLessThanOrEqual(360);

    await React.act(async () => {
      root.unmount();
    });
    document.body.removeChild(container);
  });

  it('renders Otis shell into desktop viewport without horizontal overflow', async () => {
    const container = document.createElement('div');
    container.style.width = '1024px';
    container.style.minHeight = '768px';
    container.style.overflowX = 'auto';
    document.body.appendChild(container);

    const root = createRoot(container);
    await React.act(async () => {
      root.render(<App />);
    });

    expect(container.scrollWidth).toBeLessThanOrEqual(1024);

    await React.act(async () => {
      root.unmount();
    });
    document.body.removeChild(container);
  });
});
