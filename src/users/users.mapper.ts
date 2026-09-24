import type {
  SignInMethod,
  TimeFormat,
  UserRow,
  WeekStart,
} from '../core/database/schema';

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
  firstRecordedDay: string | null;
  hasAnyRecord: boolean;
}

export function toProfile(row: UserRow, signInMethod: SignInMethod): Profile {
  return {
    id: row.id,
    version: row.version,
    email: row.email,
    name: row.name,
    signInMethod,
    weekStart: row.weekStart,
    timeFormat: row.timeFormat,
    timeZone: row.timeZone,
    // Both are derived from the day ledger, which does not exist yet. Until it
    // does, every account is truthfully one with no record.
    firstRecordedDay: null,
    hasAnyRecord: false,
  };
}
