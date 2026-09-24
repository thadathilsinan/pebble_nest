import type { Recurrence } from '../calendar/recurrence';
import type { BlockSeriesRow } from '../database/schema';

/** `BlockOccurrence` in `docs/api-plan.md` §1: one series on one date. */
export interface BlockOccurrence {
  seriesId: string;
  seriesVersion: number;
  /** The day the occurrence starts. */
  date: string;
  name: string;
  startMin: number;
  endMin: number;
  alert: boolean;
  skipped: boolean;
  recurrence: Recurrence;
  /** The user's chosen fill pattern for this name; null is the name's default. */
  trace: string | null;
  /** The tail of yesterday's midnight-crossing block. */
  continuedFromPreviousDay: boolean;
  // Tasks have no table yet. Until they do, every occurrence is truthfully
  // empty, as `toProfile` does for the ledger.
  tasks: never[];
  openCount: number;
  totalCount: number;
}

/**
 * The occurrence of `row` that starts on `date`. With no exceptions table yet,
 * every occurrence is the series itself: not skipped, not edited.
 */
export function toBlockOccurrence(
  row: BlockSeriesRow,
  date: string,
): BlockOccurrence {
  return {
    seriesId: row.id,
    seriesVersion: row.version,
    date,
    name: row.name,
    startMin: row.startMin,
    endMin: row.endMin,
    alert: row.alert,
    skipped: false,
    recurrence: {
      kind: row.recurrenceKind,
      weekdays: row.weekdays,
      monthDays: row.monthDays,
      until: row.until,
    },
    // Chosen traces are stored with `PUT /block-names/{name}/trace`, which
    // does not exist yet.
    trace: null,
    continuedFromPreviousDay: false,
    tasks: [],
    openCount: 0,
    totalCount: 0,
  };
}
