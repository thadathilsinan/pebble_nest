import type { Request } from 'express';

/**
 * Who is making a request, as proven by their access token. The guard attaches
 * it to the request; controllers take it with `@CurrentCaller()` and hand it to
 * services as an argument, since a service never sees `Request`.
 *
 * Proven by the token alone: the guard does not look the session up, so a
 * session signed out in the last `ACCESS_TOKEN_TTL_SECONDS` still yields a
 * caller. A handler that must not serve a revoked session checks it itself.
 */
export interface Caller {
  userId: string;
  sessionId: string;
}

/** A request the guard has passed. `caller` is absent on `@Public()` routes. */
export type CallerRequest = Request & { caller?: Caller };
