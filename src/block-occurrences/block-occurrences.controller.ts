import { Controller, Delete, HttpCode, Param, Post } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { CurrentCaller } from '../auth/current-caller.decorator';
import { BlockOccurrencesService } from './block-occurrences.service';
import { OccurrenceParams } from './dto/occurrence-params.dto';

@Controller('blocks/:seriesId/occurrences/:date')
export class BlockOccurrencesController {
  constructor(private readonly occurrences: BlockOccurrencesService) {}

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
}
