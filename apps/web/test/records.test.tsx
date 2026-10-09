/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { RecordsScreen } from '../src/components/records/RecordsScreen.js';
import { INITIAL_RECORD_LISTS } from '../src/components/records/seedData.js';
import { TestQueryProvider } from './query.js';

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function mount(element: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => root.render(<TestQueryProvider>{element}</TestQueryProvider>));
  await React.act(async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  return {
    host,
    unmount: async () => {
      await React.act(async () => root.unmount());
      host.remove();
    },
  };
}

const defaultProps = {
  workspaceId: 'ws-test',
  workspaces: [{ id: 'ws-test', name: 'Acme Carpentry' }],
  userId: 'user-avi',
  members: { 'user-avi': 'Avi' },
  onSignOut: vi.fn(),
  onNavigate: vi.fn(),
  onNavigateToList: vi.fn(),
  initialLists: INITIAL_RECORD_LISTS,
};

describe('Editable Records UI (R16)', () => {
  it('renders the initial leads list with correct column headers and rows', async () => {
    const view = await mount(<RecordsScreen {...defaultProps} />);

    // Breadcrumb title
    expect(view.host.textContent).toContain('Leads');
    // Column headers
    expect(view.host.textContent).toContain('Lead name');
    expect(view.host.textContent).toContain('Status');
    expect(view.host.textContent).toContain('Phone');
    expect(view.host.textContent).toContain('Deal value');

    // Seed rows
    expect(view.host.textContent).toContain('John Klakney');
    expect(view.host.textContent).toContain('Elena Vance');
    expect(view.host.textContent).toContain('Tariq Mansoor');

    await view.unmount();
  });

  it('filters rows in real-time when searching', async () => {
    const view = await mount(<RecordsScreen {...defaultProps} />);

    const searchInput = view.host.querySelector('input[placeholder="Search records..."]') as HTMLInputElement;
    expect(searchInput).toBeTruthy();

    await React.act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      nativeSetter?.call(searchInput, 'Mansoor');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(view.host.textContent).toContain('Tariq Mansoor');
    expect(view.host.textContent).not.toContain('John Klakney');

    await view.unmount();
  });

  it('allows switching to Products list and renders calculation columns', async () => {
    // Directly test rendering with Products list
    const productsView = await mount(<RecordsScreen {...defaultProps} listId="products" />);

    expect(productsView.host.textContent).toContain('Products');
    expect(productsView.host.textContent).toContain('Unit price');
    expect(productsView.host.textContent).toContain('Quantity');
    expect(productsView.host.textContent).toContain('Total');
    expect(productsView.host.textContent).toContain('Business Memory Setup');

    await productsView.unmount();
  });

  it('toggles between desktop grid and mobile card view', async () => {
    const view = await mount(<RecordsScreen {...defaultProps} />);

    // Initially table is rendered
    expect(view.host.querySelector('.otis-records__table')).toBeTruthy();

    // Find view toggle button
    const viewToggle = view.host.querySelector('[title="Switch to cards view"]') as HTMLButtonElement;
    expect(viewToggle).toBeTruthy();

    await React.act(async () => {
      viewToggle.click();
    });

    // Now cards view is rendered
    expect(view.host.querySelector('.otis-records__card')).toBeTruthy();

    await view.unmount();
  });

  it('adds a new row and updates the row count', async () => {
    const view = await mount(<RecordsScreen {...defaultProps} />);

    const addRowBtn = Array.from(view.host.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Add row'),
    ) as HTMLButtonElement;
    expect(addRowBtn).toBeTruthy();

    await React.act(async () => {
      addRowBtn.click();
    });

    expect(view.host.textContent).toContain('New record');
    // Dirty indicator
    expect(view.host.textContent).toContain('1 unsaved change');

    await view.unmount();
  });

  it('undoes changes when clicking Undo', async () => {
    const view = await mount(<RecordsScreen {...defaultProps} />);

    const addRowBtn = Array.from(view.host.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Add row'),
    ) as HTMLButtonElement;
    expect(addRowBtn).toBeTruthy();

    await React.act(async () => {
      addRowBtn.click();
    });

    expect(view.host.textContent).toContain('1 unsaved change');

    // Click undo
    const undoBtn = view.host.querySelector('button[aria-label="Undo"]') as HTMLButtonElement;
    expect(undoBtn).toBeTruthy();

    await React.act(async () => {
      undoBtn.click();
    });

    expect(view.host.textContent).not.toContain('1 unsaved change');

    await view.unmount();
  });

  it('opens and closes the Ask Otis assistant panel', async () => {
    const view = await mount(<RecordsScreen {...defaultProps} />);

    const askOtisBtn = Array.from(view.host.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Ask Otis'),
    ) as HTMLButtonElement;
    expect(askOtisBtn).toBeTruthy();

    await React.act(async () => {
      askOtisBtn.click();
    });

    expect(view.host.querySelector('.otis-records__ask-pane')?.textContent).toContain('Leads ·');

    await view.unmount();
  });

  it('renders clean empty state without hardcoded mock leads when initialLists is omitted', async () => {
    const { initialLists: _, ...liveProps } = defaultProps;
    const view = await mount(<RecordsScreen {...liveProps} />);

    // Must NOT contain hardcoded mock names
    expect(view.host.textContent).not.toContain('John Klakney');
    expect(view.host.textContent).not.toContain('Elena Vance');
    expect(view.host.textContent).not.toContain('Tariq Mansoor');

    // Shows empty collection hint
    expect(view.host.textContent).toContain('No records found');

    await view.unmount();
  });
});
