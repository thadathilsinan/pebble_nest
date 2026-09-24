import { Inject, Injectable } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { DB, type Db } from '../core/database/database.module';
import { DaysService } from '../days/days.service';
import { toTask, type Task } from '../tasks/tasks.mapper';
import { TasksRepository } from '../tasks/tasks.repository';
import { nowFor } from '../users/today';
import { UsersRepository } from '../users/users.repository';
import { reviewHours, type ReviewHours } from './review-hours';

/** DSH-05: how many tasks "most carried over" lists. */
const MOST_CARRIED_LIMIT = 5;

/** `Review` in `docs/api-plan.md` §8. */
export interface Review extends ReviewHours {
  from: string;
  to: string;
  completed: number;
  /** Carried over and missed (DSH-02). */
  incomplete: number;
  /** Null when the period recorded nothing (DSH-03). */
  completionRate: number | null;
  mostCarried: Task[];
}

@Injectable()
export class ReviewService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly days: DaysService,
    private readonly tasks: TasksRepository,
    private readonly users: UsersRepository,
  ) {}

  /**
   * The review of `from` to `to`, both included. It reads the user for the
   * time zone that says how much of today has passed, so a deleted account's
   * token gets a 401. It does not read the session (decision 16).
   *
   * The range has no cap, so the blocks are laid out only from the user's
   * first record to today: nothing starts before the one, and nothing after
   * the other counts. The minutes that passed are still those of the whole
   * range.
   */
  async review(caller: Caller, from: string, to: string): Promise<Review> {
    const [user, record, counts, carried] = await Promise.all([
      this.users.findById(this.db, caller.userId),
      this.users.findRecordStart(this.db, caller.userId),
      this.tasks.countLedgerBetween(this.db, caller.userId, from, to),
      this.tasks.findMostCarried(
        this.db,
        caller.userId,
        from,
        to,
        MOST_CARRIED_LIMIT,
      ),
    ]);
    const now = nowFor(user);

    const first = record.firstRecordedDay;
    const start = first !== null && first > from ? first : from;
    const end = to < now.date ? to : now.date;
    const days =
      first !== null && start <= end
        ? await this.days.listBlocks(caller, start, end)
        : [];

    const recorded = counts.completed + counts.incomplete;
    return {
      from,
      to,
      completed: counts.completed,
      incomplete: counts.incomplete,
      completionRate: recorded === 0 ? null : counts.completed / recorded,
      ...reviewHours({ from, to }, days, now),
      mostCarried: carried.map(toTask),
    };
  }
}
