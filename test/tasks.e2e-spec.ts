import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { MAILER, type Mailer } from '../src/auth/mailer/mailer';
import { addDays, daysBetween, todayIn } from '../src/calendar/local-date';
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

/** Zones 25 hours apart, so their calendar dates always differ. */
const AHEAD = 'Pacific/Kiritimati';
const BEHIND = 'Pacific/Pago_Pago';

describe('POST /tasks (e2e)', () => {
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

  it('creates a task on a general list', async () => {
    const res = await postTask({
      title: '  Call the bank  ',
      date: future,
      notes: 'Ask about the fee',
      reminderAt: `${future}T09:05`,
    }).expect(201);

    expect(res.body).toEqual({
      data: {
        id: expect.any(String) as unknown,
        version: 0,
        title: 'Call the bank',
        notes: 'Ask about the fee',
        date: future,
        blockSeriesId: null,
        reminderAt: `${future}T09:05`,
        done: false,
        doneAt: null,
        carryCount: 0,
        missed: false,
        repeat: null,
      },
    });
    expect((await getDay(future)).generalList).toEqual([
      (res.body as { data: Task }).data,
    ]);
  });

  it('puts a task in a block occurrence', async () => {
    const seriesId = await postBlock({ date: future });

    const task = await createTask({
      title: 'Draft',
      date: future,
      blockSeriesId: seriesId,
    });

    expect(task.blockSeriesId).toBe(seriesId);
    const day = await getDay(future);
    expect(day.generalList).toEqual([]);
    expect(day.blocks[0]).toMatchObject({
      tasks: [task],
      openCount: 1,
      totalCount: 1,
    });
  });

  it('shows a midnight tail holding the tasks of the occurrence it ends', async () => {
    const seriesId = await postBlock({
      date: future,
      startMin: 1320,
      endMin: 120,
    });
    const task = await createTask({
      title: 'Late',
      date: future,
      blockSeriesId: seriesId,
    });

    const next = await getDay(addDays(future, 1));

    expect(next.blocks).toMatchObject([
      { date: future, continuedFromPreviousDay: true, tasks: [task] },
    ]);
    expect(next.generalList).toEqual([]);
  });

  it('orders open before done, then most carried, then title', async () => {
    const titles = ['banana', 'Apple', 'cherry', 'Done'];
    const ids: Record<string, string> = {};
    for (const title of titles) {
      ids[title] = (await createTask({ title, date: future })).id;
    }
    await pool.query('UPDATE tasks SET carry_count = 2 WHERE id = $1', [
      ids.cherry,
    ]);
    await pool.query(
      'UPDATE tasks SET done = true, done_at = now() WHERE id = $1',
      [ids.Done],
    );

    const list = (await getDay(future)).generalList;

    expect(list.map((t) => t.title)).toEqual([
      'cherry',
      'Apple',
      'banana',
      'Done',
    ]);
  });

  it('refuses bad fields', async () => {
    const bad = [
      { title: '   ', date: future },
      { title: 'x'.repeat(201), date: future },
      { title: 'A', date: '2026-02-30' },
      { title: 'A', date: future, reminderAt: `${future}T09:00:00Z` },
      { title: 'A', date: future, reminderAt: `${future}T24:00` },
      { title: 'A', date: future, reminderAt: '2026-02-30T09:00' },
      { title: 'A', date: future, notes: 'x'.repeat(10_001) },
      { title: 'A', date: future, blockSeriesId: 'not-a-uuid' },
      { title: 'A', date: future, done: true },
    ];
    for (const body of bad) {
      const res = await postTask(body).expect(400);
      expect(codeOf(res.body)).toBe('VALIDATION_FAILED');
    }
  });

  it('refuses a block that is not the caller’s, or not on that date', async () => {
    const theirs = await postBlock(
      { date: future },
      await signIn('them@example.com'),
    );
    const mine = await postBlock({ date: future });

    const unknown = await postTask({
      title: 'A',
      date: future,
      blockSeriesId: '0192a000-0000-7000-8000-000000000009',
    }).expect(404);
    const other = await postTask({
      title: 'A',
      date: future,
      blockSeriesId: theirs,
    }).expect(404);
    const offDay = await postTask({
      title: 'A',
      date: addDays(future, 1),
      blockSeriesId: mine,
    }).expect(422);

    expect(codeOf(unknown.body)).toBe('NOT_FOUND');
    expect(codeOf(other.body)).toBe('NOT_FOUND');
    expect(codeOf(offDay.body)).toBe('BLOCK_NOT_ON_DATE');
  });

  it('refuses a repeat that does not fit where the task sits', async () => {
    const oneOff = await postBlock({ date: future });
    const daily = await postBlock({
      date: future,
      recurrence: { kind: 'daily' },
    });

    const cases = [
      { title: 'A', date: future, repeatWithBlock: true },
      {
        title: 'A',
        date: future,
        blockSeriesId: daily,
        recurrence: { kind: 'daily' },
      },
      {
        title: 'A',
        date: future,
        blockSeriesId: oneOff,
        repeatWithBlock: true,
      },
    ];
    for (const body of cases) {
      const res = await postTask(body).expect(422);
      expect(codeOf(res.body)).toBe('REPEAT_NOT_ALLOWED');
    }
  });

  it('treats saying "no repeat" explicitly as a one-off', async () => {
    const task = await createTask({
      title: 'A',
      date: future,
      repeatWithBlock: false,
      recurrence: { kind: 'none' },
    });

    expect(task).toMatchObject({ repeat: null });
  });

  it('returns the original task for a repeated idempotency key', async () => {
    const key = '0192a000-0000-7000-8000-000000000001';

    const first = await createTask({
      title: 'Once',
      date: future,
      idempotencyKey: key,
    });
    const again = await createTask({
      title: 'Twice',
      date: future,
      idempotencyKey: key,
    });

    expect(again).toEqual(first);
    expect((await getDay(future)).generalList).toHaveLength(1);
  });

  it('carries a task put on a closed day forward to today', async () => {
    await setTimeZone(AHEAD);
    const today = todayIn(AHEAD);
    const past = addDays(today, -3);
    const seriesId = await postBlock({
      date: addDays(today, -5),
      recurrence: { kind: 'daily' },
    });

    const task = await createTask({
      title: 'Overdue',
      date: past,
      blockSeriesId: seriesId,
    });

    expect(task).toMatchObject({
      date: today,
      blockSeriesId: null,
      carryCount: 3,
    });
    expect(await ledger()).toEqual([
      { day: past, outcome: 'incomplete' },
      { day: addDays(past, 1), outcome: 'incomplete' },
      { day: addDays(past, 2), outcome: 'incomplete' },
    ]);
    expect((await getDay(today)).generalList).toEqual([task]);
    expect((await getDay(past)).blocks).toMatchObject([{ tasks: [] }]);
  });

  it('writes no second ledger for a replayed closed-day create', async () => {
    const key = '0192a000-0000-7000-8000-000000000002';
    const past = addDays(todayIn('UTC'), -2);

    const first = await createTask({
      title: 'A',
      date: past,
      idempotencyKey: key,
    });
    const again = await createTask({
      title: 'A',
      date: past,
      idempotencyKey: key,
    });

    expect(again).toEqual(first);
    expect(await ledger()).toHaveLength(2);
  });

  it('reads which days have closed in the user’s time zone', async () => {
    const date = todayIn(BEHIND);

    await setTimeZone(BEHIND);
    const stays = await createTask({ title: 'Stays', date });
    await setTimeZone(AHEAD);
    const carried = await createTask({ title: 'Carried', date });

    expect(stays).toMatchObject({ date, carryCount: 0 });
    expect(carried).toMatchObject({
      date: todayIn(AHEAD),
      carryCount: daysBetween(date, todayIn(AHEAD)),
    });
  });

  it('keeps each user’s tasks to themselves', async () => {
    await createTask({ title: 'Mine', date: future });

    const theirs = await getDay(future, await signIn('them@example.com'));

    expect(theirs.generalList).toEqual([]);
  });

  it('refuses a token whose account is gone', async () => {
    await http()
      .delete('/api/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    const res = await postTask({ title: 'A', date: future }).expect(401);
    expect(codeOf(res.body)).toBe('TOKEN_INVALID');
  });
});

describe('PATCH /tasks/{id}/done (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let mailer: FakeMailer;
  let accessToken: string;
  let future: string;

  beforeEach(async () => {
    mailer = new FakeMailer();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();

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

  async function createTask(body: object): Promise<Task> {
    const res = await http()
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body)
      .expect(201);
    return (res.body as { data: Task }).data;
  }

  function patchDone(id: string, body: object, token = accessToken) {
    return http()
      .patch(`/api/v1/tasks/${id}/done`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  async function setDone(id: string, done: boolean): Promise<Task> {
    const res = await patchDone(id, { done }).expect(200);
    return (res.body as { data: Task }).data;
  }

  async function getDay(date: string): Promise<Day> {
    const res = await http()
      .get(`/api/v1/days/${date}`)
      .set('Authorization', `Bearer ${accessToken}`)
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

  it('marks a task done and records the day completed', async () => {
    const task = await createTask({ title: 'A', date: future });

    const done = await setDone(task.id, true);

    expect(done).toMatchObject({ done: true, version: 1, date: future });
    expect(Date.parse(done.doneAt ?? '')).not.toBeNaN();
    expect(await ledger()).toEqual([{ day: future, outcome: 'completed' }]);
    expect((await getDay(future)).generalList).toEqual([done]);
  });

  it('marks a task open again and removes the record', async () => {
    const task = await createTask({ title: 'A', date: future });
    await setDone(task.id, true);

    const open = await setDone(task.id, false);

    expect(open).toMatchObject({
      done: false,
      doneAt: null,
      version: 2,
      date: future,
      carryCount: 0,
    });
    expect(await ledger()).toEqual([]);
  });

  it('changes nothing when the task already has that value', async () => {
    const open = await createTask({ title: 'A', date: future });
    const task = await createTask({ title: 'B', date: future });
    const done = await setDone(task.id, true);

    expect(await setDone(open.id, false)).toEqual(open);
    expect(await setDone(task.id, true)).toEqual(done);
    expect(await ledger()).toEqual([{ day: future, outcome: 'completed' }]);
  });

  it('carries a task reopened on a closed day forward to today', async () => {
    await setTimeZone(BEHIND);
    const date = todayIn(BEHIND);
    const task = await createTask({ title: 'A', date });
    await setDone(task.id, true);
    await setTimeZone(AHEAD);
    const today = todayIn(AHEAD);
    const days = daysBetween(date, today);

    const open = await setDone(task.id, false);

    expect(open).toMatchObject({
      done: false,
      date: today,
      blockSeriesId: null,
      carryCount: days,
    });
    expect(await ledger()).toEqual(
      Array.from({ length: days }, (_, i) => ({
        day: addDays(date, i),
        outcome: 'incomplete',
      })),
    );
    expect((await getDay(today)).generalList).toEqual([open]);
    expect((await getDay(date)).generalList).toEqual([]);
  });

  it('keeps earlier carries when a carried task is done then reopened', async () => {
    await setTimeZone(AHEAD);
    const today = todayIn(AHEAD);
    const past = addDays(today, -2);
    const task = await createTask({ title: 'A', date: past });
    await setDone(task.id, true);

    const open = await setDone(task.id, false);

    // Reopened on the day it now sits on, which has not closed.
    expect(open).toMatchObject({ date: today, carryCount: 2 });
    expect(await ledger()).toEqual([
      { day: past, outcome: 'incomplete' },
      { day: addDays(past, 1), outcome: 'incomplete' },
    ]);
  });

  it('takes a task out of its block when it carries', async () => {
    await setTimeZone(BEHIND);
    const date = todayIn(BEHIND);
    const block = await http()
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'Deep work',
        date,
        startMin: 540,
        endMin: 600,
        alert: false,
      })
      .expect(201);
    const seriesId = (block.body as { data: { seriesId: string } }).data
      .seriesId;
    const task = await createTask({
      title: 'A',
      date,
      blockSeriesId: seriesId,
    });
    await setDone(task.id, true);
    await setTimeZone(AHEAD);

    const open = await setDone(task.id, false);

    expect(open.blockSeriesId).toBeNull();
    expect((await getDay(date)).blocks).toMatchObject([{ tasks: [] }]);
  });

  it('refuses bad input', async () => {
    const task = await createTask({ title: 'A', date: future });

    for (const [id, body] of [
      ['not-a-uuid', { done: true }],
      [task.id, {}],
      [task.id, { done: 'yes' }],
      [task.id, { done: true, version: 0 }],
    ] as const) {
      const res = await patchDone(id, body).expect(400);
      expect(codeOf(res.body)).toBe('VALIDATION_FAILED');
    }
  });

  it('answers 404 for an unknown task or someone else’s', async () => {
    const task = await createTask({ title: 'A', date: future });
    const them = await signIn('them@example.com');

    for (const [id, token] of [
      ['0192a000-0000-7000-8000-000000000009', accessToken],
      [task.id, them],
    ] as const) {
      const res = await patchDone(id, { done: true }, token).expect(404);
      expect(codeOf(res.body)).toBe('NOT_FOUND');
    }
    expect(await ledger()).toEqual([]);
  });

  it('writes one record when two devices tick at once', async () => {
    const task = await createTask({ title: 'A', date: future });

    const results = await Promise.all([
      setDone(task.id, true),
      setDone(task.id, true),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect(results[0].version).toBe(1);
    expect(await ledger()).toEqual([{ day: future, outcome: 'completed' }]);
  });

  it('refuses a token whose account is gone', async () => {
    const task = await createTask({ title: 'A', date: future });
    await http()
      .delete('/api/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    const res = await patchDone(task.id, { done: true }).expect(401);
    expect(codeOf(res.body)).toBe('TOKEN_INVALID');
  });
});

describe('PATCH /tasks/{id} (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let mailer: FakeMailer;
  let accessToken: string;
  let future: string;

  type Edited = Task & { notes: string; reminderAt: string | null };
  type Stale = { error: { code: string; meta: { current: Edited } } };

  beforeEach(async () => {
    mailer = new FakeMailer();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();

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

  async function createTask(body: object): Promise<Edited> {
    const res = await http()
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body)
      .expect(201);
    return (res.body as { data: Edited }).data;
  }

  async function postBlock(body: object): Promise<string> {
    const res = await http()
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'Deep work',
        date: future,
        startMin: 540,
        endMin: 600,
        alert: false,
        ...body,
      })
      .expect(201);
    return (res.body as { data: { seriesId: string } }).data.seriesId;
  }

  function patchTask(id: string, body: object, token = accessToken) {
    return http()
      .patch(`/api/v1/tasks/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  async function editTask(id: string, body: object): Promise<Edited> {
    const res = await patchTask(id, body).expect(200);
    return (res.body as { data: Edited }).data;
  }

  async function setDone(id: string, done: boolean): Promise<Edited> {
    const res = await http()
      .patch(`/api/v1/tasks/${id}/done`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ done })
      .expect(200);
    return (res.body as { data: Edited }).data;
  }

  async function getDay(date: string): Promise<Day> {
    const res = await http()
      .get(`/api/v1/days/${date}`)
      .set('Authorization', `Bearer ${accessToken}`)
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

  async function ledgerTitles(): Promise<string[]> {
    const { rows } = await pool.query<{ title: string }>(
      'SELECT title FROM task_ledger_entries ORDER BY day',
    );
    return rows.map((r) => r.title);
  }

  function codeOf(body: unknown): string {
    return (body as Failure).error.code;
  }

  it('edits the title, notes and reminder', async () => {
    const task = await createTask({ title: 'A', date: future });

    const edited = await editTask(task.id, {
      version: 0,
      title: '  Call the bank  ',
      notes: 'Ask about the fee',
      reminderAt: `${future}T17:30`,
    });

    expect(edited).toEqual({
      ...task,
      version: 1,
      title: 'Call the bank',
      notes: 'Ask about the fee',
      reminderAt: `${future}T17:30`,
    });
    expect((await getDay(future)).generalList).toEqual([edited]);
  });

  it('clears the reminder with null and leaves absent fields alone', async () => {
    const task = await createTask({
      title: 'A',
      date: future,
      notes: 'Keep',
      reminderAt: `${future}T09:00`,
    });

    const edited = await editTask(task.id, { version: 0, reminderAt: null });

    expect(edited).toMatchObject({
      title: 'A',
      notes: 'Keep',
      reminderAt: null,
      version: 1,
    });
  });

  it('changes nothing, not even the version, for a patch with nothing new', async () => {
    const task = await createTask({
      title: 'A',
      date: future,
      reminderAt: `${future}T09:00`,
    });

    for (const body of [
      { version: 0 },
      { version: 0, title: ' A ', notes: '', reminderAt: `${future}T09:00` },
      { version: 0, repeatWithBlock: false, recurrence: { kind: 'none' } },
    ]) {
      expect(await editTask(task.id, body)).toEqual(task);
    }
  });

  it('refuses a stale version with the task as it now is', async () => {
    const task = await createTask({ title: 'A', date: future });
    const done = await setDone(task.id, true);

    const res = await patchTask(task.id, { version: 0, title: 'B' }).expect(
      409,
    );

    expect(codeOf(res.body)).toBe('STALE_VERSION');
    expect((res.body as Stale).error.meta.current).toEqual(done);
  });

  it('gives every day the task recorded its new title', async () => {
    await setTimeZone(AHEAD);
    const today = todayIn(AHEAD);
    const task = await createTask({ title: 'A', date: addDays(today, -2) });
    const done = await setDone(task.id, true);

    await editTask(task.id, { version: done.version, title: 'B' });

    expect(await ledgerTitles()).toEqual(['B', 'B', 'B']);
  });

  it('neither moves nor carries a task on a closed day', async () => {
    await setTimeZone(BEHIND);
    const date = todayIn(BEHIND);
    const task = await createTask({ title: 'A', date });
    const done = await setDone(task.id, true);
    await setTimeZone(AHEAD);

    const edited = await editTask(task.id, {
      version: done.version,
      title: 'B',
    });

    expect(edited).toMatchObject({ date, done: true, carryCount: 0 });
  });

  it('refuses bad input', async () => {
    const task = await createTask({ title: 'A', date: future });

    for (const [id, body] of [
      ['not-a-uuid', { version: 0 }],
      [task.id, {}],
      [task.id, { title: 'B' }],
      [task.id, { version: -1 }],
      [task.id, { version: 0, title: '   ' }],
      [task.id, { version: 0, title: 'x'.repeat(201) }],
      [task.id, { version: 0, notes: 'x'.repeat(10_001) }],
      [task.id, { version: 0, reminderAt: `${future}T24:00` }],
      [task.id, { version: 0, date: future }],
      [task.id, { version: 0, blockSeriesId: null }],
      [task.id, { version: 0, done: true }],
    ] as const) {
      const res = await patchTask(id, body).expect(400);
      expect(codeOf(res.body)).toBe('VALIDATION_FAILED');
    }
  });

  it('refuses a repeat that does not fit where the task sits', async () => {
    const general = await createTask({ title: 'A', date: future });
    const oneOffBlock = await postBlock({});
    const inBlock = await createTask({
      title: 'B',
      date: future,
      blockSeriesId: oneOffBlock,
    });

    for (const [id, body] of [
      [general.id, { repeatWithBlock: true }],
      [inBlock.id, { repeatWithBlock: true }],
      [inBlock.id, { recurrence: { kind: 'daily' } }],
    ] as const) {
      const res = await patchTask(id, { version: 0, ...body }).expect(422);
      expect(codeOf(res.body)).toBe('REPEAT_NOT_ALLOWED');
    }
  });

  it('starts a series for a repeat that fits', async () => {
    const general = await createTask({ title: 'A', date: future });
    const daily = await postBlock({ recurrence: { kind: 'daily' } });
    const inBlock = await createTask({
      title: 'B',
      date: future,
      blockSeriesId: daily,
    });

    for (const [id, body, mode] of [
      [general.id, { recurrence: { kind: 'daily' } }, 'own'],
      [inBlock.id, { repeatWithBlock: true }, 'withBlock'],
    ] as const) {
      const res = await patchTask(id, { version: 0, ...body }).expect(200);
      expect(res.body).toMatchObject({
        data: { version: 1, repeat: { mode } },
      });
    }
  });

  it('answers 404 for an unknown task, someone else’s, or a deleted account', async () => {
    const task = await createTask({ title: 'A', date: future });
    const them = await signIn('them@example.com');

    for (const [id, token] of [
      ['0192a000-0000-7000-8000-000000000009', accessToken],
      [task.id, them],
    ] as const) {
      const res = await patchTask(id, { version: 0 }, token).expect(404);
      expect(codeOf(res.body)).toBe('NOT_FOUND');
    }

    await http()
      .delete('/api/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);
    const res = await patchTask(task.id, { version: 0 }).expect(404);
    expect(codeOf(res.body)).toBe('NOT_FOUND');
  });

  it('lets one of two edits at the same version through', async () => {
    const task = await createTask({ title: 'A', date: future });

    const statuses = await Promise.all([
      patchTask(task.id, { version: 0, title: 'B' }),
      patchTask(task.id, { version: 0, title: 'C' }),
    ]).then((all) => all.map((r) => r.status).sort());

    expect(statuses).toEqual([200, 409]);
  });
});

describe('POST /tasks/{id}/move (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let mailer: FakeMailer;
  let accessToken: string;
  let future: string;

  beforeEach(async () => {
    mailer = new FakeMailer();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();

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

  async function createTask(body: object): Promise<Task> {
    const res = await http()
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body)
      .expect(201);
    return (res.body as { data: Task }).data;
  }

  async function createBlock(date: string, token = accessToken) {
    const res = await http()
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Deep work',
        date,
        startMin: 540,
        endMin: 600,
        alert: false,
      })
      .expect(201);
    return (res.body as { data: { seriesId: string } }).data.seriesId;
  }

  function postMove(id: string, body: object, token = accessToken) {
    return http()
      .post(`/api/v1/tasks/${id}/move`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  async function move(id: string, body: object): Promise<Task> {
    const res = await postMove(id, body).expect(200);
    return (res.body as { data: Task }).data;
  }

  async function setDone(id: string) {
    await http()
      .patch(`/api/v1/tasks/${id}/done`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ done: true })
      .expect(200);
  }

  async function getDay(date: string): Promise<Day> {
    const res = await http()
      .get(`/api/v1/days/${date}`)
      .set('Authorization', `Bearer ${accessToken}`)
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

  it('moves a task into a block and to another date’s general list', async () => {
    const task = await createTask({ title: 'A', date: future });
    const later = addDays(future, 1);
    const seriesId = await createBlock(later);

    const inBlock = await move(task.id, {
      date: later,
      blockSeriesId: seriesId,
    });
    const onList = await move(task.id, { date: future, blockSeriesId: null });

    expect(inBlock).toMatchObject({
      date: later,
      blockSeriesId: seriesId,
      version: 1,
      carryCount: 0,
    });
    expect(onList).toMatchObject({
      date: future,
      blockSeriesId: null,
      version: 2,
    });
    expect((await getDay(future)).generalList).toEqual([onList]);
    expect((await getDay(later)).blocks).toMatchObject([{ tasks: [] }]);
  });

  it('changes nothing, not even the version, for a move to where it is', async () => {
    const task = await createTask({ title: 'A', date: future });

    expect(await move(task.id, { date: future, blockSeriesId: null })).toEqual(
      task,
    );
  });

  it('takes a done task’s completed entry with it', async () => {
    const task = await createTask({ title: 'A', date: future });
    await setDone(task.id);
    const later = addDays(future, 1);

    const moved = await move(task.id, { date: later, blockSeriesId: null });

    expect(moved).toMatchObject({ date: later, done: true, version: 2 });
    expect(await ledger()).toEqual([{ day: later, outcome: 'completed' }]);
  });

  it('leaves a done task on the closed day it is moved to', async () => {
    await setTimeZone(AHEAD);
    const past = addDays(todayIn(AHEAD), -2);
    const task = await createTask({ title: 'A', date: future });
    await setDone(task.id);

    const moved = await move(task.id, { date: past, blockSeriesId: null });

    expect(moved).toMatchObject({ date: past, done: true, carryCount: 0 });
    expect(await ledger()).toEqual([{ day: past, outcome: 'completed' }]);
  });

  it('carries an open task moved onto a closed day forward to today', async () => {
    await setTimeZone(AHEAD);
    const today = todayIn(AHEAD);
    const past = addDays(today, -2);
    const seriesId = await createBlock(past);
    const task = await createTask({ title: 'A', date: future });

    const moved = await move(task.id, { date: past, blockSeriesId: seriesId });

    expect(moved).toMatchObject({
      date: today,
      blockSeriesId: null,
      carryCount: 2,
      version: 1,
    });
    expect(await ledger()).toEqual([
      { day: past, outcome: 'incomplete' },
      { day: addDays(past, 1), outcome: 'incomplete' },
    ]);
    expect((await getDay(today)).generalList).toEqual([moved]);
    expect((await getDay(past)).blocks).toMatchObject([{ tasks: [] }]);
  });

  it('records each day once when a task is moved back through days it carried', async () => {
    await setTimeZone(AHEAD);
    const today = todayIn(AHEAD);
    const past = addDays(today, -2);
    const task = await createTask({ title: 'A', date: past });

    const moved = await move(task.id, { date: past, blockSeriesId: null });

    // Its carries count moves, so it carried twice more.
    expect(moved).toMatchObject({ date: today, carryCount: 4, version: 1 });
    expect(await ledger()).toEqual([
      { day: past, outcome: 'incomplete' },
      { day: addDays(past, 1), outcome: 'incomplete' },
    ]);
  });

  it('refuses bad input', async () => {
    const task = await createTask({ title: 'A', date: future });

    for (const [id, body] of [
      ['not-a-uuid', { date: future, blockSeriesId: null }],
      [task.id, {}],
      [task.id, { date: future }],
      [task.id, { blockSeriesId: null }],
      [task.id, { date: '2026-02-30', blockSeriesId: null }],
      [task.id, { date: future, blockSeriesId: 'nope' }],
      [task.id, { date: future, blockSeriesId: null, version: 0 }],
    ] as const) {
      const res = await postMove(id, body).expect(400);
      expect(codeOf(res.body)).toBe('VALIDATION_FAILED');
    }
  });

  it('refuses a block that is not the caller’s, or not on that date', async () => {
    const task = await createTask({ title: 'A', date: future });
    const them = await signIn('them@example.com');
    const theirs = await createBlock(future, them);
    const mine = await createBlock(future);

    const notMine = await postMove(task.id, {
      date: future,
      blockSeriesId: theirs,
    }).expect(404);
    const notOnDate = await postMove(task.id, {
      date: addDays(future, 1),
      blockSeriesId: mine,
    }).expect(422);

    expect(codeOf(notMine.body)).toBe('NOT_FOUND');
    expect(codeOf(notOnDate.body)).toBe('BLOCK_NOT_ON_DATE');
  });

  it('answers 404 for an unknown task or someone else’s', async () => {
    const task = await createTask({ title: 'A', date: future });
    const them = await signIn('them@example.com');
    const body = { date: addDays(future, 1), blockSeriesId: null };

    for (const [id, token] of [
      ['0192a000-0000-7000-8000-000000000009', accessToken],
      [task.id, them],
    ] as const) {
      const res = await postMove(id, body, token).expect(404);
      expect(codeOf(res.body)).toBe('NOT_FOUND');
    }
    expect((await getDay(future)).generalList).toEqual([task]);
  });

  it('refuses a token whose account is gone', async () => {
    const task = await createTask({ title: 'A', date: future });
    await http()
      .delete('/api/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    const res = await postMove(task.id, {
      date: future,
      blockSeriesId: null,
    }).expect(401);
    expect(codeOf(res.body)).toBe('TOKEN_INVALID');
  });
});

describe('DELETE /tasks/{id} (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let mailer: FakeMailer;
  let accessToken: string;
  let future: string;

  beforeEach(async () => {
    mailer = new FakeMailer();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();

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

  async function createTask(body: object): Promise<Task> {
    const res = await http()
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body)
      .expect(201);
    return (res.body as { data: Task }).data;
  }

  function deleteTask(id: string, query = '', token = accessToken) {
    return http()
      .delete(`/api/v1/tasks/${id}${query}`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function getDay(date: string): Promise<Day> {
    const res = await http()
      .get(`/api/v1/days/${date}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    return (res.body as { data: Day }).data;
  }

  function codeOf(body: unknown): string {
    return (body as Failure).error.code;
  }

  it('deletes a task, and a retry is a 404', async () => {
    const task = await createTask({ title: 'A', date: future });
    const other = await createTask({ title: 'B', date: future });

    const res = await deleteTask(task.id).expect(204);

    expect(res.text).toBe('');
    expect((await getDay(future)).generalList).toEqual([other]);
    const again = await deleteTask(task.id).expect(404);
    expect(codeOf(again.body)).toBe('NOT_FOUND');
  });

  it('keeps the days the task recorded, under its title', async () => {
    const task = await createTask({ title: 'A', date: future });
    await http()
      .patch(`/api/v1/tasks/${task.id}/done`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ done: true })
      .expect(200);

    await deleteTask(task.id).expect(204);

    const { rows } = await pool.query<{
      task_id: string | null;
      title: string;
    }>('SELECT task_id, title FROM task_ledger_entries');
    expect(rows).toEqual([{ task_id: null, title: 'A' }]);
  });

  it('takes either scope for a task that does not repeat', async () => {
    const a = await createTask({ title: 'A', date: future });
    const b = await createTask({ title: 'B', date: future });

    await deleteTask(a.id, '?scope=onlyThis').expect(204);
    await deleteTask(b.id, '?scope=series').expect(204);

    expect((await getDay(future)).generalList).toEqual([]);
  });

  it('refuses bad input', async () => {
    const task = await createTask({ title: 'A', date: future });

    for (const [id, query] of [
      ['not-a-uuid', ''],
      [task.id, '?scope=all'],
    ] as const) {
      const res = await deleteTask(id, query).expect(400);
      expect(codeOf(res.body)).toBe('VALIDATION_FAILED');
    }
    expect((await getDay(future)).generalList).toEqual([task]);
  });

  it('answers 404 for someone else’s task or a deleted account', async () => {
    const task = await createTask({ title: 'A', date: future });
    const them = await signIn('them@example.com');

    const theirs = await deleteTask(task.id, '', them).expect(404);
    expect(codeOf(theirs.body)).toBe('NOT_FOUND');
    expect((await getDay(future)).generalList).toEqual([task]);

    await http()
      .delete('/api/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);
    const gone = await deleteTask(task.id).expect(404);
    expect(codeOf(gone.body)).toBe('NOT_FOUND');
  });
});
