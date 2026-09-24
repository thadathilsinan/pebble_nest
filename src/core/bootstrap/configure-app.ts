import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { Env } from '../config/env.schema';
import { HEALTH_ROUTES } from '../health/health.controller';

/**
 * The prefix every route in this service sits under, separating the API from
 * anything else the process may serve later — a health probe, metrics, a
 * `.well-known` path. Not configurable: the URL is the client contract, and a
 * prefix that differs per environment is how a bug becomes irreproducible
 * locally.
 */
export const API_PREFIX = 'api';

/**
 * Applied to every controller that does not name its own version, so nothing
 * has to opt in until a second version exists. At that point one controller
 * declares `@Controller({ path: …, version: '2' })` and both serve at once,
 * which is the entire reason the segment is here from the start — retrofitting
 * it onto live clients is itself the breaking change it exists to avoid.
 */
export const DEFAULT_VERSION = '1';

/**
 * Deliberately the same value body-parser already defaults to, so this changes
 * nothing a client can observe: it converts an implicit library default into
 * one documented constant. The point is that the number now has a home.
 *
 * *Revisit at the first bulk-import endpoint*, which is the first thing that
 * will legitimately want more.
 */
const BODY_LIMIT = '100kb';

/** How long a browser may cache a preflight, in seconds. */
const PREFLIGHT_MAX_AGE = 600;

/**
 * Everything applied to an already-created app.
 *
 * This is a function rather than a run of statements in `main.ts` because
 * `main.ts` is not what tests execute: an e2e builds its app through
 * `Test.createTestingModule(...).createNestApplication()`, so anything inlined
 * there is absent under test and free to drift from production. `app.module.ts`
 * already makes this argument for `APP_PIPE`; this is the same argument for the
 * things that can only be applied at the application level.
 *
 * Registration order matters and is not alphabetical: helmet runs first so its
 * headers reach responses that never match a route — 404s and body-parser
 * failures included — and CORS runs next so a preflight is answered before
 * anything else touches it.
 */
export function configureApp(app: NestExpressApplication, env: Env): void {
  // Behind a load balancer every request arrives from the balancer, so without
  // this the `remoteAddress` that `src/logging/pino-options.ts` already
  // serializes is the balancer's address on every line — one value, logged as
  // though it were the caller. `1` trusts a single hop, which is the shape of
  // one balancer in front of one service.
  //
  // The tradeoff: with no proxy actually in front, a client can set
  // `X-Forwarded-For` itself and choose what gets logged. That is why the value
  // is a hop count rather than `true`, which would trust the whole chain.
  // *Revisit on a second hop* — a CDN ahead of the balancer makes this `2`.
  app.set('trust proxy', 1);

  // Most of what helmet sets is inert for a service that only ever emits JSON;
  // `nosniff` and the removal of `X-Powered-By` are the two that do work today.
  // It is here anyway for two reasons: the header set is a moving target that
  // someone else maintains against the spec, and the inert half stops being
  // inert the moment this process serves any HTML — a docs UI, an OAuth
  // callback — at which point CSP and `frame-ancestors` become load-bearing.
  app.use(
    helmet({
      // Off deliberately. helmet's default is one year with `includeSubDomains`,
      // which is close to irreversible: every subdomain becomes HTTPS-only for
      // any browser that has seen the header, and unwinding it needs those
      // browsers to come back over HTTPS to be told otherwise. This process
      // speaks plain HTTP and terminates no TLS, so it cannot know whether that
      // claim is true. Whatever terminates TLS can, and that is where the header
      // belongs.
      hsts: false,
    }),
  );

  // An allowlist, and empty means off rather than open — a deployment has no
  // cross-origin caller until someone names one. `origin: true` would reflect
  // whatever origin asked, which together with `credentials` lets any site a
  // user visits act as them against this API.
  app.enableCors({
    origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false,
    credentials: true,
    // Without this the id is unreadable to the very clients most likely to want
    // it: cross-origin JavaScript may only read six response headers by
    // default, so `X-Request-Id` would read as `null` in a browser — an id this
    // service sets on every response and the caller cannot see.
    exposedHeaders: ['X-Request-Id'],
    maxAge: PREFLIGHT_MAX_AGE,
  });

  // These replace the two parsers Nest registers itself, which is why
  // `main.ts` passes `bodyParser: false` — see the note there. `json` and
  // `urlencoded` are the only two Nest registers, so nothing is dropped.
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { extended: true, limit: BODY_LIMIT });

  // Composed by Nest as prefix / version / controller path, so a controller at
  // `entries` answers on `/api/v1/entries`. The health probes are excluded
  // because their shape is a contract with the orchestrator rather than with API
  // clients, and bumping the API version should not move the URL a load balancer
  // polls.
  //
  // Excluding the prefix is only half of it: versioning is a separate mechanism
  // and would still stamp `/v1` onto these routes, so `HealthController` also
  // declares `version: VERSION_NEUTRAL`. Either one alone leaves the probes
  // somewhere other than `/health/*`.
  app.setGlobalPrefix(API_PREFIX, { exclude: HEALTH_ROUTES });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: DEFAULT_VERSION,
  });
}
