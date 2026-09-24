import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { timeout, type Observable } from 'rxjs';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';

/**
 * Stops waiting on a request that has outlived `REQUEST_TIMEOUT_MS`, so the
 * caller gets a 504 rather than nothing.
 *
 * **What it bounds, and what it does not.** `DB_ACQUIRE_TIMEOUT_MS` and
 * `DB_STATEMENT_TIMEOUT_MS` each bound one statement; nothing bounded a request.
 * Two queries that each finish just inside the statement limit take twice as long
 * as either, and a handler doing no database work at all is unbounded by anything
 * else in this service.
 *
 * It does **not** cancel the work. `timeout` unsubscribes, which for a
 * promise-returning handler means nothing is listening any more — the query runs
 * on until it finishes or `statement_timeout` cancels it, and its result is
 * discarded. So what this protects is the caller, and the connection the caller
 * was occupying; the database is protected by its own timeouts. Worth stating
 * because an interceptor named "timeout" reads like a cancellation and is not
 * one. A timeout firing is a bug report rather than a tuning signal.
 *
 * **It deliberately does not translate the error.** Letting rxjs's `TimeoutError`
 * reach `AllExceptionsFilter` is what gets it rendered beside the *statement*
 * timeout that means the same thing — see the `isTimeoutError` branch there.
 * Throwing a `GatewayTimeoutException` here instead looks tidier and silently
 * loses the message: the filter replaces every `HttpException` 5xx message with
 * its opaque one, so the body would say nothing about what happened.
 *
 * Registered after the envelope interceptor in `app.module.ts`, therefore
 * *inside* it, so the failure is thrown where the filter renders it and the
 * envelope never wraps a payload that never arrived.
 */
@Injectable()
export class RequestTimeoutInterceptor implements NestInterceptor {
  private readonly timeoutMs: number;

  constructor(@Inject(ENV) env: Env) {
    this.timeoutMs = env.REQUEST_TIMEOUT_MS;
  }

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(timeout(this.timeoutMs));
  }
}
