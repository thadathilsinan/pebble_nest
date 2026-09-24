import { HttpException } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
import type { Env } from '../core/config/env.schema';
import type { Db } from '../core/database/database.module';
import type { SessionRow, UserRow } from '../core/database/schema';
import type { UsersRepository } from '../users/users.repository';
import type { AccessTokensService } from './access-tokens.service';
import { AuthService } from './auth.service';
import type { IdTokenCheck, IdTokens } from './id-tokens/id-tokens';
import type { Mailer } from './mailer/mailer';
import { hashRefreshToken, hashSignInCode } from './secrets';
import type { LockedSession, SessionsRepository } from './sessions.repository';
import type {
  LockedCode,
  SignInCodesRepository,
} from './sign-in-codes.repository';

const SECRET = 'x'.repeat(32);
const EMAIL = 'me@example.com';
const CODE = '123456';

const user: UserRow = {
  id: 'user-1',
  email: EMAIL,
  name: null,
  weekStart: 'monday',
  timeFormat: 'system',
  timeZone: null,
  version: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const session = {
  id: 'session-1',
  userId: user.id,
  signInMethod: 'email',
} as SessionRow;

const REFRESH_TOKEN = 'r'.repeat(43);

function lockedSession(overrides: Partial<LockedSession> = {}): LockedSession {
  return {
    ...session,
    refreshTokenHash: hashRefreshToken(REFRESH_TOKEN),
    expiresAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    expired: false,
    ...overrides,
  };
}

function storedCode(overrides: Partial<LockedCode> = {}): LockedCode {
  return {
    id: 'code-1',
    email: EMAIL,
    codeHash: hashSignInCode(SECRET, EMAIL, CODE),
    attempts: 0,
    expired: false,
    expiresAt: new Date(),
    lastSentAt: new Date(),
    windowStartedAt: new Date(),
    sendsInWindow: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** The error an `HttpException` renders as: status, code, and meta. */
async function failure(promise: Promise<unknown>) {
  const error: unknown = await promise.catch((e: unknown) => e);
  if (!(error instanceof HttpException)) throw error;
  const body = error.getResponse() as { code: string; meta?: unknown };
  return { status: error.getStatus(), code: body.code, meta: body.meta };
}

describe('AuthService', () => {
  let codes: jest.Mocked<
    Pick<
      SignInCodesRepository,
      'issue' | 'lockByEmail' | 'recordFailedAttempt' | 'consume'
    >
  >;
  let users: jest.Mocked<
    Pick<
      UsersRepository,
      'findOrCreateByEmail' | 'findById' | 'findRecordStart'
    >
  >;
  let sessions: jest.Mocked<
    Pick<
      SessionsRepository,
      | 'create'
      | 'lockByTokenHash'
      | 'findRetiredToken'
      | 'rotate'
      | 'deleteById'
      | 'deleteByTokenHash'
      | 'findLiveById'
    >
  >;
  let warn: jest.Mock;
  let mailer: Mailer;
  let sendSignInCode: jest.Mock<Promise<void>, [string, string]>;
  let verifyGoogle: jest.Mock<Promise<IdTokenCheck>, [string]>;
  let env: Env;
  let service: AuthService;

  beforeEach(() => {
    codes = {
      issue: jest.fn(),
      lockByEmail: jest.fn(),
      recordFailedAttempt: jest.fn(),
      consume: jest.fn(),
    };
    users = {
      findOrCreateByEmail: jest
        .fn()
        .mockResolvedValue({ row: user, created: false }),
      findById: jest.fn().mockResolvedValue(user),
      findRecordStart: jest
        .fn()
        .mockResolvedValue({ firstRecordedDay: null, hasAnyRecord: false }),
    };
    sessions = {
      create: jest.fn().mockResolvedValue(session),
      lockByTokenHash: jest.fn(),
      findRetiredToken: jest.fn(),
      rotate: jest.fn().mockResolvedValue(session),
      deleteById: jest.fn(),
      deleteByTokenHash: jest.fn(),
      findLiveById: jest.fn(),
    };
    warn = jest.fn();
    sendSignInCode = jest
      .fn<Promise<void>, [string, string]>()
      .mockResolvedValue(undefined);
    mailer = { sendSignInCode };
    const accessTokens = {
      issue: jest
        .fn()
        .mockResolvedValue({ token: 'jwt', expiresAt: new Date(0) }),
    };
    verifyGoogle = jest.fn<Promise<IdTokenCheck>, [string]>();
    const googleIdTokens: IdTokens = { verify: verifyGoogle };
    env = {
      SIGN_IN_CODE_SECRET: SECRET,
      REFRESH_TOKEN_TTL_DAYS: 60,
      GOOGLE_CLIENT_IDS: ['client-1'],
    } as Env;
    // A transaction that just runs its callback: the fakes do not care which
    // executor they are handed.
    const db = {
      transaction: (fn: (tx: unknown) => unknown) => fn({}),
    } as unknown as Db;

    service = new AuthService(
      codes as unknown as SignInCodesRepository,
      users as unknown as UsersRepository,
      sessions,
      accessTokens as unknown as AccessTokensService,
      mailer,
      googleIdTokens,
      db,
      env,
      { setContext: jest.fn(), warn } as unknown as PinoLogger,
    );
  });

  describe('requestCode', () => {
    it('stores the hash of the code it mails', async () => {
      codes.issue.mockResolvedValue({ outcome: 'issued' });

      await service.requestCode({ email: EMAIL });

      const [sentTo, sentCode] = sendSignInCode.mock.calls[0]!;
      expect(sentTo).toBe(EMAIL);
      expect(sentCode).toMatch(/^\d{6}$/);
      expect(codes.issue.mock.calls[0]![2]).toBe(
        hashSignInCode(SECRET, EMAIL, sentCode),
      );
    });

    it('answers 429 with retryAfterSeconds and mails nothing when limited', async () => {
      codes.issue.mockResolvedValue({
        outcome: 'limited',
        retryAfterSeconds: 17,
      });

      await expect(
        failure(service.requestCode({ email: EMAIL })),
      ).resolves.toEqual({
        status: 429,
        code: 'TOO_MANY_REQUESTS',
        meta: { retryAfterSeconds: 17 },
      });
      expect(sendSignInCode).not.toHaveBeenCalled();
    });
  });

  describe('verifyCode', () => {
    it('answers CODE_EXPIRED when no code was ever sent', async () => {
      codes.lockByEmail.mockResolvedValue(null);

      await expect(
        failure(service.verifyCode({ email: EMAIL, code: CODE })),
      ).resolves.toMatchObject({ status: 410, code: 'CODE_EXPIRED' });
    });

    it('answers CODE_EXPIRED for an expired code, even a correct one', async () => {
      codes.lockByEmail.mockResolvedValue(storedCode({ expired: true }));

      await expect(
        failure(service.verifyCode({ email: EMAIL, code: CODE })),
      ).resolves.toMatchObject({ status: 410, code: 'CODE_EXPIRED' });
    });

    it('answers CODE_ATTEMPTS_EXHAUSTED after five misses, even for the right code', async () => {
      codes.lockByEmail.mockResolvedValue(storedCode({ attempts: 5 }));

      await expect(
        failure(service.verifyCode({ email: EMAIL, code: CODE })),
      ).resolves.toMatchObject({
        status: 429,
        code: 'CODE_ATTEMPTS_EXHAUSTED',
      });
      expect(codes.recordFailedAttempt).not.toHaveBeenCalled();
    });

    it('counts a wrong code and says how many attempts are left', async () => {
      codes.lockByEmail.mockResolvedValue(storedCode({ attempts: 1 }));
      codes.recordFailedAttempt.mockResolvedValue(2);

      await expect(
        failure(service.verifyCode({ email: EMAIL, code: '000000' })),
      ).resolves.toEqual({
        status: 400,
        code: 'CODE_INVALID',
        meta: { attemptsLeft: 3 },
      });
      expect(sessions.create).not.toHaveBeenCalled();
    });

    it('reports zero attempts left on the fifth miss', async () => {
      codes.lockByEmail.mockResolvedValue(storedCode({ attempts: 4 }));
      codes.recordFailedAttempt.mockResolvedValue(5);

      await expect(
        failure(service.verifyCode({ email: EMAIL, code: '000000' })),
      ).resolves.toMatchObject({
        code: 'CODE_INVALID',
        meta: { attemptsLeft: 0 },
      });
    });

    it('signs in with the right code, consuming it', async () => {
      codes.lockByEmail.mockResolvedValue(storedCode());

      const result = await service.verifyCode({ email: EMAIL, code: CODE });

      expect(codes.consume).toHaveBeenCalledWith({}, 'code-1');
      expect(sessions.create).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ userId: user.id, signInMethod: 'email' }),
      );
      expect(result).toMatchObject({
        accessToken: 'jwt',
        isNewAccount: false,
        profile: { id: user.id, email: EMAIL, signInMethod: 'email' },
      });
      expect(result.refreshToken).toMatch(/^[\w-]{43}$/);
    });

    it('flags a new account so the client shows first run', async () => {
      codes.lockByEmail.mockResolvedValue(storedCode());
      users.findOrCreateByEmail.mockResolvedValue({ row: user, created: true });

      await expect(
        service.verifyCode({ email: EMAIL, code: CODE }),
      ).resolves.toMatchObject({ isNewAccount: true });
    });
  });

  describe('signInWithGoogle', () => {
    const ID_TOKEN = 'header.payload.signature';

    beforeEach(() => {
      sessions.create.mockImplementation((_, input) =>
        Promise.resolve({ ...session, signInMethod: input.signInMethod }),
      );
    });

    it('signs in the account the verified email names, passing on the name', async () => {
      verifyGoogle.mockResolvedValue({
        outcome: 'verified',
        account: { email: EMAIL, name: 'Ada' },
      });

      const result = await service.signInWithGoogle({ idToken: ID_TOKEN });

      expect(verifyGoogle).toHaveBeenCalledWith(ID_TOKEN);
      expect(users.findOrCreateByEmail).toHaveBeenCalledWith({}, EMAIL, 'Ada');
      expect(sessions.create).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ userId: user.id, signInMethod: 'google' }),
      );
      expect(result).toMatchObject({
        isNewAccount: false,
        profile: { id: user.id, signInMethod: 'google' },
      });
      expect(result.refreshToken).toMatch(/^[\w-]{43}$/);
    });

    it('flags a new account so the client shows first run', async () => {
      verifyGoogle.mockResolvedValue({
        outcome: 'verified',
        account: { email: EMAIL, name: null },
      });
      users.findOrCreateByEmail.mockResolvedValue({ row: user, created: true });

      await expect(
        service.signInWithGoogle({ idToken: ID_TOKEN }),
      ).resolves.toMatchObject({ isNewAccount: true });
    });

    it('answers ID_TOKEN_INVALID for a token Google did not sign for us', async () => {
      verifyGoogle.mockResolvedValue({ outcome: 'invalid' });

      await expect(
        failure(service.signInWithGoogle({ idToken: ID_TOKEN })),
      ).resolves.toMatchObject({ status: 401, code: 'ID_TOKEN_INVALID' });
      expect(users.findOrCreateByEmail).not.toHaveBeenCalled();
    });

    it("answers 503 when Google's keys cannot be fetched", async () => {
      verifyGoogle.mockResolvedValue({ outcome: 'unavailable' });

      await expect(
        failure(service.signInWithGoogle({ idToken: ID_TOKEN })),
      ).resolves.toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
      expect(warn).toHaveBeenCalled();
    });

    it('answers 503 without checking the token when no client IDs are set', async () => {
      env.GOOGLE_CLIENT_IDS = [];

      await expect(
        failure(service.signInWithGoogle({ idToken: ID_TOKEN })),
      ).resolves.toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
      expect(verifyGoogle).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    const OLD_TOKEN = 'o'.repeat(43);

    it('answers TOKEN_INVALID for a token no session knows', async () => {
      sessions.lockByTokenHash.mockResolvedValue(null);

      await expect(
        failure(service.refresh({ refreshToken: REFRESH_TOKEN })),
      ).resolves.toMatchObject({ status: 401, code: 'TOKEN_INVALID' });
    });

    it('answers TOKEN_INVALID for an expired session, deleting it', async () => {
      sessions.lockByTokenHash.mockResolvedValue(
        lockedSession({ expired: true }),
      );

      await expect(
        failure(service.refresh({ refreshToken: REFRESH_TOKEN })),
      ).resolves.toMatchObject({ status: 401, code: 'TOKEN_INVALID' });
      expect(sessions.deleteById).toHaveBeenCalledWith({}, 'session-1');
      expect(sessions.rotate).not.toHaveBeenCalled();
    });

    it('rotates the current token, sliding the expiry', async () => {
      const locked = lockedSession();
      sessions.lockByTokenHash.mockResolvedValue(locked);

      const result = await service.refresh({ refreshToken: REFRESH_TOKEN });

      expect(sessions.lockByTokenHash).toHaveBeenCalledWith(
        {},
        hashRefreshToken(REFRESH_TOKEN),
      );
      const [, rotated, newHash, ttlDays] = sessions.rotate.mock.calls[0]!;
      expect(rotated).toBe(locked);
      expect(ttlDays).toBe(60);
      expect(newHash).toBe(hashRefreshToken(result.refreshToken));
      expect(result.refreshToken).not.toBe(REFRESH_TOKEN);
      expect(result).toMatchObject({
        accessToken: 'jwt',
        isNewAccount: false,
        profile: { id: user.id, signInMethod: 'email' },
      });
      expect(sessions.findRetiredToken).not.toHaveBeenCalled();
    });

    it('rotates again for the last retired token inside the grace window', async () => {
      const locked = lockedSession();
      sessions.lockByTokenHash.mockResolvedValue(locked);
      sessions.findRetiredToken.mockResolvedValue({ inGrace: true });

      await service.refresh({ refreshToken: OLD_TOKEN });

      expect(sessions.findRetiredToken).toHaveBeenCalledWith(
        {},
        'session-1',
        hashRefreshToken(OLD_TOKEN),
        30,
      );
      // What retires is the session's current token, not the presented one.
      expect(sessions.rotate.mock.calls[0]![1]).toBe(locked);
      expect(sessions.deleteById).not.toHaveBeenCalled();
    });

    it('revokes the session when a retired token is reused', async () => {
      sessions.lockByTokenHash.mockResolvedValue(lockedSession());
      sessions.findRetiredToken.mockResolvedValue({ inGrace: false });

      await expect(
        failure(service.refresh({ refreshToken: OLD_TOKEN })),
      ).resolves.toMatchObject({ status: 401, code: 'TOKEN_INVALID' });
      expect(sessions.deleteById).toHaveBeenCalledWith({}, 'session-1');
      expect(sessions.rotate).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        { sessionId: 'session-1' },
        expect.any(String),
      );
    });
  });

  describe('signOut', () => {
    it('deletes the session the token is current for', async () => {
      await service.signOut({ refreshToken: REFRESH_TOKEN });

      expect(sessions.deleteByTokenHash).toHaveBeenCalledWith(
        expect.anything(),
        hashRefreshToken(REFRESH_TOKEN),
      );
    });
  });
});
