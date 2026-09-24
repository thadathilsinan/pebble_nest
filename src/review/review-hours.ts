import { normaliseBlockName } from '../block-names/block-name';
import { crossesMidnight, type BlockOccurrence } from '../blocks/blocks.mapper';
import type { ChosenTrace } from '../core/database/schema';
import { addDays, daysBetween } from '../calendar/local-date';
import type { DayBlocks } from '../days/days.service';

const MINUTES_PER_DAY = 1440;

/** DSH-04: the time spent under one block name. */
export interface NameMinutes {
  /** The first spelling the period met. */
  name: string;
  minutes: number;
  trace: ChosenTrace | null;
}

/** How the minutes that have passed in a period divide, each counted once. */
export interface MinuteSplit {
  elapsedMinutes: number;
  /** Covered by a block that happened. */
  blockedMinutes: number;
  /** Covered only by skipped blocks. */
  skippedMinutes: number;
}

/** The block half of `Review` (`docs/api-plan.md` §8). */
export interface ReviewHours {
  /** Largest first. */
  byName: NameMinutes[];
  skippedMinutes: number;
  coveredMinutes: number;
  split: MinuteSplit;
}

/** The user's local date and minute of the day, which bounds what counts. */
export interface LocalNow {
  date: string;
  minute: number;
}

/** A period of local dates, both ends included. */
export interface DateRange {
  from: string;
  to: string;
}

/**
 * DSH-04 over laid-out days, as the app's `review()` counts it:
 * - totals are by name, ignoring capitals and surrounding spaces
 * - overlapping blocks each count their full length
 * - a midnight-crossing block counts on each day for its part of that day
 * - skipped time is kept apart
 * - today counts only what has passed by `now`, and later days nothing
 *
 * The split counts each passed minute once: blocked if a block that happened
 * covers it, skipped if only skipped blocks do, free otherwise.
 *
 * `days` may leave out days of `range` that hold no block, such as those
 * before the user's first record or after today. The passed minutes are
 * counted from `range` itself.
 */
export function reviewHours(
  range: DateRange,
  days: DayBlocks[],
  now: LocalNow,
): ReviewHours {
  const byName = new Map<string, NameMinutes>();
  let skippedMinutes = 0;
  let coveredMinutes = 0;
  const split: MinuteSplit = {
    elapsedMinutes: elapsedMinutes(range, now),
    blockedMinutes: 0,
    skippedMinutes: 0,
  };

  for (const { date, blocks } of days) {
    const elapsed =
      date < now.date ? MINUTES_PER_DAY : date === now.date ? now.minute : 0;
    if (elapsed === 0) continue;

    const spans = blocks.map((block) => clip(spanOn(block), elapsed));
    const happened = spans.filter((_, i) => !blocks[i]?.skipped);
    const blocked = unionLength(happened);
    split.blockedMinutes += blocked;
    split.skippedMinutes += unionLength(spans) - blocked;

    blocks.forEach((block, i) => {
      const span = spans[i];
      if (span === undefined) return;
      const minutes = span.to - span.from;
      if (minutes <= 0) return;

      if (block.skipped) {
        skippedMinutes += minutes;
        return;
      }
      coveredMinutes += minutes;
      const key = normaliseBlockName(block.name);
      const total = byName.get(key);
      if (total === undefined) {
        byName.set(key, { name: block.name, minutes, trace: block.trace });
      } else {
        total.minutes += minutes;
      }
    });
  }

  return {
    // Stable, so equal totals keep the order they were first met in.
    byName: [...byName.values()].sort((a, b) => b.minutes - a.minutes),
    skippedMinutes,
    coveredMinutes,
    split,
  };
}

/** The minutes of `range` that have passed by `now`. */
function elapsedMinutes({ from, to }: DateRange, now: LocalNow): number {
  const lastPast = to < now.date ? to : addDays(now.date, -1);
  const pastDays = lastPast < from ? 0 : daysBetween(from, lastPast) + 1;
  const today = from <= now.date && now.date <= to ? now.minute : 0;
  return pastDays * MINUTES_PER_DAY + today;
}

interface Span {
  from: number;
  to: number;
}

/**
 * The minutes of its listed day a block covers: a tail from midnight to its
 * end, and a block that crosses midnight from its start to the day's end.
 */
function spanOn(block: BlockOccurrence): Span {
  if (block.continuedFromPreviousDay) return { from: 0, to: block.endMin };
  return {
    from: block.startMin,
    to: crossesMidnight(block) ? MINUTES_PER_DAY : block.endMin,
  };
}

function clip({ from, to }: Span, end: number): Span {
  return { from, to: Math.max(from, Math.min(to, end)) };
}

/** The minutes at least one span covers. */
function unionLength(spans: Span[]): number {
  const sorted = spans
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from);
  let total = 0;
  let reach = 0;
  for (const { from, to } of sorted) {
    if (to <= reach) continue;
    total += to - Math.max(from, reach);
    reach = to;
  }
  return total;
}
