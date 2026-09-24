import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { BlocksModule } from './blocks/blocks.module';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { AllExceptionsFilter } from './http/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './http/response.interceptor';
import { RequestTimeoutInterceptor } from './http/timeout.interceptor';
import { LoggingModule } from './logging/logging.module';
import { MeModule } from './me/me.module';
import { ZodValidationPipe } from './validation/validation.pipe';

@Module({
  // `LoggingModule` registers the middleware that stamps the request id and
  // opens the async-local-storage context, which is why there is no
  // `configure()` here any more.
  // `DatabaseModule` is where a boot against an unreachable database stops:
  // its pool provider verifies the connection and throws, which rejects
  // `NestFactory.create`. That is deliberate, and it is why a
  // `Test.createTestingModule` importing this module needs a real Postgres —
  // `docker compose up -d --wait` first.
  imports: [
    AppConfigModule,
    LoggingModule,
    DatabaseModule,
    HealthModule,
    AuthModule,
    MeModule,
    BlocksModule,
  ],
  providers: [
    // Registered here rather than in `main.ts` so tests built with
    // `Test.createTestingModule` validate exactly as production does.
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // Listed before any interceptor added later, which is what keeps the
    // envelope outermost: everything after it sees the raw handler payload
    // rather than `{ data }`.
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    // After the envelope, therefore inside it, and the order is the point: a
    // timeout has to fire where it becomes a thrown exception for
    // `AllExceptionsFilter` to render, rather than somewhere the envelope would
    // wrap a payload that never arrived.
    { provide: APP_INTERCEPTOR, useClass: RequestTimeoutInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
