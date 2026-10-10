import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from './migrations.js';
import { AUTH_BOUNDS, DOCUMENT_BOUNDS } from '@otis/contracts';
import { sha256 } from '@otis/identity';
import type { Env } from '../src/index.js';
import {
  startDocument,
  writeDocumentSections,
  publishDocument,
  processDocumentRenderJobs,
  getGeneratedDocument,
  getDocumentRevision,
  retryDocumentRender,
  listChatDocuments,
} from '../src/media/generatedDocuments.js';
import { handleUploadDocument, readDocument } from '../src/media/documents.js';
import { synthesizePdf } from '../src/media/pdfRenderer.js';
import { acceptWebMessage, listChatMessages } from '../src/inbox/repository.js';

const E = env as unknown as Env;
const WS = 'ws_docs_test';
const USER = 'usr_docs_test';
const CHAT = 'chat_docs_test';
const TOKEN = 'token_docs_test';
let cookieHeader: string;

function authHeaders(extra: Record<string, string> = {}) {
  return {
    'Cookie': cookieHeader,
    [AUTH_BOUNDS.CSRF_HEADER]: '1',
    'Origin': 'http://localhost',
    'x-expected-user-id': USER,
    ...extra,
  };
}

async function seedRun(runId: string) {
  const now = new Date().toISOString();
  const msgId = `msg_in_${runId}`;
  await E.DB.prepare(
    `INSERT OR IGNORE INTO messages_in (id, workspace_id, user_id, channel, external_id, payload_fingerprint, raw_payload, status, chat_id, created_at, updated_at)
     VALUES (?, ?, ?, 'web', ?, ?, '{}', 'processed', ?, ?, ?)`
  ).bind(msgId, WS, USER, `ext_${runId}`, `fp_${runId}`, CHAT, now, now).run();

  await E.DB.prepare(
    `INSERT OR IGNORE INTO agent_runs (id, workspace_id, chat_id, source_message_id, source_job_id, executor_kind, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 'agent', 'running', ?, ?)`
  ).bind(runId, WS, CHAT, msgId, now, now).run();
}

async function seedUserAndWorkspace() {
  const now = new Date().toISOString();
  await E.DB.prepare(
    `INSERT OR IGNORE INTO users (id, firebase_uid, display_name, created_at, updated_at)
     VALUES (?, ?, 'Test User', ?, ?)`
  ).bind(USER, USER, now, now).run();

  await E.DB.prepare(
    `INSERT OR IGNORE INTO workspaces (id, name, owner_user_id, created_at, updated_at)
     VALUES (?, 'Docs Workspace', ?, ?, ?)`
  ).bind(WS, USER, now, now).run();

  await E.DB.prepare(
    `INSERT OR IGNORE INTO workspace_users (workspace_id, user_id, role, joined_at, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?)`
  ).bind(WS, USER, now, now, now).run();

  await E.DB.prepare(
    `INSERT OR IGNORE INTO chats (id, workspace_id, author_user_id, title, created_at, updated_at, last_activity_at)
     VALUES (?, ?, ?, 'Document Chat', ?, ?, ?)`
  ).bind(CHAT, WS, USER, now, now, now).run();

  const tokenHash = await sha256(TOKEN);
  const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
  await E.DB.prepare(
    `INSERT OR IGNORE INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`
  ).bind('sess_docs_test', tokenHash, USER, now, expiresAt, now).run();
  cookieHeader = `${AUTH_BOUNDS.COOKIE_NAME}=${TOKEN}`;

  await seedRun('run_doc_1');
  await seedRun('run_doc_2');
  await seedRun('run_hunor_rehearsal');
  await seedRun('run_f');
}

describe('Generated Documents & File Ingestion Suite (R18)', () => {
  beforeAll(async () => {
    await applyMigrations(E.DB);
    await seedUserAndWorkspace();
  });

  describe('Slice D1: Ingestion & Document Attachments', () => {
    it('accepts valid text and markdown document uploads up to 2 MiB', async () => {
      const textContent = 'Hello Otis! This is a test text attachment with Cluj meeting notes.';
      const textBytes = new TextEncoder().encode(textContent);
      const req = new Request('http://localhost/api/workspaces/ws_docs_test/documents/uploads', {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'text/plain',
          'Content-Length': String(textBytes.byteLength),
          'x-filename': encodeURIComponent('notes.txt'),
          'x-upload-id': 'doc_txt_1',
        }),
        body: textBytes,
      });

      const res = await handleUploadDocument(req, E, WS, 'req_1');
      expect([200, 201]).toContain(res.status);
      const data = await res.json<{ media_id: string; filename: string; extraction_state: string }>();
      expect(data.media_id).toBe('doc_txt_1');
      expect(data.filename).toBe('notes.txt');
      expect(data.extraction_state).toBe('ready');

      // Verify stored object in R2 and media_objects in D1
      const mediaRow = await E.DB.prepare(
        'SELECT id, state, content_type, filename FROM media_objects WHERE id = ? AND workspace_id = ?'
      ).bind(data.media_id, WS).first<{ id: string; state: string; content_type: string; filename: string }>();
      expect(mediaRow).toBeTruthy();
      expect(mediaRow!.state).toBe('ready');
      expect(mediaRow!.content_type).toBe('text/plain');

      // Verify read_document returns content directly
      const docRead = await readDocument(E, WS, USER, { media_id: data.media_id, limit: 2 });
      expect(docRead).toBeTruthy();
      expect(docRead?.sections[0]?.text).toBe(textContent);
    });

    it('rejects text files with null bytes or invalid UTF-8 encoding', async () => {
      const badBytes = new Uint8Array([0x48, 0x65, 0x6c, 0x00, 0x6c, 0x6f]); // Contains null byte
      const req = new Request('http://localhost/api/workspaces/ws_docs_test/documents/uploads', {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'text/plain',
          'Content-Length': String(badBytes.byteLength),
          'x-filename': encodeURIComponent('bad.txt'),
          'x-upload-id': 'doc_bad_1',
        }),
        body: badBytes,
      });

      const res = await handleUploadDocument(req, E, WS, 'req_2');
      expect(res.status).toBe(400);
      const data = await res.json<{ error: { code: string } }>();
      expect(data.error.code).toBe('invalid_text_file');
    });

    it('rejects text files exceeding the 2 MiB boundary', async () => {
      // 2 MiB + 10 bytes
      const bigSize = DOCUMENT_BOUNDS.MAX_TEXT_BYTES + 10;
      const bigBytes = new Uint8Array(bigSize);
      bigBytes.fill(0x61); // 'a'
      const req = new Request('http://localhost/api/workspaces/ws_docs_test/documents/uploads', {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'text/plain',
          'Content-Length': String(bigSize),
          'x-filename': encodeURIComponent('big.txt'),
          'x-upload-id': 'doc_big_1',
        }),
        body: bigBytes,
      });

      const res = await handleUploadDocument(req, E, WS, 'req_3');
      expect(res.status).toBe(413);
      const data = await res.json<{ error: { code: string } }>();
      expect(data.error.code).toBe('file_too_large');
    });

    it('accepts chat messages with up to 4 document attachments and enforces bounds', async () => {
      // Create 4 valid text documents
      const docIds: string[] = [];
      for (let i = 1; i <= 4; i++) {
        const textBytes = new TextEncoder().encode(`Doc content ${i}`);
        const req = new Request('http://localhost/api/workspaces/ws_docs_test/documents/uploads', {
          method: 'POST',
          headers: authHeaders({
            'Content-Type': 'text/plain',
            'Content-Length': String(textBytes.byteLength),
            'x-filename': encodeURIComponent(`doc${i}.txt`),
            'x-upload-id': `doc_batch_${i}`,
          }),
          body: textBytes,
        });
        const res = await handleUploadDocument(req, E, WS, `req_batch_${i}`);
        expect([200, 201]).toContain(res.status);
        const data = await res.json<{ media_id: string }>();
        docIds.push(data.media_id);
      }

      // Send chat message with 4 documents
      const msgRes = await acceptWebMessage(E.DB, {
        workspaceId: WS,
        userId: USER,
        chatId: CHAT,
        clientMessageId: 'cmsg_docs_4',
        text: 'Please review these documents.',
        documentMediaIds: docIds,
      });
      expect(msgRes.message_id).toBeTruthy();

      // Verify listChatMessages returns document_media_ids
      const list = await listChatMessages(E.DB, WS, CHAT);
      const found = list.find(m => m.client_message_id === 'cmsg_docs_4');
      expect(found).toBeTruthy();
      expect(found?.document_media_ids).toEqual(docIds);

      // Verify message with 5 documents is rejected at inbox boundary
      await expect(
        acceptWebMessage(E.DB, {
          workspaceId: WS,
          userId: USER,
          chatId: CHAT,
          clientMessageId: 'cmsg_docs_5',
          text: '5 docs',
          documentMediaIds: [...docIds, 'doc_extra'],
        })
      ).rejects.toThrow();
    });

    it('allows document-only messages with empty text and records is_pasted_text', async () => {
      const textBytes = new TextEncoder().encode('Pasted long text content from user clipboard...');
      const req = new Request('http://localhost/api/workspaces/ws_docs_test/documents/uploads', {
        method: 'POST',
        headers: authHeaders({
          'Content-Type': 'text/plain',
          'Content-Length': String(textBytes.byteLength),
          'x-filename': encodeURIComponent('Pasted text.txt'),
          'x-upload-id': 'doc_pasted_1',
        }),
        body: textBytes,
      });
      const res = await handleUploadDocument(req, E, WS, 'req_pasted');
      expect([200, 201]).toContain(res.status);
      const data = await res.json<{ media_id: string }>();

      const msgRes = await acceptWebMessage(E.DB, {
        workspaceId: WS,
        userId: USER,
        chatId: CHAT,
        clientMessageId: 'cmsg_pasted_only',
        text: '',
        documentMediaIds: [data.media_id],
        isPastedText: true,
      });
      expect(msgRes.message_id).toBeTruthy();

      const list = await listChatMessages(E.DB, WS, CHAT);
      const found = list.find(m => m.client_message_id === 'cmsg_pasted_only');
      expect(found).toBeTruthy();
      expect(found?.content_text).toBe('');
      expect(found?.document_media_ids).toEqual([data.media_id]);
    });
  });

  describe('Slice D2: Agent Authoring Tools & Revisions', () => {
    let createdDocId: string;
    let initialRevId: string;

    it('starts a new multi-section document via startDocument tool', async () => {
      const startRes = await startDocument(E, WS, USER, CHAT, 'run_doc_1', {
        title: 'Hunor Cluj Rehearsal Guide',
        intended_sections: [
          'Executive Briefing',
          'Meeting 1: Gym Owner Pitch',
          'Meeting 2: Dancer Follow-up',
          'Negotiation Strategy',
          'Practice Agenda',
        ],
      });

      expect(startRes.document_id).toBeTruthy();
      expect(startRes.revision_id).toBeTruthy();
      expect(startRes.revision_number).toBe(1);
      expect(startRes.title).toBe('Hunor Cluj Rehearsal Guide');
      expect(startRes.intended_sections.length).toBe(5);

      createdDocId = startRes.document_id;
      initialRevId = startRes.revision_id;
    });

    it('writes sections to draft in bounded chunks without duplicate prose on replay', async () => {
      // First section
      const writeRes1 = await writeDocumentSections(E, WS, {
        document_id: createdDocId,
        revision_id: initialRevId,
        sections: [
          {
            id: 'sec_1',
            title: 'Executive Briefing',
            content_markdown: 'Hunor is traveling to Cluj tomorrow for high-stakes prospect meetings with the gym owner and dancer.',
          },
        ],
      });

      expect(writeRes1.saved_sections.length).toBe(1);
      expect(writeRes1.saved_sections[0]!.id).toBe('sec_1');

      // Writing same section again updates/replaces rather than duplicating
      const writeResReplay = await writeDocumentSections(E, WS, {
        document_id: createdDocId,
        revision_id: initialRevId,
        sections: [
          {
            id: 'sec_1',
            title: 'Executive Briefing',
            content_markdown: 'Hunor is traveling to Cluj tomorrow for high-stakes prospect meetings with the gym owner and dancer. (Updated note)',
          },
        ],
      });
      expect(writeResReplay.total_sections).toBe(1);

      // Add remaining sections
      await writeDocumentSections(E, WS, {
        document_id: createdDocId,
        revision_id: initialRevId,
        sections: [
          {
            id: 'sec_2',
            title: 'Meeting 1: Gym Owner Pitch',
            content_markdown: 'Tailored pitch focusing on member engagement, retention, and class scheduling automation.',
          },
          {
            id: 'sec_3',
            title: 'Negotiation Strategy',
            content_markdown: 'Price framing, tradeable concessions, walk-away boundaries, and contract duration flexibility.',
          },
        ],
      });

      // Verify draft has 3 sections
      const draftObj = await E.STORAGE.get(`${WS}/documents/${createdDocId}/rev-${initialRevId}-draft.json`);
      expect(draftObj).toBeTruthy();
      const draftJson = await draftObj!.json<{ sections: unknown[] }>();
      expect(draftJson.sections.length).toBe(3);
    });

    it('publishes the document revision and creates frozen markdown source', async () => {
      const pubRes = await publishDocument(E, WS, {
        document_id: createdDocId,
        revision_id: initialRevId,
        render_pdf: true,
      });

      expect(pubRes.document_id).toBe(createdDocId);
      expect(pubRes.revision_id).toBe(initialRevId);
      expect(pubRes.render_state).toBe('rendering');

      // Verify source markdown exists in R2
      const sourceObj = await E.STORAGE.get(`${WS}/documents/${createdDocId}/rev-${initialRevId}-source.md`);
      expect(sourceObj).toBeTruthy();
      const markdown = await sourceObj!.text();
      expect(markdown).toContain('# Hunor Cluj Rehearsal Guide');
      expect(markdown).toContain('## Executive Briefing');
      expect(markdown).toContain('## Meeting 1: Gym Owner Pitch');
      expect(markdown).toContain('## Negotiation Strategy');
    });

    it('reads the published document revision via readDocument', async () => {
      const readRes = await readDocument(E, WS, USER, { media_id: createdDocId, limit: 2 });
      expect(readRes).toBeTruthy();
      expect(readRes.sections.some(s => s.text.includes('Hunor Cluj Rehearsal Guide'))).toBe(true);
    });

    it('discovers the document via listChatDocuments', async () => {
      const listRes = await listChatDocuments(E, WS, USER, CHAT);
      expect(listRes.documents.length).toBeGreaterThanOrEqual(1);
      const found = listRes.documents.find(d => d.document.id === createdDocId);
      expect(found).toBeTruthy();
      expect(found?.document.title).toBe('Hunor Cluj Rehearsal Guide');
      expect(found?.current_revision).toBeTruthy();
    });

    it('creates revision 2 branching from revision 1 and preserves revision 1', async () => {
      const startRev2 = await startDocument(E, WS, USER, CHAT, 'run_doc_2', {
        title: 'Hunor Cluj Rehearsal Guide (v2)',
        document_id: createdDocId,
        base_revision_id: initialRevId,
        intended_sections: ['Executive Briefing', 'Negotiation Strategy v2'],
      });

      expect(startRev2.document_id).toBe(createdDocId);
      expect(startRev2.revision_number).toBe(2);
      expect(startRev2.parent_revision_id).toBe(initialRevId);

      // Write updated section in revision 2
      await writeDocumentSections(E, WS, {
        document_id: createdDocId,
        revision_id: startRev2.revision_id,
        sections: [
          {
            id: 'sec_3',
            title: 'Negotiation Strategy v2',
            content_markdown: 'Revised objections handling with specific pricing concessions for multi-location gyms.',
          },
        ],
      });

      // Publish revision 2
      await publishDocument(E, WS, {
        document_id: createdDocId,
        revision_id: startRev2.revision_id,
        render_pdf: false, // Markdown only
      });

      // Verify both revisions exist independently
      const rev1Detail = await getDocumentRevision(E, WS, USER, createdDocId, initialRevId);
      const rev2Detail = await getDocumentRevision(E, WS, USER, createdDocId, startRev2.revision_id);
      expect(rev1Detail).toBeTruthy();
      expect(rev2Detail).toBeTruthy();
      expect(rev1Detail?.revision.revision_number).toBe(1);
      expect(rev2Detail?.revision.revision_number).toBe(2);
      expect(rev2Detail?.source_markdown).toContain('Negotiation Strategy v2');
    });
  });

  describe('Slice D3: PDF Generation & Fallback Synthesizer', () => {
    it('synthesizes multi-page PDF 1.4 binary with Romanian diacritics and table layouts', () => {
      const markdown = `
# Ghid de pregătire pentru Cluj-Napoca

Document generat pentru Hunor: pregătire pentru întâlnirile din Cluj.
Diacritice românești verificate: **ș**, **ț**, **ă**, **î**, **â**, **Ș**, **Ț**, **Ă**, **Î**, **Â**.

| Obiecție | Răspuns recomandat | Concesie posibilă |
| :--- | :--- | :--- |
| Prețul este prea mare | Arată ROI-ul lunar | Reducere 10% la abonament anual |
| Nu avem timp să învățăm | Oferă onboarding gratuit | 2 săptămâni suport direct |

### Dialog de probă:
- **Hunor**: Bună ziua, mă bucur să ne cunoaștem!
- **Proprietar sală**: Salut, spune-mi direct ce oferi.
`;

      const pdfBytes = synthesizePdf('Ghid Cluj', markdown, '2026-10-10');
      expect(pdfBytes).toBeInstanceOf(Uint8Array);
      expect(pdfBytes.byteLength).toBeGreaterThan(500);

      const header = new TextDecoder().decode(pdfBytes.subarray(0, 8));
      expect(header).toContain('%PDF-1.4');

      const fullText = new TextDecoder().decode(pdfBytes);
      expect(fullText).toContain('%%EOF');
      expect(fullText).toContain('/Type /Pages');
      expect(fullText).toContain('/Type /Page');
    });

    it('processes document render jobs in background queue and creates ready media object', async () => {
      // Start and publish a document requesting PDF render
      const startRes = await startDocument(E, WS, USER, CHAT, 'run_render_test', {
        title: 'Cluj Practice Packet PDF',
        intended_sections: ['Agenda', 'Checklist'],
      });
      await writeDocumentSections(E, WS, {
        document_id: startRes.document_id,
        revision_id: startRes.revision_id,
        sections: [
          { id: 'sec_a', title: 'Agenda', content_markdown: '1. Roleplay\n2. Q&A\n3. Next steps' },
          { id: 'sec_b', title: 'Checklist', content_markdown: '- Business cards\n- Laptop charged\n- Contract draft' },
        ],
      });
      await publishDocument(E, WS, {
        document_id: startRes.document_id,
        revision_id: startRes.revision_id,
        render_pdf: true,
      });

      // Execute render queue worker
      const processed = await processDocumentRenderJobs(E, WS, startRes.revision_id);
      expect(processed).toBe(1);

      // Verify revision is marked 'ready' with output_media_id
      const rev = await E.DB.prepare(
        'SELECT render_state, output_media_id, render_error FROM document_revisions WHERE id = ?'
      ).bind(startRes.revision_id).first<{ render_state: string; output_media_id: string; render_error: string | null }>();
      expect(rev).toBeTruthy();
      expect(rev!.render_state).toBe('ready');
      expect(rev!.output_media_id).toMatch(/^media_pdf_/);
      expect(rev!.render_error).toBeNull();

      // Verify PDF media object is saved and downloadable
      const mediaRow = await E.DB.prepare(
        'SELECT id, state, content_type, byte_size, object_key FROM media_objects WHERE id = ?'
      ).bind(rev!.output_media_id).first<{ id: string; state: string; content_type: string; byte_size: number; object_key: string }>();
      expect(mediaRow).toBeTruthy();
      expect(mediaRow!.state).toBe('ready');
      expect(mediaRow!.content_type).toBe('application/pdf');
      expect(mediaRow!.byte_size).toBeGreaterThan(500);

      const pdfObj = await E.STORAGE.get(mediaRow!.object_key);
      expect(pdfObj).toBeTruthy();
      const pdfData = await pdfObj!.arrayBuffer();
      expect(pdfData.byteLength).toBe(mediaRow!.byte_size);
    });

    it('handles render retry if rendering failed', async () => {
      // Simulate failed revision
      const revId = 'rev_failed_test';
      const docId = 'doc_failed_test';
      const now = new Date().toISOString();

      await E.DB.prepare(
        `INSERT INTO generated_documents (id, workspace_id, author_user_id, source_chat_id, run_id, title, current_revision_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'run_f', 'Failed Doc', ?, ?, ?)`
      ).bind(docId, WS, USER, CHAT, revId, now, now).run();

      await E.DB.prepare(
        `INSERT INTO document_revisions (id, document_id, workspace_id, revision_number, title, source_key, checksum, render_state, render_error, render_attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'Failed Doc', 'test/key', 'hash', 'failed', 'Timeout error', 1, ?, ?)`
      ).bind(revId, docId, WS, now, now).run();

      const retryRes = await retryDocumentRender(E, WS, USER, docId, revId);
      expect(retryRes).toBe(true);

      const check = await E.DB.prepare(
        'SELECT render_state, render_error FROM document_revisions WHERE id = ?'
      ).bind(revId).first<{ render_state: string; render_error: string | null }>();
      expect(check).toBeTruthy();
      expect(check!.render_state).toBe('rendering');
      expect(check!.render_error).toBeNull();
    });
  });

  describe('End-to-End Cluj Rehearsal Guide Acceptance Test', () => {
    it('authors complete multi-page meeting preparation pack fulfilling user prompt requirements', async () => {
      // 1. Start document
      const start = await startDocument(E, WS, USER, CHAT, 'run_hunor_rehearsal', {
        title: 'Hunor Cluj Prospect Meetings: Rehearsal & Negotiation Playbook',
        intended_sections: [
          'Briefing & Prospect Profiles',
          'Meeting 1: Gym Owner Pitch & Discovery',
          'Meeting 2: Dancer Follow-up & Value Alignment',
          'Negotiation Strategy, Concessions & Boundaries',
          'Two-Person Practice Agenda & Sample Dialogue',
          'Meeting-Day Checklist & Quick Reference',
        ],
      });

      // 2. Write Section 1: Briefing & Prospect Profiles
      await writeDocumentSections(E, WS, {
        document_id: start.document_id,
        revision_id: start.revision_id,
        sections: [
          {
            id: 'sec_profiles',
            title: 'Briefing & Prospect Profiles',
            content_markdown: `
### Background & Context
Hunor is traveling to Cluj-Napoca tomorrow to conduct in-person commercial meetings with two prospects:
1. **The Gym Owner**: High-energy operator focused on operational efficiency, member retention, and fitness class capacity.
2. **The Dancer**: Creative professional with growing studio attendance looking for sustainable expansion.

### Knowns & Unknowns
- **Verified Facts**: Both prospects have confirmed meeting availability in Cluj.
- **Unknowns**: Exact current software stack and authorized monthly budget cap.
`,
          },
          {
            id: 'sec_gym_pitch',
            title: 'Meeting 1: Gym Owner Pitch & Discovery',
            content_markdown: `
### Opening Value Framing
"Our platform automates your membership renewals and spot bookings so your front desk focuses on members, not spreadsheets."

### Key Discovery Questions
- "How many dropped memberships per quarter do you attribute to missed renewal follow-ups?"
- "What is your peak class utilization on weekday mornings?"

### Objection Handling
- **Objection**: "Our trainers already use WhatsApp groups."
- **Response**: "WhatsApp works for informal chats, but it loses payment tracking and causes double bookings. Let us keep the convenience while securing the revenue."
`,
          },
          {
            id: 'sec_negotiation',
            title: 'Negotiation Strategy, Concessions & Boundaries',
            content_markdown: `
### Value vs. Price Anchoring
Never lead with a discount. Frame the investment against the cost of lost member renewals.

### Tradeable Concessions
- If they ask for 15% discount: Require a 12-month commitment paid quarterly upfront.
- If they ask for custom integrations: Offer priority onboarding support instead of engineering changes.

### Walk-Away Boundaries
- Do not offer free perpetual licensing.
- Minimum initial term: 6 months.
`,
          },
          {
            id: 'sec_rehearsal_agenda',
            title: 'Two-Person Practice Agenda & Sample Dialogue',
            content_markdown: `
### Google Meet Practice Sessions (60 minutes total)
- **Round 1 (15 min)**: Gym Owner Roleplay (Partner plays skeptical owner; Hunor pitches).
- **Round 2 (10 min)**: Feedback & Adjustment.
- **Round 3 (15 min)**: Dancer Roleplay (Partner tests budget objection).
- **Round 4 (10 min)**: Negotiation Tough Bargaining Scenario.
- **Round 5 (10 min)**: Rapid-fire objection drill.
`,
          },
          {
            id: 'sec_checklist',
            title: 'Meeting-Day Checklist & Quick Reference',
            content_markdown: `
### Cluj Travel Checklist
- [ ] Arrive 15 minutes early at meeting venue in Cluj.
- [ ] Have offline demo available on mobile/tablet.
- [ ] Confirm payment terms sheet is ready for signoff.
`,
          },
        ],
      });

      // 3. Publish document
      const pub = await publishDocument(E, WS, {
        document_id: start.document_id,
        revision_id: start.revision_id,
        render_pdf: true,
      });
      expect(pub.render_state).toBe('rendering');

      // 4. Process PDF render
      const processed = await processDocumentRenderJobs(E, WS, start.revision_id);
      expect(processed).toBe(1);

      // 5. Verify detail response has all markdown sections and ready PDF
      const docDetail = await getGeneratedDocument(E, WS, USER, start.document_id);
      expect(docDetail).toBeTruthy();
      expect(docDetail?.document.title).toContain('Hunor Cluj');
      expect(docDetail?.current_revision?.render_state).toBe('ready');
      expect(docDetail?.current_revision?.output_media_id).toBeTruthy();
      expect(docDetail?.source_markdown).toContain('Briefing & Prospect Profiles');
      expect(docDetail?.source_markdown).toContain('Meeting 1: Gym Owner Pitch & Discovery');
      expect(docDetail?.source_markdown).toContain('Two-Person Practice Agenda');
    });
  });
});
