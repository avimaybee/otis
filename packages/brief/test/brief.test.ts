import { describe, it, expect } from 'vitest';
import {
  BRIEF_KIND_SCHEDULED_DAILY,
  buildBriefDedupeKey,
  orderSelectionsForSave,
  renderBriefText,
  type SavedBriefItem,
} from '../src/brief.js';
import type { BriefItem } from '../src/selection.js';

function item(overrides: Partial<BriefItem> = {}): BriefItem {
  return {
    kind: 'task_due',
    rankGroup: 2,
    taskId: 't-1',
    entityId: null,
    title: 'Send offer to Bistro',
    reason: 'Task due 2026-10-05',
    sourceEventId: 'evt-1',
    dueLabel: '2026-10-05',
    overdueMs: 86400000,
    valueMinor: null,
    currency: null,
    ...overrides,
  };
}

describe('brief keys, save order and text', () => {
  it('builds the daily dedupe key', () => {
    expect(buildBriefDedupeKey('ws-1', 'usr-1', '2026-10-06')).toBe(
      'ws-1:usr-1:2026-10-06:scheduled_daily',
    );
    expect(BRIEF_KIND_SCHEDULED_DAILY).toBe('scheduled_daily');
  });

  it('rejects invalid key material', () => {
    expect(() => buildBriefDedupeKey('', 'usr-1', '2026-10-06')).toThrow();
    expect(() => buildBriefDedupeKey('ws-1', '', '2026-10-06')).toThrow();
    expect(() => buildBriefDedupeKey('ws-1', 'usr-1', 'tomorrow')).toThrow();
    expect(() => buildBriefDedupeKey('ws-1', 'usr-1', '2026-10-06', '')).toThrow();
  });

  it('orders selections stably and assigns positions', () => {
    const saved = orderSelectionsForSave([
      item({ taskId: 't-z', title: 'Zed', sourceEventId: 'evt-z' }),
      item({ taskId: 't-a', title: 'Aye', sourceEventId: 'evt-a' }),
    ]);
    expect(saved.map((entry) => entry.taskId)).toEqual(['t-a', 't-z']);
    expect(saved.map((entry) => entry.position)).toEqual([1, 2]);
  });

  it('renders deterministic plain text with positions and reasons', () => {
    const saved: SavedBriefItem[] = orderSelectionsForSave([
      item({ taskId: 't-a', title: 'Send offer to Bistro', reason: 'Promise due 2026-10-05' }),
      item({
        kind: 'stale_lead',
        rankGroup: 4,
        taskId: null,
        entityId: 'ent-9',
        title: 'Thai Shop',
        reason: 'Warm lead, last contact 2026-09-01',
        sourceEventId: 'evt-9',
        dueLabel: null,
        overdueMs: 1,
        valueMinor: null,
        currency: null,
      }),
    ]);
    expect(renderBriefText(saved)).toBe(
      'Your brief.\n' +
        '1. Send offer to Bistro - Promise due 2026-10-05\n' +
        '2. Thai Shop - Warm lead, last contact 2026-09-01',
    );
    expect(renderBriefText(saved).toLowerCase()).not.toContain('morning');
  });

  it('renders empty selections as scheduled silence', () => {
    expect(renderBriefText([])).toBe('');
  });
});
