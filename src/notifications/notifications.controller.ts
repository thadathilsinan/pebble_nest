import { Controller, Get, Query } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { CurrentCaller } from '../auth/current-caller.decorator';
import { ScheduleQuery } from './dto/schedule-query.dto';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('schedule')
  schedule(@CurrentCaller() caller: Caller, @Query() query: ScheduleQuery) {
    return this.notifications.schedule(caller, query.from, query.to);
  }
}
