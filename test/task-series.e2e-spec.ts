import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { MAILER, type Mailer } from '../src/auth/mailer/mailer';
import { addDays, isoWeekday, todayIn } from '../src/calendar/local-date';
import { configureApp } from '../src/core/bootstrap/configure-app';
import { ENV } from '../src/core/config/config.module';
import type { Env } from '../src/core/config/env.schema';
import { POOL } from '../src/core/database/database.module';

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

type Task = {
  id: string;
  version: number;
  title: string;
  date: string;
  blockSeriesId: string | null;
  done: boolean;
  doneAt: string | null;
  carryCount: number;
  missed: boolean;
  notes: string;
  reminderAt: string | null;
  repeat: {
    mode: 'withBlock' | 'own';
    recurrence: { kind: string } | null;
  } | null;
};
type Occurrence = {
  seriesId: string;
  date: string;
  continuedFromPreviousDay: boolean;
  tasks: Task[];
  openCount: number;
  totalCount: number;
};
type Day = { date: string; blocks: Occurrence[]; generalList: Task[] };
type Failure = { error: { code: string } };

/** A zone whose date is at or ahead of every other's. */
const AHEAD = 'Pacific/Kiritimati';

describe('Repeating tasks (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let mailer: FakeMailer;
  let accessToken: string;
  /** A day that has not closed for a user with no zone yet, who reads UTC. */
  let future: string;

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
    await pool.query(
      'TRUNCATE users, sessions, session_refresh_tokens, email_sign_in_codes, block_series, tasks, task_ledger_entries RESTART IDENTITY CASCADE',
    );
    accessToken = await signIn('me@example.com');
    future = addDays(todayIn('UTC'), 3);
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

  function postTask(body: object, token = accessToken) {
    return http()
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  async function createTask(body: object, token = accessToken) {
    const res = await postTask(body, token).expect(201);
    return (res.body as { data: Task }).data;
  }

  async function postBlock(body: object, token = accessToken) {
    const res = await http()
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${token}`)
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

  async function getDay(date: string, token = accessToken): Promise<Day> {
    const res = await http()
      .get(`/api/v1/days/${date}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return (res.body as { data: Day }).data;
  }

  async function setTimeZone(timeZone: string) {
    await http()
      .patch('/api/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ timeZone })
      .expect(200);
  }

  async function ledger(): Promise<{ day: string; outcome: string }[]> {
    const { rows } = await pool.query<{ day: string; outcome: string }>(
      "SELECT to_char(day, 'YYYY-MM-DD') AS day, outcome FROM task_ledger_entries ORDER BY day",
    );
    return rows;
  }

  function codeOf(body: unknown): string {
    return (body as Failure).error.code;
  }

  function authed<T extends { set: (k: string, v: string) => T }>(req: T) {
    return req.set('Authorization', `Bearer ${accessToken}`);
  }

  async function setDone(id: string, done: boolean): Promise<Task> {
    const res = await authed(http().patch(`/api/v1/tasks/${id}/done`))
      .send({ done })
      .expect(200);
    return (res.body as { data: Task }).data;
  }

  async function seriesCount(): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM task_series',
    );
    return rows[0]!.n;
  }

  /** Every task on `date`, in blocks and on the general list. */
  async function tasksOn(date: string): Promise<Task[]> {
    const day = await getDay(date);
    return [
      ...day.blocks
        .filter((b) => !b.continuedFromPreviousDay)
        .flatMap((b) => b.tasks),
      ...day.generalList,
    ];
  }

  it('creates a task repeating on its own and issues its later occurrences as they are read', async () => {
    const task = await createTask({
      title: 'Water plants',
      date: future,
      notes: 'The ones by the window',
      reminderAt: `${addDays(future, 1)}T08:30`,
      recurrence: { kind: 'weekly' },
    });

    expect(task).toMatchObject({
      date: future,
      repeat: {
        mode: 'own',
        recurrence: {
          kind: 'weekly',
          weekdays: [isoWeekday(future)],
          monthDays: [],
          until: null,
        },
      },
    });
    expect(await tasksOn(addDays(future, 1))).toEqual([]);

    const next = addDays(future, 7);
    const copy = (await tasksOn(next))[0]!;
    expect(copy).toMatchObject({
      date: next,
      blockSeriesId: null,
      title: 'Water plants',
      notes: 'The ones by the window',
      reminderAt: `${addDays(next, 1)}T08:30`,
      done: false,
      repeat: task.repeat,
    });
    expect(copy.id).not.toBe(task.id);
  });

  it('keeps an anchor the rule does not land on as the first occurrence', async () => {
    const date = future;
    const weekday = (isoWeekday(date) % 7) + 1; // the day after `date`'s

    const task = await createTask({
      title: 'A',
      date,
      recurrence: { kind: 'weekly', weekdays: [weekday] },
    });

    expect(await tasksOn(date)).toEqual([task]);
    expect(await tasksOn(addDays(date, 1))).toMatchObject([{ title: 'A' }]);
    expect(await tasksOn(addDays(date, 2))).toEqual([]);
  });

  it('repeats a task with its block, in each of its occurrences', async () => {
    const seriesId = await postBlock({
      date: future,
      recurrence: { kind: 'daily' },
    });

    const task = await createTask({
      title: 'Stretch',
      date: future,
      blockSeriesId: seriesId,
      repeatWithBlock: true,
    });

    expect(task.repeat).toEqual({ mode: 'withBlock', recurrence: null });
    const day = await getDay(addDays(future, 2));
    expect(day.blocks[0]!.tasks).toMatchObject([
      {
        title: 'Stretch',
        blockSeriesId: seriesId,
        date: addDays(future, 2),
        repeat: { mode: 'withBlock', recurrence: null },
      },
    ]);
    expect(day.generalList).toEqual([]);
  });

  it('issues each occurrence once, however often or at once it is read', async () => {
    await createTask({
      title: 'A',
      date: future,
      recurrence: { kind: 'daily' },
    });
    const date = addDays(future, 3);

    await Promise.all([getDay(date), getDay(date), getDay(date)]);
    await getDay(date);

    expect(await tasksOn(date)).toHaveLength(1);
  });

  it('never issues an occurrence again once it is deleted', async () => {
    await createTask({
      title: 'A',
      date: future,
      recurrence: { kind: 'daily' },
    });
    const date = addDays(future, 1);
    const copy = (await tasksOn(date))[0]!;

    await authed(http().delete(`/api/v1/tasks/${copy.id}`)).expect(204);

    expect(await tasksOn(date)).toEqual([]);
  });

  it('issues nothing in a deleted block occurrence', async () => {
    const seriesId = await postBlock({
      date: future,
      recurrence: { kind: 'daily' },
    });
    await createTask({
      title: 'A',
      date: future,
      blockSeriesId: seriesId,
      repeatWithBlock: true,
    });
    const date = addDays(future, 1);

    await authed(
      http().delete(`/api/v1/blocks/${seriesId}/occurrences/${date}`),
    ).expect(200);

    expect(await tasksOn(date)).toEqual([]);
  });

  it('refuses a repeat that ends before the task’s date', async () => {
    const res = await postTask({
      title: 'A',
      date: future,
      recurrence: { kind: 'daily', until: addDays(future, -1) },
    }).expect(400);

    expect(codeOf(res.body)).toBe('VALIDATION_FAILED');
  });

  it('starts one series for a repeated idempotency key', async () => {
    const body = {
      title: 'A',
      date: future,
      recurrence: { kind: 'daily' },
      idempotencyKey: '0192a000-0000-7000-8000-000000000011',
    };

    const first = await createTask(body);
    const again = await createTask(body);

    expect(again).toEqual(first);
    expect(await seriesCount()).toBe(1);
  });

  describe('on a closed day', () => {
    let today: string;

    beforeEach(async () => {
      await setTimeZone(AHEAD);
      today = todayIn(AHEAD);
    });

    it('records a daily task missed on its own day, where it was put', async () => {
      const date = addDays(today, -3);

      const task = await createTask({
        title: 'A',
        date,
        recurrence: { kind: 'daily' },
      });

      expect(task).toMatchObject({ date, carryCount: 0, missed: true });
      expect(await ledger()).toEqual([{ day: date, outcome: 'missed' }]);
    });

    it('carries a weekly task until the day before it comes round again', async () => {
      const date = addDays(today, -10);

      const task = await createTask({
        title: 'A',
        date,
        recurrence: { kind: 'weekly' },
      });

      const missedOn = addDays(date, 6);
      expect(task).toMatchObject({
        date: missedOn,
        blockSeriesId: null,
        carryCount: 6,
        missed: true,
      });
      expect(await ledger()).toEqual([
        ...Array.from({ length: 6 }, (_, i) => ({
          day: addDays(date, i),
          outcome: 'incomplete',
        })),
        { day: missedOn, outcome: 'missed' },
      ]);
    });

    it('carries a weekly task to today when it has not come round again', async () => {
      const date = addDays(today, -3);

      const task = await createTask({
        title: 'A',
        date,
        recurrence: { kind: 'weekly' },
      });

      expect(task).toMatchObject({ date: today, carryCount: 3, missed: false });
      expect(await ledger()).toHaveLength(3);
    });

    it('keeps a task missed in its daily block there', async () => {
      const date = addDays(today, -2);
      const seriesId = await postBlock({
        date: addDays(today, -5),
        recurrence: { kind: 'daily' },
      });

      const task = await createTask({
        title: 'A',
        date,
        blockSeriesId: seriesId,
        repeatWithBlock: true,
      });

      expect(task).toMatchObject({
        date,
        blockSeriesId: seriesId,
        carryCount: 0,
        missed: true,
      });
    });

    it('leaves the series’ other closed-day occurrences open when read', async () => {
      const date = addDays(today, -3);
      await createTask({ title: 'A', date, recurrence: { kind: 'daily' } });

      expect(await tasksOn(addDays(date, 1))).toMatchObject([
        { done: false, missed: false, carryCount: 0 },
      ]);
    });

    it('can tick a missed task, and reopening it leaves it missed', async () => {
      const date = addDays(today, -3);
      const task = await createTask({
        title: 'A',
        date,
        recurrence: { kind: 'daily' },
      });

      await setDone(task.id, true);
      expect(await ledger()).toEqual([{ day: date, outcome: 'completed' }]);

      const reopened = await setDone(task.id, false);
      expect(reopened).toMatchObject({ date, missed: true, carryCount: 0 });
      expect(await ledger()).toEqual([{ day: date, outcome: 'missed' }]);
    });

    it('settles a reopened occurrence by its series', async () => {
      const date = addDays(today, -3);
      await createTask({ title: 'A', date, recurrence: { kind: 'daily' } });
      const copy = (await tasksOn(addDays(date, 1)))[0]!;
      await setDone(copy.id, true);

      const reopened = await setDone(copy.id, false);

      expect(reopened).toMatchObject({
        date: addDays(date, 1),
        missed: true,
        carryCount: 0,
      });
    });
  });
});
