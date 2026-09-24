import { Body, Controller, Param, Patch, Post } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { CurrentCaller } from '../auth/current-caller.decorator';
import { CreateTaskBody } from './dto/create-task.dto';
import { SetTaskDoneBody, TaskIdParams } from './dto/set-task-done.dto';
import { TasksService } from './tasks.service';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post()
  create(@CurrentCaller() caller: Caller, @Body() body: CreateTaskBody) {
    return this.tasks.create(caller, body);
  }

  @Patch(':id/done')
  setDone(
    @CurrentCaller() caller: Caller,
    @Param() { id }: TaskIdParams,
    @Body() body: SetTaskDoneBody,
  ) {
    return this.tasks.setDone(caller, id, body);
  }
}
