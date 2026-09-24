import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { GOOGLE_ID_TOKENS } from '../src/auth/google/google-id-tokens';
import type { IdTokenCheck, IdTokens } from '../src/auth/id-tokens/id-tokens';
import { MAILER, type Mailer } from '../src/auth/mailer/mailer';
import { configureApp } from '../src/core/bootstrap/configure-app';
import { ENV } from '../src/core/config/config.module';
import type { Env } from '../src/core/config/env.schema';
import { POOL } from '../src/core/database/database.module';
import type { ApiError, ApiFailure } from '../src/core/http/envelope';

function errorOf(res: request.Response): ApiError {
  return (res.body as ApiFailure).error;
}

interface SessionBody {
  accessToken: string;
  refreshToken: string;
  isNewAccount: boolean;
  profile: { id: string; version: number; name: string | null };
}

function sessionOf(res: request.Response): SessionBody {
  return (res.body as { data: SessionBody }).data;
}

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

/**
 * Stands in for Google: each token string is given the verdict a test sets
 * for it, and any other is invalid. The real verifier has its own spec.
 */
class FakeGoogleIdTokens implements IdTokens {
  readonly verdicts = new Map<string, IdTokenCheck>();
  calls = 0;

  verify(idToken: string): Promise<IdTokenCheck> {
    this.calls += 1;
    return Promise.resolve(
      this.verdicts.get(idToken) ?? { outcome: 'invalid' },
    );
  }

  /** A token that proves `email`, with Google's `name` for the person. */
  tokenFor(email: string, name: string | null = null): string {
    const token = `google.${this.verdicts.size}.token`;
    this.verdicts.set(token, {
      outcome: 'verified',
      account: { email, name },
      audience: 'ios-client',
    });
    return token;
  }
}

describe('POST /auth/google (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let mailer: FakeMailer;
  let google: FakeGoogleIdTokens;

  async function start(clientIds: string[]): Promise<void> {
    mailer = new FakeMailer();
    google = new FakeGoogleIdTokens();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .overrideProvider(GOOGLE_ID_TOKENS)
      .useValue(google)
      .compile();

    // `.env` leaves Google off; these tests turn it on, or off on purpose.
    // `AuthService` reads the list per request, so setting it before the
    // first request is enough.
    moduleFixture.get<Env>(ENV).GOOGLE_CLIENT_IDS = clientIds;

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
  }

  afterEach(async () => {
    await app.close();
  });

  function http() {
    return request(app.getHttpServer());
  }

  function signInWithGoogle(idToken: string) {
    return http().post('/api/v1/auth/google').send({ idToken });
  }

  async function signInWithEmail(email: string): Promise<SessionBody> {
    await http().post('/api/v1/auth/email/code').send({ email }).expect(204);
    const res = await http()
      .post('/api/v1/auth/email/verify')
      .send({ email, code: mailer.lastCodeFor(email) })
      .expect(200);
    return sessionOf(res);
  }

  describe('with client IDs set', () => {
    beforeEach(() => start(['ios-client', 'web-client']));

    it('opens an account named as Google names the person', async () => {
      const res = await signInWithGoogle(
        google.tokenFor('new@example.com', 'Ada Lovelace'),
      ).expect(200);

      expect(sessionOf(res)).toMatchObject({
        isNewAccount: true,
        profile: {
          version: 0,
          email: 'new@example.com',
          name: 'Ada Lovelace',
          signInMethod: 'google',
          weekStart: 'monday',
        },
      });
    });

    it('signs in to the account email sign-in opened, filling its name (ACC-03)', async () => {
      const byEmail = await signInWithEmail('me@example.com');

      const res = await signInWithGoogle(
        google.tokenFor('me@example.com', 'Ada'),
      ).expect(200);
      const byGoogle = sessionOf(res);

      expect(byGoogle).toMatchObject({
        isNewAccount: false,
        profile: {
          id: byEmail.profile.id,
          version: 1,
          name: 'Ada',
          signInMethod: 'google',
        },
      });

      // The device's session remembers how it signed in; the email device's
      // doesn't change.
      const me = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${byGoogle.accessToken}`)
        .expect(200);
      expect(me.body).toMatchObject({ data: { signInMethod: 'google' } });
      const emailMe = await http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${byEmail.accessToken}`)
        .expect(200);
      expect(emailMe.body).toMatchObject({ data: { signInMethod: 'email' } });
    });

    it('keeps a name the user chose', async () => {
      const byEmail = await signInWithEmail('me@example.com');
      await http()
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${byEmail.accessToken}`)
        .send({ version: 0, name: 'Chosen' })
        .expect(200);

      const res = await signInWithGoogle(
        google.tokenFor('me@example.com', 'From Google'),
      ).expect(200);

      expect(sessionOf(res).profile).toMatchObject({
        name: 'Chosen',
        version: 1,
      });
    });

    it('keeps signInMethod google across a refresh', async () => {
      const first = sessionOf(
        await signInWithGoogle(google.tokenFor('me@example.com')).expect(200),
      );

      const res = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(200);

      expect(res.body).toMatchObject({
        data: { isNewAccount: false, profile: { signInMethod: 'google' } },
      });
    });

    it('answers 401 ID_TOKEN_INVALID for a token Google did not sign for us, opening nothing', async () => {
      const res = await signInWithGoogle('bad.google.token').expect(401);

      expect(errorOf(res).code).toBe('ID_TOKEN_INVALID');
      const { rows } = await pool.query('SELECT 1 FROM users');
      expect(rows).toHaveLength(0);
    });

    it("answers 503 when Google's keys cannot be fetched", async () => {
      google.verdicts.set('down.google.token', { outcome: 'unavailable' });

      const res = await signInWithGoogle('down.google.token').expect(503);

      expect(errorOf(res).code).toBe('SERVICE_UNAVAILABLE');
    });

    it.each([
      ['no idToken', {}],
      ['a token that is not a JWT', { idToken: 'not-a-jwt' }],
      ['an unknown field', { idToken: 'a.b.c', email: 'me@example.com' }],
      ['a token over 8 KB', { idToken: `${'a'.repeat(8192)}.b.c` }],
    ])('answers 400 VALIDATION_FAILED for %s', async (_, body) => {
      const res = await http()
        .post('/api/v1/auth/google')
        .send(body)
        .expect(400);

      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expect(google.calls).toBe(0);
    });
  });

  describe('with no client IDs', () => {
    beforeEach(() => start([]));

    it('answers 503 without checking the token', async () => {
      const res = await signInWithGoogle(
        google.tokenFor('me@example.com'),
      ).expect(503);

      expect(errorOf(res).code).toBe('SERVICE_UNAVAILABLE');
      expect(google.calls).toBe(0);
    });
  });
});
