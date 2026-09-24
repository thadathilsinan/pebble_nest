import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { CurrentCaller } from '../auth/current-caller.decorator';
import { BlockNamesService } from './block-names.service';
import { ListBlockNamesQuery } from './dto/list-block-names.dto';
import { BlockNameParams, SetTraceBody } from './dto/set-trace.dto';

@Controller('block-names')
export class BlockNamesController {
  constructor(private readonly names: BlockNamesService) {}

  @Get()
  async list(
    @CurrentCaller() caller: Caller,
    @Query() query: ListBlockNamesQuery,
  ) {
    return { items: await this.names.suggest(caller, query.q) };
  }

  /**
   * `PUT`, where adding-a-feature §4.4 prefers `PATCH`: the trace is the whole
   * resource at this path, and each request replaces it outright.
   */
  @Put(':name/trace')
  @HttpCode(204)
  setTrace(
    @CurrentCaller() caller: Caller,
    @Param() { name }: BlockNameParams,
    @Body() body: SetTraceBody,
  ) {
    return this.names.setTrace(caller, name, body.trace);
  }
}
