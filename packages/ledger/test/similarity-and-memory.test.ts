/**
 * @otis/ledger/test/similarity-and-memory.test.ts
 * Pure unit tests for entity similarity ranking (diacritics, collisions, order-independence)
 * and durable memory commands, reducers, and projection rebuilds.
 * In accordance with plans/006-implementation-handoff.md Section 5, 9, 11 (006A).
 */

import { describe, expect, it } from 'vitest';
import {
  foldDiacritics,
  normalizeName,
  rankEntityMatches,
  findPotentialDuplicate,
  MATCH_MIN_SCORE,
  MATCH_MIN_MARGIN,
  handleRememberContext,
  handleForgetMemory,
  handleMarkMessageSent,
  reduceMemory,
  rebuildProjections,
  type LedgerCommandContext,
  type LedgerProjectionState,
} from '../src/index.js';
import type { LedgerEvent, MemoryEntry, MemorySuppression } from '@otis/contracts';

describe('006A: Entity Similarity, Diacritics, and Collision Detection', () => {
  it('correctly folds Romanian and Hungarian diacritics via Unicode NFKD normalization', () => {
    // Romanian: ș, ț, ă, î, â
    expect(foldDiacritics('Timișoara')).toBe('timisoara');
    expect(foldDiacritics('Bistrița')).toBe('bistrita');
    expect(foldDiacritics('Câmpina')).toBe('campina');
    expect(foldDiacritics('Brăila')).toBe('braila');

    // Hungarian: ő, ű, á, é, í, ó, ö, ú, ü
    expect(foldDiacritics('Kávézó')).toBe('kavezo');
    expect(foldDiacritics('Csíkszereda')).toBe('csikszereda');
    expect(foldDiacritics('Győr')).toBe('gyor');
    expect(foldDiacritics('Hűvösvölgy')).toBe('huvosvolgy');

    // Normalization and matching bounds
    expect(normalizeName('Ștefan!')).toBe('stefan');
    expect(MATCH_MIN_SCORE).toBe(0.85);
    expect(MATCH_MIN_MARGIN).toBe(0.10);
  });

  it('matches entity queries preserving order-independence', () => {
    const listA = [
      { id: 'ent-1', name: 'Alpha Bistro' },
      { id: 'ent-2', name: 'Beta Cafe' },
      { id: 'ent-3', name: 'Gamma Diner' },
    ];
    const listB = [
      { id: 'ent-3', name: 'Gamma Diner' },
      { id: 'ent-1', name: 'Alpha Bistro' },
      { id: 'ent-2', name: 'Beta Cafe' },
    ];

    const resA = rankEntityMatches('alpha bistro', listA);
    const resB = rankEntityMatches('alpha bistro', listB);

    expect(resA.bestMatch?.id).toBe('ent-1');
    expect(resB.bestMatch?.id).toBe('ent-1');
    expect(resA.bestMatch?.score).toBe(resB.bestMatch?.score);
    expect(resA.candidates.map((c) => c.id)).toEqual(resB.candidates.map((c) => c.id));
  });

  it('detects accent_fold_collision when two distinct entities fold to the same query', () => {
    // E.g. "Kávézó" and "Kavezó" both fold to "kavezo"
    const entities = [
      { id: 'ent-1', name: 'Kávézó' },
      { id: 'ent-2', name: 'Kavezó' },
    ];

    const result = rankEntityMatches('kavezo', entities);
    expect(result.isAmbiguous).toBe(true);
    expect(result.ambiguityReason).toBe('accent_fold_collision');
    expect(result.bestMatch).toBeUndefined();
    expect(result.candidates.length).toBe(2);
  });

  it('detects score_margin_too_close when two candidates score within MATCH_MIN_MARGIN', () => {
    // Two closely named leads where neither is an exact match
    const entities = [
      { id: 'ent-1', name: 'Restaurant Bella' },
      { id: 'ent-2', name: 'Restaurant Belle' },
    ];

    const result = rankEntityMatches('Restaurant Bell', entities);
    expect(result.isAmbiguous).toBe(true);
    expect(result.ambiguityReason).toBe('score_margin_too_close');
    expect(result.bestMatch).toBeUndefined();
  });

  it('does not automatically merge two similarly named leads', () => {
    const entities = [
      { id: 'ent-1', name: 'Trattoria Roma' },
      { id: 'ent-2', name: 'Trattoria Romana' },
    ];

    // Searching for "Trattoria Roman" is ambiguous between Roma and Romana
    const result = rankEntityMatches('Trattoria Roman', entities);
    expect(result.isAmbiguous).toBe(true);
    expect(result.bestMatch).toBeUndefined();

    // Exact match for Trattoria Roma resolves cleanly
    const exactResult = rankEntityMatches('Trattoria Roma', entities);
    expect(exactResult.isAmbiguous).toBe(false);
    expect(exactResult.bestMatch?.id).toBe('ent-1');
    expect(exactResult.bestMatch?.isExact).toBe(true);
  });

  it('matches via aliases when provided', () => {
    const entities = [{ id: 'ent-1', name: 'Kerning Bistro' }];
    const aliases = [{ id: 'alias-1', entity_id: 'ent-1', alias: 'Kerning Cafe' }];

    const result = rankEntityMatches('Kerning Cafe', entities, aliases);
    expect(result.bestMatch?.id).toBe('ent-1');
    expect(result.bestMatch?.isAlias).toBe(true);
    expect(result.bestMatch?.matchedAlias).toBe('Kerning Cafe');
  });

  it('flags near duplicates correctly on entity creation checks', () => {
    const existing = [{ id: 'ent-1', name: 'Restaurant 2' }];

    const exact = findPotentialDuplicate('Restaurant 2', existing);
    expect(exact.exactMatch?.id).toBe('ent-1');

    const near = findPotentialDuplicate('Restaurant 22', existing);
    expect(near.nearDuplicate?.id).toBe('ent-1');

    const distinct = findPotentialDuplicate('Bakery Delight', existing);
    expect(distinct.exactMatch).toBeUndefined();
    expect(distinct.nearDuplicate).toBeUndefined();
  });
});

describe('006A: Memory Reducers and Projection Rebuild', () => {
  it('reduces memory_note into active memoryEntries map', () => {
    const entries = new Map<string, MemoryEntry>();
    const suppressions = new Map<string, MemorySuppression>();

    const event: LedgerEvent = {
      id: 'evt-mem-1',
      workspace_id: 'ws-kerning',
      sequence: 1,
      actor_kind: 'member',
      actor_user_id: 'usr-avi',
      kind: 'memory_note',
      schema_version: 1,
      payload: {
        memory_id: 'mem-1',
        scope: 'workspace',
        category: 'workflow_context',
        content: 'Quotes are in RON minor units.',
      },
      occurred_at: '2026-10-02T10:00:00Z',
      recorded_at: '2026-10-02T10:00:01Z',
      channel: 'web',
      source_message_id: 'msg-1',
      action_id: 'act-1',
      provenance: 'stated',
      created_at: '2026-10-02T10:00:01Z',
    };

    reduceMemory(entries, suppressions, event);

    expect(entries.size).toBe(1);
    const entry = entries.get('mem-1');
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('active');
    expect(entry?.scope).toBe('workspace');
    expect(entry?.subject_id).toBeNull();
    expect(entry?.content).toBe('Quotes are in RON minor units.');
    expect(entry?.source_message_id).toBe('msg-1');
  });

  it('marks prior note as superseded when a replacement note is reduced', () => {
    const entries = new Map<string, MemoryEntry>();
    const suppressions = new Map<string, MemorySuppression>();

    const evt1: LedgerEvent = {
      id: 'evt-mem-1',
      workspace_id: 'ws-kerning',
      sequence: 1,
      actor_kind: 'member',
      actor_user_id: 'usr-avi',
      kind: 'memory_note',
      schema_version: 1,
      payload: {
        memory_id: 'mem-1',
        scope: 'workspace',
        category: 'workflow_context',
        content: 'Quotes are in EUR.',
      },
      occurred_at: '2026-10-02T10:00:00Z',
      recorded_at: '2026-10-02T10:00:01Z',
      channel: 'web',
      action_id: 'act-1',
      provenance: 'stated',
      created_at: '2026-10-02T10:00:01Z',
    };

    const evt2: LedgerEvent = {
      id: 'evt-mem-2',
      workspace_id: 'ws-kerning',
      sequence: 2,
      actor_kind: 'member',
      actor_user_id: 'usr-avi',
      kind: 'memory_note',
      schema_version: 1,
      payload: {
        memory_id: 'mem-2',
        scope: 'workspace',
        category: 'workflow_context',
        content: 'Correction: Quotes are in RON.',
        supersedes_memory_id: 'mem-1',
      },
      occurred_at: '2026-10-02T10:05:00Z',
      recorded_at: '2026-10-02T10:05:01Z',
      channel: 'web',
      action_id: 'act-2',
      provenance: 'stated',
      created_at: '2026-10-02T10:05:01Z',
    };

    reduceMemory(entries, suppressions, evt1);
    reduceMemory(entries, suppressions, evt2);

    expect(entries.get('mem-1')?.status).toBe('superseded');
    expect(entries.get('mem-1')?.superseding_event_id).toBe('evt-mem-2');
    expect(entries.get('mem-2')?.status).toBe('active');
  });

  it('marks note as forgotten and creates suppression tombstone on memory_forgotten', () => {
    const entries = new Map<string, MemoryEntry>();
    const suppressions = new Map<string, MemorySuppression>();

    const evtNote: LedgerEvent = {
      id: 'evt-mem-1',
      workspace_id: 'ws-kerning',
      sequence: 1,
      actor_kind: 'member',
      actor_user_id: 'usr-avi',
      kind: 'memory_note',
      schema_version: 1,
      payload: {
        memory_id: 'mem-1',
        scope: 'entity',
        subject_id: 'ent-1',
        category: 'relationship_context',
        content: 'Client prefers calls on Friday afternoon.',
      },
      occurred_at: '2026-10-02T10:00:00Z',
      recorded_at: '2026-10-02T10:00:01Z',
      channel: 'web',
      source_message_id: 'msg-1',
      action_id: 'act-1',
      provenance: 'stated',
      created_at: '2026-10-02T10:00:01Z',
    };

    const evtForget: LedgerEvent = {
      id: 'evt-mem-2',
      workspace_id: 'ws-kerning',
      sequence: 2,
      actor_kind: 'member',
      actor_user_id: 'usr-avi',
      kind: 'memory_forgotten',
      schema_version: 1,
      payload: {
        memory_id: 'mem-1',
      },
      occurred_at: '2026-10-02T11:00:00Z',
      recorded_at: '2026-10-02T11:00:01Z',
      channel: 'web',
      action_id: 'act-forget-1',
      provenance: 'stated',
      created_at: '2026-10-02T11:00:01Z',
    };

    reduceMemory(entries, suppressions, evtNote);
    reduceMemory(entries, suppressions, evtForget);

    expect(entries.get('mem-1')?.status).toBe('forgotten');
    expect(suppressions.size).toBe(1);
    const tombstone = Array.from(suppressions.values())[0]!;
    expect(tombstone.target_memory_id).toBe('mem-1');
    expect(tombstone.source_event_id).toBe('evt-mem-1');
    expect(tombstone.source_message_id).toBe('msg-1');
    expect(tombstone.suppression_event_id).toBe('evt-mem-2');
  });

  it('rebuildProjections cleanly reconstructs memoryEntries and respects causal reverts', () => {
    const events: LedgerEvent[] = [
      {
        id: 'evt-mem-1',
        workspace_id: 'ws-kerning',
        sequence: 1,
        actor_kind: 'member',
        actor_user_id: 'usr-avi',
        kind: 'memory_note',
        schema_version: 1,
        payload: {
          memory_id: 'mem-1',
          scope: 'workspace',
          category: 'workflow_context',
          content: 'Keep replies concise.',
        },
        occurred_at: '2026-10-02T10:00:00Z',
        recorded_at: '2026-10-02T10:00:01Z',
        channel: 'web',
        action_id: 'act-1',
        provenance: 'stated',
        created_at: '2026-10-02T10:00:01Z',
      },
      {
        id: 'evt-mem-2',
        workspace_id: 'ws-kerning',
        sequence: 2,
        actor_kind: 'member',
        actor_user_id: 'usr-avi',
        kind: 'memory_note',
        schema_version: 1,
        payload: {
          memory_id: 'mem-2',
          scope: 'workspace',
          category: 'workflow_context',
          content: 'Temporary mistake note.',
        },
        occurred_at: '2026-10-02T10:10:00Z',
        recorded_at: '2026-10-02T10:10:01Z',
        channel: 'web',
        action_id: 'act-2',
        provenance: 'stated',
        created_at: '2026-10-02T10:10:01Z',
      },
      // Revert evt-mem-2
      {
        id: 'evt-revert-1',
        workspace_id: 'ws-kerning',
        sequence: 3,
        actor_kind: 'member',
        actor_user_id: 'usr-avi',
        kind: 'revert',
        schema_version: 1,
        payload: {
          target_event_id: 'evt-mem-2',
          reason: 'undo mistake',
        },
        reverts_event_id: 'evt-mem-2',
        occurred_at: '2026-10-02T10:15:00Z',
        recorded_at: '2026-10-02T10:15:01Z',
        channel: 'web',
        action_id: 'act-undo',
        provenance: 'stated',
        created_at: '2026-10-02T10:15:01Z',
      },
    ];

    const state = rebuildProjections(events);
    expect(state.memoryEntries.size).toBe(1);
    expect(state.memoryEntries.has('mem-1')).toBe(true);
    expect(state.memoryEntries.has('mem-2')).toBe(false);
  });
});

describe('006A: Memory & Draft Commands Pure Execution', () => {
  const context: LedgerCommandContext = {
    workspace_id: 'ws-kerning',
    actor: { kind: 'member', user_id: 'usr-avi' },
    membership_revision: 1,
    source_message_id: 'msg-100',
    request_id: 'req-1',
    action_id: 'act-mem-cmd',
    expected_business_revision: 5,
    run_id: 'run-1',
  };

  const emptyState: LedgerProjectionState = {
    entities: new Map([
      ['ent-rest2', { id: 'ent-rest2', workspace_id: 'ws-kerning', name: 'Restaurant 2', kind: 'lead', created_at: '2026-10-01' }],
    ]),
    aliases: new Map(),
    fields: new Map(),
    tasks: new Map(),
    drafts: new Map(),
    memoryEntries: new Map(),
    memorySuppressions: new Map(),
  };

  it('handleRememberContext validates scope/subject requirements and creates memory_note event', () => {
    // 1. Workspace scope with subject is rejected
    const badWs = handleRememberContext(context, emptyState, 6, {
      scope: 'workspace',
      subject_id: 'usr-avi',
      category: 'workflow_context',
      content: 'test',
    });
    expect(badWs.result.status).toBe('rejected');

    // 2. Entity scope with nonexistent entity is rejected
    const badEnt = handleRememberContext(context, emptyState, 6, {
      scope: 'entity',
      subject_id: 'ent-nonexistent',
      category: 'relationship_context',
      content: 'test',
    });
    expect(badEnt.result.status).toBe('rejected');

    // 3. Valid entity scope succeeds
    const validEnt = handleRememberContext(context, emptyState, 6, {
      scope: 'entity',
      subject_id: 'ent-rest2',
      category: 'relationship_context',
      content: 'Owner prefers afternoon meetings.',
    });
    expect(validEnt.result.status).toBe('applied');
    expect(validEnt.events.length).toBe(1);
    expect(validEnt.events[0]?.kind).toBe('memory_note');
    expect(validEnt.nextState?.memoryEntries.size).toBe(1);
  });

  it('handleForgetMemory rejects nonexistent note and applies on existing note', () => {
    // 1. Nonexistent note is rejected
    const missing = handleForgetMemory(context, emptyState, 6, {
      memory_id: 'mem-missing',
    });
    expect(missing.result.status).toBe('rejected');

    // 2. Existing note is forgotten
    const stateWithNote: LedgerProjectionState = {
      ...emptyState,
      memoryEntries: new Map([
        [
          'mem-existing',
          {
            id: 'mem-existing',
            workspace_id: 'ws-kerning',
            scope: 'workspace',
            subject_id: null,
            category: 'workflow_context',
            content: 'Old rule.',
            status: 'active',
            provenance: 'stated',
            source_event_id: 'evt-old',
            source_message_id: 'msg-old',
            author_user_id: 'usr-avi',
            observed_at: '2026-10-01',
            created_at: '2026-10-01',
            superseding_event_id: null,
            business_revision: 4,
          },
        ],
      ]),
    };

    const forgot = handleForgetMemory(context, stateWithNote, 6, {
      memory_id: 'mem-existing',
    });
    expect(forgot.result.status).toBe('applied');
    expect(forgot.events.length).toBe(1);
    expect(forgot.events[0]?.kind).toBe('memory_forgotten');
    expect(forgot.nextState?.memoryEntries.get('mem-existing')?.status).toBe('forgotten');
    expect(forgot.nextState?.memorySuppressions.size).toBe(1);

    // 3. Repeating on already forgotten note returns already_applied
    const repeat = handleForgetMemory(context, forgot.nextState!, 7, {
      memory_id: 'mem-existing',
    });
    expect(repeat.result.status).toBe('already_applied');
    expect(repeat.events.length).toBe(0);
  });

  it('handleMarkMessageSent transitions draft to member_confirmed_sent and handles idempotent replay', () => {
    const stateWithDraft: LedgerProjectionState = {
      ...emptyState,
      drafts: new Map([
        [
          'draft-1',
          {
            id: 'draft-1',
            workspace_id: 'ws-kerning',
            entity_id: 'ent-rest2',
            channel: 'whatsapp',
            recipient: '+40712345678',
            content: 'Here is our proposal for 3,500 RON.',
            status: 'draft',
            created_at: '2026-10-02T10:00:00Z',
            updated_at: '2026-10-02T10:00:00Z',
          },
        ],
      ]),
    };

    // 1. Missing draft rejects
    const missing = handleMarkMessageSent(context, stateWithDraft, 6, {
      draft_id: 'draft-missing',
    });
    expect(missing.result.status).toBe('rejected');

    // 2. Mark sent applies
    const applied = handleMarkMessageSent(context, stateWithDraft, 6, {
      draft_id: 'draft-1',
    });
    expect(applied.result.status).toBe('applied');
    expect(applied.events.length).toBe(1);
    expect(applied.events[0]?.kind).toBe('message_sent_by_member');
    expect(applied.nextState?.drafts.get('draft-1')?.status).toBe('member_confirmed_sent');

    // 3. Repeated mark sent returns already_applied
    const repeated = handleMarkMessageSent(context, applied.nextState!, 7, {
      draft_id: 'draft-1',
    });
    expect(repeated.result.status).toBe('already_applied');
    expect(repeated.events.length).toBe(0);
  });
});
