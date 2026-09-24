import { Body, Controller, Post } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { CurrentCaller } from '../auth/current-caller.decorator';
import { BlocksService } from './blocks.service';
import { CreateBlockBody } from './dto/create-block.dto';

@Controller('blocks')
export class BlocksController {
  constructor(private readonly blocks: BlocksService) {}

  @Post()
  create(@CurrentCaller() caller: Caller, @Body() body: CreateBlockBody) {
    return this.blocks.create(caller, body);
  }
}
