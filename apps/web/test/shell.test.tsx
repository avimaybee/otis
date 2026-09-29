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

  it('renders Daybook shell into 360px mobile viewport without throwing', async () => {
    const container = document.createElement('div');
    container.style.width = '360px';
    container.style.minHeight = '640px';
    document.body.appendChild(container);

    const root = createRoot(container);
    await React.act(async () => {
      root.render(<App />);
    });

    expect(container.querySelector('h1')?.textContent).toBe('Daybook');

    await React.act(async () => {
      root.unmount();
    });
    document.body.removeChild(container);
  });
});
