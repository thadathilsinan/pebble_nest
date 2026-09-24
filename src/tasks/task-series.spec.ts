import {
  landsOn,
  nextOccurrenceAfter,
  settle,
  type SeriesDays,
} from './task-series';

// 2026-09-21 is a Monday.
const own = (overrides: Partial<SeriesDays> = {}): SeriesDays => ({
  anchorDate: '2026-09-21',
  endedOn: null,
  blockSeriesId: null,
  recurrenceKind: 'weekly',
  weekdays: [1],
  monthDays: [],
  until: null,
  ...overrides,
});

const inBlock = (overrides: Partial<SeriesDays> = {}): SeriesDays => ({
  ...own({ recurrenceKind: 'none', weekdays: [] }),
  blockSeriesId: 'block',
  ...overrides,
});

const never = () => false;

describe('landsOn', () => {
  it('lands on its anchor even off its rule, and never before it', () => {
    const series = own({ anchorDate: '2026-09-23' });

    expect(landsOn(series, '2026-09-23', never)).toBe(true);
    expect(landsOn(series, '2026-09-21', never)).toBe(false);
    expect(landsOn(series, '2026-09-28', never)).toBe(true);
    expect(landsOn(series, '2026-09-24', never)).toBe(false);
  });

  it('lands nowhere after it ends', () => {
    const series = own({ endedOn: '2026-09-27' });

    expect(landsOn(series, '2026-09-28', never)).toBe(false);
  });

  it('follows its block', () => {
    const series = inBlock();
    const blockOn = (_id: string, date: string) => date === '2026-09-25';

    expect(landsOn(series, '2026-09-25', blockOn)).toBe(true);
    expect(landsOn(series, '2026-09-24', blockOn)).toBe(false);
  });
});

describe('nextOccurrenceAfter', () => {
  it('finds its own rule’s next day', () => {
    expect(nextOccurrenceAfter(own(), '2026-09-21', never)).toBe('2026-09-28');
  });

  it('finds none past `until` or after it ends', () => {
    expect(
      nextOccurrenceAfter(own({ until: '2026-09-27' }), '2026-09-21', never),
    ).toBeNull();
    expect(
      nextOccurrenceAfter(own({ endedOn: '2026-09-27' }), '2026-09-21', never),
    ).toBeNull();
  });

  it('finds its block’s next occurrence', () => {
    const blockOn = (_id: string, date: string) => date >= '2026-09-24';

    expect(nextOccurrenceAfter(inBlock(), '2026-09-21', blockOn)).toBe(
      '2026-09-24',
    );
  });
});

describe('settle', () => {
  it('carries a one-off to today', () => {
    expect(settle('2026-09-20', '2026-09-24', null)).toEqual({
      date: '2026-09-24',
      carryDays: 4,
      missed: false,
    });
  });

  it('carries to today while the next occurrence is still to come', () => {
    expect(settle('2026-09-20', '2026-09-24', '2026-09-25')).toEqual({
      date: '2026-09-24',
      carryDays: 4,
      missed: false,
    });
  });

  it('misses on the day before an occurrence that has come round', () => {
    expect(settle('2026-09-20', '2026-09-24', '2026-09-23')).toEqual({
      date: '2026-09-22',
      carryDays: 2,
      missed: true,
    });
  });

  it('misses on its own day when the next occurrence is the day after', () => {
    expect(settle('2026-09-20', '2026-09-24', '2026-09-21')).toEqual({
      date: '2026-09-20',
      carryDays: 0,
      missed: true,
    });
  });
});
