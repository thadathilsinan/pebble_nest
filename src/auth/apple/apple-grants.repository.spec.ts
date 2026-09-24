import {
  openTestDatabase,
  type TestDatabase,
} from '../../core/database/testing';
import { UsersRepository } from '../../users/users.repository';
import { AppleGrantsRepository } from './apple-grants.repository';

describe('AppleGrantsRepository (integration)', () => {
  let t: TestDatabase;
  const repo = new AppleGrantsRepository();
  const users = new UsersRepository();

  beforeAll(async () => {
    t = await openTestDatabase();
  });
  beforeEach(() => t.truncate('users', 'apple_grants'));
  afterAll(() => t.close());

  async function newUser(email = 'me@example.com'): Promise<string> {
    return (await users.findOrCreateByEmail(t.db, email)).row.id;
  }

  it('finds nothing for an account that never signed in with Apple', async () => {
    expect(await repo.findByUserId(t.db, await newUser())).toBeNull();
  });

  it('stores a grant and replaces it on the next Apple sign-in', async () => {
    const userId = await newUser();
    const other = await newUser('them@example.com');
    await repo.save(t.db, userId, 'com.pebble.app', 'first');
    await repo.save(t.db, other, 'com.pebble.app', 'theirs');

    await repo.save(t.db, userId, 'com.pebble.app.dev', 'second');

    expect(await repo.findByUserId(t.db, userId)).toEqual({
      clientId: 'com.pebble.app.dev',
      refreshToken: 'second',
    });
    expect(await repo.findByUserId(t.db, other)).toMatchObject({
      refreshToken: 'theirs',
    });
  });

  it('goes with its account', async () => {
    const userId = await newUser();
    await repo.save(t.db, userId, 'com.pebble.app', 'token');

    await users.deleteById(t.db, userId);

    const { rows } = await t.pool.query('SELECT 1 FROM apple_grants');
    expect(rows).toHaveLength(0);
  });
});
