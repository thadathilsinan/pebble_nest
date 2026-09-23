import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { pinoHttpOptions } from './pino-options';

/**
 * Wires pino as the application logger.
 *
 * `LoggerModule` is itself `@Global()` and registers its own middleware, so
 * importing this module once is the whole installation: `PinoLogger` becomes
 * injectable everywhere, and every request gets an id, a bound child logger and
 * a completion line without a further line of wiring.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      // The level and the transport come from the validated environment, which
      // is why this is `forRootAsync` — nothing here may read `process.env`.
      inject: [ENV],
      useFactory: (env: Env) => ({ pinoHttp: pinoHttpOptions(env) }),
    }),
  ],
})
export class LoggingModule {}
