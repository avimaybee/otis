import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import { AUTH_BOUNDS } from '@otis/contracts';
import { sha256 } from '@otis/identity';

const CSRF = {
  origin: 'http://localhost',
  [AUTH_BOUNDS.CSRF_HEADER]: '1',
  'Content-Type': 'application/json',
};

const WS = 'ws-records-test';
const USER = 'usr_records_test';
let authCookie: string;

beforeAll(async () => {
  await applyMigrations(env.DB);

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at)
     VALUES (?, 'fb_records_test', 'records@test.local', 'Records User', ?, ?)`,
  )
    .bind(USER, now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
     VALUES (?, 'Records Workspace', ?, 0, 1, ?, ?)`,
  )
    .bind(WS, USER, now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?)`,
  )
    .bind(WS, USER, now, now, now)
    .run();

  const token = 'records_token_123';
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
     VALUES ('sess_records_test', ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(await sha256(token), USER, now, expiresAt, now)
    .run();

  authCookie = `${AUTH_BOUNDS.COOKIE_NAME}=${token}`;
});

describe('Workspace Records API (D1 ledger queries & batch persistence)', () => {
  it('returns empty lists for fresh workspace without hardcoded mock rows', async () => {
    const res = await SELF.fetch(`http://localhost/api/workspaces/${WS}/records`, {
      headers: {
        Cookie: authCookie,
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { lists: Array<{ id: string; name: string; rows: unknown[] }> };
    expect(Array.isArray(body.lists)).toBe(true);
    expect(body.lists.length).toBeGreaterThanOrEqual(4);

    const leadsList = body.lists.find(l => l.id === 'leads');
    expect(leadsList).toBeDefined();
    expect(leadsList!.rows).toHaveLength(0);

    const tasksList = body.lists.find(l => l.id === 'tasks');
    expect(tasksList).toBeDefined();
    expect(tasksList!.rows).toHaveLength(0);
  });

  it('saves new records and cell updates through POST /records', async () => {
    const savePayload = {
      listId: 'leads',
      addedRows: [
        {
          id: 'row-lead-1',
          source: 'custom',
          cells: {
            name: 'Apex Design Studio',
            status: 'Hot Lead',
            contact: 'contact@apex.test',
            value: '$12,000',
            notes: 'Follow up next week',
          },
          provenance: { name: 'User added' },
        },
      ],
      dirtyCells: {
        'row-lead-1:notes': {
          rowId: 'row-lead-1',
          columnId: 'notes',
          baseValue: '',
          currentValue: 'Follow up on Monday afternoon',
          timestamp: Date.now(),
        },
      },
      deletedRowIds: [],
    };

    const res = await SELF.fetch(`http://localhost/api/workspaces/${WS}/records`, {
      method: 'POST',
      headers: {
        Cookie: authCookie,
        ...CSRF,
      },
      body: JSON.stringify(savePayload),
    });

    const resText = await res.text();
    if (res.status !== 200) {
      console.error('Save failed:', res.status, resText);
    }
    expect(res.status).toBe(200);
    const body = JSON.parse(resText) as { saved: boolean; affectedCount: number };
    expect(body.saved).toBe(true);
    expect(body.affectedCount).toBe(2);

    // Verify retrieval reflects the saved entity
    const getRes = await SELF.fetch(`http://localhost/api/workspaces/${WS}/records`, {
      headers: {
        Cookie: authCookie,
      },
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { lists: Array<{ id: string; rows: Array<{ id: string; cells: Record<string, string> }> }> };
    const leadsList = getBody.lists.find(l => l.id === 'leads');
    expect(leadsList).toBeDefined();
    expect(leadsList!.rows.length).toBe(1);
    expect(leadsList!.rows[0]?.cells['name']).toBe('Apex Design Studio');
    expect(leadsList!.rows[0]?.cells['notes']).toBe('Follow up on Monday afternoon');
  });

  it('deletes rows when passed in deletedRowIds', async () => {
    const deletePayload = {
      listId: 'leads',
      addedRows: [],
      dirtyCells: {},
      deletedRowIds: ['row-lead-1'],
    };

    const res = await SELF.fetch(`http://localhost/api/workspaces/${WS}/records`, {
      method: 'POST',
      headers: {
        Cookie: authCookie,
        ...CSRF,
      },
      body: JSON.stringify(deletePayload),
    });

    expect(res.status).toBe(200);

    // Verify row is gone
    const getRes = await SELF.fetch(`http://localhost/api/workspaces/${WS}/records`, {
      headers: {
        Cookie: authCookie,
      },
    });
    const getBody = (await getRes.json()) as { lists: Array<{ id: string; rows: Array<{ id: string }> }> };
    const leadsList = getBody.lists.find(l => l.id === 'leads');
    expect(leadsList?.rows).toHaveLength(0);
  });

  it('saves task rows, updates task cells, and fetches projected tasks', async () => {
    const savePayload = {
      listId: 'tasks',
      addedRows: [
        {
          id: 'row-task-1',
          source: 'custom',
          cells: {
            title: 'Call client',
            status: 'open',
            due: '2026-10-15',
            assignee: 'Records User',
          },
        },
      ],
      dirtyCells: {},
      deletedRowIds: [],
    };

    const res = await SELF.fetch(`http://localhost/api/workspaces/${WS}/records`, {
      method: 'POST',
      headers: {
        Cookie: authCookie,
        ...CSRF,
      },
      body: JSON.stringify(savePayload),
    });

    expect(res.status).toBe(200);

    // Verify task retrieval
    const getRes = await SELF.fetch(`http://localhost/api/workspaces/${WS}/records`, {
      headers: { Cookie: authCookie },
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      lists: Array<{ id: string; rows: Array<{ id: string; cells: Record<string, string> }> }>;
    };
    const tasksList = getBody.lists.find(l => l.id === 'tasks');
    expect(tasksList).toBeDefined();
    expect(tasksList!.rows.length).toBe(1);
    expect(tasksList!.rows[0]?.cells['title']).toBe('Call client');
    expect(tasksList!.rows[0]?.cells['status']).toBe('open');
    expect(tasksList!.rows[0]?.cells['due']).toBe('2026-10-15');
    expect(tasksList!.rows[0]?.cells['assignee']).toBe('Records User');

    // Update task cells
    const updatePayload = {
      listId: 'tasks',
      addedRows: [],
      dirtyCells: {
        'row-task-1:status': {
          rowId: 'row-task-1',
          columnId: 'status',
          baseValue: 'open',
          currentValue: 'done',
          timestamp: Date.now(),
        },
      },
      deletedRowIds: [],
    };
    const updateRes = await SELF.fetch(`http://localhost/api/workspaces/${WS}/records`, {
      method: 'POST',
      headers: { Cookie: authCookie, ...CSRF },
      body: JSON.stringify(updatePayload),
    });
    expect(updateRes.status).toBe(200);

    // Verify updated task
    const getRes2 = await SELF.fetch(`http://localhost/api/workspaces/${WS}/records`, {
      headers: { Cookie: authCookie },
    });
    const getBody2 = (await getRes2.json()) as {
      lists: Array<{ id: string; rows: Array<{ id: string; cells: Record<string, string> }> }>;
    };
    const updatedTasks = getBody2.lists.find(l => l.id === 'tasks');
    expect(updatedTasks!.rows[0]?.cells['status']).toBe('done');
  });

  it('saves and returns custom entity collections with dynamic columns', async () => {
    const customPayload = {
      listId: 'properties',
      addedRows: [
        {
          id: 'row-prop-1',
          source: 'custom',
          cells: {
            name: 'Sunset Heights Villa',
            status: 'warm',
            square_feet: '3500',
            price: '$1,200,000',
          },
        },
      ],
      dirtyCells: {},
      deletedRowIds: [],
    };

    const res = await SELF.fetch(`http://localhost/api/workspaces/${WS}/records`, {
      method: 'POST',
      headers: { Cookie: authCookie, ...CSRF },
      body: JSON.stringify(customPayload),
    });
    expect(res.status).toBe(200);

    const getRes = await SELF.fetch(`http://localhost/api/workspaces/${WS}/records`, {
      headers: { Cookie: authCookie },
    });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      lists: Array<{ id: string; name: string; columns: Array<{ id: string }>; rows: Array<{ id: string; cells: Record<string, string> }> }>;
    };
    const propList = getBody.lists.find(l => l.id === 'properties');
    expect(propList).toBeDefined();
    expect(propList!.rows.length).toBe(1);
    expect(propList!.rows[0]?.cells['name']).toBe('Sunset Heights Villa');
    expect(propList!.rows[0]?.cells['square_feet']).toBe('3500');

    // Verify dynamic column was detected
    expect(propList!.columns.some(c => c.id === 'square_feet')).toBe(true);
  });

  it('rejects unauthorized access without valid session cookie', async () => {
    const res = await SELF.fetch(`http://localhost/api/workspaces/${WS}/records`, {
      headers: {
        Cookie: 'session=invalid',
      },
    });
    expect(res.status).toBe(401);
  });
});
