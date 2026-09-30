import { Module } from '@nestjs/common';
import { ENV } from '../core/config/config.module';
import type { Env } from '../core/config/env.schema';
import { TasksModule } from '../tasks/tasks.module';
import { ClosedDaysCache } from './closed-days-cache';
import { DayCloseInterceptor } from './day-close.interceptor';

/**
 * Running the day-end close before each signed-in request (decision 38).
 * The close itself is `TasksModule`'s; this is when it runs, and what is
 * remembered in between. `AppModule` registers the interceptor, and
 * `MeModule` forgets a user whose time zone changes.
 */
@Module({
  imports: [TasksModule],
  providers: [
    DayCloseInterceptor,
    {
      provide: ClosedDaysCache,
      inject: [ENV],
      useFactory: (env: Env) =>
        new ClosedDaysCache(env.DAY_CLOSE_CACHE_MAX_USERS),
    },
  ],
  exports: [DayCloseInterceptor, ClosedDaysCache],
})
export class DayCloseModule {}
