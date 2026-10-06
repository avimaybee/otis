import { describe, it, expect } from 'vitest';
import {
  evaluateBriefSchedule,
  getLocalDate,
  getWeekdayForLocalDate,
  nextDueUtc,
  resetScheduleDiagnostics,
  resolveScheduledInstantForDate,
  scheduleDiagnostics,
  type BriefScheduleInput,
} from '../src/schedule.js';

const TZ = 'Europe/Bucharest';

function schedule(overrides: Partial<BriefScheduleInput> = {}): BriefScheduleInput {
  return {
    enabled: true,
    localTime: '20:45',
    timezone: TZ,
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    channel: 'web',
    ...overrides,
  };
}

describe('brief schedule kernel', () => {
  it('disabled schedules never run', () => {
    const result = evaluateBriefSchedule(
      schedule({ enabled: false }),
      '2026-10-06T17:50:00.000Z',
      null,
    );
    expect(result.runnable).toBe(false);
    expect(result.decision).toBe('disabled');
  });

  it('incomplete schedules (null time/timezone/weekdays) never run', () => {
    expect(
      evaluateBriefSchedule(schedule({ localTime: null }), '2026-10-06T17:50:00.000Z', null)
        .decision,
    ).toBe('incomplete');
    expect(
      evaluateBriefSchedule(schedule({ timezone: null }), '2026-10-06T17:50:00.000Z', null)
        .decision,
    ).toBe('incomplete');
    expect(
      evaluateBriefSchedule(schedule({ weekdays: null }), '2026-10-06T17:50:00.000Z', null)
        .decision,
    ).toBe('incomplete');
    expect(
      evaluateBriefSchedule(schedule({ weekdays: [] }), '2026-10-06T17:50:00.000Z', null)
        .decision,
    ).toBe('incomplete');
  });

  it('a null time at 09:00 local is incomplete: no morning fallback', () => {
    // 2026-10-06 09:00 Bucharest = 06:00Z.
    const result = evaluateBriefSchedule(
      schedule({ localTime: null }),
      '2026-10-06T06:00:00.000Z',
      null,
    );
    expect(result.runnable).toBe(false);
    expect(result.decision).toBe('incomplete');
  });

  it('invalid time, timezone and weekdays never run', () => {
    expect(
      evaluateBriefSchedule(schedule({ localTime: '8:45' }), '2026-10-06T17:50:00.000Z', null)
        .decision,
    ).toBe('invalid');
    expect(
      evaluateBriefSchedule(schedule({ localTime: '25:00' }), '2026-10-06T17:50:00.000Z', null)
        .decision,
    ).toBe('invalid');
    expect(
      evaluateBriefSchedule(schedule({ timezone: 'Mars/Olympus' }), '2026-10-06T17:50:00.000Z', null)
        .decision,
    ).toBe('invalid');
    expect(
      evaluateBriefSchedule(schedule({ weekdays: [7] }), '2026-10-06T17:50:00.000Z', null)
        .decision,
    ).toBe('invalid');
  });

  it('respects an arbitrary chosen evening time', () => {
    // 20:40 local -> not yet due; 20:50 local -> due (20:45 Bucharest = 17:45Z).
    const before = evaluateBriefSchedule(schedule(), '2026-10-06T17:40:00.000Z', null);
    expect(before).toMatchObject({ runnable: false, decision: 'not_yet_due', localDate: '2026-10-06' });
    const after = evaluateBriefSchedule(schedule(), '2026-10-06T17:50:00.000Z', null);
    expect(after).toMatchObject({
      runnable: true,
      decision: 'due',
      localDate: '2026-10-06',
      scheduledAtUtc: '2026-10-06T17:45:00.000Z',
    });
  });

  it('honours chosen weekdays', () => {
    const mondays = schedule({ weekdays: [1] });
    // Sunday 2026-10-04 20:50 local.
    const sunday = evaluateBriefSchedule(mondays, '2026-10-04T17:50:00.000Z', null);
    expect(sunday).toMatchObject({
      runnable: false,
      decision: 'weekday_not_selected',
      localDate: '2026-10-04',
      weekday: 0,
    });
    // Monday 2026-10-05 20:50 local.
    const monday = evaluateBriefSchedule(mondays, '2026-10-05T17:50:00.000Z', null);
    expect(monday).toMatchObject({ runnable: true, decision: 'due', weekday: 1 });
  });

  it('handles a midnight chosen time', () => {
    const midnight = schedule({ localTime: '00:00' });
    // 00:00:30 on 2026-10-04 Bucharest (EEST, UTC+3).
    const result = evaluateBriefSchedule(midnight, '2026-10-03T21:00:30.000Z', null);
    expect(result).toMatchObject({
      runnable: true,
      decision: 'due',
      localDate: '2026-10-04',
      scheduledAtUtc: '2026-10-03T21:00:00.000Z',
    });
  });

  it('computes the local date across the UTC midnight boundary', () => {
    expect(getLocalDate('2026-10-03T20:59:00.000Z', TZ)).toBe('2026-10-03');
    expect(getLocalDate('2026-10-03T21:01:00.000Z', TZ)).toBe('2026-10-04');
    expect(getWeekdayForLocalDate('2026-10-04')).toBe(0);
    expect(getWeekdayForLocalDate('2026-10-05')).toBe(1);
  });

  it('spring-forward gap resolves to the next valid instant (Bucharest 2026-03-29)', () => {
    // 03:30 does not exist (03:00 EET -> 04:00 EEST); next valid is 04:00 EEST = 01:00Z.
    expect(resolveScheduledInstantForDate('2026-03-29', '03:30', TZ)).toBe(
      '2026-03-29T01:00:00.000Z',
    );
  });

  it('fall-back overlap resolves to the first occurrence (Bucharest 2026-10-25)', () => {
    // 03:30 occurs twice; first is 03:30 EEST (UTC+3) = 00:30Z.
    expect(resolveScheduledInstantForDate('2026-10-25', '03:30', TZ)).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });

  it('evaluates a DST-gap schedule on the transition day', () => {
    const gapped = schedule({ localTime: '03:30', weekdays: [0] });
    const result = evaluateBriefSchedule(gapped, '2026-03-29T01:30:00.000Z', null);
    expect(result).toMatchObject({
      runnable: true,
      decision: 'due',
      localDate: '2026-03-29',
      scheduledAtUtc: '2026-03-29T01:00:00.000Z',
    });
  });

  it('repeated checks dedupe by local date and run again the next day', () => {
    const first = evaluateBriefSchedule(schedule(), '2026-10-06T17:50:00.000Z', null);
    expect(first.decision).toBe('due');
    const repeat = evaluateBriefSchedule(schedule(), '2026-10-06T19:50:00.000Z', '2026-10-06');
    expect(repeat).toMatchObject({ runnable: false, decision: 'already_generated' });
    const nextDay = evaluateBriefSchedule(schedule(), '2026-10-07T17:50:00.000Z', '2026-10-06');
    expect(nextDay).toMatchObject({ runnable: true, decision: 'due', localDate: '2026-10-07' });
  });

  it('a schedule edit after generation does not recreate that day', () => {
    const edited = evaluateBriefSchedule(
      schedule({ localTime: '22:15' }),
      '2026-10-06T19:50:00.000Z',
      '2026-10-06',
    );
    expect(edited).toMatchObject({ runnable: false, decision: 'already_generated' });
  });

  it('throws on an unparseable now instant', () => {
    expect(() => evaluateBriefSchedule(schedule(), 'not-a-time', null)).toThrow();
  });
});

describe('brief schedule operation budget (no wall-time assertions)', () => {
  it('ordinary evaluations cost a handful of conversions and one cached formatter', () => {
    resetScheduleDiagnostics();
    const first = evaluateBriefSchedule(schedule(), '2026-10-06T17:50:00.000Z', null);
    expect(first.decision).toBe('due');
    // At most one construction: zero when earlier tests already warmed the
    // module cache, one otherwise. Either way the formatter is then shared.
    expect(scheduleDiagnostics.formatterConstructions).toBeLessThanOrEqual(1);
    expect(scheduleDiagnostics.wallConversions).toBeLessThanOrEqual(10);

    // Repeats reuse the cached formatter with the same small budget.
    resetScheduleDiagnostics();
    const second = evaluateBriefSchedule(schedule(), '2026-10-06T17:55:00.000Z', null);
    expect(second.decision).toBe('due');
    expect(scheduleDiagnostics.formatterConstructions).toBe(0);
    expect(scheduleDiagnostics.wallConversions).toBeLessThanOrEqual(10);
  });

  it('short-circuits unselected weekdays and repeats before resolving', () => {
    resetScheduleDiagnostics();
    const skipped = evaluateBriefSchedule(
      schedule({ weekdays: [1] }),
      '2026-10-04T17:50:00.000Z',
      null,
    );
    expect(skipped).toMatchObject({ decision: 'weekday_not_selected', scheduledAtUtc: null });
    const repeated = evaluateBriefSchedule(schedule(), '2026-10-06T19:50:00.000Z', '2026-10-06');
    expect(repeated).toMatchObject({ decision: 'already_generated', scheduledAtUtc: null });
    // Local-date computation only: no instant resolution on either path.
    expect(scheduleDiagnostics.wallConversions).toBeLessThanOrEqual(2);
  });

  it('resolves ordinary dates without the overlap scan', () => {
    resetScheduleDiagnostics();
    expect(resolveScheduledInstantForDate('2026-10-06', '20:45', TZ)).toBe(
      '2026-10-06T17:45:00.000Z',
    );
    expect(scheduleDiagnostics.wallConversions).toBeLessThanOrEqual(8);
  });

  it('shares one cached formatter across many sweeps', () => {
    resetScheduleDiagnostics();
    for (let i = 0; i < 25; i += 1) {
      evaluateBriefSchedule(schedule(), '2026-10-06T17:50:00.000Z', null);
    }
    expect(scheduleDiagnostics.formatterConstructions).toBeLessThanOrEqual(1);
  });
});

describe('brief next-due instant (B4 sweep selection)', () => {
  // 2026-10-06 is a Tuesday; 20:45 Bucharest (EEST) is 17:45Z.
  it('returns today’s slot when it is still ahead', () => {
    expect(
      nextDueUtc({
        schedule: schedule({ weekdays: [2] }),
        fromUtcIso: '2026-10-06T10:00:00.000Z',
        lastGeneratedLocalDate: null,
      }),
    ).toBe('2026-10-06T17:45:00.000Z');
  });

  it('rolls to the next selected weekday once today’s slot has passed', () => {
    expect(
      nextDueUtc({
        schedule: schedule({ weekdays: [2] }),
        fromUtcIso: '2026-10-06T18:00:00.000Z',
        lastGeneratedLocalDate: null,
      }),
    ).toBe('2026-10-13T17:45:00.000Z');
    expect(
      nextDueUtc({
        schedule: schedule({ weekdays: [1] }),
        fromUtcIso: '2026-10-06T10:00:00.000Z',
        lastGeneratedLocalDate: null,
      }),
    ).toBe('2026-10-12T17:45:00.000Z');
  });

  it('is strictly after the lower bound and past the generated date', () => {
    expect(
      nextDueUtc({
        schedule: schedule({ weekdays: [2] }),
        fromUtcIso: '2026-10-06T17:45:00.000Z',
        lastGeneratedLocalDate: null,
      }),
    ).toBe('2026-10-13T17:45:00.000Z');
    expect(
      nextDueUtc({
        schedule: schedule({ weekdays: [2] }),
        fromUtcIso: '2026-10-06T10:00:00.000Z',
        lastGeneratedLocalDate: '2026-10-06',
      }),
    ).toBe('2026-10-13T17:45:00.000Z');
  });

  it('never runs disabled, incomplete or invalid schedules', () => {
    const from = { fromUtcIso: '2026-10-06T10:00:00.000Z', lastGeneratedLocalDate: null } as const;
    expect(nextDueUtc({ ...from, schedule: schedule({ enabled: false }) })).toBeNull();
    expect(nextDueUtc({ ...from, schedule: schedule({ localTime: null }) })).toBeNull();
    expect(nextDueUtc({ ...from, schedule: schedule({ timezone: null }) })).toBeNull();
    expect(nextDueUtc({ ...from, schedule: schedule({ weekdays: [] }) })).toBeNull();
    expect(nextDueUtc({ ...from, schedule: schedule({ localTime: '25:00' }) })).toBeNull();
    expect(nextDueUtc({ ...from, schedule: schedule({ timezone: 'Mars/Olympus' }) })).toBeNull();
  });

  it('rejects unparsable bounds instead of guessing', () => {
    expect(() =>
      nextDueUtc({ schedule: schedule(), fromUtcIso: 'not-an-instant', lastGeneratedLocalDate: null }),
    ).toThrow(/Invalid from instant/);
    expect(() =>
      nextDueUtc({ schedule: schedule(), fromUtcIso: '2026-10-06T10:00:00.000Z', lastGeneratedLocalDate: 'tomorrow' }),
    ).toThrow(/Invalid last-generated date/);
  });
});
