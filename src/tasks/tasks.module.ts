import { Module } from '@nestjs/common';
import { BlocksModule } from '../blocks/blocks.module';
import { UsersModule } from '../users/users.module';
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
  providers: [TasksService, TasksRepository],
  // `DaysModule` lays a day's tasks out beside its blocks.
  exports: [TasksRepository],
})
export class TasksModule {}
