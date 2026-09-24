import {
  BlocksRepository,
  type NewBlockSeries,
} from '../blocks/blocks.repository';
import { openTestDatabase, type TestDatabase } from '../core/database/testing';
import { UsersRepository } from '../users/users.repository';
import { BlockNamesRepository } from './block-names.repository';

describe('BlockNamesRepository (integration)', () => {
  let t: TestDatabase;
  const repo = new BlockNamesRepository();
  const blocks = new BlocksRepository();
  const users = new UsersRepository();

  beforeAll(async () => {
    t = await openTestDatabase();
  });
  beforeEach(() => t.truncate('users', 'block_series', 'block_name_traces'));
  afterAll(() => t.close());

  async function newUser(email = 'me@example.com'): Promise<string> {
    return (await users.findOrCreateByEmail(t.db, email)).row.id;
  }

  function block(userId: string, name: string) {
    return blocks.create(t.db, {
      userId,
      name,
      anchorDate: '2026-09-24',
      startMin: 540,
      endMin: 720,
      recurrenceKind: 'none',
      weekdays: [],
      monthDays: [],
      until: null,
      alert: false,
    } satisfies NewBlockSeries);
  }

  describe('findNamesByRecentUse', () => {
    it('lists each name once, most recently used first, in its latest spelling', async () => {
      const userId = await newUser();
      await block(userId, 'gym');
      await block(userId, 'Deep work');
      await block(userId, 'Family');
      await block(userId, 'Gym');
      await block(await newUser('them@example.com'), 'Theirs');

      expect(await repo.findNamesByRecentUse(t.db, userId)).toEqual([
        'Gym',
        'Family',
        'Deep work',
      ]);
    });

    it('is empty for a user with no blocks', async () => {
      expect(await repo.findNamesByRecentUse(t.db, await newUser())).toEqual(
        [],
      );
    });
  });

  describe('traces', () => {
    it('sets, replaces and clears a name’s trace', async () => {
      const userId = await newUser();

      await repo.setTrace(t.db, userId, 'family', 'grid');
      await repo.setTrace(t.db, userId, 'family', 'dotted');
      await repo.setTrace(t.db, userId, 'gym', 'ruled');
      expect(await repo.findTraces(t.db, userId)).toEqual(
        expect.arrayContaining([
          { nameKey: 'family', trace: 'dotted' },
          { nameKey: 'gym', trace: 'ruled' },
        ]),
      );

      await repo.clearTrace(t.db, userId, 'family');
      expect(await repo.findTraces(t.db, userId)).toEqual([
        { nameKey: 'gym', trace: 'ruled' },
      ]);
    });

    it('reads only the names asked for, and only the owner’s', async () => {
      const userId = await newUser();
      await repo.setTrace(t.db, userId, 'family', 'grid');
      await repo.setTrace(t.db, userId, 'gym', 'ruled');
      await repo.setTrace(
        t.db,
        await newUser('them@example.com'),
        'family',
        'solid',
      );

      expect(await repo.findTraces(t.db, userId, ['family'])).toEqual([
        { nameKey: 'family', trace: 'grid' },
      ]);
    });

    it('clearing a name with no choice changes nothing', async () => {
      await repo.clearTrace(t.db, await newUser(), 'family');
    });

    it('goes with its user', async () => {
      const userId = await newUser();
      await repo.setTrace(t.db, userId, 'family', 'grid');

      await users.deleteById(t.db, userId);

      const { rows } = await t.pool.query('SELECT 1 FROM block_name_traces');
      expect(rows).toHaveLength(0);
    });

    it.each([
      ['ck_block_name_traces_name_key_length', ' padded', 'grid'],
      ['ck_block_name_traces_name_key_length', 'x'.repeat(61), 'grid'],
      ['ck_block_name_traces_trace', 'family', 'open'],
    ])('%s rejects %j with %s', async (constraint, nameKey, trace) => {
      const userId = await newUser();

      await expect(
        // @ts-expect-error -- `open` is not a trace a user can choose.
        repo.setTrace(t.db, userId, nameKey, trace),
      ).rejects.toMatchObject({ cause: { constraint } });
    });
  });
});
