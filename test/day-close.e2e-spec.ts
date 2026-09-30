import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { MAILER, type Mailer } from '../src/auth/mailer/mailer';
import { addDays, todayIn } from '../src/calendar/local-date';
import { configureApp } from '../src/core/bootstrap/configure-app';
import { ENV } from '../src/core/config/config.module';
import type { Env } from '../src/core/config/env.schema';
import { POOL } from '../src/core/database/database.module';
import { DayCloseService } from '../src/tasks/day-close.service';

/** Captures what would have been emailed, instead of logging it. */
class FakeMailer implements Mailer {
  readonly sent: { email: string; code: string }[] = [];

  sendSignInCode(email: string, code: string): Promise<void> {
    this.sent.push({ email, code });
    return Promise.resolve();
  }

  lastCodeFor(email: string): string {
    const code = this.sent.filter((m) => m.email === email).at(-1)?.code;
    if (code === undefined) throw new Error(`no code sent to ${email}`);
    return code;
  }
}

type Task = { id: string; date: string; blockSeriesId: string | null };

/** Zones 25 hours apart, so their calendar dates always differ. */
const AHEAD = 'Pacific/Kiritimati';
const BEHIND = 'Pacific/Pago_Pago';

/**
 * The day-end close, called directly. Days pass by moving what the user
 * has back in time with SQL, since the clock can't be.
 */
describe('Day-end close (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let mailer: FakeMailer;
  let dayClose: DayCloseService;
  let accessToken: string;
  let userId: string;
  /** Today for the user, who has reported no zone and so reads UTC. */
  let today: string;

  beforeEach(async () => {
    mailer = new FakeMailer();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();

    // Mirrors `main.ts`; see the note in auth.e2e-spec.ts.
    app = moduleFixture.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, moduleFixture.get<Env>(ENV));
    await app.init();

    pool = moduleFixture.get<Pool>(POOL);
    dayClose = moduleFixture.get(DayCloseService);
    await pool.query(
      'TRUNCATE users, sessions, session_refresh_tokens, email_sign_in_codes, block_series, tasks, task_ledger_entries RESTART IDENTITY CASCADE',
    );
    accessToken = await signIn('me@example.com');
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM users');
    userId = rows[0]!.id;
    today = todayIn('UTC');
  });

  afterEach(async () => {
    await app.close();
  });

  function http() {
    return request(app.getHttpServer());
  }

  async function signIn(email: string): Promise<string> {
    await http().post('/api/v1/auth/email/code').send({ email }).expect(204);
    const res = await http()
      .post('/api/v1/auth/email/verify')
      .send({ email, code: mailer.lastCodeFor(email) })
      .expect(200);
    return (res.body as { data: { accessToken: string } }).data.accessToken;
  }

  async function createTask(body: object): Promise<Task> {
    const res = await http()
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body)
      .expect(201);
    return (res.body as { data: Task }).data;
  }

  async function postBlock(body: object): Promise<string> {
    const res = await http()
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'Deep work',
        startMin: 540,
        endMin: 600,
        alert: false,
        ...body,
      })
      .expect(201);
    return (res.body as { data: { seriesId: string } }).data.seriesId;
  }

  /**
   * Moves everything the user has `days` back in time, as though it had
   * been made that many days ago and nothing had run since, and sets how
   * far their days have closed.
   */
  async function travelBack(days: number, closedThrough: string | null) {
    await pool.query(
      `UPDATE block_series SET anchor_date = anchor_date - $1::int;
       UPDATE task_series SET anchor_date = anchor_date - $1::int;
       UPDATE task_series_issued_dates SET date = date - $1::int;
       UPDATE tasks SET date = date - $1::int;`.replaceAll('$1', String(days)),
    );
    await setClosedThrough(closedThrough);
  }

  async function setClosedThrough(day: string | null) {
    await pool.query('UPDATE users SET closed_through = $1', [day]);
  }

  async function closedThrough(): Promise<string | null> {
    const { rows } = await pool.query<{ day: string | null }>(
      "SELECT to_char(closed_through, 'YYYY-MM-DD') AS day FROM users",
    );
    return rows[0]!.day;
  }

  async function taskRows() {
    const { rows } = await pool.query<{
      id: string;
      date: string;
      blockSeriesId: string | null;
      carryCount: number;
      missed: boolean;
      done: boolean;
      version: number;
    }>(
      `SELECT id, to_char(date, 'YYYY-MM-DD') AS date,
         block_series_id AS "blockSeriesId", carry_count AS "carryCount",
         missed, done, version
       FROM tasks ORDER BY date, id`,
    );
    return rows;
  }

  async function ledger(): Promise<{ day: string; outcome: string }[]> {
    const { rows } = await pool.query<{ day: string; outcome: string }>(
      "SELECT to_char(day, 'YYYY-MM-DD') AS day, outcome FROM task_ledger_entries ORDER BY day, outcome",
    );
    return rows;
  }

  it('carries an open one-off to today’s general list, recording each day it sat through', async () => {
    const seriesId = await postBlock({ date: today });
    const task = await createTask({
      title: 'A',
      date: today,
      blockSeriesId: seriesId,
    });
    await travelBack(3, addDays(today, -4));

    expect(await dayClose.close(userId)).toEqual({
      closedThrough: addDays(today, -1),
      timeZone: 'UTC',
    });

    expect(await taskRows()).toMatchObject([
      {
        id: task.id,
        date: today,
        blockSeriesId: null,
        carryCount: 3,
        missed: false,
        version: 1,
      },
    ]);
    expect(await ledger()).toEqual(
      [3, 2, 1].map((n) => ({
        day: addDays(today, -n),
        outcome: 'incomplete',
      })),
    );
    expect(await closedThrough()).toBe(addDays(today, -1));
  });

  it('leaves done tasks where they are', async () => {
    const task = await createTask({ title: 'A', date: today });
    await http()
      .patch(`/api/v1/tasks/${task.id}/done`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ done: true })
      .expect(200);
    await travelBack(2, null);

    await dayClose.close(userId);

    expect(await taskRows()).toMatchObject([
      { date: addDays(today, -2), carryCount: 0, done: true },
    ]);
  });

  it('issues a daily task’s occurrences for days nobody read, each missed on its own day', async () => {
    await createTask({
      title: 'A',
      date: today,
      recurrence: { kind: 'daily' },
    });
    await travelBack(3, addDays(today, -4));

    await dayClose.close(userId);

    expect(await taskRows()).toMatchObject(
      [3, 2, 1].map((n) => ({
        date: addDays(today, -n),
        carryCount: 0,
        missed: true,
      })),
    );
    expect(await ledger()).toEqual(
      [3, 2, 1].map((n) => ({ day: addDays(today, -n), outcome: 'missed' })),
    );
  });

  it('settles every day before today on the first close', async () => {
    await createTask({ title: 'A', date: today });
    await createTask({
      title: 'B',
      date: today,
      recurrence: { kind: 'daily' },
    });
    await travelBack(2, null);

    await dayClose.close(userId);

    expect(await taskRows()).toMatchObject([
      { date: addDays(today, -2), missed: true },
      { date: addDays(today, -1), missed: true },
      { date: today, carryCount: 2, missed: false },
    ]);
    expect(await closedThrough()).toBe(addDays(today, -1));
  });

  it('settles a task left open on a day closed before, as a read leaves one', async () => {
    await createTask({
      title: 'A',
      date: today,
      recurrence: { kind: 'daily' },
    });
    // Its first occurrence sits open on a day already closed, as one issued
    // by reading that day does (decision 35).
    await travelBack(3, addDays(today, -2));

    await dayClose.close(userId);

    // Only the day this close covers issues its occurrence.
    expect(await taskRows()).toMatchObject([
      { date: addDays(today, -3), missed: true },
      { date: addDays(today, -1), missed: true },
    ]);
  });

  it('closes nothing twice', async () => {
    await createTask({ title: 'A', date: today });
    await travelBack(2, null);

    await dayClose.close(userId);
    const once = { tasks: await taskRows(), ledger: await ledger() };
    await dayClose.close(userId);

    expect({ tasks: await taskRows(), ledger: await ledger() }).toEqual(once);
  });

  it('closes once when requests arrive together', async () => {
    await createTask({ title: 'A', date: today });
    await createTask({
      title: 'B',
      date: today,
      recurrence: { kind: 'daily' },
    });
    await travelBack(3, null);

    await Promise.all([1, 2, 3, 4].map(() => dayClose.close(userId)));

    expect(await taskRows()).toMatchObject([
      { date: addDays(today, -3), missed: true },
      { date: addDays(today, -2), missed: true },
      { date: addDays(today, -1), missed: true },
      { date: today, carryCount: 3, missed: false },
    ]);
    expect(await ledger()).toHaveLength(6);
  });

  it('never closes a day again after travel west', async () => {
    await pool.query('UPDATE users SET time_zone = $1', [BEHIND]);
    const behindToday = todayIn(BEHIND);
    await createTask({ title: 'A', date: addDays(behindToday, 1) });
    // Days closed through the day before today where it is furthest ahead,
    // which is on or after today here.
    await pool.query('UPDATE tasks SET date = $1', [addDays(behindToday, -1)]);
    await setClosedThrough(addDays(todayIn(AHEAD), -1));

    expect(await dayClose.close(userId)).toEqual({
      closedThrough: addDays(todayIn(AHEAD), -1),
      timeZone: BEHIND,
    });
    expect(await taskRows()).toMatchObject([
      { date: addDays(behindToday, -1), carryCount: 0 },
    ]);
  });

  it('is null for an account that is gone', async () => {
    await pool.query('DELETE FROM users');

    expect(await dayClose.close(userId)).toBeNull();
  });
});
