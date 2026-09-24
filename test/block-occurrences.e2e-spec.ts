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
  carryCount: number;
};
type Occurrence = {
  seriesId: string;
  date: string;
  skipped: boolean;
  continuedFromPreviousDay: boolean;
  tasks: Task[];
};
type Day = { date: string; blocks: Occurrence[]; generalList: Task[] };
type Failure = { error: { code: string } };

/** Zones 25 hours apart, so their calendar dates always differ. */
const AHEAD = 'Pacific/Kiritimati';
const BEHIND = 'Pacific/Pago_Pago';

describe('Skipping and deleting a block occurrence (e2e)', () => {
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
      'TRUNCATE users, sessions, session_refresh_tokens, email_sign_in_codes, block_series, block_occurrence_exceptions, tasks, task_ledger_entries RESTART IDENTITY CASCADE',
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

  async function createTask(body: object): Promise<Task> {
    const res = await http()
      .post('/api/v1/tasks')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body)
      .expect(201);
    return (res.body as { data: Task }).data;
  }

  async function setDone(id: string) {
    await http()
      .patch(`/api/v1/tasks/${id}/done`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ done: true })
      .expect(200);
  }

  function skip(seriesId: string, date: string, token = accessToken) {
    return http()
      .post(`/api/v1/blocks/${seriesId}/occurrences/${date}/skip`)
      .set('Authorization', `Bearer ${token}`);
  }

  function unskip(seriesId: string, date: string, token = accessToken) {
    return http()
      .delete(`/api/v1/blocks/${seriesId}/occurrences/${date}/skip`)
      .set('Authorization', `Bearer ${token}`);
  }

  function remove(
    seriesId: string,
    date: string,
    scope?: string,
    token = accessToken,
  ) {
    return http()
      .delete(`/api/v1/blocks/${seriesId}/occurrences/${date}`)
      .query(scope === undefined ? {} : { scope })
      .set('Authorization', `Bearer ${token}`);
  }

  /** The start dates of the series' occurrences listed from `from` to `to`. */
  async function occurrenceDates(
    seriesId: string,
    from: string,
    to: string,
  ): Promise<string[]> {
    const res = await http()
      .get('/api/v1/days')
      .query({ from, to })
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    return (res.body as { data: { items: Day[] } }).data.items.flatMap((day) =>
      day.blocks
        .filter((b) => b.seriesId === seriesId && !b.continuedFromPreviousDay)
        .map((b) => b.date),
    );
  }

  async function seriesRow(
    seriesId: string,
  ): Promise<{ until: string | null; version: number } | undefined> {
    const { rows } = await pool.query<{
      until: string | null;
      version: number;
    }>(
      "SELECT to_char(until, 'YYYY-MM-DD') AS until, version FROM block_series WHERE id = $1",
      [seriesId],
    );
    return rows[0];
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
      "SELECT to_char(day, 'YYYY-MM-DD') AS day, outcome FROM task_ledger_entries ORDER BY day, outcome",
    );
    return rows;
  }

  function codeOf(res: { body: unknown }): string {
    return (res.body as Failure).error.code;
  }

  it('skips one occurrence and moves its open tasks to the general list', async () => {
    const seriesId = await postBlock({
      date: future,
      recurrence: { kind: 'daily' },
    });
    const open = await createTask({
      title: 'Open',
      date: future,
      blockSeriesId: seriesId,
    });
    const done = await createTask({
      title: 'Done',
      date: future,
      blockSeriesId: seriesId,
    });
    await setDone(done.id);

    const res = await skip(seriesId, future).expect(200);

    expect(res.body).toEqual({ data: { movedTaskCount: 1 } });
    const day = await getDay(future);
    expect(day.blocks).toHaveLength(1);
    expect(day.blocks[0]).toMatchObject({ skipped: true });
    expect(day.blocks[0].tasks.map((t) => t.title)).toEqual(['Done']);
    expect(day.generalList).toEqual([
      expect.objectContaining({
        id: open.id,
        date: future,
        blockSeriesId: null,
        carryCount: 0,
        version: open.version + 1,
      }),
    ]);
    // Only that occurrence.
    const next = await getDay(addDays(future, 1));
    expect(next.blocks[0]).toMatchObject({ skipped: false });
    expect(await ledger()).toEqual([{ day: future, outcome: 'completed' }]);
  });

  it('answers a second skip with 200 and nothing moved', async () => {
    const seriesId = await postBlock({ date: future });
    await createTask({ title: 'A', date: future, blockSeriesId: seriesId });
    await skip(seriesId, future).expect(200);

    const res = await skip(seriesId, future).expect(200);

    expect(res.body).toEqual({ data: { movedTaskCount: 0 } });
    expect((await getDay(future)).blocks[0]).toMatchObject({ skipped: true });
  });

  it('un-skips, leaving moved tasks where they went, and un-skipping again is 204', async () => {
    const seriesId = await postBlock({ date: future });
    await createTask({ title: 'A', date: future, blockSeriesId: seriesId });
    await skip(seriesId, future).expect(200);

    const res = await unskip(seriesId, future).expect(204);
    await unskip(seriesId, future).expect(204);

    expect(res.body).toEqual({});
    const day = await getDay(future);
    expect(day.blocks[0]).toMatchObject({ skipped: false, tasks: [] });
    expect(day.generalList.map((t) => t.title)).toEqual(['A']);
  });

  it('marks a skipped midnight-crossing block’s tail skipped too', async () => {
    const seriesId = await postBlock({
      date: future,
      startMin: 1320,
      endMin: 120,
    });

    await skip(seriesId, future).expect(200);

    const next = await getDay(addDays(future, 1));
    expect(next.blocks).toEqual([
      expect.objectContaining({
        date: future,
        continuedFromPreviousDay: true,
        skipped: true,
      }),
    ]);
  });

  it('carries open tasks in a closed day’s occurrence forward to today', async () => {
    await setTimeZone(BEHIND);
    const date = todayIn(BEHIND);
    const seriesId = await postBlock({ date });
    const task = await createTask({
      title: 'A',
      date,
      blockSeriesId: seriesId,
    });
    await setTimeZone(AHEAD);
    const today = todayIn(AHEAD);
    const days = daysBetween(date, today);

    const res = await skip(seriesId, date).expect(200);

    expect(res.body).toEqual({ data: { movedTaskCount: 1 } });
    expect((await getDay(today)).generalList).toEqual([
      expect.objectContaining({
        id: task.id,
        date: today,
        blockSeriesId: null,
        carryCount: days,
      }),
    ]);
    expect((await getDay(date)).generalList).toEqual([]);
    expect(await ledger()).toEqual(
      Array.from({ length: days }, (_, i) => ({
        day: addDays(date, i),
        outcome: 'incomplete',
      })),
    );
  });

  it('refuses a date the block does not fall on with 422', async () => {
    const seriesId = await postBlock({ date: future });

    const res = await skip(seriesId, addDays(future, 1)).expect(422);
    const del = await unskip(seriesId, addDays(future, 1)).expect(422);

    expect(codeOf(res)).toBe('BLOCK_NOT_ON_DATE');
    expect(codeOf(del)).toBe('BLOCK_NOT_ON_DATE');
  });

  it('answers 404 for an unknown series or someone else’s', async () => {
    const other = await signIn('other@example.com');
    const theirs = await postBlock({ date: future }, other);
    const unknown = '0192a000-0000-7000-8000-000000000001';

    for (const seriesId of [theirs, unknown]) {
      expect(codeOf(await skip(seriesId, future).expect(404))).toBe(
        'NOT_FOUND',
      );
      expect(codeOf(await unskip(seriesId, future).expect(404))).toBe(
        'NOT_FOUND',
      );
    }
    const { rows } = await pool.query(
      'SELECT 1 FROM block_occurrence_exceptions',
    );
    expect(rows).toEqual([]);
  });

  it('answers 400 for a bad series id or date', async () => {
    const seriesId = await postBlock({ date: future });

    for (const res of [
      await skip('not-a-uuid', future),
      await skip(seriesId, '2026-02-30'),
      await unskip(seriesId, '26-09-24'),
    ]) {
      expect(res.status).toBe(400);
      expect(codeOf(res)).toBe('VALIDATION_FAILED');
    }
  });

  it('answers 401 without a token', async () => {
    const seriesId = await postBlock({ date: future });

    const res = await skip(seriesId, future, 'nope').expect(401);

    expect(codeOf(res)).toBe('TOKEN_INVALID');
  });

  it('refuses a deleted account’s token: 401 to skip, 404 to un-skip', async () => {
    const seriesId = await postBlock({ date: future });
    await http()
      .delete('/api/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    expect(codeOf(await skip(seriesId, future).expect(401))).toBe(
      'TOKEN_INVALID',
    );
    expect(codeOf(await unskip(seriesId, future).expect(404))).toBe(
      'NOT_FOUND',
    );
  });
  describe('DELETE /blocks/{seriesId}/occurrences/{date}', () => {
    it('deletes a block that doesn’t repeat, moving all its tasks to the general list', async () => {
      const seriesId = await postBlock({ date: future });
      const open = await createTask({
        title: 'Open',
        date: future,
        blockSeriesId: seriesId,
      });
      const done = await createTask({
        title: 'Done',
        date: future,
        blockSeriesId: seriesId,
      });
      await setDone(done.id);

      const res = await remove(seriesId, future).expect(200);

      expect(res.body).toEqual({ data: { movedTaskCount: 2 } });
      const day = await getDay(future);
      expect(day.blocks).toEqual([]);
      expect(day.generalList).toEqual([
        expect.objectContaining({
          id: open.id,
          date: future,
          blockSeriesId: null,
          carryCount: 0,
          version: open.version + 1,
        }),
        expect.objectContaining({ id: done.id, done: true, date: future }),
      ]);
      expect(await seriesRow(seriesId)).toBeUndefined();
      expect(await ledger()).toEqual([{ day: future, outcome: 'completed' }]);
    });

    it('ignores scope for a block that doesn’t repeat', async () => {
      const seriesId = await postBlock({ date: future });

      await remove(seriesId, future, 'series').expect(200);

      expect(await seriesRow(seriesId)).toBeUndefined();
    });

    it('answers a retry with 404', async () => {
      const oneOff = await postBlock({ date: future });
      const daily = await postBlock({
        date: future,
        recurrence: { kind: 'daily' },
      });
      await remove(oneOff, future).expect(200);
      await remove(daily, future).expect(200);

      expect(codeOf(await remove(oneOff, future).expect(404))).toBe(
        'NOT_FOUND',
      );
      expect(codeOf(await remove(daily, future).expect(404))).toBe('NOT_FOUND');
    });

    it('deletes only this occurrence of a repeating block', async () => {
      const seriesId = await postBlock({
        date: future,
        recurrence: { kind: 'daily' },
      });
      const task = await createTask({
        title: 'A',
        date: addDays(future, 1),
        blockSeriesId: seriesId,
      });

      const res = await remove(seriesId, addDays(future, 1), 'onlyThis').expect(
        200,
      );

      expect(res.body).toEqual({ data: { movedTaskCount: 1 } });
      expect(
        await occurrenceDates(seriesId, future, addDays(future, 2)),
      ).toEqual([future, addDays(future, 2)]);
      expect((await getDay(addDays(future, 1))).generalList).toEqual([
        expect.objectContaining({ id: task.id, blockSeriesId: null }),
      ]);
      expect(await seriesRow(seriesId)).toMatchObject({
        until: null,
        version: 0,
      });
    });

    it('treats a deleted occurrence as gone everywhere: 404', async () => {
      const seriesId = await postBlock({
        date: future,
        recurrence: { kind: 'daily' },
      });
      const task = await createTask({ title: 'A', date: future });
      await remove(seriesId, future).expect(200);

      for (const res of [
        await skip(seriesId, future),
        await unskip(seriesId, future),
        await http()
          .post('/api/v1/tasks')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ title: 'B', date: future, blockSeriesId: seriesId }),
        await http()
          .post(`/api/v1/tasks/${task.id}/move`)
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ date: future, blockSeriesId: seriesId }),
      ]) {
        expect(res.status).toBe(404);
        expect(codeOf(res)).toBe('NOT_FOUND');
      }
    });

    it('deletes a skipped occurrence, and it stays deleted', async () => {
      const seriesId = await postBlock({
        date: future,
        recurrence: { kind: 'daily' },
      });
      await skip(seriesId, future).expect(200);

      await remove(seriesId, future).expect(200);

      expect(codeOf(await unskip(seriesId, future).expect(404))).toBe(
        'NOT_FOUND',
      );
      expect(await occurrenceDates(seriesId, future, future)).toEqual([]);
    });

    it('takes a midnight-crossing occurrence’s tail with it', async () => {
      const seriesId = await postBlock({
        date: future,
        startMin: 1320,
        endMin: 120,
        recurrence: { kind: 'daily' },
      });

      await remove(seriesId, future).expect(200);

      const next = await getDay(addDays(future, 1));
      expect(next.blocks).toEqual([
        expect.objectContaining({
          date: addDays(future, 1),
          continuedFromPreviousDay: false,
        }),
      ]);
    });

    it('carries a closed day’s open tasks to today; done ones stay on that day', async () => {
      await setTimeZone(BEHIND);
      const date = todayIn(BEHIND);
      const seriesId = await postBlock({
        date,
        recurrence: { kind: 'daily' },
      });
      const open = await createTask({
        title: 'Open',
        date,
        blockSeriesId: seriesId,
      });
      const done = await createTask({
        title: 'Done',
        date,
        blockSeriesId: seriesId,
      });
      await setDone(done.id);
      await setTimeZone(AHEAD);
      const today = todayIn(AHEAD);
      const days = daysBetween(date, today);

      const res = await remove(seriesId, date).expect(200);

      expect(res.body).toEqual({ data: { movedTaskCount: 2 } });
      expect((await getDay(today)).generalList).toEqual([
        expect.objectContaining({
          id: open.id,
          date: today,
          blockSeriesId: null,
          carryCount: days,
        }),
      ]);
      expect((await getDay(date)).generalList).toEqual([
        expect.objectContaining({ id: done.id, blockSeriesId: null }),
      ]);
      expect(await ledger()).toEqual(
        [
          { day: date, outcome: 'completed' },
          ...Array.from({ length: days }, (_, i) => ({
            day: addDays(date, i),
            outcome: 'incomplete',
          })),
        ].sort((a, b) =>
          a.day === b.day
            ? a.outcome.localeCompare(b.outcome)
            : a.day.localeCompare(b.day),
        ),
      );
    });

    it('with series from a future date, ends the series before today', async () => {
      const today = todayIn('UTC');
      const start = addDays(today, -3);
      const seriesId = await postBlock({
        date: start,
        recurrence: { kind: 'daily' },
      });
      const task = await createTask({
        title: 'A',
        date: addDays(today, 1),
        blockSeriesId: seriesId,
      });

      const res = await remove(seriesId, future, 'series').expect(200);

      expect(res.body).toEqual({ data: { movedTaskCount: 1 } });
      expect(
        await occurrenceDates(seriesId, start, addDays(future, 2)),
      ).toEqual([start, addDays(start, 1), addDays(start, 2)]);
      expect(await seriesRow(seriesId)).toEqual({
        until: addDays(today, -1),
        version: 1,
      });
      expect((await getDay(addDays(today, 1))).generalList).toEqual([
        expect.objectContaining({ id: task.id, blockSeriesId: null }),
      ]);
      // The series now ends before the date: the rule no longer lands there.
      expect(codeOf(await remove(seriesId, future, 'series').expect(422))).toBe(
        'BLOCK_NOT_ON_DATE',
      );
    });

    it('with series from a past date, deletes that occurrence too', async () => {
      const today = todayIn('UTC');
      const start = addDays(today, -3);
      const seriesId = await postBlock({
        date: start,
        recurrence: { kind: 'daily' },
      });

      await remove(seriesId, addDays(start, 1), 'series').expect(200);

      expect(await occurrenceDates(seriesId, start, addDays(today, 2))).toEqual(
        [start, addDays(start, 2)],
      );
      expect(await seriesRow(seriesId)).toEqual({
        until: addDays(today, -1),
        version: 1,
      });
    });

    it('with series, deletes the series outright when nothing before today is left', async () => {
      const today = todayIn('UTC');
      const fromToday = await postBlock({
        date: today,
        recurrence: { kind: 'daily' },
      });
      const fromYesterday = await postBlock({
        date: addDays(today, -1),
        recurrence: { kind: 'daily' },
      });

      await remove(fromToday, future, 'series').expect(200);
      await remove(fromYesterday, addDays(today, -1), 'series').expect(200);

      expect(await seriesRow(fromToday)).toBeUndefined();
      expect(await seriesRow(fromYesterday)).toBeUndefined();
    });

    it('refuses a date the block does not fall on with 422', async () => {
      const seriesId = await postBlock({ date: future });

      const res = await remove(seriesId, addDays(future, 1)).expect(422);

      expect(codeOf(res)).toBe('BLOCK_NOT_ON_DATE');
    });

    it('answers 404 for an unknown series or someone else’s', async () => {
      const other = await signIn('other@example.com');
      const theirs = await postBlock({ date: future }, other);

      for (const seriesId of [theirs, '0192a000-0000-7000-8000-000000000001']) {
        expect(codeOf(await remove(seriesId, future).expect(404))).toBe(
          'NOT_FOUND',
        );
      }
      expect(await seriesRow(theirs)).toBeDefined();
    });

    it('answers 400 for a bad id, date or scope', async () => {
      const seriesId = await postBlock({ date: future });

      for (const res of [
        await remove('not-a-uuid', future),
        await remove(seriesId, '2026-02-30'),
        await remove(seriesId, future, 'thisAndFuture'),
      ]) {
        expect(res.status).toBe(400);
        expect(codeOf(res)).toBe('VALIDATION_FAILED');
      }
    });

    it('answers 401 without a token, and to a deleted account’s token', async () => {
      const seriesId = await postBlock({ date: future });
      expect(codeOf(await remove(seriesId, future, undefined, 'nope'))).toBe(
        'TOKEN_INVALID',
      );
      await http()
        .delete('/api/v1/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      expect(codeOf(await remove(seriesId, future).expect(401))).toBe(
        'TOKEN_INVALID',
      );
    });
  });
});
