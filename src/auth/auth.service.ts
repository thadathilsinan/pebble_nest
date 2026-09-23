import {
  BadRequestException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { DB, type Db } from '../database/database.module';
import type { SessionRow, UserRow } from '../database/schema';
import type { ErrorCode } from '../http/error-code';
import { toProfile, type Profile } from '../users/users.mapper';
import { UsersRepository } from '../users/users.repository';
import { AccessTokensService } from './access-tokens.service';
import type { RequestSignInCodeBody } from './dto/request-sign-in-code.dto';
import type { VerifySignInCodeBody } from './dto/verify-sign-in-code.dto';
import { MAILER, type Mailer } from './mailer/mailer';
import { SessionsRepository } from './sessions.repository';
import {
  generateSignInCode,
  hashesMatch,
  hashSignInCode,
  newRefreshToken,
} from './secrets';
import {
  SignInCodesRepository,
  type SendLimits,
} from './sign-in-codes.repository';

/** ACC-02: six digits, ten minutes, five attempts. */
const MAX_ATTEMPTS = 5;

/**
 * The send limits for `/auth/email/code`: one send per 30 seconds and five
 * per hour, per email address. Per email rather than per IP because the
 * thing being protected is one person's inbox, and the attempt limit already
 * bounds guessing per code.
 */
const SEND_LIMITS: SendLimits = {
  ttlSeconds: 10 * 60,
  cooldownSeconds: 30,
  windowSeconds: 60 * 60,
  maxSendsPerWindow: 5,
};

/** `Session` in `docs/api-plan.md` §2. */
export interface SessionResponse {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  /** True when this sign-in opened the account: the client shows first run. */
  isNewAccount: boolean;
  profile: Profile;
}

/**
 * What the verify transaction decided. Returned rather than thrown, because
 * throwing inside the transaction would roll back the attempt it just counted
 * — a wrong guess has to commit to count.
 */
type VerifyOutcome =
  | { outcome: 'expired' }
  | { outcome: 'exhausted' }
  | { outcome: 'invalid'; attemptsLeft: number }
  | {
      outcome: 'signedIn';
      user: UserRow;
      created: boolean;
      session: SessionRow;
      refreshToken: string;
    };

@Injectable()
export class AuthService {
  constructor(
    private readonly codes: SignInCodesRepository,
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly accessTokens: AccessTokensService,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Sends a new code, replacing any earlier one. Answers the same whether or
   * not an account exists for the address, so this cannot be used to find out.
   */
  async requestCode({ email }: RequestSignInCodeBody): Promise<void> {
    const code = generateSignInCode();
    const result = await this.codes.issue(
      this.db,
      email,
      hashSignInCode(this.env.SIGN_IN_CODE_SECRET, email, code),
      SEND_LIMITS,
    );

    if (result.outcome === 'limited') {
      throw new HttpException(
        {
          code: 'TOO_MANY_REQUESTS' satisfies ErrorCode,
          message: `Too many codes requested for this address. Try again in ${result.retryAfterSeconds} seconds.`,
          meta: { retryAfterSeconds: result.retryAfterSeconds },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // After the write, outside any transaction (§7: nothing slow inside one).
    // If delivery fails the code is stored but unseen; the caller gets a 500
    // and can ask again once the cooldown has passed.
    await this.mailer.sendSignInCode(email, code);
  }

  /**
   * Checks a code and, if it is right, signs in — opening the account first
   * if this email has none.
   *
   * The checks run in a fixed order: a missing or expired code first, then
   * spent attempts (even a correct code is refused after five misses), then
   * the code itself.
   */
  async verifyCode({
    email,
    code,
  }: VerifySignInCodeBody): Promise<SessionResponse> {
    const guessHash = hashSignInCode(this.env.SIGN_IN_CODE_SECRET, email, code);

    // One transaction, holding the code row's lock from the read to the
    // outcome, so two guesses racing cannot share an attempt and a correct
    // code cannot sign in twice.
    const result = await this.db.transaction(
      async (tx): Promise<VerifyOutcome> => {
        const stored = await this.codes.lockByEmail(tx, email);

        if (stored === null || stored.expired) return { outcome: 'expired' };
        if (stored.attempts >= MAX_ATTEMPTS) return { outcome: 'exhausted' };

        if (!hashesMatch(stored.codeHash, guessHash)) {
          const used = await this.codes.recordFailedAttempt(tx, stored.id);

          return {
            outcome: 'invalid',
            attemptsLeft: Math.max(0, MAX_ATTEMPTS - used),
          };
        }

        await this.codes.consume(tx, stored.id);
        const { row: user, created } = await this.users.findOrCreateByEmail(
          tx,
          email,
        );
        const refresh = newRefreshToken();
        const session = await this.sessions.create(tx, {
          userId: user.id,
          signInMethod: 'email',
          refreshTokenHash: refresh.hash,
          ttlDays: this.env.REFRESH_TOKEN_TTL_DAYS,
        });

        return {
          outcome: 'signedIn',
          user,
          created,
          session,
          refreshToken: refresh.token,
        };
      },
    );

    switch (result.outcome) {
      case 'expired':
        throw new GoneException({
          code: 'CODE_EXPIRED' satisfies ErrorCode,
          message: 'That code has expired. Ask for a new one.',
        });
      case 'exhausted':
        throw new HttpException(
          {
            code: 'CODE_ATTEMPTS_EXHAUSTED' satisfies ErrorCode,
            message:
              'That code has been entered incorrectly five times. Ask for a new one.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      case 'invalid':
        throw new BadRequestException({
          code: 'CODE_INVALID' satisfies ErrorCode,
          message: 'That code is not right.',
          meta: { attemptsLeft: result.attemptsLeft },
        });
      case 'signedIn': {
        const access = await this.accessTokens.issue(
          result.user.id,
          result.session.id,
        );

        return {
          accessToken: access.token,
          accessTokenExpiresAt: access.expiresAt.toISOString(),
          refreshToken: result.refreshToken,
          isNewAccount: result.created,
          profile: toProfile(result.user, result.session.signInMethod),
        };
      }
    }
  }
}
