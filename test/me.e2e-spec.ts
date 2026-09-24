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

type SessionBody = {
  data: {
    accessToken: string;
    refreshToken: string;
    profile: { id: string };
  };
};

describe('Auth guard and /me (e2e)', () => {
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

    // Mirrors `main.ts`; see the note in auth.e2e-spec.ts.
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

  function getMe(authorization?: string) {
    const req = http().get('/api/v1/me');
    return authorization === undefined
      ? req
      : req.set('Authorization', authorization);
  }

  function expectTokenInvalid(res: request.Response) {
    expect(res.body).toEqual({
      error: { code: 'TOKEN_INVALID', message: anyString },
    });
  }

  it('returns the caller’s profile', async () => {
    const session = await signIn();

    const res = await getMe(`Bearer ${session.accessToken}`)
      .expect(200)
      .expect('X-Request-Id', /./);

    expect(res.body).toEqual({
      data: {
        id: session.profile.id,
        version: 0,
        email: 'me@example.com',
        name: null,
        signInMethod: 'email',
        weekStart: 'monday',
        timeFormat: 'system',
        timeZone: null,
        firstRecordedDay: null,
        hasAnyRecord: false,
      },
    });
  });

  it('refuses a request with no token', async () => {
    expectTokenInvalid(await getMe().expect(401));
  });

  it('refuses a malformed token', async () => {
    expectTokenInvalid(await getMe('Bearer nonsense').expect(401));
  });

  it('refuses an expired token', async () => {
    const session = await signIn();
    const { sid } = app
      .get(JwtService)
      .decode<{ sid: string }>(session.accessToken);
    const expired = await app
      .get(JwtService)
      .signAsync(
        { sid, exp: Math.floor(Date.now() / 1000) - 1 },
        { subject: session.profile.id },
      );

    expectTokenInvalid(await getMe(`Bearer ${expired}`).expect(401));
  });

  it('refuses a token signed with another secret', async () => {
    const session = await signIn();
    const { sid } = app
      .get(JwtService)
      .decode<{ sid: string }>(session.accessToken);
    const forged = await app
      .get(JwtService)
      .signAsync(
        { sid },
        { subject: session.profile.id, expiresIn: 60, secret: 'f'.repeat(32) },
      );

    expectTokenInvalid(await getMe(`Bearer ${forged}`).expect(401));
  });

  it('refuses a still-valid access token once its session is signed out', async () => {
    const session = await signIn();
    await http()
      .post('/api/v1/auth/sign-out')
      .send({ refreshToken: session.refreshToken })
      .expect(204);

    expectTokenInvalid(
      await getMe(`Bearer ${session.accessToken}`).expect(401),
    );
  });

  it('refuses a still-valid access token once its session has expired', async () => {
    const session = await signIn();
    await pool.query(
      "UPDATE sessions SET expires_at = now() - interval '1 second'",
    );

    expectTokenInvalid(
      await getMe(`Bearer ${session.accessToken}`).expect(401),
    );
  });

  describe('PATCH /me', () => {
    function patchMe(session: SessionBody['data'], body: object) {
      return http()
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send(body);
    }

    function expectValidationFailed(res: request.Response, path: string) {
      expect(res.body).toMatchObject({
        error: {
          code: 'VALIDATION_FAILED',
          details: [expect.objectContaining({ path })],
        },
      });
    }

    it('edits the profile and returns it with the next version', async () => {
      const session = await signIn();

      const res = await patchMe(session, {
        version: 0,
        name: '  Sinan  ',
        weekStart: 'sunday',
        timeFormat: 'h24',
      }).expect(200);

      expect(res.body).toEqual({
        data: {
          id: session.profile.id,
          version: 1,
          email: 'me@example.com',
          name: 'Sinan',
          signInMethod: 'email',
          weekStart: 'sunday',
          timeFormat: 'h24',
          timeZone: null,
          firstRecordedDay: null,
          hasAnyRecord: false,
        },
      });
      await getMe(`Bearer ${session.accessToken}`)
        .expect(200)
        .expect((r) =>
          expect(r.body).toMatchObject({ data: { name: 'Sinan', version: 1 } }),
        );
    });

    it('refuses a stale version with the current profile in meta', async () => {
      const session = await signIn();
      await patchMe(session, { version: 0, name: 'First' }).expect(200);

      const res = await patchMe(session, {
        version: 0,
        name: 'Second',
      }).expect(409);

      expect(res.body).toEqual({
        error: {
          code: 'STALE_VERSION',
          message: anyString,
          meta: {
            current: expect.objectContaining({
              id: session.profile.id,
              version: 1,
              name: 'First',
              signInMethod: 'email',
            }) as unknown,
          },
        },
      });
    });

    it('leaves the version alone when nothing changes', async () => {
      const session = await signIn();

      const res = await patchMe(session, {
        version: 0,
        weekStart: 'monday',
      }).expect(200);

      expect(res.body).toMatchObject({ data: { version: 0 } });
    });

    it('clears the name for a blank string or null', async () => {
      const session = await signIn();
      await patchMe(session, { version: 0, name: 'Sinan' }).expect(200);

      await patchMe(session, { version: 1, name: '   ' })
        .expect(200)
        .expect((r) =>
          expect(r.body).toMatchObject({ data: { name: null, version: 2 } }),
        );
      await patchMe(session, { version: 2, name: 'Again' }).expect(200);
      await patchMe(session, { version: 3, name: null })
        .expect(200)
        .expect((r) =>
          expect(r.body).toMatchObject({ data: { name: null, version: 4 } }),
        );
    });

    it('records a time zone sent alone without a version', async () => {
      const session = await signIn();
      await patchMe(session, { version: 0, name: 'Moved on' }).expect(200);

      // No version, and a version that is stale, both succeed.
      await patchMe(session, { timeZone: 'Asia/Kolkata' })
        .expect(200)
        .expect((r) =>
          expect(r.body).toMatchObject({
            data: { timeZone: 'Asia/Kolkata', version: 2 },
          }),
        );
      await patchMe(session, { version: 0, timeZone: 'Asia/Kolkata' })
        .expect(200)
        .expect((r) => expect(r.body).toMatchObject({ data: { version: 2 } }));
    });

    it('requires a version for anything but a lone time zone', async () => {
      const session = await signIn();

      expectValidationFailed(
        await patchMe(session, { name: 'Sinan' }).expect(400),
        'version',
      );
      expectValidationFailed(
        await patchMe(session, {
          timeZone: 'Asia/Kolkata',
          weekStart: 'sunday',
        }).expect(400),
        'version',
      );
      expectValidationFailed(await patchMe(session, {}).expect(400), 'version');
    });

    it('refuses a name over 80 characters', async () => {
      const session = await signIn();

      expectValidationFailed(
        await patchMe(session, { version: 0, name: 'x'.repeat(81) }).expect(
          400,
        ),
        'name',
      );
      await patchMe(session, { version: 0, name: 'x'.repeat(80) }).expect(200);
    });

    it('refuses an unknown zone and a raw offset', async () => {
      const session = await signIn();

      for (const timeZone of ['Mars/Olympus_Mons', '+05:30', '']) {
        expectValidationFailed(
          await patchMe(session, { timeZone }).expect(400),
          'timeZone',
        );
      }
    });

    it('refuses an unknown field and a bad enum value', async () => {
      const session = await signIn();

      expectValidationFailed(
        await patchMe(session, { version: 0, email: 'x@example.com' }).expect(
          400,
        ),
        '',
      );
      expectValidationFailed(
        await patchMe(session, { version: 0, weekStart: 'friday' }).expect(400),
        'weekStart',
      );
    });

    it('refuses a still-valid access token once its session is signed out', async () => {
      const session = await signIn();
      await http()
        .post('/api/v1/auth/sign-out')
        .send({ refreshToken: session.refreshToken })
        .expect(204);

      expectTokenInvalid(
        await patchMe(session, { timeZone: 'Asia/Kolkata' }).expect(401),
      );
    });
  });

  describe('DELETE /me', () => {
    function deleteMe(session: SessionBody['data']) {
      return http()
        .delete('/api/v1/me')
        .set('Authorization', `Bearer ${session.accessToken}`);
    }

    async function count(table: string): Promise<number> {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table}`,
      );
      return rows[0]?.n ?? 0;
    }

    it('deletes the account and every device’s session', async () => {
      const session = await signIn();
      // A second device: the code's cooldown has to pass before another send.
      await pool.query(
        "UPDATE email_sign_in_codes SET last_sent_at = now() - interval '1 minute'",
      );
      const other = await signIn();

      const res = await deleteMe(session).expect(204);

      expect(res.text).toBe('');
      expect(await count('users')).toBe(0);
      expect(await count('sessions')).toBe(0);
      expect(await count('email_sign_in_codes')).toBe(0);
      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: other.refreshToken })
        .expect(401);
    });

    it('leaves other accounts alone', async () => {
      const session = await signIn();
      await http()
        .post('/api/v1/auth/email/code')
        .send({ email: 'other@example.com' })
        .expect(204);
      await http()
        .post('/api/v1/auth/email/verify')
        .send({
          email: 'other@example.com',
          code: mailer.lastCodeFor('other@example.com'),
        })
        .expect(200);

      await deleteMe(session).expect(204);

      const { rows } = await pool.query<{ email: string }>(
        'SELECT email FROM users',
      );
      expect(rows).toEqual([{ email: 'other@example.com' }]);
      expect(await count('sessions')).toBe(1);
      expect(await count('email_sign_in_codes')).toBe(1);
    });

    it('answers a retry with 401, since the session went with the account', async () => {
      const session = await signIn();
      await deleteMe(session).expect(204);

      expectTokenInvalid(await deleteMe(session).expect(401));
    });

    it('opens a fresh account when the same email signs in again', async () => {
      const session = await signIn();
      await deleteMe(session).expect(204);

      const again = await signIn();

      expect(again.profile.id).not.toBe(session.profile.id);
    });

    it('refuses a still-valid access token once its session is signed out', async () => {
      const session = await signIn();
      await http()
        .post('/api/v1/auth/sign-out')
        .send({ refreshToken: session.refreshToken })
        .expect(204);

      expectTokenInvalid(await deleteMe(session).expect(401));
      expect(await count('users')).toBe(1);
    });
  });

  it('leaves the auth and health routes open', async () => {
    await http()
      .post('/api/v1/auth/email/code')
      .send({ email: 'open@example.com' })
      .expect(204);
    await http().get('/health/live').expect(200);
  });
});
