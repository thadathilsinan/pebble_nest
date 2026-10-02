import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { assertOccursOn } from '../blocks/block-occurrence';
import { shapeOf } from '../blocks/blocks.mapper';
import { BlocksRepository } from '../blocks/blocks.repository';
import { addDays, daysBetween } from '../calendar/local-date';
import { resolveRecurrence, type Recurrence } from '../calendar/recurrence';
import { DB, type Db, type Executor } from '../core/database/database.module';
import type { TaskRow, TaskSeriesRow } from '../core/database/schema';
import type { ErrorCode } from '../core/http/error-code';
import { assertNotPast, dayClosed, todayFor } from '../users/today';
import { UsersRepository } from '../users/users.repository';
import type { CreateTaskBody } from './dto/create-task.dto';
import type { DeleteTaskQuery } from './dto/delete-task.dto';
import type { MoveTaskBody } from './dto/move-task.dto';
import type { SetTaskDoneBody } from './dto/set-task-done.dto';
import type { SetTaskMissedBody } from './dto/set-task-missed.dto';
import type { UpdateTaskBody } from './dto/update-task.dto';
import { assertReminderFits, type BlockTimes } from './reminder';
import { ownRecurrenceOf } from './task-series';
import {
  TaskSeriesRepository,
  type NewTaskSeries,
  type TaskSeriesChanges,
} from './task-series.repository';
import { TaskSeriesService } from './task-series.service';
import { toTask, type Task, type TaskWithSeries } from './tasks.mapper';
import { TasksRepository, type TaskChanges } from './tasks.repository';

@Injectable()
export class TasksService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tasks: TasksRepository,
    private readonly blocks: BlocksRepository,
    private readonly users: UsersRepository,
    private readonly taskSeries: TaskSeriesRepository,
    private readonly series: TaskSeriesService,
  ) {}

  /**
   * Creates a task in a block occurrence or on a date's general list: a
   * one-off, or the first occurrence of a repeating task (decision 1). One
   * in a block may repeat with it, if the block repeats; one on the general
   * list may repeat on its own `recurrence`. The series is anchored on
   * `date` even when its rule doesn't land there, as in the app, and its
   * later occurrences are issued as their dates are read.
   *
   * `date` must not be before today in the user's time zone: a day that has
   * already closed takes no new tasks (decision 40).
   *
   * A retry carrying the same `idempotencyKey` returns the task the first
   * request created, whatever the retry's body says, and writes no series or
   * ledger entries of its own. It does not read the session (decision 16).
   */
  async create(caller: Caller, body: CreateTaskBody): Promise<Task> {
    const inBlock = body.blockSeriesId != null;
    const ownRepeat =
      body.recurrence !== undefined && body.recurrence.kind !== 'none';
    const withBlock = body.repeatWithBlock === true;

    if ((ownRepeat && inBlock) || (withBlock && !inBlock)) {
      throw repeatNotAllowed();
    }
    assertNotPast(body.date, await this.todayFor(caller));

    let block: BlockTimes | null = null;
    if (body.blockSeriesId != null) {
      const found = await this.blocks.findOccurrence(
        this.db,
        caller.userId,
        body.blockSeriesId,
        body.date,
      );
      assertOccursOn(found, body.date);
      if (withBlock && found.series.recurrenceKind === 'none') {
        throw repeatNotAllowed();
      }
      block = shapeOf(found.series, found.exception);
    }
    if (body.reminderAt) assertReminderFits(body.reminderAt, body.date, block);

    const series: NewTaskSeries | null =
      ownRepeat || withBlock
        ? {
            userId: caller.userId,
            blockSeriesId: withBlock ? body.blockSeriesId! : null,
            anchorDate: body.date,
            ...recurrenceColumns(
              ownRepeat ? resolveRecurrence(body.recurrence, body.date) : null,
            ),
            title: body.title,
            notes: body.notes ?? '',
            reminderDayOffset: body.reminderAt
              ? daysBetween(body.date, body.reminderAt.date)
              : null,
            reminderMin: body.reminderAt?.min ?? null,
          }
        : null;

    const created = await this.db.transaction(async (tx) => {
      const { row, created } = await this.tasks.create(tx, {
        userId: caller.userId,
        blockSeriesId: body.blockSeriesId ?? null,
        date: body.date,
        title: body.title,
        notes: body.notes ?? '',
        reminderDate: body.reminderAt?.date ?? null,
        reminderMin: body.reminderAt?.min ?? null,
        carryCount: 0,
        missed: false,
        idempotencyKey: body.idempotencyKey,
      });
      if (!created) return this.withSeries(tx, row);

      const task =
        series === null
          ? row
          : await this.tasks.linkSeries(
              tx,
              row.id,
              (await this.taskSeries.create(tx, series)).id,
            );
      return this.withSeries(tx, task);
    });

    return toTask(created);
  }

  /**
   * Marks a task done or open again (TSK-04). Done stamps `doneAt` and records
   * the task completed on its day; open again removes that record.
   *
   * A task reopened on a day that has already closed is settled at once
   * (decision 2), as `create` settles one put there: carried to today's
   * general list, or recorded missed on the day before its series comes
   * round again (REC-06). A missed task reopened is missed again, where it
   * is, since its day has been settled already.
   *
   * Ticking a task skipped on today or a later day (`/missed`) clears the
   * skip: done replaces it, and reopened it is simply open.
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
      const found = await this.tasks.findForUpdate(tx, caller.userId, id);
      if (found === null) throw taskNotFound();
      const task = await this.withSeries(tx, found);
      if (found.done === body.done) return task;

      if (body.done) {
        const done = await this.tasks.setDone(
          tx,
          found.id,
          true,
          undefined,
          found.missed && found.date >= today,
        );
        await this.tasks.recordCompleted(tx, done);
        return { ...task, task: done };
      }

      await this.tasks.clearDay(tx, found.id, found.date);
      if (found.missed) {
        const reopened = await this.tasks.setDone(tx, found.id, false);
        await this.tasks.recordMissed(tx, reopened);
        return { ...task, task: reopened };
      }
      if (found.date >= today) {
        return { ...task, task: await this.tasks.setDone(tx, found.id, false) };
      }

      const settled = await this.series.settleClosed(
        tx,
        caller.userId,
        task.series,
        found.date,
        today,
      );
      const carried = await this.tasks.setDone(tx, found.id, false, {
        date: settled.date,
        days: settled.carryDays,
        missed: settled.missed,
      });
      await this.tasks.recordSettled(tx, carried, found.date, settled, today);
      return { ...task, task: carried };
    });

    return toTask(row);
  }

  /**
   * Skips a task, or takes the skip back. Skipped, it is `missed`: not done,
   * recorded missed on its day at once, and never carried over or reminded
   * of. A done task skipped loses its tick, `missed` replacing `completed`.
   * Taken back, it is open again and its day's entry goes. An occurrence of
   * a repeating task is skipped alone; its series carries on.
   *
   * Only a task on today or a later day: a closed day has settled what is on
   * it, so a change there is `422 DAY_CLOSED` (decision 40).
   *
   * Sending the value the task already has changes nothing, not even
   * `version`. It does not read the session (decision 16).
   */
  async setMissed(
    caller: Caller,
    id: string,
    body: SetTaskMissedBody,
  ): Promise<Task> {
    const today = await this.todayFor(caller);

    const row = await this.db.transaction(async (tx) => {
      const found = await this.tasks.findForUpdate(tx, caller.userId, id);
      if (found === null) throw taskNotFound();
      const task = await this.withSeries(tx, found);
      if (found.missed === body.missed) return task;
      if (found.date < today) throw dayClosed();

      const changed = await this.tasks.setMissed(tx, found.id, body.missed);
      if (body.missed) {
        await this.tasks.recordMissed(tx, changed);
      } else {
        await this.tasks.clearDay(tx, found.id, found.date);
      }
      return { ...task, task: changed };
    });

    return toTask(row);
  }

  /**
   * Edits a task's title, notes, reminder or repeat. It never moves the task
   * or carries it: where a task sits is `/move`'s, and done is `/done`'s.
   *
   * On an occurrence of a repeating task (decision 5), a new title or
   * reminder reaches the series and its later open occurrences too; notes
   * reach every occurrence, past ones included. Turning the repeat off stops
   * the series here: this occurrence stays as a one-off, and open ones
   * already issued for later dates are removed. A changed rule on a task
   * repeating on its own stops the old series here and starts a new one from
   * this occurrence. Turning a repeat on starts a series from this task, by
   * `create`'s rules for where it sits.
   *
   * A task on a day that has closed can't be edited: a patch that would
   * change it is `422 DAY_CLOSED` (decision 40).
   *
   * A stale `version` is a 409 carrying the task as it now is. A patch that
   * changes nothing returns the task without bumping `version`. A new title
   * reaches every day the task has recorded (decision 25). The task row is
   * locked for the write, then its series' row, so that rename and the
   * version check cannot interleave with another device's.
   *
   * It does not read the session (decision 16).
   */
  async update(
    caller: Caller,
    id: string,
    body: UpdateTaskBody,
  ): Promise<Task> {
    const today = await this.todayFor(caller);

    const row = await this.db.transaction(async (tx) => {
      const task = await this.tasks.findForUpdate(tx, caller.userId, id);
      if (task === null) throw taskNotFound();
      const series =
        task.taskSeriesId === null
          ? null
          : await this.taskSeries.findByIdForUpdate(
              tx,
              caller.userId,
              task.taskSeriesId,
            );
      if (task.version !== body.version) {
        throw new ConflictException({
          code: 'STALE_VERSION' satisfies ErrorCode,
          message: 'The task was changed elsewhere. Re-apply and retry.',
          meta: { current: toTask({ task, series }) },
        });
      }

      const repeat = await this.repeatChange(tx, task, series, body);
      const changes = changesTo(task, body);
      if (
        task.date < today &&
        (changes !== undefined || repeat.kind !== 'keep')
      ) {
        throw dayClosed();
      }
      if (changes?.reminderDate != null) {
        assertReminderFits(
          { date: changes.reminderDate, min: changes.reminderMin! },
          task.date,
          await this.blockTimesOf(tx, task),
        );
      }
      if (changes === undefined && repeat.kind === 'keep') {
        return { task, series };
      }

      let updated = await this.tasks.update(tx, task.id, {
        ...changes,
        ...(repeat.kind === 'stop' && { taskSeriesId: null }),
      });
      if (changes?.title !== undefined) {
        await this.tasks.renameLedger(tx, task.id, changes.title);
      }

      switch (repeat.kind) {
        case 'keep':
          if (series !== null) {
            await this.followEdit(tx, updated, series, changes ?? {});
          }
          return { task: updated, series };

        case 'stop':
          await this.stopSeriesAt(tx, series!, updated.date);
          return { task: updated, series: null };

        case 'start': {
          const kept =
            series === null
              ? []
              : await this.stopSeriesAt(tx, series, updated.date);
          const started = await this.taskSeries.create(
            tx,
            seriesFrom(updated, repeat.blockSeriesId, repeat.recurrence),
            kept,
          );
          updated = await this.tasks.linkSeries(tx, updated.id, started.id);
          // Still the same task to the user, so notes reach back through the
          // series it leaves too, as in the app.
          if (series !== null && changes?.notes !== undefined) {
            await this.taskSeries.update(tx, series.id, {
              notes: changes.notes,
            });
            await this.tasks.shareNotes(tx, series.id, changes.notes);
          }
          return { task: updated, series: started };
        }
      }
    });

    return toTask(row);
  }

  /**
   * Moves a task between blocks, to the general list, or to another date
   * (TSK-03). Its tasks-in-a-block rule is create's: the block must be the
   * caller's and fall on `date`, and `date` must not be before today
   * (decision 40). A task on a closed day can be moved off it.
   *
   * An occurrence of a repeating task splits off as a one-off, and its series
   * carries on where it was without it (TSK-03). A done task takes its
   * `completed` entry with it, so the day it now sits on is the day it
   * counts for. Days an open task had already carried through keep the
   * entry they have.
   *
   * A missed task moved is open where it goes. A closed day keeps the
   * `missed` it recorded; an open day's skip is taken back.
   *
   * No `version`: the last write wins, and a real move bumps `version`.
   * Moving a task to where it already is changes nothing. It does not read
   * the session (decision 16).
   */
  async move(caller: Caller, id: string, body: MoveTaskBody): Promise<Task> {
    const today = await this.todayFor(caller);
    assertNotPast(body.date, today);

    const row = await this.db.transaction(async (tx) => {
      const task = await this.tasks.findForUpdate(tx, caller.userId, id);
      if (task === null) throw taskNotFound();
      if (body.blockSeriesId !== null) {
        assertOccursOn(
          await this.blocks.findOccurrence(
            tx,
            caller.userId,
            body.blockSeriesId,
            body.date,
          ),
          body.date,
        );
      }
      if (
        task.date === body.date &&
        task.blockSeriesId === body.blockSeriesId
      ) {
        return task;
      }

      if (task.done) {
        await this.tasks.clearDay(tx, task.id, task.date);
        const moved = await this.tasks.move(tx, task.id, {
          ...body,
          carryDays: 0,
          splitOff: true,
          reopen: true,
        });
        await this.tasks.recordCompleted(tx, moved);
        return moved;
      }

      if (task.missed && task.date >= today) {
        await this.tasks.clearDay(tx, task.id, task.date);
      }
      return this.tasks.move(tx, task.id, {
        ...body,
        carryDays: 0,
        splitOff: true,
        reopen: true,
      });
    });

    return toTask(await this.withSeries(this.db, row));
  }

  /**
   * Deletes a task. It never comes back, and the days it recorded stay in the
   * ledger under its title, so the dashboard is unchanged. A retry after a
   * lost response is a 404.
   *
   * `series` on an occurrence of a repeating task (decision 3) also deletes
   * every occurrence from today on, done or open, and ends the series
   * yesterday, so it issues nothing more. Occurrences before today stay in
   * the history. A series that hadn't begun before today is deleted
   * altogether. Either scope deletes just the task for a one-off, as the app
   * does.
   *
   * It reads no user row for `onlyThis`, as `update` doesn't, so a token
   * whose account is gone gets 404; `series` reads the user's time zone. It
   * does not read the session (decision 16).
   */
  async delete(
    caller: Caller,
    id: string,
    scope: DeleteTaskQuery['scope'],
  ): Promise<void> {
    if (scope === 'onlyThis') {
      if (!(await this.tasks.delete(this.db, caller.userId, id))) {
        throw taskNotFound();
      }
      return;
    }

    const today = await this.todayFor(caller);
    await this.db.transaction(async (tx) => {
      const task = await this.tasks.findForUpdate(tx, caller.userId, id);
      if (task === null) throw taskNotFound();
      const series =
        task.taskSeriesId === null
          ? null
          : await this.taskSeries.findByIdForUpdate(
              tx,
              caller.userId,
              task.taskSeriesId,
            );
      if (series === null) {
        await this.tasks.delete(tx, caller.userId, task.id);
        return;
      }

      await this.tasks.deleteSeriesFrom(tx, series.id, today, task.id);
      if (series.anchorDate >= today) {
        await this.taskSeries.delete(tx, series.id);
      } else {
        await this.taskSeries.endBy(tx, series.id, addDays(today, -1));
      }
    });
  }

  /**
   * What a patch does to the task's repeat, by `create`'s rules for where
   * it sits (decision 1). A repeat that doesn't fit is `REPEAT_NOT_ALLOWED`.
   * Fields that restate the repeat the task already has change nothing.
   */
  private async repeatChange(
    ex: Executor,
    task: TaskRow,
    series: TaskSeriesRow | null,
    body: UpdateTaskBody,
  ): Promise<RepeatChange> {
    const ownRepeat =
      body.recurrence !== undefined && body.recurrence.kind !== 'none';
    const withBlock = body.repeatWithBlock === true;

    if (series === null) {
      if (!ownRepeat && !withBlock) return { kind: 'keep' };
      if (task.blockSeriesId === null) {
        if (withBlock) throw repeatNotAllowed();
        return {
          kind: 'start',
          blockSeriesId: null,
          recurrence: this.ownRule(body, task.date),
        };
      }
      if (ownRepeat) throw repeatNotAllowed();
      // Set null when its series goes, so a block id here is still the user's.
      const block = await this.blocks.findById(
        ex,
        task.userId,
        task.blockSeriesId,
      );
      if (block === null || block.recurrenceKind === 'none') {
        throw repeatNotAllowed();
      }
      return {
        kind: 'start',
        blockSeriesId: block.id,
        recurrence: null,
      };
    }

    if (series.blockSeriesId !== null) {
      if (ownRepeat) throw repeatNotAllowed();
      return body.repeatWithBlock === false
        ? { kind: 'stop' }
        : { kind: 'keep' };
    }

    if (withBlock) throw repeatNotAllowed();
    if (body.recurrence === undefined) return { kind: 'keep' };
    if (!ownRepeat) return { kind: 'stop' };
    const recurrence = this.ownRule(body, task.date);
    return sameRecurrence(recurrence, ownRecurrenceOf(series)!)
      ? { kind: 'keep' }
      : { kind: 'start', blockSeriesId: null, recurrence };
  }

  /**
   * The patch's own recurrence, anchored on `date`. Its first occurrence is
   * `date`, so the repeat cannot end before it.
   */
  private ownRule(body: UpdateTaskBody, date: string): Recurrence {
    const recurrence = resolveRecurrence(body.recurrence, date);
    if (recurrence.until !== null && recurrence.until < date) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED' satisfies ErrorCode,
        message: 'The repeat cannot end before the task’s date.',
      });
    }
    return recurrence;
  }

  /**
   * An edit to one occurrence carried through its series (decision 5): the
   * title and reminder to the series and its later open occurrences, the
   * notes to the series and every occurrence.
   */
  private async followEdit(
    ex: Executor,
    task: TaskRow,
    series: TaskSeriesRow,
    changes: TaskChanges,
  ): Promise<void> {
    const reminderChanged = changes.reminderDate !== undefined;
    const reminder =
      task.reminderDate === null || task.reminderMin === null
        ? null
        : {
            dayOffset: daysBetween(task.date, task.reminderDate),
            min: task.reminderMin,
          };

    const template: TaskSeriesChanges = {
      ...(changes.title !== undefined && { title: changes.title }),
      ...(changes.notes !== undefined && { notes: changes.notes }),
      ...(reminderChanged && {
        reminderDayOffset: reminder?.dayOffset ?? null,
        reminderMin: reminder?.min ?? null,
      }),
    };
    if (Object.keys(template).length === 0) return;
    await this.taskSeries.update(ex, series.id, template);

    if (changes.title !== undefined || reminderChanged) {
      await this.tasks.applyToLaterOpen(ex, series.id, task.date, {
        ...(changes.title !== undefined && { title: changes.title }),
        ...(reminderChanged && { reminder }),
      });
    }
    if (changes.notes !== undefined) {
      await this.tasks.shareNotes(ex, series.id, changes.notes);
    }
  }

  /**
   * Stops the series after `date`: it issues nothing later, its open
   * occurrences already issued for later dates are removed, and done ones
   * stay as one-offs. Returns those done ones' dates, so a series started
   * in its place doesn't issue them again.
   */
  private async stopSeriesAt(
    ex: Executor,
    series: TaskSeriesRow,
    date: string,
  ): Promise<string[]> {
    await this.taskSeries.endBy(ex, series.id, date);
    return this.tasks.dropLaterCopies(ex, series.id, date);
  }

  /**
   * The times of the occurrence `task` sits in, overrides included, or null
   * on the general list.
   */
  private async blockTimesOf(
    ex: Executor,
    task: TaskRow,
  ): Promise<BlockTimes | null> {
    if (task.blockSeriesId === null) return null;
    const found = await this.blocks.findOccurrence(
      ex,
      task.userId,
      task.blockSeriesId,
      task.date,
    );
    return found === null ? null : shapeOf(found.series, found.exception);
  }

  /** The task with the series it is an occurrence of, for its `repeat`. */
  private async withSeries(
    ex: Executor,
    task: TaskRow,
  ): Promise<TaskWithSeries> {
    return {
      task,
      series:
        task.taskSeriesId === null
          ? null
          : await this.taskSeries.findById(ex, task.userId, task.taskSeriesId),
    };
  }

  /**
   * Today in the caller's time zone: every day before it has closed. A token
   * whose account is gone is refused here.
   */
  private async todayFor(caller: Caller): Promise<string> {
    return todayFor(await this.users.findById(this.db, caller.userId));
  }
}

/**
 * What the patch would change, as columns, or `undefined` when it changes
 * nothing.
 */
function changesTo(
  task: TaskRow,
  body: UpdateTaskBody,
): TaskChanges | undefined {
  const changes: TaskChanges = {};
  if (body.title !== undefined && body.title !== task.title) {
    changes.title = body.title;
  }
  if (body.notes !== undefined && body.notes !== task.notes) {
    changes.notes = body.notes;
  }
  if (body.reminderAt !== undefined) {
    const date = body.reminderAt?.date ?? null;
    const min = body.reminderAt?.min ?? null;
    if (date !== task.reminderDate || min !== task.reminderMin) {
      changes.reminderDate = date;
      changes.reminderMin = min;
    }
  }
  return Object.keys(changes).length === 0 ? undefined : changes;
}

/** A series' recurrence columns: its own rule, or none for one in a block. */
function recurrenceColumns(
  recurrence: Recurrence | null,
): Pick<NewTaskSeries, 'recurrenceKind' | 'weekdays' | 'monthDays' | 'until'> {
  return {
    recurrenceKind: recurrence?.kind ?? 'none',
    weekdays: recurrence?.weekdays ?? [],
    monthDays: recurrence?.monthDays ?? [],
    until: recurrence?.until ?? null,
  };
}

/** What `PATCH /tasks/{id}` does to the task's repeat. */
type RepeatChange =
  | { kind: 'keep' }
  | { kind: 'stop' }
  | {
      kind: 'start';
      /** Set to repeat with that block; null to repeat on its own. */
      blockSeriesId: string | null;
      recurrence: Recurrence | null;
    };

/** A new series started from `task`, as it now is, on its date. */
function seriesFrom(
  task: TaskRow,
  blockSeriesId: string | null,
  recurrence: Recurrence | null,
): NewTaskSeries {
  return {
    userId: task.userId,
    blockSeriesId,
    anchorDate: task.date,
    ...recurrenceColumns(recurrence),
    title: task.title,
    notes: task.notes,
    reminderDayOffset:
      task.reminderDate === null
        ? null
        : daysBetween(task.date, task.reminderDate),
    reminderMin: task.reminderMin,
  };
}

function sameRecurrence(a: Recurrence, b: Recurrence): boolean {
  return (
    a.kind === b.kind &&
    a.until === b.until &&
    a.weekdays.join() === b.weekdays.join() &&
    a.monthDays.join() === b.monthDays.join()
  );
}

function taskNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'NOT_FOUND' satisfies ErrorCode,
    message: 'No such task.',
  });
}

function repeatNotAllowed(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'REPEAT_NOT_ALLOWED' satisfies ErrorCode,
    message:
      'A task in a block can only repeat with a repeating block, and a task on the general list only on its own.',
  });
}
