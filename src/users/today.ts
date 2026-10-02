import { UnprocessableEntityException } from '@nestjs/common';
import { accessTokenInvalid } from '../auth/errors';
import { nowIn, todayIn } from '../calendar/local-date';
import type { UserRow } from '../core/database/schema';
import type { ErrorCode } from '../core/http/error-code';

/**
 * The zone a user's days are read in before the device has reported one. The
 * app reports it on every open, so this only covers the first requests of a
 * brand new account.
 */
export const FALLBACK_TIME_ZONE = 'UTC';

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

/**
 * Refuses a block or task created or moved onto a day before the user's
 * `today`: a closed day takes no new plans (decision 40).
 */
export function assertNotPast(date: string, today: string): void {
  if (date < today) {
    throw new UnprocessableEntityException({
      code: 'DATE_IN_PAST' satisfies ErrorCode,
      message: 'Blocks and tasks can only be put on today or a later day.',
    });
  }
}

/**
 * An edit to what sits on a day before the user's today. A closed day's
 * blocks and tasks can only be moved off it or deleted, and its tasks
 * ticked or un-ticked (decision 40).
 */
export function dayClosed(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'DAY_CLOSED' satisfies ErrorCode,
    message:
      'That day has closed. What is on it can be moved or deleted, not edited.',
  });
}
