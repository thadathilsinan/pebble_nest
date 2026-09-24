import { Module } from '@nestjs/common';
import { BlocksModule } from '../blocks/blocks.module';
import { UsersModule } from '../users/users.module';
import { TaskSeriesRepository } from './task-series.repository';
import { TaskSeriesService } from './task-series.service';
import { TasksController } from './tasks.controller';
import { TasksRepository } from './tasks.repository';
import { TasksService } from './tasks.service';

/**
 * Tasks (`docs/api-plan.md` §5). It reads block series to check where a task
 * goes, and the user's time zone to tell which days have closed.
 */
@Module({
  imports: [BlocksModule, UsersModule],
  controllers: [TasksController],
  providers: [
    TasksService,
    TasksRepository,
    TaskSeriesRepository,
    TaskSeriesService,
  ],
  // `DaysModule` lays a day's tasks out beside its blocks, issuing repeating
  // tasks' occurrences first.
  exports: [TasksRepository, TaskSeriesService],
})
export class TasksModule {}
