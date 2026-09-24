import { z } from 'zod';
import { localDate } from '../../calendar/local-date';

/**
 * A local wall-clock reading with no offset, `YYYY-MM-DDTHH:mm` (decision 6),
 * parsed into the date and minutes from its midnight that `tasks` stores.
 */
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

export const localDateTime = z.string().transform((value, ctx) => {
  const match = LOCAL_DATE_TIME.exec(value);
  if (match === null || !localDate.safeParse(match[1]).success) {
    ctx.addIssue({
      code: 'custom',
      message: 'Expected a real YYYY-MM-DDTHH:mm in local time, no offset.',
    });
    return z.NEVER;
  }
  // Every group took part in the match, so the defaults never apply.
  const [, date = '', hours = '', minutes = ''] = match;
  return { date, min: Number(hours) * 60 + Number(minutes) };
});
