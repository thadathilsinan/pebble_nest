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

type Occurrence = { seriesId: string; name: string };

describe('POST /blocks (e2e)', () => {
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

  function postBlock(body: object, token = accessToken) {
    return http()
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  const deepWork = {
    name: '  Deep work ',
    date: '2026-09-24',
    startMin: 540,
    endMin: 720,
    alert: true,
  };

  it('creates a one-off block and returns its occurrence', async () => {
    const res = await postBlock(deepWork).expect(201);

    expect(res.body).toEqual({
      data: {
        seriesId: anyString,
        seriesVersion: 0,
        date: '2026-09-24',
        name: 'Deep work',
        startMin: 540,
        endMin: 720,
        alert: true,
        skipped: false,
        recurrence: { kind: 'none', weekdays: [], monthDays: [], until: null },
        trace: null,
        continuedFromPreviousDay: false,
        tasks: [],
        openCount: 0,
        totalCount: 0,
      },
    });
  });

  it('fills an empty weekly repeat with the date’s weekday', async () => {
    const res = await postBlock({
      ...deepWork,
      recurrence: { kind: 'weekly', until: '2026-12-31' },
    }).expect(201);

    expect(
      (res.body as { data: { recurrence: unknown } }).data.recurrence,
    ).toEqual({
      kind: 'weekly',
      weekdays: [4],
      monthDays: [],
      until: '2026-12-31',
    });
  });

  it('accepts a block crossing midnight and a full-day block', async () => {
    await postBlock({ ...deepWork, startMin: 1350, endMin: 30 }).expect(201);
    await postBlock({ ...deepWork, startMin: 540, endMin: 540 }).expect(201);
  });

  it('refuses a block shorter than 5 minutes, across midnight too', async () => {
    for (const [startMin, endMin] of [
      [540, 544],
      [1438, 2],
    ]) {
      const res = await postBlock({ ...deepWork, startMin, endMin }).expect(
        422,
      );
      expect(res.body).toEqual({
        error: { code: 'BLOCK_TOO_SHORT', message: anyString },
      });
    }
  });

  it.each([
    ['a blank name', { name: '   ' }],
    ['a name over 60 characters', { name: 'x'.repeat(61) }],
    ['an impossible date', { date: '2026-02-30' }],
    ['a minute past the day', { endMin: 1440 }],
    ['no alert', { alert: undefined }],
    [
      'weekdays on a daily repeat',
      { recurrence: { kind: 'daily', weekdays: [1] } },
    ],
    [
      'until before the date',
      { recurrence: { kind: 'daily', until: '2026-09-23' } },
    ],
    ['a malformed idempotency key', { idempotencyKey: 'retry-1' }],
    ['an unknown field', { colour: 'red' }],
  ])('refuses %s', async (_, change) => {
    const res = await postBlock({ ...deepWork, ...change }).expect(400);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('replays a retry with the same idempotency key', async () => {
    const idempotencyKey = '0192a000-0000-7000-8000-00000000000a';

    const first = await postBlock({ ...deepWork, idempotencyKey }).expect(201);
    const retry = await postBlock({
      ...deepWork,
      name: 'Changed my mind',
      idempotencyKey,
    }).expect(201);

    expect(retry.body).toEqual(first.body);
    const { rows } = await pool.query('SELECT 1 FROM block_series');
    expect(rows).toHaveLength(1);
  });

  it('does not hand one user’s block to another holding the same key', async () => {
    const idempotencyKey = '0192a000-0000-7000-8000-00000000000b';
    const theirToken = await signIn('them@example.com');

    const mine = await postBlock({ ...deepWork, idempotencyKey }).expect(201);
    const theirs = await postBlock(
      { ...deepWork, name: 'Theirs', idempotencyKey },
      theirToken,
    ).expect(201);

    const a = (mine.body as { data: Occurrence }).data;
    const b = (theirs.body as { data: Occurrence }).data;
    expect(b.seriesId).not.toBe(a.seriesId);
    expect(b.name).toBe('Theirs');
  });

  it('needs an access token', async () => {
    const res = await http().post('/api/v1/blocks').send(deepWork).expect(401);
    expect(res.body).toEqual({
      error: { code: 'TOKEN_INVALID', message: anyString },
    });
  });

  it('is removed with the account', async () => {
    await postBlock(deepWork).expect(201);

    await http()
      .delete('/api/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    const { rows } = await pool.query('SELECT 1 FROM block_series');
    expect(rows).toHaveLength(0);
  });
});
