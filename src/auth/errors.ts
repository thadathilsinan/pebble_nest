import { UnauthorizedException } from '@nestjs/common';
import type { ErrorCode } from '../http/error-code';

/**
 * A missing, malformed, expired or forged access token, or one whose session
 * or account is gone. One code for all of them: the client refreshes once and
 * retries, and signs in again if the refresh fails too.
 */
export function accessTokenInvalid(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'TOKEN_INVALID' satisfies ErrorCode,
    message: 'The access token is missing, invalid or expired.',
  });
}
