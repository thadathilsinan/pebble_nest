import { Module } from '@nestjs/common';
import { BlocksModule } from '../blocks/blocks.module';
import { TasksModule } from '../tasks/tasks.module';
import { UsersModule } from '../users/users.module';
import { BlockOccurrencesController } from './block-occurrences.controller';
import { BlockOccurrencesRepository } from './block-occurrences.repository';
import { BlockOccurrencesService } from './block-occurrences.service';

/**
 * One occurrence of a block series (`docs/api-plan.md` §4): skipping it for
 * now. Its own module rather than part of `BlocksModule`, because it moves
 * tasks, and `TasksModule` already imports `BlocksModule`.
 */
@Module({
  imports: [BlocksModule, TasksModule, UsersModule],
  controllers: [BlockOccurrencesController],
  providers: [BlockOccurrencesService, BlockOccurrencesRepository],
  // `DaysModule` marks skipped occurrences on the timeline.
  exports: [BlockOccurrencesRepository],
})
export class BlockOccurrencesModule {}
