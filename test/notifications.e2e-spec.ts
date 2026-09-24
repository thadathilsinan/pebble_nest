import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { MAILER, type Mailer } from '../src/auth/mailer/mailer';
import { configureApp } from '../src/core/bootstrap/configure-app';
import { ENV } from '../src/core/config/config.module';
import type { Env } from '../src/core/config/env.schema';
import { POOL } from '../src/core/database/database.module';

/** `expect.any` is typed `any`; this names what it matches once. */
const anyString: unknown = expect.any(String);

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

type Occurrence = { seriesId: string; date: string; seriesVersion: number };
type Task = { id: string; version: number };
type BlockAlert = {
  seriesId: string;
  date: string;
  name: string;
  startAt: string;
  openTaskCount: number;
};
type TaskReminder = { taskId: string; title: string; remindAt: string };
type Schedule = { blockAlerts: BlockAlert[]; taskReminders: TaskReminder[] };

// Far enough ahead that no date here is a closed day, which would carry a
// task to today. 2030-09-02 is a Monday.
const MON = '2030-09-02';
const TUE = '2030-09-03';
const WED = '2030-09-04';
const SUN = '2030-09-08';
const NEXT_MON = '2030-09-09';

describe('GET /notifications/schedule (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let mailer: FakeMailer;
  let accessToken: string;

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
      'TRUNCATE users, sessions, session_refresh_tokens, email_sign_in_codes, block_series, block_occurrence_exceptions, tasks, task_ledger_entries RESTART IDENTITY CASCADE',
    );
    accessToken = await signIn('me@example.com');
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

  async function postBlock(body: object, token = accessToken) {
    const res = await http()
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${token}`)
      .send({ date: MON, startMin: 540, endMin: 600, alert: true, ...body })
      .expect(201);
    return (res.body as { data: Occurrence }).data;
  }

  async function postTask(body: object, token = accessToken) {
    const res = await http()
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ date: MON, ...body })
      .expect(201);
    return (res.body as { data: Task }).data;
  }

  function getSchedule(query: string, token = accessToken) {
    return http()
      .get(`/api/v1/notifications/schedule${query}`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function schedule(from = MON, to = SUN): Promise<Schedule> {
    const res = await getSchedule(`?from=${from}&to=${to}`).expect(200);
    return (res.body as { data: Schedule }).data;
  }

  it('returns empty lists when nothing is scheduled', async () => {
    const res = await getSchedule(`?from=${MON}&to=${SUN}`).expect(200);
    expect(res.body).toEqual({ data: { blockAlerts: [], taskReminders: [] } });
  });

  describe('block alerts', () => {
    it('lists each occurrence with its alert on, at its start', async () => {
      const block = await postBlock({
        name: 'Family',
        startMin: 1110,
        endMin: 1200,
        recurrence: { kind: 'daily', until: TUE },
      });

      expect((await schedule()).blockAlerts).toEqual([
        {
          seriesId: block.seriesId,
          date: MON,
          name: 'Family',
          startAt: `${MON}T18:30`,
          openTaskCount: 0,
        },
        {
          seriesId: block.seriesId,
          date: TUE,
          name: 'Family',
          startAt: `${TUE}T18:30`,
          openTaskCount: 0,
        },
      ]);
    });

    it('leaves out blocks with the alert off', async () => {
      await postBlock({ name: 'Quiet', alert: false });
      expect((await schedule()).blockAlerts).toEqual([]);
    });

    it('counts only the occurrence’s open tasks', async () => {
      const block = await postBlock({ name: 'Family' });
      await postTask({ title: 'Open', blockSeriesId: block.seriesId });
      const done = await postTask({
        title: 'Done',
        blockSeriesId: block.seriesId,
      });
      await http()
        .patch(`/api/v1/tasks/${done.id}/done`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ done: true })
        .expect(200);
      // On the general list, so not the block's.
      await postTask({ title: 'Elsewhere' });

      expect((await schedule()).blockAlerts).toEqual([
        expect.objectContaining({ openTaskCount: 1 }),
      ]);
    });

    it('leaves out skipped and deleted occurrences', async () => {
      const block = await postBlock({
        name: 'Daily',
        recurrence: { kind: 'daily', until: WED },
      });
      await http()
        .post(`/api/v1/blocks/${block.seriesId}/occurrences/${MON}/skip`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      await http()
        .delete(`/api/v1/blocks/${block.seriesId}/occurrences/${TUE}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect((await schedule()).blockAlerts.map((a) => a.date)).toEqual([WED]);
    });

    it('follows an occurrence’s own alert and start', async () => {
      const block = await postBlock({
        name: 'Daily',
        alert: false,
        recurrence: { kind: 'daily', until: TUE },
      });
      await http()
        .patch(`/api/v1/blocks/${block.seriesId}/occurrences/${TUE}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          version: block.seriesVersion,
          scope: 'onlyThis',
          alert: true,
          startMin: 600,
          endMin: 660,
        })
        .expect(200);

      expect((await schedule()).blockAlerts).toEqual([
        expect.objectContaining({ date: TUE, startAt: `${TUE}T10:00` }),
      ]);
    });

    it('gives a midnight-crossing block one alert, at its start', async () => {
      await postBlock({ name: 'Late shift', startMin: 1320, endMin: 120 });

      expect((await schedule()).blockAlerts).toEqual([
        expect.objectContaining({ date: MON, startAt: `${MON}T22:00` }),
      ]);
      // Its tail falls on Tuesday, but it started on Monday.
      expect((await schedule(TUE, TUE)).blockAlerts).toEqual([]);
    });

    it('orders by start, then name', async () => {
      await postBlock({ name: 'B', date: TUE, startMin: 480, endMin: 540 });
      await postBlock({ name: 'Z', startMin: 600, endMin: 660 });
      await postBlock({ name: 'A', date: TUE, startMin: 480, endMin: 600 });

      expect((await schedule()).blockAlerts.map((a) => a.name)).toEqual([
        'Z',
        'A',
        'B',
      ]);
    });

    it('stays inside the range', async () => {
      await postBlock({ name: 'Before', date: '2030-09-01' });
      await postBlock({ name: 'After', date: NEXT_MON });
      expect((await schedule()).blockAlerts).toEqual([]);
    });
  });

  describe('task reminders', () => {
    it('lists open tasks by their reminder’s own date', async () => {
      const task = await postTask({
        title: 'Call mum',
        // The task sits on Monday; its reminder is on Wednesday.
        reminderAt: `${WED}T17:30`,
      });
      // The reminder falls after the range, though the task is inside it.
      await postTask({ title: 'Later', reminderAt: `${NEXT_MON}T09:00` });
      // The task sits after the range, though its reminder is inside it.
      const early = await postTask({
        title: 'Early',
        date: NEXT_MON,
        reminderAt: `${SUN}T08:00`,
      });

      expect((await schedule()).taskReminders).toEqual([
        { taskId: task.id, title: 'Call mum', remindAt: `${WED}T17:30` },
        { taskId: early.id, title: 'Early', remindAt: `${SUN}T08:00` },
      ]);
    });

    it('leaves out done tasks and tasks with no reminder', async () => {
      const done = await postTask({
        title: 'Done',
        reminderAt: `${MON}T09:00`,
      });
      await http()
        .patch(`/api/v1/tasks/${done.id}/done`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ done: true })
        .expect(200);
      await postTask({ title: 'No reminder' });

      expect((await schedule()).taskReminders).toEqual([]);
    });

    it('orders by time, then title', async () => {
      await postTask({ title: 'b', reminderAt: `${TUE}T09:00` });
      await postTask({ title: 'z', reminderAt: `${MON}T10:00` });
      await postTask({ title: 'a', reminderAt: `${TUE}T09:00` });

      expect((await schedule()).taskReminders.map((r) => r.title)).toEqual([
        'z',
        'a',
        'b',
      ]);
    });
  });

  it('does not show another user’s blocks or tasks', async () => {
    const theirToken = await signIn('them@example.com');
    await postBlock({ name: 'Theirs' }, theirToken);
    await postTask({ title: 'Theirs', reminderAt: `${MON}T09:00` }, theirToken);

    expect(await schedule()).toEqual({ blockAlerts: [], taskReminders: [] });
  });

  it('allows a 7-day range', async () => {
    await getSchedule(`?from=${MON}&to=${SUN}`).expect(200);
  });

  it.each([
    ['a range over 7 days', `?from=${MON}&to=${NEXT_MON}`],
    ['a range ending before it starts', `?from=${TUE}&to=${MON}`],
    ['a range with no end', `?from=${MON}`],
    ['a malformed date', `?from=today&to=${MON}`],
  ])('refuses %s', async (_, query) => {
    const res = await getSchedule(query).expect(400);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('needs an access token', async () => {
    const res = await http()
      .get(`/api/v1/notifications/schedule?from=${MON}&to=${SUN}`)
      .expect(401);
    expect(res.body).toEqual({
      error: { code: 'TOKEN_INVALID', message: anyString },
    });
  });
});
