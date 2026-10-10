import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import { getTurnContext } from '../src/agent/context.js';

/**
 * Context batching proof (workerd, real D1). getTurnContext assembles the
 * same authoritative context through batched reads: workspace/member notes,
 * SQL-filtered forget tombstones, bounded entity matching in one roundtrip,
 * and tenant/member scoping intact.
 */
describe('Turn context batching (workerd)', () => {
  const ws = 'ws-context-batch';
  const aviId = 'usr_ctx_avi';
  const hunorId = 'usr_ctx_hunor';
  const chat = 'chat_ctx_1';
  const now = new Date().toISOString();

  async function note(
    id: string,
    scope: 'workspace' | 'entity' | 'member_in_workspace',
    subjectId: string | null,
    content: string,
    observedAt: string = now,
  ): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO memory_entries (id, workspace_id, scope, subject_id, category, content, status, observed_at, created_at, business_revision)
       VALUES (?, ?, ?, ?, 'other_context', ?, 'active', ?, ?, 0)`,
    ).bind(id, ws, scope, subjectId, content, observedAt, now).run();
  }

  beforeAll(async () => {
    await applyMigrations(env.DB);
    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(aviId, `fb_${aviId}`, 'avi.ctx@test', 'Avi', now, now).run();
    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(hunorId, `fb_${hunorId}`, 'hunor.ctx@test', 'Hunor', now, now).run();
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
       VALUES (?, 'Batch WS', ?, 0, 1, ?, ?)`,
    ).bind(ws, aviId, now, now).run();
    for (const userId of [aviId, hunorId]) {
      await env.DB.prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, 'member', ?, ?, ?)`,
      ).bind(ws, userId, now, now, now).run();
    }
    await env.DB.prepare(
      `INSERT INTO chats (id, workspace_id, author_user_id, title, activity_cursor, created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, 'Batch chat', 0, ?, ?, ?)`,
    ).bind(chat, ws, aviId, now, now, now).run();

    await note('mem_ws_note', 'workspace', null, 'Workspace prefers email invoices.');
    await note('mem_suppressed', 'workspace', null, 'Forgotten scaffold content.');
    await env.DB.prepare(
      `INSERT INTO memory_suppressions (id, workspace_id, target_memory_id, revision, created_at) VALUES (?, ?, ?, 1, ?)`,
    ).bind('sup_1', ws, 'mem_suppressed', now).run();
    await note('mem_avi_note', 'member_in_workspace', aviId, 'Avi prefers morning summaries.');
    await note('mem_hunor_note', 'member_in_workspace', hunorId, 'Hunor prefers evening summaries.');

    // Six entities with unmistakable names; only the first five may contribute notes.
    for (let index = 1; index <= 6; index++) {
      const entityId = `ent_ctx_${index}`;
      await env.DB.prepare(
        `INSERT INTO entities (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind(entityId, ws, `ZetaShop${index}QB`, now, now).run();
      await note(`mem_ent_${index}`, 'entity', entityId, `Standing note for ZetaShop${index}QB.`);
    }
  });

  it('assembles scoped notes while SQL-filtering forgotten entries', async () => {
    const context = await getTurnContext(env.DB, {
      workspaceId: ws,
      actorUserId: aviId,
      chatId: chat,
      sourceText: 'Send the invoice, ZetaShop1QB asked today.',
    });
    const ids = context.activeNotes.map((note) => note.id);
    expect(ids).toContain('mem_ws_note');
    expect(ids).toContain('mem_avi_note');
    expect(ids).toContain('mem_ent_1');
    // Forgotten content stays out of notes and out of the prompt.
    expect(ids).not.toContain('mem_suppressed');
    expect(context.systemPrompt).not.toContain('Forgotten scaffold');
    // Another member's private notes never leak into this actor's context.
    expect(ids).not.toContain('mem_hunor_note');
  });

  it('bounds entity matching to five in one roundtrip', async () => {
    const context = await getTurnContext(env.DB, {
      workspaceId: ws,
      actorUserId: aviId,
      chatId: chat,
      sourceText: 'Roundup for ZetaShop1QB ZetaShop2QB ZetaShop3QB ZetaShop4QB ZetaShop5QB ZetaShop6QB.',
    });
    const ids = context.activeNotes.map((note) => note.id);
    for (let index = 1; index <= 5; index++) {
      expect(ids).toContain(`mem_ent_${index}`);
    }
    expect(ids).not.toContain('mem_ent_6');
  });

  it('keeps an empty workspace usable with no source text', async () => {
    const context = await getTurnContext(env.DB, {
      workspaceId: ws,
      actorUserId: hunorId,
      chatId: chat,
      sourceText: '',
    });
    expect(context.workspaceId).toBe(ws);
    expect(context.systemPrompt).toBeTruthy();
    expect(context.activeNotes.some((note) => note.id === 'mem_avi_note')).toBe(false);
  });

  it('lists platform-backed models with per-model efforts and the current selection', async () => {
    const context = await getTurnContext(env.DB, {
      workspaceId: ws,
      actorUserId: aviId,
      chatId: chat,
      sourceText: 'Which models can I use?',
      platformKeyPresent: { gemini: true, opencode_go: true },
      currentModelKey: 'deepseek-v4.1-flash',
      currentEffortLabel: 'Max',
    });
    expect(context.systemPrompt).toContain('Available Models');
    expect(context.systemPrompt).toContain('DeepSeek V4.1 Flash [current, current effort: Max] (effort: Low/High/Max; images: untested; voice notes: no)');
    expect(context.systemPrompt).toContain('Muse Spark 1.3 Contributor (effort: Minimal/Low/Medium/High/Extra high; images: untested; voice notes: no)');
    expect(context.systemPrompt).toContain('Gemini 3.5 Flash-Lite (effort: Minimal/Low/Medium/High; images: untested; voice notes: yes)');
    expect(context.systemPrompt).not.toContain('Gemini Preview');
  });

  it('omits the catalog when no credential backs any model', async () => {
    const context = await getTurnContext(env.DB, {
      workspaceId: ws,
      actorUserId: aviId,
      chatId: chat,
      sourceText: 'Which models can I use?',
    });
    expect(context.systemPrompt).not.toContain('Available Models');
  });

  it('grants and revokes availability through workspace credential rows', async () => {
    const setCredential = async (provider: string, status: string): Promise<void> => {
      await env.DB.prepare(
        `INSERT INTO provider_credentials (workspace_id, provider, encrypted_key, key_nonce, status, created_at, updated_at)
         VALUES (?, ?, 'test-only', 'test-only', ?, ?, ?)
         ON CONFLICT(workspace_id, provider) DO UPDATE SET status = excluded.status`,
      ).bind(ws, provider, status, now, now).run();
    };
    const promptFor = async (platform?: { gemini?: boolean; opencode_go?: boolean }): Promise<string> => {
      const context = await getTurnContext(env.DB, {
        workspaceId: ws,
        actorUserId: aviId,
        chatId: chat,
        sourceText: 'Which models can I use?',
        ...(platform ? { platformKeyPresent: platform } : {}),
        currentModelKey: 'muse-13',
      });
      return context.systemPrompt;
    };
    await setCredential('gemini', 'available');
    expect(await promptFor()).toContain('Gemini 3.5 Flash-Lite');
    expect(await promptFor()).not.toContain('Muse Spark 1.3 Contributor');
    await setCredential('opencode_go', 'available');
    const withGo = await promptFor();
    expect(withGo).toContain('Muse Spark 1.3 Contributor [current] (effort: Minimal/Low/Medium/High/Extra high; images: untested; voice notes: no)');
    await setCredential('opencode_go', 'invalid_credential');
    expect(await promptFor()).not.toContain('Muse Spark 1.3 Contributor');
    // A non-available row shadows platform keys, exactly like model selection.
    expect(await promptFor({ opencode_go: true })).not.toContain('Muse Spark 1.3 Contributor');
    expect(await promptFor({ opencode_go: true })).not.toContain('DeepSeek V4.1 Flash');
    await env.DB.prepare(`DELETE FROM provider_credentials WHERE workspace_id = ?`).bind(ws).run();
  });

  it('ranks member, entity and text-search notes before general notes in every language', async () => {
    // Isolated scope: every seeded note fits the cap, so order is exact.
    const iso = (day: string) => `${day}T10:00:00.000Z`;
    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind('usr_ctx_f10', 'fb_f10', 'f10@test', 'F10', iso('2026-10-01'), iso('2026-10-01')).run();
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
       VALUES ('ws-context-f10', 'F10 WS', 'usr_ctx_f10', 0, 1, ?, ?)`,
    ).bind(iso('2026-10-01'), iso('2026-10-01')).run();
    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES ('ws-context-f10', 'usr_ctx_f10', 'member', ?, ?, ?)`,
    ).bind(iso('2026-10-01'), iso('2026-10-01'), iso('2026-10-01')).run();
    await env.DB.prepare(
      `INSERT INTO entities (id, workspace_id, name, created_at, updated_at) VALUES ('ent_f10_shop', 'ws-context-f10', 'F10Shop', ?, ?)`,
    ).bind(iso('2026-10-01'), iso('2026-10-01')).run();
    const seedF10Note = (id: string, scope: string, subject: string | null, content: string, observed: string) =>
      env.DB.prepare(
        `INSERT INTO memory_entries (id, workspace_id, scope, subject_id, category, content, status, observed_at, created_at, business_revision)
         VALUES (?, 'ws-context-f10', ?, ?, 'other_context', ?, 'active', ?, ?, 0)`,
      ).bind(id, scope, subject, content, observed, observed).run();
    await seedF10Note('f10_general_ro', 'workspace', null, 'Factură restantă pentru brutărie.', iso('2026-10-06'));
    await seedF10Note('f10_general_hu', 'workspace', null, 'Lejárt számla a pékség számára.', iso('2026-10-06'));
    await seedF10Note('f10_general_en', 'workspace', null, 'Overdue invoice for the bakery.', iso('2026-10-06'));
    await seedF10Note('f10_member', 'member_in_workspace', 'usr_ctx_f10', 'Avi esti riportot kér.', iso('2026-10-06'));
    await seedF10Note('f10_ent', 'entity', 'ent_f10_shop', 'Notă permanentă pentru F10Shop.', iso('2026-10-06'));
    await seedF10Note('f10_search', 'workspace', null, 'Ledger holds the zxcvan receipt.', iso('2026-10-06'));
    await env.DB.prepare(`INSERT INTO memory_entries_fts (entry_id, content) VALUES (?, ?)`)
      .bind('f10_search', 'Ledger holds the zxcvan receipt.')
      .run();
    const context = await getTurnContext(env.DB, {
      workspaceId: 'ws-context-f10',
      actorUserId: 'usr_ctx_f10',
      chatId: null,
      sourceText: 'F10Shop zxcvan Rugăciune factură számla invoice',
    });
    const ids = context.activeNotes.map(n => n.id);
    // Same instant everywhere: tier decides, id breaks ties deterministically.
    expect(ids).toEqual([
      'f10_ent',
      'f10_member',
      'f10_search',
      'f10_general_en',
      'f10_general_hu',
      'f10_general_ro',
    ]);
    // All three languages survive wherever they rank: ordering never reads language.
    const contents = context.activeNotes.map(n => n.content).join(' ');
    expect(contents).toContain('Avi esti riportot kér');
    expect(contents).toContain('Notă permanentă');
    expect(contents).toContain('Overdue invoice');
  });

  it('names the acting member and roster, and labels other members’ turns', async () => {
    const iso = (day: string) => `${day}T10:00:00.000Z`;
    await env.DB.prepare(
      `INSERT INTO chat_messages (id, workspace_id, chat_id, author_user_id, author_kind, channel, content_text, sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'member', 'web', ?, ?, ?, ?)`,
    ).bind('cm_ctx_avi_1', ws, chat, aviId, 'I will handle the Cluj visit.', 10, iso('2026-10-07'), iso('2026-10-07')).run();
    await env.DB.prepare(
      `INSERT INTO chat_messages (id, workspace_id, chat_id, author_user_id, author_kind, channel, content_text, sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'member', 'web', ?, ?, ?, ?)`,
    ).bind('cm_ctx_hunor_1', ws, chat, hunorId, 'I met them yesterday.', 11, iso('2026-10-07'), iso('2026-10-07')).run();
    const context = await getTurnContext(env.DB, {
      workspaceId: ws,
      actorUserId: aviId,
      chatId: chat,
      sourceText: 'What did Hunor say?',
    });
    expect(context.systemPrompt).toContain('Current Member: Avi');
    expect(context.systemPrompt).toContain('Workspace members: Avi, Hunor');
    const texts = context.recentMessages.map((m) => m.text);
    // Own turns stay bare; a teammate's turn carries their name.
    expect(texts).toContain('I will handle the Cluj visit.');
    expect(texts).toContain('Hunor: I met them yesterday.');
  });

  it('enforces the character budget with whole notes, never mid-fact truncation', async () => {
    const iso = (day: string) => `${day}T10:00:00.000Z`;
    await env.DB.prepare(
      `INSERT INTO users (id, firebase_uid, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind('usr_ctx_budget', 'fb_budget', 'budget@test', 'Budget', iso('2026-10-01'), iso('2026-10-01')).run();
    await env.DB.prepare(
      `INSERT INTO workspaces (id, name, owner_user_id, business_revision, membership_revision, created_at, updated_at)
       VALUES ('ws-context-budget', 'Budget WS', 'usr_ctx_budget', 0, 1, ?, ?)`,
    ).bind(iso('2026-10-01'), iso('2026-10-01')).run();
    await env.DB.prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at) VALUES ('ws-context-budget', 'usr_ctx_budget', 'member', ?, ?, ?)`,
    ).bind(iso('2026-10-01'), iso('2026-10-01'), iso('2026-10-01')).run();
    await env.DB.prepare(
      `INSERT INTO memory_entries (id, workspace_id, scope, subject_id, category, content, status, observed_at, created_at, business_revision)
       VALUES
        ('mem_big_general', 'ws-context-budget', 'workspace', NULL, 'other_context', ?, 'active', ?, ?, 0),
        ('mem_small_member', 'ws-context-budget', 'member_in_workspace', 'usr_ctx_budget', 'other_context', 'Small personal fact.', 'active', ?, ?, 0)`,
    ).bind('x'.repeat(10000), iso('2026-10-06'), iso('2026-10-06'), iso('2026-10-05'), iso('2026-10-05')).run();
    const context = await getTurnContext(env.DB, {
      workspaceId: 'ws-context-budget',
      actorUserId: 'usr_ctx_budget',
      chatId: null,
      sourceText: 'hi',
    });
    const ids = context.activeNotes.map(n => n.id);
    expect(ids).toContain('mem_small_member');
    expect(ids).not.toContain('mem_big_general');
    const total = context.activeNotes.reduce((sum, n) => sum + n.content.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
  });

  it('marks voice notes supported for all models when Groq STT is available', async () => {
    const context = await getTurnContext(env.DB, {
      workspaceId: ws,
      actorUserId: aviId,
      chatId: chat,
      sourceText: 'hi',
      platformKeyPresent: { groq: true, opencode_go: true },
    });
    // In Otis, all models can receive and answer voice notes via Groq STT
    expect(context.systemPrompt).toContain('Muse Spark 1.3 Contributor');
    expect(context.systemPrompt).toMatch(/Muse Spark 1\.3 Contributor.*voice notes: yes/);
  });
});
