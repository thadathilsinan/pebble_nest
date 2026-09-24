import {
  BadRequestException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { ENV } from '../core/config/config.module';
import type { Env } from '../core/config/env.schema';
import { DB, type Db, type Executor } from '../core/database/database.module';
import type {
  SessionRow,
  SignInMethod,
  UserRow,
} from '../core/database/schema';
import type { ErrorCode } from '../core/http/error-code';
import { toProfile, type Profile } from '../users/users.mapper';
import { UsersRepository } from '../users/users.repository';
import { AccessTokensService } from './access-tokens.service';
import type { GoogleSignInBody } from './dto/google-sign-in.dto';
import type { RefreshSessionBody } from './dto/refresh-session.dto';
import type { RequestSignInCodeBody } from './dto/request-sign-in-code.dto';
import type { SignOutBody } from './dto/sign-out.dto';
import type { VerifySignInCodeBody } from './dto/verify-sign-in-code.dto';
import { GOOGLE_ID_TOKENS } from './google/google-id-tokens';
import type { IdTokens } from './id-tokens/id-tokens';
import { MAILER, type Mailer } from './mailer/mailer';
import { SessionsRepository } from './sessions.repository';
import {
  generateSignInCode,
  hashesMatch,
  hashRefreshToken,
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

/**
 * How long after a rotation the token it retired still works, once. A refresh
 * whose response was lost on a bad connection is retried with the old token;
 * inside this window that rotates again instead of being treated as reuse and
 * signing the device out. Only the most recently retired token qualifies.
 */
const REFRESH_GRACE_SECONDS = 30;

/** `Session` in `docs/api-plan.md` §2. */
export interface SessionResponse {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  /** True when this sign-in opened the account: the client shows first run. */
  isNewAccount: boolean;
  profile: Profile;
}

/** A new device session, and whether signing in opened the account. */
interface SignedIn {
  user: UserRow;
  created: boolean;
  session: SessionRow;
  refreshToken: string;
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
  | ({ outcome: 'signedIn' } & SignedIn);

/**
 * What the refresh transaction decided. Returned rather than thrown for the
 * same reason as `VerifyOutcome`: revoking a reused token's session has to
 * commit even though the request fails.
 */
type RefreshOutcome =
  | { outcome: 'invalid' }
  | { outcome: 'reused'; sessionId: string }
  | {
      outcome: 'rotated';
      user: UserRow;
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
    @Inject(GOOGLE_ID_TOKENS) private readonly googleIdTokens: IdTokens,
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuthService.name);
  }

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

        return {
          outcome: 'signedIn',
          ...(await this.openSession(tx, email, 'email')),
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
      case 'signedIn':
        return this.sessionResponse(result, result.created);
    }
  }

  /**
   * Signs in with a Google ID token, opening the account if its email has
   * none (ACC-03). Google's name for the person fills an account that has no
   * name yet, and never replaces one.
   *
   * Off, with a 503, until the client IDs are configured (api-plan §13).
   */
  async signInWithGoogle({
    idToken,
  }: GoogleSignInBody): Promise<SessionResponse> {
    if (this.env.GOOGLE_CLIENT_IDS.length === 0) {
      throw new ServiceUnavailableException({
        code: 'SERVICE_UNAVAILABLE' satisfies ErrorCode,
        message: 'Google sign-in is not set up on this server.',
      });
    }

    const check = await this.googleIdTokens.verify(idToken);

    switch (check.outcome) {
      case 'invalid':
        throw new UnauthorizedException({
          code: 'ID_TOKEN_INVALID' satisfies ErrorCode,
          message: 'Google could not confirm this sign-in. Try again.',
        });
      case 'unavailable':
        this.logger.warn("Google's signing keys could not be fetched");
        throw new ServiceUnavailableException({
          code: 'SERVICE_UNAVAILABLE' satisfies ErrorCode,
          message: 'Google sign-in cannot be checked right now. Try again.',
        });
    }

    const { email, name } = check.account;
    const signedIn = await this.db.transaction((tx) =>
      this.openSession(tx, email, 'google', name),
    );

    return this.sessionResponse(signedIn, signedIn.created);
  }

  /**
   * Swaps a refresh token for a new one and a new access token, sliding the
   * session's expiry forward.
   *
   * A token the session has already rotated away from means it was copied,
   * so presenting one ends the session for whoever holds either copy — except
   * the one retired last, inside `REFRESH_GRACE_SECONDS`, which is a retry.
   */
  async refresh({
    refreshToken,
  }: RefreshSessionBody): Promise<SessionResponse> {
    const presented = hashRefreshToken(refreshToken);

    const result = await this.db.transaction(
      async (tx): Promise<RefreshOutcome> => {
        const session = await this.sessions.lockByTokenHash(tx, presented);

        if (session === null) return { outcome: 'invalid' };
        if (session.expired) {
          await this.sessions.deleteById(tx, session.id);
          return { outcome: 'invalid' };
        }

        if (session.refreshTokenHash !== presented) {
          const retired = await this.sessions.findRetiredToken(
            tx,
            session.id,
            presented,
            REFRESH_GRACE_SECONDS,
          );

          // Unreachable while the lock holds — the lookup found this session
          // by the token — but refused rather than rotated if it ever is.
          if (retired === null) return { outcome: 'invalid' };
          if (!retired.inGrace) {
            await this.sessions.deleteById(tx, session.id);
            return { outcome: 'reused', sessionId: session.id };
          }
        }

        const user = await this.users.findById(tx, session.userId);
        // The session cascades with its user, so the lock proves the user.
        if (user === null) throw new Error('locked session has no user');

        const refresh = newRefreshToken();
        const rotated = await this.sessions.rotate(
          tx,
          session,
          refresh.hash,
          this.env.REFRESH_TOKEN_TTL_DAYS,
        );

        return {
          outcome: 'rotated',
          user,
          session: rotated,
          refreshToken: refresh.token,
        };
      },
    );

    switch (result.outcome) {
      case 'reused':
        this.logger.warn(
          { sessionId: result.sessionId },
          'retired refresh token reused; session revoked',
        );
        throw this.tokenInvalid();
      case 'invalid':
        throw this.tokenInvalid();
      case 'rotated':
        return this.sessionResponse(result, false);
    }
  }

  /**
   * Ends the session the token is current for (ACC-05). Idempotent: an
   * unknown, expired or retired token is not an error, since the device is
   * signed out either way.
   */
  async signOut({ refreshToken }: SignOutBody): Promise<void> {
    await this.sessions.deleteByTokenHash(
      this.db,
      hashRefreshToken(refreshToken),
    );
  }

  /**
   * Signs `email` in on a new device session, opening the account first if
   * the email has none (ACC-03: the email is the account, whichever method
   * proved it). `name` is Google's or Apple's for the person, and names the
   * account only while it has none. Runs inside the caller's transaction, so
   * whatever proved the email commits with the session or not at all.
   */
  private async openSession(
    tx: Executor,
    email: string,
    signInMethod: SignInMethod,
    name: string | null = null,
  ): Promise<SignedIn> {
    const { row: user, created } = await this.users.findOrCreateByEmail(
      tx,
      email,
      name,
    );
    const refresh = newRefreshToken();
    const session = await this.sessions.create(tx, {
      userId: user.id,
      signInMethod,
      refreshTokenHash: refresh.hash,
      ttlDays: this.env.REFRESH_TOKEN_TTL_DAYS,
    });

    return { user, created, session, refreshToken: refresh.token };
  }

  private tokenInvalid(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'TOKEN_INVALID' satisfies ErrorCode,
      message: 'This session has ended. Sign in again.',
    });
  }

  /** The `Session` for a freshly issued refresh token, with its access token. */
  private async sessionResponse(
    {
      user,
      session,
      refreshToken,
    }: { user: UserRow; session: SessionRow; refreshToken: string },
    isNewAccount: boolean,
  ): Promise<SessionResponse> {
    const [access, record] = await Promise.all([
      this.accessTokens.issue(user.id, session.id),
      this.users.findRecordStart(this.db, user.id),
    ]);

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken,
      isNewAccount,
      profile: toProfile(user, session.signInMethod, record),
    };
  }
}
