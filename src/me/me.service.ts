import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import {
  AppleGrantsRepository,
  type AppleGrant,
} from '../auth/apple/apple-grants.repository';
import { APPLE_TOKENS, type AppleTokens } from '../auth/apple/apple-tokens';
import type { Caller } from '../auth/caller';
import { accessTokenInvalid } from '../auth/errors';
import { SessionsRepository } from '../auth/sessions.repository';
import { SignInCodesRepository } from '../auth/sign-in-codes.repository';
import { DB, type Db, type Executor } from '../core/database/database.module';
import type { SessionRow, UserRow } from '../core/database/schema';
import type { ErrorCode } from '../core/http/error-code';
import { toProfile, type Profile } from '../users/users.mapper';
import { UsersRepository } from '../users/users.repository';
import {
  isTimeZoneOnly,
  type UpdateProfileBody,
} from './dto/update-profile.dto';

@Injectable()
export class MeService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly sessions: SessionsRepository,
    private readonly signInCodes: SignInCodesRepository,
    private readonly users: UsersRepository,
    private readonly appleGrants: AppleGrantsRepository,
    @Inject(APPLE_TOKENS) private readonly appleTokens: AppleTokens,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MeService.name);
  }

  /**
   * The caller's `Profile`. It reads the session because
   * `Profile.signInMethod` belongs to the device, not the account. That read
   * also means a signed-out, revoked or expired session gets a 401 here at
   * once, even though the stateless guard let the token through.
   *
   * The two reads are not in a transaction. If `DELETE /me` lands between
   * them, the user read finds nothing, and that is a 401 too.
   */
  async get(caller: Caller): Promise<Profile> {
    const session = await this.liveSession(this.db, caller);

    const user = await this.users.findById(this.db, caller.userId);
    if (user === null) throw accessTokenInvalid();

    return this.profile(user, session);
  }

  /**
   * Edits the caller's profile. It reads the session first, as `get` does, both
   * for `signInMethod` and so that a revoked session is refused here too.
   *
   * A body with only `timeZone` is the device reporting its zone and skips the
   * version check. Any other body is a versioned edit: a stale `version` is a
   * 409 carrying the current profile, so the client can re-apply and retry
   * without another read.
   */
  async update(caller: Caller, body: UpdateProfileBody): Promise<Profile> {
    const session = await this.liveSession(this.db, caller);

    if (isTimeZoneOnly(body)) {
      const user = await this.users.setTimeZone(
        this.db,
        caller.userId,
        body.timeZone,
      );
      if (user === null) throw accessTokenInvalid();

      return this.profile(user, session);
    }

    const { version, ...patch } = body;
    // The DTO requires `version` whenever the body is not time-zone-only.
    if (version === undefined)
      throw new Error('version missing after validation');

    const result = await this.users.updateVersioned(
      this.db,
      caller.userId,
      version,
      patch,
    );

    switch (result.outcome) {
      case 'updated':
        return this.profile(result.row, session);
      case 'stale':
        throw new ConflictException({
          code: 'STALE_VERSION' satisfies ErrorCode,
          message: 'The profile was changed elsewhere. Re-apply and retry.',
          meta: { current: await this.profile(result.row, session) },
        });
      case 'missing':
        // The account was deleted after the session read.
        throw accessTokenInvalid();
    }
  }

  /**
   * Hard-deletes the caller's account and everything in it (ACC-06, decision
   * 8). The cascades from `users` remove every device's session. The sign-in
   * code row is keyed by email, not by user, so it is deleted here by hand.
   *
   * It needs a live session, like `get` and `update`: a signed-out device's
   * access token, still inside its 15 minutes, must not be able to do the most
   * destructive thing there is. A retry after a lost response therefore gets
   * a 401, because the session went with the account (decision 18).
   *
   * Every user-owned table must cascade from `users`, so that this stays one
   * delete.
   *
   * An account that signed in with Apple has its Apple grant revoked, as App
   * Review requires. That happens after the commit and is best-effort
   * (decision 34): the account is gone whether or not Apple answers, and a
   * failure is logged rather than undoing the delete.
   */
  async delete(caller: Caller): Promise<void> {
    const grant = await this.db.transaction(
      async (tx): Promise<AppleGrant | null> => {
        await this.liveSession(tx, caller);

        // Read before the delete, whose cascade removes it.
        const appleGrant = await this.appleGrants.findByUserId(
          tx,
          caller.userId,
        );

        const user = await this.users.deleteById(tx, caller.userId);
        if (user === null) throw accessTokenInvalid();

        await this.signInCodes.deleteByEmail(tx, user.email);

        return appleGrant;
      },
    );

    if (grant === null) return;

    try {
      await this.appleTokens.revoke(grant);
    } catch (error) {
      this.logger.error(
        { err: error, userId: caller.userId },
        'Apple grant not revoked after account deletion',
      );
    }
  }

  /** The `Profile` for `user` on the device holding `session`. */
  private async profile(user: UserRow, session: SessionRow): Promise<Profile> {
    const record = await this.users.findRecordStart(this.db, user.id);
    return toProfile(user, session.signInMethod, record);
  }

  private async liveSession(ex: Executor, caller: Caller): Promise<SessionRow> {
    const session = await this.sessions.findLiveById(ex, caller.sessionId);
    if (session === null || session.userId !== caller.userId) {
      throw accessTokenInvalid();
    }

    return session;
  }
}
