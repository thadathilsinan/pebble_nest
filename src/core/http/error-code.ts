/**
 * The registry of machine-readable error codes. This union is the public part of
 * the error contract — clients branch on it, so codes are **append-only**: never
 * renamed, never repurposed.
 *
 * Domain codes go here too — this skeleton ships none, having no domain of its
 * own. Add the code to the union first, then a handler names it explicitly:
 *
 * ```ts
 * throw new ConflictException({
 *   code: 'EMAIL_ALREADY_REGISTERED' satisfies ErrorCode,
 *   message: 'That email address is already registered.',
 * });
 * ```
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'CONFLICT'
  | 'GONE'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'UNPROCESSABLE_ENTITY'
  | 'TOO_MANY_REQUESTS'
  | 'INTERNAL_ERROR'
  | 'NOT_IMPLEMENTED'
  | 'BAD_GATEWAY'
  | 'SERVICE_UNAVAILABLE'
  | 'GATEWAY_TIMEOUT'
  // Email sign-in (ACC-02). Each carries a different next step for the client:
  // try again, ask for a new code, or ask for a new code after too many tries.
  | 'CODE_INVALID'
  | 'CODE_EXPIRED'
  | 'CODE_ATTEMPTS_EXHAUSTED'
  // A refresh token that is unknown, expired, revoked or reused. One code for
  // all of them: the client does the same thing for each — sign in again.
  | 'TOKEN_INVALID'
  // A PATCH carried a `version` someone else has already moved past. The
  // current resource travels in `error.meta.current`, so the client can
  // re-apply its edit and retry in one round trip.
  | 'STALE_VERSION'
  // BLK-05: a block shorter than 5 minutes. There is no BLOCK_TOO_LONG: a start
  // and end in minutes of the day cannot describe more than 24 hours.
  | 'BLOCK_TOO_SHORT'
  // A repeating block whose rule never lands on a day between its date and
  // its `until`, so it would never appear on any day.
  | 'BLOCK_NO_OCCURRENCE';

/**
 * The default code for each status Nest can produce on its own. Only consulted
 * when an exception does not name its code, so this is the floor of the
 * contract, not the whole of it.
 */
const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  410: 'GONE',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_ERROR',
  501: 'NOT_IMPLEMENTED',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

/** Never throws: an unmapped status still yields a code on the right side of 5xx. */
export function codeForStatus(status: number): ErrorCode {
  return (
    CODE_BY_STATUS[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST')
  );
}
