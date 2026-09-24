import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import type { AppleGrant } from '../src/auth/apple/apple-grants.repository';
import { APPLE_ID_TOKENS } from '../src/auth/apple/apple-id-tokens';
import {
  APPLE_TOKENS,
  type AppleCodeExchange,
  type AppleTokens,
} from '../src/auth/apple/apple-tokens';
import type { IdTokenCheck, IdTokens } from '../src/auth/id-tokens/id-tokens';
import { MAILER, type Mailer } from '../src/auth/mailer/mailer';
import { configureApp } from '../src/core/bootstrap/configure-app';
import { ENV } from '../src/core/config/config.module';
import type { Env } from '../src/core/config/env.schema';
import { POOL } from '../src/core/database/database.module';
import type { ApiError, ApiFailure } from '../src/core/http/envelope';

const CLIENT_ID = 'com.pebble.app';

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
 * Stands in for Apple's identity tokens: each token string is given the
 * verdict a test sets for it, and any other is invalid. The real verifier
 * has its own spec.
 */
class FakeAppleIdTokens implements IdTokens {
  readonly verdicts = new Map<string, IdTokenCheck>();
  calls = 0;

  verify(identityToken: string): Promise<IdTokenCheck> {
    this.calls += 1;
    return Promise.resolve(
      this.verdicts.get(identityToken) ?? { outcome: 'invalid' },
    );
  }

  /** A token that proves `email`. Apple's carry no name. */
  tokenFor(email: string): string {
    const token = `apple.${this.verdicts.size}.token`;
    this.verdicts.set(token, {
      outcome: 'verified',
      account: { email, name: null },
      audience: CLIENT_ID,
    });
    return token;
  }
}

/**
 * Stands in for Apple's token endpoint: a code exchanges for
 * `refresh-<code>` unless a test sets another answer, and revokes are
 * recorded.
 */
class FakeAppleTokens implements AppleTokens {
  readonly exchanges = new Map<string, AppleCodeExchange>();
  readonly exchanged: { code: string; clientId: string }[] = [];
  readonly revoked: AppleGrant[] = [];
  revokeFails = false;

  exchange(code: string, clientId: string): Promise<AppleCodeExchange> {
    this.exchanged.push({ code, clientId });
    return Promise.resolve(
      this.exchanges.get(code) ?? {
        outcome: 'exchanged',
        refreshToken: `refresh-${code}`,
      },
    );
  }

  revoke(grant: AppleGrant): Promise<void> {
    if (this.revokeFails) return Promise.reject(new Error('Apple is down'));
    this.revoked.push(grant);
    return Promise.resolve();
  }
}

describe('POST /auth/apple (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let mailer: FakeMailer;
  let appleIds: FakeAppleIdTokens;
  let appleTokens: FakeAppleTokens;

  async function start(clientIds: string[]): Promise<void> {
    mailer = new FakeMailer();
    appleIds = new FakeAppleIdTokens();
    appleTokens = new FakeAppleTokens();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .overrideProvider(APPLE_ID_TOKENS)
      .useValue(appleIds)
      .overrideProvider(APPLE_TOKENS)
      .useValue(appleTokens)
      .compile();

    // `.env` leaves Apple off; these tests turn it on, or off on purpose.
    // `AuthService` reads the list per request, so setting it before the
    // first request is enough.
    moduleFixture.get<Env>(ENV).APPLE_CLIENT_IDS = clientIds;

    // Mirrors `main.ts`; see the note in auth.e2e-spec.ts.
    app = moduleFixture.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, moduleFixture.get<Env>(ENV));
    await app.init();

    pool = moduleFixture.get<Pool>(POOL);
    await pool.query(
      'TRUNCATE users, sessions, session_refresh_tokens, email_sign_in_codes, apple_grants RESTART IDENTITY CASCADE',
    );
  }

  afterEach(async () => {
    await app.close();
  });

  function http() {
    return request(app.getHttpServer());
  }

  let codes = 0;

  function signInWithApple(
    identityToken: string,
    extra: Record<string, unknown> = {},
  ) {
    codes += 1;
    return http()
      .post('/api/v1/auth/apple')
      .send({ identityToken, authorizationCode: `code-${codes}`, ...extra });
  }

  async function signInWithEmail(email: string): Promise<SessionBody> {
    await http().post('/api/v1/auth/email/code').send({ email }).expect(204);
    const res = await http()
      .post('/api/v1/auth/email/verify')
      .send({ email, code: mailer.lastCodeFor(email) })
      .expect(200);
    return sessionOf(res);
  }

  async function grants() {
    const { rows } = await pool.query<{
      user_id: string;
      client_id: string;
      refresh_token: string;
    }>('SELECT user_id, client_id, refresh_token FROM apple_grants');
    return rows;
  }

  function deleteAccount(accessToken: string) {
    return http()
      .delete('/api/v1/me')
      .set('Authorization', `Bearer ${accessToken}`);
  }

  describe('with Apple set up', () => {
    beforeEach(() => start([CLIENT_ID]));

    it('opens an account named as the app passes on, keeping the grant', async () => {
      const res = await signInWithApple(appleIds.tokenFor('new@example.com'), {
        fullName: { givenName: 'Ada', familyName: 'Lovelace' },
      }).expect(200);
      const session = sessionOf(res);

      expect(session).toMatchObject({
        isNewAccount: true,
        profile: {
          version: 0,
          email: 'new@example.com',
          name: 'Ada Lovelace',
          signInMethod: 'apple',
        },
      });
      expect(appleTokens.exchanged).toEqual([
        { code: `code-${codes}`, clientId: CLIENT_ID },
      ]);
      expect(await grants()).toEqual([
        {
          user_id: session.profile.id,
          client_id: CLIENT_ID,
          refresh_token: `refresh-code-${codes}`,
        },
      ]);
    });

    it('signs in to the account email sign-in opened, filling its name (ACC-03)', async () => {
      const byEmail = await signInWithEmail('me@example.com');

      const res = await signInWithApple(appleIds.tokenFor('me@example.com'), {
        fullName: { givenName: 'Ada', familyName: null },
      }).expect(200);

      expect(sessionOf(res)).toMatchObject({
        isNewAccount: false,
        profile: {
          id: byEmail.profile.id,
          version: 1,
          name: 'Ada',
          signInMethod: 'apple',
        },
      });
    });

    it('replaces the grant on the next sign-in, which carries no name', async () => {
      const token = appleIds.tokenFor('me@example.com');
      await signInWithApple(token, {
        fullName: { givenName: 'Ada', familyName: 'Lovelace' },
      }).expect(200);

      const res = await signInWithApple(token).expect(200);

      expect(sessionOf(res)).toMatchObject({
        isNewAccount: false,
        profile: { name: 'Ada Lovelace', version: 0 },
      });
      expect(await grants()).toEqual([
        expect.objectContaining({ refresh_token: `refresh-code-${codes}` }),
      ]);
    });

    it('answers 401 ID_TOKEN_INVALID for a token Apple did not sign for us, spending no code', async () => {
      const res = await signInWithApple('bad.apple.token').expect(401);

      expect(errorOf(res).code).toBe('ID_TOKEN_INVALID');
      expect(appleTokens.exchanged).toHaveLength(0);
    });

    it('answers 401 ID_TOKEN_INVALID for a code Apple refuses, opening nothing', async () => {
      appleTokens.exchanges.set(`code-${codes + 1}`, { outcome: 'invalid' });

      const res = await signInWithApple(
        appleIds.tokenFor('me@example.com'),
      ).expect(401);

      expect(errorOf(res).code).toBe('ID_TOKEN_INVALID');
      const { rows } = await pool.query('SELECT 1 FROM users');
      expect(rows).toHaveLength(0);
      expect(await grants()).toHaveLength(0);
    });

    it("answers 503 when Apple's keys cannot be fetched", async () => {
      appleIds.verdicts.set('down.apple.token', { outcome: 'unavailable' });

      const res = await signInWithApple('down.apple.token').expect(503);

      expect(errorOf(res).code).toBe('SERVICE_UNAVAILABLE');
    });

    it('answers 503 when the code cannot be exchanged, opening nothing', async () => {
      appleTokens.exchanges.set(`code-${codes + 1}`, {
        outcome: 'unavailable',
        reason: 'invalid_client',
      });

      const res = await signInWithApple(
        appleIds.tokenFor('me@example.com'),
      ).expect(503);

      expect(errorOf(res).code).toBe('SERVICE_UNAVAILABLE');
      const { rows } = await pool.query('SELECT 1 FROM users');
      expect(rows).toHaveLength(0);
    });

    it.each([
      ['no identityToken', { authorizationCode: 'c' }],
      ['no authorizationCode', { identityToken: 'a.b.c' }],
      [
        'a token that is not a JWT',
        { identityToken: 'not-a-jwt', authorizationCode: 'c' },
      ],
      ['an empty code', { identityToken: 'a.b.c', authorizationCode: '' }],
      [
        'an unknown name field',
        {
          identityToken: 'a.b.c',
          authorizationCode: 'c',
          fullName: { nickname: 'Ada' },
        },
      ],
      [
        'an unknown field',
        {
          identityToken: 'a.b.c',
          authorizationCode: 'c',
          email: 'me@example.com',
        },
      ],
    ])('answers 400 VALIDATION_FAILED for %s', async (_, body) => {
      const res = await http()
        .post('/api/v1/auth/apple')
        .send(body)
        .expect(400);

      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expect(appleIds.calls).toBe(0);
    });

    describe('DELETE /me', () => {
      it('revokes the Apple grant under the client it was issued to', async () => {
        const session = sessionOf(
          await signInWithApple(appleIds.tokenFor('me@example.com')).expect(
            200,
          ),
        );

        await deleteAccount(session.accessToken).expect(204);

        expect(appleTokens.revoked).toEqual([
          { clientId: CLIENT_ID, refreshToken: `refresh-code-${codes}` },
        ]);
        expect(await grants()).toHaveLength(0);
      });

      it('still deletes the account when Apple does not confirm the revoke', async () => {
        const session = sessionOf(
          await signInWithApple(appleIds.tokenFor('me@example.com')).expect(
            200,
          ),
        );
        appleTokens.revokeFails = true;

        await deleteAccount(session.accessToken).expect(204);

        const { rows } = await pool.query('SELECT 1 FROM users');
        expect(rows).toHaveLength(0);
      });

      it('revokes nothing for an account that never signed in with Apple', async () => {
        const session = await signInWithEmail('me@example.com');

        await deleteAccount(session.accessToken).expect(204);

        expect(appleTokens.revoked).toHaveLength(0);
      });
    });
  });

  describe('with Apple not set up', () => {
    beforeEach(() => start([]));

    it('answers 503 without checking the token or spending the code', async () => {
      const res = await signInWithApple(
        appleIds.tokenFor('me@example.com'),
      ).expect(503);

      expect(errorOf(res).code).toBe('SERVICE_UNAVAILABLE');
      expect(appleIds.calls).toBe(0);
      expect(appleTokens.exchanged).toHaveLength(0);
    });
  });
});
