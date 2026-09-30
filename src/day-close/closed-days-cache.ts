import type { ClosedState } from '../tasks/day-close.service';

/**
 * How far each user's days have closed, as last seen, for at most
 * `maxUsers` users. Past that the least recently used entry is dropped.
 *
 * Only a shortcut: an entry saves reading the user row on a request with no
 * new day to close, and a missing or dropped one costs that read and no
 * more. So it may be forgotten at any time, and another instance's writes
 * needn't reach it: `closed_through` in the database is what counts.
 *
 * A `Map` iterates in insertion order, so re-inserting on each hit keeps the
 * least recently used entry first.
 */
export class ClosedDaysCache {
  private readonly entries = new Map<string, ClosedState>();

  constructor(private readonly maxUsers: number) {}

  get(userId: string): ClosedState | undefined {
    const state = this.entries.get(userId);
    if (state === undefined) return undefined;
    this.entries.delete(userId);
    this.entries.set(userId, state);
    return state;
  }

  set(userId: string, state: ClosedState): void {
    this.entries.delete(userId);
    this.entries.set(userId, state);
    if (this.entries.size > this.maxUsers) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** Forgets the user, as when their time zone changes. */
  delete(userId: string): void {
    this.entries.delete(userId);
  }

  get size(): number {
    return this.entries.size;
  }
}
