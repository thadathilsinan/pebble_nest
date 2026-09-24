import { Module } from '@nestjs/common';
import { DaysModule } from '../days/days.module';
import { TasksModule } from '../tasks/tasks.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * What the phone schedules as local notifications (`docs/api-plan.md` §6).
 * It owns no table: block alerts come from the laid-out days, and task
 * reminders from the tasks table by the reminder's date.
 */
@Module({
  imports: [DaysModule, TasksModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
