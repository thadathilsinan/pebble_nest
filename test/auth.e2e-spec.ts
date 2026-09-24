import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { MAILER, type Mailer } from '../src/auth/mailer/mailer';
import { configureApp } from '../src/core/bootstrap/configure-app';
import { ENV } from '../src/core/config/config.module';
import type { Env } from '../src/core/config/env.schema';
import { POOL } from '../src/core/database/database.module';
import type { ApiError, ApiFailure } from '../src/core/http/envelope';

/** `expect.any` is typed `any`; this names what it matches once. */
const anyString: unknown = expect.any(String);

function errorOf(res: request.Response): ApiError {
  return (res.body as ApiFailure).error;
}

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

describe('Email sign-in (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let mailer: FakeMailer;

  beforeEach(async () => {
    mailer = new FakeMailer();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();

    // These three lines mirror `main.ts`, and the mirroring is the point:
    // nothing here executes `main.ts`, so anything applied only there is absent
    // under test. That is not hypothetical — before this, the first spec
    // asserted `GET /` while the running service answered 404 there and served
    // `/api/v1`, and it passed.
    //
    // `bodyParser: false` matters for the same reason it does in production:
    // without it Nest registers its own parsers first and the ones in
    // `configureApp` never see a request. `configureApp` runs before `init()`
    // because that is when routes are registered.
    app = moduleFixture.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, moduleFixture.get<Env>(ENV));
    await app.init();

    pool = moduleFixture.get<Pool>(POOL);
    await pool.query(
      'TRUNCATE users, sessions, session_refresh_tokens, email_sign_in_codes RESTART IDENTITY CASCADE',
    );
  });

  afterEach(async () => {
    await app.close();
  });

  function http() {
    return request(app.getHttpServer());
  }

  // Paths are written out rather than built from `API_PREFIX` and
  // `DEFAULT_VERSION`. Deriving them from the same constants the
  // implementation uses would make the assertions tautological — both sides
  // would move together. The URL is the client contract, so changing it
  // should turn this red.
  function sendCode(email: string) {
    return http().post('/api/v1/auth/email/code').send({ email });
  }

  function verify(email: string, code: string) {
    return http().post('/api/v1/auth/email/verify').send({ email, code });
  }

  /** As if the cooldown had passed, so another code may be sent. */
  async function skipCooldown(): Promise<void> {
    await pool.query(
      "UPDATE email_sign_in_codes SET last_sent_at = last_sent_at - interval '31 seconds'",
    );
  }

  it('sends a code, then signs in with it and opens the account', async () => {
    await sendCode('new@example.com')
      .expect(204)
      .expect('X-Request-Id', /./)
      .expect('');

    const code = mailer.lastCodeFor('new@example.com');
    const res = await verify('new@example.com', code)
      .expect(200)
      .expect('X-Request-Id', /./);

    const session = (res.body as { data: Record<string, unknown> }).data;
    expect(session).toMatchObject({
      accessToken: anyString,
      accessTokenExpiresAt: anyString,
      refreshToken: anyString,
      isNewAccount: true,
      profile: {
        version: 0,
        email: 'new@example.com',
        name: null,
        signInMethod: 'email',
        weekStart: 'monday',
        timeFormat: 'system',
        timeZone: null,
        firstRecordedDay: null,
        hasAnyRecord: false,
      },
    });

    // The access token is a real HS256 JWT naming the user and the session.
    const claims = await app
      .get(JwtService)
      .verifyAsync<{ sub: string; sid: string; exp: number }>(
        session.accessToken as string,
      );
    const profile = session.profile as { id: string };
    expect(claims.sub).toBe(profile.id);
    expect(claims.exp * 1000).toBe(
      Date.parse(session.accessTokenExpiresAt as string),
    );
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM sessions WHERE user_id = $1',
      [profile.id],
    );
    expect(rows).toEqual([{ id: claims.sid }]);
  });

  it('opens the same account on a second sign-in, whatever the case', async () => {
    await sendCode('me@example.com').expect(204);
    const first = await verify(
      'me@example.com',
      mailer.lastCodeFor('me@example.com'),
    ).expect(200);

    await skipCooldown();
    await sendCode('  Me@Example.COM ').expect(204);
    const second = await verify(
      'ME@example.com',
      mailer.lastCodeFor('me@example.com'),
    ).expect(200);

    type Body = { data: { isNewAccount: boolean; profile: { id: string } } };
    expect((second.body as Body).data.isNewAccount).toBe(false);
    expect((second.body as Body).data.profile.id).toBe(
      (first.body as Body).data.profile.id,
    );
  });

  it('counts down wrong codes, then refuses even the right one', async () => {
    await sendCode('me@example.com').expect(204);
    const right = mailer.lastCodeFor('me@example.com');
    const wrong = right === '000000' ? '111111' : '000000';

    for (const attemptsLeft of [4, 3, 2, 1, 0]) {
      await verify('me@example.com', wrong)
        .expect(400)
        .expect((res) => {
          expect(res.body).toEqual({
            error: {
              code: 'CODE_INVALID',
              message: anyString,
              meta: { attemptsLeft },
            },
          });
        });
    }

    await verify('me@example.com', right)
      .expect(429)
      .expect((res) => {
        expect(errorOf(res).code).toBe('CODE_ATTEMPTS_EXHAUSTED');
      });
  });

  it('gives fresh attempts with a new code', async () => {
    await sendCode('me@example.com').expect(204);
    const first = mailer.lastCodeFor('me@example.com');
    const wrong = first === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await verify('me@example.com', wrong).expect(400);
    }

    await skipCooldown();
    await sendCode('me@example.com').expect(204);
    await verify('me@example.com', mailer.lastCodeFor('me@example.com')).expect(
      200,
    );
  });

  it('answers CODE_EXPIRED when no code was sent', async () => {
    await verify('nobody@example.com', '123456')
      .expect(410)
      .expect((res) => {
        expect(errorOf(res).code).toBe('CODE_EXPIRED');
      });
  });

  it('answers CODE_EXPIRED after ten minutes', async () => {
    await sendCode('me@example.com').expect(204);
    await pool.query(
      "UPDATE email_sign_in_codes SET expires_at = now() - interval '1 second'",
    );

    await verify('me@example.com', mailer.lastCodeFor('me@example.com'))
      .expect(410)
      .expect((res) => {
        expect(errorOf(res).code).toBe('CODE_EXPIRED');
      });
  });

  it('signs in only once with one code', async () => {
    await sendCode('me@example.com').expect(204);
    const code = mailer.lastCodeFor('me@example.com');

    await verify('me@example.com', code).expect(200);
    await verify('me@example.com', code)
      .expect(410)
      .expect((res) => {
        expect(errorOf(res).code).toBe('CODE_EXPIRED');
      });
  });

  it('refuses a second send inside 30 seconds, saying when to retry', async () => {
    await sendCode('me@example.com').expect(204);

    await sendCode('me@example.com')
      .expect(429)
      .expect((res) => {
        const { code, meta } = errorOf(res);
        expect(code).toBe('TOO_MANY_REQUESTS');
        expect(meta?.retryAfterSeconds).toBeGreaterThan(0);
        expect(meta?.retryAfterSeconds).toBeLessThanOrEqual(30);
      });
    expect(mailer.sent).toHaveLength(1);
  });

  it('refuses a sixth send in an hour', async () => {
    for (let i = 0; i < 5; i++) {
      await sendCode('me@example.com').expect(204);
      await skipCooldown();
    }

    await sendCode('me@example.com').expect(429);
    expect(mailer.sent).toHaveLength(5);
  });

  it.each([
    ['a malformed email', { email: 'not-an-email' }],
    ['an unknown field', { email: 'me@example.com', extra: 1 }],
  ])('rejects %s', async (_, body) => {
    await http()
      .post('/api/v1/auth/email/code')
      .send(body)
      .expect(400)
      .expect((res) => {
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      });
  });

  it('rejects a code that is not six digits without spending an attempt', async () => {
    await sendCode('me@example.com').expect(204);

    await verify('me@example.com', '12345')
      .expect(400)
      .expect((res) => {
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      });

    const { rows } = await pool.query<{ attempts: number }>(
      'SELECT attempts FROM email_sign_in_codes',
    );
    expect(rows).toEqual([{ attempts: 0 }]);
  });
});

describe('Refresh and sign-out (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let mailer: FakeMailer;

  beforeEach(async () => {
    mailer = new FakeMailer();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();

    // As above: mirrors `main.ts`.
    app = moduleFixture.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, moduleFixture.get<Env>(ENV));
    await app.init();

    pool = moduleFixture.get<Pool>(POOL);
    await pool.query(
      'TRUNCATE users, sessions, session_refresh_tokens, email_sign_in_codes RESTART IDENTITY CASCADE',
    );
  });

  afterEach(async () => {
    await app.close();
  });

  function http() {
    return request(app.getHttpServer());
  }

  type SessionBody = {
    data: {
      accessToken: string;
      refreshToken: string;
      isNewAccount: boolean;
      profile: { id: string; email: string; signInMethod: string };
    };
  };

  async function signIn(): Promise<SessionBody['data']> {
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
    return (res.body as SessionBody).data;
  }

  function refresh(refreshToken: string) {
    return http().post('/api/v1/auth/refresh').send({ refreshToken });
  }

  function signOut(refreshToken: string) {
    return http().post('/api/v1/auth/sign-out').send({ refreshToken });
  }

  function expectTokenInvalid(res: request.Response) {
    expect(res.body).toEqual({
      error: { code: 'TOKEN_INVALID', message: anyString },
    });
  }

  async function sessionCount(): Promise<number> {
    const { rows } = await pool.query('SELECT 1 FROM sessions');
    return rows.length;
  }

  /** As if the grace window had passed since every rotation so far. */
  async function skipGrace(): Promise<void> {
    await pool.query(
      "UPDATE session_refresh_tokens SET retired_at = retired_at - interval '31 seconds'",
    );
  }

  it('swaps a refresh token for a new session on the same device', async () => {
    const first = await signIn();

    const res = await refresh(first.refreshToken)
      .expect(200)
      .expect('X-Request-Id', /./);

    const next = (res.body as SessionBody).data;
    expect(next).toMatchObject({
      accessToken: anyString,
      isNewAccount: false,
      profile: {
        id: first.profile.id,
        email: 'me@example.com',
        signInMethod: 'email',
      },
    });
    expect(next.refreshToken).not.toBe(first.refreshToken);

    const claims = await app
      .get(JwtService)
      .verifyAsync<{ sub: string; sid: string }>(next.accessToken);
    const before = await app
      .get(JwtService)
      .verifyAsync<{ sid: string }>(first.accessToken);
    expect(claims.sub).toBe(first.profile.id);
    expect(claims.sid).toBe(before.sid);

    // And the new token works in turn.
    await refresh(next.refreshToken).expect(200);
  });

  it('accepts a retry with the old token inside the grace window', async () => {
    const first = await signIn();
    await refresh(first.refreshToken).expect(200);

    // The response above was "lost"; the app retries with the old token.
    const retried = await refresh(first.refreshToken).expect(200);

    await refresh((retried.body as SessionBody).data.refreshToken).expect(200);
    expect(await sessionCount()).toBe(1);
  });

  it('revokes the session when an old token is reused after the grace window', async () => {
    const first = await signIn();
    const second = (await refresh(first.refreshToken).expect(200))
      .body as SessionBody;
    await skipGrace();

    await refresh(first.refreshToken).expect(401).expect(expectTokenInvalid);

    // Whoever held the newer token is signed out too.
    await refresh(second.data.refreshToken)
      .expect(401)
      .expect(expectTokenInvalid);
    expect(await sessionCount()).toBe(0);
  });

  it('revokes the session when a token older than the last is reused', async () => {
    const first = await signIn();
    const second = (await refresh(first.refreshToken).expect(200))
      .body as SessionBody;
    await refresh(second.data.refreshToken).expect(200);

    // Inside the window, but not the token retired last.
    await refresh(first.refreshToken).expect(401).expect(expectTokenInvalid);
    expect(await sessionCount()).toBe(0);
  });

  it('refuses an expired session', async () => {
    const first = await signIn();
    await pool.query(
      "UPDATE sessions SET expires_at = now() - interval '1 second'",
    );

    await refresh(first.refreshToken).expect(401).expect(expectTokenInvalid);
  });

  it('refuses a token it never issued', async () => {
    await refresh('x'.repeat(43)).expect(401).expect(expectTokenInvalid);
  });

  it('signs out, after which the token no longer refreshes', async () => {
    const first = await signIn();

    await signOut(first.refreshToken).expect(204).expect('');

    expect(await sessionCount()).toBe(0);
    await refresh(first.refreshToken).expect(401).expect(expectTokenInvalid);
  });

  it('signs out idempotently', async () => {
    const first = await signIn();

    await signOut(first.refreshToken).expect(204);
    await signOut(first.refreshToken).expect(204);
    await signOut('x'.repeat(43)).expect(204);
  });

  it.each([
    ['refresh', '/api/v1/auth/refresh'],
    ['sign-out', '/api/v1/auth/sign-out'],
  ])('%s rejects a malformed body', async (_, path) => {
    for (const body of [
      {},
      { refreshToken: 'short' },
      { refreshToken: 'x'.repeat(43), extra: 1 },
    ]) {
      await http()
        .post(path)
        .send(body)
        .expect(400)
        .expect((res) => {
          expect(errorOf(res).code).toBe('VALIDATION_FAILED');
        });
    }
  });
});
