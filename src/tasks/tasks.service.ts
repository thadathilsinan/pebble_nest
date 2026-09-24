import {
  Inject,
  Injectable,
  NotFoundException,
  NotImplementedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { accessTokenInvalid } from '../auth/errors';
import type { Caller } from '../auth/caller';
import { recurrenceOf } from '../blocks/blocks.mapper';
import { BlocksRepository } from '../blocks/blocks.repository';
import { addDays, daysBetween, todayIn } from '../calendar/local-date';
import { occursOn } from '../calendar/recurrence';
import { DB, type Db } from '../core/database/database.module';
import type { BlockSeriesRow } from '../core/database/schema';
import type { ErrorCode } from '../core/http/error-code';
import { UsersRepository } from '../users/users.repository';
import type { CreateTaskBody } from './dto/create-task.dto';
import type { SetTaskDoneBody } from './dto/set-task-done.dto';
import { toTask, type Task } from './tasks.mapper';
import { TasksRepository } from './tasks.repository';

/**
 * The zone a user's days are read in before the device has reported one. The
 * app reports it on every open, so this only covers the first requests of a
 * brand new account.
 */
const FALLBACK_TIME_ZONE = 'UTC';

@Injectable()
export class TasksService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tasks: TasksRepository,
    private readonly blocks: BlocksRepository,
    private readonly users: UsersRepository,
  ) {}

  /**
   * Creates a one-off task in a block occurrence or on a date's general list.
   *
   * Any date is accepted (TSK-05), past included. A task put on a day that
   * has already closed is carried forward at once, as the day-end job would
   * have carried it (decision 2): it lands on today's general list with one
   * carry and one `incomplete` ledger entry per closed day it passed through.
   * The response shows where it ended up. Until the day-end job keeps its own
   * record, "closed" means before today in the user's time zone.
   *
   * A retry carrying the same `idempotencyKey` returns the task the first
   * request created, whatever the retry's body says, and writes no ledger
   * entries of its own. It does not read the session (decision 16).
   */
  async create(caller: Caller, body: CreateTaskBody): Promise<Task> {
    const inBlock = body.blockSeriesId != null;
    const ownRepeat =
      body.recurrence !== undefined && body.recurrence.kind !== 'none';

    if ((ownRepeat && inBlock) || (body.repeatWithBlock === true && !inBlock)) {
      throw repeatNotAllowed();
    }

    if (body.blockSeriesId != null) {
      const series = await this.blocks.findById(
        this.db,
        caller.userId,
        body.blockSeriesId,
      );
      assertOccursOn(series, body.date);
      if (body.repeatWithBlock === true && series.recurrenceKind === 'none') {
        throw repeatNotAllowed();
      }
    }

    // Repeating tasks arrive with the task series slice.
    if (ownRepeat || body.repeatWithBlock === true) {
      throw new NotImplementedException({
        code: 'NOT_IMPLEMENTED' satisfies ErrorCode,
        message: 'Repeating tasks are not available yet.',
      });
    }

    const today = await this.todayFor(caller);
    const closed = body.date < today;

    const row = await this.db.transaction(async (tx) => {
      const { row, created } = await this.tasks.create(tx, {
        userId: caller.userId,
        // A carried task arrives on the next day's general list, so one put
        // on a closed day ends up on today's (TSK-06).
        blockSeriesId: closed ? null : (body.blockSeriesId ?? null),
        date: closed ? today : body.date,
        title: body.title,
        notes: body.notes ?? '',
        reminderDate: body.reminderAt?.date ?? null,
        reminderMin: body.reminderAt?.min ?? null,
        carryCount: closed ? daysBetween(body.date, today) : 0,
        idempotencyKey: body.idempotencyKey,
      });

      if (created && closed) {
        await this.tasks.recordIncomplete(
          tx,
          row,
          body.date,
          addDays(today, -1),
        );
      }
      return row;
    });

    return toTask(row);
  }

  /**
   * Marks a task done or open again (TSK-04). Done stamps `doneAt` and records
   * the task completed on its day; open again removes that record.
   *
   * A task reopened on a day that has already closed is carried forward at
   * once (decision 2), as `create` carries one put there: to today's general
   * list, with one carry and one `incomplete` entry per closed day.
   *
   * Sending the value the task already has changes nothing, not even
   * `version`. It does not read the session (decision 16).
   */
  async setDone(
    caller: Caller,
    id: string,
    body: SetTaskDoneBody,
  ): Promise<Task> {
    const today = await this.todayFor(caller);

    const row = await this.db.transaction(async (tx) => {
      const task = await this.tasks.findForUpdate(tx, caller.userId, id);
      if (task === null) {
        throw new NotFoundException({
          code: 'NOT_FOUND' satisfies ErrorCode,
          message: 'No such task.',
        });
      }
      if (task.done === body.done) return task;

      if (body.done) {
        const done = await this.tasks.setDone(tx, task.id, true);
        await this.tasks.recordCompleted(tx, done);
        return done;
      }

      await this.tasks.clearDay(tx, task.id, task.date);
      if (task.date >= today) return this.tasks.setDone(tx, task.id, false);

      const carried = await this.tasks.setDone(tx, task.id, false, {
        date: today,
        days: daysBetween(task.date, today),
      });
      await this.tasks.recordIncomplete(
        tx,
        carried,
        task.date,
        addDays(today, -1),
      );
      return carried;
    });

    return toTask(row);
  }

  /**
   * Today in the caller's time zone: every day before it has closed. A token
   * whose account is gone is refused here.
   */
  private async todayFor(caller: Caller): Promise<string> {
    const user = await this.users.findById(this.db, caller.userId);
    if (user === null) throw accessTokenInvalid();
    return todayIn(user.timeZone ?? FALLBACK_TIME_ZONE);
  }
}

/**
 * A task goes in an occurrence that exists: one of the caller's series, on a
 * day it falls on. `date` is the day the occurrence starts, so a task in a
 * midnight-crossing block is dated the day the block began.
 */
function assertOccursOn(
  series: BlockSeriesRow | null,
  date: string,
): asserts series is BlockSeriesRow {
  if (series === null) {
    throw new NotFoundException({
      code: 'NOT_FOUND' satisfies ErrorCode,
      message: 'No such block.',
    });
  }
  if (!occursOn(recurrenceOf(series), series.anchorDate, date)) {
    throw new UnprocessableEntityException({
      code: 'BLOCK_NOT_ON_DATE' satisfies ErrorCode,
      message: 'The block does not fall on that date.',
    });
  }
}

function repeatNotAllowed(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'REPEAT_NOT_ALLOWED' satisfies ErrorCode,
    message:
      'A task in a block can only repeat with a repeating block, and a task on the general list only on its own.',
  });
}
