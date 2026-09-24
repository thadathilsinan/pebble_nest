import { Inject, Injectable } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { localDateTime } from '../calendar/local-date';
import { DB, type Db } from '../core/database/database.module';
import { DaysService } from '../days/days.service';
import { TasksRepository } from '../tasks/tasks.repository';

/** NTF-01: sent at a block's start when its alert is on. */
export interface BlockAlert {
  seriesId: string;
  /** The day the occurrence starts. */
  date: string;
  name: string;
  /** Local wall-clock time, `YYYY-MM-DDTHH:mm`, no offset. */
  startAt: string;
  /** For "Family starts now · 3 tasks". */
  openTaskCount: number;
}

/** NTF-02: sent at the reminder time, only while the task is open. */
export interface TaskReminder {
  taskId: string;
  title: string;
  /** Local wall-clock time, `YYYY-MM-DDTHH:mm`, no offset. */
  remindAt: string;
}

export interface Schedule {
  blockAlerts: BlockAlert[];
  taskReminders: TaskReminder[];
}

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly days: DaysService,
    private readonly tasks: TasksRepository,
  ) {}

  /**
   * Everything that fires from `from` to `to`, both included, each list in
   * firing order. Times already past today are kept: the phone drops them
   * when it schedules. It reads neither the session (decision 16) nor the
   * user, so a deleted account's token gets empty lists, as `GET /days` does.
   */
  async schedule(caller: Caller, from: string, to: string): Promise<Schedule> {
    const [days, reminderRows] = await Promise.all([
      this.days.list(caller, from, to),
      this.tasks.findOpenRemindersBetween(this.db, caller.userId, from, to),
    ]);

    // An alert fires at the start, so a midnight tail has none of its own.
    // Deleted occurrences are already left out of the days.
    const blockAlerts: BlockAlert[] = days
      .flatMap((day) => day.blocks)
      .filter((b) => !b.continuedFromPreviousDay && b.alert && !b.skipped)
      .map((b) => ({
        seriesId: b.seriesId,
        date: b.date,
        name: b.name,
        startAt: localDateTime(b.date, b.startMin),
        openTaskCount: b.openCount,
      }))
      .sort(
        (a, b) =>
          compare(a.startAt, b.startAt) ||
          compare(a.name, b.name) ||
          compare(a.seriesId, b.seriesId),
      );

    const taskReminders: TaskReminder[] = reminderRows
      .flatMap((row) =>
        row.reminderDate === null || row.reminderMin === null
          ? []
          : [
              {
                taskId: row.id,
                title: row.title,
                remindAt: localDateTime(row.reminderDate, row.reminderMin),
              },
            ],
      )
      .sort(
        (a, b) =>
          compare(a.remindAt, b.remindAt) ||
          compare(a.title, b.title) ||
          compare(a.taskId, b.taskId),
      );

    return { blockAlerts, taskReminders };
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
