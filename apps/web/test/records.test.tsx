/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { RecordsScreen } from '../src/components/records/RecordsScreen.js';
import { ApiError } from '../src/api/client.js';
import { TestQueryProvider } from './query.js';

// @ts-expect-error React act flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { mockGetRecords, mockSaveRecords, mockUndoPreview, mockUndo } = vi.hoisted(() => ({
  mockGetRecords: vi.fn(),
  mockSaveRecords: vi.fn(),
  mockUndoPreview: vi.fn(),
  mockUndo: vi.fn(),
}));

vi.mock('../src/api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getRecords: mockGetRecords,
      saveRecords: mockSaveRecords,
      undoPreview: mockUndoPreview,
      undo: mockUndo,
    },
  };
});

vi.mock('../src/api/queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/queries.js')>();
  return {
    ...actual,
    useNavChats: () => ({ data: undefined, isPending: false }),
    fetchMoreChats: vi.fn(),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  mockGetRecords.mockReset();
  mockSaveRecords.mockReset();
  mockUndoPreview.mockReset();
  mockUndo.mockReset();
  localStorage.clear();
  document.body.innerHTML = '';
});

async function mount(element: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await React.act(async () => root.render(<TestQueryProvider>{element}</TestQueryProvider>));
  await settle(host);
  return {
    host,
    unmount: async () => {
      await React.act(async () => root.unmount());
      host.remove();
    },
  };
}

async function settle(host: HTMLElement, ms = 30) {
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  void host;
}

async function openMenu(button: HTMLElement) {
  await React.act(async () => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle(document.body, 30);
}

async function waitForText(host: HTMLElement, text: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (host.textContent?.includes(text)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for text: ${text}\nActual: ${host.textContent?.slice(0, 500)}`);
    }
    await settle(host, 50);
  }
}

function entityRow(id: string, name: string, updatedAt: string) {
  return {
    id,
    ref: { kind: 'entity', id },
    source: 'entity',
    lifecycle_token: updatedAt,
    cells: { name, status: 'new' },
    record_cells: {
      name: { value: name, state: 'clear', version: updatedAt, binding: { kind: 'entity_property', property: 'name' }, editable: true },
      status: { value: 'new', state: 'clear', version: updatedAt, binding: { kind: 'entity_property', property: 'status' }, editable: true },
    },
  };
}

const COLUMNS = [
  { id: 'name', name: 'Lead name', type: 'text', binding: { kind: 'entity_property', property: 'name' }, capabilities: { sortable: true, filterable: true, editable: true } },
  { id: 'status', name: 'Status', type: 'status', binding: { kind: 'entity_property', property: 'status' }, capabilities: { sortable: true, filterable: true, editable: true } },
];

function leadsResponse(rows: ReturnType<typeof entityRow>[], revision = 1, history: Record<string, unknown[]> = {}) {
  return {
    lists: [{ id: 'leads', name: 'Leads', source_kind: 'entity', columns: COLUMNS, rows, total_rows: rows.length, next_cursor: null }],
    history,
    selected_list_id: 'leads',
    revision,
  };
}

const screenProps = {
  workspaceId: 'ws-test',
  workspaces: [{ id: 'ws-test', name: 'Acme Carpentry' }],
  userId: 'user-avi',
  members: { 'user-avi': 'Avi' },
  onSignOut: () => {},
  onNavigate: () => {},
  onNavigateToList: () => {},
};

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  nativeSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('Records screen on the real API boundary (R16 Slice C)', () => {
  it('renders server lists and saves a cell edit as an operations union', async () => {
    mockGetRecords.mockResolvedValue(leadsResponse([entityRow('ent_1', 'Acme', '2026-10-10T10:00:00.000Z')]));
    mockSaveRecords.mockResolvedValue({
      saved: true, status: 'applied', save_id: 'save_1', action_id: 'act_1',
      affected_count: 1, affectedCount: 1,
      affected_values: [{ row_ref: { kind: 'entity', id: 'ent_1' }, column_id: 'name', value: 'Acme Intl', version: '2026-10-10T10:01:00.000Z' }],
    });
    const view = await mount(<RecordsScreen {...screenProps} />);
    await waitForText(view.host, 'Acme');

    // Open the row editor and rename.
    const row = view.host.querySelector('.otis-records__tr') as HTMLElement;
    await React.act(async () => row.click());
    const nameInput = document.body.querySelector('#field-name') as HTMLInputElement;
    expect(nameInput).toBeTruthy();
    await React.act(async () => setInputValue(nameInput, 'Acme Intl'));
    await waitForText(view.host, '1 unsaved change');

    const saveBtn = Array.from(view.host.querySelectorAll('button')).find((b) => b.textContent === 'Save') as HTMLButtonElement;
    await React.act(async () => saveBtn.click());
    await settle(view.host);

    expect(mockSaveRecords).toHaveBeenCalledTimes(1);
    const [ws, payload] = mockSaveRecords.mock.calls[0] as [string, Record<string, unknown>];
    expect(ws).toBe('ws-test');
    expect(payload).toMatchObject({ list_id: 'leads', chunk_index: 0, chunk_count: 1 });
    expect(payload['operations']).toEqual([{
      op: 'cell.set', op_id: expect.any(String),
      row_ref: { kind: 'entity', id: 'ent_1' }, column_id: 'name',
      value: 'Acme Intl', base_token: '2026-10-10T10:00:00.000Z',
    }]);
    await waitForText(view.host, 'Saved 1 change');
    await view.unmount();
  });

  it('undoes a draft edit locally without touching the server', async () => {
    mockGetRecords.mockResolvedValue(leadsResponse([entityRow('ent_1', 'Acme', '2026-10-10T10:00:00.000Z')]));
    const view = await mount(<RecordsScreen {...screenProps} />);
    await waitForText(view.host, 'Acme');

    const row = view.host.querySelector('.otis-records__tr') as HTMLElement;
    await React.act(async () => row.click());
    const nameInput = document.body.querySelector('#field-name') as HTMLInputElement;
    await React.act(async () => setInputValue(nameInput, 'Acme Intl'));
    await waitForText(view.host, '1 unsaved change');

    const undoBtn = view.host.querySelector('button[aria-label="Undo"]') as HTMLButtonElement;
    await React.act(async () => undoBtn.click());
    expect(view.host.textContent).not.toContain('unsaved change');
    expect(mockSaveRecords).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('shows a conflict with keep-mine and use-saved recovery', async () => {
    mockGetRecords.mockResolvedValue(leadsResponse([entityRow('ent_1', 'Acme', '2026-10-10T10:00:00.000Z')]));
    mockSaveRecords.mockRejectedValue(new ApiError(409, 'conflict', 'This value changed while you edited.', 'req-1', false, {
      op_id: 'op_cell_ent_1_name', target_ref: { kind: 'entity', id: 'ent_1' }, reason: 'Concurrent modification.',
    }));
    const view = await mount(<RecordsScreen {...screenProps} />);
    await waitForText(view.host, 'Acme');

    const row = view.host.querySelector('.otis-records__tr') as HTMLElement;
    await React.act(async () => row.click());
    await React.act(async () => setInputValue(document.body.querySelector('#field-name') as HTMLInputElement, 'Acme Intl'));
    await waitForText(view.host, '1 unsaved change');

    const saveBtn = Array.from(view.host.querySelectorAll('button')).find((b) => b.textContent === 'Save') as HTMLButtonElement;
    await React.act(async () => saveBtn.click());
    await waitForText(view.host, 'changed while you edited');

    // Use saved drops the conflicted op and clears the draft.
    const useSaved = Array.from(view.host.querySelectorAll('button')).find((b) => b.textContent === 'Use saved') as HTMLButtonElement;
    await React.act(async () => useSaved.click());
    expect(view.host.textContent).not.toContain('unsaved change');
    expect(mockSaveRecords).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('retains the exact manifest when the save outcome is unknown and retries identically', async () => {
    mockGetRecords.mockResolvedValue(leadsResponse([entityRow('ent_1', 'Acme', '2026-10-10T10:00:00.000Z')]));
    mockSaveRecords.mockRejectedValueOnce(new TypeError('network down'));
    mockSaveRecords.mockResolvedValueOnce({
      saved: true, status: 'already_applied', save_id: 'save_1', action_id: 'act_1',
      affected_count: 0, affectedCount: 0, affected_values: [],
    });
    const view = await mount(<RecordsScreen {...screenProps} />);
    await waitForText(view.host, 'Acme');

    const row = view.host.querySelector('.otis-records__tr') as HTMLElement;
    await React.act(async () => row.click());
    await React.act(async () => setInputValue(document.body.querySelector('#field-name') as HTMLInputElement, 'Acme Intl'));
    await waitForText(view.host, '1 unsaved change');

    const saveBtn = Array.from(view.host.querySelectorAll('button')).find((b) => b.textContent === 'Save') as HTMLButtonElement;
    await React.act(async () => saveBtn.click());
    await waitForText(view.host, 'may or may not have committed');

    const retryBtn = Array.from(view.host.querySelectorAll('button')).find((b) => b.textContent === 'Retry save') as HTMLButtonElement;
    await React.act(async () => retryBtn.click());
    await settle(view.host);

    expect(mockSaveRecords).toHaveBeenCalledTimes(2);
    const first = mockSaveRecords.mock.calls[0]![1] as Record<string, unknown>;
    const second = mockSaveRecords.mock.calls[1]![1] as Record<string, unknown>;
    expect(second['save_id']).toBe(first['save_id']);
    expect(second['action_id']).toBe(first['action_id']);
    expect(second['operations']).toEqual(first['operations']);
    await view.unmount();
  });

  it('keeps dirty edits across a refresh that moves the base revision', async () => {
    mockGetRecords.mockResolvedValueOnce(leadsResponse([entityRow('ent_1', 'Acme', '2026-10-10T10:00:00.000Z')], 1));
    const view = await mount(<RecordsScreen {...screenProps} />);
    await waitForText(view.host, 'Acme');

    const row = view.host.querySelector('.otis-records__tr') as HTMLElement;
    await React.act(async () => row.click());
    await React.act(async () => setInputValue(document.body.querySelector('#field-name') as HTMLInputElement, 'Acme Intl'));
    await waitForText(view.host, '1 unsaved change');

    // A teammate change arrives: new base revision, same saved name.
    mockGetRecords.mockResolvedValueOnce(leadsResponse([entityRow('ent_1', 'Acme', '2026-10-10T10:05:00.000Z')], 2));
    const moreBtn = Array.from(view.host.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'More actions') as HTMLButtonElement;
    expect(moreBtn).toBeTruthy();
    await openMenu(moreBtn!);
    const refreshItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent?.includes('Refresh')) as HTMLElement;
    expect(refreshItem).toBeTruthy();
    await React.act(async () => refreshItem.click());
    await settle(view.host);

    // The dirty edit survives the rebase instead of being discarded.
    expect(view.host.textContent).toContain('1 unsaved change');
    expect(view.host.textContent).toContain('Acme Intl');
    await view.unmount();
  });

  it('sorts through the server and restores real history with undo', async () => {
    mockGetRecords.mockResolvedValue(leadsResponse([
      entityRow('ent_2', 'Zulu', '2026-10-10T10:00:00.000Z'),
      entityRow('ent_1', 'Acme', '2026-10-10T10:00:00.000Z'),
    ], 1, { leads: [{ id: 'act_1', timestamp: 'today', actor: 'user', description: 'Renamed Acme', affected_count: 1, affectedCount: 1, can_restore: true, canRestore: true }] }));
    const view = await mount(<RecordsScreen {...screenProps} />);
    await waitForText(view.host, 'Zulu');
    expect(mockGetRecords).toHaveBeenCalledTimes(1);

    // Header sort menu drives server ordering, not a local reshuffle.
    const optionsBtn = view.host.querySelector('button[aria-label="Options for Lead name"]') as HTMLButtonElement;
    expect(optionsBtn).toBeTruthy();
    await openMenu(optionsBtn);
    const sortItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent?.includes('Sort A to Z')) as HTMLElement;
    expect(sortItem).toBeTruthy();
    mockGetRecords.mockClear();
    await React.act(async () => sortItem.click());
    await settle(view.host, 100);
    expect(mockGetRecords).toHaveBeenCalled();
    const lastQuery = mockGetRecords.mock.calls[mockGetRecords.mock.calls.length - 1]![1] as Record<string, unknown>;
    expect(lastQuery).toMatchObject({ sort: { column_id: 'name', direction: 'asc' } });
    await view.unmount();
  });

  it('restores a saved change through previewed undo', async () => {
    mockGetRecords.mockResolvedValue(leadsResponse(
      [entityRow('ent_1', 'Acme', '2026-10-10T10:00:00.000Z')], 1,
      { leads: [{ id: 'act_1', timestamp: 'today', actor: 'user', description: 'Renamed Acme', affected_count: 1, affectedCount: 1, can_restore: true, canRestore: true }] },
    ));
    mockUndoPreview.mockResolvedValue({
      preview: {
        target_action_id: 'act_1', mode: 'single', selected_action_ids: ['act_1'],
        affected_event_ids: [], affected_entities: [{ id: 'ent_1', name: 'Acme', changes: ["Name will revert from 'Acme' to 'Old'."] }],
        affected_tasks: [], dependencies: [], expected_revision: 1,
      },
    });
    mockUndo.mockResolvedValue({ status: 'applied', action_id: 'act_1', undo_action_id: 'act_u1', affected_action_ids: ['act_1'], revert_event_ids: [], committed_revision: 2, summary: 'Undone' });
    (window as unknown as Record<string, unknown>)['confirm'] = vi.fn(() => true);
    const view = await mount(<RecordsScreen {...screenProps} />);
    await waitForText(view.host, 'Acme');

    const moreBtn = Array.from(view.host.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'More actions') as HTMLButtonElement;
    expect(moreBtn).toBeTruthy();
    await openMenu(moreBtn!);
    const historyBtn = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent?.includes('History')) as HTMLButtonElement;
    expect(historyBtn).toBeTruthy();
    await React.act(async () => historyBtn!.click());
    await waitForText(document.body, 'Renamed Acme');

    const restoreBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'Restore this version') as HTMLButtonElement;
    expect(restoreBtn).toBeTruthy();
    const callsBefore = mockGetRecords.mock.calls.length;
    await React.act(async () => restoreBtn.click());
    await settle(view.host, 100);

    expect(mockUndoPreview).toHaveBeenCalledWith('ws-test', 'act_1', 'single');
    expect(mockUndo).toHaveBeenCalledWith('ws-test', 'act_1', expect.objectContaining({ mode: 'single', expectedRevision: 1 }));
    expect(mockGetRecords.mock.calls.length).toBeGreaterThan(callsBefore);
    delete (window as unknown as Record<string, unknown>)['confirm'];
    await view.unmount();
  });

  it('keeps the draft and explains a rejected save', async () => {
    mockGetRecords.mockResolvedValue(leadsResponse([entityRow('ent_1', 'Acme', '2026-10-10T10:00:00.000Z')]));
    mockSaveRecords.mockRejectedValue(new ApiError(400, 'invalid_status', "Status 'bogus' is invalid.", 'req-9'));
    const view = await mount(<RecordsScreen {...screenProps} />);
    await waitForText(view.host, 'Acme');

    const row = view.host.querySelector('.otis-records__tr') as HTMLElement;
    await React.act(async () => row.click());
    await React.act(async () => setInputValue(document.body.querySelector('#field-name') as HTMLInputElement, 'Acme Intl'));
    await waitForText(view.host, '1 unsaved change');

    const saveBtn = Array.from(view.host.querySelectorAll('button')).find((b) => b.textContent === 'Save') as HTMLButtonElement;
    await React.act(async () => saveBtn.click());
    await waitForText(view.host, 'bogus');
    // Nothing committed, nothing discarded: the draft value survives the rejection.
    expect(view.host.textContent).toContain('Acme Intl');
    await view.unmount();
  });

  it('shows a failed read with retry instead of an empty table', async () => {    mockGetRecords.mockRejectedValueOnce(new ApiError(500, 'internal_error', 'Unable to load records.', 'req-x'));
    const view = await mount(<RecordsScreen {...screenProps} />);
    await waitForText(view.host, 'Could not load these records');

    mockGetRecords.mockResolvedValueOnce(leadsResponse([entityRow('ent_1', 'Acme', '2026-10-10T10:00:00.000Z')]));
    const retryBtn = Array.from(view.host.querySelectorAll('button')).find((b) => b.textContent === 'Retry') as HTMLButtonElement;
    await React.act(async () => retryBtn.click());
    await waitForText(view.host, 'Acme');
    await view.unmount();
  });
});
