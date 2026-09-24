import { Module } from '@nestjs/common';
import { DaysModule } from '../days/days.module';
import { TasksModule } from '../tasks/tasks.module';
import { UsersModule } from '../users/users.module';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';

/**
 * The dashboard (`docs/api-plan.md` §8). It owns no table: block time comes
 * from the laid-out days, and task outcomes from the tasks' ledger.
 */
@Module({
  imports: [DaysModule, TasksModule, UsersModule],
  controllers: [ReviewController],
  providers: [ReviewService],
})
export class ReviewModule {}
