import { Module } from '@nestjs/common';
import { BlocksController } from './blocks.controller';
import { BlocksRepository } from './blocks.repository';
import { BlocksService } from './blocks.service';

/** Block series and their occurrences (`docs/api-plan.md` §4). */
@Module({
  controllers: [BlocksController],
  providers: [BlocksService, BlocksRepository],
  // `DaysModule` reads series to lay out a day.
  exports: [BlocksRepository],
})
export class BlocksModule {}
