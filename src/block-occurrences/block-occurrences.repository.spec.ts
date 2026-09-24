import { BlocksRepository } from '../blocks/blocks.repository';
import { blockOccurrenceExceptions } from '../core/database/schema';
import { openTestDatabase, type TestDatabase } from '../core/database/testing';
import { UsersRepository } from '../users/users.repository';
import { BlockOccurrencesRepository } from './block-occurrences.repository';

describe('BlockOccurrencesRepository (integration)', () => {
  let t: TestDatabase;
  const repo = new BlockOccurrencesRepository();
  const users = new UsersRepository();
  const blocks = new BlocksRepository();

  beforeAll(async () => {
    t = await openTestDatabase();
  });
  beforeEach(() =>
    t.truncate('users', 'block_series', 'block_occurrence_exceptions'),
  );
  afterAll(() => t.close());

  async function newUser(email = 'me@example.com'): Promise<string> {
    return (await users.findOrCreateByEmail(t.db, email)).row.id;
  }

  async function newSeries(userId: string): Promise<string> {
    const { row } = await blocks.create(t.db, {
      userId,
      name: 'Deep work',
      anchorDate: '2026-09-24',
      startMin: 540,
      endMin: 720,
      recurrenceKind: 'daily',
      weekdays: [],
      monthDays: [],
      until: null,
      alert: false,
    });
    return row.id;
  }

  function skippedDates(
    userId: string,
    from = '2026-01-01',
    to = '2026-12-31',
  ) {
    return repo.findBetween(t.db, userId, from, to).then((rows) =>
      rows
        .filter((row) => row.skipped)
        .map((row) => row.date)
        .sort(),
    );
  }

  it('skips an occurrence, and a second skip keeps one row', async () => {
    const userId = await newUser();
    const seriesId = await newSeries(userId);

    await repo.skip(t.db, userId, seriesId, '2026-09-25');
    await repo.skip(t.db, userId, seriesId, '2026-09-25');

    expect(await skippedDates(userId)).toEqual(['2026-09-25']);
    const rows = await t.db.select().from(blockOccurrenceExceptions);
    expect(rows).toHaveLength(1);
  });

  it('un-skips by removing the row, and un-skipping again is harmless', async () => {
    const userId = await newUser();
    const seriesId = await newSeries(userId);
    await repo.skip(t.db, userId, seriesId, '2026-09-25');

    await repo.unskip(t.db, seriesId, '2026-09-25');
    await repo.unskip(t.db, seriesId, '2026-09-25');

    expect(await skippedDates(userId)).toEqual([]);
  });

  it('reads skipped occurrences in the range, ends included, for one user', async () => {
    const userId = await newUser();
    const other = await newUser('other@example.com');
    const seriesId = await newSeries(userId);
    const otherSeries = await newSeries(other);
    for (const date of ['2026-09-24', '2026-09-26', '2026-09-28']) {
      await repo.skip(t.db, userId, seriesId, date);
    }
    await repo.skip(t.db, other, otherSeries, '2026-09-26');

    expect(await skippedDates(userId, '2026-09-24', '2026-09-26')).toEqual([
      '2026-09-24',
      '2026-09-26',
    ]);
  });

  it('marks an occurrence deleted, keeping its skip, and un-skip leaves it', async () => {
    const userId = await newUser();
    const seriesId = await newSeries(userId);
    await repo.skip(t.db, userId, seriesId, '2026-09-25');

    await repo.markDeleted(t.db, userId, seriesId, '2026-09-25');
    await repo.markDeleted(t.db, userId, seriesId, '2026-09-26');
    await repo.unskip(t.db, seriesId, '2026-09-25');

    const rows = await repo.findBetween(
      t.db,
      userId,
      '2026-09-25',
      '2026-09-26',
    );
    expect(
      rows
        .map(({ date, skipped, deleted }) => ({ date, skipped, deleted }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    ).toEqual([
      { date: '2026-09-25', skipped: true, deleted: true },
      { date: '2026-09-26', skipped: false, deleted: true },
    ]);
  });

  it('goes with its series', async () => {
    const userId = await newUser();
    const seriesId = await newSeries(userId);
    await repo.skip(t.db, userId, seriesId, '2026-09-25');

    await t.pool.query('DELETE FROM block_series');

    expect(await skippedDates(userId)).toEqual([]);
  });
});
