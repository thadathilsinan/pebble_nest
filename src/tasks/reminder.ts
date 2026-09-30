import { UnprocessableEntityException } from '@nestjs/common';
import { addDays } from '../calendar/local-date';
import type { ErrorCode } from '../core/http/error-code';

/** A reminder as the tasks table holds it: a local date and minutes. */
export interface Reminder {
  date: string;
  min: number;
}

/** The times of the block occurrence a task sits in. */
export interface BlockTimes {
  startMin: number;
  endMin: number;
}

/**
 * Where a reminder at `min` minutes of the day falls for a task on `date`
 * (decision 39). On the general list it is that time on the task's day. In
 * a block it falls from the occurrence's start to its end, both included,
 * so a block crossing midnight takes a reminder early the next morning; a
 * time outside the block goes back to its start.
 */
export function fitReminder(
  min: number,
  date: string,
  block: BlockTimes | null,
): Reminder {
  if (block === null) return { date, min };
  const { startMin, endMin } = block;
  const crosses = endMin <= startMin;
  if (min >= startMin && (crosses || min <= endMin)) return { date, min };
  if (crosses && min <= endMin) return { date: addDays(date, 1), min };
  return { date, min: startMin };
}

/**
 * A reminder the user set for a task on `date`, in `block` or on the general
 * list, must be one `fitReminder` leaves where it is: on the task's day, and
 * within its block.
 */
export function assertReminderFits(
  reminder: Reminder,
  date: string,
  block: BlockTimes | null,
): void {
  const fitted = fitReminder(reminder.min, date, block);
  if (fitted.date === reminder.date && fitted.min === reminder.min) return;
  throw new UnprocessableEntityException({
    code: 'REMINDER_OUT_OF_RANGE' satisfies ErrorCode,
    message:
      block === null
        ? 'A reminder falls on the task’s own day.'
        : 'A reminder falls within the task’s block.',
  });
}
