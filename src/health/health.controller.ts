import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Pool } from 'pg';
import { POOL } from '../database/database.module';
import type { ErrorCode } from '../http/error-code';

/** Base path for both probes. */
export const HEALTH_PATH = 'health';

/**
 * The two probe routes as `setGlobalPrefix`'s `exclude` wants them — relative to
 * the prefix, which is the thing being excluded.
 *
 * Exported so `configure-app.ts` builds its exclusion from the same strings the
 * routes are declared with. Writing them out there instead would drift silently:
 * renaming the controller path would stop the exclusion matching, and the probes
 * would quietly move to `/api/health/*` while every test still passed.
 */
export const HEALTH_ROUTES = [`${HEALTH_PATH}/live`, `${HEALTH_PATH}/ready`];

/**
 * Liveness and readiness. Two endpoints because they answer two questions with
 * different consequences, and an orchestrator acts differently on each.
 *
 * **Liveness — "is this process wedged?"** Failing it gets the container
 * *killed and replaced*. So it must touch nothing external: a liveness probe
 * that checks the database restarts every instance of this service when the
 * database has a bad minute, turning a recoverable dependency outage into a
 * total one. It answers only that the event loop is turning.
 *
 * **Readiness — "should traffic come here now?"** Failing it removes the
 * instance from the load balancer and nothing else; it recovers by itself when
 * the check passes again. That makes it the right place for the database, and
 * the mechanism that makes "stay up through a database outage" more than a
 * refusal to exit — the instance stops taking requests it cannot serve.
 *
 * `VERSION_NEUTRAL` is load-bearing and easy to miss. `configure-app.ts`
 * excludes these routes from the global prefix, but `enableVersioning` is a
 * separate mechanism that would still stamp `/v1` on them — leaving the probes
 * at `/v1/health/ready`, which is exactly the coupling between the API version
 * and the orchestrator's URL that mounting them outside the API exists to
 * prevent.
 */
@Controller({ path: HEALTH_PATH, version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(HealthController.name);
  }

  /**
   * Deliberately does no work. Reaching the handler at all is the entire signal:
   * it means the process is up, Express is listening, and the event loop is not
   * blocked.
   */
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  /**
   * `SELECT 1` — the cheapest statement that proves a connection was obtained
   * *and* the server answered on it. `pool.query` checks a connection out and
   * returns it automatically, so this exercises the pool rather than going
   * around it.
   *
   * Two ways to fail, and both should read as not-ready. The database is
   * unreachable: obviously. Or every connection is busy, in which case the
   * checkout waits `DB_ACQUIRE_TIMEOUT_MS` and gives up — and shedding traffic
   * from a saturated instance is the correct response, not a false alarm.
   *
   * Worth knowing the bound: a checkout wait plus a statement timeout puts the
   * slowest possible failure at roughly `DB_ACQUIRE_TIMEOUT_MS +
   * DB_STATEMENT_TIMEOUT_MS`. That is longer than a typical probe timeout, so in
   * the worst case the orchestrator's own timer fires first — which yields the
   * same verdict by a different route, and is why there is no third timeout here.
   */
  @Get('ready')
  async ready(): Promise<{ status: string }> {
    try {
      await this.pool.query('SELECT 1');
      // The annotation is now redundant — `strict` in `tsconfig.json` brings
      // `useUnknownInCatchVariables`, so this binds `unknown` either way. Kept
      // because it states the requirement at the site that depends on it: an
      // `any` reaching a log call is how a field silently stops being what the
      // serializer expects.
    } catch (error: unknown) {
      // Logged here rather than left to `AllExceptionsFilter`, which would only
      // see the exception thrown below and record a stack pointing at this line.
      // The driver's error is the one that says *why* — ECONNREFUSED, too many
      // clients, a timeout — and it is the reason anyone reads this log.
      this.logger.error({ err: error }, 'readiness check failed');

      // A 503 rather than the 500 the raw driver error would map to. The filter
      // replaces any 5xx message with its opaque one, so what reaches the client
      // is a status code and a stable code — never a host name, a role name, or
      // a driver's description of the network.
      throw new ServiceUnavailableException({
        code: 'SERVICE_UNAVAILABLE' satisfies ErrorCode,
        message: 'Database is not reachable.',
      });
    }

    return { status: 'ok' };
  }
}
