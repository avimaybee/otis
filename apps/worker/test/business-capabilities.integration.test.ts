import { readWork } from '../src/entities/work.js';
import { readChatAttachments } from '../src/entities/attachments.js';
import { readFollowUps } from '../src/entities/followups.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  DEFAULT_COMMAND_HANDLERS,
  executeLedgerCommand,
  getWorkspaceActions,
  getWorkspaceEvents,
  getWorkspaceProjectionState,
  handleUndoCommit,
  rebuildProjections,
  type LedgerCommandContext,
} from '@otis/ledger';
import type { EntityFile, EntityFileSectionResponse } from '@otis/contracts';
import { applyMigrations } from './migrations.js';
import { readEntityFile } from '../src/entities/file.js';
import {
  backfillConversationSearch,
  readWorkspaceMessageSource,
  searchWorkspaceHistory,
} from '../src/conversationSearch.js';
import { cleanupExpiredMedia } from '../src/media/cleanup.js';
import { processReminderRules, quoteFollowUpDue } from '../src/reminders/rules.js';
import { processDueReminders } from '../src/reminders/service.js';
import { processDocumentExtractions, readDocument } from '../src/media/documents.js';
import type { Env } from '../src/index.js';
import type { ReminderRule } from '@otis/contracts';
import { executeAgentTool } from '../src/agent/repository.js';
import { commitSelectedEdit } from '../src/routes/entities.js';

const user = 'capabilities_member';
let workspace: string, source: string, chat: string;
beforeAll(async () => {
  await applyMigrations(env.DB);
  await env.DB.prepare(
    "INSERT INTO users(id, firebase_uid, display_name, created_at, updated_at) VALUES (?, ?, 'Member', '2026-10-01', '2026-10-01')",
  )
    .bind(user, user)
    .run();
});
beforeEach(async () => {
  workspace = crypto.randomUUID();
  source = crypto.randomUUID();
  chat = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO workspaces(id, name, owner_user_id, created_at, updated_at) VALUES (?, 'Capabilities', ?, '2026-10-01', '2026-10-01')",
  )
    .bind(workspace, user)
    .run();
  await env.DB.prepare(
    "INSERT INTO workspace_users(workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'owner', '2026-10-01', '2026-10-01', '2026-10-01')",
  )
    .bind(workspace, user)
    .run();
  await env.DB.prepare(
    "INSERT INTO chats(id, workspace_id, author_user_id, title, created_at, updated_at, last_activity_at) VALUES (?, ?, ?, 'A conversation', '2026-10-01', '2026-10-01', '2026-10-01')",
  )
    .bind(chat, workspace, user)
    .run();
  await env.DB.prepare(
    "INSERT INTO messages_in(id, workspace_id, user_id, chat_id, channel, external_id, payload_fingerprint, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'web', ?, 'synthetic', 'processed', '2026-10-01', '2026-10-01')",
  )
    .bind(source, workspace, user, chat, source)
    .run();
});
async function context(): Promise<LedgerCommandContext> {
  const meta = await env.DB.prepare('SELECT business_revision FROM workspaces WHERE id = ?')
    .bind(workspace)
    .first<{ business_revision: number }>();
  return {
    workspace_id: workspace,
    actor: { kind: 'member', user_id: user },
    source_message_id: source,
    membership_revision: 1,
    request_id: crypto.randomUUID(),
    action_id: crypto.randomUUID(),
    expected_business_revision: meta!.business_revision,
  };
}
const command = async (name: string, args: unknown) =>
  executeLedgerCommand(env.DB, await context(), name, args, DEFAULT_COMMAND_HANDLERS[name]!);
const file = async (id: string) =>
  (await readEntityFile(env.DB, workspace, user, id)) as EntityFile;
async function entity(name: string) {
  const result = await command('create_entity', { name, kind: 'lead', initial_status: 'warm' });
  expect(result.status).toBe('applied');
  return (result.data as { entity_id: string }).entity_id;
}
async function undo(action: string) {
  const events = await getWorkspaceEvents(env.DB, workspace),
    actions = await getWorkspaceActions(env.DB, workspace),
    ctx = await context();
  return executeLedgerCommand(
    env.DB,
    ctx,
    'undo',
    {
      action_id: action,
      mode: 'single',
      expected_revision: ctx.expected_business_revision,
      client_operation_id: ctx.action_id,
    },
    (current, state, seq, args) => handleUndoCommit(current, events, actions, state, seq, args),
  );
}

describe('shared business files, contacts and identity', () => {
  it('keeps original reporter and corrector distinct under author/date filters and manual retries', async () => {
    const id = await entity('Attribution client'),
      teammate = crypto.randomUUID(),
      teammateSource = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users(id, firebase_uid, display_name, created_at, updated_at) VALUES (?, ?, 'Teammate', '2026-10-01', '2026-10-01')",
      ).bind(teammate, teammate),
      env.DB.prepare(
        "INSERT INTO workspace_users(workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'member', '2026-10-01', '2026-10-01', '2026-10-01')",
      ).bind(workspace, teammate),
      env.DB.prepare(
        "INSERT INTO messages_in(id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, created_at, updated_at) VALUES (?, ?, ?, 'web', ?, 'synthetic', ?, 'processed', '2026-10-01', '2026-10-01')",
      ).bind(
        teammateSource,
        workspace,
        teammate,
        teammateSource,
        JSON.stringify({ text: 'Original report from Teammate' }),
      ),
    ]);
    const log = await executeLedgerCommand(
      env.DB,
      {
        ...(await context()),
        actor: { kind: 'member', user_id: teammate },
        source_message_id: teammateSource,
      },
      'log_event',
      {
        entity_id: id,
        kind: 'note',
        payload: { text: 'Wrong quantity' },
        occurred_at: '2026-09-01T08:00:00Z',
      },
      DEFAULT_COMMAND_HANDLERS.log_event!,
    );
    const root = log.event_ids![0]!,
      revision = (await context()).expected_business_revision,
      operation = crypto.randomUUID();
    const args = {
      interaction_id: root,
      expected_head_event_id: root,
      kind: 'note',
      payload: { text: 'Correct quantity' },
      occurred_at: '2026-09-02T08:00:00Z',
    };
    const saved = await commitSelectedEdit(
      env as Env,
      workspace,
      user,
      id,
      'manual-source',
      'revise_interaction',
      args,
      operation,
      revision,
    );
    expect(saved.status).toBe(200);
    const retry = await commitSelectedEdit(
      env as Env,
      workspace,
      user,
      id,
      'manual-retry',
      'revise_interaction',
      args,
      operation,
      revision,
    );
    expect(retry.status).toBe(200);
    expect((await context()).expected_business_revision).toBe(revision + 1);
    expect(
      (
        await commitSelectedEdit(
          env as Env,
          workspace,
          user,
          id,
          'wrong-retry',
          'revise_interaction',
          { ...args, payload: { text: 'Different edit' } },
          operation,
          revision,
        )
      ).status,
    ).toBe(409);
    const found = await file(id),
      entry = found.notes.items[0]!;
    expect(entry.original_actor_name).toBe('Teammate');
    expect(entry.actor_name).toBe('Member');
    expect(entry.original_source_message_id).toBe(teammateSource);
    expect(entry.source_message_id).toBe(`file_edit_${operation}`);
    for (const author of [user, teammate]) {
      const filtered = (await readEntityFile(env.DB, workspace, user, id, {
        section: 'notes',
        author_user_id: author,
        from: '2026-09-02T00:00:00Z',
        to: '2026-09-03T00:00:00Z',
      })) as EntityFileSectionResponse;
      expect(filtered.page.total).toBe(1);
    }
    expect((await readWorkspaceMessageSource(env.DB, workspace, user, teammateSource)).text).toBe(
      'Original report from Teammate',
    );
  });
  it('prevents direct reads of another member’s preferences and searches merged entity memory through either identity', async () => {
    const a = await entity('Astoria Manufacturing'),
      b = await entity('Copper Winds');
    const memory = await command('remember_context', {
      scope: 'entity',
      subject_id: a,
      category: 'workflow_context',
      content: 'Farsi preferred in calls',
    });
    expect(memory.status).toBe('applied');
    await command('merge_entities', {
      source_entity_id: a,
      target_entity_id: b,
      expected_revision: (await context()).expected_business_revision,
    });
    const run = (toolName: string, toolArgs: unknown) =>
      executeAgentTool({
        db: env.DB,
        workspaceId: workspace,
        actorUserId: user,
        actionId: crypto.randomUUID(),
        toolName,
        toolArgs,
      });
    for (const subject_id of [a, b])
      expect(
        (await run('search_memory', { query: 'Farsi', scope: 'entity', subject_id })).data,
      ).toHaveLength(1);
    const other = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO memory_entries(id, workspace_id, scope, subject_id, category, content, status, observed_at, created_at, business_revision) VALUES (?, ?, 'member_in_workspace', ?, 'communication_preference', 'Personal preference', 'active', '2026-10-01', '2026-10-01', 1)",
    )
      .bind(other, workspace, 'different-member')
      .run();
    expect((await run('get_memory', { memory_id: other })).status).toBe('rejected');
    expect((await run('search_memory', { query: 'Personal' })).data).toEqual([]);
    await env.DB.prepare('DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?')
      .bind(workspace, user)
      .run();
    expect((await run('query', { resource: 'entities' })).error?.code).toBe('access_lost');
  });
  it('keeps two conflicting phone primaries undecided and preserves every contact through chained merge and Undo', async () => {
    const a = await entity('First identity'),
      b = await entity('Second identity'),
      c = await entity('Third identity');
    await command('change_contact', {
      entity_id: a,
      operation: 'save',
      method: 'phone',
      value: '011 111 111',
      primary: true,
    });
    await command('change_contact', {
      entity_id: b,
      operation: 'save',
      method: 'phone',
      value: '022 222 222',
      primary: true,
    });
    const merged = await command('merge_entities', {
      source_entity_id: a,
      target_entity_id: b,
      expected_revision: (await context()).expected_business_revision,
    });
    expect(merged.status).toBe('applied');
    const contacts = (await file(a)).contacts.items as { is_primary: boolean; value: string }[];
    expect(contacts).toHaveLength(2);
    expect(contacts.filter((row) => row.is_primary)).toHaveLength(0);
    const second = await command('merge_entities', {
      source_entity_id: b,
      target_entity_id: c,
      expected_revision: (await context()).expected_business_revision,
    });
    expect(second.status).toBe('applied');
    expect((await file(a)).entity.id).toBe(c);
    expect((await file(c)).contacts.total).toBe(2);
    const sourceCounts = (
      second.data as { manifest: { origin_entity_id: string; counts: { contacts: number } }[] }
    ).manifest.find((row) => row.origin_entity_id === a)!.counts;
    expect(sourceCounts.contacts).toBe(1);
    expect((await undo(second.action_id!)).status).toBe('applied');
    expect((await file(a)).entity.id).toBe(b);
    expect((await undo(merged.action_id!)).status).toBe('applied');
    expect((await file(a)).contacts.items[0]!.is_primary).toBe(true);
    expect((await file(b)).contacts.items[0]!.is_primary).toBe(true);
  });
  it('orders general work using each task timezone, respects snooze and scopes bookmarks', async () => {
    const id = await entity('Work client');
    const make = async (title: string, zone: string) =>
      command('create_task', {
        entity_id: id,
        title,
        due: { kind: 'date', local_date: '2026-10-09', timezone: zone },
      });
    expect((await make('Tokyo today', 'Asia/Tokyo')).status).toBe('applied');
    expect((await make('Los Angeles tomorrow', 'America/Los_Angeles')).status).toBe('applied');
    const instant = await command('create_task', {
      entity_id: id,
      title: 'Snoozed',
      due: { kind: 'instant', instant: '2026-10-01T09:00:00Z', timezone: 'UTC' },
    });
    const taskId = (instant.data as { task_id: string }).task_id;
    expect(
      (await command('update_task', { task_id: taskId, snooze_until: '2026-10-10T09:00:00Z' }))
        .status,
    ).toBe('applied');
    const first = await readWork(env.DB, workspace, user, {
      limit: 1,
      now: '2026-10-09T00:00:00Z',
    });
    expect(first.counts.total).toBe(3);
    expect(first.counts.overdue).toBe(1);
    expect(first.rows[0]!.title).toBe('Tokyo today');
    const second = await readWork(env.DB, workspace, user, {
      limit: 50,
      cursor: first.next_cursor!,
    });
    expect(second.rows).toHaveLength(2);
    await expect(
      readWork(env.DB, workspace, user, {
        filters: { overdue_only: true },
        cursor: first.next_cursor!,
      }),
    ).rejects.toThrow('changed');
  });
  it('reads independently paged effective entries and scopes file/source access', async () => {
    const id = await entity('Copper');
    for (let n = 0; n < 3; n++)
      expect(
        (
          await command('log_event', {
            entity_id: id,
            kind: 'note',
            payload: { text: `Note ${n}` },
            occurred_at: `2026-10-0${n + 1}T10:00:00Z`,
          })
        ).status,
      ).toBe('applied');
    const first = (await readEntityFile(env.DB, workspace, user, id, {
      section: 'notes',
      limit: 2,
    })) as EntityFileSectionResponse;
    expect(first.page.total).toBe(3);
    expect(first.page.has_more).toBe(true);
    const second = (await readEntityFile(env.DB, workspace, user, id, {
      section: 'notes',
      limit: 2,
      cursor: first.page.next_cursor!,
    })) as EntityFileSectionResponse;
    expect(second.page.items).toHaveLength(1);
    expect(
      new Set(
        [...first.page.items, ...second.page.items].map(
          (v: unknown) => (v as { interaction_id: string }).interaction_id,
        ),
      ).size,
    ).toBe(3);
    await expect(readEntityFile(env.DB, workspace, 'outsider', id)).rejects.toThrow(
      'not available',
    );
    await expect(readWorkspaceMessageSource(env.DB, workspace, 'outsider', source)).rejects.toThrow(
      'unavailable',
    );
  });
  it('stores distinct contact methods, changes primary atomically and rebuilds after Undo', async () => {
    const id = await entity('Contact');
    const first = await command('change_contact', {
      entity_id: id,
      operation: 'save',
      method: 'phone',
      value: '+40 123 456',
      primary: true,
    });
    const second = await command('change_contact', {
      entity_id: id,
      operation: 'save',
      method: 'phone',
      value: '555 444',
      primary: true,
    });
    expect(first.status).toBe('applied');
    expect(second.status).toBe('applied');
    expect(
      (await file(id)).contacts.items.filter(
        (v: unknown) => (v as { is_primary: boolean }).is_primary,
      ),
    ).toHaveLength(1);
    const duplicate = await command('change_contact', {
      entity_id: id,
      operation: 'save',
      method: 'phone',
      value: '555444',
    });
    expect(duplicate.status).toBe('already_applied');
    expect((await undo(second.action_id!)).status).toBe('applied');
    const state = await getWorkspaceProjectionState(env.DB, workspace),
      replay = rebuildProjections(await getWorkspaceEvents(env.DB, workspace));
    expect(state.contacts).toEqual(replay.contacts);
    expect((await file(id)).contacts.items).toHaveLength(1);
  });
  it('combines current files losslessly and separates later originating writes on Undo', async () => {
    const sourceId = await entity('Hunor-Attila'),
      targetId = await entity('North Metals');
    expect(
      (
        await command('set_field', {
          entity_id: sourceId,
          field_name: 'preferred_language',
          value: 'Farsi',
          provenance: 'stated',
        })
      ).status,
    ).toBe('applied');
    expect(
      (
        await command('set_field', {
          entity_id: targetId,
          field_name: 'preferred_language',
          value: 'English',
          provenance: 'stated',
        })
      ).status,
    ).toBe('applied');
    await command('log_event', {
      entity_id: sourceId,
      kind: 'note',
      payload: { text: 'Only afternoon calls' },
    });
    const merged = await command('merge_entities', {
      source_entity_id: sourceId,
      target_entity_id: targetId,
      expected_revision: (await context()).expected_business_revision,
    });
    expect(merged.status).toBe('applied');
    const combined = await file(sourceId);
    expect(combined.entity.id).toBe(targetId);
    expect(combined.notes.total).toBe(1);
    expect(combined.facts.items.find((f) => f.field === 'preferred_language')?.state).toBe(
      'disputed',
    );
    expect(
      (
        await command('set_field', {
          entity_id: sourceId,
          field_name: 'phone',
          value: '012 345 678',
          provenance: 'stated',
        })
      ).status,
    ).toBe('applied');
    expect((await file(targetId)).facts.items.find((f) => f.field === 'phone')?.value).toBe(
      '012 345 678',
    );
    expect((await undo(merged.action_id!)).status).toBe('applied');
    expect((await file(sourceId)).facts.items.find((f) => f.field === 'phone')?.value).toBe(
      '012 345 678',
    );
    expect((await file(targetId)).facts.items.some((f) => f.field === 'phone')).toBe(false);
    const state = await getWorkspaceProjectionState(env.DB, workspace),
      replay = rebuildProjections(await getWorkspaceEvents(env.DB, workspace));
    expect(state.fields).toEqual(replay.fields);
    expect(state.redirects).toEqual(replay.redirects);
  });
});

describe('canonical conversation search', () => {
  async function message(n: number, text = 'Promised copper sample') {
    const id = crypto.randomUUID(),
      at = `2026-10-01T10:0${n}:00.000Z`;
    await env.DB.prepare(
      "INSERT INTO chat_messages(id, workspace_id, chat_id, author_user_id, author_kind, channel, content_text, sequence, created_at, updated_at) VALUES (?, ?, ?, ?, 'member', 'web', ?, ?, ?, ?)",
    )
      .bind(id, workspace, chat, user, text, n, at, at)
      .run();
    return id;
  }
  it('indexes immediately, pages without newly inserted overlap and opens nearby source context', async () => {
    const one = await message(1);
    await message(2);
    await message(3);
    await backfillConversationSearch(env.DB, 100);
    const first = await searchWorkspaceHistory(env.DB, workspace, user, {
      query: 'copper',
      mode: 'chronological',
      limit: 2,
    });
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);
    await message(4);
    const second = await searchWorkspaceHistory(env.DB, workspace, user, {
      query: 'copper',
      mode: 'chronological',
      limit: 2,
      cursor: first.next_cursor!,
    });
    expect(second.items.map((r) => r.message_id)).toEqual([one]);
    expect((await readWorkspaceMessageSource(env.DB, workspace, user, one)).context).toHaveLength(
      4,
    );
    expect(
      (await searchWorkspaceHistory(env.DB, workspace, 'outsider', { query: 'copper' })).items,
    ).toHaveLength(0);
    await env.DB.prepare('DELETE FROM chat_messages WHERE id = ?').bind(one).run();
    expect((await searchWorkspaceHistory(env.DB, workspace, user, { query: 'copper' })).total).toBe(
      3,
    );
  });
  it('rejects invalid/scoped cursors and compares zoned intervals as instants', async () => {
    await message(1);
    await expect(
      searchWorkspaceHistory(env.DB, workspace, user, {
        query: 'copper',
        mode: 'chronological',
        cursor: btoa('null'),
      }),
    ).rejects.toThrow('invalid');
    expect(
      (
        await searchWorkspaceHistory(env.DB, workspace, user, {
          query: 'copper',
          from: '2026-10-01T12:00:00+03:00',
          to: '2026-10-01T10:30:00Z',
        })
      ).total,
    ).toBe(1);
  });
});

describe('retained originals and documents', () => {
  it('pages all four photos of one message without skipping siblings or leaking removed-member metadata', async () => {
    const message = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO chat_messages(id, workspace_id, chat_id, author_user_id, author_kind, channel, content_text, sequence, created_at, updated_at) VALUES (?, ?, ?, ?, 'member', 'web', 'Four photos', 1, '2026-10-01', '2026-10-01')",
    )
      .bind(message, workspace, chat, user)
      .run();
    const ids: string[] = [];
    for (let position = 0; position < 4; position++) {
      const id = crypto.randomUUID();
      ids.push(id);
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO media_objects(id, workspace_id, uploader_user_id, state, object_key, content_type, format, expires_at, created_at, updated_at) VALUES (?, ?, ?, 'ready', ?, 'image/png', 'image/png', '2100-01-01', '2026-10-01', '2026-10-01')",
        ).bind(id, workspace, user, `${workspace}/photos/${id}`),
        env.DB.prepare(
          "INSERT INTO message_image_attachments(chat_message_id, media_id, workspace_id, position, created_at) VALUES (?, ?, ?, ?, '2026-10-01')",
        ).bind(message, id, workspace, position),
      ]);
    }
    const first = await readChatAttachments(env.DB, workspace, user, chat, { limit: 2 });
    const second = await readChatAttachments(env.DB, workspace, user, chat, {
      limit: 2,
      cursor: first.next_cursor!,
    });
    expect(first.total).toBe(4);
    expect([...first.rows, ...second.rows].map((row) => row.media_id)).toEqual(ids);
    expect(second.has_more).toBe(false);
    await expect(
      readChatAttachments(env.DB, workspace, user, chat, {
        cursor: first.next_cursor!,
        text: 'different scope',
      }),
    ).rejects.toThrow('invalid');
    await expect(
      readChatAttachments(env.DB, workspace, user, chat, { text: '語'.repeat(17) }),
    ).rejects.toThrow('shorter');
    await env.DB.prepare('DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?')
      .bind(workspace, user)
      .run();
    expect((await readChatAttachments(env.DB, workspace, user, chat, {})).rows).toEqual([]);
  });
  it('deletes and restores a combined client without losing retained originals or origin history', async () => {
    const a = await entity('Silver Foundry'),
      b = await entity('Evergreen Paper'),
      m = await media();
    await env.DB.prepare("UPDATE media_objects SET expires_at = '2100-01-01' WHERE id = ?")
      .bind(m.id)
      .run();
    expect((await command('link_attachment', { entity_id: a, media_id: m.id })).status).toBe(
      'applied',
    );
    await command('log_event', {
      entity_id: b,
      kind: 'note',
      payload: { text: 'Preserve this original note' },
    });
    await command('merge_entities', {
      source_entity_id: a,
      target_entity_id: b,
      expected_revision: (await context()).expected_business_revision,
    });
    const removed = await command('delete_entity', { entity_id: a, confirm: 'yes' });
    expect(removed.status).toBe('applied');
    await expect(file(b)).rejects.toThrow('not available');
    await env.DB.prepare("UPDATE media_objects SET expires_at = '2000-01-01' WHERE id = ?")
      .bind(m.id)
      .run();
    await cleanupExpiredMedia(env.DB, env.STORAGE);
    expect(await env.STORAGE.head(m.key)).not.toBeNull();
    expect((await undo(removed.action_id!)).status).toBe('applied');
    expect((await file(a)).entity.id).toBe(b);
    expect((await file(b)).attachments.total).toBe(1);
    expect((await file(b)).notes.total).toBe(1);
    const state = await getWorkspaceProjectionState(env.DB, workspace),
      replay = rebuildProjections(await getWorkspaceEvents(env.DB, workspace));
    expect(state.attachmentLinks).toEqual(replay.attachmentLinks);
    expect(state.redirects).toEqual(replay.redirects);
  });
  it('keeps original voice and transcript, corrects by event, guards release and reverses it during grace', async () => {
    const client = await entity('Voice client'),
      mediaId = crypto.randomUUID(),
      objectKey = `${workspace}/voice/${mediaId}`;
    await env.STORAGE.put(objectKey, 'synthetic original audio');
    await env.DB.prepare(
      "INSERT INTO media_objects(id, workspace_id, uploader_user_id, state, object_key, content_type, format, expires_at, created_at, updated_at) VALUES (?, ?, ?, 'ready', ?, 'audio/ogg', 'audio/ogg', '2100-01-01', '2026-10-01', '2026-10-01')",
    )
      .bind(mediaId, workspace, user, objectKey)
      .run();
    await env.DB.prepare(
      "INSERT INTO media_transcriptions(id, workspace_id, media_id, state, route, format, transcript_text, created_at, updated_at) VALUES (?, ?, ?, 'ready', 'native', 'audio/ogg', 'Original said 400', '2026-10-01', '2026-10-01')",
    )
      .bind(crypto.randomUUID(), workspace, mediaId)
      .run();
    const linked = await command('link_attachment', { entity_id: client, media_id: mediaId });
    expect(linked.status).toBe('applied');
    const correction = await command('update_attachment', {
      entity_id: client,
      media_id: mediaId,
      expected_revision: 0,
      transcript: 'Actually 4000',
    });
    expect(correction.status).toBe('applied');
    let row = (await file(client)).attachments.items[0] as Record<string, unknown>;
    expect(row.transcript).toBe('Actually 4000');
    expect(row.original_transcript).toBe('Original said 400');
    const beforeRelease = (await context()).expected_business_revision;
    expect(
      (
        await command('update_attachment', {
          entity_id: client,
          media_id: mediaId,
          expected_revision: row.annotation_revision,
          retention: 'release',
        })
      ).status,
    ).not.toBe('applied');
    expect((await context()).expected_business_revision).toBe(beforeRelease);
    expect((await undo(correction.action_id!)).status).toBe('applied');
    row = (await file(client)).attachments.items[0] as Record<string, unknown>;
    expect(row.transcript).toBe('Original said 400');
    expect(
      (await command('unlink_attachment', { link_id: row.id, expected_revision: row.revision }))
        .status,
    ).toBe('applied');
    const release = await command('update_attachment', {
      entity_id: client,
      media_id: mediaId,
      expected_revision: 0,
      retention: 'release',
    });
    expect(release.status).toBe('applied');
    const media = await env.DB.prepare(
      'SELECT retained, expires_at FROM media_objects WHERE id = ?',
    )
      .bind(mediaId)
      .first<{ retained: number; expires_at: string }>();
    expect(media!.retained).toBe(0);
    expect(Date.parse(media!.expires_at) - Date.now()).toBeGreaterThan(13 * 86400000);
    await cleanupExpiredMedia(env.DB, env.STORAGE);
    expect(await env.STORAGE.head(objectKey)).not.toBeNull();
    expect((await undo(release.action_id!)).status).toBe('applied');
    expect(
      (await env.DB.prepare('SELECT retained FROM media_objects WHERE id = ?')
        .bind(mediaId)
        .first<{ retained: number }>())!.retained,
    ).toBe(1);
    expect((await getWorkspaceProjectionState(env.DB, workspace)).mediaAnnotations).toEqual(
      rebuildProjections(await getWorkspaceEvents(env.DB, workspace)).mediaAnnotations,
    );
  });
  async function media() {
    const id = crypto.randomUUID(),
      key = `${workspace}/synthetic/${id}`;
    await env.STORAGE.put(key, '%PDF-1.7 synthetic original');
    await env.DB.prepare(
      "INSERT INTO media_objects(id, workspace_id, uploader_user_id, state, object_key, content_type, filename, expires_at, created_at, updated_at) VALUES (?, ?, ?, 'ready', ?, 'application/pdf', 'Quote.pdf', '2000-01-01', '2026-10-01', '2026-10-01')",
    )
      .bind(id, workspace, user, key)
      .run();
    return { id, key };
  }
  it('retains linked bytes through cleanup, unlink and Undo; claimed deletion cannot become a link', async () => {
    const id = await entity('File owner'),
      m = await media();
    await env.DB.prepare('UPDATE media_objects SET expires_at = ? WHERE id = ?')
      .bind('2100-01-01', m.id)
      .run();
    const linked = await command('link_attachment', { entity_id: id, media_id: m.id });
    expect(linked.status).toBe('applied');
    await env.DB.prepare('UPDATE media_objects SET expires_at = ? WHERE id = ?')
      .bind('2000-01-01', m.id)
      .run();
    await cleanupExpiredMedia(env.DB, env.STORAGE);
    expect(await env.STORAGE.head(m.key)).not.toBeNull();
    const link = (await file(id)).attachments.items[0] as { id: string; revision: number };
    const removed = await command('unlink_attachment', {
      link_id: link.id,
      expected_revision: link.revision,
    });
    expect(removed.status).toBe('applied');
    expect((await file(id)).attachments.items).toHaveLength(0);
    expect((await undo(removed.action_id!)).status).toBe('applied');
    expect((await file(id)).attachments.items).toHaveLength(1);
    const claimed = await media();
    await env.DB.prepare(
      "UPDATE media_objects SET expires_at = '2100-01-01', deletion_claimed_at = '2026-10-01' WHERE id = ?",
    )
      .bind(claimed.id)
      .run();
    expect(
      (await command('link_attachment', { entity_id: id, media_id: claimed.id })).status,
    ).not.toBe('applied');
  });
  it('extracts once with a mocked converter, pages text honestly and denies removed members', async () => {
    const m = await media();
    await env.DB.prepare('UPDATE media_objects SET retained = 1 WHERE id = ?').bind(m.id).run();
    await env.DB.prepare(
      "INSERT INTO document_extractions(media_id, workspace_id, checksum, state, updated_at) VALUES (?, ?, 'synthetic-hash', 'pending', '2026-10-01')",
    )
      .bind(m.id, workspace)
      .run();
    const extractionEnv = {
      DB: env.DB,
      STORAGE: env.STORAGE,
      AI: {
        toMarkdown: async () => ({
          format: 'markdown',
          data: '# Quote\n' + 'Source content. '.repeat(1000),
        }),
      },
    } as Env;
    expect(await processDocumentExtractions(extractionEnv, workspace)).toBe(1);
    expect(await processDocumentExtractions(extractionEnv, workspace)).toBe(0);
    const first = await readDocument(extractionEnv, workspace, user, { media_id: m.id, limit: 1 });
    expect(first.coverage.complete).toBe(false);
    expect(first.next_cursor).toBeTruthy();
    await expect(
      readDocument(extractionEnv, workspace, 'outsider', { media_id: m.id }),
    ).rejects.toThrow('not found');
    expect(
      (
        await readDocument(extractionEnv, workspace, user, {
          media_id: m.id,
          cursor: first.next_cursor!,
          limit: 5,
        })
      ).sections,
    ).toHaveLength(2);
  });
});

describe('explicit recurring follow-ups', () => {
  it('fits quote discovery and two Telegram deliveries below 50 D1 queries with first-chat provisioning', async () => {
    const id = await entity('Budget fixture');
    for (let n = 0; n < 4; n++) {
      await command('log_event', { entity_id: id, kind: 'quote', payload: { amount: 10000 + n, currency: 'EUR', role: 'offered' }, occurred_at: '2026-01-01T10:00:00Z' });
    }
    await command('change_reminder_rule', {
      entity_id: id, text: 'Check the quote', timezone: 'UTC', channel: 'telegram',
      spec: { kind: 'after_quote', role: 'offered', offset: { hours: 24 }, if_no_contact: false },
    });
    await env.DB.batch([
      env.DB.prepare('UPDATE messages_in SET chat_id = NULL WHERE workspace_id = ?').bind(workspace),
      env.DB.prepare('DELETE FROM chats WHERE workspace_id = ?').bind(workspace),
      env.DB.prepare('INSERT INTO telegram_users(telegram_user_id, user_id, selected_workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), user, workspace, '2026-10-01', '2026-10-01'),
    ]);
    let prepares = 0;
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === 'prepare') return (sql: string) => { prepares++; return target.prepare(sql); };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const now = new Date().toISOString();
    expect(await processReminderRules(db, now, 1)).toBe(4);
    expect((await processDueReminders(db, now, { limit: 2 })).delivered).toBe(2);
    expect(prepares).toBeLessThan(50);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE workspace_id = ? AND destination = 'telegram'").bind(workspace).first<{ n: number }>())?.n).toBe(2);
    console.log(JSON.stringify({ minute_reminder_queries: prepares, rules: 1, discovered_quotes: 4, delivered: 2, channel: 'telegram', first_chat_provisioned: true }));
    // Finish this synthetic backlog so the later global-cron fixture starts
    // without unrelated due reminders. This also proves the next bounded pass.
    expect((await processDueReminders(env.DB, now, { limit: 2 })).delivered).toBe(2);
    expect(await processReminderRules(env.DB, now, 1)).toBe(0);
  });
  it('pages own weekly rules and observes midnight start, pause/Undo and no repeated delivered slots', async () => {
    const now = new Date().toISOString(),
      day = now.slice(0, 10),
      weekday = new Date(now).getUTCDay();
    const create = await command('change_reminder_rule', {
      text: 'Weekly review',
      timezone: 'UTC',
      channel: 'web',
      spec: { kind: 'weekly', weekdays: [weekday], local_time: '00:00', start_date: day },
    });
    expect(create.status).toBe('applied');
    const first = await readFollowUps(env.DB, workspace, user);
    expect(first.total).toBe(1);
    expect(first.rows[0]!.entity_id).toBeNull();
    await expect(readFollowUps(env.DB, workspace, 'outsider')).rejects.toThrow('unavailable');
    const rule = create.data as ReminderRule;
    const pause = await command('change_reminder_rule', {
      rule_id: rule.id,
      expected_revision: rule.revision,
      status: 'paused',
    });
    expect(pause.status).toBe('applied');
    expect((await readFollowUps(env.DB, workspace, user)).rows[0]!.status).toBe('paused');
    expect((await undo(pause.action_id!)).status).toBe('applied');
    const nextWeek = new Date(Date.parse(`${day}T00:00:00Z`) + 7 * 86400000).toISOString();
    expect(await processReminderRules(env.DB, nextWeek)).toBe(1);
    expect((await processDueReminders(env.DB, nextWeek)).delivered).toBe(1);
    expect(await processReminderRules(env.DB, nextWeek)).toBe(0);
    expect((await processDueReminders(env.DB, nextWeek)).delivered).toBe(0);
  });
  it('uses local calendar days through DST rather than treating a day as 24 hours', () => {
    const rule = {
      timezone: 'Europe/Bucharest',
      spec: {
        kind: 'after_quote',
        role: 'offered',
        offset: { days: 1, local_time: '10:00' },
        if_no_contact: true,
      },
    } as ReminderRule;
    expect(quoteFollowUpDue(rule, '2026-03-28T08:00:00Z')).toBe('2026-03-29T07:00:00.000Z');
  });
  it('delivers an after-quote occurrence exactly once and respects contact/removal/Undo', async () => {
    const id = await entity('Follow up');
    const quote = await command('log_event', {
      entity_id: id,
      kind: 'quote',
      payload: { amount: 1200, currency: 'EUR', role: 'offered' },
      occurred_at: '2026-10-01T10:00:00Z',
    });
    const created = await command('change_reminder_rule', {
      entity_id: id,
      text: 'Check this quote',
      timezone: 'Europe/Bucharest',
      channel: 'web',
      spec: { kind: 'after_quote', role: 'offered', offset: { hours: 24 }, if_no_contact: true },
    });
    expect(created.status).toBe('applied');
    await processReminderRules(env.DB, '2026-10-03T10:00:00Z');
    const delivered = await processDueReminders(env.DB, '2026-10-03T10:00:00Z');
    expect(delivered.delivered).toBe(1);
    await processReminderRules(env.DB, '2026-10-04T10:00:00Z');
    expect((await processDueReminders(env.DB, '2026-10-04T10:00:00Z')).delivered).toBe(0);
    const second = await command('log_event', {
      entity_id: id,
      kind: 'quote',
      payload: { amount: 1400, currency: 'EUR', role: 'offered' },
      occurred_at: '2026-10-04T10:00:00Z',
    });
    expect(
      (
        await command('log_event', {
          entity_id: id,
          kind: 'contact',
          payload: { summary: 'Spoke on phone', channel: 'phone' },
          occurred_at: '2026-10-05T09:00:00Z',
        })
      ).status,
    ).toBe('applied');
    await processReminderRules(env.DB, '2026-10-06T10:00:00Z');
    expect((await processDueReminders(env.DB, '2026-10-06T10:00:00Z')).delivered).toBe(0);
    expect((await undo(created.action_id!)).status).toBe('applied');
    expect((await file(id)).reminders.total).toBe(0);
    expect(quote.event_ids).toHaveLength(1);
    expect(second.event_ids).toHaveLength(1);
  });
});
