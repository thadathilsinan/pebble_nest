import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';

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
}
