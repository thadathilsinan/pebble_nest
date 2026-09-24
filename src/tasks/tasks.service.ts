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
import { BlocksRepository } from '../blocks/blocks.repository';
import { addDays, daysBetween } from '../calendar/local-date';
import { resolveRecurrence, type Recurrence } from '../calendar/recurrence';
import { DB, type Db, type Executor } from '../core/database/database.module';
import type { TaskRow, TaskSeriesRow } from '../core/database/schema';
import type { ErrorCode } from '../core/http/error-code';
import { todayFor } from '../users/today';
import { UsersRepository } from '../users/users.repository';
import type { CreateTaskBody } from './dto/create-task.dto';
import type { DeleteTaskQuery } from './dto/delete-task.dto';
import type { MoveTaskBody } from './dto/move-task.dto';
import type { SetTaskDoneBody } from './dto/set-task-done.dto';
import type { UpdateTaskBody } from './dto/update-task.dto';
import {
  ownRecurrenceOf,
  settle,
  type SeriesDays,
  type Settled,
} from './task-series';
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
   * Any date is accepted (TSK-05), past included. A task put on a day that
   * has already closed is settled at once, as the day-end job would have
   * settled it (decision 2): carried to today's general list with one
   * `incomplete` entry per closed day it passed through, or, if its series
   * comes round again first, recorded missed on the day before that
   * (REC-06). The response shows where it ended up. The series' other
   * closed-day occurrences are issued open when read, like any other day's.
   * Until the day-end job keeps its own record, "closed" means before today
   * in the user's time zone.
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
    }

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

    const today = await this.todayFor(caller);

    const created = await this.db.transaction(async (tx) => {
      const settled =
        body.date < today
          ? await this.settleClosed(
              tx,
              caller.userId,
              series && { ...series, endedOn: null },
              body.date,
              today,
            )
          : null;

      const { row, created } = await this.tasks.create(tx, {
        userId: caller.userId,
        blockSeriesId:
          settled !== null && settled.carryDays > 0
            ? // A carried task arrives on the next day's general list (TSK-06).
              null
            : (body.blockSeriesId ?? null),
        date: settled?.date ?? body.date,
        title: body.title,
        notes: body.notes ?? '',
        reminderDate: body.reminderAt?.date ?? null,
        reminderMin: body.reminderAt?.min ?? null,
        carryCount: settled?.carryDays ?? 0,
        missed: settled?.missed ?? false,
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
      if (settled !== null) {
        await this.recordSettled(tx, task, body.date, settled, today);
      }
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
        const done = await this.tasks.setDone(tx, found.id, true);
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

      const settled = await this.settleClosed(
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
      await this.recordSettled(tx, carried, found.date, settled, today);
      return { ...task, task: carried };
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
   * A stale `version` is a 409 carrying the task as it now is. A patch that
   * changes nothing returns the task without bumping `version`. A new title
   * reaches every day the task has recorded (decision 25). The task row is
   * locked for the write, then its series' row, so that rename and the
   * version check cannot interleave with another device's.
   *
   * It reads no user row, so a token whose account is gone gets the 404 its
   * vanished tasks give. It does not read the session (decision 16).
   */
  async update(
    caller: Caller,
    id: string,
    body: UpdateTaskBody,
  ): Promise<Task> {
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
   * caller's and fall on `date`.
   *
   * An occurrence of a repeating task splits off as a one-off, and its series
   * carries on where it was without it (TSK-03). A done task takes its
   * `completed` entry with it, so the day it now sits on is the day it
   * counts for. An open task moved onto a day that has
   * already closed is carried forward at once, as `create` carries one put
   * there (decision 2). Days it had already carried through keep the entry
   * they have.
   *
   * No `version`: the last write wins, and a real move bumps `version`.
   * Moving a task to where it already is changes nothing. It does not read
   * the session (decision 16).
   */
  async move(caller: Caller, id: string, body: MoveTaskBody): Promise<Task> {
    const today = await this.todayFor(caller);

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
        });
        await this.tasks.recordCompleted(tx, moved);
        return moved;
      }

      if (body.date >= today) {
        return this.tasks.move(tx, task.id, {
          ...body,
          carryDays: 0,
          splitOff: true,
        });
      }

      const carried = await this.tasks.move(tx, task.id, {
        date: today,
        blockSeriesId: null,
        carryDays: daysBetween(body.date, today),
        splitOff: true,
      });
      await this.tasks.recordIncomplete(
        tx,
        carried,
        body.date,
        addDays(today, -1),
      );
      return carried;
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
   * Where an open task on closed day `date` ends up (`settle`): its series'
   * next occurrence decides whether it carries to today or is missed first.
   */
  private async settleClosed(
    ex: Executor,
    userId: string,
    series: SeriesDays | null,
    date: string,
    today: string,
  ): Promise<Settled> {
    const next =
      series === null
        ? null
        : await this.series.nextAfter(ex, userId, series, date);
    return settle(date, today, next);
  }

  /**
   * The ledger for a task `settle`d from closed day `from`: `incomplete` on
   * each day it carried out of, and `missed` on the day it stopped, if it
   * was missed. `task` is the row as it now sits.
   */
  private async recordSettled(
    ex: Executor,
    task: TaskRow,
    from: string,
    settled: Settled,
    today: string,
  ): Promise<void> {
    if (!settled.missed) {
      await this.tasks.recordIncomplete(ex, task, from, addDays(today, -1));
      return;
    }
    if (settled.carryDays > 0) {
      await this.tasks.recordIncomplete(
        ex,
        task,
        from,
        addDays(settled.date, -1),
      );
    }
    await this.tasks.recordMissed(ex, task);
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
