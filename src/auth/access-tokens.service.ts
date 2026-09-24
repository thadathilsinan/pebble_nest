import { Inject, Injectable } from '@nestjs/common';
import { JsonWebTokenError, JwtService } from '@nestjs/jwt';
import { ENV } from '../core/config/config.module';
import type { Env } from '../core/config/env.schema';
import type { Caller } from './caller';

/** What an access token carries beyond `sub` (the user id). */
export interface AccessTokenClaims {
  /** The session the token was issued to. */
  sid: string;
}

@Injectable()
export class AccessTokensService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * A short-lived HS256 JWT for one user on one session.
   *
   * `exp` is set in the payload rather than through `expiresIn`, so the
   * `expiresAt` returned to the client is the token's exact expiry and not a
   * second reading of the clock.
   */
  async issue(
    userId: string,
    sessionId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const exp =
      Math.floor(Date.now() / 1000) + this.env.ACCESS_TOKEN_TTL_SECONDS;
    const token = await this.jwt.signAsync(
      { sid: sessionId, exp } satisfies AccessTokenClaims & { exp: number },
      { subject: userId },
    );

    return { token, expiresAt: new Date(exp * 1000) };
  }

  /**
   * The caller an access token proves, or `null` if it proves nothing: a bad
   * signature, an `alg` other than HS256 (pinned in `AuthModule`), an expired
   * or missing `exp`, or claims that are not the ones `issue` writes.
   *
   * Only the library's own token errors mean "invalid". Anything else is a
   * fault here and propagates as a 500 rather than passing as a bad token.
   */
  async verify(token: string): Promise<Caller | null> {
    let claims: Record<string, unknown>;
    try {
      claims = await this.jwt.verifyAsync<Record<string, unknown>>(token);
    } catch (error: unknown) {
      if (error instanceof JsonWebTokenError) return null;
      throw error;
    }

    const { sub, sid, exp } = claims;
    if (
      typeof sub !== 'string' ||
      typeof sid !== 'string' ||
      typeof exp !== 'number'
    ) {
      return null;
    }

    return { userId: sub, sessionId: sid };
  }
}
