import { HttpException } from '@nestjs/common';
import type { Env } from '../config/env.schema';
import type { Db } from '../database/database.module';
import type { SessionRow, UserRow } from '../database/schema';
import type { UsersRepository } from '../users/users.repository';
import type { AccessTokensService } from './access-tokens.service';
import { AuthService } from './auth.service';
import type { Mailer } from './mailer/mailer';
import { hashSignInCode } from './secrets';
import type { SessionsRepository } from './sessions.repository';
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
  let users: jest.Mocked<Pick<UsersRepository, 'findOrCreateByEmail'>>;
  let sessions: jest.Mocked<Pick<SessionsRepository, 'create'>>;
  let mailer: Mailer;
  let sendSignInCode: jest.Mock<Promise<void>, [string, string]>;
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
    };
    sessions = { create: jest.fn().mockResolvedValue(session) };
    sendSignInCode = jest
      .fn<Promise<void>, [string, string]>()
      .mockResolvedValue(undefined);
    mailer = { sendSignInCode };
    const accessTokens = {
      issue: jest
        .fn()
        .mockResolvedValue({ token: 'jwt', expiresAt: new Date(0) }),
    };
    // A transaction that just runs its callback: the fakes do not care which
    // executor they are handed.
    const db = {
      transaction: (fn: (tx: unknown) => unknown) => fn({}),
    } as unknown as Db;

    service = new AuthService(
      codes as unknown as SignInCodesRepository,
      users,
      sessions,
      accessTokens as unknown as AccessTokensService,
      mailer,
      db,
      { SIGN_IN_CODE_SECRET: SECRET, REFRESH_TOKEN_TTL_DAYS: 60 } as Env,
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
});
