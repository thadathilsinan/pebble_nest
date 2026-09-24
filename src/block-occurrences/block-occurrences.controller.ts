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
import { BlockOccurrencesService } from './block-occurrences.service';
import { DeleteOccurrenceQuery } from './dto/delete-occurrence.dto';
import { OccurrenceParams } from './dto/occurrence-params.dto';
import { UpdateOccurrenceBody } from './dto/update-occurrence.dto';

@Controller('blocks/:seriesId/occurrences/:date')
export class BlockOccurrencesController {
  constructor(private readonly occurrences: BlockOccurrencesService) {}

  @Patch()
  edit(
    @CurrentCaller() caller: Caller,
    @Param() { seriesId, date }: OccurrenceParams,
    @Body() body: UpdateOccurrenceBody,
  ) {
    return this.occurrences.edit(caller, seriesId, date, body);
  }

  // An action on the occurrence, not a create, so 200 rather than POST's 201.
  @Post('skip')
  @HttpCode(200)
  skip(
    @CurrentCaller() caller: Caller,
    @Param() { seriesId, date }: OccurrenceParams,
  ) {
    return this.occurrences.skip(caller, seriesId, date);
  }

  @Delete('skip')
  @HttpCode(204)
  async unskip(
    @CurrentCaller() caller: Caller,
    @Param() { seriesId, date }: OccurrenceParams,
  ): Promise<void> {
    await this.occurrences.unskip(caller, seriesId, date);
  }

  // A stated exception to DELETE's 204: the UI shows how many tasks moved.
  @Delete()
  @HttpCode(200)
  delete(
    @CurrentCaller() caller: Caller,
    @Param() { seriesId, date }: OccurrenceParams,
    @Query() { scope }: DeleteOccurrenceQuery,
  ) {
    return this.occurrences.delete(caller, seriesId, date, scope);
  }
}
