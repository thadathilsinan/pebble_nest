import { Controller, Get, Param, Query } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { CurrentCaller } from '../auth/current-caller.decorator';
import { DaysService } from './days.service';
import { DayDateParams } from './dto/day-date.dto';
import { ListDaysQuery } from './dto/list-days.dto';

@Controller('days')
export class DaysController {
  constructor(private readonly days: DaysService) {}

  @Get()
  async list(@CurrentCaller() caller: Caller, @Query() query: ListDaysQuery) {
    return { items: await this.days.list(caller, query.from, query.to) };
  }

  @Get(':date')
  async get(@CurrentCaller() caller: Caller, @Param() { date }: DayDateParams) {
    const [day] = await this.days.list(caller, date, date);
    return day;
  }
}
