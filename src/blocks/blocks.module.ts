import { Module } from '@nestjs/common';
import { BlockNamesModule } from '../block-names/block-names.module';
import { UsersModule } from '../users/users.module';
import { BlocksController } from './blocks.controller';
import { BlocksRepository } from './blocks.repository';
import { BlocksService } from './blocks.service';

/** Block series and their occurrences (`docs/api-plan.md` §4). */
@Module({
  // Each occurrence carries the trace chosen for its name. The user's time
  // zone tells which days have closed to new blocks.
  imports: [BlockNamesModule, UsersModule],
  controllers: [BlocksController],
  providers: [BlocksService, BlocksRepository],
  // `DaysModule` reads series to lay out a day.
  exports: [BlocksRepository],
})
export class BlocksModule {}
