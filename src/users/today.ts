import { accessTokenInvalid } from '../auth/errors';
import { nowIn, todayIn } from '../calendar/local-date';
import type { UserRow } from '../core/database/schema';

/**
 * The zone a user's days are read in before the device has reported one. The
 * app reports it on every open, so this only covers the first requests of a
 * brand new account.
 */
const FALLBACK_TIME_ZONE = 'UTC';

/**
 * Today in the user's time zone: every day before it has closed (decision
 * 22). A token whose account is gone reads no user, and is refused here.
 */
export function todayFor(user: UserRow | null): string {
  if (user === null) throw accessTokenInvalid();
  return todayIn(user.timeZone ?? FALLBACK_TIME_ZONE);
}

/**
 * The user's local date and minute of the day, for what has passed so far
 * today. Refused, as `todayFor` is, when the account is gone.
 */
export function nowFor(user: UserRow | null): { date: string; minute: number } {
  if (user === null) throw accessTokenInvalid();
  return nowIn(user.timeZone ?? FALLBACK_TIME_ZONE);
}
