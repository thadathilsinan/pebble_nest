import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotImplementedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { normaliseBlockName, tracesByName } from '../block-names/block-name';
import { BlockNamesRepository } from '../block-names/block-names.repository';
import {
  assertLongEnough,
  assertOccursOn,
  noOccurrence,
  type FoundOccurrence,
} from '../blocks/block-occurrence';
import {
  recurrenceOf,
  shapeOf,
  toBlockOccurrence,
  type BlockOccurrence,
  type OccurrenceException,
  type OccurrenceShape,
} from '../blocks/blocks.mapper';
import {
  BlocksRepository,
  type SeriesChanges,
} from '../blocks/blocks.repository';
import { firstOccurrenceOf } from '../blocks/blocks.service';
import { addDays, daysBetween } from '../calendar/local-date';
import {
  firstOccurrenceFrom,
  occursOn,
  resolveRecurrence,
  type Recurrence,
} from '../calendar/recurrence';
import { DB, type Db, type Executor } from '../core/database/database.module';
import type { BlockSeriesRow, TaskRow } from '../core/database/schema';
import type { ErrorCode } from '../core/http/error-code';
import { compareTasks, toTask } from '../tasks/tasks.mapper';
import { TasksRepository } from '../tasks/tasks.repository';
import { todayFor } from '../users/today';
import { UsersRepository } from '../users/users.repository';
import { BlockOccurrencesRepository } from './block-occurrences.repository';
import type { DeleteScope } from './dto/delete-occurrence.dto';
import type { UpdateOccurrenceBody } from './dto/update-occurrence.dto';

/**
 * `POST …/skip`'s and `DELETE …`'s body: what the UI tells the user moved.
 */
export interface MovedTasks {
  movedTaskCount: number;
}

@Injectable()
export class BlockOccurrencesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly occurrences: BlockOccurrencesRepository,
    private readonly blocks: BlocksRepository,
    private readonly tasks: TasksRepository,
    private readonly users: UsersRepository,
    private readonly names: BlockNamesRepository,
  ) {}

  /**
   * Edits the occurrence starting on `date` (`docs/api-plan.md` §4). A
   * block that doesn't repeat, or a series' first occurrence edited with
   * `thisAndFuture`, is the series itself, so the series is edited in place.
   * `onlyThis` on a repeating block overrides that occurrence alone.
   *
   * A stale `version` is a 409 carrying the occurrence as it is, checked
   * before which fields the scope accepts, since those depend on whether the
   * series repeats. A real change bumps the series' `version`; a patch that
   * changes nothing leaves it alone. The series row is locked for the write.
   * It does not read the session (decision 16).
   */
  async edit(
    caller: Caller,
    seriesId: string,
    date: string,
    body: UpdateOccurrenceBody,
  ): Promise<BlockOccurrence> {
    const today = todayFor(await this.users.findById(this.db, caller.userId));

    return this.db.transaction(async (tx) => {
      const found = await this.blocks.findOccurrence(
        tx,
        caller.userId,
        seriesId,
        date,
        { lock: true },
      );
      assertOccursOn(found, date);
      const { series, exception } = found;
      if (series.version !== body.version) {
        throw new ConflictException({
          code: 'STALE_VERSION' satisfies ErrorCode,
          message: 'The block was changed elsewhere. Re-apply and retry.',
          meta: {
            current: await this.occurrence(tx, series, date, exception),
          },
        });
      }

      const newDate = body.newDate === date ? undefined : body.newDate;
      const repeats = series.recurrenceKind !== 'none';
      if (
        !repeats ||
        (body.scope === 'thisAndFuture' && date === firstOccurrenceOf(series))
      ) {
        return this.editSeries(tx, found, date, { ...body, newDate }, today);
      }
      if (body.scope === 'onlyThis') {
        if (body.recurrence !== undefined) {
          throw invalid('Only this and all future ones can change the repeat.');
        }
        if (newDate !== undefined) throw editsNotYet();
        return this.override(tx, found, date, body);
      }
      if (newDate !== undefined) {
        throw invalid('Only this occurrence, or the first, can move.');
      }
      throw editsNotYet();
    });
  }

  /**
   * Skips one occurrence (BLK-07). Its open tasks move to that day's general
   * list, and its done tasks stay where they were done. An open task on a
   * day that has already closed is carried forward at once, as `/move`
   * carries one moved there (decision 26): to today's general list, with one
   * carry and one `incomplete` entry per closed day.
   *
   * No `version`: skipped is an absolute value, so the last write wins, and
   * skipping again moves whatever has arrived since, normally nothing. It
   * does not read the session (decision 16).
   */
  async skip(
    caller: Caller,
    seriesId: string,
    date: string,
  ): Promise<MovedTasks> {
    const today = todayFor(await this.users.findById(this.db, caller.userId));

    return this.db.transaction(async (tx) => {
      assertOccursOn(
        await this.blocks.findOccurrence(tx, caller.userId, seriesId, date, {
          lock: true,
        }),
        date,
      );
      await this.occurrences.skip(tx, caller.userId, seriesId, date);

      const open = await this.tasks.findOpenInOccurrenceForUpdate(
        tx,
        caller.userId,
        seriesId,
        date,
      );
      return { movedTaskCount: await this.toGeneralList(tx, open, today) };
    });
  }

  /**
   * Un-skips one occurrence (BLK-08). Tasks the skip moved stay where they
   * went. Un-skipping an occurrence that isn't skipped changes nothing.
   *
   * It reads no user row, so a token whose account is gone gets the 404 its
   * vanished series gives. It does not read the session (decision 16).
   */
  async unskip(caller: Caller, seriesId: string, date: string): Promise<void> {
    assertOccursOn(
      await this.blocks.findOccurrence(this.db, caller.userId, seriesId, date),
      date,
    );
    await this.occurrences.unskip(this.db, seriesId, date);
  }

  /**
   * Deletes one occurrence, or with `series` the whole series from today on
   * (decision 3) and the occurrence named too, even a past one (decision 29).
   * A block that doesn't repeat is deleted outright, whatever the scope.
   *
   * Every task, open and done, in a deleted occurrence moves to its own
   * day's general list (BLK-10), and an open one on a closed day carries on
   * to today's, as `skip` carries it. A series with no occurrence left before
   * today is deleted rather than ended.
   *
   * No `version`: the last write wins, and a retry finds the occurrence gone,
   * a 404. It does not read the session (decision 16).
   */
  async delete(
    caller: Caller,
    seriesId: string,
    date: string,
    scope: DeleteScope,
  ): Promise<MovedTasks> {
    const today = todayFor(await this.users.findById(this.db, caller.userId));

    return this.db.transaction(async (tx) => {
      const found = await this.blocks.findOccurrence(
        tx,
        caller.userId,
        seriesId,
        date,
        { lock: true },
      );
      assertOccursOn(found, date);
      const { series } = found;
      const repeats = series.recurrenceKind !== 'none';
      const wholeSeries = scope === 'series' && repeats;

      const tasks = await this.tasks.findInSeriesForUpdate(
        tx,
        caller.userId,
        seriesId,
        { date, from: wholeSeries ? today : undefined },
      );
      // Before the series goes, since its foreign key would only unset the
      // tasks' block, without a version bump or a carry.
      const movedTaskCount = await this.toGeneralList(tx, tasks, today);

      if (!repeats || (wholeSeries && !keepsHistory(series, date, today))) {
        await this.blocks.delete(tx, seriesId);
      } else if (!wholeSeries) {
        await this.occurrences.markDeleted(tx, caller.userId, seriesId, date);
      } else {
        await this.blocks.endBy(tx, seriesId, addDays(today, -1));
        if (date < today) {
          await this.occurrences.markDeleted(tx, caller.userId, seriesId, date);
        }
      }
      return { movedTaskCount };
    });
  }

  /**
   * Edits the series in place: every occurrence changes, past ones too, as
   * the app edits a series from its first occurrence.
   *
   * A `newDate` moves the anchor, taking the occurrence's tasks and its
   * exception row along (BLK-09); the rule must land on it. A new rule is
   * anchored on the occurrence, and the answer is its first occurrence, as
   * `POST /blocks` answers. Tasks in occurrences the new rule no longer has
   * go to their own day's general list, as a deleted occurrence's go.
   */
  private async editSeries(
    tx: Executor,
    { series, exception }: FoundOccurrence,
    date: string,
    body: UpdateOccurrenceBody,
    today: string,
  ): Promise<BlockOccurrence> {
    const { newDate } = body;
    const anchor = newDate ?? date;
    const recurrence =
      body.recurrence === undefined
        ? recurrenceOf(series)
        : resolveRecurrence(body.recurrence, anchor);
    if (recurrence.until !== null && recurrence.until < anchor) {
      throw invalid('The repeat cannot end before the block starts.');
    }
    const shape = patched(shapeOf(series), body);
    assertLongEnough(shape);

    const reruled = !sameRecurrence(recurrence, recurrenceOf(series));
    const anchorDate =
      newDate !== undefined || reruled ? anchor : series.anchorDate;
    if (newDate !== undefined && !occursOn(recurrence, newDate, newDate)) {
      throw new UnprocessableEntityException({
        code: 'BLOCK_NOT_ON_DATE' satisfies ErrorCode,
        message: 'The block does not fall on that date.',
      });
    }
    const first = firstOccurrenceFrom(recurrence, anchorDate, anchorDate);
    if (first === null) throw noOccurrence();

    const changes = seriesChanges(series, { ...shape, anchorDate }, recurrence);
    if (changes === undefined) {
      return this.occurrence(tx, series, date, exception);
    }
    const updated = await this.blocks.update(tx, series.id, changes);

    if (newDate !== undefined || reruled) {
      if (newDate !== undefined) {
        await this.occurrences.moveDate(tx, series.id, date, newDate);
      }
      const tasks = await this.tasks.findAllInSeriesForUpdate(
        tx,
        series.userId,
        series.id,
      );
      for (const task of tasks) {
        if (newDate !== undefined && task.date === date) {
          await this.place(
            tx,
            task,
            { date: newDate, blockSeriesId: series.id },
            today,
          );
        } else if (!occursOn(recurrence, anchorDate, task.date)) {
          await this.place(
            tx,
            task,
            { date: task.date, blockSeriesId: null },
            today,
          );
        }
      }
    }

    const answer = newDate ?? (reruled ? first : date);
    return this.occurrence(
      tx,
      updated,
      answer,
      await this.occurrences.find(tx, series.id, answer),
    );
  }

  /**
   * Overrides one occurrence of a repeating series with the patch. Each
   * override matching the series is stored as null, so it follows later
   * changes to the series. A real change bumps the series' `version`.
   */
  private async override(
    tx: Executor,
    { series, exception }: FoundOccurrence,
    date: string,
    body: UpdateOccurrenceBody,
  ): Promise<BlockOccurrence> {
    const before = shapeOf(series, exception);
    const after = patched(before, body);
    assertLongEnough(after);
    if (sameShape(before, after)) {
      return this.occurrence(tx, series, date, exception);
    }

    const row = await this.occurrences.override(
      tx,
      series.userId,
      series.id,
      date,
      {
        name: after.name === series.name ? null : after.name,
        startMin: after.startMin === series.startMin ? null : after.startMin,
        endMin: after.endMin === series.endMin ? null : after.endMin,
        alert: after.alert === series.alert ? null : after.alert,
      },
    );
    const bumped = await this.blocks.update(tx, series.id);
    return this.occurrence(tx, bumped, date, row);
  }

  /**
   * The occurrence of `series` starting on `date` in its wire shape, with
   * its tasks and the trace chosen for its name.
   */
  private async occurrence(
    ex: Executor,
    series: BlockSeriesRow,
    date: string,
    exception: OccurrenceException | null,
  ): Promise<BlockOccurrence> {
    const [taskRows, traces] = await Promise.all([
      this.tasks.findBetween(ex, series.userId, date, date),
      this.names.findTraces(ex, series.userId, [
        normaliseBlockName(shapeOf(series, exception).name),
      ]),
    ]);
    const tasks = taskRows
      .filter((task) => task.blockSeriesId === series.id)
      .map(toTask)
      .sort(compareTasks);
    return toBlockOccurrence(series, date, tracesByName(traces), {
      tasks,
      exception,
    });
  }

  /**
   * Moves `tasks`, locked by the caller, to the general list of the day each
   * sits on, and counts them, as `place` places each.
   */
  private async toGeneralList(
    tx: Executor,
    tasks: TaskRow[],
    today: string,
  ): Promise<number> {
    for (const task of tasks) {
      await this.place(
        tx,
        task,
        { date: task.date, blockSeriesId: null },
        today,
      );
    }
    return tasks.length;
  }

  /**
   * Puts `task`, locked by the caller, on `to`. A done task takes its
   * `completed` entry to its new day. An open task put on a day that has
   * closed carries on to today's general list instead, with one carry and
   * one `incomplete` entry per closed day, as `/move` carries one
   * (decision 26).
   */
  private async place(
    tx: Executor,
    task: TaskRow,
    to: { date: string; blockSeriesId: string | null },
    today: string,
  ): Promise<void> {
    if (task.done || to.date >= today) {
      const moved = await this.tasks.move(tx, task.id, {
        ...to,
        carryDays: 0,
      });
      if (task.done && to.date !== task.date) {
        await this.tasks.clearDay(tx, task.id, task.date);
        await this.tasks.recordCompleted(tx, moved);
      }
      return;
    }
    const carried = await this.tasks.move(tx, task.id, {
      date: today,
      blockSeriesId: null,
      carryDays: daysBetween(to.date, today),
    });
    await this.tasks.recordIncomplete(tx, carried, to.date, addDays(today, -1));
  }
}

/** `shape` with the fields `body` sets. */
function patched(
  shape: OccurrenceShape,
  body: UpdateOccurrenceBody,
): OccurrenceShape {
  return {
    name: body.name ?? shape.name,
    startMin: body.startMin ?? shape.startMin,
    endMin: body.endMin ?? shape.endMin,
    alert: body.alert ?? shape.alert,
  };
}

function sameShape(a: OccurrenceShape, b: OccurrenceShape): boolean {
  return (
    a.name === b.name &&
    a.startMin === b.startMin &&
    a.endMin === b.endMin &&
    a.alert === b.alert
  );
}

function sameRecurrence(a: Recurrence, b: Recurrence): boolean {
  return (
    a.kind === b.kind &&
    a.until === b.until &&
    a.weekdays.join() === b.weekdays.join() &&
    a.monthDays.join() === b.monthDays.join()
  );
}

/**
 * The columns an in-place edit changes, or `undefined` when it changes
 * nothing.
 */
function seriesChanges(
  series: BlockSeriesRow,
  next: OccurrenceShape & { anchorDate: string },
  recurrence: Recurrence,
): SeriesChanges | undefined {
  const changes: SeriesChanges = {};
  for (const key of [
    'name',
    'startMin',
    'endMin',
    'alert',
    'anchorDate',
  ] as const) {
    if (next[key] !== series[key]) Object.assign(changes, { [key]: next[key] });
  }
  if (!sameRecurrence(recurrence, recurrenceOf(series))) {
    Object.assign(changes, {
      recurrenceKind: recurrence.kind,
      weekdays: recurrence.weekdays,
      monthDays: recurrence.monthDays,
      until: recurrence.until,
    });
  }
  return Object.keys(changes).length > 0 ? changes : undefined;
}

function invalid(message: string): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_FAILED' satisfies ErrorCode,
    message,
  });
}

/** Splitting a series and moving one occurrence ship in the next commit. */
function editsNotYet(): NotImplementedException {
  return new NotImplementedException({
    code: 'NOT_IMPLEMENTED' satisfies ErrorCode,
    message: 'This edit is not available yet.',
  });
}

/**
 * Whether the series keeps an occurrence before today once the one on
 * `date` is deleted with the rest of the series.
 */
function keepsHistory(
  series: BlockSeriesRow,
  date: string,
  today: string,
): boolean {
  const recurrence = recurrenceOf(series);
  let first = firstOccurrenceFrom(
    recurrence,
    series.anchorDate,
    series.anchorDate,
  );
  if (first === date) {
    first = firstOccurrenceFrom(
      recurrence,
      series.anchorDate,
      addDays(date, 1),
    );
  }
  return first !== null && first < today;
}
