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

type Occurrence = {
  seriesId: string;
  date: string;
  name: string;
  startMin: number;
  continuedFromPreviousDay: boolean;
};
type Day = { date: string; blocks: Occurrence[]; generalList: unknown[] };

describe('GET /days (e2e)', () => {
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
      'TRUNCATE users, sessions, session_refresh_tokens, email_sign_in_codes, block_series RESTART IDENTITY CASCADE',
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
      .send({ startMin: 540, endMin: 600, alert: false, ...body })
      .expect(201);
    return (res.body as { data: Occurrence }).data;
  }

  function getDay(path: string, token = accessToken) {
    return http()
      .get(`/api/v1/days${path}`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function namesOn(date: string): Promise<string[]> {
    const res = await getDay(`/${date}`).expect(200);
    return (res.body as { data: Day }).data.blocks.map((b) =>
      b.continuedFromPreviousDay ? `${b.name} (tail)` : b.name,
    );
  }

  it('returns an empty day', async () => {
    const res = await getDay('/2026-09-24').expect(200);
    expect(res.body).toEqual({
      data: { date: '2026-09-24', blocks: [], generalList: [] },
    });
  });

  it('returns a one-off block on its date only, as POST /blocks did', async () => {
    const created = await postBlock({ name: 'Deep work', date: '2026-09-24' });

    const res = await getDay('/2026-09-24').expect(200);
    expect((res.body as { data: Day }).data.blocks).toEqual([created]);
    expect(await namesOn('2026-09-25')).toEqual([]);
    expect(await namesOn('2026-09-23')).toEqual([]);
  });

  it('expands daily, weekly and monthly repeats', async () => {
    // 2026-09-24 is a Thursday.
    await postBlock({
      name: 'Daily',
      date: '2026-09-24',
      recurrence: { kind: 'daily', until: '2026-09-30' },
    });
    await postBlock({
      name: 'Mondays',
      date: '2026-09-24',
      recurrence: { kind: 'weekly', weekdays: [1] },
    });
    await postBlock({
      name: 'The 31st',
      date: '2026-09-24',
      recurrence: { kind: 'monthly', monthDays: [31] },
    });

    // The anchor is not a Monday, so Mondays starts on the 28th.
    expect(await namesOn('2026-09-24')).toEqual(['Daily']);
    expect(await namesOn('2026-09-28')).toEqual(['Daily', 'Mondays']);
    // REC-02: September has no 31st.
    expect(await namesOn('2026-09-30')).toEqual(['Daily', 'The 31st']);
    expect(await namesOn('2026-10-01')).toEqual([]);
    expect(await namesOn('2026-10-31')).toEqual(['The 31st']);
  });

  it('shows a midnight-crossing block’s tail the next day (BLK-04)', async () => {
    const late = await postBlock({
      name: 'Late shift',
      date: '2026-09-24',
      startMin: 1320,
      endMin: 120,
    });
    await postBlock({
      name: 'Ends at midnight',
      date: '2026-09-24',
      startMin: 1320,
      endMin: 0,
    });
    await postBlock({
      name: 'Morning',
      date: '2026-09-25',
      startMin: 0,
      endMin: 60,
    });

    const res = await getDay('/2026-09-25').expect(200);
    const blocks = (res.body as { data: Day }).data.blocks;

    expect(blocks.map((b) => b.name)).toEqual(['Late shift', 'Morning']);
    expect(blocks[0]).toEqual({
      ...late,
      date: '2026-09-24',
      continuedFromPreviousDay: true,
    });
    expect(await namesOn('2026-09-26')).toEqual([]);
  });

  it('shows a repeating block’s tail the day after its until', async () => {
    await postBlock({
      name: 'Night',
      date: '2026-09-24',
      startMin: 1380,
      endMin: 60,
      recurrence: { kind: 'daily', until: '2026-09-25' },
    });

    expect(await namesOn('2026-09-24')).toEqual(['Night']);
    expect(await namesOn('2026-09-25')).toEqual(['Night (tail)', 'Night']);
    expect(await namesOn('2026-09-26')).toEqual(['Night (tail)']);
    expect(await namesOn('2026-09-27')).toEqual([]);
  });

  it('orders a day by start time, then name', async () => {
    await postBlock({
      name: 'B',
      date: '2026-09-24',
      startMin: 600,
      endMin: 660,
    });
    await postBlock({
      name: 'Z',
      date: '2026-09-24',
      startMin: 540,
      endMin: 600,
    });
    await postBlock({
      name: 'A',
      date: '2026-09-24',
      startMin: 600,
      endMin: 700,
    });

    expect(await namesOn('2026-09-24')).toEqual(['Z', 'A', 'B']);
  });

  it('does not show another user’s blocks', async () => {
    const theirToken = await signIn('them@example.com');
    await postBlock({ name: 'Theirs', date: '2026-09-24' }, theirToken);

    expect(await namesOn('2026-09-24')).toEqual([]);
  });

  it('returns a range of days, both ends included', async () => {
    await postBlock({
      name: 'Daily',
      date: '2026-09-25',
      recurrence: { kind: 'daily' },
    });

    const res = await getDay('?from=2026-09-24&to=2026-09-26').expect(200);
    const items = (res.body as { data: { items: Day[] } }).data.items;

    expect(items.map((d) => [d.date, d.blocks.map((b) => b.date)])).toEqual([
      ['2026-09-24', []],
      ['2026-09-25', ['2026-09-25']],
      ['2026-09-26', ['2026-09-26']],
    ]);
  });

  it('allows a 14-day range', async () => {
    const res = await getDay('?from=2026-09-24&to=2026-10-07').expect(200);
    expect((res.body as { data: { items: Day[] } }).data.items).toHaveLength(
      14,
    );
  });

  it.each([
    ['an impossible date', '/2026-02-30'],
    ['a malformed date', '/today'],
    ['a range over 14 days', '?from=2026-09-24&to=2026-10-08'],
    ['a range ending before it starts', '?from=2026-09-24&to=2026-09-23'],
    ['a range with no end', '?from=2026-09-24'],
  ])('refuses %s', async (_, path) => {
    const res = await getDay(path).expect(400);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('needs an access token', async () => {
    const res = await http().get('/api/v1/days/2026-09-24').expect(401);
    expect(res.body).toEqual({
      error: { code: 'TOKEN_INVALID', message: anyString },
    });
  });
});
