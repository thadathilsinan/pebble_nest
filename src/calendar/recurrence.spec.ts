import {
  firstOccurrenceFrom,
  NO_RECURRENCE,
  occursOn,
  type Recurrence,
  recurrenceInput,
  resolveRecurrence,
} from './recurrence';

describe('resolveRecurrence', () => {
  // 2026-09-24 is a Thursday.
  const anchor = '2026-09-24';

  it('is none when absent', () => {
    expect(resolveRecurrence(undefined, anchor)).toEqual(NO_RECURRENCE);
  });

  it('fills an empty weekly set with the anchor’s weekday', () => {
    expect(resolveRecurrence({ kind: 'weekly' }, anchor)).toEqual({
      kind: 'weekly',
      weekdays: [4],
      monthDays: [],
      until: null,
    });
  });

  it('fills an empty monthly set with the anchor’s day', () => {
    expect(
      resolveRecurrence({ kind: 'monthly', monthDays: [] }, anchor),
    ).toMatchObject({ monthDays: [24] });
  });

  it('counts Sunday as 7', () => {
    expect(
      resolveRecurrence({ kind: 'weekly' }, '2026-09-27').weekdays,
    ).toEqual([7]);
  });

  it('keeps the days it was given, deduplicated and sorted', () => {
    const input = recurrenceInput.parse({
      kind: 'weekly',
      weekdays: [5, 1, 5],
      until: '2026-12-31',
    });

    expect(resolveRecurrence(input, anchor)).toEqual({
      kind: 'weekly',
      weekdays: [1, 5],
      monthDays: [],
      until: '2026-12-31',
    });
  });
});

describe('recurrenceInput', () => {
  it.each([
    { kind: 'daily', weekdays: [1] },
    { kind: 'weekly', monthDays: [1] },
    { kind: 'none', until: '2026-12-31' },
    { kind: 'weekly', weekdays: [0] },
    { kind: 'monthly', monthDays: [32] },
    { kind: 'yearly' },
    { kind: 'daily', extra: true },
  ])('refuses %j', (input) => {
    expect(recurrenceInput.safeParse(input).success).toBe(false);
  });
});

function rule(r: Partial<Recurrence>): Recurrence {
  return { ...NO_RECURRENCE, ...r };
}

describe('occursOn', () => {
  // 2026-09-24 is a Thursday.
  const anchor = '2026-09-24';

  it('puts a one-off block on its anchor only', () => {
    expect(occursOn(NO_RECURRENCE, anchor, anchor)).toBe(true);
    expect(occursOn(NO_RECURRENCE, anchor, '2026-09-25')).toBe(false);
  });

  it('never occurs before the anchor', () => {
    expect(occursOn(rule({ kind: 'daily' }), anchor, '2026-09-23')).toBe(false);
  });

  it('stops after until, and includes it', () => {
    const daily = rule({ kind: 'daily', until: '2026-09-30' });
    expect(occursOn(daily, anchor, '2026-09-30')).toBe(true);
    expect(occursOn(daily, anchor, '2026-10-01')).toBe(false);
  });

  it('lands a weekly series on its weekdays only', () => {
    const monFri = rule({ kind: 'weekly', weekdays: [1, 5] });
    expect(occursOn(monFri, anchor, anchor)).toBe(false);
    expect(occursOn(monFri, anchor, '2026-09-25')).toBe(true);
    expect(occursOn(monFri, anchor, '2026-09-28')).toBe(true);
    expect(occursOn(monFri, anchor, '2026-09-29')).toBe(false);
  });

  it('moves a day past the month’s end to its last day (REC-02)', () => {
    const on31st = rule({ kind: 'monthly', monthDays: [31] });
    const from = '2026-01-31';
    expect(occursOn(on31st, from, '2026-02-28')).toBe(true);
    expect(occursOn(on31st, from, '2026-04-30')).toBe(true);
    expect(occursOn(on31st, from, '2026-05-30')).toBe(false);
    expect(occursOn(on31st, from, '2026-05-31')).toBe(true);
    expect(occursOn(on31st, from, '2028-02-29')).toBe(true);
    expect(occursOn(on31st, from, '2028-02-28')).toBe(false);
  });

  it('lands twice-listed month-end days once on a short month', () => {
    const r = rule({ kind: 'monthly', monthDays: [30, 31] });
    expect(occursOn(r, '2026-01-01', '2026-02-28')).toBe(true);
    expect(occursOn(r, '2026-01-01', '2026-02-27')).toBe(false);
  });
});

describe('firstOccurrenceFrom', () => {
  const anchor = '2026-09-24'; // Thursday

  it('is the anchor when the rule fits it', () => {
    expect(firstOccurrenceFrom(NO_RECURRENCE, anchor, anchor)).toBe(anchor);
    expect(
      firstOccurrenceFrom(
        rule({ kind: 'weekly', weekdays: [4] }),
        anchor,
        anchor,
      ),
    ).toBe(anchor);
  });

  it('skips ahead to the first day the rule fits', () => {
    expect(
      firstOccurrenceFrom(
        rule({ kind: 'weekly', weekdays: [1] }),
        anchor,
        anchor,
      ),
    ).toBe('2026-09-28');
    expect(
      firstOccurrenceFrom(
        rule({ kind: 'monthly', monthDays: [31] }),
        '2026-02-01',
        '2026-02-01',
      ),
    ).toBe('2026-02-28');
  });

  it('is null when until comes first', () => {
    expect(
      firstOccurrenceFrom(
        rule({ kind: 'weekly', weekdays: [1], until: '2026-09-27' }),
        anchor,
        anchor,
      ),
    ).toBeNull();
  });

  it('is null for a one-off block already past', () => {
    expect(firstOccurrenceFrom(NO_RECURRENCE, anchor, '2026-09-25')).toBeNull();
  });

  it('finds the longest gap, the 31st from January to March', () => {
    expect(
      firstOccurrenceFrom(
        rule({ kind: 'monthly', monthDays: [31] }),
        '2026-01-31',
        '2026-02-01',
      ),
    ).toBe('2026-02-28');
  });
});
