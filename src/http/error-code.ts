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
  | 'GATEWAY_TIMEOUT';

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
