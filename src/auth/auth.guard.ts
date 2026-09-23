import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessTokensService } from './access-tokens.service';
import type { CallerRequest } from './caller';
import { accessTokenInvalid } from './errors';
import { IS_PUBLIC } from './public.decorator';

const BEARER = /^Bearer ([^\s]+)$/i;

/**
 * Registered globally, so every route needs a valid access token unless it is
 * marked `@Public()`. On success the request carries its `Caller`.
 *
 * Stateless by decision: it checks the token's signature and expiry and nothing
 * else, so a request costs no database round trip. The price is that a revoked
 * session keeps working until its access token expires (about 15 minutes).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokensService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<CallerRequest>();
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
    const caller =
      token === undefined ? null : await this.accessTokens.verify(token);

    if (caller === null) throw accessTokenInvalid();

    request.caller = caller;
    return true;
  }
}
