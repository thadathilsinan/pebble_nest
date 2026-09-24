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

type Task = { id: string; title: string; carryCount: number; date: string };
type Review = {
  from: string;
  to: string;
  completed: number;
  incomplete: number;
  completionRate: number | null;
  byName: { name: string; minutes: number; trace: string | null }[];
  skippedMinutes: number;
  coveredMinutes: number;
  split: {
    elapsedMinutes: number;
    blockedMinutes: number;
    skippedMinutes: number;
  };
  mostCarried: Task[];
};

describe('GET /review (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let mailer: FakeMailer;
  let accessToken: string;
  /** The user has no zone yet, so their days are read in UTC. */
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
    await pool.query(
      'TRUNCATE users, sessions, session_refresh_tokens, email_sign_in_codes, block_series, block_occurrence_exceptions, block_name_traces, tasks, task_ledger_entries RESTART IDENTITY CASCADE',
    );
    accessToken = await signIn('me@example.com');
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

  async function postBlock(body: object, token = accessToken) {
    const res = await http()
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${token}`)
      .send({ alert: false, ...body })
      .expect(201);
    return (res.body as { data: { seriesId: string; date: string } }).data;
  }

  async function postTask(body: object, token = accessToken) {
    const res = await http()
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    return (res.body as { data: Task }).data;
  }

  function getReview(from: string, to: string, token = accessToken) {
    return http()
      .get(`/api/v1/review?from=${from}&to=${to}`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function review(from: string, to: string): Promise<Review> {
    const res = await getReview(from, to).expect(200);
    return (res.body as { data: Review }).data;
  }

  it('reviews an empty period: nothing recorded, every past minute free', async () => {
    const from = addDays(today, -7);
    const to = addDays(today, -1);

    expect(await review(from, to)).toEqual({
      from,
      to,
      completed: 0,
      incomplete: 0,
      completionRate: null,
      byName: [],
      skippedMinutes: 0,
      coveredMinutes: 0,
      split: {
        elapsedMinutes: 7 * 1440,
        blockedMinutes: 0,
        skippedMinutes: 0,
      },
      mostCarried: [],
    });
  });

  it('totals past block time by name, splits a midnight crossing, and keeps skipped time apart', async () => {
    const day = addDays(today, -5);
    await postBlock({
      name: 'Deep work',
      date: day,
      startMin: 540,
      endMin: 660,
    });
    await postBlock({
      name: 'deep work',
      date: day,
      startMin: 600,
      endMin: 720,
    });
    await postBlock({ name: 'Sleep', date: day, startMin: 1380, endMin: 420 });
    const read = await postBlock({
      name: 'Read',
      date: day,
      startMin: 480,
      endMin: 600,
    });
    await http()
      .post(`/api/v1/blocks/${read.seriesId}/occurrences/${day}/skip`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const first = await review(day, day);
    expect(first.byName).toEqual([
      { name: 'Deep work', minutes: 240, trace: null },
      { name: 'Sleep', minutes: 60, trace: null },
    ]);
    expect(first.coveredMinutes).toBe(300);
    expect(first.skippedMinutes).toBe(120);
    expect(first.split).toEqual({
      elapsedMinutes: 1440,
      // 9:00–12:00 and 23:00–24:00; 8:00–9:00 only the skipped block covers.
      blockedMinutes: 240,
      skippedMinutes: 60,
    });

    // The tail of the night falls on the next day.
    const next = await review(addDays(day, 1), addDays(day, 1));
    expect(next.byName).toEqual([{ name: 'Sleep', minutes: 420, trace: null }]);
  });

  it('counts a repeating block on each past day, and nothing from days ahead', async () => {
    await postBlock({
      name: 'Gym',
      date: addDays(today, -3),
      startMin: 360,
      endMin: 420,
      recurrence: { kind: 'daily' },
    });

    const past = await review(addDays(today, -3), addDays(today, -1));
    expect(past.byName).toEqual([{ name: 'Gym', minutes: 180, trace: null }]);

    const ahead = await review(addDays(today, 1), addDays(today, 30));
    expect(ahead.byName).toEqual([]);
    expect(ahead.split.elapsedMinutes).toBe(0);
  });

  it('reaches back years without a cap', async () => {
    await postBlock({
      name: 'Deep work',
      date: addDays(today, -2),
      startMin: 540,
      endMin: 600,
    });

    const res = await review('1990-01-01', addDays(today, -1));

    expect(res.byName).toEqual([
      { name: 'Deep work', minutes: 60, trace: null },
    ]);
    expect(res.split.blockedMinutes).toBe(60);
  });

  it('counts the ledger and ranks tasks carried through the period', async () => {
    const past = addDays(today, -4);
    const overdue = await postTask({ title: 'Overdue', date: past });
    const done = await postTask({ title: 'Ticked', date: today });
    await http()
      .patch(`/api/v1/tasks/${done.id}/done`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ done: true })
      .expect(200);

    // The overdue task now sits on today, carried through four closed days.
    expect(overdue).toMatchObject({ date: today, carryCount: 4 });

    const week = await review(past, addDays(past, 1));
    expect(week).toMatchObject({
      completed: 0,
      incomplete: 2,
      completionRate: 0,
      mostCarried: [{ id: overdue.id, title: 'Overdue', carryCount: 4 }],
    });

    const now = await review(today, today);
    expect(now).toMatchObject({
      completed: 1,
      incomplete: 0,
      completionRate: 1,
      // It sits on today, so it is active in today too.
      mostCarried: [{ id: overdue.id }],
    });
  });

  it('refuses a range that ends before it starts', async () => {
    const res = await getReview(today, addDays(today, -1)).expect(400);

    expect((res.body as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('refuses a request without a token', async () => {
    await http().get(`/api/v1/review?from=${today}&to=${today}`).expect(401);
  });

  it('refuses a deleted account’s token', async () => {
    await http()
      .delete('/api/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    const res = await getReview(today, today).expect(401);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      'TOKEN_INVALID',
    );
  });

  describe('the profile’s record fields', () => {
    async function profile() {
      const res = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      return (
        res.body as {
          data: { firstRecordedDay: string | null; hasAnyRecord: boolean };
        }
      ).data;
    }

    it('reports no record for a new account', async () => {
      expect(await profile()).toMatchObject({
        firstRecordedDay: null,
        hasAnyRecord: false,
      });
    });

    it('reports the first day anything was recorded on', async () => {
      await postBlock({
        name: 'Deep work',
        date: addDays(today, -2),
        startMin: 540,
        endMin: 600,
      });
      await postTask({ title: 'Overdue', date: addDays(today, -6) });

      // The task carried to today, but its ledger starts six days back.
      expect(await profile()).toMatchObject({
        firstRecordedDay: addDays(today, -6),
        hasAnyRecord: true,
      });
    });

    it('reports it on sign-in too', async () => {
      await postTask({ title: 'Plan', date: today });
      // Lifts the 30-second resend limit left by `beforeEach`'s sign-in.
      await pool.query('DELETE FROM email_sign_in_codes');

      await http()
        .post('/api/v1/auth/email/code')
        .send({ email: 'me@example.com' })
        .expect(204);
      const res = await http()
        .post('/api/v1/auth/email/verify')
        .send({
          email: 'me@example.com',
          code: mailer.lastCodeFor('me@example.com'),
        })
        .expect(200);

      expect(
        (res.body as { data: { profile: object } }).data.profile,
      ).toMatchObject({ firstRecordedDay: today, hasAnyRecord: true });
    });
  });
});
