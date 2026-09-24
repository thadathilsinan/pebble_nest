import { openTestDatabase, type TestDatabase } from '../core/database/testing';
import { UsersRepository } from '../users/users.repository';
import { BlocksRepository, type NewBlockSeries } from './blocks.repository';

describe('BlocksRepository (integration)', () => {
  let t: TestDatabase;
  const repo = new BlocksRepository();
  const users = new UsersRepository();

  beforeAll(async () => {
    t = await openTestDatabase();
  });
  beforeEach(() => t.truncate('users', 'block_series'));
  afterAll(() => t.close());

  async function newUser(email = 'me@example.com'): Promise<string> {
    return (await users.findOrCreateByEmail(t.db, email)).row.id;
  }

  function block(userId: string, extra: Partial<NewBlockSeries> = {}) {
    return {
      userId,
      name: 'Deep work',
      anchorDate: '2026-09-24',
      startMin: 540,
      endMin: 720,
      recurrenceKind: 'none',
      weekdays: [],
      monthDays: [],
      until: null,
      alert: false,
      ...extra,
    } satisfies NewBlockSeries;
  }

  it('creates a series at version 0', async () => {
    const userId = await newUser();

    const { row, created } = await repo.create(t.db, block(userId));

    expect(created).toBe(true);
    expect(row).toMatchObject({ userId, name: 'Deep work', version: 0 });
  });

  it('creates any number of series without a key', async () => {
    const userId = await newUser();

    const a = await repo.create(t.db, block(userId));
    const b = await repo.create(t.db, block(userId));

    expect(a.row.id).not.toBe(b.row.id);
  });

  it('returns the original series for a repeated key', async () => {
    const userId = await newUser();
    const key = '0192a000-0000-7000-8000-000000000001';

    const first = await repo.create(
      t.db,
      block(userId, { idempotencyKey: key }),
    );
    const again = await repo.create(
      t.db,
      block(userId, { idempotencyKey: key, name: 'Something else' }),
    );

    expect(again.created).toBe(false);
    expect(again.row).toEqual(first.row);
  });

  it('creates exactly one series when two retries race', async () => {
    const userId = await newUser();
    const key = '0192a000-0000-7000-8000-000000000002';

    const results = await Promise.all([
      t.db.transaction((tx) =>
        repo.create(tx, block(userId, { idempotencyKey: key })),
      ),
      t.db.transaction((tx) =>
        repo.create(tx, block(userId, { idempotencyKey: key })),
      ),
    ]);

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[0].row.id).toBe(results[1].row.id);
  });

  it('scopes keys to their owner', async () => {
    const key = '0192a000-0000-7000-8000-000000000003';
    const mine = await repo.create(
      t.db,
      block(await newUser('me@example.com'), { idempotencyKey: key }),
    );
    const theirs = await repo.create(
      t.db,
      block(await newUser('them@example.com'), { idempotencyKey: key }),
    );

    expect(theirs.created).toBe(true);
    expect(theirs.row.id).not.toBe(mine.row.id);
  });

  it('goes with its user', async () => {
    const userId = await newUser();
    await repo.create(t.db, block(userId));

    await users.deleteById(t.db, userId);

    const { rows } = await t.pool.query('SELECT 1 FROM block_series');
    expect(rows).toHaveLength(0);
  });

  describe('findActiveBetween', () => {
    it('returns the owner’s series begun by `to` and not ended before `from`', async () => {
      const userId = await newUser();
      const other = await newUser('them@example.com');
      const daily = { recurrenceKind: 'daily' as const };

      const inRange = await repo.create(t.db, block(userId));
      const endsOnFrom = await repo.create(
        t.db,
        block(userId, {
          ...daily,
          anchorDate: '2026-09-01',
          until: '2026-09-20',
        }),
      );
      const endless = await repo.create(
        t.db,
        block(userId, { ...daily, anchorDate: '2026-01-01' }),
      );
      await repo.create(t.db, block(userId, { anchorDate: '2026-09-26' }));
      await repo.create(
        t.db,
        block(userId, {
          ...daily,
          anchorDate: '2026-09-01',
          until: '2026-09-19',
        }),
      );
      await repo.create(t.db, block(other));

      const rows = await repo.findActiveBetween(
        t.db,
        userId,
        '2026-09-20',
        '2026-09-25',
      );

      expect(rows.map((r) => r.id).sort()).toEqual(
        [inRange.row.id, endsOnFrom.row.id, endless.row.id].sort(),
      );
    });
  });

  describe('check constraints', () => {
    it.each([
      ['ck_block_series_min_length', { startMin: 600, endMin: 603 }],
      ['ck_block_series_min_length', { startMin: 1438, endMin: 1 }],
      ['ck_block_series_name_length', { name: ' padded ' }],
      ['ck_block_series_weekdays', { recurrenceKind: 'weekly' as const }],
      ['ck_block_series_weekdays', { weekdays: [1] }],
      [
        'ck_block_series_weekdays',
        { recurrenceKind: 'weekly' as const, weekdays: [8] },
      ],
      ['ck_block_series_month_days', { recurrenceKind: 'monthly' as const }],
      [
        'ck_block_series_month_days',
        { recurrenceKind: 'monthly' as const, monthDays: [32] },
      ],
      ['ck_block_series_until', { until: '2026-12-31' }],
      [
        'ck_block_series_until',
        { recurrenceKind: 'daily' as const, until: '2026-09-23' },
      ],
    ])('%s rejects %j', async (constraint, extra) => {
      const userId = await newUser();

      await expect(
        repo.create(t.db, block(userId, extra)),
      ).rejects.toMatchObject({ cause: { constraint } });
    });

    it('accepts a full-day block and a midnight crossing', async () => {
      const userId = await newUser();

      await repo.create(t.db, block(userId, { startMin: 540, endMin: 540 }));
      await repo.create(t.db, block(userId, { startMin: 1350, endMin: 30 }));
    });
  });
});
