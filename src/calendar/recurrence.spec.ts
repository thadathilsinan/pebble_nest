import {
  NO_RECURRENCE,
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
