import { describe, it, expect } from 'vitest';
import {
  compareBriefItems,
  selectBriefItems,
  type BriefItem,
  type BriefLeadInput,
  type BriefTaskInput,
  type SelectBriefInput,
} from '../src/selection.js';

const NOW = '2026-10-06T12:00:00.000Z';
const LOCAL_DATE = '2026-10-06';
const TZ = 'Europe/Bucharest';
const STALE_DAYS = 14;

let counter = 0;
function task(overrides: Partial<BriefTaskInput> = {}): BriefTaskInput {
  counter += 1;
  return {
    id: `t-${counter}`,
    entityId: null,
    title: `Task ${counter}`,
    status: 'open',
    dueKind: 'date',
    dueLocalDate: '2026-10-06',
    dueInstantAt: null,
    dueTimezone: TZ,
    snoozeUntil: null,
    reason: 'task',
    explicitNoDeadline: false,
    valueMinor: null,
    currency: null,
    sourceEventId: `evt-${counter}`,
    disputed: false,
    ...overrides,
  };
}

function lead(overrides: Partial<BriefLeadInput> = {}): BriefLeadInput {
  counter += 1;
  return {
    entityId: `ent-${counter}`,
    name: `Lead ${counter}`,
    status: 'warm',
    lastContactAt: '2026-09-01T10:00:00.000Z',
    valueMinor: null,
    currency: null,
    sourceEventId: `evt-${counter}`,
    disputed: false,
    ...overrides,
  };
}

function select(
  overrides: Partial<SelectBriefInput> = {},
  tasks: BriefTaskInput[] = [],
  leads: BriefLeadInput[] = [],
) {
  return selectBriefItems({
    nowUtcIso: NOW,
    briefLocalDate: LOCAL_DATE,
    briefTimezone: TZ,
    tasks,
    leads,
    staleAfterDays: STALE_DAYS,
    ...overrides,
  });
}

describe('brief selection kernel', () => {
  it('ranks a due promise before a due plain task with the same overdue age', () => {
    const items = select(
      {},
      [
        task({ id: 't-plain', reason: 'task', dueLocalDate: '2026-10-05' }),
        task({ id: 't-promise', reason: 'promise', dueLocalDate: '2026-10-05' }),
      ],
    );
    expect(items.map((item) => item.taskId)).toEqual(['t-promise', 't-plain']);
    expect(items[0]?.reason).toBe('Promise due 2026-10-05');
  });

  it('includes date tasks due today and excludes future dates', () => {
    const items = select(
      {},
      [
        task({ id: 't-today', dueLocalDate: '2026-10-06' }),
        task({ id: 't-future', dueLocalDate: '2026-10-07' }),
      ],
    );
    expect(items.map((item) => item.taskId)).toEqual(['t-today']);
  });

  it('distinguishes due instants from future instants', () => {
    const items = select(
      {},
      [
        task({
          id: 't-past',
          dueKind: 'instant',
          dueLocalDate: null,
          dueInstantAt: '2026-10-06T11:00:00.000Z',
        }),
        task({
          id: 't-future',
          dueKind: 'instant',
          dueLocalDate: null,
          dueInstantAt: '2026-10-06T13:00:00.000Z',
        }),
      ],
    );
    expect(items.map((item) => item.taskId)).toEqual(['t-past']);
    expect(items[0]?.reason).toBe('Task due 2026-10-06T11:00:00.000Z');
  });

  it('orders older overdue work first across date and instant dues', () => {
    const items = select(
      {},
      [
        task({ id: 't-recent', reason: 'task', dueLocalDate: '2026-10-06' }),
        task({
          id: 't-hour',
          reason: 'task',
          dueKind: 'instant',
          dueLocalDate: null,
          dueInstantAt: '2026-10-06T11:00:00.000Z',
        }),
        task({ id: 't-old', reason: 'task', dueLocalDate: '2026-10-04' }),
      ],
    );
    expect(items.map((item) => item.taskId)).toEqual(['t-old', 't-hour', 't-recent']);
  });

  it('excludes completed, cancelled, snoozed and disputed tasks', () => {
    const items = select(
      {},
      [
        task({ id: 't-done', status: 'done' }),
        task({ id: 't-cancelled', status: 'cancelled' }),
        task({ id: 't-snoozed', snoozeUntil: '2026-10-07T12:00:00.000Z' }),
        task({ id: 't-disputed', disputed: true }),
        task({ id: 't-kept', dueLocalDate: '2026-10-06' }),
      ],
    );
    expect(items.map((item) => item.taskId)).toEqual(['t-kept']);
  });

  it('keeps tasks whose snooze already expired', () => {
    const items = select(
      {},
      [task({ id: 't-awake', snoozeUntil: '2026-10-06T11:59:00.000Z' })],
    );
    expect(items.map((item) => item.taskId)).toEqual(['t-awake']);
  });

  it('includes explicit undated actions but never missing-deadline rows', () => {
    const items = select(
      {},
      [
        task({ id: 't-clarify', dueKind: null, dueLocalDate: null, explicitNoDeadline: false }),
        task({ id: 't-undated', dueKind: null, dueLocalDate: null, explicitNoDeadline: true }),
      ],
    );
    expect(items.map((item) => item.taskId)).toEqual(['t-undated']);
    expect(items[0]?.kind).toBe('undated');
  });

  it('dedupes duplicate task IDs to one item', () => {
    const first = task({ id: 't-same' });
    const items = select({}, [first, task({ id: 't-same' })]);
    expect(items).toHaveLength(1);
  });

  it('skips a stale lead for an entity already covered by a selected task', () => {
    const items = select(
      {},
      [task({ id: 't-cover', entityId: 'ent-1', dueLocalDate: '2026-10-06' })],
      [
        lead({ entityId: 'ent-1', name: 'Covered Bistro' }),
        lead({ entityId: 'ent-2', name: 'Lonely Bistro' }),
      ],
    );
    expect(items.map((item) => item.entityId)).toEqual(['ent-1', 'ent-2']);
    expect(items[1]?.kind).toBe('stale_lead');
  });

  it('selects stale warm/hot leads, not recent or cold ones', () => {
    const items = select(
      {},
      [],
      [
        lead({ entityId: 'e-old', status: 'warm', lastContactAt: '2026-09-01T10:00:00.000Z' }),
        lead({ entityId: 'e-recent', status: 'warm', lastContactAt: '2026-10-05T10:00:00.000Z' }),
        lead({ entityId: 'e-cold', status: 'cold', lastContactAt: '2026-08-01T10:00:00.000Z' }),
        lead({ entityId: 'e-new', status: 'new', lastContactAt: '2026-08-01T10:00:00.000Z' }),
        lead({ entityId: 'e-won', status: 'won', lastContactAt: '2026-08-01T10:00:00.000Z' }),
        lead({ entityId: 'e-hot', status: 'hot', lastContactAt: '2026-09-10T10:00:00.000Z' }),
        lead({ entityId: 'e-future', status: 'warm', lastContactAt: '2026-10-07T10:00:00.000Z' }),
        lead({ entityId: 'e-disputed', status: 'hot', lastContactAt: '2026-08-01T10:00:00.000Z', disputed: true }),
      ],
    );
    expect(items.map((item) => item.entityId)).toEqual(['e-old', 'e-hot']);
  });

  it('surfaces leads with unknown last contact as most stale', () => {
    const items = select(
      {},
      [],
      [
        lead({ entityId: 'e-known', lastContactAt: '2026-09-01T10:00:00.000Z' }),
        lead({ entityId: 'e-unknown', lastContactAt: null }),
      ],
    );
    expect(items.map((item) => item.entityId)).toEqual(['e-unknown', 'e-known']);
    expect(items[0]?.reason).toContain('unknown');
  });

  it('prefers higher stated value within the same currency', () => {
    const items = select(
      {},
      [
        task({ id: 't-b', dueLocalDate: '2026-10-06', valueMinor: 50000, currency: 'EUR' }),
        task({ id: 't-a', dueLocalDate: '2026-10-06', valueMinor: 10000, currency: 'EUR' }),
      ],
    );
    expect(items.map((item) => item.taskId)).toEqual(['t-b', 't-a']);
  });

  it('orders currency buckets before IDs and never compares across currencies', () => {
    // EUR bucket sorts before USD bucket even though t-a < t-z and the
    // USD amount is larger; no amount crosses a currency boundary.
    const items = select(
      {},
      [
        task({ id: 't-a', dueLocalDate: '2026-10-06', valueMinor: 900000, currency: 'USD' }),
        task({ id: 't-z', dueLocalDate: '2026-10-06', valueMinor: 10000, currency: 'EUR' }),
      ],
    );
    expect(items.map((item) => item.taskId)).toEqual(['t-z', 't-a']);
  });

  it('sorts unknown-value items last inside their bucket, then by ID', () => {
    const items = select(
      {},
      [
        task({ id: 't-b', dueLocalDate: '2026-10-06', valueMinor: 50000, currency: 'EUR' }),
        task({ id: 't-c', dueLocalDate: '2026-10-06', valueMinor: null, currency: 'EUR' }),
        task({ id: 't-a', dueLocalDate: '2026-10-06', valueMinor: null, currency: null }),
      ],
    );
    // Empty (unknown-currency) bucket first, then EUR by value desc.
    expect(items.map((item) => item.taskId)).toEqual(['t-a', 't-b', 't-c']);
  });

  function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [[...items]];
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += 1) {
      const head = items[i] as T;
      const rest = [...items.slice(0, i), ...items.slice(i + 1)];
      for (const tail of permutations(rest)) out.push([head, ...tail]);
    }
    return out;
  }

  it('orders a mixed-currency triple identically for all six input permutations', () => {
    // Reviewer cycle case: old match-or-ID fallback gave A>B, B>C, C>A.
    // Bucket policy: EUR bucket first, then RON by value desc.
    const makeTriple = (): BriefTaskInput[] => [
      task({ id: 't-z', dueLocalDate: '2026-10-06', valueMinor: 10000, currency: 'RON' }),
      task({ id: 't-m', dueLocalDate: '2026-10-06', valueMinor: 5000, currency: 'EUR' }),
      task({ id: 't-a', dueLocalDate: '2026-10-06', valueMinor: 1000, currency: 'RON' }),
    ];
    const expected = ['t-m', 't-z', 't-a'];
    const orders = permutations(makeTriple());
    expect(orders).toHaveLength(6);
    for (const order of orders) {
      expect(select({}, order).map((item) => item.taskId)).toEqual(expected);
    }
  });

  it('compareBriefItems is transitive over a mixed-currency set', () => {
    const ranked = select(
      {},
      [
        task({ id: 't-z', dueLocalDate: '2026-10-06', valueMinor: 10000, currency: 'RON' }),
        task({ id: 't-m', dueLocalDate: '2026-10-06', valueMinor: 5000, currency: 'EUR' }),
        task({ id: 't-a', dueLocalDate: '2026-10-06', valueMinor: 1000, currency: 'RON' }),
        task({ id: 't-v', dueLocalDate: '2026-10-06', valueMinor: 7000, currency: 'eur' }),
        task({ id: 't-w', dueLocalDate: '2026-10-05', valueMinor: 100, currency: 'EUR' }),
      ],
    );
    expect(ranked).toHaveLength(5);
    // Pairwise transitivity across every triple of the selected items.
    for (const a of ranked) {
      for (const b of ranked) {
        for (const c of ranked) {
          const ab = Math.sign(compareBriefItems(a, b));
          const bc = Math.sign(compareBriefItems(b, c));
          const ac = Math.sign(compareBriefItems(a, c));
          if (ab <= 0 && bc <= 0) expect(ac).toBeLessThanOrEqual(0);
          if (ab >= 0 && bc >= 0) expect(ac).toBeGreaterThanOrEqual(0);
        }
      }
    }
    // Lowercase currency joins the same bucket: t-v sorts with EUR by value.
    expect(ranked.map((item) => item.taskId)).toEqual(['t-w', 't-v', 't-m', 't-z', 't-a']);
    // The old cycle is gone: B first, then A, then C.
    const byId = new Map(ranked.map((entry) => [entry.taskId, entry]));
    const itemA = byId.get('t-z') as BriefItem;
    const itemB = byId.get('t-m') as BriefItem;
    const itemC = byId.get('t-a') as BriefItem;
    expect(compareBriefItems(itemB, itemA)).toBeLessThan(0);
    expect(compareBriefItems(itemA, itemC)).toBeLessThan(0);
    expect(compareBriefItems(itemB, itemC)).toBeLessThan(0);
  });

  it('breaks full ties by stable task ID', () => {
    const items = select(
      {},
      [task({ id: 't-z' }), task({ id: 't-m' }), task({ id: 't-a' })],
    );
    expect(items.map((item) => item.taskId)).toEqual(['t-a', 't-m', 't-z']);
  });

  it('caps at five items deterministically regardless of input order', () => {
    const manyTasks = [
      task({ id: 't-1', reason: 'promise', dueLocalDate: '2026-10-01' }),
      task({ id: 't-2', reason: 'promise', dueLocalDate: '2026-10-02' }),
      task({ id: 't-3', reason: 'promise', dueLocalDate: '2026-10-03' }),
      task({ id: 't-4', reason: 'promise', dueLocalDate: '2026-10-04' }),
      task({ id: 't-5', reason: 'task', dueLocalDate: '2026-10-01' }),
      task({ id: 't-6', reason: 'task', dueLocalDate: '2026-10-02' }),
    ];
    const manyLeads = [lead({ entityId: 'e-7', name: 'Stale Seven' })];
    const forward = select({}, manyTasks, manyLeads);
    const backward = select({}, [...manyTasks].reverse(), manyLeads);
    expect(forward).toHaveLength(5);
    expect(forward.map((item) => item.taskId ?? item.entityId)).toEqual(
      backward.map((item) => item.taskId ?? item.entityId),
    );
    expect(forward.map((item) => item.taskId ?? item.entityId)).toEqual([
      't-1',
      't-2',
      't-3',
      't-4',
      't-5',
    ]);
  });

  it('honours a smaller requested cap but never exceeds five', () => {
    const many = [
      task({ id: 't-1' }),
      task({ id: 't-2' }),
      task({ id: 't-3' }),
    ];
    expect(select({ maxItems: 2 }, many)).toHaveLength(2);
    expect(select({ maxItems: 10 }, many)).toHaveLength(3);
  });

  it('returns an empty selection when nothing qualifies', () => {
    expect(select({}, [], [])).toEqual([]);
  });

  it('rejects invalid call-level inputs', () => {
    expect(() => select({ nowUtcIso: 'bad' }, [], [])).toThrow();
    expect(() => select({ briefLocalDate: '2026-13-40' }, [], [])).toThrow();
    expect(() => select({ staleAfterDays: -1 }, [], [])).toThrow();
    expect(() => select({ staleAfterDays: Number.NaN }, [], [])).toThrow();
  });
});
