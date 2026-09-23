import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { MAILER, type Mailer } from './../src/auth/mailer/mailer';
import { configureApp } from './../src/bootstrap/configure-app';
import { ENV } from './../src/config/config.module';
import type { Env } from './../src/config/env.schema';
import { POOL } from './../src/database/database.module';

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

describe('Auth guard and GET /me (e2e)', () => {
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

  it('leaves the auth and health routes open', async () => {
    await http()
      .post('/api/v1/auth/email/code')
      .send({ email: 'open@example.com' })
      .expect(204);
    await http().get('/health/live').expect(200);
  });
});
