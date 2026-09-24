import type { BlockOccurrence } from '../blocks/blocks.mapper';
import type { DayBlocks } from '../days/days.service';
import { reviewHours as reviewRange, type LocalNow } from './review-hours';

const MON = '2030-09-02';
const TUE = '2030-09-03';
const WED = '2030-09-04';

function block(extra: Partial<BlockOccurrence>): BlockOccurrence {
  return {
    seriesId: 'series',
    seriesVersion: 0,
    date: MON,
    name: 'Deep work',
    startMin: 540,
    endMin: 600,
    alert: false,
    skipped: false,
    recurrence: { kind: 'none', weekdays: [], monthDays: [], until: null },
    trace: null,
    continuedFromPreviousDay: false,
    tasks: [],
    openCount: 0,
    totalCount: 0,
    ...extra,
  };
}

function day(date: string, ...blocks: Partial<BlockOccurrence>[]): DayBlocks {
  return { date, blocks: blocks.map((b) => block({ date, ...b })) };
}

/** Reviews exactly the days given. */
function reviewHours(days: DayBlocks[], now: LocalNow) {
  const dates = days.map((d) => d.date);
  const [from, to] = [dates[0], dates.at(-1)];
  if (from === undefined || to === undefined) throw new Error('no days');
  return reviewRange({ from, to }, days, now);
}

/** Long after every day here, so each one counts in full. */
const LATER = { date: '2031-01-01', minute: 0 };

describe('reviewHours', () => {
  it('counts nothing for an empty past day but its elapsed minutes', () => {
    expect(reviewHours([day(MON)], LATER)).toEqual({
      byName: [],
      skippedMinutes: 0,
      coveredMinutes: 0,
      split: { elapsedMinutes: 1440, blockedMinutes: 0, skippedMinutes: 0 },
    });
  });

  it('totals by name, ignoring capitals and surrounding spaces, largest first', () => {
    const hours = reviewHours(
      [
        day(MON, { name: 'Gym', startMin: 360, endMin: 420 }),
        day(
          TUE,
          { name: 'Deep work', startMin: 540, endMin: 720, trace: 'grid' },
          { name: ' gym ', startMin: 1080, endMin: 1110 },
        ),
      ],
      LATER,
    );

    expect(hours.byName).toEqual([
      { name: 'Deep work', minutes: 180, trace: 'grid' },
      // The first spelling met names the total.
      { name: 'Gym', minutes: 90, trace: null },
    ]);
    expect(hours.coveredMinutes).toBe(270);
  });

  it('counts overlapping blocks in full by name, but each minute once in the split', () => {
    const hours = reviewHours(
      [
        day(
          MON,
          { name: 'A', startMin: 540, endMin: 660 },
          { name: 'B', startMin: 600, endMin: 720 },
        ),
      ],
      LATER,
    );

    expect(hours.byName.map((n) => n.minutes)).toEqual([120, 120]);
    expect(hours.coveredMinutes).toBe(240);
    expect(hours.split.blockedMinutes).toBe(180);
  });

  it('keeps skipped time apart, and counts in the split only what no block that happened covers', () => {
    const hours = reviewHours(
      [
        day(
          MON,
          { name: 'Read', startMin: 480, endMin: 600, skipped: true },
          { name: 'Deep work', startMin: 540, endMin: 660 },
        ),
      ],
      LATER,
    );

    expect(hours.byName).toEqual([
      { name: 'Deep work', minutes: 120, trace: null },
    ]);
    expect(hours.skippedMinutes).toBe(120);
    expect(hours.split).toEqual({
      elapsedMinutes: 1440,
      blockedMinutes: 120,
      skippedMinutes: 60,
    });
  });

  it('splits a midnight-crossing block across its two days', () => {
    const hours = reviewHours(
      [
        day(MON, { name: 'Sleep', startMin: 1380, endMin: 420 }),
        day(TUE, {
          date: MON,
          name: 'Sleep',
          startMin: 1380,
          endMin: 420,
          continuedFromPreviousDay: true,
        }),
      ],
      LATER,
    );

    expect(hours.byName).toEqual([
      { name: 'Sleep', minutes: 480, trace: null },
    ]);
    expect(hours.split.blockedMinutes).toBe(480);
  });

  it('counts a tail at the start of the range without its head', () => {
    const hours = reviewHours(
      [
        day(TUE, {
          date: MON,
          name: 'Sleep',
          startMin: 1380,
          endMin: 420,
          continuedFromPreviousDay: true,
        }),
      ],
      LATER,
    );

    expect(hours.coveredMinutes).toBe(420);
  });

  it('counts a block ending exactly at midnight to the end of its day', () => {
    const hours = reviewHours([day(MON, { startMin: 1320, endMin: 0 })], LATER);

    expect(hours.coveredMinutes).toBe(120);
  });

  it('counts today only up to now, and a later day not at all', () => {
    const hours = reviewHours(
      [
        day(
          MON,
          { name: 'Done', startMin: 480, endMin: 540 },
          { name: 'Under way', startMin: 570, endMin: 660, skipped: true },
          { name: 'Ahead', startMin: 720, endMin: 780 },
        ),
        day(TUE, { name: 'Tomorrow', startMin: 0, endMin: 600 }),
      ],
      { date: MON, minute: 600 },
    );

    expect(hours.byName).toEqual([{ name: 'Done', minutes: 60, trace: null }]);
    expect(hours.skippedMinutes).toBe(30);
    expect(hours.split).toEqual({
      elapsedMinutes: 600,
      blockedMinutes: 60,
      skippedMinutes: 30,
    });
  });

  it('counts nothing when the whole range is ahead', () => {
    const hours = reviewHours([day(WED, { startMin: 0, endMin: 600 })], {
      date: MON,
      minute: 900,
    });

    expect(hours).toEqual({
      byName: [],
      skippedMinutes: 0,
      coveredMinutes: 0,
      split: { elapsedMinutes: 0, blockedMinutes: 0, skippedMinutes: 0 },
    });
  });

  it('counts the passed minutes of the whole range, even days not laid out', () => {
    const hours = reviewRange(
      { from: '2030-08-01', to: '2030-12-31' },
      [day(MON, { startMin: 540, endMin: 600 })],
      { date: TUE, minute: 90 },
    );

    // August 1 to September 2 is 33 days, then 90 minutes of September 3.
    expect(hours.split).toEqual({
      elapsedMinutes: 33 * 1440 + 90,
      blockedMinutes: 60,
      skippedMinutes: 0,
    });
  });
});
