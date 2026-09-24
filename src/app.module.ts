import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { BlockNamesModule } from './block-names/block-names.module';
import { BlockOccurrencesModule } from './block-occurrences/block-occurrences.module';
import { BlocksModule } from './blocks/blocks.module';
import { AppConfigModule } from './core/config/config.module';
import { DatabaseModule } from './core/database/database.module';
import { DaysModule } from './days/days.module';
import { HealthModule } from './core/health/health.module';
import { AllExceptionsFilter } from './core/http/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './core/http/response.interceptor';
import { RequestTimeoutInterceptor } from './core/http/timeout.interceptor';
import { LoggingModule } from './core/logging/logging.module';
import { MeModule } from './me/me.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReviewModule } from './review/review.module';
import { TasksModule } from './tasks/tasks.module';
import { ZodValidationPipe } from './core/validation/validation.pipe';

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
    BlockOccurrencesModule,
    BlockNamesModule,
    DaysModule,
    TasksModule,
    NotificationsModule,
    ReviewModule,
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
