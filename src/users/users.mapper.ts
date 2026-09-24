import type {
  SignInMethod,
  TimeFormat,
  UserRow,
  WeekStart,
} from '../core/database/schema';
import type { RecordStart } from './users.repository';

/** `Profile` in `docs/api-plan.md` §2. */
export interface Profile {
  id: string;
  version: number;
  email: string;
  /** Optional; the client shows the email when it is null. */
  name: string | null;
  /** How the device holding this session signed in — not a property of the account. */
  signInMethod: SignInMethod;
  weekStart: WeekStart;
  timeFormat: TimeFormat;
  timeZone: string | null;
  /** The review's range picker goes back no further. */
  firstRecordedDay: string | null;
  /** Whether any block or task exists, for the Now screen's empty state. */
  hasAnyRecord: boolean;
}

export function toProfile(
  row: UserRow,
  signInMethod: SignInMethod,
  record: RecordStart,
): Profile {
  return {
    id: row.id,
    version: row.version,
    email: row.email,
    name: row.name,
    signInMethod,
    weekStart: row.weekStart,
    timeFormat: row.timeFormat,
    timeZone: row.timeZone,
    firstRecordedDay: record.firstRecordedDay,
    hasAnyRecord: record.hasAnyRecord,
  };
}
