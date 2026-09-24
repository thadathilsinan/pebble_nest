import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { CurrentCaller } from '../auth/current-caller.decorator';
import { CreateTaskBody } from './dto/create-task.dto';
import { DeleteTaskQuery } from './dto/delete-task.dto';
import { MoveTaskBody } from './dto/move-task.dto';
import { SetTaskDoneBody, TaskIdParams } from './dto/set-task-done.dto';
import { UpdateTaskBody } from './dto/update-task.dto';
import { TasksService } from './tasks.service';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post()
  create(@CurrentCaller() caller: Caller, @Body() body: CreateTaskBody) {
    return this.tasks.create(caller, body);
  }

  @Patch(':id')
  update(
    @CurrentCaller() caller: Caller,
    @Param() { id }: TaskIdParams,
    @Body() body: UpdateTaskBody,
  ) {
    return this.tasks.update(caller, id, body);
  }

  @Patch(':id/done')
  setDone(
    @CurrentCaller() caller: Caller,
    @Param() { id }: TaskIdParams,
    @Body() body: SetTaskDoneBody,
  ) {
    return this.tasks.setDone(caller, id, body);
  }

  // An action on the task, not a create, so 200 rather than POST's 201.
  @Post(':id/move')
  @HttpCode(200)
  move(
    @CurrentCaller() caller: Caller,
    @Param() { id }: TaskIdParams,
    @Body() body: MoveTaskBody,
  ) {
    return this.tasks.move(caller, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(
    @CurrentCaller() caller: Caller,
    @Param() { id }: TaskIdParams,
    // Validated, but every task is a one-off until task series exist, so the
    // scope changes nothing yet.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @Query() _query: DeleteTaskQuery,
  ): Promise<void> {
    await this.tasks.delete(caller, id);
  }
}
