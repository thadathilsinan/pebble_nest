import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { daysBetween, localDate } from '../../calendar/local-date';

/** The most days one `GET /days` returns, `from` and `to` included. */
export const MAX_DAYS_PER_REQUEST = 14;

/**
 * `GET /days?from=&to=`: swipe prefetch and the Now screen's today and
 * tomorrow. Both ends are included.
 */
export class ListDaysQuery extends createZodDto(
  z
    .object({ from: localDate, to: localDate })
    .superRefine(({ from, to }, ctx) => {
      if (to < from) {
        ctx.addIssue({
          code: 'custom',
          path: ['to'],
          message: 'The range cannot end before it starts.',
        });
      } else if (daysBetween(from, to) >= MAX_DAYS_PER_REQUEST) {
        ctx.addIssue({
          code: 'custom',
          path: ['to'],
          message: `A range covers at most ${MAX_DAYS_PER_REQUEST} days.`,
        });
      }
    }),
) {}
